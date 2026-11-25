// A reader that follows a run keeps what it cut of each text, by the held value set (store-reads/journal.ts rowCutsOnce),
// so a run's rows are not cut again on every read. What it serves must be exactly what a reader with nothing kept
// serves. Seeded random runs (pi's and a CLI's records: messages, calls and their results, a value split across two
// writes, answers, a value said again) grow one step at a time while the held values are saved, rotated for others and
// reordered, some of them overlapping. After each step what the followed reader serves is compared byte for byte (JSON)
// with a fresh render that keeps nothing:
//  - the rows: many runs through the renderer both store reads use (timelineOf over piShaped), the followed reader's rows
//    through a RowLog as a client applies its pages (reset, drop, then upsert), against the rows cut as before rowCutsOnce
//    (redacted and withheldWhole over every text, on every read);
//  - the store's readers: fewer runs through the timeline page a server serves (runTimelines over servedTimelineRows and
//    viewOverStore), the followed store's pages applied by a client and its view, against a second store on the same
//    file whose cuts are forgotten before each read.
// A failure names its seed: CUT_DIFF_SEED=<seed> CUT_DIFF_RUNS=1 CUT_DIFF_STORE_RUNS=1 reproduces it alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { cutPasses, redacted, redactedAnswer, withheldWhole } from "../dist/key-refusal.js";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { storeOn, T0 } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
const { forgetServed, viewOverStore } = await import("../dist/store-view.js");
const { runTimelines } = await import("../dist/run-reads-over-store.js");
const { cutBudget, cutsKeptOf, piShaped, rowCutsOnce, servedSince } = await import("../dist/store-reads/journal.js");
const { timelineOf } = await import("../dist/timeline/timeline.js");
const { ChangeClock, RowLog } = await import("../dist/rows.js");

const RUNS = Number(process.env.CUT_DIFF_RUNS ?? 300);
const STORE_RUNS = Number(process.env.CUT_DIFF_STORE_RUNS ?? 12);
const FIRST_SEED = Number(process.env.CUT_DIFF_SEED ?? 0x5eed);
const STEPS = 9;

/** mulberry32: the same seed, the same run. */
function rngOf(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (list) => list[int(list.length)], chance: (p) => next() < p };
}

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const word = (rng, n) => Array.from({ length: n }, () => ALNUM[rng.int(ALNUM.length)]).join("");

/** The values a run may come to hold: plain ones, and pairs that overlap (one's tail the other's head; one inside
 *  another), so a cut of one and a cut of the other meet in a text, and their order could matter. */
function poolOf(rng) {
  const a = word(rng, 24);
  const b = `${a.slice(10)}${word(rng, 10)}`; // b's head is a's tail
  const c = a.slice(4, 20); // c inside a
  const d = word(rng, 22);
  const e = `${word(rng, 8)}${d.slice(0, 14)}`; // e's tail is d's head
  return [a, b, c, d, e, word(rng, 26), word(rng, 20)];
}

/** A text that may hold values from `pool` whole, split or joined where two overlap, and filler around them. */
function textOf(rng, pool) {
  const parts = [`${word(rng, 5)} ${word(rng, 7)}`];
  const n = rng.int(3);
  for (let i = 0; i < n; i++) {
    const v = rng.pick(pool);
    const how = rng.int(4);
    if (how === 0) parts.push(v);
    else if (how === 1) parts.push(`${pool[0]}${pool[1].slice(14)}`); // a then b, overlapping in the text
    else if (how === 2) parts.push(`"${v}"`);
    else parts.push(`key=${v}&n=${rng.int(99)}`);
    parts.push(word(rng, 4 + rng.int(6)));
  }
  return parts.join(" ");
}

/** A run's writer: pi's entries, or a CLI's records (codex's: a message, a call's start and end), each step's writes
 *  committed to `sink` (a store's journal, or a list in memory). */
