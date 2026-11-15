// The host's codemode (runner/meta-tools.ts) on a run with a desktop: the computer's tools (computer_screenshot,
// computer_act, computer_observe...) are the run's own host tools, so a script calls them as `tools.<name>(...)`, each a
// nested call of its own: asked about at the gate as that tool (held to the kind's setting, a deny on desktop refusing
// it and ending the script), recorded on the timeline as its own rows under the script's id, its computer protocol calls
// on its own result row, and answered from its record when the script runs again. pi through the adapter loop on a
// runner; the model is a scripted Anthropic origin and the computer a loopback fake: nothing leaves this process.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
const { INTERRUPTED_TEXT } = await import("@parcha/agentrun-kernel/kernel");
const { DENIED_OPENING, REFUSAL_OPENINGS } = await import("../dist/refusal-words.js");
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
async function desktop({ ui = false, apps = false, surface, more = [], exec } = {}) {
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
  const groups = [...GROUPS, ...(ui ? ["ui"] : []), ...(apps ? ["apps"] : []), ...more];
  const run = await runTools(localWorkspace(dir), { kind: "desktop", computer: { client: recordedClient(computer.client) }, hello: { protocol: "0.2", version: "0", os: "linux", kind: "desktop", arch: "amd64", groups }, ...(surface ? { surface } : {}), ...(exec === false ? { exec } : {}) }, { mode: 1, context: ctx });
  // With a surface or more groups, every tool the computer brings as the run's spec binds them (RunTools.kindTools); else
  // its step tools.
  return { computer, run, tools: run.hostTools(surface || more.length ? run.kindTools : COMPUTER) };
}

/** The computer's protocol calls past its hello. */
const methodsOf = (computer) => computer.calls.map(([method]) => method).filter((method) => method !== "hello");

/** A pi run of `script` over the suite's tools and `computerTools`, its gate `gate(call)`: the request bodies the provider
 *  got, and the server's store. With `restartAt`, the first runner shuts down once it settles and a second one takes the
 *  run on. `options.computer`: the run's computer as its scripts get it bound (RunTools.computer); `options.settled`: the
 *  run's state it waits for (default ended); `options.adapter`: the run's adapter in pi's place, or `options.adapterOf(run)`
 *  makes it; `options.record`: the run's record as its harness keeps it ("loop" for a CLI's); `options.beforeNext(server)`:
 *  what happens between the first runner's shutdown and the second's start (with `restartAt`). */
async function codemodeRun(t, script, computerTools, gate = () => "allow", restartAt = undefined, options = {}) {
  const { server, runners: stores_ } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const { tools } = suiteTools();
  const requests = [];
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: options.adapterOf ? await options.adapterOf(run) : options.adapter ?? piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => 0 }),
    ...(options.record ? { record: options.record } : {}),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: [...hostTools(tools), ...computerTools], context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks: quiet,
    gate,
    ...(options.computer ? { scriptComputer: options.computer } : {}),
  }));
  const runner = startRunner({ store: stores_[0], createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  if (restartAt) {
    await restartAt;
    // A shutdown mid-script: the claim lets the run go, its codemode call unsettled in its journal.
    await runner.close();
    await options.beforeNext?.(server);
    const next = startRunner({ store: stores_[1], createLoop: loop, name: "runner-b", ...TIMING });
    t.after(() => next.close());
  }
  const settled = options.settled ?? "ended";
  await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === settled && now.runner === null && now;
  }, `the run ${settled}`, 30_000);
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
  assert.equal(outer.tool_input_preview, null, "the script's row shows no script: it can hold what an act types");
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

