// A reader that follows a run (a console's live Timeline, its view polled, a test's follow) reads the run's rows once per
// change, and each read renders them from the journal again. The journal only grows and an entry's words never change, so
// each text is cut by the run's held values once: a read cuts only the texts no earlier read cut under the same values.
// When each read cut every text again, a run of n turns cost n² of the redactor's work, in the process that runs it: a
// plan run of 61 searches spent most of its time cutting what it had cut already.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { cutPasses } from "../dist/key-refusal.js";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { storeOn, T0 } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
const { forgetServed, timelineOverStore, viewOverStore } = await import("../dist/store-view.js");
const { runTimelines } = await import("../dist/run-reads-over-store.js");

// Two held values of 24 characters in no secret's shape, made at runtime: one held from the start, one saved later.
const KEY = ["Zq8V", "bN3x", "LmT6", "pR2w", "Yk9H", "sD4f"].join("");
const LATER = ["Wt5N", "hQ2c", "Jr8M", "vX3e", "Pd6K", "gB7s"].join("");
const TURNS = 24;

/** Search `n`'s answer: three hits with a long snippet each, KEY whole in the first hit's title of search 3, LATER in
 *  search 5's (inside what a row shows of it). */
const searchOf = (n) => JSON.stringify({
  query: `widgets ${n}`,
  results: [0, 1, 2].map((i) => ({ url: `https://h.example/${n}/${i}`, title: `Widget ${n}.${i}${i === 0 && n === 3 ? ` ${KEY}` : ""}${i === 0 && n === 5 ? ` ${LATER}` : ""}`, snippet: `${"widgets are made of parts ".repeat(20)}end` })),
});

/** A store holding run-1, a pi run of `turns` web searches (each a call and its answer) after the person's message.
 *  `more()` adds one more search. */
