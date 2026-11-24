// A held value split across two strings of a JSON text, where each string alone holds half of it: a call's result of any
// tool (its rows and the text a grader reads of it), a call's arguments (tool_input, and the grader's prompt built from
// them), a web call's property name and value, a workflow's output in its graph and in the run's view, a run's input,
// a running tool's live args and a workflow run's title. Each withholds what holds it, never showing a half.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { servedGraphView } from "../dist/graph-served.js";
import { redacted, redactedCall, withheldWhole } from "../dist/key-refusal.js";
import { withLiveTicker } from "../dist/runner/live-ticker.js";
import { prepareLaunch } from "../dist/runs-over-store.js";
import { viewOverStore } from "../dist/store-view.js";
import { callsOf, graderInput } from "../dist/template-eval.js";
import { CALL_RESULT_CHARS, scrubUrls, timelineOf } from "../dist/timeline/index.js";
import { storeOn, T0 } from "./store-helpers.mjs";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

// A held value of 32 characters in no secret's shape, made at runtime, and its two halves.
const [HEAD, REST] = [["Zq8V", "bN3x", "LmT6", "pR2w"].join(""), ["Yk9H", "sD4f", "Gj7A", "c5Ue"].join("")];
const KEY = `${HEAD}${REST}`;
const SECRETS = [KEY];
const halves = [HEAD.slice(0, 8), REST.slice(0, 8)];

/** A run's rows with one call of `tool` with `args`, its output `text`, as a served calls read makes them. */
const rowsOf = (tool, args, text) =>
  timelineOf([user("Run it."), assistant([call("c1", tool, args)]), result("c1", tool, text)], {
    redact: (part) => redacted(part, SECRETS),
    holds: (whole) => withheldWhole(whole, SECRETS),
    calls: { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, SECRETS, CALL_RESULT_CHARS, scrubUrls) },
  });
const rowOf = (rows, kind) => rows.find((row) => row.kind === kind && row.tool_use_id === "c1");
const grader = { file: "rubric.md", type: "llm", rubric: "Pass if the run ran its command." };
const promptOf = (rows) => graderInput(grader, "task", { answer: "done", calls: callsOf(rows, "pi"), mcpCalls: [], files: [] });
const shows = (text) => halves.filter((half) => text.includes(half));

test("a held value split across two strings of a non-web tool's JSON result: no row shows a half, and the grader reads it withheld", () => {
  const text = JSON.stringify({ items: [{ title: `see ${HEAD}`, snippet: `${REST} more` }] });
  const rows = rowsOf("read", { path: "notes.json" }, text);
  assert.deepEqual(shows(JSON.stringify(rows)), []);
  assert.equal(rowOf(rows, "tool_result").tool_result_text, "[redacted]");
  assert.deepEqual(shows(promptOf(rows)), []);
});

test("web_fetch's refused answer (no text, so read as any tool's): a held value split across its url and its reason is withheld", () => {
  const text = JSON.stringify({ ok: false, url: `https://h.example/${HEAD}`, refused: `${REST} is not allowed` });
  const rows = rowsOf("web_fetch", { url: "https://h.example/" }, text);
  assert.deepEqual(shows(JSON.stringify(rows)), []);
  assert.equal(rowOf(rows, "tool_result").tool_result_text, "[redacted]");
});

test("a held value split across two arguments of a call: tool_input is withheld, its preview is \"[redacted]\", and the grader's prompt shows no half", () => {
  const rows = rowsOf("bash", { command: `echo ${HEAD}`, note: REST }, "ok");
  const use = rowOf(rows, "tool_use");
  assert.equal(use.tool_input, undefined);
  assert.equal(use.tool_input_preview, "[redacted]");
  assert.deepEqual(shows(promptOf(rows)), []);
  // Across a property name and its value too.
  const named = rowOf(rowsOf("bash", { command: "ls", [HEAD]: REST }, "ok"), "tool_use");
  assert.equal(named.tool_input, undefined);
  assert.deepEqual(shows(JSON.stringify(named.tool_input ?? {})), []);
});

test("a read with no calls (the run's view, its Timeline): a held value split across two arguments of a call shows no half in any row, and its preview is \"[redacted]\"", () => {
  const read = (args) =>
    timelineOf([user("Run it."), assistant([call("c1", "bash", args)]), result("c1", "bash", "ok")], {
      redact: (part) => redacted(part, SECRETS),
      holds: (whole) => withheldWhole(whole, SECRETS),
    });
  for (const args of [{ command: `echo ${HEAD}`, note: REST }, { command: "ls", [HEAD]: REST }]) {
    const rows = read(args);
    assert.deepEqual(shows(JSON.stringify(rows)), [], JSON.stringify(args));
    assert.equal(rowOf(rows, "tool_use").tool_input_preview, "[redacted]");
  }
  // A held value whole in one argument is cut in place there too (control).
  assert.equal(rowOf(read({ command: `echo ${KEY}` }), "tool_use").tool_input_preview, "echo [redacted]");
});

