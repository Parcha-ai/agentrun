// What a run's cap cannot price is refused under it, never passed as $0. On pi, a spend no one knows: one the run's store
// cannot say (a request a crash cut, a cost that is not a number), or one an answer in this process left unknown. Every
// later request is refused, as claude-agent's and codex's already are. A request stopped before its end is priced at its
// upper bound instead: the worst case the cap held for it, in this process and, from its end mark, in a later one, so a
// stopped run goes on while its cap allows. On every harness, a model whose output is priced and that has no output
// ceiling: nothing bounds a request's worst case. A model whose output costs nothing has a known worst case with or
// without a ceiling, and passes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { REQUEST_COST, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED, runMetricsOf, timelineOf, TOOL_COST, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
import { CAP_REFUSED_FIELD, capBefore, capModels, capToolSpend, HELD_FIELD, HELD_USD, MARK_NOT_WRITTEN, metersIn, spentIn, streamedBytes } from "../dist/cap.js";
import { markRequests } from "../dist/request-start.js";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { agent, follow, letGo, scratch, serve, withEnv } from "./support.mjs";

const UNKNOWN = /^spend_cap_reached: .*spent is unknown.*out of budget/;
const NO_CEILING = /^spend_cap_reached: .*no output ceiling.*out of budget/;

/** A run store holding `entries`, in order, as pi-durable keeps them; removed after the test. */
function storeOf(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "cap-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO entries (conversation_id, record) VALUES (1, ?)");
  for (const entry of entries) put.run(JSON.stringify({ conversationId: 1, ...entry }));
  db.close();
  return file;
}

const started = { kind: REQUEST_STARTED, data: {} };
const compactionStarted = { kind: REQUEST_STARTED, data: { request: "compaction" } };
/** The end mark of a request stopped before its end, with what the cap held for it, or none (a store from before). */
const ended = (heldUsd, extra = {}) => ({ kind: REQUEST_ENDED, data: { ...extra, ...(heldUsd === undefined ? {} : { heldUsd }) } });
/** The start mark written for a request the cap refused. */
const refusedStart = { kind: REQUEST_STARTED, data: { capRefused: true } };
/** A start mark with what the cap held for the request, as a capped run writes it. */
const startedHeld = (heldUsd, extra = {}) => ({ kind: REQUEST_STARTED, data: { ...extra, heldUsd } });
/** pi's answer entry: `cost` its usage's cost, `stopReason` how it ended. */
const answer = (cost, stopReason = "stop") => ({ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { cost }, stopReason, timestamp: 0 }] });
/** pi's answer to a request the cap refused: an error entry for a request that never left, with no mark of its own. */
const refused = { kind: "pi.assistant", model: [{ role: "assistant", content: [], usage: { cost: { total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached: the next model request was not sent. What the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.", timestamp: 0 }] };

test("the spend read from a run's store is each known cost summed, a compaction's among them", (t) => {
  const file = storeOf(t, [started, answer({ total: 0.001 }), started, answer({ total: 0.002 }), compactionStarted, { kind: REQUEST_COST, data: { request: "compaction", usd: 0.004 } }]);
  assert.equal(Math.round(spentIn(file) * 1e6) / 1e6, 0.007);
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.001 }), refused])), 0.001, "a request the cap refused never left: it costs nothing");
  assert.equal(spentIn(join(tmpdir(), `cap-unknown-none-${process.pid}`, "run.sqlite")), 0, "no store yet: nothing spent");
  assert.equal(spentIn(storeOf(t, [])), 0, "an empty store: nothing spent");
  const charged = (usd) => ({ kind: TOOL_COST, data: { tool: "monid.run", charged_by: "monid", usd } });
  assert.equal(Math.round(spentIn(storeOf(t, [started, answer({ total: 0.001 }), charged(0.003)])) * 1e6) / 1e6, 0.004, "a paid tool's charge is spent too");
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.001 }), charged(null)])), null, "an unknown charge leaves the spend unknown");
});

test("a Parallel request whose settle record could not be written: the cap, and a restarted process, count it at its held price, never $0; the run's shown cost and the tools meter read it as unknown", async (t) => {
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  const marked = { kind: TOOL_STARTED, data: { tool: "web_search", charged_by: "parallel", call: "c1", heldUsd: 0.001 } };
  const open = [started, answer({ total: 0.002 }), marked];
  assert.equal(round(spentIn(storeOf(t, open))), 0.003, "a restarted process reads the held $0.001 as spent");
  assert.equal(capToolSpend(open), 0.001, "and so does another harness's, read at its open");
  assert.equal(timelineOf(open, { settled: true }).at(-1).usage.usd, null, "the run's shown cost: unknown, never the hold or $0");
  assert.deepEqual(metersIn(storeOf(t, open)), { tools: null, tokens: 0.002, browser: { usd: 0, seconds: 0 }, others: null }, "the tools meter: unknown");
});

test("a paid tool call a crash cut (marked, never settled) counts at its held figure in the cap's spend, leaves the run's reported cost unknown, and is no reported tool charge; settled, its charge alone", async (t) => {
  const marked = (heldUsd) => ({ kind: TOOL_STARTED, data: { tool: "monid.run", charged_by: "monid", call: "c1", heldUsd } });
  const charged = (usd) => ({ kind: TOOL_COST, data: { tool: "monid.run", charged_by: "monid", call: "c1", usd } });
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  // A monid call held at the $1 allowance, cut, beside a model request of $0.002.
  const cut = [started, answer({ total: 0.002 }), marked(1)];
  assert.equal(round(spentIn(storeOf(t, cut))), 1.002, "the cap counts the held figure");
  assert.equal(capToolSpend(cut), 1, "and so does another harness's, read at its open");
  assert.equal(timelineOf(cut, { settled: true }).at(-1).usage.usd, null, "the run's cost is unknown, never 1.002");
  assert.deepEqual(metersIn(storeOf(t, cut)), { tools: null, tokens: 0.002, browser: { usd: 0, seconds: 0 }, others: null }, "a cut call: the tools meter unknown, the tokens known, never the held $1");
  const settled = [...cut, charged(0.003)];
  assert.equal(round(spentIn(storeOf(t, settled))), 0.005, "its charge, not both");
  assert.equal(capToolSpend(settled), 0.003);
  assert.equal(timelineOf(settled, { settled: true }).at(-1).usage.usd, 0.005);
  assert.deepEqual(metersIn(storeOf(t, settled)), { tools: 0.003, tokens: 0.002, browser: { usd: 0, seconds: 0 }, others: 0.003 });
  assert.equal(metersIn(storeOf(t, [...settled, { kind: TOOL_COST, data: { call: "c2", usd: null } }])).tools, null, "an unknown charge is unknown");
  assert.deepEqual(metersIn(storeOf(t, [...settled, { kind: TOOL_COST, data: { tool: "browser", charged_by: "browserbase", call: "c3", usd: 0.002, seconds: 60 } }])).browser, { usd: 0.002, seconds: 60 }, "the browser's session time apart, with its seconds");
  // A live run's tools, from the same rows as its cost: the charge's line, never a mark.
  const { toolCostOf } = await import("../dist/runs.js");
  assert.equal(toolCostOf(timelineOf(cut)), 0);
  assert.equal(toolCostOf(timelineOf(settled)), 0.003);
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.001 }), marked(undefined)])), null, "cut with no figure: unknown, never $0");
});

