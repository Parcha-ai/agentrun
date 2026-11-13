// The ui group on the ui fixture (ui-fixture.ts): observe's shape on a window whose elements the suite knows; refs that
// stay good across states while their element exists and go stale when it leaves; a point refused as stale once its
// window changed; an expect met and one unmet; the route each step took; a settle on the tree while a caret blinks; a
// set the app takes back answered unverified; a window expect; an act whose window closed, with no window left or with
// another to follow; and hello.features, each declared feature
// doing what it says and each one off refused with its own sentence. The fixture is an image's, so its cases are Full: a
// computer without it skips them in words. ui.hello needs no fixture and is Core for every computer of the ui group.
import { FEATURES, type Feature, MAX_IMAGE_EDGE, MAX_SETTLE_MS, type Point, SET_HOLD_MS, type UiActParams, type UiActResult, type UiNode, type UiObserveResult, type UiRoute, type UiStepResult } from "../../protocol.js";
import { featureOff } from "../../ui-engine.js";
import type { Case, CaseContext } from "../types.js";
import { NEW_WINDOW_MS, TAKES_BACK_MS, UI_FIXTURE } from "../ui-fixture.js";
import { observeWrong } from "./apps.js";

const APP = UI_FIXTURE.id;
const ROUTES: ReadonlySet<UiRoute> = new Set<UiRoute>(["semantic", "page", "background", "foreground"]);
const KNOWN: ReadonlySet<string> = new Set(Object.keys(FEATURES));
const show = (value: unknown) => JSON.stringify(value) ?? String(value);

const look = (t: CaseContext, extra: Record<string, unknown> = {}): Promise<UiObserveResult> => t.call("ui.observe", { target: { app: APP }, ...extra });
/** Whether the driver's only input is the foreground route: ui.background off, ui.foreground on. */
const inputOnly = (t: CaseContext) => {
	const features = t.hello.features ?? {};
	return featureOff(features, "ui.background") !== undefined && features["ui.foreground"] === true;
};
/** The feature a route needs on. */
const ROUTE_FEATURE: Readonly<Record<UiRoute, Feature>> = { semantic: "ui.tree", page: "ui.page", background: "ui.background", foreground: "ui.foreground" };
/**
 * ui.act on the fixture. An input-only driver gets foreground: true unless the case says otherwise, so the cases check
 * what it offers rather than refuse it every step. Every step that ran is held to the routes it may take: its route's
 * feature on, and the foreground route only when the call allowed it.
 */
const act = async (t: CaseContext, params: Omit<UiActParams, "target">, window?: string): Promise<UiActResult> => {
	const sent = { target: { app: APP, ...(window === undefined ? {} : { window }) }, ...(inputOnly(t) && !("foreground" in params) ? { foreground: true } : {}), ...params };
	const result = await t.call("ui.act", sent);
	const features = t.hello.features ?? {};
	for (const [index, step] of (result.steps ?? []).entries()) {
		if (typeof step !== "object" || step === null || "error" in step) continue;
		const feature = ROUTE_FEATURE[step.route];
		if (feature === undefined) continue;
		const off = featureOff(features, feature);
		t.assert(off === undefined, `steps[${index}] took the ${step.route} route, and ${off}`);
		t.assert(step.route !== "foreground" || sent.foreground === true, `steps[${index}] took the foreground route on a call without foreground: true`);
	}
	return result;
};
const byId = (t: CaseContext, seen: UiObserveResult, id: string): UiNode => t.present(seen.nodes.find((node) => node.id === id), `the fixture's ${id}, by its id, in ui.observe: ${show(seen.nodes.map((node) => node.id ?? node.name))}`);
const centre = ({ bounds: [x, y, w, h] }: UiNode): Point => [Math.floor(x + w / 2), Math.floor(y + h / 2)];

/** The fixture, freshly launched; skips when this computer has not installed it. */
async function launch(t: CaseContext): Promise<void> {
	const listed = await t.call("apps.list", {});
	if (!listed.apps.some((app) => app.id === APP)) return t.skip(`the ui fixture (${APP}) is not installed on this computer: its conformance image installs it`);
	await t.call("apps.terminate", { id: APP });
	t.deepEqual(await t.call("apps.launch", { id: APP }), {}, `apps.launch ${APP}`);
	await t.until(async () => (await t.call("apps.list", {})).foreground === APP, `${APP} in front after apps.launch`);
}

