// A run's tools by its computer's kind (serve/src/workspace/run-tools.ts runTools, computer-ports.ts): the run folder
// is attached only when the kind has files and exec AND the provider mounts it (a sandbox always; a desktop when its
// provider mounts); otherwise it stays the no-computer Workspace with no computer's shell: none in Mode 1 (the folder is
// one of this server's own: no bash family), Archil's exec in Mode 2 ("local", bash only). A desktop or a phone adds the
// computer's tools on top, over its one surface: computer_observe and computer_act on the ui group (ui.observe, ui.act),
// or on the screen and raw input without it; computer_screenshot; computer_script in serve's isolate; the hand-over. A
// browser brings none (the run's browser tool drives it). Every computer here is a loopback fake: nothing leaves this
// process.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { COMPUTER_TOOLS, NO_SHELL } from "@parcha/agentrun-kernel/kernel";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computerMcp, localWorkspace, runTools } from "../dist/workspace/index.js";
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
  const script = await call(tools, "computer_script", { code: "await computer.input.act([{ type: 'move', at: [1, 1] }]); return (await computer.screen.shot()).width;" });
  assert.equal(script.structured, 1280, "a script's calls go through the same hands");
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

test("computer_script: the script's value is the per-step tool's value; text() and image() show beside it; a throw answers its words; the isolate has no network, no process and no require", async () => {
  const root = scratch();
  const phone = fakeScreen(root, { ui: true });
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, hello: helloOf("phone", [...PHONE_GROUPS, "ui"]) }, { mode: 2, context: ctx });
  const tools = run.hostTools(TOOLS);
  const byTool = await call(tools, "computer_observe", {});
  const byScript = await call(tools, "computer_script", { code: "return await computer.app().observe();" });
  assert.equal(JSON.stringify(byScript.structured), JSON.stringify(byTool.structured), "byte-identical values");
  const found = await call(tools, "computer_script", { code: [
    "const notes = computer.app('com.example.notes');",
    "await notes.observe();",
    "const save = notes.find({ role: 'button', text: 'save' })[0];",
    "const done = await notes.press(save.ref);",
    "text('pressed ' + save.ref);",
    "image(await computer.screen.shot());",
    "return { state: done.state, steps: done.steps.length };",
  ].join("\n") });
  assert.equal(found.isError, false, found.text);
  assert.deepEqual(found.structured, { state: "s2", steps: 1 });
  assert.equal(found.text, 'pressed @e3\n{"state":"s2","steps":1}');
  assert.equal(found.images.length, 1);
  assert.equal(found.images[0].data, PNG.toString("base64"));
  const isolated = await call(tools, "computer_script", { code: "return [typeof fetch, typeof process, typeof require, typeof setTimeout, typeof computer.shell];" });
  assert.deepEqual(isolated.structured, ["undefined", "undefined", "undefined", "undefined", "undefined"], "no network, no process, no modules, no timers; no shell on a phone without exec");
  const thrown = await call(tools, "computer_script", { code: "text('before');\nthrow new Error('no Save button here');" });
  assert.equal(thrown.isError, true);
  assert.match(thrown.text, /no Save button here/);
  assert.equal((await call(tools, "computer_script", { code: "" })).isError, true);
});

test("a script that shows output and returns nothing answers its words and images with no value, so a Codex script's nested call keeps them", async () => {
  const root = scratch();
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: fakeScreen(root, { ui: true }), hello: helloOf("phone", [...PHONE_GROUPS, "ui"]) }, { mode: 2, context: ctx });
  const tools = run.hostTools(run.kindTools);
  const shown = await call(tools, "computer_script", { code: "image(await computer.screen.shot()); text('hello');" });
  assert.equal(shown.isError, false, shown.text);
  assert.equal(shown.text, "hello");
  assert.equal(shown.images.length, 1);
  assert.equal(shown.structured, undefined, "no value: the words and images are the answer");
  await run.end();
});