test("on a desktop whose surface is code, the model is offered codemode and the hand-over, no step tool and no computer_script; a script that acts twice and is cut by the runner's end mid-script reruns with each act reaching the computer once", async (t) => {
  const { computer, tools } = await desktop({ surface: "code" });
  // The third click never answers on the first runner: it ends with the script waiting on it. (A click, never a
  // screenshot: a screenshot is replay-safe, so a rerun takes it again.)
  let stuck;
  let bound;
  // A script that never reaches the third click fails here, never hangs.
  const reached = Promise.race([new Promise((resolve) => (stuck = resolve)), new Promise((_, reject) => (bound = setTimeout(() => reject(new Error("the script never reached its third click within 30 s")), 30_000)))]).finally(() => clearTimeout(bound));
  let clicks = 0;
  computer.overrides["input.actions"] = ({ actions }) => {
    clicks += 1;
    if (clicks < 3) return { done: actions.length };
    stuck();
    return new Promise(() => {});
  };
  const script = "await tools.computer_act({ steps: [{ click: [10, 10] }] });\nawait tools.computer_act({ steps: [{ click: [20, 20] }] });\nawait tools.computer_act({ steps: [{ click: [30, 30] }] });\nreturn 'clicked';";
  const { requests, server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, () => "allow", reached);
  const offered = offeredTools(requests[0]);
  assert.ok(offered.includes(CODEMODE) && offered.includes("computer_request_handoff"), `codemode and the hand-over are offered: ${JSON.stringify(offered)}`);
  for (const name of [...COMPUTER, "computer_script"]) assert.ok(!offered.includes(name), `${name} is not offered: ${JSON.stringify(offered)}`);
  const result = lastResult(requests);
  assert.match(result.text, /1\. computer_act completed[^\n]*\n2\. computer_act completed[^\n]*\n3\. computer_act was started and did not report a result/, result.text);
  assert.deepEqual(computer.calls.map(([method]) => method).filter((method) => method !== "hello"), ["input.actions", "input.actions", "input.actions"], "each act reached the computer once: the rerun answered the first two from their records, and never sent the cut one again");
  const nested = nestedRows(await runTimeline(server, "run-1", ctx));
  assert.deepEqual(nested.filter((row) => row.kind === "tool_use").map((row) => row.tool_name), ["computer_act", "computer_act", "computer_act"], "each call on the timeline once, under the script");
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

// A vendor's desktop (Mode 1, no run folder mounted: no bash family at all) whose card has exec, files and apps.
const VENDOR = ["exec", "files", "apps"];

/** The run's journal entries. */
async function entriesOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx)).entries;
}

test("on a vendor's desktop (no run folder, no bash), a codemode script drives `computer`: a shell command, a file written and read back, the apps listed and one opened with a URL, each a nested call of its own that reaches the computer once", async (t) => {
  const { computer, run, tools } = await desktop({ more: VENDOR });
  const script = [
    "const ran = await computer.shell.run('echo hi');",
    "await computer.files.write('/workspace/notes.txt', 'Pears: 41');",
    "const read = await computer.files.read('/workspace/notes.txt');",
    "const apps = await computer.apps.list();",
    "await computer.apps.open('firefox', { url: 'https://example.com/' });",
    "return { exit: ran.exitCode, read, apps: apps.apps.map((app) => app.id) };",
  ].join("\n");
  const { requests, server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, () => "allow", undefined, { computer: run.computer });
  const result = lastResult(requests);
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /"exit":\s*0/, result.text);
  assert.match(result.text, /"read":\s*"Pears: 41"/, result.text);
  assert.match(result.text, /"apps":\s*\["xfce4-terminal"\]/, result.text);
  const methods = methodsOf(computer);
  for (const method of ["exec.run", "files.write", "apps.list", "apps.launch"]) assert.equal(methods.filter((one) => one === method).length, 1, `${method} once: ${JSON.stringify(methods)}`);
  assert.deepEqual(computer.calls.find(([method]) => method === "apps.launch")?.[1], { id: "firefox", url: "https://example.com/" });
  const nested = nestedRows(await runTimeline(server, "run-1", ctx)).filter((row) => row.kind === "tool_use");
  assert.deepEqual(nested.map((row) => row.tool_name), ["computer_op", "computer_op", "computer_op", "computer_op", "computer_op"], "each call of `computer` is a nested call of its own on the timeline");
  const offered = offeredTools(requests[0]);
  assert.ok(!offered.includes("computer_op"), `computer_op is bound for scripts alone, never listed: ${JSON.stringify(offered)}`);
  assert.ok(!offered.includes("computer_script"), JSON.stringify(offered));
});