test("/usage by meter for a run whose monid call a crash cut: its cost is unknown, filed under tools as unpriced; its tokens are known", { timeout: 120_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api, data } = await serve(t, { faux: new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname, fauxMonid: new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("slow", { tools: ["monid.run"], tool_settings: { "monid.run": { permission: "allow" } } }))).status, 201);
  const { body } = await api("POST", "/agents/slow/runs", { input: { content: "Run monid's /slow." } });
  for (let i = 0; !(existsSync(log) && readFileSync(log, "utf8").includes('"path":"/v1/run"')); i++) {
    assert.ok(i < 400, "the monid call is sent");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The run's process dies mid-call: the next one answers the call interrupted, never sends it again, and ends.
  process.kill(JSON.parse(readFileSync(join(data, "runs", body.run_id, "run.json"), "utf8")).holder.pid, "SIGKILL");
  await follow(api, body.run_id, ["completed"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${body.run_id}`)).body.cost.usd, null, "what the cut call charged no one knows");
  const { tokens } = metersIn(join(data, "runs", body.run_id, "store", "run.sqlite"));
  assert.ok(tokens > 0, `the model requests are priced: ${tokens}`);
  const meters = (await api("GET", "/usage?group_by=meter")).body.lines.map((line) => [line.meter, line.usd, line.unpriced_runs]);
  assert.deepEqual(meters, [["tokens", tokens, 0], ["tools", 0, 1]]);
});

test("a spend the store cannot say is unknown (null), never $0: a request a crash cut, a stopped answer, a cost that is not a number, a cut compaction, a cut request the cap's refusal follows", (t) => {
  const cases = {
    "a request marked as sent with no answer, the process gone": [started, answer({ total: 0.001 }), started],
    "an answer stopped before its end, whatever usage it reported, with no end mark (a crash)": [started, answer({ total: 0.001 }, "aborted")],
    "a store from before the figure: an answer stopped before its end, and an end mark with none": [started, answer({ total: 0.001 }, "aborted"), ended()],
    "a request stopped before any content, its end mark with no figure": [started, answer({ total: 0.001 }), started, ended()],
    "an answer whose cost is not a number": [started, answer({})],
    "a compaction marked as sent with no cost": [started, answer({ total: 0.001 }), compactionStarted],
    "a request a crash cut, then the cap's refusal in the next process, which answers no request": [started, answer({ total: 0.001 }), started, refused],
    "a request a stop cut with no figure, then the cap's refusal with its own mark": [started, answer({ total: 0.001 }), started, ended(), refusedStart, refused],
  };
  for (const [why, entries] of Object.entries(cases)) assert.equal(spentIn(storeOf(t, entries)), null, why);
});

test("a request a crash cut (marked as sent, no answer, no end) counts at the figure its start mark holds, whatever of it pi wrote, a summary's too", (t) => {
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  const answered = [startedHeld(0.001), answer({ total: 0.001 })];
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.4)]))), 0.401, "cut before any content");
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.4), answer({ total: 0 }, "aborted")]))), 0.401, "what had streamed of it, written aborted by the next process");
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.4), startedHeld(0.002), answer({ total: 0.002 })]))), 0.403, "and then the next process's request, answered");
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.2, { request: "compaction" })]))), 0.201, "a summary a crash cut");
  // Requests that overlap leave which one was cut unsaid: each open one counts at one of the largest figures, never less.
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.5), startedHeld(0.4), answer({ total: 0.001 })]))), 0.501);
});

test("the cap's refusal in its own words (its code with a note) is left out as any refusal: it closes no request a crash cut", (t) => {
  // pi's answer to a request the cap limited and then refused: "spend_cap_reached (out of budget): Not sent: ...".
  const refusedNow = { kind: "pi.assistant", model: [{ role: "assistant", content: [], usage: { cost: { total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached (out of budget): Not sent: the run has spent $0.401 of its $0.5 cap, and its next m request needs at least $0.11. Raise the cap to at least $0.52 to run it.", timestamp: 0 }] };
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.001), answer({ total: 0.001 }), startedHeld(0.4), refusedStart, refusedNow]))), 0.401, "the cut request still counts at its figure");
});

test("a cut request is unknown when its start mark holds no figure (an older store), and one request is counted once whatever marks and entry it has", (t) => {
  assert.equal(spentIn(storeOf(t, [startedHeld(0.001), answer({ total: 0.001 }), started])), null, "a start with no figure, cut");
  // Read in order, the answer closed the start before it, which holds no figure: the cut one is certain, at its own.
  assert.equal(Math.round(spentIn(storeOf(t, [started, answer({ total: 0.001 }), startedHeld(0.4)])) * 1e6) / 1e6, 0.401, "an older start, answered before the cut one started");
  assert.equal(spentIn(storeOf(t, [started, startedHeld(0.4), answer({ total: 0.001 })])), null, "a start with no figure that may still be the open one: which was cut is not certain");
  assert.equal(spentIn(storeOf(t, [startedHeld(0.2), started])), null, "a start with no figure still open at the crash, beside one with a figure: unknown, never the figure alone");
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  for (const [why, entries] of Object.entries({
    "start, aborted entry, end": [startedHeld(0.4), answer({ total: 0 }, "aborted"), ended(0.4)],
    "start, end, aborted entry": [startedHeld(0.4), ended(0.4), answer({ total: 0 }, "aborted")],
    "start, end": [startedHeld(0.4), ended(0.4)],
  })) assert.equal(round(spentIn(storeOf(t, entries))), 0.4, why);
});

test("a request stopped before its end counts at the figure its end mark holds, what the cap held for it, wherever pi's entry for it falls", (t) => {
  assert.equal(HELD_FIELD, "heldUsd", "the end mark's field, read by name");
  assert.equal(CAP_REFUSED_FIELD, "capRefused", "the refusal's start mark field, read by name");
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  const cases = {
    "its entry (what had streamed) before the end mark": [started, answer({ total: 0.001 }), started, answer({ total: 0 }, "aborted"), ended(0.5)],
    "its entry after the end mark": [started, answer({ total: 0.001 }), started, ended(0.5), answer({ total: 0 }, "aborted")],
    "no entry: stopped before any content": [started, answer({ total: 0.001 }), started, ended(0.5)],
  };
  for (const [why, entries] of Object.entries(cases)) assert.equal(round(spentIn(storeOf(t, entries))), 0.501, why);
  assert.equal(round(spentIn(storeOf(t, [started, answer({ total: 0.001 }), compactionStarted, ended(0.2, { request: "compaction" })]))), 0.201, "a summary stopped before its end, at its figure");
  assert.equal(round(spentIn(storeOf(t, [started, ended(0.5), started, answer({ total: 0.002 }), refusedStart, refused]))), 0.502, "the cap's refusal, marked, answers its own mark");
});

test("after a crash, each request still open counts at its own start's figure: a start an answer or an end mark closed is never counted again", (t) => {
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.3), answer({ total: 0.2 }), startedHeld(0.1)]))), 0.3, "answered at 0.20 before the cut one (held 0.10) started: 0.20 + 0.10, never the answered start's 0.30 again");
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.1), startedHeld(0.3), ended(0.3)]))), 0.4, "one stopped at 0.30 (its end mark) and one a crash cut, held 0.10: 0.30 + 0.10");
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.3), ended(0.3), startedHeld(0.1)]))), 0.4, "the same, the stop before the cut one started");
  // Requests that overlap: the marks do not say which one an answer closed, so it closes the smallest figure still open.
  // Its cost is not read as a clue: a held figure is the cap's worst case, and a reading that trusted it never to be
  // passed would count less than was spent if it ever were.
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.1), startedHeld(0.3), answer({ total: 0.2 })]))), 0.5, "either can have been cut: at the larger, 0.30");
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.5), startedHeld(0.2), answer({ total: 0.1 }), startedHeld(0.3)]))), 0.9, "an overlap, then a request after it: 0.10 + 0.50 + 0.30");
});

/** The most the marks `events` allow the run to have spent: each answer can have closed any request open when it came,
 *  each end mark one open with its figure, and each request still open at the end counts at its figure. */
const mostOf = (events, open = [], i = 0) => {
  if (i === events.length) return open.reduce((sum, figure) => sum + figure, 0);
  const [kind, x] = events[i];
  const without = (figure) => {
    const at = open.indexOf(figure);
    return [...open.slice(0, at), ...open.slice(at + 1)];
  };
  if (kind === "start") return mostOf(events, [...open, x], i + 1);
  if (kind === "end") return open.includes(x) ? x + mostOf(events, without(x), i + 1) : -Infinity;
  if (!open.length) return x + mostOf(events, open, i + 1);
  return Math.max(...[...new Set(open)].map((figure) => x + mostOf(events, without(figure), i + 1)));
};

test("read in order, the spend after a crash is never less than any reading of the marks allows, and exactly what was spent when no requests overlap", (t) => {
  // mulberry32: a 32-bit state stepped with Math.imul, so every bit is exact. A product past 2^53 would lose its low
  // bits, and rand(2) with them.
  let seed = 1377;
  const rand = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
  const FIGURES = [0.1, 0.2, 0.3, 0.4, 0.5];
  // A run's requests as they went: each one opens with its start mark, and may close by an answer (at most its figure)
  // or a stop (its end mark); the process then crashes, cutting the rest. `serial`: each closes before the next opens.
  const runOf = (serial) => {
    const entries = [];
    const events = [];
    const open = [];
    let spent = 0;
    let overlapping = 0;
    for (let step = 0, steps = 1 + rand(7); step < steps; step++) {
      const opening = open.length === 0 || (!serial && rand(2) === 0);
      if (opening) {
        const figure = FIGURES[rand(FIGURES.length)];
        open.push(figure);
        entries.push(startedHeld(figure));
        events.push(["start", figure]);
        continue;
      }
      // A close while another request is open too: which one it closed is what the reading has to get right.
      if (open.length > 1) overlapping += 1;
      const [figure] = open.splice(rand(open.length), 1);
      if (rand(2) === 0) {
        const cost = Math.round(figure * rand(5) * 25_000) / 100_000;
        entries.push(answer({ total: cost }));
        events.push(["answer", cost]);
        spent += cost;
      } else {
        entries.push(ended(figure));
        events.push(["end", figure]);
        spent += figure;
      }
    }
    return { entries, events, overlapping, most: spent + open.reduce((sum, figure) => sum + figure, 0) };
  };
  const seen = { answers: 0, ends: 0, overlapping: 0 };
  for (let i = 0; i < 300; i++) {
    const { entries, events, overlapping, most: actual } = runOf(false);
    seen.answers += events.filter(([kind]) => kind === "answer").length;
    seen.ends += events.filter(([kind]) => kind === "end").length;
    seen.overlapping += overlapping;
    const got = spentIn(storeOf(t, entries));
    assert.ok(got >= mostOf(events) - 1e-9, `never less than the marks allow: ${got} for ${JSON.stringify(events)}`);
    assert.ok(got >= actual - 1e-9, `never less than what the run can have spent: ${got} < ${actual}`);
  }
  // The walk covers what it checks: answers, end marks, and closes while requests overlap, each well past a handful.
  t.diagnostic(`overlapping runs: ${seen.answers} answers, ${seen.ends} end marks, ${seen.overlapping} closes while requests overlap`);
  for (const [what, count] of Object.entries(seen)) assert.ok(count >= 50, `the generator made only ${count} ${what}`);
  for (let i = 0; i < 300; i++) {
    const { entries, events, most } = runOf(true);
    assert.ok(Math.abs(spentIn(storeOf(t, entries)) - most) < 1e-9, `exact with no overlap: ${JSON.stringify(events)}`);
  }
});

/** pi's entry for `message`, as it writes a request's answer or error. */
const entryOf = (message) => ({ kind: "pi.assistant", model: [message] });
/** A run whose store keeps the marks it is given, or refuses every write (`refusing`). */
const markStore = (refusing = false) => {
  const marks = [];
  const commit = async (change) => (refusing ? Promise.reject(new Error("the store refused the write")) : change({ appendEntry: async (_conversation, entry) => void marks.push(entry) }));
  return { marks, run: { harness: { commit } } };
};
const FAUX_MODEL = { api: "faux", provider: "faux", id: "m" };

test("a request that never left answers none: pi's error for one whose start mark could not be written, and a cancel's refusal, close no other request", async (t) => {
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  // request-start's own path: the store refuses the start mark, so the request is not sent, and pi gets the error it
  // writes as the request's entry. The cap reads that error by the same constant request-start builds it from.
  let sent = 0;
  const { models, open } = await markRequests({ streamSimple: () => (sent++, { async *[Symbol.asyncIterator]() {}, result: async () => ({}) }) });
  open(markStore(true).run);
  const notSent = await models.streamSimple(FAUX_MODEL, { messages: [] }, {}).result();
  assert.equal(sent, 0, "the request did not leave");
  assert.equal(notSent.stopReason, "error");
  assert.ok(notSent.errorMessage.startsWith(MARK_NOT_WRITTEN), notSent.errorMessage);
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.4), entryOf(notSent)]))), 0.4, "the request in flight at the crash is not answered by it: counted at its figure");
  // A figureless start in flight when another request's mark failed; that process crashed, the next sent a request (held
  // 0.30) and crashed too. The figureless one was cut: unknown, never 0.30.
  assert.equal(spentIn(storeOf(t, [started, entryOf(notSent), startedHeld(0.3)])), null, "a figureless start left open stays unknown");
  // A cancel's refusal, through request-start's own path: its mark, then pi's error for it. Together they are no request.
  const { marks, run } = markStore();
  const cancelled = await markRequests({ streamSimple: () => (sent++, {}) }, () => true);
  cancelled.open(run);
  const refusal = await cancelled.models.streamSimple(FAUX_MODEL, { messages: [] }, {}).result();
  assert.equal(sent, 0, "the cancelled request did not leave");
  assert.deepEqual(marks.map((m) => m.kind), [REQUEST_REFUSED]);
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.3), ...marks, entryOf(refusal)]))), 0.3, "the request in flight still counts; the refusal closes nothing");
});

test("the run's shown cost is the timeline's, unchanged: a stopped request is unknown there, and a refusal after it never makes it $0", () => {
  const shown = (entries) => timelineOf(entries.map((entry) => ({ conversationId: 1, ...entry })), { settled: true }).find((row) => row.kind === "usage")?.usage?.usd;
  assert.equal(shown([started, answer({ total: 0.001 }), started, answer({ total: 0 }, "aborted"), ended(0.5)]), null, "stopped with content: unknown");
  assert.equal(shown([started, answer({ total: 0.001 }), started, ended(0.5), refusedStart, refused]), null, "stopped before content, then refused: unknown, never $0");
  assert.equal(shown([started, answer({ total: 0.001 }), started, ended(0.5), started, answer({ total: 0.002 })]), null, "stopped, then answered: unknown");
});

/** The usage row a settled run shows, and its meter's request count and unmetered requests (runMetricsOf). */
const meterOf = (entries) => {
  const all = entries.map((entry) => ({ conversationId: 1, ...entry }));
  const { requests, unmetered } = runMetricsOf(all);
  return { usage: timelineOf(all, { settled: true }).find((row) => row.kind === "usage")?.usage, requests, unmetered };
};
/** pi's entry for a request the cap refused, as capModels makes it: an error with zero counts and no cost. */
const refusalEntry = { kind: "pi.assistant", model: [{ role: "assistant", content: [], api: "faux", provider: "faux", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached (out of budget): Not sent: the run has spent $0.001 of its $1 cap, and its next m request needs at least $1.01. Raise the cap to at least $1.02 to run it.", timestamp: 0 }] };
/** The same refusal as an older store has it: the words serve wrote then, and no start mark of its own. */
const olderRefusal = { kind: "pi.assistant", model: [{ role: "assistant", content: [], api: "faux", provider: "faux", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached: the next model request was not sent. It could cost up to $1.000000, and with $0.001000 spent the run would pass its cap of $1: the run is out of budget.", timestamp: 0 }] };
const paidEntry = { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "faux", provider: "faux", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason: "stop", timestamp: 0 }] };

test("a refusal for room with its own start mark is no request on the run's meter: the cost stays known, and the count is the requests that were sent", () => {
  // An older store's refusal, with no mark, cannot be told from a request that failed: it counts, as it did.
  assert.deepEqual(meterOf([started, paidEntry, olderRefusal]), { usage: { usd: 0.001, requests: 2 }, requests: 2, unmetered: 0 }, "the refusal as an older store has it");
  assert.deepEqual(meterOf([started, paidEntry, refusedStart, refusalEntry]), { usage: { usd: 0.001, requests: 1 }, requests: 1, unmetered: 0 }, "its mark first, as the cap writes it: no request");
  assert.deepEqual(meterOf([refusedStart, refusalEntry]), { usage: { usd: 0, requests: 0 }, requests: 0, unmetered: 0 }, "a refusal as the run's first request: a run that sent none, its usage line saying so");
  // A refusal's mark never makes a cut, even after its entry (the cap never writes them so): it marks no request.
  assert.equal(meterOf([refusalEntry, refusedStart]).usage.usd, 0);
});

/** A Models whose every request is recorded and stays open until the test ends it with the answer it gives. */
function fakeModels() {
  const sent = [];
  const send = () => {
    const events = createAssistantMessageEventStream();
    const end = ({ total, stopReason = "stop" } = {}) => {
      const cost = total === undefined ? {} : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total };
      const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost }, stopReason, timestamp: Date.now() };
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    };
    sent.push({ end });
    return events;
  };
  const models = {
    stream: send, streamSimple: send,
    complete: (...args) => send(...args).result(), completeSimple: (...args) => send(...args).result(),
    streamDeferred: send, fetchDeferred: (...args) => send(...args).result(),
  };
  return { models, sent };
}

const model = (cost, ceiling = { maxTokens: 1_000, contextWindow: 128_000 }) => ({ id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: true, input: ["text"], cost, ...ceiling });
const priced = model({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("pi under a cap, with a spend the store cannot say: every request is refused and none is sent", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1, null);
  const streamed = capped.streamSimple(priced, context);
  const completed = capped.completeSimple(priced, context);
  assert.equal(sent.length, 0, "none is sent");
  assert.match((await streamed.result()).errorMessage, UNKNOWN);
  assert.match((await completed).errorMessage, UNKNOWN);
});

test("pi under a cap: an answer whose cost is unknown makes what the run has spent unknown, and the next request is refused", async () => {
  for (const [why, ending] of [["no cost total", {}]]) {
    const { models, sent } = fakeModels();
    const capped = await capModels(models, 1, 0);
    const first = capped.streamSimple(priced, context);
    sent[0].end(ending);
    await first.result();
    await settle();
    const next = capped.streamSimple(priced, context);
    assert.equal(sent.length, 1, `${why}: the next request is not sent`);
    assert.match((await next.result()).errorMessage, UNKNOWN, why);
  }
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1, 0);
  const first = capped.streamSimple(priced, context);
  sent[0].end({ total: 0.0001 });
  await first.result();
  await settle();
  const next = capped.streamSimple(priced, context);
  assert.equal(sent.length, 2, "after an answer of known cost the next request goes");
  sent[1].end({ total: 0 });
  await next.result();
});

// $1 a million output tokens and nothing for input, a ceiling of 1,000: each request's worst case is $0.001 exactly.
const outputOnly = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });

test("after a crash, the cut request's held worst case is spent: the next request goes while that leaves room, and is refused once it does not", async (t) => {
  // One request's worst case is $0.001; the crash cut one, held at that.
  const spent = spentIn(storeOf(t, [startedHeld(0.001)]));
  assert.equal(spent, 0.001);
  for (const [cap, sends] of [[0.0025, 1], [0.0015, 0]]) {
    const { models, sent } = fakeModels();
    const next = (await capModels(models, cap, spent)).streamSimple(outputOnly, context);
    assert.equal(sent.length, sends, `a cap of $${cap}`);
    if (sends) sent[0].end({ total: 0 });
    else assert.match((await next.result()).errorMessage, /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$0\.001 of its \$0\.0015 cap, and its next m request needs at least \$0\.01\. Raise the cap to at least \$0\.01 to run it\.$/);
    await next.result();
  }
});

test("the spend a reopened run reads is the full amount, never the timeline's total rounded for display: $0.0000004 spent is $0.0000004, and a request it leaves no room for is refused", async (t) => {
  // Below the six decimals the timeline shows: rounded, it would read $0.
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.0000004 })])), 0.0000004);
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.0000001 }), compactionStarted, { kind: REQUEST_COST, data: { request: "compaction", usd: 0.0000002 } }, started, ended(0.0000001)])), 0.0000001 + 0.0000002 + 0.0000001, "answers, a summary's cost and a stopped request's held figure, summed as they are");
  // One request's worst case is $0.001; a cap $0.0000002 above it has no room once $0.0000004 is spent.
  const spent = spentIn(storeOf(t, [started, answer({ total: 0.0000004 })]));
  const { models, sent } = fakeModels();
  const next = (await capModels(models, 0.001 + 0.0000002, spent)).streamSimple(outputOnly, context);
  assert.equal(sent.length, 0, "not sent: $0.0000004 spent and $0.001 held pass the cap");
  assert.match((await next.result()).errorMessage, /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$0\.0000004 of its \$0\.0010002 cap, and its next m request needs at least \$0\.01\. Raise the cap to at least \$0\.01 to run it\.$/);
});

test("pi under a cap: a request stopped before its end whose stream and the 1,024-token allowance pass its limit counts at the worst case the cap held for it, which it hands its marks; the next goes while that leaves room, and is refused once it does not", async () => {
  const options = [];
  const { models, sent } = fakeModels();
  const record = (send) => (model, ctx, opts) => (options.push(opts?.[HELD_USD]), send(model, ctx, opts));
  const capped = await capModels({ ...models, streamSimple: record(models.streamSimple) }, 0.0025, 0);
  for (const turn of [0, 1]) {
    const request = capped.streamSimple(outputOnly, context);
    assert.equal(sent.length, turn + 1, `request ${turn + 1} goes: $${turn * 0.001} spent and $0.001 held fit $0.0025`);
    // Stopped, its stream reporting no usage, as the Responses API's does: its 2 bytes and 1,024 tokens pass the 1,000 it
    // was sent with, so it counts at its $0.001.
    sent[turn].end({ total: 0, stopReason: "aborted" });
    await request.result();
    await settle();
  }
  assert.deepEqual(options, [0.001, 0.001], "each request carries what the cap held for it to its marks");
  const third = capped.streamSimple(outputOnly, context);
  assert.equal(sent.length, 2, "with $0.002 counted, $0.001 more passes $0.0025");
  assert.match((await third.result()).errorMessage, /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$0\.002 of its \$0\.0025 cap, and its next m request needs at least \$0\.01\. Raise the cap to at least \$0\.01 to run it\.$/);
});

/** Requests the test ends itself, each recorded with the options it went with: `end(stopReason, text, total)` streams
 *  `text` as its content (a string as one text block, an array as the blocks themselves) and ends it so. */
function streamingModels() {
  const sent = [];
  const send = (m, ctx, options) => {
    const events = createAssistantMessageEventStream();
    const end = (stopReason, text, total) => {
      const message = { role: "assistant", content: Array.isArray(text) ? text : text ? [{ type: "text", text }] : [], api: "fake", provider: "fake", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } }, stopReason, timestamp: Date.now() };
      events.push(stopReason === "aborted" ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: "stop", message });
      events.end(message);
    };
    sent.push({ options, end });
    return events;
  };
  return { sent, models: { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result(), streamDeferred: send, fetchDeferred: (...a) => send(...a).result() } };
}
/** $100 a million output tokens, input free, a 64,000-token ceiling: what it asks for passes a $1 cap, so it is clamped. */
const clamped = { ...model({ input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, { maxTokens: 64_000, contextWindow: 200_000 }), reasoning: false };
/** $10,000 a million output tokens: its least (1,024 tokens) is $10.24, which no cap here can buy. */
const dear = { ...model({ input: 0, output: 10_000, cacheRead: 0, cacheWrite: 0 }), reasoning: false };
/** What the cap says a run has spent, from its refusal of a request on `dear`. */
const spentSaid = async (capped) => {
  const why = (await capped.streamSimple(dear, context).result()).errorMessage;
  const said = /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$(\d+(?:\.\d+)?) of its /.exec(why ?? "");
  assert.ok(said, `refused, saying what was spent: ${why}`);
  return Number(said[1]);
};
/** The tokens a stopped request counts beyond what it streamed: what the provider may have made after the last event. */
const STOP_ALLOWANCE = 1_024;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

test("pi under a cap: a request the person stops counts at what it can have cost, never past its hold: its input, each byte it streamed as a token, and 1,024 tokens more; a clamped one no longer takes the rest of the cap, so the next request goes", async () => {
  // QA 7.4: a $1 cap, $0.004 spent; the request is clamped to what $0.996 buys and held at that, then stopped.
  const { models, sent } = streamingModels();
  const capped = await capModels(models, 1, 0.004);
  const first = capped.streamSimple(clamped, context, { maxTokens: 64_000 });
  assert.equal(sent[0].options.maxTokens, 9_960, "clamped to what is left");
  sent[0].end("aborted", "Half of one.md", 0.0002);
  await first.result();
  await settle();
  const next = capped.streamSimple(clamped, context, { maxTokens: 64_000 });
  assert.equal(sent.length, 2, "the follow-up is sent: the stop counted what it can have cost, not the $0.996 held for it");
  // 14 bytes streamed and 1,024 tokens more, at $100 a million: $0.1038, beside the $0.004 spent before.
  sent[1].end("stop", "Done.", 0.001);
  await next.result();
  await settle();
  assert.equal(await spentSaid(capped), eight(0.004 + (14 + STOP_ALLOWANCE) * 100 / 1e6 + 0.001), "$0.004, the stop at $0.1038, the follow-up's $0.001");
  // Its input counts in full: on a model whose input is priced, the stop is its hold less the output it was held for,
  // plus what it streamed and the allowance.
  const other = streamingModels();
  const run = await capModels(other.models, 1, 0);
  const asked = run.streamSimple({ ...clamped, cost: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 } }, context, { maxTokens: 64_000 });
  const [held, most] = [other.sent[0].options[HELD_USD], other.sent[0].options.maxTokens];
  other.sent[0].end("aborted", "abc", 0);
  await asked.result();
  await settle();
  const input = held - most * 100 / 1e6;
  assert.ok(input > 0, `the input is priced: $${input}`);
  assert.equal(await spentSaid(run), eight(input + (3 + STOP_ALLOWANCE) * 100 / 1e6), "the input, 3 bytes and the allowance");
  // Never past its hold: a stop whose stream and allowance pass what it was held for counts at the hold.
  const tight = streamingModels();
  const small = await capModels(tight.models, 0.11, 0);
  const cut = small.streamSimple(clamped, context, { maxTokens: 64_000 });
  assert.ok(tight.sent[0].options.maxTokens < 500 + STOP_ALLOWANCE, `clamped to what $0.11 buys: ${tight.sent[0].options.maxTokens} tokens`);
  const hold = tight.sent[0].options[HELD_USD];
  tight.sent[0].end("aborted", "x".repeat(500), 0);
  await cut.result();
  await settle();
  assert.equal(await spentSaid(small), eight(hold), "500 bytes and 1,024 tokens pass its limit: at its hold");
});

test("a stopped request counts every byte it streamed, whatever its blocks hold: thinking, a tool call's name and arguments, and text outside ASCII, each UTF-8 byte a token", async () => {
  const thinking = "Je réfléchis… 思考する";
  const call = { name: "write", arguments: { path: "notes/é.md", text: "naïve ✓ — 1 €" } };
  const text = "Écrit ✓";
  const content = [{ type: "thinking", thinking }, { type: "toolCall", id: "c1", ...call }, { type: "text", text }];
  // UTF-8 bytes, never characters: each of these takes more bytes than it has characters.
  const bytes = Buffer.byteLength(thinking) + Buffer.byteLength(`${call.name}${JSON.stringify(call.arguments)}`) + Buffer.byteLength(text);
  assert.equal(streamedBytes({ content }), bytes);
  assert.ok(bytes > thinking.length + call.name.length + JSON.stringify(call.arguments).length + text.length, "more bytes than characters");
  // Each block alone counts its own bytes, so none is left out of the sum.
  assert.deepEqual(content.map((block) => streamedBytes({ content: [block] })), [Buffer.byteLength(thinking), Buffer.byteLength(`${call.name}${JSON.stringify(call.arguments)}`), Buffer.byteLength(text)]);
  // Stopped under $1 with $0.004 spent, clamped: it counts those bytes and the allowance, at the output price.
  const { models, sent } = streamingModels();
  const capped = await capModels(models, 1, 0.004);
  const request = capped.streamSimple(clamped, context, { maxTokens: 64_000 });
  sent[0].end("aborted", content, 0);
  await request.result();
  await settle();
  assert.equal(await spentSaid(capped), eight(0.004 + (bytes + STOP_ALLOWANCE) * 100 / 1e6));
});

/** A gpt-5-class model on the Responses API: $1.25 a million input tokens, $10 a million output, reasoning that streams
 *  only its summary. */
const responsesReasoner = { ...model({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, { maxTokens: 128_000, contextWindow: 400_000 }), id: "gpt-5", api: "openai-responses", provider: "openai", reasoning: true };
/** A Claude-class model on the Messages API, whose thinking takes a budget: $3 a million input, $15 output. */
const budgetReasoner = { ...model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, { maxTokens: 64_000, contextWindow: 200_000 }), id: "claude", api: "anthropic-messages", provider: "anthropic", reasoning: true };
/** A 20 KB context: one message of 20,000 bytes. */
const twentyKb = { messages: [{ role: "user", content: "x".repeat(20_000), timestamp: 0 }] };
/** About 300 bytes of reasoning summary: all a Responses stream shows of thousands of reasoning tokens. */
const SUMMARY = "**Weighing the options**\n\nI compared the two layouts, checked the totals against the ledger, and settled on the second, since it keeps the running balance in one column and the notes beside each entry, which the reader asked for; the first would split them across pages.";
/** The thinking budget of each level, as pi-ai's defaults set it. */
const LEVEL_BUDGET = { minimal: 1_024, low: 2_048, medium: 8_192, high: 16_384 };

test("pi under a cap: a request whose reasoning is hidden, stopped after its summary streamed, counts the part of its reasoning budget that never streamed (the reader's case: a gpt-5-class model, a 20 KB context, a stop after ~10k hidden reasoning tokens, past medium's 8,192, costs about $0.106): the effort budget's figure, at least that, and never past its hold", async () => {
  const { models, sent } = streamingModels();
  const capped = await capModels(models, 1, 0);
  const request = capped.streamSimple(responsesReasoner, twentyKb, { reasoning: "medium" });
  const [held, most] = [sent[0].options[HELD_USD], sent[0].options.maxTokens];
  // Its input as the cap prices it: the hold less the output it was sent with.
  const input = held - most * 10 / 1e6;
  sent[0].end("aborted", [{ type: "thinking", thinking: SUMMARY }], 0);
  await request.result();
  await settle();
  const spent = await spentSaid(capped);
  const summary = Buffer.byteLength(SUMMARY);
  // Its input, the summary's bytes, the 1,024-token allowance, and what of medium effort's 8,192-token reasoning budget
  // did not stream: max(0, 8,192 - the summary's bytes). So the summary and the budget together count 8,192 tokens.
  assert.equal(spent, eight(input + (summary + STOP_ALLOWANCE + Math.max(0, LEVEL_BUDGET.medium - summary)) * 10 / 1e6), "the stop counts the unstreamed part of its reasoning budget");
  assert.ok(spent >= 0.106, `at least what the reader's stop cost: $${spent}`);
  assert.ok(spent <= eight(held), `never past its hold, $${held}: $${spent}`);
});

test("pi under a cap: a request whose hidden reasoning came before 8,000 bytes of answer text, then stopped, counts all it streamed and the whole unstreamed part of its reasoning budget: the text does not stand in for reasoning it never showed", async () => {
  const { models, sent } = streamingModels();
  const capped = await capModels(models, 1, 0);
  const request = capped.streamSimple(responsesReasoner, twentyKb, { reasoning: "medium" });
  const [held, most] = [sent[0].options[HELD_USD], sent[0].options.maxTokens];
  const input = held - most * 10 / 1e6;
  const text = "The ledger balances once the March entries move to April. ".repeat(140).slice(0, 8_000);
  sent[0].end("aborted", [{ type: "thinking", thinking: SUMMARY }, { type: "text", text }], 0);
  await request.result();
  await settle();
  const spent = await spentSaid(capped);
  const summary = Buffer.byteLength(SUMMARY);
  // The summary, the text, the allowance, and the 8,192-token budget less the summary: about 17,500 tokens of output.
  assert.equal(spent, eight(input + (summary + Buffer.byteLength(text) + STOP_ALLOWANCE + Math.max(0, LEVEL_BUDGET.medium - summary)) * 10 / 1e6), "the text and the unstreamed reasoning both count");
  assert.ok(spent <= eight(held), `never past its hold: $${spent}`);
});

test("pi under a cap: a reasoning model sent with no thinking level, stopped, counts its whole output limit, its hold: its reasoning is hidden and its effort unknown", async () => {
  const { models, sent } = streamingModels();
  const capped = await capModels(models, 1, 0);
  const request = capped.streamSimple(responsesReasoner, twentyKb);
  const held = sent[0].options[HELD_USD];
  sent[0].end("aborted", [{ type: "thinking", thinking: SUMMARY }], 0);
  await request.result();
  await settle();
  assert.equal(await spentSaid(capped), eight(held), "at its hold");
});

test("pi under a cap: a Messages request that thinks, stopped after a short thinking summary streamed, counts the unstreamed part of its thinking budget; stopped after about a budget's worth of thinking streamed, nothing on top; with thinking off, what streamed and the allowance only", async () => {
  const { models, sent } = streamingModels();
  const capped = await capModels(models, 1, 0);
  const request = capped.streamSimple(budgetReasoner, twentyKb, { reasoning: "medium" });
  const opts = sent[0].options;
  // On a budget API the budget is part of the output it was sent with: maxTokens beside the budget, or the budget pi-ai adds.
  const budget = opts.thinkingBudgets?.medium ?? LEVEL_BUDGET.medium;
  const limit = opts.maxTokens + (opts.thinkingBudgets ? budget : 0);
  const input = opts[HELD_USD] - limit * 15 / 1e6;
  sent[0].end("aborted", [{ type: "thinking", thinking: SUMMARY }], 0);
  await request.result();
  await settle();
  const spent = await spentSaid(capped);
  const short = Buffer.byteLength(SUMMARY);
  assert.equal(spent, eight(input + (short + STOP_ALLOWANCE + Math.max(0, budget - short)) * 15 / 1e6), "the stop counts the unstreamed part of its thinking budget");
  assert.ok(spent <= eight(opts[HELD_USD]), `never past its hold: $${spent}`);
  // The lead's case: about a budget's worth of thinking streamed (8,300 bytes against the 8,192-token budget), then a stop.
  // The thinking is all there to count: nothing of the budget goes on top, so the stop counts its input, what streamed
  // and the 1,024-token allowance (exactly: max(0, budget - streamed) is 0 here).
  const visible = streamingModels();
  const thinker = await capModels(visible.models, 1, 0);
  const shown = thinker.streamSimple(budgetReasoner, twentyKb, { reasoning: "medium" });
  const vo = visible.sent[0].options;
  const vBudget = vo.thinkingBudgets?.medium ?? LEVEL_BUDGET.medium;
  const vInput = vo[HELD_USD] - (vo.maxTokens + (vo.thinkingBudgets ? vBudget : 0)) * 15 / 1e6;
  const thought = "Let me work through the ledger. ".repeat(260).slice(0, 8_300);
  assert.ok(Buffer.byteLength(thought) >= vBudget, "setup: a budget's worth of thinking streamed");
  visible.sent[0].end("aborted", [{ type: "thinking", thinking: thought }], 0);
  await shown.result();
  await settle();
  assert.equal(await spentSaid(thinker), eight(vInput + (Buffer.byteLength(thought) + STOP_ALLOWANCE) * 15 / 1e6), "thinking that streamed: nothing of the budget on top");
  // Thinking off: no hidden reasoning, as before.
  const off = streamingModels();
  const plain = await capModels(off.models, 1, 0);
  const asked = plain.streamSimple(budgetReasoner, twentyKb);
  const [held, most] = [off.sent[0].options[HELD_USD], off.sent[0].options.maxTokens];
  off.sent[0].end("aborted", "abc", 0);
  await asked.result();
  await settle();
  assert.equal(await spentSaid(plain), eight(held - most * 15 / 1e6 + (3 + STOP_ALLOWANCE) * 15 / 1e6), "thinking off: its input, 3 bytes and the allowance");
});

/** A Claude entry of pi-ai's own catalog, on Anthropic's API. */
const catalogClaude = async (id) => {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const found = builtinModels({}).getModel("anthropic", id);
  assert.ok(found, `pi-ai's catalog lists ${id}`);
  return found;
};
/** What a request on `on` with `context` holds for its input under a $1 cap: the hold of one asking 2,000 tokens, less
 *  their price. */
const inputHeld = async (on, context) => {
  const { models, sent } = streamingModels();
  void (await capModels(models, 1, 0)).streamSimple(on, context, { maxTokens: 2_000 });
  return sent[0].options[HELD_USD] - 2_000 * on.cost.output / 1e6;
};
/** Adaptive thinking takes no budget: pi-ai sends the model's maxTokens as is and it thinks within them as it sees fit.
 *  Sonnet 5.5 thinks adaptively at every level, a level or none (supportsMidConvoEffort); Opus 4.7 when given a level. */
const ADAPTIVE = [["claude-sonnet-5-5", { reasoning: "medium" }], ["claude-sonnet-5-5", { reasoning: "high" }], ["claude-opus-4-7", { reasoning: "medium" }], ["claude-sonnet-5-5", {}]];

for (const [id, options] of ADAPTIVE) {
  test(`pi under a cap: a request to ${id}${options.reasoning ? ` at ${options.reasoning}` : " with no level"}, whose thinking is adaptive (no budget, bounded only by its output limit), stopped after a 300-byte thinking summary, counts the whole limit's unstreamed thinking: at its hold (the reader's case on Sonnet 5.5: a 20 KB context under a $1 cap, where ~40,000 adaptive thinking tokens cost about $0.45, counted $0.142 at medium and $0.224 at high: its level's budget, never sent; claude-agent's reader gives the hold for the same body)`, async () => {
    const claude = await catalogClaude(id);
    assert.ok(claude.compat?.forceAdaptiveThinking === true || claude.compat?.supportsMidConvoEffort === true, "setup: pi-ai thinks adaptively on it");
    const per = claude.cost.output / 1e6;
    const input = await inputHeld(claude, twentyKb);
    const { models, sent } = streamingModels();
    const capped = await capModels(models, 1, 0);
    const request = capped.streamSimple(claude, twentyKb, options);
    const held = sent[0].options[HELD_USD];
    sent[0].end("aborted", [{ type: "thinking", thinking: SUMMARY }], 0);
    await request.result();
    await settle();
    const spent = await spentSaid(capped);
    // ~40,000 thinking tokens, or what the $1 cap buys when that is less (Opus 4.7's $25 a million).
    const thought = Math.min(40_000, Math.floor((1 - input) / per));
    assert.ok(spent >= eight(input + thought * per), `at least what ${thought} adaptive thinking tokens cost, $${eight(input + thought * per)}: $${spent}`);
    assert.equal(spent, eight(held), "at its hold: what streamed, the allowance and the limit's unstreamed thinking fill its output limit");
  });

  test(`pi under a cap: a request to ${id}${options.reasoning ? ` at ${options.reasoning}` : " with no level"}, whose thinking is adaptive, is sent with the output limit it is held at, no budget taken out of it: pi-ai sends an adaptive model's maxTokens as is`, async () => {
    const claude = await catalogClaude(id);
    const per = claude.cost.output / 1e6;
    const input = await inputHeld(claude, twentyKb);
    const { models, sent } = streamingModels();
    void (await capModels(models, 1, 0)).streamSimple(claude, twentyKb, options);
    const { maxTokens, [HELD_USD]: held, thinkingBudgets } = sent[0].options;
    assert.equal(eight(input + maxTokens * per), eight(held), `sent with ${maxTokens} tokens, held at $${held}`);
    assert.equal(thinkingBudgets, undefined, "no budget: pi-ai sends none to an adaptive model");
  });
}

test("pi under a cap: a request to a Claude model whose thinking takes a budget (pi-ai's Sonnet 4.5), stopped after a 300-byte thinking summary, still counts its level's budget, the budget it was sent with, not its whole limit", async () => {
  const claude = await catalogClaude("claude-sonnet-4-5");
  assert.ok(claude.compat?.forceAdaptiveThinking !== true && claude.compat?.supportsMidConvoEffort !== true, "setup: pi-ai sends it a thinking budget");
  const per = claude.cost.output / 1e6;
  const { models, sent } = streamingModels();
  const capped = await capModels(models, 1, 0);
  const request = capped.streamSimple(claude, twentyKb, { reasoning: "medium" });
  const opts = sent[0].options;
  const budget = opts.thinkingBudgets?.medium ?? LEVEL_BUDGET.medium;
  const input = opts[HELD_USD] - (opts.maxTokens + (opts.thinkingBudgets ? budget : 0)) * per;
  sent[0].end("aborted", [{ type: "thinking", thinking: SUMMARY }], 0);
  await request.result();
  await settle();
  const summary = Buffer.byteLength(SUMMARY);
  assert.equal(await spentSaid(capped), eight(input + (summary + STOP_ALLOWANCE + Math.max(0, budget - summary)) * per), "its level's budget, less what streamed");
});

test("pi under a cap: a summary that fails with no answer counts at the worst case the cap held for it", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels({ ...models, completeSimple: () => Promise.reject(new Error("the connection reset")) }, 0.0015, 0);
  await assert.rejects(capped.completeSimple(outputOnly, context));
  await settle();
  const next = capped.streamSimple(outputOnly, context);
  assert.equal(sent.length, 0, "$0.001 counted and $0.001 more passes $0.0015");
  assert.match((await next.result()).errorMessage, /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$0\.001 of its \$0\.0015 cap, and its next m request needs at least \$0\.01\. Raise the cap to at least \$0\.01 to run it\.$/);
});

