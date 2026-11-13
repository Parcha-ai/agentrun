// The fake ui driver over the wire, and the ui conformance cases on it: a desktop, a phone and one with features off
// pass, each feature off refused with its sentence; a driver whose refs do not survive fails ui.refs-stable. Then the
// driver's own rules: each connection its own refs, settle through a transition, a point stale after a resize and good
// after a move, the line server's error codes and cancel, and the CLI on stdin and stdout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkUiAct, chordKeys, conformanceCases, findNodes, formatReport, refusedStep, runConformance, SET_HOLD_MS, UiSession } from "../dist/index.js";
import { connectUi, FakeUiDriver, fakeUiConnection, fakeUiProvider, NEXT_ANIMATE_MS, NEXT_MS, UI_FIXTURE } from "../dist/fake-ui-driver.js";

const APP = UI_FIXTURE.id;
const UI_CASES = ["ui.hello", "ui.fixture-shape", "ui.refs-stable", "ui.expect", "ui.stale-ref", "ui.stale-point", "ui.route-reported", "ui.features-declared", "ui.features-off-refused", "ui.settle-tree", "ui.set-holds", "ui.expect-window", "ui.window-closed", "ui.window-follow"];
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

test("the Core apps and ui cases read the ui fixture on a computer with no exec or files, desktop and phone", { timeout: 60_000 }, async () => {
	const core = ["apps.launch-terminate", "apps.launch-window", "ui.observe-shape"];
	for (const options of [{}, { os: "android", kind: "android" }]) {
		const report = await run(fakeUiProvider(options), core);
		for (const id of core) assert.equal(statuses(report)[id], "pass", `${options.kind ?? "desktop"} ${id}: ${reasonOf(report, id)}`);
	}
});

test("health.kind-served fails a desktop or phone whose hello lacks a group its kind needs, naming the groups; one that declares them passes", async () => {
	const lacking = await run(fakeUiProvider(), ["health.kind-served"]);
	assert.equal(statuses(lacking)["health.kind-served"], "fail");
	assert.match(reasonOf(lacking, "health.kind-served"), /a macos desktop must declare in hello to be given to an agent, which it lacks: expected \[\], got \["screen","input\.pointer","input\.keys"\]/);
	const phone = await run(fakeUiProvider({ os: "android", kind: "android", groups: ["screen", "apps", "ui"] }), ["health.kind-served"]);
	assert.match(reasonOf(phone, "health.kind-served"), /a android android .*got \["input\.touch"\]/);
	const served = await run(fakeUiProvider({ groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] }), ["health.kind-served"]);
	assert.equal(statuses(served)["health.kind-served"], "pass", reasonOf(served, "health.kind-served"));
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
	// Nor through whether it changed: setting the same value and another answer alike.
	const seen = (await c.client.call("ui.observe", {})).value;
	const pw = seen.nodes[0].ref;
	assert.equal(seen.nodes[0].value, undefined);
	const same = await c.client.call("ui.act", { steps: [{ set: pw, value: "hunter2" }] });
	const other = await c.client.call("ui.act", { steps: [{ set: pw, value: "guess" }] });
	assert.deepEqual([same.value.changed, other.value.changed], [false, false]);
	const since = await c.client.call("ui.observe", { since: seen.state });
	assert.deepEqual(since.value.diff, { added: [], removed: [], changed: [] });
	const point = await c.client.call("ui.act", { state: seen.state, steps: [{ click: [20, 20] }] });
	assert.equal(point.value.steps[0].error, undefined, "a point on it is not stale for its value");
	await c.close();
});

