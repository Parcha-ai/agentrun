// A run's tools by its computer's kind (serve/src/workspace/run-tools.ts runTools, computer-ports.ts): the run folder
// is attached only when the kind has files and exec AND the provider mounts it (a sandbox always; a desktop when its
// provider mounts); otherwise it stays the no-computer Workspace with no computer's shell: none in Mode 1 (the folder is
// one of this server's own: no bash family), Archil's exec in Mode 2 ("local", bash only). A desktop or a phone adds the
// computer's tools on top, over its one surface: computer_observe and computer_act on the ui group (ui.observe, ui.act),
// or on the screen and raw input without it; computer_screenshot; computer_op (a codemode script's `computer` reaches
// the computer's shell, files, apps and raw input through it); the hand-over. A browser brings none (the run's browser
// tool drives it). Every computer here is a loopback fake: nothing leaves this process.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { bindComputer } from "@parcha/agentrun-computer/surface";
import { COMPUTER_TOOLS, NO_SHELL } from "@parcha/agentrun-kernel/kernel";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computerMcp, localWorkspace, runTools } from "../dist/workspace/index.js";
import { heldAs } from "../dist/tool-gate.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-computer-tools-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}
const call = (tools, name, args) => tools.find((tool) => tool.name === name).call(args, { callId: `c-${name}-${Math.random()}`, signal: new AbortController().signal });
const names = (run) => run.registry.list().map((def) => def.name);
/** A call of computer_op: the computer's op `op` with `args`, as a script's `computer` makes it. */
const op = (tools, name, args = {}) => call(tools, "computer_op", { op: name, args });
/** A script's `computer` over the run's tools, as codemode binds it (runner/meta-tools.ts scriptComputer): observe, act
 *  and screenshot by their own tools, every other op by computer_op, each answering its value or throwing its words. */
const STEP_TOOLS = { observe: "computer_observe", act: "computer_act", screenshot: "computer_screenshot" };
function scriptComputer(run, tools) {
  const via = async (op, args) => {
    const answer = STEP_TOOLS[op] ? await call(tools, STEP_TOOLS[op], args) : await call(tools, "computer_op", { op, args });
    if (answer.isError) throw new Error(answer.text);
    return answer.structured;
  };
  return bindComputer(via, run.computer.card);
}