test("on a vendor's desktop, a script cut by the runner's end after a shell command and a file write reruns with neither made again: each answered from its record", async (t) => {
  const { computer, run, tools } = await desktop({ more: VENDOR });
  let stuck;
  let bound;
  const reached = Promise.race([new Promise((resolve) => (stuck = resolve)), new Promise((_, reject) => (bound = setTimeout(() => reject(new Error("the script never reached its app's open within 30 s")), 30_000)))]).finally(() => clearTimeout(bound));
  // The app's open after the command and the write never answers on the first runner: it ends with the script waiting.
  computer.overrides["apps.launch"] = () => {
    stuck();
    return new Promise(() => {});
  };
  const script = "await computer.shell.run('touch /workspace/once');\nawait computer.files.write('/workspace/notes.txt', 'Pears: 41');\nawait computer.apps.open('firefox');\nreturn 'opened';";
  const { requests } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, () => "allow", reached, { computer: run.computer });
  const result = lastResult(requests);
  assert.match(result.text, /1\. computer_op completed[^\n]*\n2\. computer_op completed[^\n]*\n3\. computer_op was started and did not report a result/, result.text);
  const methods = methodsOf(computer);
  assert.equal(methods.filter((one) => one === "exec.run").length, 1, `the command ran once: ${JSON.stringify(methods)}`);
  assert.equal(methods.filter((one) => one === "files.write").length, 1, `the file was written once: ${JSON.stringify(methods)}`);
  assert.equal(methods.filter((one) => one === "apps.launch").length, 1, `the cut open was never sent again: ${JSON.stringify(methods)}`);
});

test("on a vendor's desktop, a script cut by the runner's end tells each call it made before the cut as it answered live, byte for byte: a command by its value, a file's write (no value) by its answer's words, never null", async (t) => {
  const said = { exitCode: 0, stdout: Buffer.from("shell-ok-7731\n").toString("base64"), stderr: "", timedOut: false, truncated: false };
  // Live: the command's value, as the script read it and returned it, and the write's answer, as its own row keeps it.
  const first = await desktop({ more: VENDOR });
  first.computer.overrides["exec.run"] = () => said;
  const { requests: live, server: liveServer } = await codemodeRun(t, [{ call: CODEMODE, args: { script: "const ran = await computer.shell.run('echo shell-ok-7731');\nawait computer.files.write('/workspace/notes.txt', 'Pears: 41');\nreturn ran;" } }, { say: "done" }], first.tools, () => "allow", undefined, { computer: first.run.computer });
  const value = lastResult(live).text;
  assert.match(value, /shell-ok-7731/, `the live value holds the command's output: ${value}`);
  const wrote = nestedRows(await runTimeline(liveServer, "run-1", ctx)).filter((row) => row.kind === "tool_result")[1]?.tool_result_preview;
  assert.equal(wrote, "wrote /workspace/notes.txt", "the write answered in words, live");
  // Cut: the same command and write, then an app's open the first runner never sees answered; the rerun tells both from
  // their records.
  const { computer, run, tools } = await desktop({ more: VENDOR });
  computer.overrides["exec.run"] = () => said;
  let stuck;
  let bound;
  const reached = Promise.race([new Promise((resolve) => (stuck = resolve)), new Promise((_, reject) => (bound = setTimeout(() => reject(new Error("the script never reached its app's open within 30 s")), 30_000)))]).finally(() => clearTimeout(bound));
  computer.overrides["apps.launch"] = () => {
    stuck();
    return new Promise(() => {});
  };
  const script = "const ran = await computer.shell.run('echo shell-ok-7731');\nawait computer.files.write('/workspace/notes.txt', 'Pears: 41');\nawait computer.apps.open('firefox');\nreturn ran;";
  const { requests } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, () => "allow", reached, { computer: run.computer });
  const result = lastResult(requests);
  const told = (n) => new RegExp(`^${n}\\. computer_op completed: (.*)\\. Its effect is done; it was not run again\\.$`, "m").exec(result.text)?.[1];
  assert.equal(told(1), value, `the recorded command is told with its live value: ${result.text}`);
  assert.equal(told(2), JSON.stringify(wrote), `the recorded write is told with its live answer: ${result.text}`);
  const methods = methodsOf(computer);
  assert.equal(methods.filter((one) => one === "exec.run").length, 1, "the command ran once");
  assert.equal(methods.filter((one) => one === "files.write").length, 1, "the file was written once");
});

test("on a vendor's desktop whose agent's bash is set to ask, a script's computer.shell.run parks the run on a person's answer, asked about as bash, and nothing runs on the computer", async (t) => {
  const { computer, run, tools } = await desktop({ more: VENDOR });
  const { runners } = await stores({ runners: 1 });
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-gate-"));
  dirs.push(folder);
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { bash: { permission: "ask" } } } }, folder, "none");
  const script = "await computer.shell.run('echo hi');\nreturn 'ran';";
  const { server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, gate, undefined, { computer: run.computer, settled: "parked" });
  const ask = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask")?.data;
  assert.equal(ask?.tool, "bash", `asked about as bash: ${JSON.stringify(ask)}`);
  assert.match(JSON.stringify(ask?.args), /echo hi/, "the card shows the command");
  assert.deepEqual(methodsOf(computer).filter((method) => method === "exec.run"), [], "nothing ran on the computer");
});