test("pi under a cap: a refused request's own start mark is written before its error ends the request, and a mark that fails still ends it", async () => {
  for (const fails of [false, true]) {
    const order = [];
    const { models } = fakeModels();
    const refused = async () => {
      order.push("mark");
      if (fails) throw new Error("the store is full");
    };
    const capped = await capModels(models, 0.0005, 0, { refused });
    const answer = await capped.streamSimple(outputOnly, context).result();
    order.push("answer");
    assert.deepEqual(order, ["mark", "answer"], fails ? "a failed mark" : "the mark first");
    assert.match(answer.errorMessage, /^spend_cap_reached \(out of budget\): Not sent: /);
  }
});

const NONE = [["a ceiling and a window of 0", { maxTokens: 0, contextWindow: 0 }], ["neither named", {}]];

test("pi under a cap: a model whose output is priced and that has no output ceiling is refused, whatever the request asks; one whose output costs nothing passes", async () => {
  for (const [why, ceiling] of NONE) {
    for (const cost of [{ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 0, input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }] }]) {
      const { models, sent } = fakeModels();
      const answer = (await capModels(models, 1_000, 0)).streamSimple(model(cost, ceiling), context, { maxTokens: 100 });
      assert.equal(sent.length, 0, `${why}: not sent`);
      assert.match((await answer.result()).errorMessage, NO_CEILING, why);
    }
    const { models, sent } = fakeModels();
    const answer = (await capModels(models, 0.000001, 0)).streamSimple(model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ceiling), context);
    assert.equal(sent.length, 1, `${why}: a model whose output costs nothing is a known worst case, and goes`);
    sent[0].end({ total: 0 });
    await answer.result();
  }
});

