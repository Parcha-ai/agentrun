// The kernel registry's computer kinds: a run whose computer is a desktop, a phone or a browser sees the host tools of
// its shell plus that kind's tools, in a fixed order, and nothing else. Desktop and phone tools run on the hands' narrow
// ports (screen, input, phone), with images back in the answer's images; the browser kind's definitions are the host's
// (pi-browser's contracts, passed in, never copied here) with the host's executors. A kind tool the run does not have
// is refused in words that name the setting; a def with no executor is refused when the registry is built.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityToolDefs, createRegistry, hostToolDefs, NEEDS_A_COMPUTER, PHONE_TREE_MAX_CHARS, PHONE_TREE_MAX_NODES } from "@parcha/agentrun-kernel/kernel";
import { fakeBrowser, fakeInput, fakePhone, fakeScreen, PNG, refusal } from "./registry-ports.mjs";
import { localHands } from "./registry-support.mjs";

const answer = (text) => async () => ({ text });
const injected = { read: answer("read"), write: answer("write"), edit: answer("edit"), bash: answer("bash") };
const LOCAL = ["read", "write", "edit", "bash"];
const HANDOFF = "computer_request_handoff";
const DESKTOP = ["desktop_screen", "desktop_input", HANDOFF];
const PHONE = ["phone_screen", "phone_tree", "phone_tap", "phone_swipe", "phone_type", "phone_key", "phone_apps", "phone_open", HANDOFF];
/** A browser's contracts as a host passes them (pi-browser's ToolContract shape); the registry keeps their words as given. */
const CONTRACTS = Object.freeze([
  { name: "snapshot", label: "Browser: snapshot", description: "The page's tree.", parameters: { type: "object", properties: {} }, effect: "read", replay: "safe" },
  { name: "run", label: "Browser: run", description: "Act on the page.", parameters: { type: "object", properties: { code: { type: "string" } } }, effect: "effect", replay: "unsafe" },
]);
const BROWSER = CONTRACTS.map((contract) => contract.name);
const browserExecutors = (seen = []) => Object.fromEntries(BROWSER.map((name) => [name, async (args, call) => {
  const session = await call.hands.browser.connect();
  await session.send(`Fake.${name}`, args);
  seen.push(name);
  return { text: `${name} ran` };
}]));
const handsWith = (ports) => ({ ...localHands().hands, ...ports });
const words = (tool, kind) => `${tool} needs a ${kind} computer: set this agent's computer to ${kind} (Settings → Computers).`;

test("a kind's tools follow the host tools, in a fixed order whatever order the kinds are given in", () => {
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["browser", "phone", "desktop"], executors: { ...injected, browser: browserExecutors() }, browserTools: CONTRACTS });
  // The hand-over both kinds have is listed once, with the desktop's.
  assert.deepEqual(registry.list().map((def) => def.name), [...LOCAL, ...DESKTOP, ...PHONE.filter((name) => name !== HANDOFF), ...BROWSER]);
  // No kinds: today's rows, unchanged.
  assert.deepEqual(createRegistry({ maxExecS: 600, shell: "local", executors: injected }).list(), hostToolDefs({ maxExecS: 600, shell: "local" }));
});

test("each kind's definitions: its own gate names and settings key; a read is replay-safe, an act is not", () => {
  const desktop = capabilityToolDefs("desktop");
  assert.deepEqual(desktop.map((def) => [def.name, def.gateName, def.settingsKey, def.replaySafe, def.source]), [
    ["desktop_screen", "host:desktop/desktop_screen", "desktop", true, "host"],
    ["desktop_input", "host:desktop/desktop_input", "desktop", false, "host"],
    [HANDOFF, `host:desktop/${HANDOFF}`, "desktop", false, "host"],
  ]);
  const phone = capabilityToolDefs("phone");
  assert.deepEqual(phone.map((def) => [def.name, def.settingsKey, def.replaySafe]), [
    ["phone_screen", "phone", true], ["phone_tree", "phone", true], ["phone_tap", "phone", false], ["phone_swipe", "phone", false], ["phone_type", "phone", false], ["phone_key", "phone", false], ["phone_apps", "phone", true], ["phone_open", "phone", false], [HANDOFF, "phone", false],
  ]);
  for (const def of [...desktop, ...phone]) {
    assert.equal(def.parameters.type, "object", def.name);
    assert.equal(def.parameters.additionalProperties, false, def.name);
    assert.ok(def.description.length > 40, def.name);
  }
});