test("a script's computer.shell.run a person allowed carries its computer calls on one row, the call's own result row, as a call that never waited does: never on its approval row or its outcome row too", async (t) => {
  const { computer, run, tools } = await desktop({ more: VENDOR });
  const { runners } = await stores({ runners: 1 });
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-gate-"));
  dirs.push(folder);
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { bash: { permission: "ask" } } } }, folder, "none");
  const script = "await computer.shell.run('echo hi');\nreturn 'ran';";
  const { server } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, gate, undefined, { computer: run.computer, settled: "parked" });
  const ask = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask")?.data;
  assert.equal(ask?.tool, "bash", JSON.stringify(ask));
  await sendCommand(server, "run-1", { kind: "approve", body: { approval: ask.callId } });
  await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended once allowed", 30_000);
  assert.equal(methodsOf(computer).filter((method) => method === "exec.run").length, 1, "the allowed command ran once");
  const rows = await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, server, "run-1", ctx);
  const carrying = rows.filter((row) => row.computer_calls?.some((call) => call.method === "exec.run"));
  assert.deepEqual(carrying.map((row) => [row.kind, row.tool_use_id]), [["tool_result", ask.callId]], `the command's computer calls on its own result row alone: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_use_id, row.summary, row.computer_calls?.length]))}`);
  // Its approval and what came of it still read as before.
  assert.ok(rows.some((row) => row.kind === "tool_approval_requested" && row.tool_use_id === ask.callId), "the approval row is there");
  assert.ok(rows.some((row) => row.kind === "phase" && /^AgentRun: bash ran once you allowed it/.test(row.summary ?? "")), "the outcome row is there");
});

test("on a vendor's desktop whose agent's write is set to deny, a script's computer.files.write is refused in the gate's words and ends the script; nothing is written", async (t) => {
  const { computer, run, tools } = await desktop({ more: VENDOR });
  const { runners } = await stores({ runners: 1 });
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-gate-"));
  dirs.push(folder);
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { write: { permission: "deny" } } } }, folder, "none");
  const script = "const apps = await computer.apps.list();\nawait computer.files.write('/workspace/notes.txt', 'Pears: 41');\nreturn 'wrote';";
  const { requests } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, gate, undefined, { computer: run.computer });
  const result = lastResult(requests);
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, /write/, result.text);
  assert.match(result.text, /1\. computer_op completed/, `the call before it ran: ${result.text}`);
  assert.doesNotMatch(result.text, /wrote"/);
  assert.deepEqual(methodsOf(computer).filter((method) => method === "files.write"), [], "nothing was written");
});

test("codemode's description declares `computer` for the run's desktop, with only the namespaces its card offers; a script on an agent whose exec is off is told so when it reaches for computer.shell", async (t) => {
  const { computer, run, tools } = await desktop({ more: VENDOR, exec: false });
  const script = "try { await computer.shell.run('id'); return 'ran'; } catch (error) { return error.message; }";
  const { requests } = await codemodeRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], tools, () => "allow", undefined, { computer: run.computer });
  const described = (requests[0].tools ?? []).find((tool) => tool.name === CODEMODE)?.description ?? "";
  assert.match(described, /declare const computer: Computer;/, described);
  assert.match(described, /files: /, "the card's files namespace is declared");
  assert.doesNotMatch(described, /shell: /, "no shell on an agent whose exec is off");
  const result = lastResult(requests);
  assert.match(result.text, /this agent's computer runs no programs: its exec setting is off/, result.text);
  assert.deepEqual(methodsOf(computer).filter((method) => method === "exec.run"), [], "nothing ran on the computer");
});

