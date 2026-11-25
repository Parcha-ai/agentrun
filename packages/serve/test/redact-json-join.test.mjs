// A held value split across two strings of a JSON text, where each string alone holds half of it: a call's result of any
// tool (its rows and the text a grader reads of it), a call's arguments (tool_input, and the grader's prompt built from
// them), a web call's property name and value, a workflow's output in its graph (a web call's JSON text among it) and in
// the run's view, a run's input, a running tool's live args, a workflow run's title, and an SDK run's tool events and
// completion as stored. Each withholds what holds it, never showing a half.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { servedGraphView } from "../dist/graph-served.js";
import { redacted, redactedCall, withheldWhole } from "../dist/key-refusal.js";
import { withLiveTicker } from "../dist/runner/live-ticker.js";
import { prepareLaunch } from "../dist/runs-over-store.js";
import { SdkRuns, sdkInbox } from "../dist/sdk/runs.js";
import { viewOverStore } from "../dist/store-view.js";
import { callsOf, graderInput } from "../dist/template-eval.js";
import { CALL_RESULT_CHARS, scrubUrls, timelineOf } from "../dist/timeline/index.js";
import { landWorkflows, promoteChecked } from "./learned-workflow-seed-support.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";
import { serve } from "./support.mjs";
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

test("a held value split across two strings of a non-web tool's JSON result, a \"+\" after its head or a quote of its own in it, is withheld: no row shows a half", () => {
  const QUOTED = `${HEAD}"${REST}`;
  const read = (secrets, text) =>
    timelineOf([user("Run it."), assistant([call("c1", "read", { path: "notes.json" })]), result("c1", "read", text)], {
      redact: (part) => redacted(part, secrets),
      holds: (whole) => withheldWhole(whole, secrets),
      calls: { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, secrets, CALL_RESULT_CHARS, scrubUrls) },
    });
  const cases = [
    [SECRETS, JSON.stringify({ items: [{ title: `see ${HEAD}+`, snippet: `${REST} more` }] })],
    [[QUOTED], JSON.stringify({ items: [{ title: `see ${HEAD}"${REST.slice(0, 8)}`, snippet: `${REST.slice(8)} more` }] })],
  ];
  for (const [secrets, text] of cases) {
    const rows = read(secrets, text);
    assert.deepEqual(shows(JSON.stringify(rows)), [], text);
    assert.equal(rowOf(rows, "tool_result").tool_result_text, "[redacted]", text);
  }
  // Control: the quoted value whole in one string is cut in place.
  const whole = rowOf(read([QUOTED], JSON.stringify({ items: [{ title: `see ${QUOTED}`, snippet: "more" }] })), "tool_result").tool_result_text;
  assert.deepEqual(JSON.parse(whole), { items: [{ title: "see [redacted]", snippet: "more" }] });
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

// The graph's structure (`graph`, the DSL's workflowGraph): a question whose instructions end with a held value's head
// and whose first option starts with its rest. Withheld, it is served in the shape every reader of the graph reads, no
// nodes and no edges, marked withheld; never the string "[redacted]" where a graph stands. A held value whole in one
// question's words is cut in place, the graph keeping its nodes and no mark (control).
const questionGraph = (instructions, option) => ({
  nodes: [{ path: "/root", kind: "pick", label: "pick", questions: [{ id: "q", type: "choice", instructions, options: [option, "second"] }] }],
  edges: [],
});

test("the graph: a held value split across a question's instructions and its first option serves the graph withheld, with no nodes or edges", () => {
  const shown = servedGraphView({ ...graphOf({}, {}, "x"), graph: questionGraph(`Which one? ${HEAD}`, `${REST} first`) }, SECRETS);
  assert.deepEqual(shows(JSON.stringify(shown)), []);
  assert.deepEqual(shown.graph, { nodes: [], edges: [], withheld: true });
});

test("the graph: a held value whole in a question's instructions is cut in place, the graph keeping its nodes (control)", () => {
  const shown = servedGraphView({ ...graphOf({}, {}, "x"), graph: questionGraph(`Which one? ${KEY}`, "first") }, SECRETS);
  assert.deepEqual(shown.graph, questionGraph("Which one? [redacted]", "first"));
});

// The run's facts (`run`): a held value split across its agent and its revision. Withheld, it is served in its own shape:
// the facts the server makes (its id, status, pause and times) as they are, the agent and the revision "[redacted]", and
// marked withheld; never the string "[redacted]" where the run's facts stand. A held value whole in the agent is cut in
// place, with no mark (control).
test("the graph: a held value split across the run's agent and its revision serves the run in its shape, its agent and revision \"[redacted]\", marked withheld", () => {
  const view = graphOf({}, {}, "x");
  const shown = servedGraphView({ ...view, run: { ...view.run, agent: `agent ${HEAD}`, revision: `${REST} r1` } }, SECRETS);
  assert.deepEqual(shows(JSON.stringify(shown)), []);
  assert.deepEqual(shown.run, { ...view.run, agent: "[redacted]", revision: "[redacted]", withheld: true });
});

test("the graph: a held value whole in the run's agent is cut in place, the run's facts as they are and no mark (control)", () => {
  const view = graphOf({}, {}, "x");
  const shown = servedGraphView({ ...view, run: { ...view.run, agent: `agent ${KEY}` } }, SECRETS);
  assert.deepEqual(shown.run, { ...view.run, agent: "agent [redacted]" });
});

// A web call's output in the graph is its JSON written as a string in the call's part: the join reads the strings inside
// that string too, so a held value split across two of them withholds the part; one whole in a string is cut in place,
// the JSON still parsing (control).
const webPartOf = (title, snippet) => ({
  read_at: "2026-11-24T00:00:00.000Z",
  run: { id: "run-1", agent: "a1", revision: "r1", status: "completed", paused: false, startedAt: "2026-11-24T00:00:00.000Z", endedAt: null },
  nodes: {},
  decisions: [],
  effects: [{ tool: "web_search", status: "done", output: JSON.stringify({ query: "q", results: [{ url: "https://h.example/a", title, snippet }] }) }],
});

test("the graph: a web call's output, its JSON text in a call's part, with a held value split across two of its strings shows no half", () => {
  const view = webPartOf(`see ${HEAD}`, `${REST} more`);
  const shown = servedGraphView(view, SECRETS);
  assert.deepEqual(shows(JSON.stringify(shown)), []);
  assert.deepEqual(shown.run, view.run);
});

test("the graph: a web call's output with a held value whole in one of its strings is cut in place, its JSON still parsing (control)", () => {
  const [part] = servedGraphView(webPartOf(`see ${KEY}`, "ok"), SECRETS).effects;
  assert.equal(part.tool, "web_search");
  assert.deepEqual(JSON.parse(part.output).results[0], { url: "https://h.example/a", title: "see [redacted]", snippet: "ok" });
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

// What an SDK-run agent reports is stored as the server cuts it (sdk/runs.ts): a tool event's input and output (a web
// tool's answer among them) and the completion's answer and error. A held value split across two strings of one of
// them withholds that one, and one split across two of them withholds both; the event's or the completion's own facts
// (sequence, type, id, name, status) stay. A held value whole in one string is cut in place (controls).
async function sdkRunOf(t, secrets = SECRETS) {
  const server = await serve(t, { runner: false });
  const definition = { id: "sdk-split", name: "SDK split", instructions: "Use the policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] };
  assert.equal((await server.api("POST", "/agents", { definition })).status, 201);
  const started = await server.api("POST", "/agents/sdk-split/sdk-runs", { runtime: "claude-agent-sdk", input: "A task.", instructions: "Keep the policy." }, { "Idempotency-Key": "split" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.run_id;
  return { id, sdk: new SdkRuns(server.store, server.data, "fake-test-key", () => [...secrets]), inbox: () => sdkInbox(server.store, id) };
}
const toolEvent = (id, input, output) => ({ type: "tool", id, name: "web_search", status: "completed", input, output });

test("an SDK run's tool event: a held value split across two strings of its output, or across its input and its output, is stored as no half", async (t) => {
  const run = await sdkRunOf(t);
  const input = { query: "q" };
  const output = { results: [{ url: "https://h.example/a", title: `see ${HEAD}`, snippet: `${REST} more` }] };
  const events = [toolEvent("t1", input, output), toolEvent("t2", { command: `echo ${HEAD}` }, { note: `${REST} more` })];
  assert.deepEqual(await run.sdk.events(run.id, { sequence: 1, events }), { accepted: true });
  const inbox = await run.inbox();
  assert.deepEqual(shows(JSON.stringify(inbox)), []);
  assert.deepEqual(inbox.batches[0], { sequence: 1, events: [toolEvent("t1", input, "[redacted]"), toolEvent("t2", "[redacted]", "[redacted]")] });
  assert.equal(inbox.check_redacted, true);
});

test("an SDK run's tool event with a held value whole in one string of its output is cut in place (control)", async (t) => {
  const run = await sdkRunOf(t);
  const events = [toolEvent("t1", { query: "q" }, { results: [{ title: `see ${KEY}`, snippet: "ok" }] })];
  assert.deepEqual(await run.sdk.events(run.id, { sequence: 1, events }), { accepted: true });
  assert.deepEqual((await run.inbox()).batches[0].events, [toolEvent("t1", { query: "q" }, { results: [{ title: "see [redacted]", snippet: "ok" }] })]);
});

test("an SDK run's completion: a held value split across its answer and its error is stored as no half", async (t) => {
  const run = await sdkRunOf(t);
  assert.deepEqual(await run.sdk.complete(run.id, { status: "failed", answer: `stopped at ${HEAD}`, error: `${REST} was refused` }), { accepted: true });
  const { completion } = await run.inbox();
  assert.deepEqual(shows(JSON.stringify(completion)), []);
  assert.deepEqual(completion, { status: "failed", answer: "[redacted]", error: "[redacted]" });
});

// A second held value, and what of either value a stored text must not show: each half's first eight characters.
const [HEAD2, REST2] = [["Wm5T", "qX8c", "Rv3N", "jB7d"].join(""), ["Lp4K", "hF9s", "Zt2G", "yE6a"].join("")];
const BOTH = [KEY, `${HEAD2}${REST2}`];
const showsEither = (text) => [HEAD, REST, HEAD2, REST2].map((half) => half.slice(0, 8)).filter((half) => text.includes(half));

test("an SDK run's completion: one part withheld by itself, its tail holding a second value's head whose rest is the other part, stores neither half", async (t) => {
  // The answer holds the first value split by a space, so it is withheld alone; it ends with the second value's head,
  // and the error starts with that value's rest.
  const run = await sdkRunOf(t, BOTH);
  assert.deepEqual(await run.sdk.complete(run.id, { status: "failed", answer: `stopped at ${HEAD} ${REST}, then ${HEAD2}`, error: `${REST2} was refused` }), { accepted: true });
  const { completion } = await run.inbox();
  assert.deepEqual(showsEither(JSON.stringify(completion)), []);
  assert.deepEqual(completion, { status: "failed", answer: "[redacted]", error: "[redacted]" });
});

test("an SDK run's tool event: its input withheld by itself, its tail holding a second value's head whose rest is the output, stores neither half", async (t) => {
  const run = await sdkRunOf(t, BOTH);
  const events = [toolEvent("t1", { command: `echo ${HEAD} ${REST} and ${HEAD2}` }, { note: `${REST2} more` })];
  assert.deepEqual(await run.sdk.events(run.id, { sequence: 1, events }), { accepted: true });
  const inbox = await run.inbox();
  assert.deepEqual(showsEither(JSON.stringify(inbox)), []);
  assert.deepEqual(inbox.batches[0].events, [toolEvent("t1", "[redacted]", "[redacted]")]);
});

test("an SDK run's completion with its answer withheld by itself and an error that holds no part of a held value keeps the error as given (control)", async (t) => {
  const run = await sdkRunOf(t, BOTH);
  assert.deepEqual(await run.sdk.complete(run.id, { status: "failed", answer: `stopped at ${HEAD} ${REST}`, error: "the search was refused" }), { accepted: true });
  assert.deepEqual((await run.inbox()).completion, { status: "failed", answer: "[redacted]", error: "the search was refused" });
});

/** An SDK run given the learned workflow "release", whose one step calls `STATUS`, and its inbox read as the server
 *  cuts what it reports, against the held values. */
const STATUS = "mcp:backend/status";
async function sdkWorkflowRunOf(t) {
  const server = await serve(t, { runner: false });
  const workflow = { v: 2, name: "release", schemas: { In: { type: "object" }, Out: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool: STATUS, args: {}, out: "Out", as: "answer", deadline_s: 5 } };
  assert.equal((await server.api("POST", "/agents", { definition: { id: "sdk-flow", name: "SDK flow", instructions: "Read release status.", sdk: { runtime: "claude-agent-sdk" }, learning: true, tools: [] } })).status, 201);
  await landWorkflows(server.data, "sdk-flow", [{ name: "release", description: "Read release status.", workflow }]);
  await promoteChecked(server.store.settings, "sdk-flow", [{ name: "release", workflow }]);
  const started = await server.api("POST", "/agents/sdk-flow/sdk-runs", { runtime: "claude-agent-sdk", input: "Read release status.", instructions: "Read release status.", workflow_tools: [{ name: STATUS, description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 }] }, { "Idempotency-Key": "flow" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.learning.workflows.map((flow) => flow.name), ["release"]);
  const id = started.body.run_id;
  return { id, sdk: new SdkRuns(server.store, server.data, "fake-test-key", () => [...SECRETS]), inbox: () => sdkInbox(server.store, id) };
}
const workflowStart = (name) => ({ type: "tool", id: "workflow", name: "learned_workflow", status: "started", input: { name, input: { note: `see ${HEAD}`, more: `${REST} next` } } });
const callback = { type: "tool", id: "callback", name: STATUS, status: "started", parent_tool_use_id: "workflow" };

test("an SDK run's learned_workflow start whose arguments hold a split held value is stored withheld, and a callback nested in it is taken", async (t) => {
  const run = await sdkWorkflowRunOf(t);
  assert.deepEqual(await run.sdk.events(run.id, { sequence: 1, events: [workflowStart("release")] }), { accepted: true });
  assert.deepEqual(await run.sdk.events(run.id, { sequence: 2, events: [callback] }), { accepted: true });
  const inbox = await run.inbox();
  assert.deepEqual(shows(JSON.stringify(inbox)), []);
  assert.deepEqual(inbox.batches.map((batch) => batch.events), [[{ ...workflowStart("release"), input: "[redacted]" }], [callback]]);
  assert.deepEqual(inbox.workflow_calls, { workflow: "release" });
});

test("an SDK run's learned_workflow start stored withheld whose id holds a held value: the stored row shows no part of it, and the workflow it names is kept under the id as stored", async (t) => {
  const run = await sdkWorkflowRunOf(t);
  const start = { ...workflowStart("release"), id: `workflow-${KEY}` };
  assert.deepEqual(await run.sdk.events(run.id, { sequence: 1, events: [start] }), { accepted: true });
  const row = await run.inbox();
  assert.deepEqual(shows(JSON.stringify(row)), []);
  const stored = row.batches[0].events[0];
  assert.deepEqual(stored, { ...start, id: "workflow-[redacted]", input: "[redacted]" });
  assert.deepEqual(row.workflow_calls, { [stored.id]: "release" });
});

test("an SDK run's learned_workflow start whose arguments hold a split held value and that names no workflow the run was given still refuses a callback nested in it (control)", async (t) => {
  const run = await sdkWorkflowRunOf(t);
  assert.deepEqual(await run.sdk.events(run.id, { sequence: 1, events: [workflowStart("invented")] }), { accepted: true });
  await assert.rejects(run.sdk.events(run.id, { sequence: 2, events: [callback] }), /nested SDK callback must name an open learned_workflow|was not supplied to this run/);
  assert.deepEqual(shows(JSON.stringify(await run.inbox())), []);
});

test("an SDK run's completion with a held value whole in its answer is cut in place, its error as given (control)", async (t) => {
  const run = await sdkRunOf(t);
  assert.deepEqual(await run.sdk.complete(run.id, { status: "failed", answer: `see ${KEY}`, error: "the search was refused" }), { accepted: true });
  assert.deepEqual((await run.inbox()).completion, { status: "failed", answer: "see [redacted]", error: "the search was refused" });
});