test("the browser kind's definitions are the host's contracts, their words and schemas as given (the same objects), held to the setting browser", () => {
  const browser = capabilityToolDefs("browser", { browserTools: CONTRACTS });
  assert.deepEqual(browser.map((def) => [def.name, def.gateName, def.settingsKey, def.replaySafe]), [["snapshot", "host:browser/snapshot", "browser", true], ["run", "host:browser/run", "browser", false]]);
  for (const [i, def] of browser.entries()) {
    assert.equal(def.description, CONTRACTS[i].description);
    assert.equal(def.parameters, CONTRACTS[i].parameters, "the contract's own schema object, not a copy");
  }
  assert.throws(() => capabilityToolDefs("browser"), /the browser's definitions are pi-browser's BROWSER_TOOLS, which the host passes as browserTools/);
  assert.throws(() => createRegistry({ maxExecS: 600, shell: "local", kinds: ["browser"], executors: { ...injected, browser: browserExecutors() } }), /browserTools/);
});

test("a kind's def with no executor is refused when the registry is built, naming the tool", () => {
  const { run: _run, ...partial } = browserExecutors();
  assert.throws(() => createRegistry({ maxExecS: 600, shell: "local", kinds: ["browser"], executors: { ...injected, browser: partial }, browserTools: CONTRACTS }), /no executor for run/);
  assert.throws(() => createRegistry({ maxExecS: 600, shell: "local", kinds: ["browser"], executors: injected, browserTools: CONTRACTS }), /no executor for snapshot/);
  // desktop and phone run on the kernel's own executors, over the hands' ports.
  assert.doesNotThrow(() => createRegistry({ maxExecS: 600, shell: "none", kinds: ["desktop", "phone"], executors: injected }));
});

test("desktop_screen: the screen's shot as an image in the answer's images; a region goes to the port as given", async () => {
  const screen = fakeScreen();
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], executors: injected });
  const hands = handsWith({ screen, input: fakeInput() });
  const shot = await registry.invoke("desktop_screen", {}, { hands });
  assert.equal(shot.error, undefined);
  assert.equal(shot.text, "A screenshot of the whole screen, 1280x800 pixels.");
  assert.deepEqual(shot.images, [{ mimeType: "image/png", data: Buffer.from(PNG).toString("base64") }]);
  const part = await registry.invoke("desktop_screen", { region: { x: 10, y: 20, w: 300, h: 200 } }, { hands });
  assert.equal(part.text, "A screenshot of the screen's region at (10, 20), 300x200 pixels, in the whole screen's coordinates.");
  assert.deepEqual(screen.calls, [["shot", {}], ["shot", { region: { x: 10, y: 20, w: 300, h: 200 } }]]);
  const bad = await registry.invoke("desktop_screen", { region: { x: -1, y: 0, w: 0, h: 5 } }, { hands });
  assert.equal(bad.error, "region is {x, y, w, h}: x and y whole numbers from 0, w and h whole numbers above 0");
  assert.equal(screen.calls.length, 2, "a malformed region reaches no computer");
});

test("desktop_input: the batch goes to the port as given; an action outside the six runs nothing; the computer's refusal is its words", async () => {
  const input = fakeInput();
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], executors: injected });
  const hands = handsWith({ screen: fakeScreen(), input });
  const actions = [
    { type: "move", at: [5, 6] },
    { type: "click", at: [5, 6], button: "left", count: 2 },
    { type: "drag", path: [[1, 1], [9, 9]] },
    { type: "scroll", at: [5, 6], dy: 3, unit: "clicks" },
    { type: "type", text: "hello" },
    { type: "key", keys: ["ctrl", "s"] },
  ];
  const ran = await registry.invoke("desktop_input", { actions }, { hands });
  assert.equal(ran.text, "Ran 6 actions. desktop_screen shows what they did.");
  assert.deepEqual(input.calls, [["actions", actions]]);
  const outside = await registry.invoke("desktop_input", { actions: [{ type: "move", at: [1, 1] }, { type: "tap", at: [1, 1] }] }, { hands });
  assert.equal(outside.error, "action 1 is a \"tap\": an action is one of move, click, drag, scroll, type, key");
  assert.equal((await registry.invoke("desktop_input", { actions: [] }, { hands })).error, "actions is a list of 1 to 100 actions");
  assert.equal(input.calls.length, 1, "a refused batch reaches no computer");
  const refusing = handsWith({ screen: fakeScreen(), input: fakeInput({ refuse: refusal("unsupported", "action 0 (scroll): this computer scrolls by clicks, not pixels") }) });
  const said = await registry.invoke("desktop_input", { actions: [{ type: "scroll", dy: 1, unit: "px" }] }, { hands: refusing });
  assert.equal(said.error, "action 0 (scroll): this computer scrolls by clicks, not pixels");
});