test("on Codex, whose own code mode reaches only the tools it is handed, a desktop run lists computer_op (and under surface code the step tools), and the host offers no codemode beside Codex's own", async (t) => {
  const { fauxAdapter } = await import("@parcha/agentrun-kernel/testing");
  for (const surface of [undefined, "code"]) {
    const { run, tools } = await desktop({ more: VENDOR, ...(surface ? { surface } : {}) });
    let handed;
    const faux = fauxAdapter({ script: (spec) => ((handed ??= spec.tools.map((tool) => ({ name: tool.name, deferred: tool.deferred === true }))), [{ say: "done" }]) });
    // The faux harness under Codex's id: the loop reads Codex's facts (ownCodemode) by the adapter's id.
    const codex = Object.defineProperty(Object.create(faux), "id", { value: "codex" });
    await codemodeRun(t, [], tools, () => "allow", undefined, { computer: run.computer, adapter: codex });
    const label = `surface ${surface}`;
    const names = handed.map((tool) => tool.name);
    assert.ok(!names.includes(CODEMODE), `${label}: no host codemode beside Codex's own: ${JSON.stringify(names)}`);
    assert.ok(!names.includes("computer_script"), `${label}: ${JSON.stringify(names)}`);
    for (const name of ["computer_op", "computer_act", "computer_screenshot"]) assert.ok(handed.some((tool) => tool.name === name && !tool.deferred), `${label}: ${name} listed: ${JSON.stringify(handed)}`);
  }
});

/** A Responses origin for Codex's stand-in (FAKE_CODEX_MODEL=responses): its first answer is one code-mode `exec` whose
 *  script (the stand-in's: a JSON list of host tool calls) is `calls`; every later one says done. */
function codexScript(calls) {
  const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  const usage = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } };
  return async (_url, init = {}) => {
    const input = JSON.parse(String(init.body ?? "{}")).input ?? [];
    const done = (n) => ({ type: "response.completed", response: { id: `resp_${n}`, object: "response", status: "completed", usage } });
    if (!input.some((item) => item.type === "custom_tool_call")) {
      const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_exec", name: "exec", input: JSON.stringify(calls), status: "completed" };
      return sse([{ type: "response.output_item.done", output_index: 0, item }, done(1)]);
    }
    return sse([{ type: "response.output_text.delta", item_id: "m_2", output_index: 0, content_index: 0, delta: "done" }, done(2)]);
  };
}

/** A desktop run on Codex (its stand-in app server) whose one code-mode `exec` runs `calls` (codexScript): its computer and
 *  the server's store. `options.gate`, `options.settled`, `options.restartAt` and `options.beforeNext` as codemodeRun takes them;
 *  `options.computer(computer)` sets the desktop up before the run starts. */
async function codexRun(t, calls, options = {}) {
  const { resolveHarness } = await import("../dist/runner/adapters/index.js");
  const standIn = new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url).pathname;
  const saved = process.env.AGENTRUN_CODEX_STANDIN;
  process.env.AGENTRUN_CODEX_STANDIN = "1";
  t.after(() => (saved === undefined ? delete process.env.AGENTRUN_CODEX_STANDIN : (process.env.AGENTRUN_CODEX_STANDIN = saved)));
  const sessionsDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-codex-"));
  dirs.push(sessionsDir);
  const { computer, run, tools } = await desktop({ more: VENDOR });
  options.computer?.(computer);
  const harness = resolveHarness("codex");
  const fetch = codexScript(calls);
  const adapterOf = (run_) => harness.adapter({ run: run_, model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "not-a-secret" }, price: () => 0, sessionsDir, fetch }, { standIn: { command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "responses" } } });
  const { server } = await codemodeRun(t, [], tools, options.gate ?? (() => "allow"), options.restartAt, { computer: run.computer, adapterOf, record: harness.record, ...(options.settled ? { settled: options.settled } : {}), ...(options.beforeNext ? { beforeNext: options.beforeNext } : {}) });
  return { computer, server };
}

/** Each row of `rows` as [kind, tool, id, parent, status]: what a failed check shows. */
const rowsSeen = (rows) => JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.tool_use_id, row.parent_tool_use_id, row.tool_status]));

