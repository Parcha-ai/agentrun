// The wrap-up end to end. pi: near its cap the run's model is told once, inside the request it is about to send ("About
// $X left of this run's budget: finish now with your answer.", or before any request is priced "This run's budget is about
// $X, enough for little work: answer as soon as you can."), and one row of the server's says so; pi's transcript never
// holds it and no input is queued, so the model's answer ends the turn. A next turn under the same cap is told nothing
// again. Another harness (the faux harness standing in for claude-agent): the same words go in a main-model request (the
// model proxy adds them to its body), once, worked out with what is left as the request takes them, and the row is
// written only once a request carrying them is admitted: never for a note no request carried, across a crash or a
// turn's end.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const WRAPUP = new URL("./fixtures/faux-wrapup.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
/** The tests' faux model priced on output only, $100 a million: what the faux harness's requests are held at. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
/** The wrap-up's words with `left` of the cap (cap.ts wrapUpWords). */
const WRAP_UP = (left) => `About ${left} left of this run's budget: finish now with your answer.`;
/** The same with no priced request yet: its typical cost the next request's expected cost (step 0). */
const WRAP_UP_FIRST = (left) => `This run's budget is about ${left}, enough for little work: answer as soon as you can.`;
/** Each note the faux harness took, with the index of the request that carried it (its first request is 0), from the run's
 *  journal in the store: the note is filed as it is admitted, before that request's own record. */
const noteRequests = async (store, runId) => {
  let requests = 0;
  const out = [];
  for (const entry of await journalOf(store, runId)) {
    if (entry.kind === "faux.request") requests += 1;
    else if (entry.kind === "faux.note") out.push([requests, entry.data.text]);
  }
  return out;
};
/** The run's messages in order: the person's and the server's own rows. */
const said = (rows) => rows.filter((row) => row.kind === "user_message" || (row.kind === "phase" && row.summary?.startsWith("AgentRun:"))).map((row) => row.text);
const WORDS = /^AgentRun: (?:About \$\d+(?:\.\d\d)? left of this run's budget: finish now with your answer|This run's budget is about \$\d+(?:\.\d\d)?, enough for little work: answer as soon as you can)\.$/;
const rowsOf = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows.filter((row) => row.kind === "phase" && WORDS.test(row.summary ?? ""));
/** The run's journal entries, from the one store (a runner writes them as it goes: nothing to let go first). */
const journalOf = async (store, runId) => (await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT)).entries;
/** The faux harness's notes taken into its requests (FAUX_RECORDS.note), from the run's journal in the store. */
const notesOf = async (store, runId) => (await journalOf(store, runId)).filter((entry) => entry.kind === "faux.note").map((entry) => entry.data.text);
/** The words inside a request's reminder (the proxy places the note in the last user text, in a <system-reminder>). */
const reminderIn = (text) => /<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/.exec(text)?.[1] ?? text;
/** Until the run's runner has let it go (its claim released). */
const released = async (store, runId) => {
  for (let i = 0; (await store.runs.get(runId))?.runner; i++) {
    assert.ok(i < 300, "the runner lets the run go");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("pi: near its cap the model is told once, in the request it is sent, to finish; it answers, the turn ends under the cap, one row says so, and the transcript never holds the note", { timeout: 180_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls });
  const { api, store } = await serve(t, { faux: WRAPUP });
  assert.equal((await api("POST", "/agents", agent("wrap", { instructions: "Write the pages.", tools: ["write"] }))).status, 201);
  const started = await api("POST", "/agents/wrap/runs", { input: { content: "go" }, max_cost_usd: 0.5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Wrapping up: the pages so far are the answer."], JSON.stringify(run.pending ?? run.error));
  assert.ok(run.cost.usd <= 0.5, `under its cap: $${run.cost.usd}`);
  const rows = await rowsOf(api, runId);
  assert.equal(rows.length, 1, `one row: ${JSON.stringify(rows.map((r) => r.summary))}`);
  // Its first request is held at nearly the whole $0.50 (16,384 tokens at $100 a million, clamped to the cap): due before
  // anything is priced, so the words say the budget, not a finish.
  assert.equal(rows[0].text, WRAP_UP_FIRST("$0.50"), "told at step 0, in its words");
  const seen = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.note);
  assert.equal(seen.length, 1, "the model saw the note in one request");
  // The proxy places the note in the request's last user text, inside its reminder: the words between the tags are the row's.
  assert.equal(`AgentRun: ${reminderIn(seen[0].note)}`, rows[0].summary, "the words it saw are the row's");
  assert.ok(!(await journalOf(store, runId)).some((entry) => JSON.stringify(entry.model ?? []).includes("run's budget")), "no entry of pi's transcript holds it");
});

test("pi on a large cap: the note tells the model what is left no later than its tools stop, with the first refused call, once, and it answers there", { timeout: 240_000 }, async (t) => {
  // $2: each page is about $0.10, and the run keeps back a typical page and a least answer ($0.10 + $0.1024). Its tools
  // stop once that no longer fits: the write after about $1.80 spent is refused, and the request that carries that
  // refusal carries the note too, saying what is left (about $0.20). The model answers there.
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls });
  const { api } = await serve(t, { faux: WRAPUP });
  assert.equal((await api("POST", "/agents", agent("wrap-line", { instructions: "Write the pages.", tools: ["write"] }))).status, 201);
  const runId = (await api("POST", "/agents/wrap-line/runs", { input: { content: "go" }, max_cost_usd: 2 })).body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 200_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Wrapping up: the pages so far are the answer."], JSON.stringify(run.pending ?? run.error));
  const rows = await rowsOf(api, runId);
  assert.equal(rows.length, 1, `one row: ${JSON.stringify(rows.map((r) => r.summary))}`);
  const left = Number(/^About \$(\d+\.\d\d) left of this run's budget: finish now with your answer\.$/.exec(rows[0].text)?.[1]);
  assert.ok(left > 0.1 && left < 0.3, `told with about what it keeps back left ($0.20), well past 75% of $2: ${rows[0].text}`);
  // Told no later than its tools stopped: the model answered on the note, so at most the one write before it was refused.
  const timeline = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
  const refused = timeline.filter((row) => row.kind === "tool_result" && `${row.text ?? ""} ${row.summary ?? ""}`.includes("Budget nearly spent"));
  assert.ok(refused.length <= 1, `no write refused after the note: ${JSON.stringify(refused.map((row) => row.summary))}`);
  const seen = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.note);
  assert.equal(seen.length, 1, "the model saw the note in one request");
});