test("another harness under a cap: a model whose output is priced and that has no output ceiling is refused; one whose output costs nothing passes; with no cap nothing is", async () => {
  for (const [why, ceiling] of NONE) {
    const guard = await capBefore(1_000, model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, ceiling));
    assert.match(guard.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 10 })?.refuse ?? "", NO_CEILING, why);
    const free = await capBefore(0.000001, model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ceiling));
    assert.equal(free.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 10 }), undefined, `${why}: output that costs nothing goes`);
    assert.equal(await capBefore(undefined, model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, ceiling)), undefined, `${why}: no cap, no refusal`);
  }
});

// A whole capped pi run on the faux model, priced on output only: each request's worst case is the faux model's 16,384
// max output tokens at $100 a million, about $1.64, well within a $10 cap.
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;

/** A run of a new agent `id` asked `content` under a cap of `cap`, once its first request is in flight. */
async function inFlight(api, id, content, cap = 10) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content }, max_cost_usd: cap })).body;
  for (let i = 0; ; i++) {
    const { status, state } = (await api("GET", `/runs/${run_id}`)).body;
    if (status === "working" && state === "working") return run_id;
    assert.ok(i < 200, "the run starts working");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a capped pi run steered mid-answer: the answer in flight finishes, never aborted, and the steered request is admitted", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const dir = mkdtempSync(join(tmpdir(), "cap-steer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const go = join(dir, "go");
  // The faux model answers once `go` exists, made only after the steer is accepted: the steer lands while that request
  // is in flight.
  const runId = await inFlight(api, "steered", `Answer once ${go} exists.`);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Also say hi." })).body.mode, "steer");
  writeFileSync(go, "");
  await follow(api, runId, ["completed", "failed", "cancelled"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.error?.code ?? null], ["completed", null], JSON.stringify(run.error));
  assert.equal(run.result.final_answer, "On Also say hi.: done.", "the steered request was sent and answered");
  assert.equal(typeof run.cost.usd, "number", "no answer was cut: the run's cost is known");
});