test("every point of a drag is held to its state: an end outside the window is invalid, an end on what changed is stale", async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	const wifi = seen.nodes.find((n) => n.id === "wifi");
	const [x, y, w, h] = wifi.bounds;
	const onWifi = [Math.floor(x + w / 2), Math.floor(y + h / 2)];
	const out = await c.client.call("ui.act", { state: seen.state, steps: [{ drag: [[300, 300], [310, 310], [1000, 1000]] }] });
	assert.equal(out.value.steps[0].error?.kind, "invalid", JSON.stringify(out.value.steps));
	assert.match(out.value.steps[0].error.message, /\(1000, 1000\) is outside the window/);
	assert.deepEqual((await c.client.call("ui.act", { steps: [{ press: wifi.ref }] })).value.steps, [{ route: "semantic", verified: true }]);
	const moved = await c.client.call("ui.act", { state: seen.state, steps: [{ drag: [[300, 300], onWifi] }] });
	assert.equal(moved.value.steps[0].error?.kind, "stale", JSON.stringify(moved.value.steps));
	assert.match(moved.value.steps[0].error.message, new RegExp(`what is at \\(${onWifi[0]}, ${onWifi[1]}\\) changed`));
	await c.close();
});

test("a chord's last key may be + itself", () => {
	assert.deepEqual(["+", "shift++", "ctrl+shift+t", "a"].map(chordKeys), [["+"], ["shift", "+"], ["ctrl", "shift", "t"], ["a"]]);
	for (const key of ["+", "shift++", "ctrl+="]) assert.equal(checkUiAct({ steps: [{ key }] }).ok, true, key);
	for (const key of ["", "++", "shift+", "+shift"]) assert.equal(checkUiAct({ steps: [{ key }] }).ok, false, key);
});

