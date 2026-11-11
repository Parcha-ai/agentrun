// A run's tools by its computer's kind (serve/src/workspace/run-tools.ts runTools, computer-ports.ts): the run folder
// is attached only when the kind has files and exec AND the provider mounts it (a sandbox always; a desktop when its
// provider mounts); otherwise it stays the no-computer Workspace with no computer's shell: none in Mode 1 (the folder is
// one of this server's own: no bash family), Archil's exec in Mode 2 ("local", bash only). The kind's own tools come on
// top, their ports filled from the computer's capabilities: a desktop's screen and input from computerd's screen.shot
// and input.actions, a phone's from its touch and apps calls; a browser brings none (the run's browser tool drives it).
// Screenshots go back as images. Every computer here is a loopback fake: nothing leaves this process.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { checkActions, KEYS, MAX_ACTIONS, readBackOf } from "@parcha/agentrun-computer";
import { DESKTOP_ACTIONS, DESKTOP_KEYS, DESKTOP_MAX_ACTIONS, NO_SHELL } from "@parcha/agentrun-kernel/kernel";
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

/** The file tools alone: no computer's shell in Mode 1. */
const FILES = ["read", "write", "edit"];
/** With Archil's exec (Mode 2, no computer's shell): bash only. */
const LOCAL = [...FILES, "bash"];
const COMPUTER = [...LOCAL, "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];
const DESKTOP = ["desktop_screen", "desktop_input", "computer_request_handoff"];
const PHONE = ["phone_screen", "phone_tree", "phone_tap", "phone_swipe", "phone_type", "phone_key", "phone_apps", "phone_open", "computer_request_handoff"];
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

test("a desktop whose provider does not mount, in Mode 1: the run folder stays the runner's with no shell (no bash family, no processes), and the desktop's tools come on top", async () => {
  const root = scratch();
  const computer = fakeDesktop(root);
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer, groups: DESKTOP_GROUPS }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), [...FILES, ...DESKTOP]);
  assert.equal(run.hands.processes, undefined, "no background processes on an unmounted desktop");
  const tools = run.hostTools(["bash", ...DESKTOP]);
  assert.ok(!tools.some((tool) => tool.name === "bash"), "bash is not bound, granted or not");
  assert.equal((await run.registry.invoke("bash", { command: "touch ran" }, { hands: run.hands })).error, NO_SHELL, "a call of it anyway says how to get a shell");
  assert.ok(!existsSync(join(root, "ran")), "and runs nothing");
  assert.ok(!computer.methods().includes("exec.run") && !computer.methods().includes("process.start"), "nor on the desktop");
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
  assert.deepEqual(names(bare), [...FILES, ...DESKTOP]);
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
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, groups: [...PHONE_GROUPS, "apps.ui_tree", "input.keys"] }, { mode: 2, context: ctx });
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

test("a phone that does not declare apps.ui_tree or input.keys (an iPhone today) is offered neither phone_tree nor phone_key, and a call of either is refused in words", async () => {
  const root = scratch();
  const iphone = fakeDesktop(root);
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: iphone, groups: PHONE_GROUPS }, { mode: 2, context: ctx });
  assert.deepEqual(names(run), [...LOCAL, ...PHONE.filter((name) => name !== "phone_tree" && name !== "phone_key")]);
  assert.deepEqual(await run.registry.invoke("phone_tree", {}, { hands: run.hands, callId: "t", signal: new AbortController().signal }), { text: "", error: "this phone does not offer its UI tree" });
  assert.deepEqual(await run.registry.invoke("phone_key", { key: "back" }, { hands: run.hands, callId: "k", signal: new AbortController().signal }), { text: "", error: "this phone does not offer its keys" });
  assert.ok(!iphone.methods().includes("apps.ui_tree") && !iphone.calls.some(([method]) => method === "input.actions"), "nothing reached the phone");
  // One declared, the other not: only that one is offered.
  const android = await runTools(localWorkspace(scratch()), { kind: "phone", computer: fakeDesktop(root), groups: [...PHONE_GROUPS, "apps.ui_tree"] }, { mode: 2, context: ctx });
  assert.deepEqual(names(android).filter((name) => name === "phone_tree" || name === "phone_key"), ["phone_tree"]);
});