/** The run's store, read once its process has let it go. */
const storeFileOf = (data, runId) => join(data, "runs", runId, "store", "run.sqlite");
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const finished = async (api, runId) => (await follow(api, runId, ["completed", "failed", "cancelled"]), view(api, runId));
/** The same, or the run paused at its cap (input_required, pending budget). */
const pausedOrEnded = async (api, runId) => (await follow(api, runId, ["input_required", "completed", "failed", "cancelled"]), view(api, runId));
const PAUSED = ["input_required", "waiting", null, "budget"];
const pausedState = (run) => [run.status, run.state, run.error, run.pending?.kind];
/** A run under a cap of `cap` whose turn is stopped while its first request is in flight, once it reads stopped. */
async function stopped(api, id, cap) {
  const runId = await inFlight(api, id, "Take your time.", cap);
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  return runId;
}
/** One request's worst case on the faux model: 16,384 output tokens at $100 a million. */
const FAUX_WORST = 16_384 * 100 / 1e6;

test("a capped pi run stopped mid-answer goes on while its cap allows: in its process, and in the process a later message opens, the stopped request counts what it streamed and the 1,024-token allowance", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await stopped(api, "stopped");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  let run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code ?? null, run.result.final_answer], ["completed", null, "On go on: done."], "the same process admits the next request");
  assert.equal(run.cost.usd, null, "the stopped request's cost shows unknown, never $0");
  const stoppedUsage = (await api("GET", `/runs/${runId}/timeline`)).body.rows.findLast((r) => r.kind === "usage")?.usage;
  assert.deepEqual([stoppedUsage?.usd, stoppedUsage?.requests, stoppedUsage?.unpriced], [null, 2, 1], "the stopped request is booked: counted, at an unknown cost, the one charge with no price");
  assert.ok(stoppedUsage.so_far_usd > 0 && stoppedUsage.so_far_usd === run.cost.so_far_usd, `the follow-up's known cost so far, as the run says: ${JSON.stringify([stoppedUsage, run.cost])}`);
  const spent = spentIn(storeFileOf(data, runId));
  // Stopped before it streamed anything, on the faux model's free input: 1,024 tokens at $100 a million, and the answer since.
  assert.ok(Math.abs(spent - (1_024 * 100 / 1e6 + run.cost.so_far_usd)) < 1e-6, `the store says what the cap counts: the stop's $0.1024 and the answer since, $${spent}`);
  // Completed, the run's process is gone: the next message opens a new one, which reads its spend from the store.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again" })).body.mode, "follow_up");
  run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code ?? null, run.result.final_answer], ["completed", null, "On and again: done."], "a later process admits it too");
  assert.equal(run.cost.usd, null);
});

