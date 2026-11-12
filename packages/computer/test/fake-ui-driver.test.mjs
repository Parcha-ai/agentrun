// The fake ui driver over the wire, and the ui conformance cases on it: a desktop, a phone and one with features off
// pass, each feature off refused with its sentence; a driver whose refs do not survive fails ui.refs-stable. Then the
// driver's own rules: each connection its own refs, settle through a transition, a point stale after a resize and good
// after a move, the line server's error codes and cancel, and the CLI on stdin and stdout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { conformanceCases, findNodes, formatReport, refusedStep, runConformance, UiSession } from "../dist/index.js";
import { connectUi, FakeUiDriver, fakeUiConnection, fakeUiProvider, NEXT_ANIMATE_MS, NEXT_MS, UI_FIXTURE } from "../dist/fake-ui-driver.js";

const APP = UI_FIXTURE.id;
const UI_CASES = ["ui.hello", "ui.fixture-shape", "ui.refs-stable", "ui.expect", "ui.stale-ref", "ui.stale-point", "ui.route-reported", "ui.features-declared", "ui.features-off-refused"];
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasonOf = (report, id) => report.results.find((r) => r.id === id)?.reason ?? "";
const run = (provider, ids = UI_CASES) => runConformance(provider, { image: "fake-ui", patience: 5000, cases: conformanceCases.filter((c) => ids.includes(c.id)) });

test("the ui cases pass on a fake desktop: ui.nav off, refused with its sentence", { timeout: 60_000 }, async () => {
	const provider = fakeUiProvider();
	const report = await run(provider);
	for (const id of UI_CASES) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}\n${formatReport(report)}`);
	assert.deepEqual(report.cleanup.left, []);
	assert.equal(provider.drivers.size, 0, "every computer the run made is released");
});

test("the ui cases pass on a fake phone: ui.nav on, apps.background off and refused with its sentence", { timeout: 60_000 }, async () => {
	const report = await run(fakeUiProvider({ os: "android", kind: "android" }));
	for (const id of UI_CASES) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}`);
});

test("with ui.image and ui.foreground off, both are refused with their sentences, and the foreground route skips in words", { timeout: 60_000 }, async () => {
	const features = { "ui.image": { off: "this build reads no pixels" }, "ui.foreground": { off: "the user's pointer is theirs" } };
	const report = await run(fakeUiProvider({ features }));
	for (const id of UI_CASES.filter((id) => id !== "ui.route-reported")) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}`);
	assert.equal(statuses(report)["ui.route-reported"], "skip");
	assert.match(reasonOf(report, "ui.route-reported"), /the foreground route is not tested: ui.foreground is off here: the user's pointer is theirs/);
});

test("with ui.tree off, observe answers the image and the reason with no nodes, an expect is refused, and the fixture's cases skip in words", { timeout: 60_000 }, async () => {
	const why = "Accessibility is not granted to Computerd: System Settings > Privacy & Security > Accessibility";
	const report = await run(fakeUiProvider({ features: { "ui.tree": { off: why } } }));
	for (const id of ["ui.hello", "ui.features-off-refused"]) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}`);
	for (const id of ["ui.fixture-shape", "ui.refs-stable", "ui.stale-point"]) {
		assert.equal(statuses(report)[id], "skip", id);
		assert.equal(reasonOf(report, id), `the fixture's cases read its elements, and ui.tree is off here: ${why}`);
	}
	const c = await fakeUiConnection({ features: { "ui.tree": { off: why } } });
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	assert.deepEqual(seen.nodes, []);
	assert.equal(seen.empty, `ui.tree is off here: ${why}`);
	assert.equal(seen.image.width, 320,"the image comes unasked, at the window's size within the default edge");
	const clicked = await c.client.call("ui.act", { state: seen.state, steps: [{ click: [40, 150] }] });
	assert.deepEqual(clicked.value.steps, [{ route: "background", verified: false }], "a point from the image-only state still lands");
	await c.close();
	const both = await run(fakeUiProvider({ features: { "ui.tree": { off: why }, "ui.image": { off: "Screen Recording is not granted" } } }), ["ui.features-off-refused"]);
	assert.equal(statuses(both)["ui.features-off-refused"], "pass", reasonOf(both, "ui.features-off-refused"));
});