test("on Codex, a script's computer_op calls sit under the script's own call on the timeline as on every other harness: the exec has its own rows, and each nested row names it as its parent", async (t) => {
  const { computer, server } = await codexRun(t, [{ tool: "computer_op", args: { op: "apps.list", args: {} } }, { tool: "computer_op", args: { op: "files.write", args: { path: "/workspace/notes.txt", data: "Pears: 41" } } }]);
  assert.deepEqual(methodsOf(computer).filter((method) => method === "apps.list" || method === "files.write"), ["apps.list", "files.write"], "each call reached the computer once");
  const rows = await runTimeline(server, "run-1", ctx);
  const seen = JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.tool_use_id, row.parent_tool_use_id]));
  const outer = rows.find((row) => row.kind === "tool_use" && row.tool_name === "exec");
  assert.ok(outer, `the script's own call has its row: ${seen}`);
  assert.equal(outer.tool_use_id, "call_exec", `under the model's own id for its exec: ${seen}`);
  assert.equal(outer.parent_tool_use_id, undefined, "the script's own call is the model's: no parent");
  assert.equal(outer.tool_input_preview, null, "the script's row shows no script: it can hold what an act types");
  assert.ok(rows.some((row) => row.kind === "tool_result" && row.tool_use_id === "call_exec"), `the script's own call has its result row: ${seen}`);
  const nested = rows.filter((row) => (row.kind === "tool_use" || row.kind === "tool_result") && row.tool_name === "computer_op");
  assert.equal(nested.length, 4, seen);
  assert.deepEqual(nested.map((row) => [row.kind, row.parent_tool_use_id]), [["tool_use", "call_exec"], ["tool_result", "call_exec"], ["tool_use", "call_exec"], ["tool_result", "call_exec"]], `every nested row names the script's call: ${seen}`);
  assert.ok(rows.indexOf(outer) < rows.indexOf(nested[0]), `the script's row comes first: ${seen}`);
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "call_exec");
  assert.equal(result.tool_status, "success", `a script that ended well reads ok: ${result.summary}`);
});

/** Each nested call's answer as Codex's code mode handed it to the script: its rollout's DynamicToolCall completions (the
 *  rollout as the session's journal mirrors it, `rollout:<threadId>`), each with its arguments and content items. */
async function codexAnswers(server) {
  const streams = (await entriesOf(server)).filter((entry) => entry.kind === "kernel.start" && entry.data?.name === "journal").map((entry) => entry.data.input?.streams ?? {});
  const lines = streams.flatMap((all) => Object.entries(all).filter(([name]) => name.startsWith("rollout:")).flatMap(([, held]) => held.entries.map((entry) => entry.data)));
  return lines.map((line) => JSON.parse(line)).filter((line) => line.type === "event_msg" && line.payload?.item?.type === "DynamicToolCall").map((line) => line.payload.item);
}

test("on Codex, a computer_op answers its script one text item: an op that ran is JSON (shell.run's has exitCode), and a refused one is the gate's words, opening as the kind skills say", async (t) => {
  const { runners } = await stores({ runners: 1 });
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-codex-shape-"));
  dirs.push(folder);
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { bash: { permission: "allow" }, write: { permission: "deny" } } } }, folder, "none");
  const { server } = await codexRun(t, [{ tool: "computer_op", args: { op: "shell.run", args: { command: "echo hi" } } }, { tool: "computer_op", args: { op: "files.write", args: { path: "/workspace/notes.txt", data: "Pears: 41" } } }], { gate });
  const answers = await codexAnswers(server);
  const ran = answers.find((one) => one.arguments?.op === "shell.run");
  const refused = answers.find((one) => one.arguments?.op === "files.write");
  assert.ok(ran && refused, `both calls were answered: ${JSON.stringify(answers)}`);
  for (const one of [ran, refused]) assert.deepEqual(one.content_items.map((item) => item.type), ["inputText"], `one text item: ${JSON.stringify(one)}`);
  const value = JSON.parse(ran.content_items[0].text);
  assert.equal(value.exitCode, 0, `shell.run's answer parses as JSON with its exit code: ${ran.content_items[0].text}`);
  const words = refused.content_items[0].text;
  assert.ok(words.startsWith(DENIED_OPENING), `a refused op's answer opens with the gate's words: ${words}`);
  assert.throws(() => JSON.parse(words), "a refused op's answer is words, never JSON");
  // Its row names the op it refused, never the tool's name alone, nor what it would have written.
  const rows = await runTimeline(server, "run-1", ctx);
  const row = rows.find((one) => one.kind === "tool_result" && one.tool_name === "computer_op" && one.tool_status === "failed");
  assert.match(row?.summary ?? "", /^Refused: files\.write: Permission denied: /, rowsSeen(rows));
  // The kind skills name every opening a refused op's answer starts with, from the one copy the gate writes them from.
  for (const kind of ["desktop", "phone"]) {
    const skill = readFileSync(new URL(`../src/workspace/kind-skills/${kind}/SKILL.md`, import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const opening of REFUSAL_OPENINGS) assert.ok(skill.includes(`\`${opening.trim()}\``), `the ${kind} skill names "${opening.trim()}"`);
  }
});