/** The file tools alone: no computer's shell in Mode 1. */
const FILES = ["read", "write", "edit"];
/** With Archil's exec (Mode 2, no computer's shell): bash only. */
const LOCAL = [...FILES, "bash"];
const COMPUTER = [...LOCAL, "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];
/** The computer's tools, a desktop's and a phone's alike. */
const TOOLS = [...COMPUTER_TOOLS];
const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
const PHONE_GROUPS = ["screen", "input.touch", "apps"];
/** The hello a desktop or a phone answered when the claim connected it, offering `groups`. */
const helloOf = (kind, groups) => ({ protocol: "0.2", version: "0", os: kind === "phone" ? "android" : "linux", kind: kind === "phone" ? "android" : "desktop", arch: "amd64", groups });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A loopback computer: computerd's screen.shot answers the PNG in two pieces (the rest by screen.read), input.actions
 *  runs every action, apps.list and apps.launch answer; with `ui`, ui.observe answers a Notes window and ui.act runs its
 *  steps. */
function fakeScreen(root, { ui = false } = {}) {
  const computer = fakeComputer(root);
  const half = Math.floor(PNG.length / 2);
  computer.overrides["screen.shot"] = () => ({ id: "s1", size: PNG.length, data: PNG.subarray(0, half).toString("base64"), eof: false, width: 1280, height: 800, scale: 1 });
  computer.overrides["screen.read"] = ({ offset }) => ({ data: PNG.subarray(offset).toString("base64"), eof: true });
  computer.overrides["input.actions"] = ({ actions }) => ({ done: actions.length });
  computer.overrides["apps.list"] = () => ({ apps: [{ id: "com.example.notes", name: "Notes" }], foreground: "com.example.notes" });
  computer.overrides["apps.launch"] = () => ({});
  if (ui) {
    computer.overrides["ui.observe"] = () => ({
      state: "s1",
      app: { id: "com.example.notes", name: "Notes" },
      window: { id: "w1", title: "Untitled", bounds: [0, 0, 400, 300] },
      nodes: [
        { ref: "@e1", role: "window", name: "Untitled", bounds: [0, 0, 400, 300] },
        { ref: "@e2", role: "textbox", name: "Title", value: "", bounds: [10, 10, 380, 30], parent: "@e1", flags: ["focused"] },
        { ref: "@e3", role: "button", name: "Save", bounds: [300, 250, 80, 30], parent: "@e1", actions: ["press"] },
      ],
      truncated: false,
    });
    computer.overrides["ui.act"] = ({ steps }) => ({ steps: steps.map(() => ({ route: "semantic", verified: true })), state: "s2", changed: true });
  }
  return computer;
}

test("a desktop whose provider does not mount, in Mode 1: the run folder stays the runner's with no shell, and the computer's tools come on top, on its screen and raw input (no ui group)", async () => {
  const root = scratch();
  const computer = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS) }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), [...FILES, ...TOOLS]);
  assert.deepEqual(run.kindTools, TOOLS);
  assert.equal(run.hands.processes, undefined, "no background processes on an unmounted desktop");
  const tools = run.hostTools(["bash", ...TOOLS]);
  assert.ok(!tools.some((tool) => tool.name === "bash"), "bash is not bound, granted or not");
  assert.equal((await run.registry.invoke("bash", { command: "touch ran" }, { hands: run.hands })).error, NO_SHELL, "a call of it anyway says how to get a shell");
  assert.ok(!existsSync(join(root, "ran")), "and runs nothing");
  const shot = await call(tools, "computer_screenshot", {});
  assert.deepEqual(shot, {
    text: "screenshot 1280×800 px", isError: false,
    images: [{ type: "image", mimeType: "image/png", data: PNG.toString("base64"), width: 1280, height: 800 }],
    structured: { type: "image", mimeType: "image/png", width: 1280, height: 800 },
  });
  assert.deepEqual(computer.calls.filter(([method]) => method.startsWith("screen.")), [["screen.shot", {}], ["screen.read", { id: "s1", offset: Math.floor(PNG.length / 2) }]]);
  assert.equal((await call(tools, "computer_screenshot", { region: [1, 2, 3, 4] })).isError, false);
  assert.deepEqual(computer.calls.filter(([method]) => method === "screen.shot").at(-1), ["screen.shot", { region: [1, 2, 3, 4] }]);
  // Without the ui group, observe is the screenshot, and act's steps go as raw input at its pixels.
  const seen = await call(tools, "computer_observe", {});
  assert.equal(seen.images.length, 1);
  assert.match(seen.text, /^screen 1280×800 px · this computer has no ui group/);
  const acted = await call(tools, "computer_act", { steps: [{ click: [10, 20] }, { type: "hi" }, { key: "enter" }] });
  assert.deepEqual(acted, { text: "1. click: input\n2. type: input\n3. key: input", isError: false, structured: { steps: [{ route: "input", verified: false }, { route: "input", verified: false }, { route: "input", verified: false }] } });
  assert.deepEqual(computer.calls.filter(([method]) => method === "input.actions"), [["input.actions", { actions: [{ type: "click", at: [10, 20] }, { type: "type", text: "hi" }, { type: "key", keys: ["enter"] }] }]]);
  // An element step needs the ui group: refused before anything is sent.
  const refused = await call(tools, "computer_act", { steps: [{ press: "@e3" }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /needs the ui group/);
  assert.equal(computer.calls.filter(([method]) => method === "input.actions").length, 1);
  assert.ok(!computer.methods().includes("readBack"), "nothing was attached");
  await run.end();
});