test("the canvas: a driver blind to which views background input reaches posts the click unverified and passes; one that verifies a click that never landed fails", { timeout: 60_000 }, async () => {
	const c = await fakeUiConnection({ blindBackground: true });
	await c.client.call("apps.launch", { id: APP });
	const canvasOf = async () => (await c.client.call("ui.observe", {})).value.nodes.find((n) => n.id === "canvas");
	const canvas = await canvasOf();
	assert.equal(canvas.value, "0");
	const posted = await c.client.call("ui.act", { steps: [{ click: canvas.ref }] });
	assert.deepEqual(posted.value.steps, [{ route: "background", verified: false }], "posted, and it cannot tell whether it landed");
	assert.equal((await canvasOf()).value, "0", "it did not land");
	const real = await c.client.call("ui.act", { steps: [{ click: canvas.ref }], foreground: true });
	assert.deepEqual(real.value.steps, [{ route: "foreground", verified: true }]);
	assert.equal((await canvasOf()).value, "1", "real input reached it, and the count read back verifies it");
	await c.close();
	const blind = await run(fakeUiProvider({ blindBackground: true }), ["ui.route-reported"]);
	assert.equal(statuses(blind)["ui.route-reported"], "pass", reasonOf(blind, "ui.route-reported"));
	class Boasting extends FakeUiDriver {
		async run(step, context) {
			const done = await super.run(step, context);
			return done.ok && "click" in step ? { ok: true, value: { ...done.value, verified: true } } : done;
		}
	}
	const boasting = await run(fakeUiProvider({ blindBackground: true }, (options) => new Boasting(options)), ["ui.route-reported"]);
	assert.equal(statuses(boasting)["ui.route-reported"], "fail");
	assert.match(reasonOf(boasting, "ui.route-reported"), /the click answered verified, and the canvas's count did not move/);
});

test("an act whose expect a poll meets mid-transition hands back the settled window; with ui.tree off, a point goes stale when the frame changes", { timeout: 60_000 }, async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	const next = (await c.client.call("ui.observe", {})).value.nodes.find((n) => n.id === "next");
	const opened = await c.client.call("ui.act", { steps: [{ press: next.ref }], expect: { text: "Second page" } });
	assert.equal(opened.value.expect, "met");
	const blank = await c.client.call("ui.act", { state: opened.value.state, steps: [{ click: [300, 300] }] });
	assert.deepEqual(blank.value.steps, [{ route: "background", verified: false }], "the state is the settled second page, not a frame of its transition");
	await c.close();
	const off = await fakeUiConnection({ features: { "ui.tree": { off: "Accessibility is not granted" } } });
	await off.client.call("apps.launch", { id: APP });
	const home = (await off.client.call("ui.observe", {})).value;
	const atNext = [150, 150];
	assert.deepEqual((await off.client.call("ui.act", { state: home.state, steps: [{ click: atNext }] })).value.steps, [{ route: "background", verified: false }]);
	await new Promise((resolve) => setTimeout(resolve, NEXT_MS + NEXT_ANIMATE_MS + 100));
	const again = await off.client.call("ui.act", { state: home.state, steps: [{ click: atNext }] });
	assert.equal(again.value.steps[0].error?.kind, "stale", `the window shows the second page now, which the home state's point knows nothing of: ${JSON.stringify(again.value.steps)}`);
	await off.close();
});

test("typing and keys take the routes the features allow, refused in the off features' own words", async () => {
	const features = { "ui.background": { off: "posting input is off" }, "ui.foreground": { off: "the user's pointer is theirs" } };
	const c = await fakeUiConnection({ features });
	await c.client.call("apps.launch", { id: APP });
	const name = (await c.client.call("ui.observe", {})).value.nodes.find((n) => n.id === "name");
	for (const step of [{ type: "Ada", into: name.ref }, { key: "enter" }]) {
		const refused = (await c.client.call("ui.act", { steps: [step] })).value.steps[0].error;
		assert.equal(refused.kind, "unsupported");
		assert.match(refused.message, /posting input is off, and ui.foreground is off here: the user's pointer is theirs/);
	}
	assert.equal((await c.client.call("ui.observe", {})).value.nodes.find((n) => n.id === "name").value, "", "the field is untouched");
	await c.close();
	const canvas = await fakeUiConnection({ features: { "ui.foreground": { off: "the user's pointer is theirs" } } });
	await canvas.client.call("apps.launch", { id: APP });
	const ref = (await canvas.client.call("ui.observe", {})).value.nodes.find((n) => n.id === "canvas").ref;
	const refused = (await canvas.client.call("ui.act", { steps: [{ click: ref }] })).value.steps[0].error;
	assert.equal(refused.message, "no route reaches it: Canvas takes foreground input only, and ui.foreground is off here: the user's pointer is theirs");
	await canvas.close();
});

test("a press is verified only when its effect is there at once; a double click lands twice", async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	const ref = (id) => seen.nodes.find((n) => n.id === id).ref;
	assert.deepEqual((await c.client.call("ui.act", { steps: [{ press: ref("wifi") }] })).value.steps, [{ route: "semantic", verified: true }], "a switch's toggle reads back at once");
	assert.deepEqual((await c.client.call("ui.act", { steps: [{ press: ref("save") }] })).value.steps, [{ route: "semantic", verified: false }], "Save shows Saved only later");
	const twice = await c.client.call("ui.act", { steps: [{ click: ref("canvas"), count: 2 }], foreground: true });
	assert.deepEqual(twice.value.steps, [{ route: "foreground", verified: true }]);
	assert.equal((await c.client.call("ui.observe", {})).value.nodes.find((n) => n.id === "canvas").value, "2");
	await c.close();
});

