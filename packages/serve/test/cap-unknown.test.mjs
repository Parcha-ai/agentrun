// What a run's spend, read back from its store, cannot say is unknown (null), never $0: a request a crash cut, a stopped answer,
// a cost that is not a number. A request stopped before its end is priced at the figure its end mark holds, a request a crash
// cut at the figure its start mark holds, so a stopped run goes on while its cap allows. The meters and a refused run's pause
// are read over the same marks. (The admission side of these figures is the kernel cap's: run-adapters kernel-cap-*.test.mjs.)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REQUEST_COST, REQUEST_ENDED, REQUEST_STARTED, runMetricsOf, timelineOf, TOOL_COST } from "../dist/timeline/index.js";
import { CAP_REFUSED_FIELD, HELD_FIELD, meterFiguresFrom, spentFrom } from "../dist/cap.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { runEntries } from "../dist/store-reads/journal.js";
import { agent, follow, journalOf, runDir, serve } from "./support.mjs";


/** `entries`, in order, as the one store's journal hands them to the cap's reading (store-reads/cap.ts spentOverStore runs
 *  cap.ts spentFrom over a run's records): each a stored record, with its conversation. */
const rowsOf = (entries) => entries.map((entry) => JSON.parse(JSON.stringify({ conversationId: 1, ...entry })));
/** /usage's meters for a run whose journal holds `entries` (store-reads/cap.ts metersOverStore runs cap.ts meterFiguresFrom
 *  over a run's records), without the known-dollars figures beside them. */
const metersOf = (entries) => {
  const { known: _, ...meters } = meterFiguresFrom(rowsOf(entries).map((entry) => ({ conversation: 1, entry })));
  return meters;
};

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
  const rows = rowsOf([started, answer({ total: 0.001 }), started, answer({ total: 0.002 }), compactionStarted, { kind: REQUEST_COST, data: { request: "compaction", usd: 0.004 } }]);
  assert.equal(Math.round(spentFrom(rows) * 1e6) / 1e6, 0.007);
  assert.equal(spentFrom(rowsOf([started, answer({ total: 0.001 }), refused])), 0.001, "a request the cap refused never left: it costs nothing");
  // A run with no journal yet (nothing spent) is store-reads-cap.test.mjs's "a run with no journal spends 0".
  assert.equal(spentFrom(rowsOf([])), 0, "an empty journal: nothing spent");
  const charged = (usd) => ({ kind: TOOL_COST, data: { tool: "monid.run", charged_by: "monid", usd } });
  assert.equal(Math.round(spentFrom(rowsOf([started, answer({ total: 0.001 }), charged(0.003)])) * 1e6) / 1e6, 0.004, "a paid tool's charge is spent too");
  assert.equal(spentFrom(rowsOf([started, answer({ total: 0.001 }), charged(null)])), null, "an unknown charge leaves the spend unknown");
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
  for (const [why, entries] of Object.entries(cases)) assert.equal(spentFrom(rowsOf(entries)), null, why);
});

test("a request a crash cut (marked as sent, no answer, no end) counts at the figure its start mark holds, whatever of it pi wrote, a summary's too", (t) => {
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  const answered = [startedHeld(0.001), answer({ total: 0.001 })];
  assert.equal(round(spentFrom(rowsOf([...answered, startedHeld(0.4)]))), 0.401, "cut before any content");
  assert.equal(round(spentFrom(rowsOf([...answered, startedHeld(0.4), answer({ total: 0 }, "aborted")]))), 0.401, "what had streamed of it, written aborted by the next process");
  assert.equal(round(spentFrom(rowsOf([...answered, startedHeld(0.4), startedHeld(0.002), answer({ total: 0.002 })]))), 0.403, "and then the next process's request, answered");
  assert.equal(round(spentFrom(rowsOf([...answered, startedHeld(0.2, { request: "compaction" })]))), 0.201, "a summary a crash cut");
  // Requests that overlap leave which one was cut unsaid: each open one counts at one of the largest figures, never less.
  assert.equal(round(spentFrom(rowsOf([startedHeld(0.5), startedHeld(0.4), answer({ total: 0.001 })]))), 0.501);
});