test("on Codex, a script that failed reads failed on its exec's result row, as a failed script's row does on every other harness, never ok", async (t) => {
  const { computer, server } = await codexRun(t, [{ tool: "computer_op", args: { op: "apps.list", args: {} } }, { throw: "pears is not defined" }]);
  assert.deepEqual(methodsOf(computer).filter((method) => method === "apps.list"), ["apps.list"], "the call before the error reached the computer");
  const rows = await runTimeline(server, "run-1", ctx);
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "call_exec");
  assert.ok(result, `the exec has its result row: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.tool_use_id]))}`);
  assert.equal(result.tool_status, "failed", `a failed script's row says so: ${result.summary}`);
  assert.match(result.summary, /^Using tool: exec failed: /, "its summary says it failed");
  assert.match(result.tool_result_preview ?? "", /pears is not defined/, "and its result says why");
  const nested = rows.find((row) => row.kind === "tool_result" && row.tool_name === "computer_op");
  assert.equal(nested?.tool_status, "success", "the call that ran before the error still reads ok");
});

test("on Codex, a script whose shell.run parked on a person's approval and ran once allowed: the exec ends after its call's rows, read as stopped and resumed, never failed, as a codemode script that parked reads on pi", async (t) => {
  const { runners } = await stores({ runners: 1 });
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-codex-gate-"));
  dirs.push(folder);
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { bash: { permission: "ask" } } } }, folder, "none");
  const { computer, server } = await codexRun(t, [{ tool: "computer_op", args: { op: "shell.run", args: { command: "echo hi" } } }], { gate, settled: "parked" });
  const ask = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask")?.data;
  assert.equal(ask?.tool, "bash", JSON.stringify(ask));
  await sendCommand(server, "run-1", { kind: "approve", body: { approval: ask.callId } });
  await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended once allowed", 30_000);
  assert.equal(methodsOf(computer).filter((method) => method === "exec.run").length, 1, "the allowed command ran once");
  const rows = await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, server, "run-1", ctx);
  const seen = rowsSeen(rows);
  const ends = rows.filter((row) => row.kind === "tool_result" && row.tool_use_id === "call_exec");
  assert.equal(ends.length, 1, `the exec has one end: ${seen}`);
  const [end] = ends;
  const under = rows.filter((row) => row.parent_tool_use_id === "call_exec");
  assert.ok(under.some((row) => row.kind === "tool_result" && row.tool_use_id === ask.callId), `the allowed call has its result row under the exec: ${seen}`);
  assert.ok(under.every((row) => rows.indexOf(row) < rows.indexOf(end)), `the exec's end sorts after every row of its calls: ${seen}`);
  assert.equal(end.tool_status, "success", `parked, then resumed with its call's answer, the exec did not fail: ${end.summary}`);
  assert.match(end.tool_result_preview ?? "", /waited for a person's approval, then ran/, `its end tells what the model was told: ${end.tool_result_preview}`);
});

test("on Codex, a script cut by the runner's end mid-call: the call cut off ends interrupted and the exec ends after it, told what its calls came to, failed as a codemode script cut there reads on pi", async (t) => {
  let stuck;
  let bound;
  const reached = Promise.race([new Promise((resolve) => (stuck = resolve)), new Promise((_, reject) => (bound = setTimeout(() => reject(new Error("the script never reached its app's open within 30 s")), 30_000)))]).finally(() => clearTimeout(bound));
  const hang = (computer) => {
    computer.overrides["apps.launch"] = () => {
      stuck();
      return new Promise(() => {});
    };
  };
  const { computer, server } = await codexRun(t, [{ tool: "computer_op", args: { op: "apps.open", args: { id: "firefox" } } }], { restartAt: reached, computer: hang });
  assert.equal(methodsOf(computer).filter((method) => method === "apps.launch").length, 1, "the cut open was never sent again");
  const rows = await runTimeline(server, "run-1", ctx);
  const seen = rowsSeen(rows);
  const ends = rows.filter((row) => row.kind === "tool_result" && row.tool_use_id === "call_exec");
  assert.equal(ends.length, 1, `the exec has one end: ${seen}`);
  const [end] = ends;
  const cut = rows.find((row) => row.kind === "tool_result" && row.tool_name === "computer_op");
  assert.ok(cut, `the cut call has its end: ${seen}`);
  assert.equal(cut.parent_tool_use_id, "call_exec", seen);
  assert.equal(cut.tool_result_preview, INTERRUPTED_TEXT, `the cut call reads interrupted: ${cut.summary}`);
  assert.ok(rows.indexOf(cut) < rows.indexOf(end), `the exec's end sorts after its call's end: ${seen}`);
  assert.equal(end.tool_status, "failed", `cut at a call that never reported, the exec reads failed: ${end.summary}`);
  assert.match(end.tool_result_preview ?? "", /^The exec was cut short after these calls/, `its end tells what the model was told: ${end.tool_result_preview}`);
});