test("pi: the final-answer request that carries the note is the run's last: no further request is sent, live or after a restart that comes after the answer", { timeout: 240_000 }, async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls });
  const first = await serve(t, { faux: WRAPUP });
  const { api, store } = first;
  assert.equal((await api("POST", "/agents", agent("wrap-last", { instructions: "Write the pages.", tools: ["write"] }))).status, 201);
  const runId = (await api("POST", "/agents/wrap-last/runs", { input: { content: "go" }, max_cost_usd: 0.5 })).body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  const requests = () => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const answered = requests();
  assert.ok(answered.at(-1).note, "the run's last request carried the note: its answer ended the turn");
  // Live: whatever would follow the answer (a queued steer runs one more request after a request with no tool call,
  // pi-agent-core's loop) has had its chance, its runner having let the run go.
  await released(store, runId);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal(requests().length, answered.length, "no request after the answer");
  // After a restart: a server started again on the same data reads the run whole, and sends nothing for it.
  await first.close();
  const again = await serve(t, { faux: WRAPUP, data: first.data });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal((await again.api("GET", `/runs/${runId}`)).body.status, "completed");
  assert.equal(requests().length, answered.length, "none after the restart either");
});

test("claude-agent on the faux harness: near its cap a main-model request carries the words, once, and one row says so", { timeout: 180_000 }, async (t) => {
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: WRAPUP });
  assert.equal((await api("POST", "/agents", agent("wrap-h", { harness: "claude-agent", instructions: "Grow a cached context." }))).status, 201);
  const started = await api("POST", "/agents/wrap-h/runs", { input: { content: "go" }, max_cost_usd: 0.5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
  const rows = await rowsOf(api, runId);
  assert.equal(rows.length, 1, `one row: ${JSON.stringify(rows.map((r) => r.summary))}`);
  await released(store, runId);
  assert.deepEqual((await notesOf(store, runId)).map((text) => `AgentRun: ${text}`), [rows[0].summary], "the session's next main-model request took the words, once");
});

