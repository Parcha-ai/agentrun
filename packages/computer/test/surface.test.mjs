// The surface's one core against a fake computer: observe and act through the ui group, the screen-and-input fallback,
// the outline, the shell and files, and a script's `computer` (built from its one-line prelude in a fresh context)
// answering exactly what the core answers.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { COMPUTER_CALL_GLOBAL, chordKeys, createSurface, opsOf, outlineOf, scriptPrelude, SurfaceError, withoutImageData } from "../dist/surface/index.js";
import { fakeComputer, PNG } from "./fake-surface-driver.mjs";

const surfaceOf = (options) => {
	const fake = fakeComputer(options);
	return { ...fake, surface: createSurface(fake.client, fake.hello) };
};

test("observe through ui: the outline names each element by ref, indented under its parent", async () => {
	const { surface, calls } = surfaceOf();
	const answer = await surface.call("observe", {});
	assert.deepEqual(calls.at(-1), { method: "ui.observe", params: {} });
	assert.equal(answer.value.id, "s1");
	assert.deepEqual(answer.images, []);
	assert.equal(
		answer.text,
		[
			'state s1 · com.apple.Notes "Notes" · window "Untitled" 800×600 pt',
			'@e1 window "Notes"',
			'  @e2 textbox "Title" [focused]',
			'  @e3 button "Save"',
		].join("\n"),
	);
	assert.equal(answer.value.outline, answer.text);
});

