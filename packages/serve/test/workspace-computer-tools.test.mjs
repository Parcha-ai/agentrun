// A run's tools by its computer's kind (serve/src/workspace/run-tools.ts runTools, computer-ports.ts): the run folder
// is attached only when the kind has files and exec AND the provider mounts it (a sandbox always; a desktop when its
// provider mounts); otherwise it stays the no-computer Workspace and the shell is "local". The kind's own tools come on
// top, their ports filled from the computer's capabilities: a desktop's screen and input from computerd's screen.shot
// and input.actions, a phone's from its touch and apps calls, a browser's from its CDP connect. Screenshots go back as
// images. Every computer here is a loopback fake: nothing leaves this process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { checkActions, KEYS, MAX_ACTIONS, readBackOf } from "@parcha/agentrun-computer";
import { DESKTOP_ACTIONS, DESKTOP_KEYS, DESKTOP_MAX_ACTIONS } from "@parcha/agentrun-kernel/kernel";
import { BROWSER_TOOLS, listedFor } from "@parcha/pi-browser";
import { inputOf, localWorkspace, phoneOf, runTools, screenOf } from "../dist/workspace/index.js";
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

const LOCAL = ["read", "write", "edit", "bash"];
const COMPUTER = [...LOCAL, "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];
const DESKTOP = ["desktop_screen", "desktop_input", "computer_request_handoff"];
const PHONE = ["phone_screen", "phone_tap", "phone_swipe", "phone_type", "phone_apps", "phone_open", "computer_request_handoff"];
const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
const PHONE_GROUPS = ["screen", "input.touch", "apps"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A loopback desktop: computerd's screen.shot answers the PNG in two pieces (the rest by screen.read), input.actions
 *  runs every action, apps.list and apps.launch answer a phone's. */
function fakeDesktop(root) {
  const computer = fakeComputer(root);
  const half = Math.floor(PNG.length / 2);
  computer.overrides["screen.shot"] = () => ({ id: "s1", size: PNG.length, data: PNG.subarray(0, half).toString("base64"), eof: false, width: 1280, height: 800, scale: 1 });
  computer.overrides["screen.read"] = ({ offset }) => ({ data: PNG.subarray(offset).toString("base64"), eof: true });
  computer.overrides["input.actions"] = ({ actions }) => ({ done: actions.length });
  computer.overrides["apps.list"] = () => ({ apps: [{ id: "com.example.mail", name: "Mail" }], foreground: null });
  computer.overrides["apps.launch"] = () => ({});
  return computer;
}

test("a desktop whose provider does not mount: the run folder stays the runner's (shell local, no processes), and the desktop's tools come on top", async () => {
  const root = scratch();
  const computer = fakeDesktop(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, groups: DESKTOP_GROUPS }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), [...LOCAL, ...DESKTOP]);
  assert.equal(run.hands.processes, undefined, "no background processes on an unmounted desktop");
  const tools = run.hostTools(["bash", ...DESKTOP]);
  assert.deepEqual(await call(tools, "bash", { command: "echo here" }), { text: "here\n", isError: false });
  assert.ok(!computer.methods().includes("exec.run"), "bash ran in the run's folder on the runner, not on the desktop");
  const shot = await call(tools, "desktop_screen", {});
  assert.deepEqual(shot, { text: "A screenshot of the whole screen, 1280x800 pixels.", isError: false, images: [{ mimeType: "image/png", data: PNG.toString("base64") }] });
  assert.deepEqual(computer.calls.filter(([method]) => method.startsWith("screen.")), [["screen.shot", {}], ["screen.read", { id: "s1", offset: Math.floor(PNG.length / 2) }]]);
  const part = await call(tools, "desktop_screen", { region: { x: 1, y: 2, w: 3, h: 4 } });
  assert.equal(part.isError, false, part.text);
  assert.deepEqual(computer.calls.filter(([method]) => method === "screen.shot").at(-1), ["screen.shot", { region: [1, 2, 3, 4] }]);
  const actions = [{ type: "click", at: [10, 20] }, { type: "type", text: "hi" }, { type: "key", keys: ["enter"] }];
  assert.deepEqual(await call(tools, "desktop_input", { actions }), { text: "Ran 3 actions. desktop_screen shows what they did.", isError: false });
  assert.deepEqual(computer.calls.filter(([method]) => method === "input.actions"), [["input.actions", { actions }]]);
  assert.ok(!computer.methods().includes("readBack"), "nothing was attached");
  await run.end();
});

