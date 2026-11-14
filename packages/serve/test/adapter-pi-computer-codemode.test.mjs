// pi's code mode with a desktop (runner/adapters/pi-computer.ts): pi-durable's `codemode` tool is offered beside the
// session's own tools (code mode "on", not "only"), and its script has `computer` bound as computer_script's has, on the
// run's port: the script's computer calls reach the computer, and its returned value reaches the model in the tool's
// result. The `codemode` call is held to the kind's setting (tool-gate.ts), so a deny on desktop refuses the script
// whole. The model is a scripted Anthropic origin and the computer a loopback fake: nothing leaves this process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSurface } from "@parcha/agentrun-computer/surface";
import { closeOpenSessions, hostTools, MODEL, offeredTools, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { computerCodemode, PI_CODEMODE_TOOL } = await import("../dist/runner/adapters/pi-computer.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { portOf, ScriptGuard, scriptPreludeOf } = await import("../dist/workspace/index.js");
/** A script guard whose gate allows every call: these tests are about code mode, not the run's tool settings. */
const allowAll = () => {
  const guard = new ScriptGuard();
  guard.install(async () => "allow");
  return guard;
};
const { deniedText, settingsKeyOf } = await import("../dist/tool-gate.js");
const { recordedClient } = await import("../dist/computer-calls.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const GROUPS = ["screen", "input.pointer", "input.keys"];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const dirs = [];
after(async () => {
  await closeOpenSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A loopback desktop with the screen and raw input (and with `ui`, ui.observe and ui.act on one TextEdit window): its
 *  screen.shot answers a 1280-wide PNG; every call is recorded. Its client is the run's as the claim wraps it
 *  (resolve-computer.ts runComputerOf: recordedClient). */
async function desktop({ ui = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pi-codemode-"));
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
  const groups = ui ? [...GROUPS, "ui"] : GROUPS;
  const surface = createSurface(recordedClient(computer.client), { protocol: "0.2", version: "0", os: "linux", kind: "desktop", arch: "amd64", groups });
  return { computer, script: { card: surface.card, port: portOf(surface), guard: allowAll(), prelude: scriptPreludeOf(surface.card), declare: false } };
}

/** A pi run of `script` with code mode on `computer`, its gate `gate(call)`: the request bodies the provider got, and the
 *  server's store. With `restartAt`, the first runner shuts down once it settles and a second one takes the run on. */
async function codemodeRun(t, script, computer, gate = () => "allow", restartAt = undefined) {
  const { server, runners: stores_ } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const { tools } = suiteTools();
  const requests = [];
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => 0, extensions: [computerCodemode(computer)] }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks: quiet,
    gate,
  }));
  const runner = startRunner({ store: stores_[0], createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  if (restartAt) {
    await restartAt;
    // A shutdown mid-script: the claim lets the run go, its codemode call's task unsettled in its journal.
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

test("code mode is on beside the session's tools, and its script drives the computer through `computer`, its value in the result", async (t) => {
  const { computer, script } = await desktop();
  const code = "const shot = await computer.screen.shot();\nawait computer.input.act([{ type: 'click', at: [10, 10] }]);\nreturn { width: shot.width, app: typeof computer.app };";
  const { requests } = await codemodeRun(t, [{ call: PI_CODEMODE_TOOL, args: { code } }, { say: "done" }], script);
  const offered = offeredTools(requests[0]);
  assert.ok(offered.includes(PI_CODEMODE_TOOL), `code mode is offered: ${JSON.stringify(offered)}`);
  assert.ok(offered.includes("read"), `the session's own tools stay offered (on, not only): ${JSON.stringify(offered)}`);
  const system = JSON.stringify(requests[0].system ?? "");
  assert.match(system, /Tools scripts can call/, "the codemode section is there");
  assert.doesNotMatch(system, /### `/, `no tool is declared twice: the codemode section lists none of the offered tools: ${system.slice(0, 400)}`);
  const result = lastResult(requests);
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /"width":\s*1280/, `the script's value reached the model: ${result.text}`);
  assert.match(result.text, /"app":\s*"undefined"/, "no ui group: no app()");
  const methods = computer.calls.map(([method]) => method);
  assert.ok(methods.includes("screen.shot") && methods.includes("input.actions"), `the script's calls reached the computer: ${JSON.stringify(methods)}`);
});

test("a script's computer calls are on its codemode call's result row, as a direct tool call's are: each with its start time, the app, and each step's element and chord, never what it typed", async (t) => {
  const { computer, script } = await desktop({ ui: true });
  const code = [
    "const app = computer.app('com.apple.TextEdit');",
    "await app.observe();",
    "await app.act([{ key: 'super+a' }, { type: 'Pears: 42 typed-words-stay-out', into: '@e1' }, { key: 'x' }]);",
    "await app.act([{ press: '@e2' }]);",
    "return 'saved';",
  ].join("\n");
  const before = Date.now();
  const { requests, server } = await codemodeRun(t, [{ call: PI_CODEMODE_TOOL, args: { code } }, { say: "done" }], script);
  assert.equal(lastResult(requests).isError, false, lastResult(requests).text);
  assert.deepEqual(computer.calls.map(([method]) => method), ["ui.observe", "ui.act", "ui.act"], "the script's calls reached the computer");
  const rows = await runTimeline(server, "run-1", BACKGROUND_CONTEXT);
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === PI_CODEMODE_TOOL);
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === PI_CODEMODE_TOOL);
  assert.ok(call && result, `the codemode call and its result are on the timeline: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_name]))}`);
  assert.ok(result.computer_calls, `the codemode result row carries computer_calls: ${JSON.stringify(result)}`);
  const times = result.computer_calls.map((one) => Date.parse(one.started_at));
  assert.ok(times.every((at, i) => at >= before && at <= Date.parse(result.timestamp) && (i === 0 || at >= times[i - 1])), `each call's own start time, in order, inside the run: ${JSON.stringify(result.computer_calls.map((one) => one.started_at))}`);
  assert.deepEqual(result.computer_calls.map(({ ms, started_at, ...rest }) => (assert.equal(typeof ms, "number"), rest)), [
    { method: "ui.observe", app: "com.apple.TextEdit", ok: true },
    { method: "ui.act", app: "com.apple.TextEdit", ok: true, steps: [
      { do: "key", keys: "super+a", route: "semantic", verified: true },
      { do: "type", on: { role: "textbox", name: "Pears: 41" }, route: "semantic", verified: true },
      { do: "key", route: "semantic", verified: true },
    ] },
    { method: "ui.act", app: "com.apple.TextEdit", ok: true, steps: [{ do: "press", on: { role: "button", name: "Save" }, route: "semantic", verified: true }] },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /typed-words-stay-out|"x"/, "no typed text and no lone key on the row");
});

test("code mode is held to the computer kind's setting: a deny on desktop refuses the script whole, and the computer is never called", async (t) => {
  assert.equal(settingsKeyOf("pi", PI_CODEMODE_TOOL), "desktop", "codemode is read as the kind's tools are");
  const { computer, script } = await desktop();
  const before = computer.calls.length;
  const { requests } = await codemodeRun(t, [{ call: PI_CODEMODE_TOOL, args: { code: "return (await computer.screen.shot()).width;" } }, { say: "done" }], script, (call) => (call.tool === PI_CODEMODE_TOOL ? "deny" : "allow"));
  const result = lastResult(requests);
  assert.equal(result.isError, true);
  assert.equal(result.text, deniedText(PI_CODEMODE_TOOL), "refused in the gate's words, before the script ran");
  assert.equal(computer.calls.length, before, "nothing reached the computer");
});

test("a code-mode script replayed after a restart: a replayed call is not made again nor recorded twice; the row holds the calls the rerun made (the shutdown sealed the journal before the cut attempt's record)", async (t) => {
  const { computer, script } = await desktop();
  const before = computer.calls.length;
  // The first click never answers on the first runner: it shuts down with the script waiting on it.
  let stuck;
  const reached = new Promise((resolve) => (stuck = resolve));
  let clicks = 0;
  computer.overrides["input.actions"] = ({ actions }) => {
    clicks += 1;
    if (clicks === 1) {
      stuck();
      return new Promise(() => {});
    }
    return { done: actions.length };
  };
  const code = "await computer.screen.shot();\nawait computer.input.act([{ type: 'click', at: [10, 10] }]);\nreturn (await computer.screen.shot()).width;";
  const { requests, server } = await codemodeRun(t, [{ call: PI_CODEMODE_TOOL, args: { code } }, { say: "done" }], script, () => "allow", reached);
  assert.equal(lastResult(requests).isError, false, lastResult(requests).text);
  const rows = await runTimeline(server, "run-1", BACKGROUND_CONTEXT);
  const made = computer.calls.slice(before).map(([method]) => method);
  assert.deepEqual(made, ["screen.shot", "input.actions", "input.actions", "screen.shot"], "the replay never shot the screen again: its first shot's result was handed back");
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === PI_CODEMODE_TOOL);
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === call?.tool_use_id);
  assert.ok(result, `its result row: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_name]))}`);
  assert.deepEqual((result.computer_calls ?? []).map((one) => [one.method, one.ok]), [["input.actions", true], ["screen.shot", true]], `the rerun's calls, once each; the replayed shot not again: ${JSON.stringify(result.computer_calls)}`);
  assert.equal(rows.filter((row) => row.computer_calls).length, 1, "on that row only");
});

test("a code-only computer (no computer_script listed to declare `computer`): the codemode tool's own description declares it, as computer_script's would; with computer_script listed it declares nothing twice", async () => {
  const { computerDeclarations } = await import("@parcha/agentrun-kernel/kernel");
  const { script } = await desktop();
  const description = (given) => computerCodemode(given).tools.find((tool) => tool.name === PI_CODEMODE_TOOL).description;
  const declared = description({ ...script, declare: true });
  assert.ok(declared.includes(computerDeclarations(GROUPS)), `the computer's declarations for its groups: ${declared.slice(-400)}`);
  assert.ok(!description(script).includes(computerDeclarations(GROUPS)), "beside computer_script, which declares it once");
});
