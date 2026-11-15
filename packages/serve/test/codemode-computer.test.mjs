// The host's codemode (runner/meta-tools.ts) on a run with a desktop: the computer's tools (computer_screenshot,
// computer_act, computer_observe...) are the run's own host tools, so a script calls them as `tools.<name>(...)`, each a
// nested call of its own: asked about at the gate as that tool (held to the kind's setting, a deny on desktop refusing
// it and ending the script), recorded on the timeline as its own rows under the script's id, its computer protocol calls
// on its own result row, and answered from its record when the script runs again. pi through the adapter loop on a
// runner; the model is a scripted Anthropic origin and the computer a loopback fake: nothing leaves this process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, hostTools, MODEL, offeredTools, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { CODEMODE } = await import("../dist/runner/meta-tools.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { localWorkspace, runTools } = await import("../dist/workspace/index.js");
const { deniedText } = await import("../dist/tool-gate.js");
const { recordedClient } = await import("../dist/computer-calls.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const GROUPS = ["screen", "input.pointer", "input.keys"];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const COMPUTER = ["computer_observe", "computer_act", "computer_screenshot"];
const dirs = [];
after(async () => {
  await closeOpenSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A loopback desktop with the screen and raw input (and with `ui`, ui.observe and ui.act on one TextEdit window): its
 *  screen.shot answers a 1280-wide PNG; every call is recorded. Its client is the run's as the claim wraps it
 *  (recordedClient), and its tools are the run's as runTools binds them. */
async function desktop({ ui = false, apps = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-"));
  dirs.push(dir);
  const computer = fakeComputer(dir);
  const size = Buffer.from(PNG, "base64").length;
  computer.overrides["screen.shot"] = () => ({ id: "s1", size, data: PNG, eof: true, width: 1280, height: 800, scale: 1 });
  computer.overrides["input.actions"] = ({ actions }) => ({ done: actions.length });
  computer.overrides["ui.observe"] = () => ({
    state: "s1", app: { id: "com.apple.TextEdit", name: "TextEdit" }, window: { id: "w1", title: "totals.txt", bounds: [0, 0, 600, 400] }, truncated: false,
    nodes: [
      { ref: "@e1", role: "textbox", name: "Pears: 41", value: "Apples: 3\nPears: 41", bounds: [0, 20, 600, 380] },
      { ref: "@e2", role: "button", name: "Save", bounds: [500, 0, 60, 20] },
    ],
  });
  computer.overrides["ui.act"] = ({ steps }) => ({ steps: steps.map(() => ({ route: "semantic", verified: true })), state: "s2", changed: true });
  // With `apps`, a terminal in front: apps.launch brings an app there.
  computer.overrides["apps.list"] = () => ({ apps: [{ id: "xfce4-terminal", name: "Terminal" }], foreground: "xfce4-terminal" });
  computer.overrides["apps.launch"] = () => ({});
  const groups = [...GROUPS, ...(ui ? ["ui"] : []), ...(apps ? ["apps"] : [])];
  const run = await runTools(localWorkspace(dir), { kind: "desktop", computer: { client: recordedClient(computer.client) }, hello: { protocol: "0.2", version: "0", os: "linux", kind: "desktop", arch: "amd64", groups } }, { mode: 1, context: ctx });
  return { computer, tools: run.hostTools(COMPUTER) };
}

/** A pi run of `script` over the suite's tools and `computerTools`, its gate `gate(call)`: the request bodies the provider
 *  got, and the server's store. With `restartAt`, the first runner shuts down once it settles and a second one takes the
 *  run on. */
async function codemodeRun(t, script, computerTools, gate = () => "allow", restartAt = undefined) {
  const { server, runners: stores_ } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const { tools } = suiteTools();
  const requests = [];
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => 0 }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: [...hostTools(tools), ...computerTools], context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks: quiet,
    gate,
  }));
  const runner = startRunner({ store: stores_[0], createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  if (restartAt) {
    await restartAt;
    // A shutdown mid-script: the claim lets the run go, its codemode call unsettled in its journal.
    await runner.close();
    const next = startRunner({ store: stores_[1], createLoop: loop, name: "runner-b", ...TIMING });
    t.after(() => next.close());
  }
  await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended", 30_000);
  return { requests, server };
}

/** The text of the newest tool result the provider got. */
function lastResult(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return { text: typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), isError: results.at(-1)?.is_error === true };
}

/** The base64 data of each image in the newest tool result the provider got. */
function lastImages(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return (Array.isArray(content) ? content : []).filter((part) => part.type === "image").map((part) => part.source?.data);
}

/** The rows of each call `codemode` made, by tool: its own tool_use and tool_result rows, under the script's id. */
function nestedRows(rows) {
  const id = rows.find((row) => row.kind === "tool_use" && row.tool_name === CODEMODE)?.tool_use_id;
  assert.ok(id, `the script has its own row: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_name]))}`);
  return rows.filter((row) => row.tool_use_id?.startsWith(`${id}/`));
}

test("a script calls the computer's tools as tools.<name>, each a nested call: the computer is reached, and the script reads each call's value", async (t) => {
  const { computer, tools } = await desktop();
  const script = "const shot = await tools.computer_screenshot({});\nawait tools.computer_act({ steps: [{ click: [10, 10] }] });\nreturn { width: shot.width, steps: (await tools.computer_act({ steps: [{ click: [20, 20] }] })).steps.length };";
  const { requests, server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools);
  const offered = offeredTools(requests[0]);
  assert.ok(offered.includes(CODEMODE) && offered.includes("computer_act"), `the host's codemode beside the computer's tools: ${JSON.stringify(offered)}`);
  const result = lastResult(requests);
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /"width":\s*1280/, `the screenshot's value reached the script: ${result.text}`);
  assert.match(result.text, /"steps":\s*1/, `the act's value reached the script: ${result.text}`);
  assert.deepEqual(computer.calls.map(([method]) => method).filter((method) => method !== "hello"), ["screen.shot", "input.actions", "input.actions"], "each call reached the computer once");
  const nested = nestedRows(await runTimeline(server, "run-1", ctx));
  assert.deepEqual(nested.filter((row) => row.kind === "tool_use").map((row) => row.tool_name), ["computer_screenshot", "computer_act", "computer_act"], "each is a call of its own on the timeline");
});