test("a desktop whose provider mounts: the run folder is attached (shell computer, the five background tools), with the desktop's tools on top", async () => {
  const root = scratch();
  const computer = fakeDesktop(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, groups: DESKTOP_GROUPS, check: { readBackOf } }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), [...COMPUTER, ...DESKTOP]);
  assert.ok(run.hands.processes && run.hands.screen && run.hands.input);
  assert.ok(computer.methods().includes("readBack"), "attach read the mount back");
  // A desktop with no exec or files (a screen alone) attaches nothing, mount or not.
  const bare = await runTools(localWorkspace(scratch()), { kind: "desktop", computer: fakeDesktop(root), groups: ["screen", "input.pointer"], check: { readBackOf } }, { mode: 1, context: ctx });
  assert.deepEqual(names(bare), [...LOCAL, ...DESKTOP]);
});

test("a sandbox: today's computer list, attached; no kind tools", async () => {
  const root = scratch();
  const run = await runTools(localWorkspace(root), { kind: "sandbox", computer: fakeComputer(root), check: { readBackOf } }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), COMPUTER);
  assert.equal(run.hands.screen, undefined);
});

test("a phone: the runner's folder and shell, and the phone's tools on its touch and apps calls", async () => {
  const root = scratch();
  const phone = fakeDesktop(root);
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, groups: PHONE_GROUPS }, { mode: 2, context: ctx });
  assert.deepEqual(names(run), [...LOCAL, ...PHONE]);
  const tools = run.hostTools(PHONE);
  assert.equal((await call(tools, "phone_screen", {})).images[0].data, PNG.toString("base64"));
  await call(tools, "phone_tap", { x: 5, y: 6 });
  await call(tools, "phone_swipe", { from: { x: 1, y: 900 }, to: { x: 1, y: 100 }, duration_ms: 400 });
  await call(tools, "phone_type", { text: "hello" });
  assert.deepEqual(await call(tools, "phone_apps", {}), { text: "1 app; none is in front.\ncom.example.mail (Mail)", isError: false });
  await call(tools, "phone_open", { id: "com.example.mail" });
  assert.deepEqual(phone.calls.filter(([method]) => method === "input.actions" || method.startsWith("apps.")), [
    ["input.actions", { actions: [{ type: "tap", at: [5, 6] }] }],
    ["input.actions", { actions: [{ type: "swipe", path: [[1, 900], [1, 100]], ms: 400 }] }],
    ["input.actions", { actions: [{ type: "type", text: "hello" }] }],
    ["apps.list", {}],
    ["apps.launch", { id: "com.example.mail" }],
  ]);
});

test("a browser: the browser's tools are pi-browser's BROWSER_TOOLS (the same objects), listed for the run's offers, run by the executors given over the CDP connect", async () => {
  const root = scratch();
  const sent = [];
  const connect = async () => ({ send: async (method, params) => (sent.push([method, params]), {}), on: () => () => {}, close: () => {} });
  const offers = { downloads: false, upload: true, handoff: true };
  const listed = BROWSER_TOOLS.filter((contract) => listedFor(contract, offers));
  const executors = Object.fromEntries(listed.map((contract) => [contract.name, async (args, run) => {
    const session = await run.hands.browser.connect();
    await session.send(`Fake.${contract.name}`, args);
    return { text: `${contract.name} ran` };
  }]));
  const run = await runTools(localWorkspace(root), { kind: "browser", connect }, { mode: 1, context: ctx, browser: { executors, offers } });
  assert.deepEqual(names(run), [...LOCAL, ...listed.map((contract) => contract.name)]);
  assert.ok(!names(run).includes("browser_downloads"), "no downloads where the provider keeps none");
  for (const def of run.registry.list().slice(LOCAL.length)) {
    const contract = BROWSER_TOOLS.find((one) => one.name === def.name);
    assert.equal(def.description, contract.description, def.name);
    assert.equal(def.parameters, contract.parameters, `${def.name}: pi-browser's own schema object`);
    assert.equal(def.settingsKey, "browser");
  }
  const [snapshot] = run.hostTools(["snapshot"]);
  assert.deepEqual(await snapshot.call({}, { callId: "c1", signal: new AbortController().signal }), { text: "snapshot ran", isError: false });
  assert.deepEqual(sent, [["Fake.snapshot", {}]]);
  await assert.rejects(runTools(localWorkspace(root), { kind: "browser", connect }, { mode: 1, context: ctx }), /no executor for snapshot/);
});