test("the phone's tools: a shot as an image, a tap, a swipe, typing, its apps and opening one, each on the phone's port", async () => {
  const phone = fakePhone();
  const registry = createRegistry({ maxExecS: 600, shell: "none", kinds: ["phone"], executors: injected });
  const hands = handsWith({ phone });
  const shot = await registry.invoke("phone_screen", {}, { hands });
  assert.equal(shot.text, "A screenshot of the phone's screen, 1080x2400 pixels.");
  assert.deepEqual(shot.images, [{ mimeType: "image/png", data: Buffer.from(PNG).toString("base64") }]);
  assert.equal((await registry.invoke("phone_tap", { x: 100, y: 200 }, { hands })).text, "Tapped at (100, 200).");
  assert.equal((await registry.invoke("phone_swipe", { from: { x: 500, y: 1800 }, to: { x: 500, y: 600 } }, { hands })).text, "Swiped from (500, 1800) to (500, 600) over 300 ms.");
  assert.equal((await registry.invoke("phone_swipe", { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, duration_ms: 900 }, { hands })).text, "Swiped from (1, 2) to (3, 4) over 900 ms.");
  assert.equal((await registry.invoke("phone_type", { text: "héllo" }, { hands })).text, "Typed 5 characters.");
  assert.equal((await registry.invoke("phone_apps", {}, { hands })).text, "2 apps; com.example.mail is in front.\ncom.example.mail (Mail)\ncom.example.maps");
  assert.equal((await registry.invoke("phone_open", { id: "com.example.maps" }, { hands })).text, "Opened com.example.maps.");
  assert.deepEqual(phone.calls, [
    ["shot"], ["tap", { x: 100, y: 200 }], ["swipe", { from: { x: 500, y: 1800 }, to: { x: 500, y: 600 }, durationMs: 300 }],
    ["swipe", { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 900 }], ["type", "héllo"], ["apps.list"], ["apps.open", "com.example.maps"],
  ]);
  assert.equal((await registry.invoke("phone_tap", { x: "1", y: 2 }, { hands })).error, "x and y are whole numbers from 0, in the screenshot's pixels");
  const refusing = handsWith({ phone: fakePhone({ refuse: refusal("not_found", "no app com.nope") }) });
  assert.equal((await registry.invoke("phone_open", { id: "com.nope" }, { hands: refusing })).error, "no app com.nope");
});

test("phone_tree lists the nodes a model can tap or type into, each with its center and bounds; phone_key presses back, home or enter", async () => {
  const phone = fakePhone();
  const registry = createRegistry({ maxExecS: 600, shell: "none", kinds: ["phone"], executors: injected });
  const hands = handsWith({ phone });
  assert.equal((await registry.invoke("phone_tree", {}, { hands })).text, [
    "3 nodes you can tap or type into, of 37 on the screen. Coordinates are a phone_screen screenshot's pixels.",
    '- EditText "To" [com.example.mail:id/to]: a field, focused; center (540, 360), bounds 40,300 1000x120',
    '- Button "Send" [com.example.mail:id/send]: center (930, 2260), bounds 820,2200 220x120',
    '- Switch "Attach signature": center (970, 640), bounds 900,600 140x80',
  ].join("\n"));
  const truncated = handsWith({ phone: fakePhone({ tree: { nodes: [], total: 5000, truncated: true } }) });
  assert.equal((await registry.invoke("phone_tree", {}, { hands: truncated })).text, "0 nodes you can tap or type into, of 5000 on the screen. Coordinates are a phone_screen screenshot's pixels. The phone gave only part of the screen's structure: take a phone_screen screenshot for the rest.");
  for (const key of ["back", "home", "enter"]) assert.equal((await registry.invoke("phone_key", { key }, { hands })).text, `Pressed ${key}.`);
  assert.equal((await registry.invoke("phone_key", { key: "volume_up" }, { hands })).error, "key is back, home or enter");
  assert.deepEqual(phone.calls, [["tree"], ["key", "back"], ["key", "home"], ["key", "enter"]]);
  const def = capabilityToolDefs("phone").find((d) => d.name === "phone_key");
  assert.deepEqual(def.parameters.properties.key.enum, ["back", "home", "enter"]);
});