test("a desktop whose provider mounts: the run folder is attached (shell computer, the five background tools), with the computer's tools on top", async () => {
  const root = scratch();
  const computer = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS), check: { readBackOf } }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), [...COMPUTER, ...TOOLS]);
  assert.ok(run.hands.processes && run.hands.computer);
  assert.deepEqual(run.hands.computer.groups, DESKTOP_GROUPS);
  assert.ok(computer.methods().includes("readBack"), "attach read the mount back");
  // A desktop with no exec or files (a screen alone) attaches nothing, mount or not.
  const bare = await runTools(localWorkspace(scratch()), { kind: "desktop", computer: fakeScreen(root), hello: helloOf("desktop", ["screen", "input.pointer"]), check: { readBackOf } }, { mode: 1, context: ctx });
  assert.deepEqual(names(bare), [...FILES, ...TOOLS]);
});

test("a sandbox: today's computer list, attached; no computer tools", async () => {
  const root = scratch();
  const run = await runTools(localWorkspace(root), { kind: "sandbox", computer: fakeComputer(root), check: { readBackOf } }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), COMPUTER);
  assert.equal(run.hands.computer, undefined);
});

test("a phone with the ui group: observe is the outline of its window, act its steps by ref, each with its route; the state goes with a step at a point", async () => {
  const root = scratch();
  const phone = fakeScreen(root, { ui: true });
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, hello: helloOf("phone", [...PHONE_GROUPS, "ui"]) }, { mode: 2, context: ctx });
  assert.deepEqual(names(run), [...LOCAL, ...TOOLS]);
  const tools = run.hostTools(TOOLS);
  const seen = await call(tools, "computer_observe", {});
  assert.deepEqual(seen.text.split("\n"), ['state s1 · com.example.notes "Notes" · window "Untitled" 400×300 pt', '@e1 window "Untitled"', '  @e2 textbox "Title" [focused]', '  @e3 button "Save"']);
  assert.equal(seen.images, undefined, "no image unless asked");
  assert.equal(seen.structured.id, "s1");
  const acted = await call(tools, "computer_act", { steps: [{ set: "@e2", value: "Groceries" }, { press: "@e3" }] });
  assert.deepEqual(acted.text.split("\n"), ['1. set @e2 textbox "Title": semantic, verified', '2. press @e3 button "Save": semantic, verified', "changed · state s2"]);
  await call(tools, "computer_act", { steps: [{ click: [320, 260] }] });
  assert.deepEqual(phone.calls.filter(([method]) => method === "ui.act").map(([, params]) => params), [
    { steps: [{ set: "@e2", value: "Groceries" }, { press: "@e3" }] },
    { state: "s1", steps: [{ click: [320, 260] }] },
  ]);
});

test("a phone without the ui group (an iPhone today): observe falls back to the screenshot, and taps go as touch input", async () => {
  const root = scratch();
  const iphone = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: iphone, hello: helloOf("phone", PHONE_GROUPS) }, { mode: 2, context: ctx });
  assert.deepEqual(names(run), [...LOCAL, ...TOOLS]);
  const tools = run.hostTools(TOOLS);
  const seen = await call(tools, "computer_observe", {});
  assert.equal(seen.images[0].data, PNG.toString("base64"));
  assert.match(seen.text, /com\.example\.notes in front/);
  await call(tools, "computer_act", { steps: [{ click: [5, 6] }, { nav: "back" }] });
  assert.deepEqual(iphone.calls.filter(([method]) => method === "input.actions").map(([, params]) => params.actions), [[{ type: "tap", at: [5, 6] }, { type: "button", name: "back" }]]);
  assert.ok(!iphone.methods().includes("ui.observe"), "never asked for elements it does not declare");
});