test("a capped pi run stopped mid-answer, when what the stopped request counts leaves no room for another request's least: the next request is refused with the cap's message, the run pauses at its cap, and its cost shows unknown, never $0", async (t) => {
  // $0.15: the request is clamped to what $0.15 buys; stopped before it streamed anything, it counts its 1,024-token
  // allowance, $0.1024, and leaves $0.0476: not another's least, 1,024 tokens at $0.0001.
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await stopped(api, "tight", 0.15);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  const run = await pausedOrEnded(api, runId);
  assert.deepEqual(pausedState(run), PAUSED, JSON.stringify(run));
  assert.match(run.pending.said, /^Not sent: the run has spent \$0\.1024 of its \$0\.15 cap, and its next \S+ request needs at least \$0\.11\. Raise the cap to at least \$0\.2\d to run it\.$/);
  assert.equal(run.cost.usd, null, "the refusal never balances the stopped request: unknown, not $0");
});

test("QA 7.4: a pi run under a $1 cap, stopped while its clamped request is out, goes on: the stop counts what it can have cost (nothing streamed and 1,024 tokens, $0.1024), never the rest of the cap, in its process and in its store", async (t) => {
  // The faux model's request asks 16,384 tokens at $100 a million, $1.64: under $1 it is clamped to what is left and held
  // at nearly all of it. Stopped before it streamed anything, it counts its free input and the 1,024-token allowance.
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await stopped(api, "qa-stop", 1);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  const run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code ?? null, run.result?.final_answer], ["completed", null, "On go on: done."], `the follow-up runs: ${JSON.stringify(run.error)}`);
  const db = new DatabaseSync(storeFileOf(data, runId), { readOnly: true });
  let marks;
  try {
    marks = db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(row.record)).filter((entry) => entry.kind === REQUEST_ENDED);
  } finally {
    db.close();
  }
  assert.equal(marks.length, 1, "one stopped request");
  assert.ok(Math.abs(marks[0].data[HELD_FIELD] - 1_024 * 100 / 1e6) < 1e-12, `the stopped request's end mark says what the cap counts it at: ${marks[0].data[HELD_FIELD]}`);
  const spent = spentIn(storeFileOf(data, runId));
  assert.ok(Math.abs(spent - (0.1024 + run.cost.so_far_usd)) < 1e-6, `the store says the stop's $0.1024 and the follow-up's cost: $${spent}, so far $${run.cost.so_far_usd}`);
});