test("phone_tree's answer is bounded: past PHONE_TREE_MAX_NODES nodes, or PHONE_TREE_MAX_CHARS characters, one line says how many more were not shown", async () => {
  const registry = createRegistry({ maxExecS: 600, shell: "none", kinds: ["phone"], executors: injected });
  const button = (i, text = `Row ${i}`) => ({ role: "android.widget.Button", text, bounds: { x: 0, y: i * 10, w: 100, h: 10 }, clickable: true, editable: false });
  // Many nodes: the first PHONE_TREE_MAX_NODES are listed, then one line for the rest.
  const many = Array.from({ length: PHONE_TREE_MAX_NODES + 250 }, (_, i) => button(i));
  const listed = (await registry.invoke("phone_tree", {}, { hands: handsWith({ phone: fakePhone({ tree: { nodes: many, total: 5000, truncated: false } }) }) })).text.split("\n");
  assert.equal(listed[0], `${many.length} nodes you can tap or type into, of 5000 on the screen. Coordinates are a phone_screen screenshot's pixels.`);
  assert.equal(listed.length, 1 + PHONE_TREE_MAX_NODES + 1);
  assert.equal(listed.at(-1), "250 more nodes not shown.");
  // Long texts: the answer stops within PHONE_TREE_MAX_CHARS, each node's text clipped, the rest counted.
  const long = Array.from({ length: 100 }, (_, i) => button(i, "x".repeat(5000)));
  const text = (await registry.invoke("phone_tree", {}, { hands: handsWith({ phone: fakePhone({ tree: { nodes: long, total: 100, truncated: false } }) }) })).text;
  assert.ok(text.length <= PHONE_TREE_MAX_CHARS, `${text.length} characters`);
  const shown = text.split("\n").filter((line) => line.startsWith("- ")).length;
  assert.ok(shown > 0 && shown < 100, `${shown} shown`);
  assert.equal(text.split("\n").at(-1), `${100 - shown} more nodes not shown.`);
});

test("the browser kind's tools run on the host's executors, which reach the browser through the hands' CDP connect", async () => {
  const browser = fakeBrowser();
  const seen = [];
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["browser"], executors: { ...injected, browser: browserExecutors(seen) }, browserTools: CONTRACTS });
  const said = await registry.invoke("snapshot", { includeIframes: false }, { hands: handsWith({ browser }) });
  assert.equal(said.text, "snapshot ran");
  assert.deepEqual(browser.calls, [["connect"], ["send", "Fake.snapshot", { includeIframes: false }]]);
});

test("a kind tool the run does not have is refused in words naming the setting, and a port the hands lack says the same", async () => {
  const local = createRegistry({ maxExecS: 600, shell: "local", executors: injected, browserTools: CONTRACTS });
  const { hands } = localHands();
  assert.equal((await local.invoke("desktop_screen", {}, { hands })).error, words("desktop_screen", "desktop"));
  assert.equal((await local.invoke("phone_tap", { x: 1, y: 1 }, { hands })).error, words("phone_tap", "phone"));
  assert.equal((await local.invoke("snapshot", {}, { hands })).error, words("snapshot", "browser"));
  assert.equal((await local.invoke("nothing_here", {}, { hands })).error, "there is no host tool nothing_here in this run");
  // Built with the kind, called on hands with no such port (the computer lacks it): the same words, and nothing runs.
  const desktop = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop", "phone"], executors: injected });
  assert.equal((await desktop.invoke("desktop_screen", {}, { hands })).error, words("desktop_screen", "desktop"));
  assert.equal((await desktop.invoke("desktop_input", { actions: [{ type: "move", at: [1, 1] }] }, { hands })).error, words("desktop_input", "desktop"));
  assert.equal((await desktop.invoke("phone_screen", {}, { hands })).error, words("phone_screen", "phone"));
});

test("the background tools' refusal with no computer names the setting", async () => {
  assert.equal(NEEDS_A_COMPUTER, "Background programs need a computer: run this agent with a sandbox computer (Settings → Computers; place sandbox in the v2 API).");
  const { hands } = localHands();
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], executors: injected });
  assert.equal((await registry.invoke("bash_background", { command: "true" }, { hands })).error, NEEDS_A_COMPUTER);
});

test("only an abort throws: a kind tool whose call has aborted rejects", async () => {
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], executors: injected });
  const hands = handsWith({ screen: fakeScreen({ refuse: Object.assign(new Error("aborted"), { name: "AbortError" }) }), input: fakeInput() });
  await assert.rejects(registry.invoke("desktop_screen", {}, { hands, signal: AbortSignal.abort() }), (error) => error.name === "AbortError");
});