test("a browser brings none of the registry's tools: the run's browser tool drives it (runner-browser-computer.test.mjs)", async () => {
  const run = await runTools(localWorkspace(scratch()), { kind: "browser", browser: { provider: "local-chrome" } }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), FILES);
  assert.deepEqual(run.kindTools, []);
  assert.equal(run.hands.computer, undefined);
});

test("a person's hold on the computer: runTools hands a desktop's or a phone's port to the hold given, and only those", async () => {
  const root = scratch();
  const seen = [];
  const hold = (ports) => {
    seen.push(Object.keys(ports).sort());
    return { computer: { ...ports.computer, call: async (op, args, signal) => (op === "act" ? Promise.reject(new Error("the person had this computer: observe again before you act")) : ports.computer.call(op, args, signal)) } };
  };
  const desktop = await runTools(localWorkspace(root), { kind: "desktop", computer: fakeScreen(root), hello: helloOf("desktop", DESKTOP_GROUPS), check: { readBackOf } }, { mode: 1, context: ctx, hold });
  const tools = desktop.hostTools(TOOLS);
  assert.equal((await call(tools, "computer_screenshot", {})).isError, false, "a look runs through the hold");
  assert.deepEqual(await call(tools, "computer_act", { steps: [{ click: [1, 1] }] }), { text: "the person had this computer: observe again before you act", isError: true });
  const computer = scriptComputer(desktop, desktop.hostTools(desktop.kindTools));
  await computer.input.act([{ type: "move", at: [1, 1] }]);
  assert.equal((await computer.screen.shot()).width, 1280, "a script's calls (computer_op's among them) go through the same hands");
  assert.ok(desktop.hands.processes, "the shell's processes never pass through the hold");
  await runTools(localWorkspace(root), { kind: "phone", computer: fakeScreen(root), hello: helloOf("phone", PHONE_GROUPS) }, { mode: 1, context: ctx, hold });
  await runTools(localWorkspace(root), { kind: "browser", browser: { provider: "local-chrome" } }, { mode: 1, context: ctx, hold });
  await runTools(localWorkspace(root), { kind: "sandbox", computer: fakeComputer(root), check: { readBackOf } }, { mode: 1, context: ctx, hold });
  assert.deepEqual(seen, [["computer"], ["computer"]], "a browser and a sandbox never pass through it");
});