test("the cap's refusal in its own words (its code with a note) is left out as any refusal: it closes no request a crash cut", (t) => {
  // pi's answer to a request the cap limited and then refused: "spend_cap_reached (out of budget): Not sent: ...".
  const refusedNow = { kind: "pi.assistant", model: [{ role: "assistant", content: [], usage: { cost: { total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached (out of budget): Not sent: this run has spent $0.401 of its $0.5 cap, and the next step needs at least $0.11. Raise the cap to at least $0.52 to continue.", timestamp: 0 }] };
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  assert.equal(round(spentFrom(rowsOf([startedHeld(0.001), answer({ total: 0.001 }), startedHeld(0.4), refusedStart, refusedNow]))), 0.401, "the cut request still counts at its figure");
});

test("a cut request is unknown when its start mark holds no figure (an older store), and one request is counted once whatever marks and entry it has", (t) => {
  assert.equal(spentFrom(rowsOf([startedHeld(0.001), answer({ total: 0.001 }), started])), null, "a start with no figure, cut");
  // Read in order, the answer closed the start before it, which holds no figure: the cut one is certain, at its own.
  assert.equal(Math.round(spentFrom(rowsOf([started, answer({ total: 0.001 }), startedHeld(0.4)])) * 1e6) / 1e6, 0.401, "an older start, answered before the cut one started");
  assert.equal(spentFrom(rowsOf([started, startedHeld(0.4), answer({ total: 0.001 })])), null, "a start with no figure that may still be the open one: which was cut is not certain");
  assert.equal(spentFrom(rowsOf([startedHeld(0.2), started])), null, "a start with no figure still open at the crash, beside one with a figure: unknown, never the figure alone");
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  for (const [why, entries] of Object.entries({
    "start, aborted entry, end": [startedHeld(0.4), answer({ total: 0 }, "aborted"), ended(0.4)],
    "start, end, aborted entry": [startedHeld(0.4), ended(0.4), answer({ total: 0 }, "aborted")],
    "start, end": [startedHeld(0.4), ended(0.4)],
  })) assert.equal(round(spentFrom(rowsOf(entries))), 0.4, why);
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
  for (const [why, entries] of Object.entries(cases)) assert.equal(round(spentFrom(rowsOf(entries))), 0.501, why);
  assert.equal(round(spentFrom(rowsOf([started, answer({ total: 0.001 }), compactionStarted, ended(0.2, { request: "compaction" })]))), 0.201, "a summary stopped before its end, at its figure");
  assert.equal(round(spentFrom(rowsOf([started, ended(0.5), started, answer({ total: 0.002 }), refusedStart, refused]))), 0.502, "the cap's refusal, marked, answers its own mark");
});

test("after a crash, each request still open counts at its own start's figure: a start an answer or an end mark closed is never counted again", (t) => {
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  assert.equal(round(spentFrom(rowsOf([startedHeld(0.3), answer({ total: 0.2 }), startedHeld(0.1)]))), 0.3, "answered at 0.20 before the cut one (held 0.10) started: 0.20 + 0.10, never the answered start's 0.30 again");
  assert.equal(round(spentFrom(rowsOf([startedHeld(0.1), startedHeld(0.3), ended(0.3)]))), 0.4, "one stopped at 0.30 (its end mark) and one a crash cut, held 0.10: 0.30 + 0.10");
  assert.equal(round(spentFrom(rowsOf([startedHeld(0.3), ended(0.3), startedHeld(0.1)]))), 0.4, "the same, the stop before the cut one started");
  // Requests that overlap: the marks do not say which one an answer closed, so it closes the smallest figure still open.
  // Its cost is not read as a clue: a held figure is the cap's worst case, and a reading that trusted it never to be
  // passed would count less than was spent if it ever were.
  assert.equal(round(spentFrom(rowsOf([startedHeld(0.1), startedHeld(0.3), answer({ total: 0.2 })]))), 0.5, "either can have been cut: at the larger, 0.30");
  assert.equal(round(spentFrom(rowsOf([startedHeld(0.5), startedHeld(0.2), answer({ total: 0.1 }), startedHeld(0.3)]))), 0.9, "an overlap, then a request after it: 0.10 + 0.50 + 0.30");
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
    const got = spentFrom(rowsOf(entries));
    assert.ok(got >= mostOf(events) - 1e-9, `never less than the marks allow: ${got} for ${JSON.stringify(events)}`);
    assert.ok(got >= actual - 1e-9, `never less than what the run can have spent: ${got} < ${actual}`);
  }
  // The walk covers what it checks: answers, end marks, and closes while requests overlap, each well past a handful.
  t.diagnostic(`overlapping runs: ${seen.answers} answers, ${seen.ends} end marks, ${seen.overlapping} closes while requests overlap`);
  for (const [what, count] of Object.entries(seen)) assert.ok(count >= 50, `the generator made only ${count} ${what}`);
  for (let i = 0; i < 300; i++) {
    const { entries, events, most } = runOf(true);
    assert.ok(Math.abs(spentFrom(rowsOf(entries)) - most) < 1e-9, `exact with no overlap: ${JSON.stringify(events)}`);
  }
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
const refusalEntry = { kind: "pi.assistant", model: [{ role: "assistant", content: [], api: "faux", provider: "faux", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached (out of budget): Not sent: this run has spent $0.001 of its $1 cap, and the next step needs at least $1.01. Raise the cap to at least $1.02 to continue.", timestamp: 0 }] };
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
const storeFileOf = (data, runId) => join(runDir(data, runId), "store", "run.sqlite");
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const finished = async (api, runId) => (await follow(api, runId, ["completed", "failed", "cancelled"]), view(api, runId));
/** The same, or the run paused at its cap (input_required, pending budget). */
const pausedOrEnded = async (api, runId) => (await follow(api, runId, ["input_required", "completed", "failed", "cancelled"]), view(api, runId));
/** The run once it has paused or ended past a pause of kind `past` it was answered at: a run just answered still reads
 *  that pause until its runner takes the answer. */
async function pausedPast(api, runId, past) {
  for (const end = Date.now() + 60_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    const run = await view(api, runId);
    if (["input_required", "completed", "failed", "cancelled"].includes(run.status) && run.pending?.kind !== past) return run;
    assert.ok(Date.now() < end, `the run went on past its ${past}: ${JSON.stringify(run)}`);
  }
}
/** Once run `runId`'s claim is let go (its row names no runner), as a paused run's is at its park. */
async function releasedOf(store, runId) {
  for (let i = 0; (await store.runs.get(runId))?.runner !== null; i++) {
    assert.ok(i < 300, "the run's claim was let go");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const PAUSED = ["input_required", "waiting", null, "budget"];
const pausedState = (run) => [run.status, run.state, run.error, run.pending?.kind];
/** A run under a cap of `cap` whose turn is stopped while its first request is in flight, once it reads stopped. */
async function stopped(api, id, cap) {
  const runId = await inFlight(api, id, "Take your time.", cap);
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  return runId;
}

// SKIP (follow-up #2080): a capped pi run stopped mid-answer ends cancelled on the runner, never goes on while its cap allows.
test.skip("a capped pi run stopped mid-answer goes on while its cap allows: in its process, and in the process a later message opens, the stopped request counts what it streamed and the 1,024-token allowance", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await stopped(api, "stopped");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  let run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code ?? null, run.result.final_answer], ["completed", null, "On go on: done."], "the same process admits the next request");
  assert.equal(run.cost.usd, null, "the stopped request's cost shows unknown, never $0");
  const stoppedUsage = (await api("GET", `/runs/${runId}/timeline`)).body.rows.findLast((r) => r.kind === "usage")?.usage;
  assert.deepEqual([stoppedUsage?.usd, stoppedUsage?.requests, stoppedUsage?.unpriced], [null, 2, 1], "the stopped request is booked: counted, at an unknown cost, the one charge with no price");
  assert.ok(stoppedUsage.so_far_usd > 0 && stoppedUsage.so_far_usd === run.cost.so_far_usd, `the follow-up's known cost so far, as the run says: ${JSON.stringify([stoppedUsage, run.cost])}`);
  const spent = spentFrom(journalOf(data, runId));
  // Stopped before it streamed anything, on the faux model's free input: 1,024 tokens at $100 a million, and the answer since.
  assert.ok(Math.abs(spent - (1_024 * 100 / 1e6 + run.cost.so_far_usd)) < 1e-6, `the store says what the cap counts: the stop's $0.1024 and the answer since, $${spent}`);
  // Completed, the run's process is gone: the next message opens a new one, which reads its spend from the store.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again" })).body.mode, "follow_up");
  run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code ?? null, run.result.final_answer], ["completed", null, "On and again: done."], "a later process admits it too");
  assert.equal(run.cost.usd, null);
});

// SKIP (follow-up #2080): a capped pi run stopped mid-answer ends cancelled on the runner, never goes on to pause at its cap.
test.skip("a capped pi run stopped mid-answer, when what the stopped request counts leaves no room for another request's least: the next request is refused with the cap's message, the run pauses at its cap, and its cost shows unknown, never $0", async (t) => {
  // $0.15: the request is clamped to what $0.15 buys; stopped before it streamed anything, it counts its 1,024-token
  // allowance, $0.1024, and leaves $0.0476: not another's least, 1,024 tokens at $0.0001.
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await stopped(api, "tight", 0.15);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  const run = await pausedOrEnded(api, runId);
  assert.deepEqual(pausedState(run), PAUSED, JSON.stringify(run));
  assert.match(run.pending.said, /^Not sent: this run has spent \$0\.10 of its \$0\.15 cap, and the next step needs at least \$0\.11\. Raise the cap to at least \$0\.2\d to continue\.$/);
  assert.equal(run.cost.usd, null, "the refusal never balances the stopped request: unknown, not $0");
});

// SKIP (follow-up #2080): a capped pi run stopped mid-answer ends cancelled on the runner, never goes on to pause at its cap.
test.skip("QA 7.4: a pi run under a $1 cap, stopped while its clamped request is out, goes on: the stop counts what it can have cost (nothing streamed and 1,024 tokens, $0.1024), never the rest of the cap, in its process and in its store", async (t) => {
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
  const spent = spentFrom(journalOf(data, runId));
  assert.ok(Math.abs(spent - (0.1024 + run.cost.so_far_usd)) < 1e-6, `the store says the stop's $0.1024 and the follow-up's cost: $${spent}, so far $${run.cost.so_far_usd}`);
});

test("a capped pi run refused for room with no stop pauses at its cap: its cost stays the known total it spent, and the refused request counts as no request", async (t) => {
  const { api, store } = await serve(t, { faux: new URL("./fixtures/faux-input-priced.mjs", import.meta.url).pathname });
  // A probe: one paid request (asking the person), to learn what one costs.
  assert.equal((await api("POST", "/agents", agent("probe", { tools: ["ask_person"] }))).status, 201);
  const probe = (await api("POST", "/agents/probe/runs", { input: { content: "Pick a region." } })).body.run_id;
  await follow(api, probe, ["input_required"]);
  const first = (await view(api, probe)).cost.usd;
  assert.ok(first > 0, "the ask was paid for");
  // The cap sits above the wrap-up line at step 0 (a bit over three times a request's least, 1,024 tokens at $0.0001, with
  // the note's own bytes: under it the run is told to finish and never asks), so the ask goes. The answer is a long message, input priced: its input alone, about
  // 5,700 tokens ($0.57), is more than what the cap leaves after the ask, so it cannot be bought.
  assert.equal((await api("POST", "/agents", agent("plain", { tools: ["ask_person"] }))).status, 201);
  const runId = (await api("POST", "/agents/plain/runs", { input: { content: "Pick a region." }, max_cost_usd: 0.5 })).body.run_id;
  await follow(api, runId, ["input_required"]);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "eu ".repeat(6_666) })).body.mode, "answer");
  // Its next pause, past the question it answered: the answer is taken once the run reads as no longer asking.
  const run = await pausedPast(api, runId, "question");
  assert.deepEqual(pausedState(run), PAUSED, JSON.stringify(run));
  assert.equal(run.cost.usd, first, "the known total, never null");
  // Its journal, from the one store, once its claim is let go at the pause.
  await releasedOf(store, runId);
  const entries = await runEntries(store, runId, BACKGROUND_CONTEXT);
  // On the runner the model proxy refuses the request before it is sent, and the run's pause at its cap records it: one.
  assert.equal(entries.filter((entry) => entry.kind === "agentrun.budget").length, 1, "the refusal is the run's one pause at its cap");
  const asWritten = meterOf(entries);
  assert.deepEqual([asWritten.usage.usd, asWritten.usage.requests, asWritten.requests], [first, 1, 1], "the ask alone: the refused request was never sent");
});