test("observe with image: the window's image travels beside the text, and the text gives its scale", async () => {
	const { surface, calls } = surfaceOf();
	const answer = await surface.call("observe", { app: "com.apple.Notes", image: true });
	assert.deepEqual(calls.at(-1).params, { target: { app: "com.apple.Notes" }, image: true });
	assert.equal(answer.images.length, 1);
	assert.deepEqual(answer.images[0], { type: "image", mimeType: "image/png", data: PNG, width: 2, height: 1 });
	assert.match(answer.text, /image: 2×1 px of the window's 800×600 points$/);
	assert.deepEqual(withoutImageData(answer.value).image, { type: "image", mimeType: "image/png", width: 2, height: 1 });
});

test("observe with image where ui.image is off: the whole screen instead, said in the text", async () => {
	const { surface, calls } = surfaceOf({ features: {} });
	const answer = await surface.call("observe", { image: true });
	assert.deepEqual(calls.map((call) => call.method), ["ui.observe", "screen.shot"]);
	assert.equal(answer.images[0].width, 1440);
	assert.match(answer.text, /image: the whole screen, 1440×900 px/);
});

test("act: each step's route and readback, the expect, and the new state", async () => {
	const { surface, calls } = surfaceOf();
	const answer = await surface.call("act", { app: "com.apple.Notes", steps: [{ set: "@e2", value: "Groceries" }, { press: "@e3" }], expect: { text: "Saved" } });
	assert.deepEqual(calls.at(-1), { method: "ui.act", params: { target: { app: "com.apple.Notes" }, steps: [{ set: "@e2", value: "Groceries" }, { press: "@e3" }], expect: { text: "Saved" } } });
	assert.deepEqual(answer.value, { steps: [{ route: "semantic", verified: true }, { route: "semantic", verified: true }], expect: "met", changed: true, state: "s2" });
	assert.equal(answer.text, ["1. set: semantic, verified", "2. press: semantic, verified", "expect: met", "changed · state s2"].join("\n"));
});

test("act at a point takes the app's last observed state, and a refused step says why and stops the rest", async () => {
	const { surface, calls } = surfaceOf();
	await surface.call("observe", { app: "com.apple.Notes" });
	const ok = await surface.call("act", { app: "com.apple.Notes", steps: [{ click: [20, 20] }] });
	assert.equal(calls.at(-1).params.state, "s1");
	assert.deepEqual(ok.value.steps, [{ route: "background", verified: false }]);
	const stale = await surface.call("act", { app: "com.apple.Notes", state: "s1", steps: [{ click: [20, 20] }, { press: "@e3" }] });
	assert.equal(stale.text, ["1. click: refused (stale): the window changed since s1", "1 later steps did not run", "changed · state s3"].join("\n"));
});

test("act with observe: one call returns the new observation, its outline after the steps", async () => {
	const { surface } = surfaceOf();
	const answer = await surface.call("act", { steps: [{ press: "@e3" }], observe: true });
	assert.equal(answer.value.after.id, "s2");
	assert.match(answer.text, /\n\nstate s2 · .*\n.*\n.*\n.*\n {2}@e4 text "Saved"$/);
});

test("an empty act with an expect is a wait, and gone waits for the opposite", async () => {
	const { surface } = surfaceOf();
	const answer = await surface.call("act", { steps: [], expect: { text: "Saved", gone: true } });
	assert.equal(answer.value.expect, "met");
	assert.equal(answer.text, ["expect: met", "unchanged · state s2"].join("\n"));
});

test("without the ui group: observe is the screen, read whole across screen.read; act maps steps at points to input", async () => {
	const { surface, calls } = surfaceOf({ groups: ["screen", "input.pointer", "input.keys"], split: 10 });
	const seen = await surface.call("observe", {});
	assert.deepEqual(calls.map((call) => call.method), ["screen.shot", "screen.read"]);
	assert.equal(seen.images[0].data, PNG);
	assert.match(seen.text, /^screen 1440×900 px · this computer has no ui group/);
	const acted = await surface.call("act", { steps: [{ click: [5, 6], count: 2 }, { type: "hi" }, { key: "cmd+s" }, { scroll: [1, 1], dy: 120 }, { drag: [[0, 0], [9, 9]] }, { nav: "back" }] });
	assert.deepEqual(calls.at(-1), {
		method: "input.actions",
		params: {
			actions: [
				{ type: "click", at: [5, 6], count: 2 },
				{ type: "type", text: "hi" },
				{ type: "key", keys: ["cmd", "s"] },
				{ type: "scroll", at: [1, 1], unit: "clicks", dy: 1 },
				{ type: "drag", path: [[0, 0], [9, 9]] },
				{ type: "button", name: "back" },
			],
		},
	});
	assert.equal(acted.value.steps.length, 6);
	assert.deepEqual(acted.value.steps[0], { route: "input", verified: false });
	assert.equal(acted.value.state, undefined);
	assert.equal(acted.value.changed, undefined);
});

test("without the ui group: a ref, an into or an expect is refused before anything runs", async () => {
	const { surface, calls } = surfaceOf({ groups: ["screen", "input.pointer"] });
	await assert.rejects(surface.call("act", { steps: [{ press: "@e3" }] }), (error) => error instanceof SurfaceError && error.kind === "unsupported" && /needs the ui group/.test(error.message));
	await assert.rejects(surface.call("act", { steps: [{ click: "@e3" }] }), /names an element/);
	await assert.rejects(surface.call("act", { steps: [{ type: "x", into: "@e2" }] }), /click the field first/);
	await assert.rejects(surface.call("act", { steps: [], expect: { text: "x" } }), /can't check an expect/);
	assert.equal(calls.length, 0);
});

test("a touch-only phone: click is a tap, a right click a long press, drag a swipe", async () => {
	const { surface, calls } = surfaceOf({ groups: ["screen", "input.touch", "apps"], os: "android", kind: "android" });
	await surface.call("act", { steps: [{ click: [1, 2] }, { click: [1, 2], button: "right" }, { drag: [[0, 0], [0, 50]], ms: 300 }] });
	assert.deepEqual(calls.at(-1).params.actions, [
		{ type: "tap", at: [1, 2] },
		{ type: "long_press", at: [1, 2] },
		{ type: "swipe", path: [[0, 0], [0, 50]], ms: 300 },
	]);
});

test("without the ui group: a scroll is wheel clicks (about 120 px each, at least one, at most 50), never pixels", async () => {
	const { surface, calls } = surfaceOf({ groups: ["screen", "input.pointer"] });
	await surface.call("act", { steps: [{ scroll: [1, 1], dy: 600 }, { scroll: [1, 1], dy: -30, dx: 240 }, { scroll: [1, 1], dy: 99999 }] });
	assert.deepEqual(calls.at(-1).params.actions, [
		{ type: "scroll", at: [1, 1], unit: "clicks", dy: 5 },
		{ type: "scroll", at: [1, 1], unit: "clicks", dx: 2, dy: -1 },
		{ type: "scroll", at: [1, 1], unit: "clicks", dy: 50 },
	]);
});

test("without the ui group: a full batch with observe still runs (the settling wait is its own batch), and a batch the computer refuses says why", async () => {
	const { surface, calls } = surfaceOf({ groups: ["screen", "input.pointer", "input.keys"] });
	const full = await surface.call("act", { steps: Array.from({ length: 100 }, () => ({ key: "a" })), observe: true });
	const sent = calls.filter((call) => call.method === "input.actions");
	assert.deepEqual(sent.map((call) => call.params.actions.length), [100, 1]);
	assert.equal(full.value.steps.length, 100);
	assert.ok(full.value.after, "the observation comes after the wait");
	const fake = fakeComputer({ groups: ["screen", "input.pointer", "input.keys"] });
	const call = fake.client.call.bind(fake.client);
	fake.client.call = async (method, params, options) => (method === "input.actions" && params.actions.length > 100 ? { ok: true, value: { done: 0, failed: { index: 100, kind: "limit", message: "a batch holds at most 100 actions" } } } : call(method, params, options));
	const over = await createSurface(fake.client, fake.hello).call("act", { steps: Array.from({ length: 101 }, () => ({ key: "a" })), observe: true });
	assert.deepEqual(over.value.steps, [{ error: { kind: "limit", message: "a batch holds at most 100 actions" } }]);
});

test("a refused step throws in a script, so the steps after it never run", async () => {
	const { surface, calls } = surfaceOf();
	await assert.rejects(runScript(surface, `const notes = computer.app("com.apple.Notes"); await notes.press("@e99"); await notes.key("enter");`), /step 1 was refused \(stale\): that element is gone/);
	assert.equal(calls.filter((call) => call.method === "ui.act").length, 1, "the key after the refused press was never sent");
});

test("a touch-only phone: a scroll is a swipe the other way over the distance, never a pointer scroll", async () => {
	const { surface, calls } = surfaceOf({ groups: ["screen", "input.touch", "apps"], os: "android", kind: "android" });
	await surface.call("act", { steps: [{ scroll: [100, 400], dy: 300 }, { scroll: [100, 400], dy: -200, dx: 50 }] });
	assert.deepEqual(calls.at(-1).params.actions, [
		{ type: "swipe", path: [[100, 400], [100, 100]] },
		{ type: "swipe", path: [[100, 400], [50, 600]] },
	]);
});

test("a point step after an act takes the last observation's state, not the one the act returned unseen", async () => {
	const { surface, calls } = surfaceOf();
	await surface.call("observe", { app: "com.apple.Notes" });
	await surface.call("act", { app: "com.apple.Notes", steps: [{ press: "@e3" }] });
	await surface.call("act", { app: "com.apple.Notes", steps: [{ click: [20, 20] }] });
	assert.equal(calls.at(-1).params.state, "s1", "the state the model saw, so the changed window refuses the click as stale");
});

test("an act that names a state and no app observes that state's app afterwards, not the one in front", async () => {
	const { surface, calls } = surfaceOf();
	await surface.call("observe", { app: "com.example.background" });
	await surface.call("act", { state: "s1", steps: [{ press: "@e3" }], observe: true });
	assert.deepEqual(calls.at(-1), { method: "ui.observe", params: { target: { app: "com.example.background" } } });
});

test("a directory listing past its pages throws a limit error instead of returning part of it", async () => {
	const fake = fakeComputer();
	const call = fake.client.call.bind(fake.client);
	fake.client.call = async (method, params, options) =>
		method === "files.list" ? { ok: true, value: { entries: [{ path: `/d/f${params.offset ?? 0}`, type: "file", size: 1, mode: 0o644, mtimeMs: 1, uid: 0, gid: 0 }], truncated: true } } : call(method, params, options);
	await assert.rejects(createSurface(fake.client, fake.hello).call("files.list", { path: "/d" }), /more than 10 entries/);
});

test("input.act: a failed action is the last step, with its kind", async () => {
	const { surface } = surfaceOf({ groups: ["screen", "input.touch"] });
	const answer = await surface.call("input.act", { actions: [{ type: "tap", at: [1, 1] }, { type: "pinch", at: [1, 1], scale: 2 }, { type: "tap", at: [2, 2] }] });
	assert.deepEqual(answer.value.steps, [{ route: "input", verified: false }, { error: { kind: "unsupported", message: "no pinch here" } }]);
	assert.equal(answer.text, ["1. tap: input", "2. pinch: refused (unsupported): no pinch here", "1 later steps did not run"].join("\n"));
});

test("ops follow the groups, and an op the computer lacks is refused as unsupported", async () => {
	assert.deepEqual(opsOf(["exec"]), ["shell.run"]);
	assert.deepEqual(opsOf(["ui"]), ["observe", "act"]);
	const { surface, calls } = surfaceOf({ groups: ["exec"] });
	await assert.rejects(surface.call("screenshot", {}), (error) => error.kind === "unsupported");
	await assert.rejects(surface.call("nope", {}), (error) => error.kind === "invalid");
	assert.equal(calls.length, 0);
});

test("shell and files: a string runs in sh -c, output decoded; a file written in chunks reads back whole", async () => {
	const { surface, calls } = surfaceOf();
	const ran = await surface.call("shell.run", { command: "echo hi" });
	assert.deepEqual(calls.at(-1).params, { argv: ["sh", "-c", "echo hi"], timeoutMs: 60_000 });
	assert.equal(ran.value.stdout, "sh -c echo hi");
	const big = "x".repeat(600 * 1024);
	await surface.call("files.write", { path: "/tmp/a.txt", data: big });
	assert.deepEqual(calls.filter((call) => call.method === "files.write").map((call) => call.params.offset), [undefined, 512 * 1024]);
	assert.equal((await surface.call("files.read", { path: "/tmp/a.txt" })).value, big);
	assert.deepEqual((await surface.call("files.stat", { path: "/tmp/a.txt" })).value, { path: "/tmp/a.txt", type: "file", size: big.length, mtimeMs: 1 });
	await assert.rejects(surface.call("files.read", { path: "/nope" }), (error) => error.kind === "not_found");
});

test("a Windows computer runs a string command in cmd", async () => {
	const { surface, calls } = surfaceOf({ os: "windows" });
	await surface.call("shell.run", { command: "dir" });
	assert.deepEqual(calls.at(-1).params.argv, ["cmd.exe", "/d", "/s", "/c", "dir"]);
});

test("chords split on +, and a trailing + is the plus key", () => {
	assert.deepEqual(chordKeys("ctrl+shift+t"), ["ctrl", "shift", "t"]);
	assert.deepEqual(chordKeys("ctrl++"), ["ctrl", "+"]);
	assert.deepEqual(chordKeys("+"), ["+"]);
});

test("the outline stops within its cap and counts what it left out", () => {
	const nodes = Array.from({ length: 2000 }, (_, index) => ({ ref: `@e${index}`, role: "listitem", name: `Row number ${index} of a long list`, bounds: [0, 0, 1, 1] }));
	const outline = outlineOf("head", nodes, false);
	assert.ok(outline.length <= 12_000, `outline is ${outline.length} chars`);
	assert.match(outline, /\n… \d+ more elements not shown/);
	assert.match(outlineOf("head", [], false), /no elements/);
});

test("an element's desc is on its line; a window whose tree is off says why, and its image comes whole", async () => {
	const row = { ref: "@e5", role: "button", name: "Network & internet", desc: "Mobile, Wi-Fi, hotspot", bounds: [0, 0, 1, 1] };
	assert.equal(outlineOf("head", [row], false), 'head\n@e5 button "Network & internet" ("Mobile, Wi-Fi, hotspot")');
	const fake = fakeComputer();
	const call = fake.client.call.bind(fake.client);
	fake.client.call = async (method, params, options) =>
		method === "ui.observe"
			? { ok: true, value: { state: "s1", app: { id: "com.example.game", name: "Game" }, window: { id: "w1", bounds: [0, 0, 800, 600] }, nodes: [], empty: "this app draws its own window: the tree is off here", image: { format: "png", data: PNG, width: 2, height: 1 }, truncated: false } }
			: call(method, params, options);
	const answer = await createSurface(fake.client, fake.hello).call("observe", {});
	assert.match(answer.text, /\(no elements: this app draws its own window: the tree is off here; act at points in the window's image\)/);
	assert.equal(answer.images.length, 1, "the image the computer sent instead, unasked");
});

/** A script run the way an isolate runs it: the one-line prelude, then the code, in a fresh context whose only global
 *  is the host's call. */
async function runScript(surface, code) {
	const context = vm.createContext({ [COMPUTER_CALL_GLOBAL]: async (op, args) => (await surface.call(op, args)).value });
	const source = `(async () => { ${scriptPrelude(surface.card)}\n${code}\n})()`;
	return vm.runInContext(source, context);
}

test("a script's computer answers what the core answers, and has only the computer's namespaces", async () => {
	const one = surfaceOf();
	const two = surfaceOf();
	const viaScript = await runScript(one.surface, `const notes = computer.app("com.apple.Notes"); await notes.observe(); return await notes.act([{ press: "@e3" }], { expect: { text: "Saved" } });`);
	const viaTool = await two.surface.call("act", { app: "com.apple.Notes", steps: [{ press: "@e3" }], expect: { text: "Saved" } });
	assert.equal(JSON.stringify(viaScript), JSON.stringify(viaTool.value));
	const names = await runScript(surfaceOf({ groups: ["exec"] }).surface, "return Object.keys(computer)");
	assert.deepEqual([...names], ["card", "shell"]);
	// A ui computer's script keeps raw input: the screen-level way to what one app's window can't reach.
	const ui = await runScript(surfaceOf({ groups: ["ui", "screen", "input.pointer", "input.keys"] }).surface, "return Object.keys(computer)");
	assert.deepEqual([...ui], ["card", "app", "screen", "input"]);
	const raw = await runScript(surfaceOf({ groups: ["screen", "input.pointer"] }).surface, "return Object.keys(computer)");
	assert.deepEqual([...raw], ["card", "screen", "input"]);
});

test("a script finds elements in the last observation with no call, and a point step carries its state", async () => {
	const { surface, calls } = surfaceOf();
	const found = await runScript(
		surface,
		`const notes = computer.app("com.apple.Notes");
		await notes.observe();
		const [save] = notes.find({ role: "button", text: /save/i });
		await notes.click([save.bounds[0] + 1, save.bounds[1] + 1]);
		return save.ref;`,
	);
	assert.equal(found, "@e3");
	assert.deepEqual(calls.map((call) => call.method), ["ui.observe", "ui.act"]);
	assert.equal(calls[1].params.state, "s1");
});

test("a script's find() takes the app's own id, and its text matches an element's desc", async () => {
	const fake = fakeComputer();
	const call = fake.client.call.bind(fake.client);
	const nodes = [
		{ ref: "@e1", role: "button", name: "Network & internet", desc: "Mobile, Wi-Fi, hotspot", id: "network", bounds: [0, 0, 10, 10] },
		{ ref: "@e2", role: "button", name: "Battery", desc: "80%", id: "battery", bounds: [0, 10, 10, 10] },
	];
	fake.client.call = async (method, params, options) =>
		method === "ui.observe" ? { ok: true, value: { state: "s1", app: { id: "com.android.settings", name: "Settings" }, window: { id: "w1", bounds: [0, 0, 360, 800] }, nodes, truncated: false } } : call(method, params, options);
	const surface = createSurface(fake.client, fake.hello);
	const found = await runScript(surface, `const app = computer.app(); await app.observe(); return [app.find({ text: "hotspot" }).map((n) => n.ref), app.find({ id: "battery" }).map((n) => n.ref), app.find({ role: "button", id: "nope" }).length];`);
	assert.deepEqual(JSON.parse(JSON.stringify(found)), [["@e1"], ["@e2"], 0]);
});

test("a script's errors carry the computer's words", async () => {
	const { surface } = surfaceOf({ groups: ["screen", "input.pointer"] });
	await assert.rejects(runScript(surface, `return computer.input.act([]).then(() => computer.screen.shot()).then(() => { throw new Error("got here"); })`), /got here/);
	await assert.rejects(runScript(surfaceOf().surface, `return computer.app("x").find({})`), /observe\(\) first/);
});