test("with no computer or a sandbox, a computer tool is refused in words naming the setting", async () => {
  const run = await runTools(localWorkspace(scratch()), undefined, { mode: 1, context: ctx });
  assert.match((await run.registry.invoke("computer_observe", {}, { hands: run.hands })).error, /^computer_observe needs a desktop computer: set this agent's computer to desktop/);
});

test("a script's `computer` over the run's tools: its value is the per-step tool's value, an element found by its last look is pressed by ref, its shell is absent on a phone without exec, and a refusal throws its words", async () => {
  const root = scratch();
  const phone = fakeScreen(root, { ui: true });
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, hello: helloOf("phone", [...PHONE_GROUPS, "ui"]) }, { mode: 2, context: ctx });
  const tools = run.hostTools(run.kindTools);
  const computer = scriptComputer(run, tools);
  const byTool = await call(tools, "computer_observe", {});
  assert.equal(JSON.stringify(await computer.app().observe()), JSON.stringify(byTool.structured), "byte-identical values");
  const notes = computer.app("com.example.notes");
  await notes.observe();
  const save = notes.find({ role: "button", text: "save" })[0];
  const done = await notes.press(save.ref);
  assert.deepEqual({ state: done.state, steps: done.steps.length }, { state: "s2", steps: 1 });
  assert.deepEqual((await computer.apps.list()).apps.map((app) => app.id), ["com.example.notes"], "apps.list through computer_op");
  assert.equal(computer.shell, undefined, "no shell on a phone without exec");
  // An op the computer has not (its shell), called by hand: computer_op answers the surface's refusal, and nothing runs.
  const refused = await op(tools, "shell.run", { command: "id" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /can't shell\.run/);
  assert.equal(phone.calls.filter(([method]) => method === "exec.run").length, 0);
  await run.end();
});

test("a script's shell and files run through computer_op, and the gate reads each as the run's own tool's call: bash with its command and the directory it runs in, write and read with their path", async () => {
  const root = scratch();
  const computer = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS), check: { readBackOf } }, { mode: 1, context: ctx });
  const tools = run.hostTools(run.kindTools);
  const ran = await op(tools, "shell.run", { command: "cat passwd", cwd: "/etc" });
  assert.equal(ran.isError, false, ran.text);
  const [, sent] = computer.calls.filter(([method]) => method === "exec.run").at(-1);
  assert.equal(sent.cwd, "/etc", "the directory it runs in is the one the gate read");
  assert.deepEqual(heldAs("computer_op", { op: "shell.run", args: { command: "cat passwd", cwd: "/etc" } }), { tool: "bash", args: { command: "cat passwd", cwd: "/etc" } });
  assert.equal((await op(tools, "files.write", { path: "/workspace/a.txt", data: "x" })).isError, false);
  assert.equal(computer.calls.filter(([method]) => method === "files.write").length, 1);
  assert.deepEqual(heldAs("computer_op", { op: "files.write", args: { path: "/workspace/a.txt", data: "x" } }), { tool: "write", args: { path: "/workspace/a.txt" } }, "the gate reads the path, never the data");
  for (const read of ["files.read", "files.list", "files.stat"]) assert.equal(heldAs("computer_op", { op: read, args: { path: "/workspace" } })?.tool, "read", read);
  for (const kind of ["apps.list", "apps.open", "input.act"]) assert.equal(heldAs("computer_op", { op: kind, args: {} }), undefined, `${kind} is the kind's alone`);
  await run.end();
});

test("a script's processes.start runs through computer_op, held as bash_background, and opens on the desktop's display", async () => {
  const root = scratch();
  const computer = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: { ...helloOf("desktop", DESKTOP_GROUPS), display: ":0" }, check: { readBackOf } }, { mode: 1, context: ctx });
  const tools = run.hostTools(run.kindTools);
  assert.deepEqual((await op(tools, "processes.start", { command: "mousepad", cwd: "/tmp" })).structured, { pid: 42 });
  assert.deepEqual(heldAs("computer_op", { op: "processes.start", args: { command: "mousepad", cwd: "/tmp" } }), { tool: "bash_background", args: { command: "mousepad", cwd: "/tmp" } });
  const [, sent] = computer.calls.filter(([method]) => method === "process.start").at(-1);
  assert.deepEqual(sent, { argv: ["sh", "-c", "mousepad"], cwd: "/tmp", env: { DISPLAY: ":0" }, orphans: "keep" });
  await op(tools, "shell.run", { command: "xdotool getactivewindow" });
  const [, ran] = computer.calls.filter(([method]) => method === "exec.run").at(-1);
  assert.equal(ran.env.DISPLAY, ":0", "a desktop's shell.run opens on its display too");
  await run.end();
});

test("under a bash policy a script's shell carries the policy's git lock-down as the bash tool's does, and no option of the script overrides it", async () => {
  const root = scratch();
  const computer = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS), check: { readBackOf } }, { mode: 1, context: ctx, bashPolicy: "read-only" });
  const tools = run.hostTools(run.kindTools);
  await op(tools, "shell.run", { command: "git status", env: { GIT_CONFIG_COUNT: "0", MINE: "1" } });
  const [, sent] = computer.calls.filter(([method]) => method === "exec.run").at(-1);
  assert.equal(sent.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.notEqual(sent.env.GIT_CONFIG_COUNT, "0", "the policy's value, not the script's");
  assert.equal(sent.env.MINE, "1", "the script's other variables stay");
  assert.match(sent.argv.at(-1), /^git\(\) \{ case .*\ngit status$/s, "the git floor check runs before the command");
  await run.end();
});