test("on a desktop with no ui group, an act that names an app makes one apps.launch (the app brought in front) then its input; an act that names none is its input alone", async (t) => {
  const { computer, tools } = await desktop({ apps: true });
  const script = "await tools.computer_act({ app: 'xfce4-terminal', steps: [{ type: 'x' }] });\nawait tools.computer_act({ app: 'xfce4-terminal', steps: [{ type: 'y' }] });\nawait tools.computer_act({ steps: [{ type: 'z' }] });\nreturn 'typed';";
  const { requests, server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools);
  assert.equal(lastResult(requests).isError, false, lastResult(requests).text);
  assert.deepEqual(computer.calls.map(([method]) => method).filter((method) => method !== "hello"), ["apps.launch", "input.actions", "apps.launch", "input.actions", "input.actions"], "two host calls for an act that names an app, one for one that names none");
  const acts = nestedRows(await runTimeline(server, "run-1", ctx)).filter((row) => row.kind === "tool_result");
  assert.deepEqual(acts.map((row) => row.computer_calls.map((call) => call.method)), [["apps.launch", "input.actions"], ["apps.launch", "input.actions"], ["input.actions"]], "each act's row says which calls it made");
});

test("a script's calls sit under the script's own call on the timeline: each nested row names that call as its parent, and its input shows in the default view as a top-level call's does", async (t) => {
  const { tools } = await desktop({ ui: true });
  const script = "await tools.computer_observe({ app: 'com.apple.TextEdit' });\nawait tools.computer_act({ app: 'com.apple.TextEdit', steps: [{ press: '@e2' }] });\nreturn 'saved';";
  const { requests, server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools);
  assert.equal(lastResult(requests).isError, false, lastResult(requests).text);
  const rows = await runTimeline(server, "run-1", ctx);
  const outer = rows.find((row) => row.kind === "tool_use" && row.tool_name === CODEMODE);
  assert.equal(outer.parent_tool_use_id, undefined, "the script's own call is the model's: no parent");
  assert.equal(outer.tool_input_preview, script, "the script's row shows its script");
  assert.equal(rows.find((row) => row.kind === "tool_result" && row.tool_name === CODEMODE)?.parent_tool_use_id, undefined);
  const nested = nestedRows(rows);
  assert.equal(nested.length, 4, JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.tool_use_id])));
  assert.deepEqual(nested.map((row) => [row.kind, row.tool_name, row.parent_tool_use_id]), [
    ["tool_use", "computer_observe", outer.tool_use_id],
    ["tool_result", "computer_observe", outer.tool_use_id],
    ["tool_use", "computer_act", outer.tool_use_id],
    ["tool_result", "computer_act", outer.tool_use_id],
  ], "every nested row names the script's call");
  assert.deepEqual(nested.filter((row) => row.kind === "tool_use").map((row) => [row.tool_input_preview, row.tool_input]), [["com.apple.TextEdit", undefined], ["com.apple.TextEdit", undefined]], "each nested call's app in its preview, its whole input only with calls");
});

test("a screenshot a script takes reaches the model with its pixels when the script shows it with image(...) or returns it, as a direct call's does", async (t) => {
  for (const script of ["const shot = await tools.computer_screenshot({});\nimage(shot);\nreturn { width: shot.width };", "return await tools.computer_screenshot({});"]) {
    const { tools } = await desktop();
    const { requests } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools);
    const result = lastResult(requests);
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(lastImages(requests), [PNG], `${script}: the screenshot's pixels are in the script's answer`);
    assert.match(result.text, /"width":\s*1280/, result.text);
    assert.ok(!result.text.includes(PNG), `${script}: its text never carries the image's data`);
  }
});