function writerOf(sink, cli) {
  let at = T0;
  const entry = async (kind, body) => ({ type: "entry", value: { id: await sink.mintId(), conversationId: 1, kind, ...body } });
  const pi = (kind, model) => entry(kind, { model: [{ ...model, timestamp: (at += 1000) }] });
  const cliOf = (kind, data) => entry(kind, { data: { ...data, at: (at += 1000) } });
  let calls = 0;
  return {
    begin: async () => sink.commit([{ type: "conversation", value: { id: 1 } }, cli ? await cliOf(KINDS.message, { role: "person", text: "Work." }) : await pi("pi.user", { role: "user", content: "Work." })]),
    /** One step's writes: `person` a message, `said` the model's texts (each its own entry), `blocks` one model turn of
     *  several texts, `call` a call's arguments and output. */
    write: async ({ said = [], blocks, call, person }) => {
      const writes = [];
      if (person !== undefined) writes.push(cli ? await cliOf(KINDS.message, { role: "person", text: person }) : await pi("pi.user", { role: "user", content: person }));
      for (const text of said) writes.push(cli ? await cliOf(KINDS.message, { role: "model", text }) : await pi("pi.assistant", { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }));
      if (blocks) writes.push(await pi("pi.assistant", { role: "assistant", stopReason: "stop", content: blocks.map((text) => ({ type: "text", text })) }));
      if (call) {
        const id = `c${(calls += 1)}`;
        if (cli) {
          writes.push(await cliOf(KINDS.callStart, { callId: id, tool: call.tool, input: call.args }));
          writes.push(await cliOf(KINDS.callEnd, { callId: id, status: call.failed ? "failed" : "done", output: call.output }));
        } else {
          writes.push(await pi("pi.assistant", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: call.tool, arguments: call.args }] }));
          writes.push(await pi("pi.tool-result", { role: "toolResult", toolCallId: id, toolName: call.tool, content: [{ type: "text", text: call.output }], isError: Boolean(call.failed) }));
        }
      }
      if (writes.length) await sink.commit(writes);
    },
  };
}

/** Seed `seed`'s run: pi's or a CLI's, the values it may hold, and STEPS steps, each the held values then (saved, rotated
 *  or reordered since the step before) and what the run writes. `did` counts each kind of change. */
function scriptOf(seed) {
  const rng = rngOf(seed);
  const cli = rng.chance(0.5);
  const pool = poolOf(rng);
  let held = rng.chance(0.5) ? [pool[3]] : [];
  const did = { grown: 0, grownShown: 0, rotated: 0, reordered: 0, split: 0, again: 0 };
  const shownValues = new Set();
  const steps = [];
  for (let step = 0; step < STEPS; step++) {
    // The held values change: one saved (often one a row showed already), one rotated for another (as many as before),
    // or their order changed.
    const change = rng.int(6);
    const unheld = pool.filter((v) => !held.includes(v));
    if (change === 0 && unheld.length) {
      const seen = unheld.filter((v) => shownValues.has(v));
      const v = seen.length && rng.chance(0.7) ? rng.pick(seen) : rng.pick(unheld);
      if (shownValues.has(v)) did.grownShown++;
      held = [...held, v];
      did.grown++;
    } else if (change === 1 && unheld.length && held.length) {
      held = [...held];
      held[rng.int(held.length)] = rng.pick(unheld);
      did.rotated++;
    } else if (change === 2 && held.length > 1) {
      held = [...held].reverse();
      did.reordered++;
    }
    // What the run writes this step.
    const kind = rng.int(6);
    const write = {};
    if (kind === 0) write.said = [textOf(rng, pool)];
    else if (kind === 1) {
      // A value split across two writes: the tail of one text, the head of the next (two entries, or two blocks of one).
      const v = rng.pick(pool);
      const at = 4 + rng.int(v.length - 8);
      const [head, tail] = [`${word(rng, 6)} ${v.slice(0, at)}`, `${v.slice(at)} ${word(rng, 6)}`];
      if (!cli && rng.chance(0.5)) write.blocks = [head, tail];
      else write.said = [head, tail];
      did.split++;
    } else if (kind === 2) {
      const q = textOf(rng, pool);
      write.call = { tool: "web_search", args: { query: q }, output: JSON.stringify({ query: q, results: [0, 1].map((i) => ({ url: `https://h.example/${seed}/${step}/${i}?k=${rng.pick(pool)}`, title: textOf(rng, pool), snippet: textOf(rng, pool) })) }) };
    } else if (kind === 3) write.call = { tool: rng.pick(["bash", "read_file", "fetch"]), args: { command: textOf(rng, pool) }, output: textOf(rng, pool), failed: rng.chance(0.2) };
    else if (kind === 4) write.person = textOf(rng, pool);
    else {
      // A value cut earlier, written again: one held now, said once more.
      const v = held.length ? rng.pick(held) : rng.pick(pool);
      write.said = [`${word(rng, 6)} ${v} ${word(rng, 5)}`];
      did.again++;
    }
    for (const v of pool) if (JSON.stringify(write).includes(v)) shownValues.add(v);
    steps.push({ held, write });
  }
  return { seed, cli, steps, did };
}