test("ui.observe-shape reads the ui fixture on a computer with no exec or files, desktop and phone", { timeout: 60_000 }, async () => {
	for (const options of [{}, { os: "android", kind: "android" }]) {
		const report = await run(fakeUiProvider(options), ["ui.observe-shape"]);
		assert.equal(statuses(report)["ui.observe-shape"], "pass", `${options.kind ?? "desktop"}: ${reasonOf(report, "ui.observe-shape")}`);
	}
});

test("an expect never matches a secure field's value", async () => {
	const app = {
		id: "test.login",
		name: "Login",
		start: "a",
		size: [300, 200],
		screens: { a: { elements: [{ key: "pw", role: "textbox", name: "Password", flags: ["secure"], value: "hunter2", bounds: [10, 10, 200, 28] }] } },
	};
	const c = await fakeUiConnection({ apps: [app] });
	await c.client.call("apps.launch", { id: app.id });
	const probed = await c.client.call("ui.act", { steps: [], expect: { text: "hunter2", timeoutMs: 200 } });
	assert.equal(probed.value.expect, "unmet", "the password is not readable through an expect");
	const named = await c.client.call("ui.act", { steps: [], expect: { text: "Password", timeoutMs: 200 } });
	assert.equal(named.value.expect, "met", "its name still is");
	await c.close();
});

test("two apps' elements of one scripted key are two elements: a ref of the app behind is stale, not the front app's", async () => {
	const appOf = (id) => ({ id, name: id, start: "a", size: [300, 200], screens: { a: { elements: [{ key: "go", role: "switch", name: "Go", bounds: [10, 10, 80, 28] }] } } });
	const c = await fakeUiConnection({ apps: [appOf("test.one"), appOf("test.two")] });
	await c.client.call("apps.launch", { id: "test.one" });
	const one = (await c.client.call("ui.observe", {})).value.nodes[0].ref;
	await c.client.call("apps.launch", { id: "test.two" });
	const two = (await c.client.call("ui.observe", {})).value.nodes[0].ref;
	assert.notEqual(one, two);
	const pressed = await c.client.call("ui.act", { steps: [{ press: one }] });
	assert.equal(pressed.value.steps[0].error?.kind, "stale", JSON.stringify(pressed.value.steps));
	assert.equal((await c.client.call("ui.observe", {})).value.nodes[0].flags?.includes("checked") ?? false, false, "test.two's switch is untouched");
	await c.close();
});

test("nav home on a fake phone settles on its home screen, and the app comes back with apps.launch", async () => {
	const c = await fakeUiConnection({ os: "android", kind: "android" });
	await c.client.call("apps.launch", { id: APP });
	const home = await c.client.call("ui.act", { steps: [{ nav: "home" }] });
	assert.deepEqual(home.value.steps, [{ route: "semantic", verified: true }], JSON.stringify(home));
	const seen = (await c.client.call("ui.observe", {})).value;
	assert.equal(seen.app.id, "home");
	assert.deepEqual(seen.nodes, []);
	const tapped = await c.client.call("ui.act", { state: seen.state, steps: [{ click: [10, 10] }] });
	assert.equal(tapped.value.steps[0].error?.kind, "unsupported");
	await c.client.call("apps.launch", { id: APP });
	assert.equal((await c.client.call("ui.observe", {})).value.app.id, APP);
	await c.close();
});