test("claude-agent on the faux harness: a turn that ends on the request after which the wrap-up comes due: the next turn's first request carries the note, with what is left then, and its row follows that turn's message", { timeout: 180_000 }, async (t) => {
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("next-h", { harness: "claude-agent", instructions: "Wrap up in the next turn." }))).status, 201);
  const started = await api("POST", "/agents/next-h/runs", { input: { content: "go" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  assert.deepEqual(await rowsOf(api, runId), [], "no row while no request has carried the note");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).status, 202);
  const { rows } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Second."], JSON.stringify(run.pending ?? run.error));
  // $0.40 spent: $0.60 left, under 3 x $0.40, read as the follow-up's first request takes the note.
  assert.deepEqual(said(rows), ["go", "go on", WRAP_UP("$0.60")], "the row after the turn's message, in the words it carried");
  await released(store, runId);
  assert.deepEqual(await notesOf(store, runId), [WRAP_UP("$0.60")], "the follow-up's first request carried the note, once");
});

test("claude-agent on the faux harness: a note taken after the first request was priced ($0.40, due by the measured typical) is worded as the run's spend says, \"finish now\", and a side call admitted between its take and the admission of the request carrying it leaves it told once, with one row", { timeout: 180_000 }, async (t) => {
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("side-h", { harness: "claude-agent", instructions: "Wrap up with a side call in between." }))).status, 201);
  const started = await api("POST", "/agents/side-h/runs", { input: { content: "go" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Done."], JSON.stringify(run.pending ?? run.error));
  // $0.40 spent and priced when request 2 takes the note: $0.60 left, under 3 x $0.40. The side call's admission comes
  // before request 2's own.
  assert.deepEqual((await rowsOf(api, runId)).map((row) => row.text), [WRAP_UP("$0.60")], "one row");
  await released(store, runId);
  assert.deepEqual(await notesOf(store, runId), [WRAP_UP("$0.60")], "the note went once: request 2 did not take it again");
});

/** A run of `agentId` on Sonnet 5.5 pricing (faux-sonnet55.mjs) under `cap`, its harness `harness` ("pi" or a faux CLI),
 *  ended; with the rows the wrap-up wrote, and the store its journal (the notes the faux harness took) is read from. */
async function sonnetRun(t, { harness, instructions, cap, id }) {
  const sonnet = new URL("./fixtures/faux-sonnet55.mjs", import.meta.url).pathname;
  const { api, store } = await serve(t, { faux: sonnet, ...(harness === "pi" ? {} : { harnessTable: fauxTable(FAUX_HARNESS) }) });
  assert.equal((await api("POST", "/agents", agent(id, { ...(harness === "pi" ? {} : { harness }), instructions }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Say hi." }, max_cost_usd: cap });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  return { api, store, runId, run, rows: await rowsOf(api, runId) };
}

test("pi on Sonnet 5.5 under $1: no wrap-up at step 0. Nothing priced yet, the typical request is its input and a 4,096-token answer ($0.04), never its whole 128,000-token allowance ($1.28)", { timeout: 120_000 }, async (t) => {
  const { run, rows } = await sonnetRun(t, { harness: "pi", instructions: "Answer.", cap: 1, id: "s55-pi" });
  assert.equal(run.status, "completed", JSON.stringify(run.pending ?? run.error));
  assert.deepEqual(rows.map((row) => row.text), [], "no note: $1 is over 3 times the step-0 typical request");
});

test("pi on Sonnet 5.5 under $0.10: due at step 0, told in the budget's words, never \"finish now\"", { timeout: 120_000 }, async (t) => {
  const { rows } = await sonnetRun(t, { harness: "pi", instructions: "Answer.", cap: 0.1, id: "s55-pi-small" });
  assert.deepEqual(rows.map((row) => row.text), [WRAP_UP_FIRST("$0.10")]);
});

test("claude-agent on Sonnet 5.5 under $0.10: due at step 0, judged on its first request itself as pi judges it, and told in that request in the budget's words; then nothing more", { timeout: 120_000 }, async (t) => {
  const { store, runId, run, rows } = await sonnetRun(t, { harness: "claude-agent", instructions: "Claude Code makes five cent calls.", cap: 0.1, id: "s55-cc-small" });
  assert.equal(run.status, "completed", JSON.stringify(run.pending ?? run.error));
  // Its first request's step-0 figure, its input and a 4,096-token answer ($0.054: 5,000 x $2.50 + 4,096 x $10 a million), is over a third of $0.10.
  assert.deepEqual(rows.map((row) => row.text), [WRAP_UP_FIRST("$0.10")], "told once, in step 0's words");
  await released(store, runId);
  assert.deepEqual(await noteRequests(store, runId), [[0, WRAP_UP_FIRST("$0.10")]], "in request 1, the request it was judged on");
});

test("pi and claude-agent on the same model under the same $0.10, the first request due at step 0: the same note, in the same words, in request 1 (parity)", { timeout: 120_000 }, async (t) => {
  const pi = await sonnetRun(t, { harness: "pi", instructions: "Answer.", cap: 0.1, id: "s55-parity-pi" });
  const cli = await sonnetRun(t, { harness: "claude-agent", instructions: "Claude Code makes five cent calls.", cap: 0.1, id: "s55-parity-cc" });
  assert.deepEqual([pi.rows.map((row) => row.text), cli.rows.map((row) => row.text)], [[WRAP_UP_FIRST("$0.10")], [WRAP_UP_FIRST("$0.10")]], "the same words on both");
  await released(cli.store, cli.runId);
  assert.deepEqual((await noteRequests(cli.store, cli.runId)).map(([request]) => request), [0], "the CLI's in its first request, as pi's is");
});

test("claude-agent on Sonnet 5.5 under $0.11, the next request taking its note before the first request's cost came in: judged at step 0 on itself, and told in the budget's words", { timeout: 120_000 }, async (t) => {
  const booked = join(await scratch(t), "booked");
  const sonnet = new URL("./fixtures/faux-sonnet55.mjs", import.meta.url).pathname;
  const { api, store } = await serve(t, { faux: sonnet, harnessTable: fauxTable(FAUX_HARNESS) });
  assert.equal((await api("POST", "/agents", agent("s55-late", { harness: "claude-agent", instructions: `Claude Code on a small cap, its first cost booked when ${booked} exists.` }))).status, 201);
  const runId = (await api("POST", "/agents/s55-late/runs", { input: { content: "Say hi." }, max_cost_usd: 0.11 })).body.run_id;
  // Request 1 asks 1,024 tokens: its step-0 figure, $0.023 (5,000 x $2.50 + 1,024 x $10 a million), is under a third of
  // $0.11, so it takes no note. It is answered, and held at $0.023 until its cost comes in, which is not yet when request 2
  // takes the note: nothing priced, $0.09 left, under 3 x request 2's own step-0 figure ($0.054). Then request 1's cost
  // comes in.
  for (const end = Date.now() + 60_000; (await rowsOf(api, runId)).length === 0; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (Date.now() > end) assert.fail(`the note was told within 60 s: ${JSON.stringify((await api("GET", `/runs/${runId}`)).body).slice(0, 1500)}`);
  }
  await writeFile(booked, "");
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  assert.deepEqual((await rowsOf(api, runId)).map((row) => row.text), [WRAP_UP_FIRST("$0.09")]);
  await released(store, runId);
  assert.deepEqual(await notesOf(store, runId), [WRAP_UP_FIRST("$0.09")]);
});

test("claude-agent on Sonnet 5.5 under $0.10, a $0.04 first request: the measured typical makes it due, and request 2 is told to finish (a guard)", { timeout: 120_000 }, async (t) => {
  const { store, runId, rows } = await sonnetRun(t, { harness: "claude-agent", instructions: "Claude Code spends four cents first.", cap: 0.1, id: "s55-cc-four" });
  assert.deepEqual(rows.map((row) => row.text), [WRAP_UP("$0.06")]);
  await released(store, runId);
  assert.deepEqual(await notesOf(store, runId), [WRAP_UP("$0.06")]);
});

test("claude-agent on Sonnet 5.5 under $0.30, Codex-shaped requests that each need 10,240 output tokens and cost half a cent: the wrap-up comes before the cap refuses the next request, while what is left still buys about two of them", { timeout: 180_000 }, async (t) => {
  const { store, runId, run, rows } = await sonnetRun(t, { harness: "claude-agent", instructions: "Make sixty half-cent calls that each need 10,240 output tokens at least.", cap: 0.3, id: "s55-least" });
  // Its measured typical ($0.005) never makes it due: 3 x $0.005 is under what the next request needs at least (about
  // $0.11: 10,240 x $10 a million, and its input), so without the least the cap refuses it untold. The cap is $0.30 so
  // that the refusal comes inside the sixty calls ($0.005 each).
  assert.equal(rows.length, 1, `one row before the refusal: ${JSON.stringify(rows.map((row) => row.text))}; the run: ${JSON.stringify(run.pending ?? run.error ?? run.status)}`);
  assert.match(rows[0].text, /^About \$0\.\d\d left of this run's budget: finish now with your answer\.$/);
  await released(store, runId);
  assert.deepEqual(await notesOf(store, runId), [rows[0].text]);
});

test("claude-agent on the faux harness: at step 0, with no previous request in hand, the next request's least is priced uncached, and it alone makes the wrap-up due, in the budget's words (a pin)", { timeout: 180_000 }, async (t) => {
  const booked = join(await scratch(t), "booked");
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("step0-least", { harness: "claude-agent", instructions: `Two requests needing 10,240 output tokens, the first booked when ${booked} exists.` }))).status, 201);
  // Output at $100 a million, input free: each request's least is $1.024, its step-0 typical (4,096 tokens) $0.41. Under
  // $2.50 the step-0 latch is not due (over 3 x $0.41); request 1, admitted with request 0 still in flight at $1.024 and
  // nothing priced, finds $1.48 left, under 2 x its least: due by the least alone.
  const runId = (await api("POST", "/agents/step0-least/runs", { input: { content: "go" }, max_cost_usd: 2.5 })).body.run_id;
  for (const end = Date.now() + 60_000; (await rowsOf(api, runId)).length === 0; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (Date.now() > end) assert.fail(`the note was told within 60 s: ${JSON.stringify((await api("GET", `/runs/${runId}`)).body).slice(0, 1500)}`);
  }
  await writeFile(booked, "");
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const rows = (await rowsOf(api, runId)).map((row) => row.text);
  assert.deepEqual(rows, [WRAP_UP_FIRST("$1.48")], "step 0's words: nothing priced at the take");
  await released(store, runId);
  assert.deepEqual(await notesOf(store, runId), rows);
});

test("claude-agent on the faux harness: paused at its cap, let go and raised, the first request after the raise, in the process the raise opens, is told when it alone is due by its least: the least of the request being taken, never of one admitted in an earlier process", { timeout: 180_000 }, async (t) => {
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("raised-least", { harness: "claude-agent", instructions: "Make two requests needing 10,240 output tokens." }))).status, 201);
  // $0.50: under the first request's least ($1.024 at $100 a million output), so the run pauses at it, nothing spent.
  const runId = (await api("POST", "/agents/raised-least/runs", { input: { content: "go" }, max_cost_usd: 0.5 })).body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.pending?.kind, "budget", "paused at its cap");
  // Raised to $1.50: the first request after it is admitted ($1.50 left, over its least), and $1.50 is under 2 x $1.024,
  // so it is due by its least alone (its step-0 typical, 4,096 tokens or $0.41, is not: 3 x $0.41 is under $1.50).
  const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: 1.5 });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.deepEqual((await rowsOf(api, runId)).map((row) => row.text), [WRAP_UP_FIRST("$1.50")], "the first request after the raise is told, in the budget's words: nothing priced, $1.50 left, under 2 x its own least ($1.024)");
  // The faux harness's own record of the note it took into a request, in the run's journal: once, those words.
  assert.deepEqual(await notesOf(store, runId), [WRAP_UP_FIRST("$1.50")]);
});

