// A held value split across two strings of a JSON text, where each string alone holds half of it: a call's result of any
// tool (its rows and the text a grader reads of it), a call's arguments (tool_input, and the grader's prompt built from
// them), a web call's property name and value, a workflow's output in its graph. Each withholds what holds it, never
// showing a half.
import assert from "node:assert/strict";
import { test } from "node:test";
import { servedGraphView } from "../dist/graph-served.js";
import { redacted, redactedCall, withheldWhole } from "../dist/key-refusal.js";
import { callsOf, graderInput } from "../dist/template-eval.js";
import { CALL_RESULT_CHARS, scrubUrls, timelineOf } from "../dist/timeline/index.js";
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
    calls: { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, SECRETS, CALL_RESULT_CHARS, scrubUrls), holds: (whole) => withheldWhole(whole, SECRETS) },
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
      calls: { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, SECRETS, CALL_RESULT_CHARS, scrubUrls), holds: (whole) => withheldWhole(whole, SECRETS) },
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