/** The exec's one end on `rows` and the rows of its calls: each of them before it, and it read interrupted in the words
 *  every harness gives a call cut off. */
function endedInterruptedAfterCalls(rows) {
  const seen = rowsSeen(rows);
  const ends = rows.filter((row) => row.kind === "tool_result" && row.tool_use_id === "call_exec");
  assert.equal(ends.length, 1, `the exec has one end, never left open: ${seen}`);
  const [end] = ends;
  const under = rows.filter((row) => row.parent_tool_use_id === "call_exec");
  assert.ok(under.length > 0, `its calls have rows: ${seen}`);
  assert.ok(under.every((row) => rows.indexOf(row) < rows.indexOf(end)), `the exec's end sorts after every row of its calls: ${seen}`);
  assert.equal(end.tool_result_preview, INTERRUPTED_TEXT, `the exec reads interrupted: ${end.summary}`);
}

test("on Codex, a run stopped while its exec's call waits for a person's approval: the run's end closes the exec interrupted, after its call's rows, never left open", async (t) => {
  const { runners } = await stores({ runners: 1 });
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codemode-computer-codex-stop-"));
  dirs.push(folder);
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { bash: { permission: "ask" } } } }, folder, "none");
  const { computer, server } = await codexRun(t, [{ tool: "computer_op", args: { op: "shell.run", args: { command: "echo hi" } } }], { gate, settled: "parked" });
  await sendCommand(server, "run-1", { kind: "stop" });
  await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "stopped" && now.runner === null && now;
  }, "the run stopped", 30_000);
  assert.equal(methodsOf(computer).filter((method) => method === "exec.run").length, 0, "the waiting command never ran");
  endedInterruptedAfterCalls(await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, server, "run-1", ctx));
});

test("on Codex, a run a crash cut mid-call and the next claim ends without resuming Codex's thread (stopped meanwhile): the exec is closed interrupted, after its cut call's rows, never left open", async (t) => {
  let stuck;
  let bound;
  const reached = Promise.race([new Promise((resolve) => (stuck = resolve)), new Promise((_, reject) => (bound = setTimeout(() => reject(new Error("the script never reached its app's open within 30 s")), 30_000)))]).finally(() => clearTimeout(bound));
  const hang = (computer) => {
    computer.overrides["apps.launch"] = () => {
      stuck();
      return new Promise(() => {});
    };
  };
  const stop = (server) => sendCommand(server, "run-1", { kind: "stop" });
  const { server } = await codexRun(t, [{ tool: "computer_op", args: { op: "apps.open", args: { id: "firefox" } } }], { restartAt: reached, computer: hang, beforeNext: stop, settled: "stopped" });
  endedInterruptedAfterCalls(await runTimeline(server, "run-1", ctx));
});

test("a desktop run whose codemode is set to deny, under surface code too, lists the step tools and computer_op: with no script to call them, the computer stays in the model's reach", async (t) => {
  const { fauxAdapter } = await import("@parcha/agentrun-kernel/testing");
  for (const surface of [undefined, "code"]) {
    const { run, tools } = await desktop({ more: VENDOR, ...(surface ? { surface } : {}) });
    let handed;
    const faux = fauxAdapter({ script: (spec) => ((handed ??= spec.tools.map((tool) => ({ name: tool.name, deferred: tool.deferred === true }))), [{ say: "done" }]) });
    const gate = Object.assign(() => "allow", { permission: async (name) => (name === CODEMODE ? "deny" : "allow") });
    await codemodeRun(t, [], tools, gate, undefined, { computer: run.computer, adapter: faux });
    const label = `surface ${surface}`;
    assert.ok(!handed.some((tool) => tool.name === CODEMODE), `${label}: codemode set to deny is not offered: ${JSON.stringify(handed)}`);
    for (const name of ["computer_op", "computer_act", "computer_screenshot"]) assert.ok(handed.some((tool) => tool.name === name && !tool.deferred), `${label}: ${name} listed: ${JSON.stringify(handed)}`);
  }
});