test("claude-agent on the faux harness: a side call that comes first (the harness's own title request) neither takes the note nor is judged as the request taking it: the session's first request carries it, judged at step 0 on its own bound (a pin)", { timeout: 180_000 }, async (t) => {
  const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: new URL("./fixtures/faux-input-priced.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("side-first-h", { harness: "claude-agent", instructions: "Wrap up after a side call comes first." }))).status, 201);
  // Input at $100 a million, output free. Request 0's step-0 figure, its own 1,000-token input, is $0.10, over a third of
  // $0.29; the side call's 100 tokens ($0.01) are not, so a take judged on the side call would tell nothing. Request 1
  // takes no note: $0.2795 is left, over 3 x the typical $0.01 (request 0's alone: a side call's cost is not counted) and
  // over 2 x its least, priced after request 0 on its own model, never after the side call on another.
  const runId = (await api("POST", "/agents/side-first-h/runs", { input: { content: "go" }, max_cost_usd: 0.29 })).body.run_id;
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run.pending ?? run.error));
  assert.deepEqual((await rowsOf(api, runId)).map((row) => row.text), [WRAP_UP_FIRST("$0.29")], "one row, in step 0's words");
  await released(store, runId);
  assert.deepEqual(await noteRequests(store, runId), [[0, WRAP_UP_FIRST("$0.29")]], "in the session's first request, once");
});