// The agent's computer setting picks the computer's surface (computer-setting.ts surface, carried on the RunComputer):
// "tools" (or none named), the per-step tools and the hand-over listed; "code", the hand-over listed and the per-step
// tools bound for a codemode script's nested calls alone. computer_op is bound for scripts alone under both. The same on
// every harness: the host's codemode calls whichever of them the run binds.
const listedOf = (run) => run.hostTools(run.kindTools).filter((tool) => !tool.deferred).map((tool) => tool.name);
test("surface tools: a desktop's and a phone's run lists computer_observe, computer_act, computer_screenshot and the hand-over; computer_op is bound for scripts alone; no computer_script", async () => {
  for (const [kind, groups] of [["desktop", DESKTOP_GROUPS], ["phone", PHONE_GROUPS]]) {
    const run = await runTools(localWorkspace(scratch()), { kind, computer: fakeScreen(scratch()), hello: helloOf(kind, groups), surface: "tools" }, { mode: 1, context: ctx });
    assert.deepEqual(run.kindTools, ["computer_observe", "computer_act", "computer_screenshot", "computer_op", "computer_request_handoff"], kind);
    assert.deepEqual(listedOf(run), ["computer_observe", "computer_act", "computer_screenshot", "computer_request_handoff"], kind);
    await run.end();
  }
});

test("surface code: the run lists the hand-over alone, its per-step tools and computer_op bound for scripts alone; none named reads as tools", async () => {
  for (const [kind, groups] of [["desktop", DESKTOP_GROUPS], ["phone", PHONE_GROUPS]]) {
    const run = await runTools(localWorkspace(scratch()), { kind, computer: fakeScreen(scratch()), hello: helloOf(kind, groups), surface: "code" }, { mode: 1, context: ctx });
    assert.deepEqual(run.kindTools, ["computer_observe", "computer_act", "computer_screenshot", "computer_op", "computer_request_handoff"], kind);
    assert.deepEqual(listedOf(run), ["computer_request_handoff"], kind);
    await run.end();
  }
  const none = await runTools(localWorkspace(scratch()), { kind: "desktop", computer: fakeScreen(scratch()), hello: helloOf("desktop", DESKTOP_GROUPS) }, { mode: 1, context: ctx });
  assert.deepEqual(none.kindTools, TOOLS);
  assert.deepEqual(listedOf(none), ["computer_observe", "computer_act", "computer_screenshot", "computer_request_handoff"]);
  await none.end();
});

test("exec false: no bash family even on a desktop whose provider mounts, in either mode, no computer.shell or computer.processes on the script's card, computer_op refuses one in words, and nothing reaches the computer's exec", async () => {
  for (const mode of [1, 2]) {
    const root = scratch();
    const computer = fakeScreen(root);
    const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS), check: { readBackOf }, exec: false }, { mode, context: ctx });
    assert.deepEqual(names(run), [...FILES, ...TOOLS], `mode ${mode}: the file tools on the run's folder and the computer's tools, no bash`);
    assert.equal(run.shell, "none", `mode ${mode}`);
    assert.equal(run.hands.processes, undefined, `mode ${mode}: no background processes`);
    assert.ok(!computer.methods().includes("readBack"), `mode ${mode}: the folder is not attached`);
    assert.deepEqual(run.hands.computer.groups, ["files", "screen", "input.pointer", "input.keys"], "the computer's card has no exec or processes");
    assert.ok(!run.hostTools(["bash", "bash_background"]).length, "bash is not bound, granted or not");
    const tools = run.hostTools(run.kindTools);
    // A script's computer is bound to the agent's card: no exec, no processes (codemode-computer.test.mjs: its reach for
    // computer.shell throws the words below).
    assert.deepEqual(run.computer, { card: { ...run.computer.card, groups: ["files", "screen", "input.pointer", "input.keys"] }, exec: false });
    const bound = scriptComputer(run, tools);
    assert.deepEqual(["shell" in bound, "processes" in bound], [false, false]);
    // computer_op called by hand with either: refused in words, before the computer is reached.
    for (const [name, args] of [["shell.run", { command: "id" }], ["processes.start", { command: "xterm" }]]) {
      const refused = await op(tools, name, args);
      assert.equal(refused.isError, true, name);
      assert.match(refused.text, /this agent's computer runs no programs: its exec setting is off/, name);
    }
    assert.deepEqual(computer.calls.filter(([method]) => method === "exec.run" || method.startsWith("process.")), [], `mode ${mode}: nothing ran on the computer`);
    await run.end();
  }
  // A phone in Mode 2 has Archil's bash ("local") as a rule; exec false takes it away too.
  const phone = await runTools(localWorkspace(scratch()), { kind: "phone", computer: fakeScreen(scratch()), hello: helloOf("phone", PHONE_GROUPS), exec: false }, { mode: 2, context: ctx });
  assert.deepEqual(names(phone), [...FILES, ...TOOLS]);
  await phone.end();
});