test("a capped pi run refused for room with no stop pauses at its cap: its cost stays the known total it spent, and the refused request counts as no request", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  // A probe: one paid request (asking the person), to learn what one costs.
  assert.equal((await api("POST", "/agents", agent("probe", { tools: ["ask_person"] }))).status, 201);
  const probe = (await api("POST", "/agents/probe/runs", { input: { content: "Pick a region." } })).body.run_id;
  await follow(api, probe, ["input_required"]);
  const first = (await view(api, probe)).cost.usd;
  assert.ok(first > 0, "the ask was paid for");
  // One request's least (1,024 tokens at $0.0001) plus half the ask: the ask goes, limited to what the cap buys, and the
  // answer cannot buy its least after it.
  assert.equal((await api("POST", "/agents", agent("plain", { tools: ["ask_person"] }))).status, 201);
  const runId = (await api("POST", "/agents/plain/runs", { input: { content: "Pick a region." }, max_cost_usd: (1_024 * 100) / 1e6 + first / 2 })).body.run_id;
  await follow(api, runId, ["input_required"]);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "eu" })).body.mode, "answer");
  const run = await pausedOrEnded(api, runId);
  assert.deepEqual(pausedState(run), PAUSED, JSON.stringify(run));
  assert.equal(run.cost.usd, first, "the known total, never null");
  // Paused, its process is let go: its store is read once that process has exited (it marks itself released before
  // it closes the store).
  await letGo(data, runId);
  const db = new DatabaseSync(storeFileOf(data, runId), { readOnly: true });
  const entries = db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
  db.close();
  const isRefusalMark = (entry) => entry.kind === REQUEST_STARTED && entry.data?.capRefused === true;
  assert.equal(entries.filter(isRefusalMark).length, 1, "the refusal has its own start mark");
  const asWritten = meterOf(entries);
  assert.deepEqual([asWritten.usage.usd, asWritten.usage.requests, asWritten.requests], [first, 1, 1], "the ask alone: the refused request was never sent");
});