/** The fixture, freshly launched on its home window and seen there; skips without the fixture or the tree. */
async function start(t: CaseContext): Promise<UiObserveResult> {
	await launch(t);
	const treeOff = featureOff(t.hello.features ?? {}, "ui.tree");
	if (treeOff !== undefined) return t.skip(`the fixture's cases read its elements, and ${treeOff}`);
	return t.until(async () => {
		const seen = await look(t);
		return seen.nodes.some((node) => node.id === "next") ? seen : undefined;
	}, `the fixture's home window, with its Next button, in ui.observe`);
}

/** The step's result, which ran: its route one of the protocol's and verified a boolean. */
function ran(t: CaseContext, step: UiStepResult | undefined, what: string): { route: UiRoute; verified: boolean } {
	t.assert(step !== undefined, `${what}: the act answered no result for the step`);
	t.assert(!("error" in (step as object)), `${what}: refused: ${show(step)}`);
	const done = step as { route: UiRoute; verified: boolean };
	t.assert(ROUTES.has(done.route), `${what}: route ${show(done.route)} is not one of ${[...ROUTES].join(", ")}`);
	t.assert(typeof done.verified === "boolean", `${what}: verified ${show(done.verified)} is not a boolean`);
	return done;
}

/** The step's refusal, of one of these kinds. */
function refusedStep(t: CaseContext, result: UiActResult, what: string, kinds: string[]): { kind: string; message: string } {
	const last = result.steps.at(-1);
	t.assert(last !== undefined && "error" in last, `${what}: the step ran, where it should be refused (${kinds.join(" or ")}): ${show(result.steps)}`);
	const { error } = last as { error: { kind: string; message: string } };
	t.assert(kinds.includes(error.kind), `${what}: refused as ${error.kind}, not ${kinds.join(" or ")}: ${error.message}`);
	t.assert(typeof error.message === "string" && error.message.length > 0, `${what}: the refusal has no words`);
	return error;
}

/** The fixture's node by its id, or a skip in words when this computer's fixture leaves it out (one window per app). */
const optional = (t: CaseContext, seen: UiObserveResult, id: string, why: string): UiNode =>
	seen.nodes.find((node) => node.id === id) ?? t.skip(`the ui fixture here has no ${id} (${why}): a fixture that leaves it out skips this case`);

/** New window pressed, and the act's expect waits for the window it opens: the act answers once it is there. */
const openAnother = async (t: CaseContext, seen: UiObserveResult): Promise<UiActResult> => {
	const open = optional(t, seen, "open", "New window, which opens a second window");
	const opened = await act(t, { steps: [{ press: open.ref }], expect: { window: { title: "Another window" } } });
	ran(t, opened.steps[0], "press New window");
	t.equal(opened.expect, "met", `expect window "Another window": New window opens it ${NEW_WINDOW_MS} ms after its press, so only a polled expect sees it`);
	return opened;
};

/** Whether a state is of this window: an observe of it since that state finds nothing changed. */
const stateOf = async (t: CaseContext, state: string | undefined, window: string, what: string) => {
	t.assert(typeof state === "string" && state !== "", `${what}: the act answered no state: ${show(state)}`);
	const since = await look(t, { target: { app: APP, window }, since: state });
	t.deepEqual(since.diff, { added: [], removed: [], changed: [] }, `${what}: observe of window ${window} since the act's state (a state of another window shows every node added)`);
};

const toSecond = async (t: CaseContext, seen: UiObserveResult) => {
	const result = await act(t, { steps: [{ press: byId(t, seen, "next").ref }], expect: { text: "Second page" } });
	t.equal(result.expect, "met", "Next opens the second page, seen by the act's expect");
	return result;
};