test("an Android list row (a clickable layout whose title sits on a child text) is named by its first inner text, marked so; the search bar by its inner text or label", async () => {
  const root = scratch();
  const phone = fakeDesktop(root);
  const node = (role, extra) => ({ role, enabled: true, children: [], ...extra });
  const text = (value, bounds) => node("android.widget.TextView", { text: value, bounds });
  // Settings' top screen, as Android 15 gives it: each row a clickable LinearLayout, its title and summary child TextViews.
  const row = (y, title, summary) => node("android.widget.LinearLayout", { bounds: [0, y, 720, 150], clickable: true, children: [
    node("android.widget.ImageView", { bounds: [30, y + 45, 60, 60] }),
    node("android.widget.RelativeLayout", { bounds: [120, y + 20, 560, 110], children: [text(title, [120, y + 20, 560, 50]), text(summary, [120, y + 75, 560, 40])] }),
  ] });
  phone.overrides["apps.ui_tree"] = () => ({
    root: node("android.widget.FrameLayout", {
      bounds: [0, 0, 720, 1600],
      children: [
        node("android.widget.LinearLayout", { id: "com.android.settings:id/search_action_bar", bounds: [20, 200, 680, 100], clickable: true, children: [node("android.widget.TextView", { label: "Search settings", bounds: [100, 220, 400, 60] })] }),
        row(550, "Network & internet", "Mobile, Wi-Fi, hotspot"),
        row(700, "Connected devices", "Bluetooth, pairing"),
        row(850, "Apps", "Default apps, app management"),
      ],
    }),
    nodes: 20,
    truncated: false,
  });
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, groups: [...PHONE_GROUPS, "apps.ui_tree"] }, { mode: 2, context: ctx });
  const answer = await call(run.hostTools(["phone_tree"]), "phone_tree", {});
  assert.deepEqual(answer.text.split("\n"), [
    "4 nodes you can tap or type into, of 20 on the screen. Coordinates are a phone_screen screenshot's pixels.",
    '- LinearLayout "Search settings" (inner text) [com.android.settings:id/search_action_bar]: center (360, 250), bounds 20,200 680x100',
    '- LinearLayout "Network & internet" (inner text): center (360, 625), bounds 0,550 720x150',
    '- LinearLayout "Connected devices" (inner text): center (360, 775), bounds 0,700 720x150',
    '- LinearLayout "Apps" (inner text): center (360, 925), bounds 0,850 720x150',
  ]);
});

test("a phone's tree is its apps.ui_tree, flattened to the nodes a model can tap or type into; its keys are back and home as the phone's buttons, enter as a key", async () => {
  const root = scratch();
  const phone = fakeDesktop(root);
  const node = (role, extra) => ({ role, enabled: true, children: [], ...extra });
  phone.overrides["apps.ui_tree"] = () => ({
    root: node("android.widget.FrameLayout", {
      bounds: [0, 0, 720, 1280],
      children: [
        node("android.widget.EditText", { id: "com.example.mail:id/to", text: "", label: "To", bounds: [20, 150, 680, 80], clickable: true, focused: true }),
        node("android.widget.LinearLayout", { bounds: [0, 1100, 720, 180], children: [node("android.widget.Button", { text: "Send", bounds: [500, 1150, 200, 80], clickable: true })] }),
        node("android.widget.TextView", { text: "New message", bounds: [20, 60, 400, 60] }),
        node("android.widget.Button", { text: "Disabled", bounds: [20, 1150, 200, 80], clickable: true, enabled: false }),
      ],
    }),
    nodes: 6,
    truncated: false,
  });
  const run = await runTools(localWorkspace(root), { kind: "phone", computer: phone, groups: [...PHONE_GROUPS, "apps.ui_tree", "input.keys"] }, { mode: 2, context: ctx });
  const tools = run.hostTools(["phone_tree", "phone_key"]);
  assert.deepEqual(await call(tools, "phone_tree", {}), { isError: false, text: [
    "2 nodes you can tap or type into, of 6 on the screen. Coordinates are a phone_screen screenshot's pixels.",
    '- EditText "To" [com.example.mail:id/to]: a field, focused; center (360, 190), bounds 20,150 680x80',
    '- Button "Send": center (600, 1190), bounds 500,1150 200x80',
  ].join("\n") });
  for (const key of ["back", "home", "enter"]) await call(tools, "phone_key", { key });
  assert.deepEqual(phone.calls.filter(([method]) => method === "input.actions" || method === "apps.ui_tree"), [
    ["apps.ui_tree", {}],
    ["input.actions", { actions: [{ type: "button", name: "back" }] }],
    ["input.actions", { actions: [{ type: "button", name: "home" }] }],
    ["input.actions", { actions: [{ type: "key", keys: ["enter"] }] }],
  ]);
});

test("a browser brings none of the registry's tools: the run's browser tool drives it (runner-browser-computer.test.mjs)", async () => {
  const run = await runTools(localWorkspace(scratch()), { kind: "browser", browser: { provider: "local" } }, { mode: 1, context: ctx });
  assert.deepEqual(names(run), FILES);
  assert.deepEqual(run.kindTools, []);
  assert.equal(run.hands.browser, undefined, "no CDP port on the hands");
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
  await runTools(localWorkspace(root), { kind: "browser", browser: { provider: "local" } }, { mode: 1, context: ctx, hold });
  await runTools(localWorkspace(root), { kind: "sandbox", computer: fakeComputer(root), check: { readBackOf } }, { mode: 1, context: ctx, hold });
  assert.deepEqual(seen, [["input", "screen"], ["phone"]], "a browser and a sandbox never pass through it");
});

test("with no computer or a sandbox, a kind's tool is refused in words naming the setting", async () => {
  const run = await runTools(localWorkspace(scratch()), undefined, { mode: 1, context: ctx });
  assert.equal((await run.registry.invoke("desktop_screen", {}, { hands: run.hands })).error, "desktop_screen needs a desktop computer: set this agent's computer to desktop (Settings → Computers).");
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