test("a held value whole in one argument is cut in place: tool_input keeps the call's shape (control)", () => {
  const use = rowOf(rowsOf("bash", { command: `echo ${KEY}`, note: "x" }, "ok"), "tool_use");
  assert.deepEqual(use.tool_input, { command: "echo [redacted]", note: "x" });
});

// The prompt builder itself (template-eval.ts graderInput): a run whose calls split a held value across two arguments,
// across a property name and its value, and across two strings of a result, and hold it whole in one argument. The
// calls come from the rows of a calls read (callsOf), as an eval reads them; the prompt holds neither half nor the value.
test("graderInput: the prompt built from a run whose calls split a held value holds neither half nor the whole value", () => {
  const rows = timelineOf(
    [
      user("Run it."),
      assistant([call("c1", "bash", { command: `echo ${HEAD}`, note: REST }), call("c2", "bash", { command: "ls", [HEAD]: REST }), call("c3", "read", { path: "notes.json" }), call("c4", "bash", { command: `echo ${KEY}` })]),
      result("c1", "bash", "ok"),
      result("c2", "bash", "ok"),
      result("c3", "read", JSON.stringify({ items: [{ title: `see ${HEAD}`, snippet: `${REST} more` }] })),
      result("c4", "bash", "done"),
    ],
    {
      redact: (part) => redacted(part, SECRETS),
      holds: (whole) => withheldWhole(whole, SECRETS),
      calls: { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, SECRETS, CALL_RESULT_CHARS, scrubUrls) },
    },
  );
  const prompt = graderInput(grader, "task", { answer: "done", calls: callsOf(rows, "pi"), mcpCalls: [], files: [] });
  assert.equal(prompt.includes(KEY), false);
  assert.deepEqual(shows(prompt), []);
  // Each split call is listed by its preview, "[redacted]"; the whole value in one argument is cut in place.
  assert.equal(prompt.match(/\(\[redacted\]\)/g)?.length, 2);
  assert.match(prompt, /"command":"echo \[redacted\]"/);
});

test("a held value split across a web call's property name and its value withholds the call's result", () => {
  const text = JSON.stringify({ query: "q", results: [{ url: "https://h.example/a", title: "t", [HEAD]: `${REST} more` }] });
  assert.equal(rowOf(rowsOf("web_search", { query: "q" }, text), "tool_result").tool_result_text, "[redacted]");
});

// A workflow run's graph (graph-served.ts servedGraphView): each part (a call, a decision) and each other top-level field
// of the view is read whole, as its JSON, so a held value split across two top-level fields of a call's output, a
// decision's state or a field of the view withholds that part or field; the run's own facts pass as they are. A held
// value whole in one field is cut in place there, and the part keeps its shape (control).
const graphOf = (output, state, later) => ({
  read_at: "2026-11-24T00:00:00.000Z",
  run: { id: "run-1", agent: "a1", revision: "r1", status: "completed", paused: false, startedAt: "2026-11-24T00:00:00.000Z", endedAt: null },
  nodes: {},
  decisions: [{ id: "d1", status: "done", state }],
  effects: [{ tool: "llm", status: "done", output }],
  later,
});

test("the graph: a held value split across two top-level fields of a call's output, a decision's state or a field shows no half", () => {
  const split = { summary: `echo ${HEAD}`, detail: `${REST} more` };
  const view = graphOf(split, split, split);
  const shown = servedGraphView(view, SECRETS);
  assert.deepEqual(shows(JSON.stringify(shown)), []);
  assert.deepEqual(shown.run, view.run);
});

test("the graph: a held value whole in one field of a call's output is cut in place, the part keeping its shape (control)", () => {
  const whole = { summary: `see ${KEY}`, detail: "ok" };
  const shown = servedGraphView(graphOf(whole, whole, whole), SECRETS);
  const cut = { summary: "see [redacted]", detail: "ok" };
  assert.deepEqual(shown.effects, [{ tool: "llm", status: "done", output: cut }]);
  assert.deepEqual(shown.decisions, [{ id: "d1", status: "done", state: cut }]);
  assert.deepEqual(shown.later, cut);
});

// Every other read of a value with fields (key-refusal.ts redactedOutput) reads it whole too: a workflow run's output in
// its run's view, the input "Run again" sends, a running tool's args in the live view, the input a workflow run's title
// is made of. A held value split across two of its fields withholds it; one whole in a field is cut in place (controls).
const SPLIT = { command: `echo ${HEAD}`, note: `${REST} more` };
const VIEW_DEPS = { origin: "https://run.test", serverSecrets: () => [...SECRETS] };