export const uiCases: Case[] = [
	{
		id: "ui.fixture-shape",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const seen = await start(t);
			const wrong = observeWrong(seen);
			t.assert(wrong === undefined, `ui.observe: ${wrong}`);
			t.equal(seen.app.id, APP, "the observed app");
			const [, , width, height] = seen.window.bounds;
			t.deepEqual([width, height], UI_FIXTURE.size, "the fixture's window size, in points");
			for (const [id, role, name] of [
				["name", "textbox", "Name"],
				["wifi", "switch", "Wi-Fi"],
				["save", "button", "Save"],
				["next", "button", "Next"],
			] as const) {
				const node = byId(t, seen, id);
				t.equal(node.role, role, `${id}'s role`);
				t.equal(node.name, name, `${id}'s name`);
			}
			t.equal(byId(t, seen, "wifi").desc, "Networks nearby", "Wi-Fi's secondary text, in desc (not value, which is an editable value)");
			const full = await look(t, { full: true });
			t.assert(full.nodes.length >= seen.nodes.length, `a full observe holds every node a compact one does: ${full.nodes.length} < ${seen.nodes.length}`);
			// since: what changed from a state, by refs.
			const again = await look(t, { since: seen.state });
			t.assert(again.state !== seen.state, `each observe is a new state: ${again.state} twice`);
			t.deepEqual(again.diff, { added: [], removed: [], changed: [] }, "observe since a state of the same window, untouched");
		},
	},
	{
		id: "ui.refs-stable",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const seen = await start(t);
			const refs = Object.fromEntries(["name", "wifi", "save", "next"].map((id) => [id, byId(t, seen, id).ref]));
			const typed = await act(t, { steps: [{ set: refs.name, value: "Ada" }] });
			ran(t, typed.steps[0], "set Name to Ada");
			const saved = await act(t, { steps: [{ press: refs.save }], expect: { text: "Saved" } });
			ran(t, saved.steps[0], "press Save");
			t.equal(saved.expect, "met", "Saved shows after Save, seen by the act's expect");
			t.equal(saved.changed, true, "the act changed the window");
			const after = await look(t, { since: seen.state });
			for (const [id, ref] of Object.entries(refs)) t.equal(byId(t, after, id).ref, ref, `${id}'s ref, its element still there after the window changed`);
			t.equal(byId(t, after, "name").value, "Ada", "Name's value after set");
			const note = t.present(
				after.nodes.find((node) => node.name === "Saved"),
				"the text Saved in ui.observe",
			);
			t.assert(after.diff?.added.includes(note.ref), `observe since the first state names Saved as added: ${show(after.diff)}`);
			t.assert(after.diff?.changed.includes(refs.name), `observe since the first state names Name as changed: ${show(after.diff)}`);
		},
	},
	{
		id: "ui.expect",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const seen = await start(t);
			const next = byId(t, seen, "next").ref;
			// Unmet, on the still home window: after its timeout, and the act still answers its state.
			const began = Date.now();
			const waited = await act(t, { steps: [], expect: { text: "No such text anywhere", timeoutMs: 300 } });
			const took = Date.now() - began;
			t.equal(waited.expect, "unmet", "an expect for text the window never shows");
			t.assert(took >= 250, `an unmet expect waits its timeout (300 ms) before it answers: it answered in ${took} ms`);
			t.assert(typeof waited.state === "string" && waited.state !== "", `an unmet act answers its state: ${show(waited.state)}`);
			t.equal(waited.changed, false, "an act of no steps on a still window changes nothing");
			// Met: the second page comes some time after the press, so only a polled expect sees it.
			const opened = await act(t, { steps: [{ press: next }], expect: { ref: next, gone: true } });
			t.equal(opened.expect, "met", "expect gone: Next leaves the window after its press");
			const now = await look(t);
			t.assert(now.nodes.some((node) => node.name === "Second page"), `the second page is shown after the expect was met: ${show(now.nodes.map((node) => node.name))}`);
		},
	},
	{
		id: "ui.stale-ref",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const seen = await start(t);
			const name = byId(t, seen, "name").ref;
			await toSecond(t, seen);
			const gone = await act(t, { steps: [{ press: name }, { press: name }] });
			refusedStep(t, gone, "press Name, which is not on the second page", ["stale"]);
			t.equal(gone.steps.length, 1, "the refused step is the last result: the steps after it do not run");
			const never = await t.client.call("ui.act", { target: { app: APP }, steps: [{ press: "@never-given" }] }, { signal: t.signal });
			t.refused(never, "ui.act with a ref this connection was never given", ["invalid"]);
		},
	},
	{
		id: "ui.stale-point",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const seen = await start(t);
			const save = centre(byId(t, seen, "save"));
			await toSecond(t, seen);
			const moved = await act(t, { state: seen.state, steps: [{ click: save }] });
			refusedStep(t, moved, `a click at Save's point ${show(save)}, read from the home window's state, on the second page`, ["stale"]);
			const old = await act(t, { state: "s-never-given", steps: [{ click: save }] });
			refusedStep(t, old, "a click from a state never given", ["stale"]);
			const second = await look(t);
			const [, , width, height] = second.window.bounds;
			const outside = await act(t, { state: second.state, steps: [{ click: [width + 10, height + 10] }] });
			refusedStep(t, outside, "a click outside the window", ["invalid"]);
			// A point from the current state lands: Back, at its centre, goes home.
			const features = t.hello.features ?? {};
			const foreground = features["ui.background"] !== true;
			if (foreground && features["ui.foreground"] !== true) return t.skip("a click needs ui.background or ui.foreground, and this computer declares neither");
			const back = await act(t, { state: second.state, steps: [{ click: centre(byId(t, second, "back")) }], expect: { text: "UI fixture" }, ...(foreground ? { foreground: true } : {}) });
			ran(t, back.steps[0], "a click at Back's point, read from the current state");
			t.equal(back.expect, "met", "the click at Back's point went home");
		},
	},
	{
		id: "ui.route-reported",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const seen = await start(t);
			const pressed = ran(t, (await act(t, { steps: [{ press: byId(t, seen, "wifi").ref }] })).steps[0], "press Wi-Fi");
			// The best route first: semantic, unless the driver's input is all it has (ui.background off, foreground only).
			t.assert(pressed.route === "semantic" || (inputOnly(t) && pressed.route === "foreground"), `a press on a switch with an accessibility action goes the semantic route, or foreground on a driver with no other: it went ${pressed.route}`);
			const after = await look(t);
			t.assert(byId(t, after, "wifi").flags?.includes("checked"), `Wi-Fi is checked after its press: ${show(byId(t, after, "wifi").flags)}`);
			// The canvas takes foreground input only, and its value counts the clicks that reached it. A driver need not
			// know that: without foreground: true it may refuse the click, or post it the background way, which never
			// reaches the canvas. Either is right. What is never right is answering verified for a click that did not land.
			const canvas = byId(t, after, "canvas").ref;
			const count = (seen: UiObserveResult) => {
				const value = byId(t, seen, "canvas").value;
				t.assert(value !== undefined && /^\d+$/.test(value), `the canvas's value counts the clicks that reached it: ${show(value)}`);
				return Number(value);
			};
			const off = featureOff(t.hello.features ?? {}, "ui.foreground");
			const before = count(after);
			const posted = await act(t, { steps: [{ click: canvas }], foreground: false });
			const first = posted.steps[0];
			if (first !== undefined && "error" in first) {
				const refused = refusedStep(t, posted, "a click on the canvas without foreground: true", ["denied", "unsupported"]);
				if (off === undefined) t.equal(refused.kind, "denied", "with ui.foreground on, a foreground-only step in a call that does not allow it is denied");
			} else {
				const step = ran(t, first, "a click on the canvas without foreground: true");
				t.assert(step.route !== "foreground", "a call without foreground: true never takes the foreground route");
				const landed = count(await look(t)) > before;
				t.assert(!step.verified || landed, `the click answered verified, and the canvas's count did not move: a driver never verifies an effect that did not happen`);
			}
			if (off !== undefined) return t.skip(`the foreground route is not tested: ${off}`);
			const ready = count(await look(t));
			const allowed = ran(t, (await act(t, { steps: [{ click: canvas }], foreground: true })).steps[0], "a click on the canvas with foreground: true");
			t.equal(count(await look(t)), ready + 1, "the click with foreground: true reached the canvas: its count went up by one");
			t.equal(allowed.verified, true, "the driver verified the click by reading the canvas's count back");
		},
	},
	{
		id: "ui.hello",
		level: "core",
		group: "ui",
		needs: ["ui"],
		async run(t) {
			// Needs no fixture: every computer of the ui group says its screen and its features, each on or off in words.
			const features = t.present(t.hello.features, "hello.features, which a computer of the ui group declares");
			for (const [name, value] of Object.entries(features)) {
				const off = typeof value === "object" && value !== null && typeof (value as { off?: unknown }).off === "string" && (value as { off: string }).off.trim() !== "";
				t.assert(value === true || off, `hello.features.${name} is ${show(value)}, not true or { off: "<why, in words>" }`);
				if (!KNOWN.has(name)) t.observe(`hello.features names ${name}, which the protocol does not (FEATURES)`);
			}
			t.assert(features["ui.tree"] !== undefined, `hello.features declares ui.tree, on or off with its reason: ${show(features)}`);
			const screen = t.present(t.hello.screen, "hello.screen, which a computer of the ui group declares");
			t.assert([screen.width, screen.height, screen.scale].every((n) => typeof n === "number" && n > 0), `hello.screen is ${show(screen)}, not { width, height, scale } above 0`);
			const device = t.hello.device;
			if (device !== undefined) {
				t.assert([device.maker, device.model].every((one) => typeof one === "string" && one.trim() !== ""), `hello.device is ${show(device)}, not { maker, model } in words`);
			}
		},
	},
	{
		id: "ui.features-declared",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			// Each declared feature does what it says.
			const features = t.hello.features ?? {};
			const seen = await start(t);
			if (features["ui.image"] === true) {
				const shot = t.present((await look(t, { image: { maxEdge: 256 } })).image, "ui.observe's image with ui.image on");
				t.assert(shot.format === "png" || shot.format === "jpeg", `the image's format is ${show(shot.format)}`);
				t.assert(Math.max(shot.width, shot.height) <= 256 && Math.min(shot.width, shot.height) > 0, `the image is ${shot.width}x${shot.height}, not within maxEdge 256`);
				t.assert(Buffer.from(shot.data, "base64").length > 0, "the image has data");
				const big = await t.client.call("ui.observe", { target: { app: APP }, image: { maxEdge: MAX_IMAGE_EDGE + 1 } }, { signal: t.signal });
				t.refused(big, `ui.observe with image.maxEdge ${MAX_IMAGE_EDGE + 1}`, ["limit"]);
			}
			if (features["ui.nav"] === true) {
				await toSecond(t, seen);
				const back = await act(t, { steps: [{ nav: "back" }], expect: { text: "UI fixture" } });
				ran(t, back.steps[0], "nav back");
				t.equal(back.expect, "met", "nav back from the second page goes home");
			}
			if (features["apps.background"] === true) {
				await t.call("apps.terminate", { id: APP });
				t.deepEqual(await t.call("apps.launch", { id: APP, background: true }), {}, "apps.launch in the background, with apps.background on");
				t.assert((await t.call("apps.list", {})).foreground !== APP, "an app launched in the background is not in front");
				t.assert((await look(t)).nodes.some((node) => node.id === "next"), "ui.observe reaches an app in the background by its target");
			}
		},
	},
	{
		id: "ui.features-off-refused",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const features = t.hello.features ?? {};
			const offs = (["ui.tree", "ui.image", "ui.nav", "apps.background"] as const).filter((name) => features[name] !== true);
			if (offs.length === 0) return t.skip("this computer declares ui.tree, ui.image, ui.nav and apps.background on: no refusal to check");
			/** The refusal says why, in the computer's own sentence, when it declared one. */
			const says = (message: string, name: (typeof offs)[number]) => {
				const value = features[name];
				const why = typeof value === "object" ? value.off : undefined;
				if (why !== undefined) t.assert(message.includes(why), `the refusal of ${name} carries its sentence ${show(why)}: ${message}`);
			};
			if (offs.includes("ui.tree")) {
				// No tree: the window's image with no nodes and the reason, or, with no image either, denied in words.
				await launch(t);
				const seen = await t.client.call("ui.observe", { target: { app: APP } }, { signal: t.signal });
				if (offs.includes("ui.image")) {
					const refused = t.refused(seen, "ui.observe with ui.tree and ui.image off", ["denied"]);
					says(refused.message, "ui.tree");
					says(refused.message, "ui.image");
				} else {
					const view = t.ok(seen, "ui.observe with ui.tree off");
					t.deepEqual(view.nodes, [], "ui.observe's nodes with ui.tree off");
					says(t.present(view.empty, "ui.observe's empty, the reason it has no nodes"), "ui.tree");
					t.present(view.image, "ui.observe's image with ui.tree off, unasked: the view a caller acts on by points");
					const waited = await t.client.call("ui.act", { target: { app: APP }, steps: [], expect: { text: "UI fixture", timeoutMs: 100 } }, { signal: t.signal });
					says(t.refused(waited, "an expect with ui.tree off", ["unsupported"]).message, "ui.tree");
				}
				if (offs.includes("apps.background")) {
					const launched = await t.client.call("apps.launch", { id: APP, background: true }, { signal: t.signal });
					says(t.refused(launched, "apps.launch in the background, apps.background off", ["unsupported"]).message, "apps.background");
				}
				return;
			}
			const seen = await start(t);
			for (const name of offs) {
				if (name === "ui.image") {
					const shot = await t.client.call("ui.observe", { target: { app: APP }, image: true }, { signal: t.signal });
					says(t.refused(shot, "ui.observe with an image, ui.image off", ["unsupported"]).message, name);
				} else if (name === "ui.nav") {
					await toSecond(t, seen);
					const back = await act(t, { steps: [{ nav: "back" }] });
					says(refusedStep(t, back, "nav back, ui.nav off", ["unsupported"]).message, name);
				} else {
					const launched = await t.client.call("apps.launch", { id: APP, background: true }, { signal: t.signal });
					says(t.refused(launched, "apps.launch in the background, apps.background off", ["unsupported"]).message, name);
				}
			}
		},
	},
	{
		id: "ui.settle-tree",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			// A focused field's caret blinks: what the window draws changes, its tree does not. A driver settles on the tree
			// when the window has nodes, so an act on it answers once the tree is still, never at the settle cap.
			const seen = await start(t);
			ran(t, (await act(t, { steps: [{ press: byId(t, seen, "name").ref }] })).steps[0], "press Name, which takes the focus");
			for (const round of [1, 2, 3]) {
				const began = Date.now();
				const still = await act(t, { steps: [], expect: { text: "UI fixture" } });
				const took = Date.now() - began;
				t.equal(still.expect, "met", `act ${round} of no steps, its expect for the heading UI fixture`);
				t.assert(took < MAX_SETTLE_MS * 0.8, `act ${round} of no steps on a window whose tree is still took ${took} ms, near the ${MAX_SETTLE_MS} ms settle cap: settle on the window's nodes, and on its image only when it has none (a blinking caret never settles)`);
			}
		},
	},
	{
		id: "ui.set-holds",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			// The Code field takes back any value set into it TAKES_BACK_MS later: the set ran, and did not hold.
			const seen = await start(t);
			const code = optional(t, seen, "code", "Code, a field that takes back what is set into it");
			const taken = ran(t, (await act(t, { steps: [{ set: code.ref, value: "1234" }] })).steps[0], "set Code to 1234");
			t.equal(taken.verified, false, `set Code, which takes its value back ${TAKES_BACK_MS} ms later: a set is verified only when its value still holds ${SET_HOLD_MS} ms after the settle`);
			t.equal(byId(t, await look(t), "code").value ?? "", "", "Code's value, taken back");
		},
	},
	{
		id: "ui.expect-window",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			const seen = await start(t);
			// Unmet: no window of that title comes, and the act answers unmet after its timeout, never not_found.
			const none = await act(t, { steps: [], expect: { window: { title: "No such window" }, timeoutMs: 300 } });
			t.equal(none.expect, "unmet", "expect a window titled No such window, which never opens");
			const opened = await openAnother(t, seen);
			const front = await look(t);
			t.equal(front.window.title, "Another window", "the window in front after New window");
			await stateOf(t, opened.state, front.window.id, "a met window expect answers that window's state");
		},
	},
	{
		id: "ui.window-closed",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			// Close on the fixture's only window: the app runs on with none, and the act says so with no state.
			const seen = await start(t);
			optional(t, seen, "open", "New window: a fixture that closes its window opens one too");
			const closed = await act(t, { steps: [{ press: byId(t, seen, "close").ref }] });
			ran(t, closed.steps[0], "press Close on the app's only window");
			t.equal(closed.window, "closed", "ui.act's window after a step closed the app's last one");
			t.equal(closed.state, undefined, "ui.act's state when the app has no window left");
			t.equal(closed.changed, true, "ui.act's changed when the window closed");
		},
	},
	{
		id: "ui.window-follow",
		level: "full",
		group: "ui",
		needs: ["ui", "apps"],
		async run(t) {
			// Close on a second window: the act follows the app's next main window, as after a nav, and answers its state.
			const seen = await start(t);
			const home = seen.window.id;
			await openAnother(t, seen);
			const another = await look(t);
			const closed = await act(t, { steps: [{ press: byId(t, another, "close").ref }] }, another.window.id);
			ran(t, closed.steps[0], "press Close on the second window");
			t.equal(closed.window, undefined, `ui.act's window after a step closed one window of two: ${show(closed.window)}`);
			await stateOf(t, closed.state, home, "an act whose window closed follows the app's next main window");
		},
	},
];