test("a person's hold on the computer: runTools hands a desktop's or a phone's ports to the hold given, and only those", async () => {
  const root = scratch();
  const seen = [];
  const takenOver = Object.assign(new Error("the person had the desktop: look at the screen again before acting"), { code: "taken_over" });
  const hold = (ports) => {
    seen.push(Object.keys(ports).sort());
    return { ...ports, ...(ports.input ? { input: { actions: async () => { throw takenOver; } } } : {}), ...(ports.phone ? { phone: { ...ports.phone, tap: async () => { throw takenOver; } } } : {}) };
  };
  const desktop = await runTools(localWorkspace(root), { kind: "desktop", computer: fakeDesktop(root), groups: DESKTOP_GROUPS, check: { readBackOf } }, { mode: 1, context: ctx, hold });
  const tools = desktop.hostTools(DESKTOP);
  assert.equal((await call(tools, "desktop_screen", {})).isError, false, "a read runs through the hold");
  assert.deepEqual(await call(tools, "desktop_input", { actions: [{ type: "move", at: [1, 1] }] }), { text: "the person had the desktop: look at the screen again before acting", isError: true });
  assert.ok(desktop.hands.processes, "the shell's processes never pass through the hold");
  const phone = await runTools(localWorkspace(root), { kind: "phone", computer: fakeDesktop(root), groups: PHONE_GROUPS }, { mode: 1, context: ctx, hold });
  assert.equal((await call(phone.hostTools(["phone_tap"]), "phone_tap", { x: 1, y: 1 })).isError, true);
  await runTools(localWorkspace(root), { kind: "browser", connect: async () => ({}) }, { mode: 1, context: ctx, hold, browser: { executors: Object.fromEntries(BROWSER_TOOLS.map((one) => [one.name, async () => ({ text: "" })])), offers: { downloads: true, upload: true, handoff: true } } });
  await runTools(localWorkspace(root), { kind: "sandbox", computer: fakeComputer(root), check: { readBackOf } }, { mode: 1, context: ctx, hold });
  assert.deepEqual(seen, [["input", "screen"], ["phone"]], "a browser and a sandbox never pass through it");
});

test("with no computer or a sandbox, a kind's tool is refused in words naming the setting", async () => {
  const run = await runTools(localWorkspace(scratch()), undefined, { mode: 1, context: ctx });
  assert.equal((await run.registry.invoke("desktop_screen", {}, { hands: run.hands })).error, "desktop_screen needs a desktop computer: set this agent's computer to desktop (Settings → Computers).");
  assert.equal((await run.registry.invoke("snapshot", {}, { hands: run.hands })).error, "snapshot needs a browser computer: set this agent's computer to browser (Settings → Computers).");
});

test("the ports over computerd: a shot read to its end; a failed batch throws the computer's code and words, with how many ran", async () => {
  const root = scratch();
  const computer = fakeDesktop(root);
  const shot = await screenOf(computer.client).shot();
  assert.deepEqual([Buffer.from(shot.png).equals(PNG), shot.width, shot.height], [true, 1280, 800]);
  computer.overrides["screen.read"] = () => ({ data: "", eof: false });
  await assert.rejects(screenOf(computer.client).shot(), /the computer's screenshot stopped at byte \d+ of \d+/);
  computer.overrides["input.actions"] = () => ({ done: 1, failed: { index: 1, kind: "unsupported", message: "action 1 (scroll): this computer scrolls by clicks, not pixels" } });
  await assert.rejects(inputOf(computer.client).actions([{ type: "move", at: [1, 1] }, { type: "scroll", dy: 1, unit: "px" }]), (error) => error.code === "unsupported" && error.message === "action 1 (scroll): this computer scrolls by clicks, not pixels (1 of 2 actions ran)");
  computer.overrides["apps.launch"] = { result: { ok: false, error: { code: "not_found", message: "no app com.nope" } } };
  await assert.rejects(phoneOf(computer.client).apps.open("com.nope"), (error) => error.code === "not_found" && error.message === "no app com.nope");
});

test("parity: the desktop's key names and batch limit are computerd's, and every action desktop_input offers is one computerd takes from a desktop", () => {
  assert.deepEqual([...DESKTOP_KEYS], [...KEYS]);
  assert.equal(DESKTOP_MAX_ACTIONS, MAX_ACTIONS);
  const one = { move: { type: "move", at: [1, 2] }, click: { type: "click", at: [1, 2], button: "right", count: 2 }, drag: { type: "drag", path: [[1, 1], [2, 2]], button: "left" }, scroll: { type: "scroll", at: [1, 1], dx: 0, dy: 2, unit: "clicks" }, type: { type: "type", text: "x" }, key: { type: "key", keys: ["ctrl", "c"] } };
  assert.deepEqual(Object.keys(one), [...DESKTOP_ACTIONS]);
  assert.equal(checkActions(Object.values(one), ["screen", "input.pointer", "input.keys"]), undefined);
});