const SIGNAL = new URL("./fixtures/faux-signal.mjs", import.meta.url).pathname;

/** Waits for `check`, up to `ms`. */
async function until(what, check, ms = 30_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, what);
}

/** The pid `file` holds once it holds a whole one, else null: a file read while it is being written can be empty. */
function pidIn(file) {
  try {
    const text = readFileSync(file, "utf8");
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** `pid`, once it is sure to name one other process: 0 or a negative pid signals a whole process group (this test
 *  runner's among them), 1 is init. Anything else fails the test and is never signalled. */
function killable(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid, `refusing to signal pid ${pid}: it does not name one other process`);
  return pid;
}

/** A run under `cap` killed (SIGKILL, its own pid) while its first request is in flight; serve opens it again. */
async function killedMidRequest(t, cap) {
  const dir = mkdtempSync(join(tmpdir(), "cap-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [signal, go] = [join(dir, "signal"), join(dir, "go")];
  const server = await serve(t, { faux: SIGNAL });
  assert.equal((await server.api("POST", "/agents", agent("crashed"))).status, 201);
  const runId = (await server.api("POST", "/agents/crashed/runs", { input: { content: `Signal ${signal}, then answer once ${go} exists.` }, max_cost_usd: cap })).body.run_id;
  let pid = null;
  await until("the first request is in flight", () => (pid = pidIn(signal)) !== null);
  rmSync(signal);
  process.kill(killable(pid), "SIGKILL");
  return { ...server, runId, signal, go, pid };
}

test("a capped pi run whose process is killed mid-request is opened again and goes on: the cut request counts at the worst case held for it", { timeout: 120_000 }, async (t) => {
  const { api, data, runId, signal, go, pid } = await killedMidRequest(t, 10);
  // The next process reads the cut request from the store, at $1.64 held, and sends the turn's request again.
  await until("the request is sent again, or the run ends", async () => pidIn(signal) !== null || ["failed", "cancelled"].includes((await view(api, runId)).status));
  assert.ok(pidIn(signal) !== null, JSON.stringify((await view(api, runId)).error));
  assert.notEqual(pidIn(signal), pid, "by a new process");
  writeFileSync(go, "");
  const run = await finished(api, runId);
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Answered after the crash."], JSON.stringify(run.error));
  assert.equal(run.cost.usd, null, "the cut request's cost shows unknown");
  const spent = spentIn(storeFileOf(data, runId));
  assert.ok(spent >= FAUX_WORST && spent < FAUX_WORST * 1.5, `the cap counts the cut request at its held worst case: $${spent}`);
});

test("a capped pi run whose process is killed mid-request, when the held worst case leaves no room for another request's least: the next process refuses the request with the cap's message, and the run pauses at its cap", { timeout: 120_000 }, async (t) => {
  // $1.70 holds one request's $1.64, and leaves $0.06: not another's least.
  const { api, runId, signal } = await killedMidRequest(t, 1.7);
  const run = await pausedOrEnded(api, runId);
  assert.deepEqual(pausedState(run), PAUSED, JSON.stringify(run));
  assert.match(run.pending.said, /^Not sent: the run has spent \$1\.6\d* of its \$1\.70 cap, and its next \S+ request needs at least \$0\.11\. Raise the cap to at least \$1\.7\d to run it\.$/);
  assert.equal(existsSync(signal), false, "the request is not sent again");
});