test("a script's returned image keeps its own pixels, apart from the images it showed", async () => {
  const root = scratch();
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: fakeScreen(root, { ui: true }), hello: helloOf("phone", [...PHONE_GROUPS, "ui"]) }, { mode: 2, context: ctx });
  const tools = run.hostTools(run.kindTools);
  const returned = await call(tools, "computer_script", { code: "return await computer.screen.shot();" });
  assert.equal(returned.isError, false, returned.text);
  assert.deepEqual(returned.images, [{ data: PNG.toString("base64"), mimeType: "image/png" }]);
  assert.ok(!JSON.stringify(returned.structured).includes(PNG.toString("base64")), "the value carries no pixels, the answer's images do");
  const both = await call(tools, "computer_script", { code: "image({ type: 'image', mimeType: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });\nreturn await computer.screen.shot();" });
  assert.equal(both.isError, false, both.text);
  assert.deepEqual(both.images.map((image) => image.data), [PNG.toString("base64"), "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"], "the returned image first, with its own data, then the shown one");
  await run.end();
});

test("a script's shell and files are held to the run's gate: a denied bash, a denied write and an ask refuse in the script, and an allow runs", async () => {
  const root = scratch();
  const computer = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS), check: { readBackOf } }, { mode: 1, context: ctx });
  const tools = run.hostTools(run.kindTools);
  const code = "try { await computer.shell.run('echo hi'); return 'ran'; } catch (error) { return String(error.message); }";
  const before = await call(tools, "computer_script", { code });
  assert.match(before.structured, /not attached to its scripts yet/, "no gate installed: refused, never run");
  const seen = [];
  let verdict = "allow";
  run.computer.guard.install(async (tool, args) => { seen.push([tool, args]); return verdict; });
  assert.equal((await call(tools, "computer_script", { code })).structured, "ran");
  assert.deepEqual(seen, [["bash", { command: "echo hi" }]]);
  await call(tools, "computer_script", { code: "try { await computer.shell.run('cat passwd', { cwd: '/etc' }); } catch (error) {} return 1;" });
  assert.deepEqual(seen.at(-1), ["bash", { command: "cat passwd", cwd: "/etc" }], "the directory it runs in is what the gate reads");
  verdict = { deny: "bash is denied for this agent" };
  assert.match((await call(tools, "computer_script", { code })).structured, /bash is denied for this agent/);
  verdict = "ask";
  assert.match((await call(tools, "computer_script", { code: "try { await computer.files.write('/workspace/a.txt', 'x'); return 'wrote'; } catch (error) { return String(error.message); }" })).structured, /write setting asks a person first/);
  assert.deepEqual(seen.at(-1), ["write", { path: "/workspace/a.txt" }]);
  assert.equal(computer.calls.filter(([method]) => method === "files.write").length, 0, "a refused write sent nothing");
  await run.end();
});

test("under a bash policy a script's shell carries the policy's git lock-down as the bash tool's does, and no option of the script overrides it", async () => {
  const root = scratch();
  const computer = fakeScreen(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, hello: helloOf("desktop", DESKTOP_GROUPS), check: { readBackOf } }, { mode: 1, context: ctx, bashPolicy: "read-only" });
  run.computer.guard.install(async () => "allow");
  const tools = run.hostTools(run.kindTools);
  await call(tools, "computer_script", { code: "try { await computer.shell.run('git status', { env: { GIT_CONFIG_COUNT: '0', MINE: '1' } }); } catch (error) {} return 1;" });
  const [, sent] = computer.calls.filter(([method]) => method === "exec.run").at(-1);
  assert.equal(sent.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.notEqual(sent.env.GIT_CONFIG_COUNT, "0", "the policy's value, not the script's");
  assert.equal(sent.env.MINE, "1", "the script's other variables stay");
  assert.match(sent.argv.at(-1), /^git\(\) \{ case .*\ngit status$/s, "the git floor check runs before the command");
  await run.end();
});

test("the claim's MCP server: an MCP client lists the run's computer tools and its calls answer what the per-step tools and the script answer, with structuredContent and image blocks", async () => {
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
    const scripted = await client.callTool({ name: "computer_script", arguments: { code: "return await computer.app().observe();" } });
    assert.equal(JSON.stringify(scripted.structuredContent), JSON.stringify(byTool.structured), "the script's value is the tool's");
    const shot = await client.callTool({ name: "computer_screenshot", arguments: {} });
    assert.deepEqual(shot.content.filter((block) => block.type === "image"), [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], "the screenshot as an image block, whole");
    const failed = await client.callTool({ name: "computer_script", arguments: { code: "throw new Error('no Save button here');" } });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined, "a failure carries no value");
    assert.match(failed.content[0].text, /no Save button here/);
  } finally {
    await client.close();
  }
});