test("the fixture's ui cases pass on a driver whose only input is the foreground route", { timeout: 60_000 }, async () => {
	const report = await run(fakeUiProvider({ os: "android", kind: "android", features: { "ui.background": { off: "a phone has no posted input" } } }));
	for (const id of UI_CASES) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}`);
});

test("a feature refused without its declared sentence fails ui.features-off-refused", { timeout: 60_000 }, async () => {
	class Mumbling extends FakeUiDriver {
		async handle(engine, method, params, signal) {
			if (method === "apps.launch" && params?.background === true) return { ok: false, error: { code: "unsupported", message: "no" } };
			return super.handle(engine, method, params, signal);
		}
	}
	const report = await run(fakeUiProvider({ os: "android", kind: "android" }, (options) => new Mumbling(options)), ["ui.features-off-refused"]);
	assert.equal(statuses(report)["ui.features-off-refused"], "fail");
	assert.match(reasonOf(report, "ui.features-off-refused"), /carries its sentence "an app a phone opens comes to the front": no/);
});

test("a driver whose refs do not survive a change fails ui.refs-stable", { timeout: 60_000 }, async () => {
	let looks = 0;
	class Forgetful extends FakeUiDriver {
		async look(target, signal) {
			const looked = await super.look(target, signal);
			if (!looked.ok) return looked;
			const era = looks++;
			const rename = (key) => (key === undefined ? undefined : `${key}#${era}`);
			return { ok: true, value: { ...looked.value, elements: looked.value.elements.map((e) => ({ ...e, key: rename(e.key), parent: rename(e.parent) })) } };
		}
	}
	const report = await run(fakeUiProvider({}, (options) => new Forgetful(options)), ["ui.refs-stable"]);
	assert.equal(statuses(report)["ui.refs-stable"], "fail", reasonOf(report, "ui.refs-stable"));
});

test("refs and states are each connection's own; the apps are the computer's", async () => {
	const driver = new FakeUiDriver();
	const a = (await connectUi(driver)).value;
	const b = (await connectUi(driver)).value;
	assert.deepEqual(await a.client.call("apps.launch", { id: APP }), { ok: true, value: {} });
	const seen = await a.client.call("ui.observe", {});
	const save = seen.value.nodes.find((n) => n.id === "save").ref;
	const other = await b.client.call("ui.act", { steps: [{ press: save }] });
	assert.equal(other.ok, false);
	assert.equal(other.error.code, "invalid");
	assert.match(other.error.message, /is not a ref this connection was given: observe first/);
	assert.equal((await b.client.call("ui.observe", {})).value.app.id, APP, "the app a launched is in front for b");
	await a.close();
	assert.equal(driver.screenOf(APP), "home", "closing a connection leaves the computer's apps running");
	await b.close();
	driver.close();
});

test("an act settles through a transition before it answers, and its state is the settled window", async () => {
	const app = {
		id: "test.slide",
		name: "Slide",
		start: "a",
		size: [300, 200],
		screens: {
			a: { elements: [{ key: "go", role: "button", name: "Go", bounds: [10, 10, 80, 28], press: { go: "b", animateMs: 400 } }] },
			b: { elements: [{ key: "done", role: "text", name: "Done", bounds: [10, 10, 80, 28] }] },
		},
	};
	const c = await fakeUiConnection({ apps: [app] });
	await c.client.call("apps.launch", { id: app.id });
	const seen = await c.client.call("ui.observe", {});
	const began = Date.now();
	const pressed = await c.client.call("ui.act", { steps: [{ press: seen.value.nodes[0].ref }] });
	assert.ok(Date.now() - began >= 350, `the act waited for the transition: ${Date.now() - began} ms`);
	assert.equal(pressed.value.changed, true);
	const after = await c.client.call("ui.observe", { since: pressed.value.state });
	assert.deepEqual(after.value.diff, { added: [], removed: [], changed: [] }, "nothing moved after the act's settled state");
	await c.close();
});

test("a point is stale after its window changed size, and still lands after a move", async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	const [x, y, w, h] = seen.window.bounds;
	c.driver.place(APP, [x + 50, y + 30, w, h]);
	const moved = await c.client.call("ui.act", { state: seen.state, steps: [{ click: [20, 100] }] });
	assert.deepEqual(moved.value.steps, [{ route: "background", verified: false }], "a move keeps window points good");
	const now = (await c.client.call("ui.observe", {})).value;
	c.driver.place(APP, [x, y, w + 40, h]);
	const resized = await c.client.call("ui.act", { state: now.state, steps: [{ click: [20, 100] }] });
	assert.equal(resized.value.steps[0].error.kind, "stale");
	assert.match(resized.value.steps[0].error.message, /changed size since state/);
	await c.close();
});