test("a fake desktop with no app in front shows its desktop", async () => {
	const c = await fakeUiConnection();
	const seen = (await c.client.call("ui.observe", {})).value;
	assert.deepEqual([seen.app, seen.nodes], [{ id: "home", name: "Desktop" }, []]);
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

test("an act aimed at an app (a saved state, or a target) that navigates away follows the window in front: its steps keep their results and its state is the new window's", async () => {
	const c = await fakeUiConnection({ os: "android", kind: "android" });
	for (const aimed of [(seen) => ({ state: seen.state }), () => ({ target: { app: APP, window: `${APP}#main` } })]) {
		await c.client.call("apps.launch", { id: APP });
		const seen = (await c.client.call("ui.observe", {})).value;
		assert.equal(seen.app.id, APP);
		const home = await c.client.call("ui.act", { ...aimed(seen), steps: [{ nav: "home" }], expect: { text: "nothing here", timeoutMs: 100 } });
		assert.equal(home.ok, true, JSON.stringify(home));
		assert.deepEqual(home.value.steps, [{ route: "semantic", verified: true }]);
		assert.equal(home.value.expect, "unmet", "the expect polled the home screen, not the app behind it");
		assert.equal((await c.client.call("ui.observe", { since: home.value.state })).value.app.id, "home", "the act's state is the home screen's");
	}
	await c.close();
});

test("a step other than nav that takes the act's window away (a key that leaves the app) runs nothing after it, keeps its result, and settles on the window in front", async () => {
	class Leaving extends FakeUiDriver {
		async run(step, context) {
			return "key" in step && step.key === "f12" ? super.run({ nav: "home" }, context) : super.run(step, context);
		}
	}
	const c = (await connectUi(new Leaving({ os: "android", kind: "android" }))).value;
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	const left = await c.client.call("ui.act", { state: seen.state, steps: [{ key: "f12" }, { key: "a" }] });
	assert.equal(left.ok, true, JSON.stringify(left));
	assert.deepEqual(left.value.steps[0], { route: "semantic", verified: true });
	assert.equal(left.value.steps[1].error?.kind, "stale");
	assert.match(left.value.steps[1].error.message, /the window this act aimed at is gone since the step before/);
	assert.equal(left.value.changed, true);
	// With neither state nor target, the act is bound to the app it began on: the step after one that leaves it is
	// refused, never run in whatever is in front now.
	await c.client.call("apps.launch", { id: APP });
	const bare = await c.client.call("ui.act", { steps: [{ key: "f12" }, { type: "1234" }] });
	assert.equal(bare.ok, true, JSON.stringify(bare));
	assert.deepEqual(bare.value.steps[0], { route: "semantic", verified: true });
	assert.equal(bare.value.steps[1].error?.kind, "stale", JSON.stringify(bare.value.steps));
	await c.close();
});

test("a disabled control takes no effect by any route: its ref is refused, a click at its point lands and does nothing", async () => {
	const app = { id: "test.off", name: "Off", start: "a", size: [300, 200], screens: { a: { elements: [{ key: "wifi", role: "switch", name: "Wi-Fi", bounds: [10, 10, 80, 28], flags: ["disabled"] }] } } };
	const c = await fakeUiConnection({ apps: [app] });
	await c.client.call("apps.launch", { id: app.id });
	const seen = (await c.client.call("ui.observe", {})).value;
	const ref = seen.nodes[0].ref;
	assert.equal((await c.client.call("ui.act", { steps: [{ press: ref }] })).value.steps[0].error?.kind, "refused");
	const clicked = await c.client.call("ui.act", { state: seen.state, steps: [{ click: [20, 20] }] });
	assert.equal(clicked.value.steps[0].verified, false, JSON.stringify(clicked));
	assert.deepEqual((await c.client.call("ui.observe", {})).value.nodes[0].flags, ["disabled"], "not checked");
	await c.close();
});

test("blind background input reaches no field or key effect that takes foreground input only: typing and enter land nowhere, with foreground: true they apply", async () => {
	const field = { key: "pin", role: "textbox", name: "PIN", bounds: [10, 10, 200, 28], route: "foreground", enter: { go: "b" } };
	const app = { id: "test.blind", name: "Blind", start: "a", size: [300, 200], screens: { a: { elements: [field] }, b: { elements: [{ key: "done", role: "text", name: "Done", bounds: [10, 10, 80, 28] }] } } };
	const c = await fakeUiConnection({ apps: [app], blindBackground: true });
	await c.client.call("apps.launch", { id: app.id });
	const ref = (await c.client.call("ui.observe", {})).value.nodes[0].ref;
	const typed = await c.client.call("ui.act", { steps: [{ type: "1234", into: ref }, { key: "enter" }] });
	assert.deepEqual(typed.value.steps, [{ route: "background", verified: false }, { route: "background", verified: false }], JSON.stringify(typed));
	const seen = (await c.client.call("ui.observe", {})).value;
	assert.equal(seen.nodes[0].value, undefined, "nothing was typed");
	assert.equal(seen.nodes[0].name, "PIN", "and enter did not go to the next screen");
	const real = await c.client.call("ui.act", { foreground: true, steps: [{ type: "1234", into: ref }, { key: "enter" }] });
	assert.deepEqual(real.value.steps.map((one) => one.route), ["foreground", "foreground"], JSON.stringify(real));
	assert.equal((await c.client.call("ui.observe", {})).value.nodes[0].name, "Done", "real input typed and entered");
	await c.close();
});

test("type into a ref that is no field is refused; a field whose tap opens another screen takes no focus and gets nothing typed", async () => {
	const app = {
		id: "test.into",
		name: "Into",
		start: "a",
		size: [300, 200],
		screens: {
			a: { elements: [{ key: "send", role: "button", name: "Send", bounds: [10, 10, 80, 28] }, { key: "search", role: "searchbox", name: "Search", bounds: [10, 50, 200, 28], press: { go: "b" } }, { key: "to", role: "textbox", name: "To", bounds: [10, 90, 200, 28] }] },
			b: { elements: [{ key: "query", role: "textbox", name: "Query", bounds: [10, 10, 200, 28], flags: ["focused"] }] },
		},
	};
	const c = await fakeUiConnection({ apps: [app] });
	await c.client.call("apps.launch", { id: app.id });
	const [send, search, to] = (await c.client.call("ui.observe", {})).value.nodes.map((node) => node.ref);
	const notField = await c.client.call("ui.act", { steps: [{ type: "hello", into: send }] });
	assert.deepEqual(notField.value.steps[0].error, { kind: "refused", message: `${send} is a button, not a text field: type into a field` }, JSON.stringify(notField));
	const typed = await c.client.call("ui.act", { steps: [{ type: "hello", into: to }] });
	assert.equal(typed.value.steps[0].verified, true, JSON.stringify(typed));
	const opened = await c.client.call("ui.act", { steps: [{ type: "hello", into: search }] });
	assert.deepEqual(opened.value.steps[0].error, { kind: "refused", message: `${search} did not take focus: nothing typed` }, JSON.stringify(opened));
	const after = (await c.client.call("ui.observe", {})).value.nodes;
	assert.deepEqual([after[0].name, after[0].value], ["Query", undefined], "the tap opened the other screen, and nothing reached its field");
	await c.close();
});

test("a set honors the element's route as a press does: a foreground-only control is never set by the semantic route", async () => {
	const app = { id: "test.fg", name: "Fg", start: "a", size: [300, 200], screens: { a: { elements: [{ key: "pin", role: "textbox", name: "PIN", bounds: [10, 10, 200, 28], route: "foreground" }, { key: "lock", role: "switch", name: "Lock", bounds: [10, 50, 80, 28], route: "foreground" }] } } };
	const strict = await fakeUiConnection({ apps: [app] });
	await strict.client.call("apps.launch", { id: app.id });
	const [pin, lock] = (await strict.client.call("ui.observe", {})).value.nodes.map((node) => node.ref);
	const denied = await strict.client.call("ui.act", { steps: [{ set: pin, value: "1234" }] });
	assert.equal(denied.value.steps[0].error?.kind, "denied", JSON.stringify(denied));
	const allowed = await strict.client.call("ui.act", { foreground: true, steps: [{ set: pin, value: "1234" }, { set: lock, value: "on" }] });
	assert.deepEqual(allowed.value.steps, [{ route: "foreground", verified: true }, { route: "foreground", verified: true }]);
	await strict.close();
	const blind = await fakeUiConnection({ apps: [app], blindBackground: true });
	await blind.client.call("apps.launch", { id: app.id });
	const refs = (await blind.client.call("ui.observe", {})).value.nodes.map((node) => node.ref);
	const posted = await blind.client.call("ui.act", { steps: [{ set: refs[0], value: "1234" }, { set: refs[1], value: "on" }] });
	assert.deepEqual(posted.value.steps, [{ route: "background", verified: false }, { route: "background", verified: false }]);
	const after = (await blind.client.call("ui.observe", {})).value.nodes;
	assert.equal(after[0].value, undefined, "posted input reached no field");
	assert.equal(after[1].flags, undefined, "nor the switch");
	await blind.close();
});

test("ui.observe-shape skips, in hello's words, a computer with both ui.tree and ui.image off", async () => {
	const report = await run(fakeUiProvider({ features: { "ui.tree": { off: "this driver reads no tree" }, "ui.image": { off: "this driver takes no images" } } }), ["ui.observe-shape"]);
	assert.equal(statuses(report)["ui.observe-shape"], "skip", reasonOf(report, "ui.observe-shape"));
	assert.match(reasonOf(report, "ui.observe-shape"), /this driver reads no tree, and .*this driver takes no images/);
});

test("the fake ui provider keeps a computer's network (none or open, never an allowlist, fixed at create) and ends a computer at its deadline", async () => {
	const provider = fakeUiProvider();
	const spec = { image: "fake-ui", user: "501", kind: "desktop", labels: { run: "r1" } };
	const allow = await provider.create({ ...spec, network: { allow: ["example.com"] }, lifetimeMs: 60_000 }, { requestId: "allow" });
	assert.equal(allow.error?.code, "refused");
	assert.match(allow.error.message, /never an allowlist/);
	const made = await provider.create({ ...spec, network: "open", lifetimeMs: 60_000 }, { requestId: "made" });
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.equal((await provider.network(made.value)).value, "open");
	assert.equal((await provider.attach({ id: made.value.id })).value.spec.network, "open");
	assert.equal((await provider.list({ run: "r1" })).value[0].network, "open");
	assert.equal((await provider.network(made.value, "open")).value, "open", "asking for the network it has is ok");
	const change = await provider.network(made.value, "none");
	assert.equal(change.error?.code, "refused", "a remote computer's network is fixed at create");
	assert.match(change.error.message, /network is open, fixed when it was made: create a computer with network none/);
	assert.equal((await provider.network(made.value, { allow: ["example.com"] })).error?.code, "refused");
	assert.equal((await provider.network(made.value)).value, "open", "a refused policy changes nothing");
	const brief = await provider.create({ ...spec, labels: { run: "r2" }, network: "none", lifetimeMs: 30 }, { requestId: "brief" });
	assert.equal(brief.ok, true, JSON.stringify(brief));
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual((await provider.list({ run: "r2" })).value, [], "past its deadline it is not listed");
	assert.equal((await provider.connect(brief.value)).error?.code, "not_found");
	assert.equal((await provider.attach({ id: brief.value.id })).error?.code, "not_found");
	assert.equal(provider.drivers.has(brief.value.id), false, "it was ended");
	await provider.release(made.value, "delete");
});

test("idempotent create: the fake ui provider passes provider.create-retried and create-after-release; one that makes a computer per call fails both", { timeout: 60_000 }, async () => {
	const ids = ["provider.create-retried", "provider.create-after-release"];
	const good = await run(fakeUiProvider(), ids);
	for (const id of ids) assert.equal(statuses(good)[id], "pass", `${id}: ${reasonOf(good, id)}`);
	const fresh = fakeUiProvider();
	let calls = 0;
	const forgetful = { ...fresh, capabilities: fresh.capabilities, check: fresh.check, create: (spec, context) => fresh.create(spec, { ...context, requestId: `${context.requestId}#${calls++}` }) };
	const bad = await run(forgetful, ids);
	assert.equal(statuses(bad)["provider.create-retried"], "fail");
	assert.match(reasonOf(bad, "provider.create-retried"), /the computer a create retried while it starts answers: expected/);
	assert.equal(statuses(bad)["provider.create-after-release"], "fail");
	assert.match(reasonOf(bad, "provider.create-after-release"), /the same request id after its computer was released: expected an error \(exists\), got ok/);
	assert.deepEqual(bad.cleanup.left, [], "the second computers it made are released too");
});

test("a scripted switch's checked flag is where its state starts: it shows checked, turns off, and on again", async () => {
	const app = { id: "test.switch", name: "Switch", start: "a", size: [300, 200], screens: { a: { elements: [{ key: "wifi", role: "switch", name: "Wi-Fi", bounds: [10, 10, 80, 28], flags: ["checked"] }, { key: "name", role: "textbox", name: "Name", bounds: [10, 50, 200, 28], flags: ["focused"] }] } } };
	const c = await fakeUiConnection({ apps: [app] });
	await c.client.call("apps.launch", { id: app.id });
	const flagsOf = async (name) => (await c.client.call("ui.observe", {})).value.nodes.find((node) => node.name === name).flags ?? [];
	assert.deepEqual(await flagsOf("Wi-Fi"), ["checked"]);
	assert.deepEqual(await flagsOf("Name"), ["focused"], "a scripted focus is the state's focus too");
	const ref = (await c.client.call("ui.observe", {})).value.nodes.find((node) => node.name === "Wi-Fi").ref;
	assert.equal((await c.client.call("ui.act", { steps: [{ set: ref, value: "off" }] })).ok, true);
	assert.deepEqual(await flagsOf("Wi-Fi"), []);
	assert.equal((await c.client.call("ui.act", { steps: [{ press: ref }] })).ok, true);
	assert.deepEqual(await flagsOf("Wi-Fi"), ["checked"]);
	await c.close();
});

test("the fixture's ui cases pass on a driver whose only input is the foreground route", { timeout: 60_000 }, async () => {
	const report = await run(fakeUiProvider({ os: "android", kind: "android", features: { "ui.background": { off: "a phone has no posted input" } } }));
	for (const id of UI_CASES) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}`);
});

test("a step that took a route the features or the call do not allow fails the case it ran in", { timeout: 60_000 }, async () => {
	class Rogue extends FakeUiDriver {
		async run(step, context) {
			const done = await super.run(step, context);
			return done.ok ? { ok: true, value: { ...done.value, route: "foreground" } } : done;
		}
	}
	const features = { "ui.background": { off: "posting input is off" }, "ui.foreground": { off: "the user's pointer is theirs" } };
	const off = await run(fakeUiProvider({ features }, (options) => new Rogue(options)), ["ui.route-reported"]);
	assert.equal(statuses(off)["ui.route-reported"], "fail");
	assert.match(reasonOf(off, "ui.route-reported"), /took the foreground route, and ui.foreground is off here: the user's pointer is theirs/);
	const unasked = await run(fakeUiProvider({}, (options) => new Rogue(options)), ["ui.route-reported"]);
	assert.equal(statuses(unasked)["ui.route-reported"], "fail");
	assert.match(reasonOf(unasked, "ui.route-reported"), /took the foreground route on a call without foreground: true/);
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

test("a settle reads the tree: a blinking caret, which changes only the image, settles at once; a tree that never stills fails ui.settle-tree", { timeout: 60_000 }, async () => {
	const c = await fakeUiConnection({ blink: true, quietMs: 50 });
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	await c.client.call("ui.act", { steps: [{ press: seen.nodes.find((n) => n.id === "name").ref }] });
	const began = Date.now();
	const still = await c.client.call("ui.act", { steps: [], expect: { text: "UI fixture" } });
	assert.ok(Date.now() - began < 500, `an act on a still tree with a blinking caret settled in ${Date.now() - began} ms`);
	assert.equal(still.value.changed, false, "the caret is no change: the tree is the same");
	await c.close();
	// ui.settle-tree passes the blinking fake, and fails a driver whose window never settles.
	const blinking = await run(fakeUiProvider({ blink: true }), ["ui.settle-tree"]);
	assert.equal(statuses(blinking)["ui.settle-tree"], "pass", reasonOf(blinking, "ui.settle-tree"));
	let ticks = 0;
	class Restless extends FakeUiDriver {
		async look(target, signal) {
			const looked = await super.look(target, signal);
			if (!looked.ok || looked.value.app.id !== APP) return looked;
			return { ok: true, value: { ...looked.value, elements: [...looked.value.elements, { key: "clock", role: "text", name: `tick ${ticks++}`, bounds: [0, 300, 80, 16] }] } };
		}
	}
	const restless = await run(fakeUiProvider({}, (options) => new Restless(options)), ["ui.settle-tree"]);
	assert.equal(statuses(restless)["ui.settle-tree"], "fail");
	assert.match(reasonOf(restless, "ui.settle-tree"), /act 1 of no steps on a window whose tree is still took \d+ ms, near the 3000 ms settle cap: settle on the window's nodes/);
});

test("a set the app takes back within SET_HOLD_MS answers verified false; one that holds stays verified", async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	const ref = (id) => seen.nodes.find((n) => n.id === id).ref;
	const began = Date.now();
	const set = await c.client.call("ui.act", { steps: [{ set: ref("code"), value: "1234" }, { set: ref("name"), value: "Ada" }] });
	assert.ok(Date.now() - began >= 500, `the act read the sets again ${SET_HOLD_MS} ms after its settle: it answered in ${Date.now() - began} ms`);
	assert.deepEqual(set.value.steps, [{ route: "semantic", verified: false }, { route: "semantic", verified: true }]);
	const after = (await c.client.call("ui.observe", {})).value;
	assert.equal(after.nodes.find((n) => n.id === "code").value, "", "Code took its value back");
	assert.equal(after.nodes.find((n) => n.id === "name").value, "Ada");
	await c.close();
	// ui.set-holds fails a driver that answers a set verified without reading it again.
	class Trusting extends FakeUiDriver {
		async handle(engine, method, params, signal) {
			const done = await super.handle(engine, method, params, signal);
			if (method !== "ui.act" || !done.ok) return done;
			return { ok: true, value: { ...done.value, steps: done.value.steps.map((step) => ("error" in step ? step : { ...step, verified: true })) } };
		}
	}
	const report = await run(fakeUiProvider({}, (options) => new Trusting(options)), ["ui.set-holds"]);
	assert.equal(statuses(report)["ui.set-holds"], "fail");
	assert.match(reasonOf(report, "ui.set-holds"), /set Code, which takes its value back 150 ms later: a set is verified only when its value still holds 500 ms after the settle/);
});

test("expect window waits for a window of the act's app and answers its state; none in time is unmet, never not_found", async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	const seen = (await c.client.call("ui.observe", {})).value;
	const opened = await c.client.call("ui.act", { steps: [{ press: seen.nodes.find((n) => n.id === "open").ref }], expect: { window: { title: "Another", role: "window" } } });
	assert.equal(opened.value.expect, "met");
	const front = (await c.client.call("ui.observe", { since: opened.value.state })).value;
	assert.equal(front.window.title, "Another window");
	assert.deepEqual(front.diff, { added: [], removed: [], changed: [] }, "the act's state is the new window");
	const dialog = await c.client.call("ui.act", { steps: [], expect: { window: { role: "dialog" }, timeoutMs: 100 } });
	assert.equal(dialog.value.expect, "unmet", "no dialog opens");
	for (const expect of [{ window: {} }, { window: { title: 3 } }, { window: { role: "spaceship" } }, { window: { title: "A" }, text: "B" }]) {
		const wrong = await c.client.call("ui.act", { steps: [], expect });
		assert.equal(wrong.ok, false, JSON.stringify(expect));
		assert.equal(wrong.error.code, "invalid", JSON.stringify(expect));
	}
	await c.close();
	// ui.expect-window fails a driver that looks once and does not poll for the window.
	class Glance extends FakeUiDriver {
		async handle(engine, method, params, signal) {
			if (method === "ui.act" && params?.expect?.window !== undefined) return super.handle(engine, method, { ...params, expect: { ...params.expect, timeoutMs: 0 } }, signal);
			return super.handle(engine, method, params, signal);
		}
	}
	const report = await run(fakeUiProvider({}, (options) => new Glance(options)), ["ui.expect-window"]);
	assert.equal(statuses(report)["ui.expect-window"], "fail");
	assert.match(reasonOf(report, "ui.expect-window"), /expect window "Another window": New window opens it 300 ms after its press, so only a polled expect sees it/);
});

test("a step that closes the act's window: with none left the act answers window closed and no state; with another it follows that one", async () => {
	const c = await fakeUiConnection();
	await c.client.call("apps.launch", { id: APP });
	let seen = (await c.client.call("ui.observe", {})).value;
	const close = seen.nodes.find((n) => n.id === "close").ref;
	const closed = await c.client.call("ui.act", { steps: [{ press: close }, { press: close }] });
	assert.equal(closed.value.window, "closed");
	assert.equal(closed.value.state, undefined);
	assert.equal(closed.value.changed, true);
	assert.deepEqual(closed.value.steps[0], { route: "semantic", verified: true }, "the step that closed it keeps its result");
	assert.equal(closed.value.steps[1].error.kind, "stale");
	assert.match(closed.value.steps[1].error.message, /^UI fixture has no window left: the step before closed its last one/);
	const none = await c.client.call("ui.observe", { target: { app: APP } });
	assert.equal(none.error.code, "not_found");
	assert.match(none.error.message, /running with no window: its last one closed, and apps\.launch opens it again/);
	assert.deepEqual(await c.client.call("apps.launch", { id: APP }), { ok: true, value: {} });
	seen = (await c.client.call("ui.observe", {})).value;
	assert.equal(seen.window.id, `${APP}#main`, "apps.launch opened the main window again");
	await c.client.call("ui.act", { steps: [{ press: seen.nodes.find((n) => n.id === "open").ref }], expect: { window: { title: "Another window" } } });
	const another = (await c.client.call("ui.observe", {})).value;
	const followed = await c.client.call("ui.act", { target: { app: APP, window: another.window.id }, steps: [{ press: another.nodes.find((n) => n.id === "close").ref }] });
	assert.equal(followed.value.window, undefined);
	const main = (await c.client.call("ui.observe", { since: followed.value.state })).value;
	assert.equal(main.window.id, `${APP}#main`);
	assert.deepEqual(main.diff, { added: [], removed: [], changed: [] }, "the act's state is the main window it followed");
	await c.close();
	// ui.window-closed fails a driver that answers not_found once its window closed; ui.window-follow one that answers
	// closed though the app has another window.
	class NotFound extends FakeUiDriver {
		async handle(engine, method, params, signal) {
			const done = await super.handle(engine, method, params, signal);
			return method === "ui.act" && done.ok && done.value.window === "closed" ? { ok: false, error: { code: "not_found", message: "the window is gone" } } : done;
		}
	}
	const lost = await run(fakeUiProvider({}, (options) => new NotFound(options)), ["ui.window-closed"]);
	assert.equal(statuses(lost)["ui.window-closed"], "fail");
	assert.match(reasonOf(lost, "ui.window-closed"), /not_found: the window is gone/);
	class Quitter extends FakeUiDriver {
		async handle(engine, method, params, signal) {
			const done = await super.handle(engine, method, params, signal);
			if (method !== "ui.act" || !done.ok || params?.target?.window === undefined) return done;
			const { state: _state, ...rest } = done.value;
			return { ok: true, value: { ...rest, window: "closed", changed: true } };
		}
	}
	const quit = await run(fakeUiProvider({}, (options) => new Quitter(options)), ["ui.window-follow"]);
	assert.equal(statuses(quit)["ui.window-follow"], "fail");
	assert.match(reasonOf(quit, "ui.window-follow"), /ui\.act's window after a step closed one window of two/);
});

test("apps.launch answers once the app has a window: a slow window still passes apps.launch-window; a launch that answers before it fails", { timeout: 60_000 }, async () => {
	const slow = await run(fakeUiProvider({ windowAfterMs: 400 }), ["apps.launch-window"]);
	assert.equal(statuses(slow)["apps.launch-window"], "pass", reasonOf(slow, "apps.launch-window"));
	class Early extends FakeUiDriver {
		async windowOf() {
			return { ok: true, value: {} };
		}
	}
	const early = await run(fakeUiProvider({ windowAfterMs: 400 }, (options) => new Early(options)), ["apps.launch-window"]);
	assert.equal(statuses(early)["apps.launch-window"], "fail");
	assert.match(reasonOf(early, "apps.launch-window"), /has no window yet/);
});

test("a node's bounds are clamped to its window: one partly outside is cut at the edge, one wholly outside is empty at it", async () => {
	const app = {
		id: "test.wide",
		name: "Wide",
		start: "a",
		size: [200, 100],
		screens: {
			a: {
				elements: [
					{ key: "wide", role: "text", name: "Wide", bounds: [150, -10, 100, 40] },
					{ key: "far", role: "text", name: "Far", bounds: [300, 200, 10, 10] },
				],
			},
		},
	};
	const c = await fakeUiConnection({ apps: [app] });
	await c.client.call("apps.launch", { id: app.id });
	const seen = (await c.client.call("ui.observe", {})).value;
	assert.deepEqual(seen.nodes.map((n) => [n.name, n.bounds]), [["Wide", [150, 0, 50, 30]], ["Far", [200, 100, 0, 0]]]);
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