async function searches(t, turns) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Search." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Search." }, title: "Search", place: { mode: "runner" } } });
  const journal = store.journal(await store.claim("run-1", "runner-a", { leaseMs: 60_000 }));
  const entry = async (kind, model) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind, model: [{ ...model, timestamp: T0 }] } });
  let made = 0;
  const turn = async () => {
    const n = (made += 1);
    return [
      await entry("pi.assistant", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${n}`, name: "web_search", arguments: { query: `widgets ${n}` } }] }),
      await entry("pi.tool-result", { role: "toolResult", toolCallId: `c${n}`, toolName: "web_search", content: [{ type: "text", text: searchOf(n) }], isError: false }),
    ];
  };
  const first = [{ type: "conversation", value: { id: 1 } }, await entry("pi.user", { role: "user", content: "Search." })];
  for (let i = 0; i < turns; i++) first.push(...(await turn()));
  await commitWrites(journal, first, BACKGROUND_CONTEXT);
  return { store, more: async () => commitWrites(journal, await turn(), BACKGROUND_CONTEXT) };
}

/** The two reads a timeline page makes of run-1 (run-reads-over-store.ts once: the view, then the served rows), the server
 *  holding `secrets`; and the texts the run's cut read meanwhile (cutPasses). */
async function page(store, secrets) {
  const before = cutPasses.count;
  const view = await timelineOverStore(store, "run-1", { origin: "https://run.test", serverSecrets: () => secrets });
  const served = await servedTimelineRows({ serverSecrets: () => secrets, keyEnv: () => ({}) }, store, "run-1", BACKGROUND_CONTEXT);
  return { view, served, passes: cutPasses.count - before };
}

const results = (rows) => rows.filter((row) => row.kind === "tool_result");

test("a second read of a run's rows cuts no text again, whatever the run's length; a search added since cuts that search's texts alone", async (t) => {
  const short = await searches(t, 1);
  const long = await searches(t, TURNS);
  const firstShort = await page(short.store, [KEY]);
  const firstLong = await page(long.store, [KEY]);
  assert.equal(results(firstLong.served).length, TURNS);
  assert.ok(firstLong.passes >= 2 * TURNS, `the first read cuts each search's answer: ${firstLong.passes} texts for ${TURNS} searches`);
  const againShort = await page(short.store, [KEY]);
  const againLong = await page(long.store, [KEY]);
  assert.equal(againLong.passes, againShort.passes, `a second read of ${TURNS} searches cuts as many texts as one of 1 search (${againShort.passes}), not ${againLong.passes}: what the first read cut is not cut again`);
  assert.deepEqual(againLong.served, firstLong.served, "the second read's rows are the first's");
  assert.deepEqual(againLong.view, firstLong.view, "the second view's rows are the first's");
  for (const rows of [firstLong.served, firstLong.view]) {
    const all = JSON.stringify(rows);
    assert.ok(!all.includes(KEY) && all.includes("[redacted]"), "the held value is cut");
  }
  // One search more: that search's call and answer are cut, every earlier text read as it was cut.
  await long.more();
  const grown = await page(long.store, [KEY]);
  assert.equal(results(grown.served).length, TURNS + 1);
  t.diagnostic(`texts cut: ${firstLong.passes} by the first read of ${TURNS} searches, ${againLong.passes} by the second, ${grown.passes} after one more; ${firstShort.passes} and ${againShort.passes} for 1 search`);
  assert.ok(grown.passes <= againShort.passes + firstShort.passes, `a read after one more search cuts at most one search's texts more than a second read: ${grown.passes}, over ${againShort.passes} + ${firstShort.passes}`);
});

test("a key saved since a read cuts every text of the run again, by the larger set; a run forgotten keeps none of what was cut", async (t) => {
  const { store } = await searches(t, TURNS);
  const first = await page(store, [KEY]);
  assert.ok(JSON.stringify(first.served).includes(LATER), "LATER is no held value yet: it shows");
  const saved = await page(store, [KEY, LATER]);
  assert.ok(saved.passes >= 2 * TURNS, `a key saved since: every search's answer cut again, ${saved.passes} texts`);
  for (const rows of [saved.served, saved.view]) {
    const all = JSON.stringify(rows);
    assert.ok(!all.includes(LATER) && !all.includes(KEY), "both held values are cut");
  }
  assert.equal((await page(store, [KEY, LATER])).passes < saved.passes, true, "read again under the same set: what it cut is kept");
  // A purged or deleted run's text stays in no memory of this process (agent-delete.ts forgetServed): its cuts go too.
  forgetServed(store, "run-1");
  const forgotten = await page(store, [KEY, LATER]);
  assert.ok(forgotten.passes >= 2 * TURNS, `a run forgotten: every text cut again, ${forgotten.passes} texts`);
});

// The shape of a plan run of 61 searches followed to its end: one timeline page per search, as a server serves it
// (runTimelines over the run's view and its served rows). Each page cuts the texts of the search it adds, so the texts a
// page cuts stay flat as the run grows and the whole run costs the redactor work linear in its searches. When every
// page cut every text again, page 60 cut 723 texts (page 15: 183), and the run 22141.
for (const cli of [false, true]) test(`${cli ? "a CLI's" : "a pi"} run followed page by page for 60 searches: each page cuts the texts of the search it adds, not the run's`, async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Search." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Search." }, title: "Search", place: { mode: "runner" } } });
  const journal = store.journal(await store.claim("run-1", "runner-a", { leaseMs: 600_000 }));
  let at = T0;
  const entry = async (kind, body) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind, ...body } });
  const pi = (kind, model) => entry(kind, { model: [{ ...model, timestamp: (at += 1000) }] });
  const record = (kind, data) => entry(kind, { data: { ...data, at: (at += 1000) } });
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, cli ? await record(KINDS.message, { role: "person", text: "Search." }) : await pi("pi.user", { role: "user", content: "Search." })], BACKGROUND_CONTEXT);
  const held = [KEY];
  const timelines = runTimelines({
    context: BACKGROUND_CONTEXT,
    pollMs: 1,
    timelineRows: (s, runId, context, calls) => servedTimelineRows({ serverSecrets: () => held, sealKey: undefined, keyEnv: () => ({}) }, s, runId, context, calls),
    runView: (s, runId) => viewOverStore(s, runId, { origin: "https://run.test", serverSecrets: () => held, sealKey: undefined }),
  });
  let after = 0;
  const cut = [];
  for (let n = 1; n <= 60; n++) {
    const id = `c${n}`;
    const writes = cli
      ? [await record(KINDS.callStart, { callId: id, tool: "web_search", input: { query: `widgets ${n}` } }), await record(KINDS.callEnd, { callId: id, status: "done", output: searchOf(n) })]
      : [await pi("pi.assistant", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "web_search", arguments: { query: `widgets ${n}` } }] }), await pi("pi.tool-result", { role: "toolResult", toolCallId: id, toolName: "web_search", content: [{ type: "text", text: searchOf(n) }], isError: false })];
    await commitWrites(journal, writes, BACKGROUND_CONTEXT);
    const before = cutPasses.count;
    const page = await timelines.page(store, "run-1", after, 0, 10_000);
    after = page.next_after;
    cut.push(cutPasses.count - before);
  }
  const sum = (pages) => pages.reduce((a, b) => a + b, 0);
  t.diagnostic(`texts cut: page 1 ${cut[0]}, page 15 ${cut[14]}, page 30 ${cut[29]}, page 60 ${cut[59]}; ${sum(cut.slice(0, 30))} over 30 pages, ${sum(cut)} over 60`);
  assert.equal(cut[59], cut[14], `page 60 cuts as many texts as page 15 (${cut[14]}), not ${cut[59]}: a page cuts the search it adds`);
  assert.ok(sum(cut) <= 2 * sum(cut.slice(0, 30)) + cut[0], `60 pages cut at most twice what 30 did: ${sum(cut)} against ${sum(cut.slice(0, 30))}`);
});