/** A workflow run on a new store, ended completed with `output` as its end kept it, read as the run's view serves it. */
async function workflowViewOf(t, output) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Review" }, { id: "rev-1", kind: "workflow", body: { workflow: {} } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { topic: "x" }, title: "t", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const end = { id: await journal.mintId(), conversationId: 1, kind: "agentrun.end", data: { state: "ended", summary: "done", costUsd: 0, output } };
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: end }], BACKGROUND_CONTEXT);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd: 0, endedAt: T0 + 10 });
  return viewOverStore(store, "run-1", VIEW_DEPS);
}

test("the run's view: a workflow's output split across two of its fields shows no half", async (t) => {
  const view = await workflowViewOf(t, SPLIT);
  assert.equal(view.status, "completed");
  assert.deepEqual(shows(JSON.stringify(view)), []);
});

test("the run's view: a workflow's output with a held value whole in one field is cut in place (control)", async (t) => {
  const view = await workflowViewOf(t, { command: `echo ${KEY}`, note: "ok" });
  assert.deepEqual(view.result.output, { command: "echo [redacted]", note: "ok" });
});

/** An agentic run queued on a new store with `input` in its launch, read as the run's view serves it. */
async function queuedViewOf(t, input) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input, title: "t", place: { mode: "runner" } } });
  return viewOverStore(store, "run-1", VIEW_DEPS);
}

test("the run's view: an input split across two of its fields is not served, and shows no half", async (t) => {
  const view = await queuedViewOf(t, SPLIT);
  assert.equal(view.input, null);
  assert.deepEqual(shows(JSON.stringify(view)), []);
});

test("the run's view: an input with no held value is served as given (control)", async (t) => {
  const view = await queuedViewOf(t, { command: "ls", note: "fine" });
  assert.deepEqual(view.input, { command: "ls", note: "fine" });
});

/** The args a running tool reports, as the live ticker writes them to run_live under a held value: one tick, at close. */
async function liveArgsOf(args) {
  const rows = [];
  const ticker = withLiveTicker({ live: { put: async (put) => void rows.push(...put), drop: async () => {} } }, (deps) => ({
    start: async () => {
      deps.live(() => ({ tools: [{ callId: "c1", name: "bash", args }] }));
      await held;
      return { state: "interrupted" };
    },
    command: async () => ({ refused: "this loop takes no commands" }),
    stop: async () => {},
  }), { tickMs: 3_600_000 });
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  const loop = ticker.createLoop({ signal: new AbortController().signal, redact: { heldValues: () => SECRETS } });
  const started = loop.start({ runId: "run-1" });
  await ticker.close();
  release();
  await started;
  assert.equal(rows.length, 1);
  return rows[0].state.tools[0].args;
}

test("the live view: a running tool's args split across two of its fields show no half", async () => {
  assert.deepEqual(shows(JSON.stringify(await liveArgsOf(SPLIT))), []);
});

test("the live view: a running tool's args with a held value whole in one field are cut in place (control)", async () => {
  assert.deepEqual(await liveArgsOf({ command: `echo ${KEY}`, note: "ok" }), { command: "echo [redacted]", note: "ok" });
});

/** The input a workflow run's title is made of (StartDeps.workflowTitle's), as prepareLaunch hands it: the start stops
 *  there, at the test's own refusal. */
async function titleInputOf(input) {
  const revision = { id: "rev-1", kind: "workflow", body: { workflow: {} } };
  const entry = { agent: { id: "agent-1", name: "Review" }, version: 1, revision };
  const STOP = new Error("the test stops the start at its title");
  let given;
  const deps = {
    runBodyIssues: () => [],
    inputIssuesOf: async () => [],
    told: (error) => error,
    explainRun: async (issues) => issues,
    readyFiles: async () => {},
    fallbackPlace: () => ({ mode: "runner" }),
    runnable: async () => {},
    serverSecrets: () => [...SECRETS],
    workflowTitle: (_name, shown) => {
      given = shown;
      throw STOP;
    },
  };
  await assert.rejects(prepareLaunch(deps, entry, { input }, { revision }), (error) => error === STOP);
  return given;
}

test("a workflow run's title: an input split across two of its fields gives the title none of it", async () => {
  assert.deepEqual(shows(JSON.stringify(await titleInputOf(SPLIT))), []);
});

test("a workflow run's title: an input with no held value gives the title its fields (control)", async () => {
  assert.deepEqual(await titleInputOf({ command: "ls", note: "fine" }), { command: "ls", note: "fine" });
});