const where = (script, step, held) => `seed ${script.seed} (CUT_DIFF_SEED=${script.seed} CUT_DIFF_RUNS=1 CUT_DIFF_STORE_RUNS=1), ${script.cli ? "codex" : "pi"} run, step ${step}, held ${JSON.stringify(held)}`;
/** Rows as a client keeps them, in the order they read (seq), each as its bytes with the log's numbering left out. */
const shown = (rows) => [...rows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(({ seq: _seq, ...row }) => JSON.stringify(row));
/** A client of a run's pages: each page applied as the console applies it (reset, drop, then upsert). */
const clientOf = () => {
  const rows = new Map();
  return {
    rows,
    after: 0,
    apply(page) {
      if (page.reset) rows.clear();
      for (const id of page.drop) rows.delete(id);
      for (const row of page.rows) rows.set(row.id, row);
      this.after = page.next_after;
    },
  };
};
const noneShown = (bytes, held, at) => {
  for (const v of held) assert.ok(!bytes.includes(v), `${at}: held value ${v} is shown`);
};

/** Seed `seed`'s run in memory, rendered as both store reads render it (timelineOf over piShaped), after each step: the
 *  followed reader's rows (rowCutsOnce, its cuts kept from step to step) through a RowLog to a client, against the rows
 *  cut as before rowCutsOnce (redacted and withheldWhole over every text). */
async function inMemory(script) {
  const store = {};
  store.origin = store;
  const entries = [];
  let ids = 0;
  const run = writerOf({ mintId: async () => (ids += 1), commit: async (writes) => { for (const w of writes) if (w.type === "entry") entries.push(w.value); } }, script.cli);
  await run.begin();
  const log = new RowLog(new ChangeClock());
  const client = clientOf();
  for (const [step, { held, write }] of script.steps.entries()) {
    await run.write(write);
    const shaped = piShaped(entries);
    const followed = timelineOf(shaped, rowCutsOnce(store, `run-${script.seed}`, { values: [...held] }, servedSince(store)));
    const fresh = timelineOf(shaped, { redact: (text) => redacted(text, held), holds: (text) => withheldWhole(text, held) });
    log.sync(followed);
    client.apply(log.page(client.after, 10_000));
    const at = where(script, step, held);
    assert.deepEqual(shown([...client.rows.values()]), shown(fresh), `${at}: the followed pages, applied, show the rows a fresh render shows`);
    noneShown(JSON.stringify([...client.rows.values()]), held, at);
  }
}

/** Two stores over one file: `followed`, read as a console follows a run (its cuts kept from read to read), and `fresh`,
 *  a second store on the file whose cuts are forgotten before each read, so it cuts every text anew. */
async function stores(t) {
  const { store: followed, file } = await storeOn(t);
  const { store: fresh } = await storeOn(t, { file, role: "runner" });
  await followed.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Work." } });
  return { followed, fresh };
}

const viewDeps = (held) => ({ origin: "https://run.test", serverSecrets: () => held, sealKey: undefined });
const servedDeps = (held) => ({ serverSecrets: () => held, sealKey: undefined, keyEnv: () => ({}) });
/** The timeline reader a server builds (server.ts runTimelines), its runs' held values `state.held`; the view each page
 *  read is kept in `seen.view`, to compare as the page's. */
const timelinesOf = (state, seen) => runTimelines({
  context: BACKGROUND_CONTEXT,
  pollMs: 1,
  timelineRows: (store, runId, context, calls) => servedTimelineRows(servedDeps(state.held), store, runId, context, calls),
  runView: async (store, runId) => (seen.view = await viewOverStore(store, runId, viewDeps(state.held))),
});

/** Seed `seed`'s run in a store, after each step: the followed store's page past the client's cursor, applied, and its
 *  view, against a page from the start and the view of the fresh store, its cuts forgotten first. */
async function inStore({ followed, fresh }, script) {
  const runId = `run-${script.seed}`;
  await followed.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Work." }, title: "Work", place: { mode: "runner" } } });
  const journal = followed.journal(await followed.claim(runId, "runner-a", { leaseMs: 600_000 }));
  const run = writerOf({ mintId: () => journal.mintId(), commit: (writes) => commitWrites(journal, writes, BACKGROUND_CONTEXT) }, script.cli);
  await run.begin();
  const state = { held: [] };
  const followedSeen = {};
  const follower = timelinesOf(state, followedSeen);
  const client = clientOf();
  for (const [step, { held, write }] of script.steps.entries()) {
    state.held = held;
    await run.write(write);
    client.apply(await follower.page(followed, runId, client.after, 0, 10_000));
    forgetServed(fresh, runId);
    const before = cutPasses.count;
    const freshSeen = {};
    const freshPage = await timelinesOf(state, freshSeen).page(fresh, runId, 0, 0, 10_000);
    assert.ok(cutPasses.count > before, "the fresh store cut the run's texts itself");
    const at = where(script, step, held);
    assert.deepEqual(shown([...client.rows.values()]), shown(freshPage.rows), `${at}: the followed store's pages, applied, show the rows a fresh store's page shows`);
    assert.equal(JSON.stringify(followedSeen.view), JSON.stringify(freshSeen.view), `${at}: the followed store's view is a fresh store's`);
    noneShown(JSON.stringify([...client.rows.values()]) + JSON.stringify(followedSeen.view), held, at);
  }
}

const tally = (scripts) => {
  const total = { grown: 0, grownShown: 0, rotated: 0, reordered: 0, split: 0, again: 0 };
  for (const { did } of scripts) for (const k of Object.keys(total)) total[k] += did[k];
  return total;
};
const told = (n, total, used) => `${n} runs of ${STEPS} steps from seed ${FIRST_SEED}: ${total.grown} values saved (${total.grownShown} of them shown before), ${total.rotated} rotated, ${total.reordered} reordered, ${total.split} split across two writes, ${total.again} said again; ${((used.user + used.system) / 1e6).toFixed(1)} s of CPU`;

test("a followed run's rows, applied page by page, are byte for byte a fresh render's, as its values are saved, rotated and reordered", async (t) => {
  const scripts = Array.from({ length: RUNS }, (_, i) => scriptOf(FIRST_SEED + i));
  const cpu = process.cpuUsage();
  for (const script of scripts) await inMemory(script);
  const total = tally(scripts);
  t.diagnostic(told(RUNS, total, process.cpuUsage(cpu)));
  // Each case ran: runs that never saved, rotated, reordered or split a value check nothing of it.
  for (const k of Object.keys(total)) assert.ok(total[k] > 0, `no run ${k}`);
});

test("a followed store's timeline pages and view are byte for byte a fresh store's, as the run's values are saved, rotated and reordered", { timeout: 600_000 }, async (t) => {
  const both = await stores(t);
  const scripts = Array.from({ length: STORE_RUNS }, (_, i) => scriptOf(FIRST_SEED + i));
  const cpu = process.cpuUsage();
  for (const script of scripts) await inStore(both, script);
  const total = tally(scripts);
  t.diagnostic(told(STORE_RUNS, total, process.cpuUsage(cpu)));
  for (const k of Object.keys(total)) assert.ok(total[k] > 0, `no run ${k}`);
});

test("a text is cut alike whatever the order its held values come in, overlapping ones too", () => {
  // rowCutsOnce keys its cuts by the values in their order; the view's other kept cuts (wholeAnswers, keptOnce) by the
  // values sorted. Sorted is sound only when the order changes nothing: one value's tail another's head, one inside
  // another, the two met in a text.
  let texts = 0;
  for (let i = 0; i < 200; i++) {
    const rng = rngOf(FIRST_SEED + i);
    const pool = poolOf(rng);
    const orders = [pool, [...pool].reverse(), [...pool].sort(), [pool[1], pool[0], ...pool.slice(2)], [pool[2], pool[0], pool[4], pool[3], ...pool.slice(5), pool[1]]];
    for (let j = 0; j < 4; j++) {
      const text = `${textOf(rng, pool)} ${pool[0]}${pool[1].slice(14)} ${pool[4].slice(0, 8)}${pool[3]} ${textOf(rng, pool)}`;
      const at = `seed ${FIRST_SEED + i}, text ${JSON.stringify(text)}`;
      for (const order of orders.slice(1)) {
        assert.equal(redacted(text, order), redacted(text, orders[0]), `${at}: redacted`);
        assert.equal(withheldWhole(text, order), withheldWhole(text, orders[0]), `${at}: withheldWhole`);
        assert.equal(redactedAnswer(text, order), redactedAnswer(text, orders[0]), `${at}: redactedAnswer`);
      }
      texts++;
    }
  }
  assert.equal(texts, 800);
});

test("what a store's readers keep of their cuts is bounded in bytes: past the budget the oldest go, and a cut no longer kept is made again", async (t) => {
  const { followed: store } = await stores(t);
  const budget = cutBudget.bytes;
  t.after(() => { cutBudget.bytes = budget; });
  cutBudget.bytes = 64 * 1024;
  const value = "Zq8VbN3xLmT6pR2wYk9HsD4f";
  const texts = Array.from({ length: 200 }, (_, i) => `${i} ${"words of a row ".repeat(20)}${i % 7 === 0 ? value : ""}`);
  const cut = rowCutsOnce(store, "run-x", { values: [value] }, servedSince(store));
  for (const text of texts) cut.redact(text);
  const kept = cutsKeptOf(store);
  assert.ok(kept.bytes <= cutBudget.bytes, `kept ${kept.bytes} bytes, over the budget of ${cutBudget.bytes}`);
  assert.ok(kept.texts > 0 && kept.texts < texts.length, `some texts kept, the oldest dropped: ${kept.texts} of ${texts.length}`);
  // The newest is still kept (no cut made), the oldest is cut again.
  let before = cutPasses.count;
  assert.equal(cut.redact(texts.at(-1)), cut.redact(texts.at(-1)));
  assert.equal(cutPasses.count, before, "the newest text is kept");
  before = cutPasses.count;
  cut.redact(texts[0]);
  assert.equal(cutPasses.count, before + 1, "the oldest text was dropped and is cut again");
  // A text that alone costs more than the budget is cut each time and kept never.
  cutBudget.bytes = 1024;
  const huge = "y ".repeat(750);
  before = cutPasses.count;
  cut.redact(huge);
  cut.redact(huge);
  assert.equal(cutPasses.count, before + 2, "a text over the budget is not kept");
});