test("exec false is the agent's alone: the loop's computer (the owner's POST /runs/{id}/computer/call channel) keeps the computer's whole hello and runs exec.run", async () => {
  const { loopComputerOf } = await import("../dist/runner/computer-channel.js");
  const root = scratch();
  const computer = fakeScreen(root);
  const given = { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS), exec: false };
  const run = await runTools(localWorkspace(root), given, { mode: 1, context: ctx });
  assert.ok(!run.hands.computer.groups.includes("exec"));
  const loop = loopComputerOf(given, undefined);
  assert.deepEqual(loop.hello.groups, DESKTOP_GROUPS, "every group, exec and processes among them");
  const ran = await loop.client.call("exec.run", { argv: ["true"], timeoutMs: 1000 });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.deepEqual(computer.calls.filter(([method]) => method === "exec.run").map(([, params]) => params.argv), [["true"]]);
  await run.end();
});

test("the claim's MCP server: an MCP client lists the run's computer tools and its calls answer what the per-step tools and computer_op answer, with structuredContent and image blocks", async () => {
  const root = scratch();
  const phone = fakeScreen(root, { ui: true });
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, hello: helloOf("phone", [...PHONE_GROUPS, "ui"]) }, { mode: 2, context: ctx });
  const tools = run.hostTools(run.kindTools);
  const mcp = computerMcp(tools);
  const client = new Client({ name: "computer-mcp-test", version: "1.0.0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://claim.test/mcp"), { fetch: (url, init) => mcp.fetch(new Request(url, init)) }));
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), run.kindTools);
    const byTool = await call(tools, "computer_observe", {});
    const observed = await client.callTool({ name: "computer_observe", arguments: {} });
    assert.equal(observed.isError ?? false, false);
    assert.deepEqual(observed.content, [{ type: "text", text: byTool.text }], "the same words");
    assert.equal(JSON.stringify(observed.structuredContent), JSON.stringify(byTool.structured), "byte-identical values");
    const listedApps = await client.callTool({ name: "computer_op", arguments: { op: "apps.list", args: {} } });
    assert.equal(JSON.stringify(listedApps.structuredContent), JSON.stringify((await op(tools, "apps.list")).structured), "computer_op's value is the same over MCP");
    const shot = await client.callTool({ name: "computer_screenshot", arguments: {} });
    assert.deepEqual(shot.content.filter((block) => block.type === "image"), [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], "the screenshot as an image block, whole");
    // A shell on a phone that has none: the computer's refusal, in its words.
    const failed = await client.callTool({ name: "computer_op", arguments: { op: "shell.run", args: { command: "id" } } });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined, "a failure carries no value");
    assert.match(failed.content[0].text, /can't shell\.run/);
  } finally {
    await client.close();
  }
});
