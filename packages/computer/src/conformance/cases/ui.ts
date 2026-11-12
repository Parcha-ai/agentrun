// The ui group on the ui fixture (ui-fixture.ts): observe's shape on a window whose elements the suite knows; refs that
// stay good across states while their element exists and go stale when it leaves; a point refused as stale once its
// window changed; an expect met and one unmet; the route each step took; and hello.features, each declared feature
// doing what it says and each one off refused with its own sentence. The fixture is an image's, so its cases are Full: a
// computer without it skips them in words. ui.hello needs no fixture and is Core for every computer of the ui group.
import { FEATURES, MAX_IMAGE_EDGE, type Point, type UiActParams, type UiActResult, type UiNode, type UiObserveResult, type UiRoute, type UiStepResult } from "../../protocol.js";
import { featureOff } from "../../ui-engine.js";
import type { Case, CaseContext } from "../types.js";
import { UI_FIXTURE } from "../ui-fixture.js";
import { observeWrong } from "./apps.js";

const APP = UI_FIXTURE.id;
const ROUTES: ReadonlySet<UiRoute> = new Set<UiRoute>(["semantic", "page", "background", "foreground"]);
const KNOWN: ReadonlySet<string> = new Set(Object.keys(FEATURES));
const show = (value: unknown) => JSON.stringify(value) ?? String(value);

const look = (t: CaseContext, extra: Record<string, unknown> = {}): Promise<UiObserveResult> => t.call("ui.observe", { target: { app: APP }, ...extra });
const act = (t: CaseContext, params: Omit<UiActParams, "target">): Promise<UiActResult> => t.call("ui.act", { target: { app: APP }, ...params });
const byId = (t: CaseContext, seen: UiObserveResult, id: string): UiNode => t.present(seen.nodes.find((node) => node.id === id), `the fixture's ${id}, by its id, in ui.observe: ${show(seen.nodes.map((node) => node.id ?? node.name))}`);
const centre = ({ bounds: [x, y, w, h] }: UiNode): Point => [Math.floor(x + w / 2), Math.floor(y + h / 2)];

/** The fixture, freshly launched on its home window and seen there; skips when this computer has not installed it. */
async function start(t: CaseContext): Promise<UiObserveResult> {
	const listed = await t.call("apps.list", {});
	if (!listed.apps.some((app) => app.id === APP)) return t.skip(`the ui fixture (${APP}) is not installed on this computer: its conformance image installs it`);
	await t.call("apps.terminate", { id: APP });
	t.deepEqual(await t.call("apps.launch", { id: APP }), {}, `apps.launch ${APP}`);
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
			t.equal(pressed.route, "semantic", "a press on a switch with an accessibility action goes the semantic route");
			const after = await look(t);
			t.assert(byId(t, after, "wifi").flags?.includes("checked"), `Wi-Fi is checked after its press: ${show(byId(t, after, "wifi").flags)}`);
			// The canvas takes foreground input only: refused without the call's leave, run by the foreground route with it.
			const canvas = byId(t, after, "canvas").ref;
			const refused = refusedStep(t, await act(t, { steps: [{ click: canvas }] }), "a click on the canvas, which only foreground input reaches, without foreground: true", ["denied", "unsupported"]);
			const off = featureOff(t.hello.features ?? {}, "ui.foreground");
			if (off !== undefined) {
				t.equal(refused.kind, "unsupported", "with ui.foreground off, the canvas is refused as unsupported");
				return t.skip(`the foreground route is not tested: ${off}`);
			}
			t.equal(refused.kind, "denied", "with ui.foreground on, a call that does not allow it is denied");
			const allowed = ran(t, (await act(t, { steps: [{ click: canvas }], foreground: true })).steps[0], "a click on the canvas with foreground: true");
			t.equal(allowed.route, "foreground", "the canvas is reached by the foreground route");
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
			const screen = t.present(t.hello.screen, "hello.screen, which a computer of the ui group declares");
			t.assert([screen.width, screen.height, screen.scale].every((n) => typeof n === "number" && n > 0), `hello.screen is ${show(screen)}, not { width, height, scale } above 0`);
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
			const offs = (["ui.image", "ui.nav", "apps.background"] as const).filter((name) => features[name] !== true);
			if (offs.length === 0) return t.skip("this computer declares ui.image, ui.nav and apps.background on: no refusal to check");
			const seen = await start(t);
			/** The refusal says why, in the computer's own sentence, when it declared one. */
			const says = (message: string, name: (typeof offs)[number]) => {
				const value = features[name];
				const why = typeof value === "object" ? value.off : undefined;
				if (why !== undefined) t.assert(message.includes(why), `the refusal of ${name} carries its sentence ${show(why)}: ${message}`);
			};
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
];