test("each computer call a script makes carries its own computer_calls on its own result row, as a direct call's does: the app and each step's element and chord, never what it typed", async (t) => {
  const { computer, tools } = await desktop({ ui: true });
  const script = [
    "const page = await tools.computer_observe({ app: 'com.apple.TextEdit' });",
    "await tools.computer_act({ app: 'com.apple.TextEdit', state: page.id, steps: [{ key: 'super+a' }, { type: 'Pears: 42 typed-words-stay-out', into: '@e1' }, { key: 'x' }] });",
    "await tools.computer_act({ app: 'com.apple.TextEdit', steps: [{ press: '@e2' }] });",
    "return 'saved';",
  ].join("\n");
  const before = Date.now();
  const { requests, server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools);
  assert.equal(lastResult(requests).isError, false, lastResult(requests).text);
  assert.deepEqual(computer.calls.map(([method]) => method).filter((method) => method !== "hello"), ["ui.observe", "ui.act", "ui.act"], "the script's calls reached the computer");
  const rows = await runTimeline(server, "run-1", ctx);
  const results = nestedRows(rows).filter((row) => row.kind === "tool_result");
  assert.deepEqual(results.map((row) => row.tool_name), ["computer_observe", "computer_act", "computer_act"], JSON.stringify(rows.map((row) => [row.kind, row.tool_name])));
  const script_ = rows.find((row) => row.kind === "tool_result" && row.tool_name === CODEMODE);
  assert.equal(script_?.computer_calls, undefined, "the script's own row carries none: each call's are on its own row");
  for (const row of results) {
    assert.equal(row.computer_calls?.length, 1, `one protocol call on each nested row: ${JSON.stringify(row)}`);
    const at = Date.parse(row.computer_calls[0].started_at);
    assert.ok(at >= before && at <= Date.parse(row.timestamp), `its own start time, inside the run: ${row.computer_calls[0].started_at}`);
  }
  assert.deepEqual(results.map((row) => row.computer_calls.map(({ ms, started_at, ...rest }) => (assert.equal(typeof ms, "number"), rest))[0]), [
    { method: "ui.observe", app: "com.apple.TextEdit", ok: true },
    { method: "ui.act", app: "com.apple.TextEdit", ok: true, steps: [
      { do: "key", keys: "super+a", route: "semantic", verified: true },
      { do: "type", on: { role: "textbox", name: "Pears: 41" }, route: "semantic", verified: true },
      { do: "key", route: "semantic", verified: true },
    ] },
    { method: "ui.act", app: "com.apple.TextEdit", ok: true, steps: [{ do: "press", on: { role: "button", name: "Save" }, route: "semantic", verified: true }] },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /typed-words-stay-out|"x"/, "no typed text and no lone key on any row");
});

test("a script's computer call is held to the kind's setting: a deny on desktop refuses that call in the gate's words and ends the script there; the script itself and the calls before it ran", async (t) => {
  const { computer, tools } = await desktop();
  const deny = (call) => (call.tool === "computer_act" ? { deny: deniedText("desktop") } : "allow");
  const script = "const shot = await tools.computer_screenshot({});\nawait tools.computer_act({ steps: [{ click: [10, 10] }] });\nreturn 'clicked';";
  const { requests } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, deny);
  const result = lastResult(requests);
  assert.equal(result.isError, true, result.text);
  assert.ok(result.text.startsWith(deniedText("desktop")), `refused in desktop's deny words: ${result.text}`);
  assert.match(result.text, /1\. computer_screenshot completed/, result.text);
  assert.doesNotMatch(result.text, /clicked/);
  assert.deepEqual(computer.calls.map(([method]) => method).filter((method) => method !== "hello"), ["screen.shot"], "the click never reached the computer");
});

test("a script run again after a restart: a computer call it made is answered from its record, never made again, and a click the shutdown cut is told interrupted, never sent twice", async (t) => {
  const { computer, tools } = await desktop();
  // The first click never answers on the first runner: it shuts down with the script waiting on it.
  let stuck;
  const reached = new Promise((resolve) => (stuck = resolve));
  computer.overrides["input.actions"] = () => {
    stuck();
    return new Promise(() => {});
  };
  const script = "await tools.computer_screenshot({});\nawait tools.computer_act({ steps: [{ click: [10, 10] }] });\nreturn (await tools.computer_screenshot({})).width;";
  const { requests, server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, () => "allow", reached);
  const result = lastResult(requests);
  assert.match(result.text, /1\. computer_screenshot completed[^\n]*\n2\. computer_act was started and did not report a result/, result.text);
  assert.deepEqual(computer.calls.map(([method]) => method).filter((method) => method !== "hello"), ["screen.shot", "input.actions"], "the replay never shot the screen again, and never clicked twice");
  const nested = nestedRows(await runTimeline(server, "run-1", ctx));
  assert.deepEqual(nested.filter((row) => row.kind === "tool_use").map((row) => row.tool_name), ["computer_screenshot", "computer_act"], "each call on the timeline once");
});