test("the line server: method not found, parse error, a request with no id, and a cancel that ends an expect", async () => {
	const driver = new FakeUiDriver();
	const { PassThrough } = await import("node:stream");
	const { serveUiLines } = await import("../dist/fake-ui-driver.js");
	const input = new PassThrough();
	const output = new PassThrough();
	serveUiLines(driver, input, output);
	const replies = [];
	let buffered = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		buffered += chunk;
		const lines = buffered.split("\n");
		buffered = lines.pop();
		replies.push(...lines.map((line) => JSON.parse(line)));
	});
	const reply = async (id) => {
		for (let i = 0; i < 200; i++) {
			const found = replies.find((r) => r.id === id);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`no reply to ${id}`);
	};
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "screen.capture", params: {} })}\n`);
	assert.equal((await reply(1)).error.code, -32601);
	input.write("{not json\n");
	assert.equal((await reply(null)).error.code, -32700);
	replies.length = 0;
	input.write("null\n");
	assert.equal((await reply(null)).error.code, -32600, "a line of JSON that is not an object is an invalid request, and the server goes on");
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "apps.launch", params: { id: APP } })}\n`);
	await reply(2);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ui.act", params: { steps: [], expect: { text: "never", timeoutMs: 30_000 } } })}\n`);
	await new Promise((resolve) => setTimeout(resolve, 100));
	input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 3 } })}\n`);
	const cancelled = await reply(3);
	assert.equal(cancelled.error.code, -32800);
	assert.equal(cancelled.error.data.kind, "aborted");
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ui.act", params: { steps: [{ wait: 100 }] } })}\n`);
	const invalid = await reply(4);
	assert.equal(invalid.error.code, -32602);
	assert.equal(invalid.error.data.kind, "invalid");
	input.end();
	driver.close();
});

test("UiSession: typed observe and act on a target, a point act carries the last state, findNodes and refusedStep", async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	const ui = new UiSession(c.client, { app: APP });
	const seen = (await ui.observe()).value;
	assert.equal(ui.state, seen.state);
	const [save] = findNodes(seen, { role: "button", text: "Save" });
	assert.equal(save.id, "save");
	assert.deepEqual(findNodes(seen, { text: "nothing like it" }), []);
	const saved = (await ui.act([{ press: save.ref }], { expect: { text: "Saved" } })).value;
	assert.equal(saved.expect, "met");
	assert.equal(ui.state, saved.state, "an act's state is the session's last");
	assert.equal(refusedStep(saved), undefined);
	const [wifi] = findNodes(seen, { id: "wifi" });
	const [x, y, w, h] = wifi.bounds;
	const clicked = (await ui.act([{ click: [x + Math.floor(w / 2), y + Math.floor(h / 2)] }])).value;
	assert.deepEqual(clicked.steps, [{ route: "background", verified: false }], "the click carried the last state, unasked");
	assert.equal(c.driver.calls.at(-1)[1].state, saved.state);
	const next = findNodes(seen, { id: "next" })[0].ref;
	await ui.act([{ press: next }], { expect: { text: "Second page" } });
	const stale = (await ui.act([{ press: save.ref }])).value;
	assert.deepEqual(refusedStep(stale), { index: 0, kind: "stale", message: refusedStep(stale).message });
	await c.close();
});

test("the CLI answers hello and ui.observe on stdin and stdout", async () => {
	const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/fake-ui-driver.js", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
	let out = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		out += chunk;
	});
	const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	send(1, "hello", { client: "test" });
	send(2, "apps.launch", { id: APP });
	send(3, "ui.observe", {});
	const replies = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`the CLI answered: ${out}`)), 10_000);
		child.stdout.on("data", () => {
			const lines = out.split("\n").filter(Boolean);
			if (lines.length >= 3) {
				clearTimeout(timer);
				resolve(lines.map((line) => JSON.parse(line)));
			}
		});
	});
	child.stdin.end();
	const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
	assert.equal(byId[1].result.protocol, "0.2");
	assert.equal(byId[3].result.app.id, APP);
	await new Promise((resolve) => child.on("exit", resolve));
});
