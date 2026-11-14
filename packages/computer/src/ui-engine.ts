// The ui group (ui.observe and ui.act) in TypeScript, over a UiSource: what a driver can see of one app's window, and
// what it can do to it. The engine keeps the rules every driver keeps (spec/computer/wire.md, "The ui group"): a ref
// stays good while its element exists; a point is bound to the state it was read from; every act settles before it
// answers; an expect is polled on the computer; a feature that is off is refused with its reason. The fake driver runs
// it over a scripted app, and the adb phone harness over uiautomator. Computerd (Swift) and phoned (Java) keep the same
// rules in their own code.
import {
	DEFAULT_EXPECT_MS,
	DEFAULT_IMAGE_EDGE,
	type DaemonErrorKind,
	type Feature,
	type Features,
	KEYS,
	MAX_BATCH_WAIT_MS,
	MAX_EXPECT_MS,
	MAX_IMAGE_EDGE,
	MAX_LINE_BYTES,
	MAX_SETTLE_MS,
	MAX_STEPS,
	MAX_UI_NODES,
	MIN_IMAGE_EDGE,
	type Point,
	type Rect,
	type UiActParams,
	type UiActResult,
	type UiExpect,
	type UiFlag,
	type UiImage,
	type UiNode,
	type UiObserveParams,
	type UiObserveResult,
	type UiRef,
	type UiRole,
	type UiRoute,
	type UiStep,
	type UiStepResult,
	type UiTarget,
	type UiWindow,
	SET_HOLD_MS,
	UI_ROLES,
} from "./protocol.js";
import { fail, ok, type Result } from "./result.js";

/** One element as a source sees it. Bounds are in window points. */
export interface UiElement {
	/**
	 * The source's own identity for the element in its window: the same in every look while the element exists, never
	 * reused for another. The engine scopes it to the window, so two windows' elements of one key are two refs.
	 */
	key: string;
	role: UiRole;
	name?: string;
	value?: string;
	desc?: string;
	id?: string;
	bounds: Rect;
	/** The key of the element above it. An element comes after its parent. */
	parent?: string;
	flags?: UiFlag[];
	actions?: string[];
}

/** One look at a window. */
export interface UiView {
	app: { id: string; name: string; pid?: number };
	window: UiWindow;
	elements: UiElement[];
	/**
	 * Whatever else a person would see change (a hash of the window's pixels), so a redraw with the same tree counts.
	 * A point with no element under it, and every point while ui.tree is off, stays good only while the frame is the
	 * same. A source that can run with ui.tree off gives one: without it the engine cannot see a redraw under a point.
	 */
	frame?: string;
}

export interface UiRun {
	route: UiRoute;
	verified: boolean;
}

/** What a step is run with: the element its ref names (for type, its into), and the look it was checked against. */
export interface UiStepContext {
	element?: UiElement;
	view: UiView;
	/** The call allows the foreground route. */
	foreground: boolean;
}

/** What a driver can see and do. Each method answers a refusal (a protocol kind, in words) as a failed Result. */
export interface UiSource {
	/** hello.features, as this source offers them now. */
	features(): Features;
	/** A look at the target's window; with no target, the app in front and its main window. */
	look(target: UiTarget | undefined, signal: AbortSignal): Promise<Result<UiView>>;
	/** The window's image, its longest edge at most maxEdge, whole in at most MAX_CHUNK_BYTES. Called only with ui.image on. */
	image(view: UiView, maxEdge: number, signal: AbortSignal): Promise<Result<UiImage>>;
	/** Runs one step, by the best route the call allows. A step it cannot run is refused as unsupported, in words. */
	run(step: UiStep, context: UiStepContext, signal: AbortSignal): Promise<Result<UiRun>>;
	/**
	 * Whether the app is running with no window left (a step closed its last one), which look() answers not_found for.
	 * Absent on a source whose apps always show a window while they run (a phone's).
	 */
	closed?(app: string, signal: AbortSignal): Promise<boolean>;
}

export interface UiEngineOptions {
	/** How long a window must stay the same to count as settled. Default 150 ms; 0 for a source whose every look is settled. */
	quietMs?: number;
	/** How often an expect looks again. Default 50 ms. */
	pollMs?: number;
	/** The longest an act waits to settle. Default and most MAX_SETTLE_MS. */
	settleMs?: number;
}

/** How many states an engine keeps for since and for points; an older one is refused as stale. */
export const UI_STATES_KEPT = 32;

/** The roles a compact observe keeps even without a name: the ones a person acts on. */
const ACTIONABLE: ReadonlySet<UiRole> = new Set<UiRole>(["button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "slider", "combobox", "menuitem", "tab", "listitem", "scrollarea"]);
/** Room a reply keeps for everything but its nodes and image: the envelope and the other fields. */
const REPLY_ROOM = 16 * 1024;
/** The kinds a step's refusal carries; any other failure of a source fails the whole call. */
const STEP_KINDS: ReadonlySet<string> = new Set<DaemonErrorKind>(["not_found", "invalid", "timeout", "denied", "limit", "unsupported", "stale", "refused"]);

type StepName = "press" | "set" | "perform" | "click" | "type" | "key" | "nav" | "scroll" | "drag";
/** Each step's fields: its name first. */
const STEP_FIELDS: Record<StepName, readonly string[]> = {
	press: ["press"],
	set: ["set", "value"],
	perform: ["perform", "action"],
	click: ["click", "button", "count"],
	type: ["type", "into"],
	key: ["key"],
	nav: ["nav"],
	scroll: ["scroll", "dx", "dy"],
	drag: ["drag", "ms"],
};
const STEP_NAMES = Object.keys(STEP_FIELDS) as StepName[];
const KEY_NAMES: ReadonlySet<string> = new Set(KEYS);
const ROLE_NAMES: ReadonlySet<string> = new Set(UI_ROLES);

const show = (value: unknown) => JSON.stringify(value) ?? String(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isRef = (value: unknown): value is UiRef => typeof value === "string" && value.length > 1 && value.startsWith("@");
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isPoint = (value: unknown): value is Point => Array.isArray(value) && value.length === 2 && value.every(isWhole);

/** The ref a step acts on, if any: press, set, perform, a click or scroll at a ref, and type's into. */
export function stepRef(step: UiStep): UiRef | undefined {
	if ("press" in step) return step.press;
	if ("set" in step) return step.set;
	if ("perform" in step) return step.perform;
	if ("click" in step) return isRef(step.click) ? step.click : undefined;
	if ("scroll" in step) return isRef(step.scroll) ? step.scroll : undefined;
	if ("type" in step) return step.into;
	return undefined;
}

/**
 * Every point a step touches, in order: a click or scroll at a point, each point of a drag's path. Each one is held to
 * the same checks (inside the window, nothing changed under it since the state), so a drag's end is no freer than its start.
 */
export function stepPoints(step: UiStep): Point[] {
	if ("click" in step) return isPoint(step.click) ? [step.click] : [];
	if ("scroll" in step) return isPoint(step.scroll) ? [step.scroll] : [];
	if ("drag" in step) return step.drag;
	return [];
}

/**
 * A key chord's names, in order: joined by "+", the last of them may be "+" itself ("+", "shift++"). Every driver reads
 * a chord with it.
 */
export function chordKeys(chord: string): string[] {
	if (chord === "+") return ["+"];
	if (chord.endsWith("++")) return [...chord.slice(0, -2).split("+"), "+"];
	return chord.split("+");
}

/** A key chord's words: undefined when it is one, else why not. */
function chordWrong(chord: string): string | undefined {
	const names = chordKeys(chord);
	const wrong = names.find((name) => !KEY_NAMES.has(name) && !/^[\x21-\x7e]$/.test(name));
	if (chord === "" || wrong !== undefined) return `key ${show(chord)}: each name joined by "+" is one of the key table's (protocol.json keys) or one printable character`;
	return undefined;
}

/** The first way one step breaks its shape, in words, or undefined. */
function stepWrong(step: unknown, at: string): string | undefined {
	if (!isObject(step)) return `${at} is not a step object`;
	const names = STEP_NAMES.filter((name) => name in step);
	if (names.length !== 1) return `${at} names ${names.length === 0 ? "no step" : `${names.join(" and ")}`}: a step is exactly one of ${STEP_NAMES.join(", ")}`;
	const name = names[0];
	const extra = Object.keys(step).find((field) => !STEP_FIELDS[name].includes(field));
	if (extra !== undefined) return `${at}: a ${name} step has no field ${show(extra)}`;
	const ref = (field: string, value: unknown) => (isRef(value) ? undefined : `${at}.${field} is ${show(value)}, not a ref ("@e12")`);
	const text = (field: string, value: unknown) => (typeof value === "string" ? undefined : `${at}.${field} is not a string`);
	const refOrPoint = (field: string, value: unknown) => (isRef(value) || isPoint(value) ? undefined : `${at}.${field} is ${show(value)}: a ref ("@e12") or a point [x, y] of whole window points`);
	const s = step as Record<string, unknown>;
	switch (name) {
		case "press":
			return ref("press", s.press);
		case "set":
			return ref("set", s.set) ?? text("value", s.value);
		case "perform":
			return ref("perform", s.perform) ?? text("action", s.action);
		case "click":
			if (s.button !== undefined && s.button !== "left" && s.button !== "right") return `${at}.button is ${show(s.button)}: "left" or "right"`;
			if (s.count !== undefined && s.count !== 1 && s.count !== 2 && s.count !== 3) return `${at}.count is ${show(s.count)}: 1, 2 or 3`;
			return refOrPoint("click", s.click);
		case "type":
			return text("type", s.type) ?? (s.into === undefined ? undefined : ref("into", s.into));
		case "key":
			return typeof s.key === "string" ? chordWrong(s.key) : `${at}.key is not a string`;
		case "nav":
			return s.nav === "back" || s.nav === "home" || s.nav === "app_switch" ? undefined : `${at}.nav is ${show(s.nav)}: "back", "home" or "app_switch"`;
		case "scroll":
			if (s.dx !== undefined && !isWhole(s.dx)) return `${at}.dx is not a whole number of points`;
			if (s.dy !== undefined && !isWhole(s.dy)) return `${at}.dy is not a whole number of points`;
			return refOrPoint("scroll", s.scroll);
		case "drag":
			if (!Array.isArray(s.drag) || s.drag.length < 2 || !s.drag.every(isPoint)) return `${at}.drag is not 2 or more points [x, y] of whole window points`;
			if (s.ms !== undefined && (!isWhole(s.ms) || s.ms < 0)) return `${at}.ms is not a whole number of milliseconds`;
			return undefined;
	}
}

function targetWrong(target: unknown): string | undefined {
	if (target === undefined) return undefined;
	if (!isObject(target)) return "target is not an object";
	const extra = Object.keys(target).find((field) => field !== "app" && field !== "window");
	if (extra !== undefined) return `target has no field ${show(extra)}: it is { app?, window? }`;
	if (target.app !== undefined && typeof target.app !== "string") return "target.app is not a string";
	if (target.window !== undefined && typeof target.window !== "string") return "target.window is not a string";
	return undefined;
}

function expectWrong(expect: unknown): string | undefined {
	if (expect === undefined) return undefined;
	if (!isObject(expect)) return "expect is not an object";
	const extra = Object.keys(expect).find((field) => !["text", "ref", "window", "gone", "timeoutMs"].includes(field));
	if (extra !== undefined) return `expect has no field ${show(extra)}`;
	if (expect.window !== undefined) {
		if (expect.text !== undefined || expect.ref !== undefined) return "expect.window stands alone: an expect waits for a window, or for text or a ref in the act's window, not both";
		const wanted = expect.window;
		if (!isObject(wanted)) return "expect.window is not an object: it is { title?, role? }";
		const unknown = Object.keys(wanted).find((field) => field !== "title" && field !== "role");
		if (unknown !== undefined) return `expect.window has no field ${show(unknown)}: it is { title?, role? }`;
		if (wanted.title === undefined && wanted.role === undefined) return "expect.window names neither title nor role: it needs at least one";
		if (wanted.title !== undefined && typeof wanted.title !== "string") return "expect.window.title is not a string";
		if (wanted.role !== undefined && !ROLE_NAMES.has(wanted.role as string)) return `expect.window.role is ${show(wanted.role)}, not one of the protocol's roles (uiRoles)`;
	} else if (expect.text === undefined && expect.ref === undefined) return "expect names neither text, ref nor window: it needs one";
	if (expect.text !== undefined && typeof expect.text !== "string") return "expect.text is not a string";
	if (expect.ref !== undefined && !isRef(expect.ref)) return `expect.ref is ${show(expect.ref)}, not a ref ("@e12")`;
	if (expect.gone !== undefined && typeof expect.gone !== "boolean") return "expect.gone is not a boolean";
	if (expect.timeoutMs !== undefined && (!isWhole(expect.timeoutMs) || expect.timeoutMs < 0)) return "expect.timeoutMs is not a whole number of milliseconds";
	return undefined;
}

/** ui.observe's params checked whole: ok, or a refusal (invalid) in words. */
export function checkUiObserve(params: unknown): Result<UiObserveParams> {
	const p = params ?? {};
	if (!isObject(p)) return fail("invalid", "ui.observe's params are not an object");
	const extra = Object.keys(p).find((field) => !["target", "full", "image", "since"].includes(field));
	if (extra !== undefined) return fail("invalid", `ui.observe has no param ${show(extra)}`);
	const wrong = targetWrong(p.target);
	if (wrong !== undefined) return fail("invalid", `ui.observe: ${wrong}`);
	if (p.full !== undefined && typeof p.full !== "boolean") return fail("invalid", "ui.observe: full is not a boolean");
	if (p.since !== undefined && typeof p.since !== "string") return fail("invalid", "ui.observe: since is not a state id");
	if (p.image !== undefined && typeof p.image !== "boolean") {
		const edge = isObject(p.image) ? p.image.maxEdge : undefined;
		if (!isObject(p.image) || Object.keys(p.image).some((field) => field !== "maxEdge") || !isWhole(edge)) return fail("invalid", "ui.observe: image is true, false or { maxEdge }");
		if (edge < MIN_IMAGE_EDGE || edge > MAX_IMAGE_EDGE) return fail("limit", `ui.observe: image.maxEdge ${edge} is outside ${MIN_IMAGE_EDGE} to ${MAX_IMAGE_EDGE} pixels`);
	}
	return ok(p as UiObserveParams);
}

/** ui.act's params checked whole, before any step runs: ok, or a refusal (invalid, limit) in words. */
export function checkUiAct(params: unknown): Result<UiActParams> {
	if (!isObject(params)) return fail("invalid", "ui.act's params are not an object");
	const extra = Object.keys(params).find((field) => !["target", "state", "steps", "expect", "foreground"].includes(field));
	if (extra !== undefined) return fail("invalid", `ui.act has no param ${show(extra)}`);
	const wrongTarget = targetWrong(params.target);
	if (wrongTarget !== undefined) return fail("invalid", `ui.act: ${wrongTarget}`);
	if (params.state !== undefined && typeof params.state !== "string") return fail("invalid", "ui.act: state is not a state id");
	if (params.foreground !== undefined && typeof params.foreground !== "boolean") return fail("invalid", "ui.act: foreground is not a boolean");
	if (!Array.isArray(params.steps)) return fail("invalid", "ui.act: steps is not a list");
	if (params.steps.length > MAX_STEPS) return fail("limit", `ui.act: ${params.steps.length} steps, more than the ${MAX_STEPS} one act holds`);
	for (const [index, step] of params.steps.entries()) {
		const wrong = stepWrong(step, `steps[${index}]`);
		if (wrong !== undefined) return fail("invalid", `ui.act: ${wrong}`);
	}
	const steps = params.steps as UiStep[];
	const dragMs = steps.reduce((sum, step) => sum + ("drag" in step ? (step.ms ?? 0) : 0), 0);
	if (dragMs > MAX_BATCH_WAIT_MS) return fail("limit", `ui.act: the drags ask for ${dragMs} ms, more than the ${MAX_BATCH_WAIT_MS} ms one act may`);
	if (params.state === undefined) {
		const index = steps.findIndex((step) => stepPoints(step).length > 0);
		if (index >= 0) return fail("invalid", `ui.act: steps[${index}] is at a point, and a point needs the state it was read from: pass state`);
	}
	const wrongExpect = expectWrong(params.expect);
	if (wrongExpect !== undefined) return fail("invalid", `ui.act: ${wrongExpect}`);
	const timeout = (params.expect as UiExpect | undefined)?.timeoutMs;
	if (timeout !== undefined && timeout > MAX_EXPECT_MS) return fail("limit", `ui.act: expect.timeoutMs ${timeout} is more than the ${MAX_EXPECT_MS} ms an expect may wait`);
	if (steps.length === 0 && params.expect === undefined) return fail("invalid", "ui.act has no steps and no expect: nothing to do");
	return ok(params as unknown as UiActParams);
}

/** Why a feature is not on, in words, or undefined when it is. */
export function featureOff(features: Features, name: Feature): string | undefined {
	const value = features[name];
	if (value === true) return undefined;
	return value === undefined ? `this computer does not offer ${name}` : `${name} is off here: ${value.off}`;
}

/**
 * A rect of a ui observation, in window points, as screen.shot and input.actions take it: screenshot pixels, the
 * window's origin added and the screen's scale (hello.screen.scale) applied. The one conversion every caller uses.
 */
export function windowRectToPixels([wx, wy]: Rect, scale: number, [x, y, w, h]: Rect): Rect {
	return [Math.round((wx + x) * scale), Math.round((wy + y) * scale), Math.round(w * scale), Math.round(h * scale)];
}

const contains = ([x, y, w, h]: Rect, [px, py]: Point) => px >= x && py >= y && px < x + w && py < y + h;
/**
 * An element's bounds held inside its window of width by height points (wire.md, ui.observe): each edge past the
 * window's moved in to it. A row half scrolled out of a list reports only the part a person sees and taps; one wholly
 * out (offscreen, in a full observe) becomes a line on the edge it left by.
 */
export function insideWindow([x, y, w, h]: Rect, width: number, height: number): Rect {
	const clamp = (value: number, most: number) => Math.min(most, Math.max(0, value));
	const [left, top] = [clamp(x, width), clamp(y, height)];
	return [left, top, clamp(x + w, width) - left, clamp(y + h, height) - top];
}
/** The deepest element under a point: the last in order whose bounds hold it. */
const under = (view: UiView, point: Point) => view.elements.findLast((element) => contains(element.bounds, point));
const sameRect = (a: Rect, b: Rect) => a.every((value, index) => value === b[index]);
const sameSize = (a: Rect, b: Rect) => a[2] === b[2] && a[3] === b[3];
/**
 * The value the engine may read: none for a secure field. Every read of a value goes through it (the nodes, the
 * outline, the diff, the stale checks, the settle, an expect), so no answer is an oracle for a password, not even by
 * telling whether it changed.
 */
const valueOf = (element: UiElement) => (element.flags?.includes("secure") ? undefined : element.value);
const looksOf = (element: UiElement) => JSON.stringify([element.role, element.name, valueOf(element), element.desc, element.bounds, element.flags]);
/**
 * What a person would see of a view, for the settle and an act's changed: the window, and its elements when it has
 * any. The frame (a hash of its pixels) counts only with no elements (ui.tree off, or a window with none): a blinking
 * caret or a spinner redraws the frame under the same tree, which held each settle to maxSettleMs (Notes on a Mac: 13.5 s
 * against 1.9 s on the tree) and counted as a step's effect. A state keeps its frame, for a point with no element. Only
 * what is on the window counts, with its bounds held inside it as ui.observe shows them: System Settings rebuilds its
 * sidebar rows scrolled out of view each time its tree is read (so the list's content is a new height each time), and
 * Finder's status bar below the window counts the free disk space, which held every settle there to maxSettleMs too.
 */
const fingerprint = (view: UiView) =>
	JSON.stringify([
		view.window.id,
		view.window.bounds,
		view.elements.length > 0
			? view.elements.filter((element) => onWindow(view, element.bounds)).map((element) => [element.key, looksOf({ ...element, bounds: insideWindow(element.bounds, view.window.bounds[2], view.window.bounds[3]) })])
			: view.frame,
	]);
/** The bounds (window points) reach into the window. */
const onWindow = (view: UiView, [x, y, w, h]: Rect) => x < view.window.bounds[2] && 0 < x + w && y < view.window.bounds[3] && 0 < y + h;
/** Whether an element says text, in its name, value or desc. */
const holdsText = (element: UiElement, text: string) => [element.name, valueOf(element), element.desc].some((said) => said?.includes(text) ?? false);
/** An element's key scoped to its window: what a ref stands for. */
const scopedKey = (view: UiView, key: string) => `${view.window.id}\n${key}`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

const aborted = (method: string): Result<never> => fail("aborted", `${method} was cancelled`);

/**
 * The ui group over one source, for one connection: its refs and states are this connection's own. Calls run one at a
 * time in arrival order, so one act's steps never interleave with another's.
 */
export class UiEngine {
	readonly #source: UiSource;
	readonly #quietMs: number;
	readonly #pollMs: number;
	readonly #settleMs: number;
	readonly #refOf = new Map<string, UiRef>();
	readonly #keyOf = new Map<UiRef, string>();
	readonly #states = new Map<string, UiView>();
	#nextRef = 1;
	#nextState = 1;
	#turn: Promise<unknown> = Promise.resolve();

	constructor(source: UiSource, options: UiEngineOptions = {}) {
		this.#source = source;
		this.#quietMs = options.quietMs ?? 150;
		this.#pollMs = options.pollMs ?? 50;
		this.#settleMs = Math.min(options.settleMs ?? MAX_SETTLE_MS, MAX_SETTLE_MS);
	}

	/** hello.features, as the source offers them now. */
	features(): Features {
		return this.#source.features();
	}

	observe(params: unknown, signal: AbortSignal = new AbortController().signal): Promise<Result<UiObserveResult>> {
		return this.#inTurn(() => this.#observe(params, signal));
	}

	act(params: unknown, signal: AbortSignal = new AbortController().signal): Promise<Result<UiActResult>> {
		return this.#inTurn(() => this.#act(params, signal));
	}

	#inTurn<T>(fn: () => Promise<T>): Promise<T> {
		const turn = this.#turn.then(fn);
		this.#turn = turn.catch(() => undefined);
		return turn;
	}

	/** The ref of a view's element key, given once per window and key. */
	#ref(view: UiView, key: string): UiRef {
		const scoped = scopedKey(view, key);
		let ref = this.#refOf.get(scoped);
		if (ref === undefined) {
			ref = `@e${this.#nextRef++}`;
			this.#refOf.set(scoped, ref);
			this.#keyOf.set(ref, scoped);
		}
		return ref;
	}

	/** The view's element a ref stands for: undefined when it is gone, or of another window. */
	#elementOf(view: UiView, ref: UiRef): UiElement | undefined {
		const scoped = this.#keyOf.get(ref);
		return view.elements.find((one) => scopedKey(view, one.key) === scoped);
	}

	#remember(view: UiView): string {
		const state = `s${this.#nextState++}`;
		this.#states.set(state, view);
		for (const old of this.#states.keys()) {
			if (this.#states.size <= UI_STATES_KEPT) break;
			this.#states.delete(old);
		}
		return state;
	}

	async #observe(raw: unknown, signal: AbortSignal): Promise<Result<UiObserveResult>> {
		const checked = checkUiObserve(raw);
		if (!checked.ok) return checked;
		const params = checked.value;
		const features = this.#source.features();
		const imageOff = featureOff(features, "ui.image");
		// With the tree off, the image is the whole observation: it comes asked for or not, and with no image either,
		// there is nothing to see.
		const treeOff = featureOff(features, "ui.tree");
		if (treeOff !== undefined && imageOff !== undefined) return fail("denied", `ui.observe: ${treeOff}, and ${imageOff}: there is nothing to see`);
		const wantsImage = treeOff !== undefined || (params.image !== undefined && params.image !== false);
		if (wantsImage && imageOff !== undefined) return fail("unsupported", `ui.observe: ${imageOff}`);
		if (signal.aborted) return aborted("ui.observe");
		const looked = await this.#see(params.target, signal);
		if (!looked.ok) return looked;
		const view = looked.value;
		let image: UiImage | undefined;
		if (wantsImage) {
			const edge = typeof params.image === "object" ? params.image.maxEdge : DEFAULT_IMAGE_EDGE;
			const shot = await this.#source.image(view, edge, signal);
			if (!shot.ok) return shot;
			image = shot.value;
		}
		if (signal.aborted) return aborted("ui.observe");
		const since = params.since === undefined ? undefined : this.#states.get(params.since);
		let { nodes, truncated } = this.#nodes(view, params.full === true);
		// Keep the reply within the line limit: everything but the nodes (the image, the diff) is whole, so nodes give way.
		const rest = {
			app: view.app,
			window: view.window,
			...(since === undefined ? {} : { diff: this.#diff(since, view) }),
			...(image === undefined ? {} : { image }),
			...(treeOff === undefined ? {} : { empty: treeOff }),
		};
		const room = MAX_LINE_BYTES - REPLY_ROOM - Buffer.byteLength(JSON.stringify(rest));
		if (room < 0) return fail("limit", `ui.observe: the image and the diff since ${params.since ?? "no state"} are more than one reply holds: observe with a smaller image, or without since`);
		while (nodes.length > 0 && Buffer.byteLength(JSON.stringify(nodes)) > room) {
			nodes = nodes.slice(0, Math.floor(nodes.length * 0.9));
			truncated = true;
		}
		const state = this.#remember(view);
		return ok({ state, nodes, ...rest, truncated });
	}

	/** A look at the target, with no elements while the tree is off: a source never shows what the feature hides. */
	async #see(target: UiTarget | undefined, signal: AbortSignal): Promise<Result<UiView>> {
		const looked = await this.#source.look(target, signal); // the one direct look
		if (!looked.ok || featureOff(this.#source.features(), "ui.tree") === undefined) return looked;
		return ok({ ...looked.value, elements: [] });
	}

	/** The view's nodes, compact or full, at most MAX_UI_NODES. A compact node's parent is its nearest kept ancestor. */
	#nodes(view: UiView, full: boolean): { nodes: UiNode[]; truncated: boolean } {
		const byKey = new Map(view.elements.map((element) => [element.key, element]));
		const kept = new Set<string>();
		for (const element of view.elements) {
			if (!full && element.name === undefined && valueOf(element) === undefined && element.desc === undefined && !(element.actions?.length ?? 0) && !ACTIONABLE.has(element.role)) continue;
			// The element, and every element above it, so each node's parent is in the list.
			for (let at: UiElement | undefined = element; at !== undefined && !kept.has(at.key); at = at.parent === undefined ? undefined : byKey.get(at.parent)) kept.add(at.key);
		}
		const nodes: UiNode[] = [];
		let truncated = false;
		for (const element of view.elements) {
			if (!kept.has(element.key)) continue;
			if (nodes.length >= MAX_UI_NODES) {
				truncated = true;
				break;
			}
			let parent = element.parent === undefined ? undefined : byKey.get(element.parent);
			while (parent !== undefined && !kept.has(parent.key)) parent = parent.parent === undefined ? undefined : byKey.get(parent.parent);
			nodes.push({
				ref: this.#ref(view, element.key),
				role: element.role,
				...(element.name === undefined ? {} : { name: element.name }),
				...(valueOf(element) === undefined ? {} : { value: valueOf(element) }),
				...(element.desc === undefined ? {} : { desc: element.desc }),
				...(element.id === undefined ? {} : { id: element.id }),
				bounds: insideWindow(element.bounds, view.window.bounds[2], view.window.bounds[3]),
				...(parent === undefined ? {} : { parent: this.#ref(view, parent.key) }),
				...(element.flags?.length ? { flags: element.flags } : {}),
				...(element.actions?.length ? { actions: element.actions } : {}),
			});
		}
		return { nodes, truncated };
	}

	#diff(before: UiView, after: UiView): { added: UiRef[]; removed: UiRef[]; changed: UiRef[] } {
		// Keys are each window's own: across two windows every element is added or removed.
		const was = new Map(before.elements.map((element) => [scopedKey(before, element.key), looksOf(element)]));
		const now = new Set(after.elements.map((element) => scopedKey(after, element.key)));
		const added: UiRef[] = [];
		const changed: UiRef[] = [];
		for (const element of after.elements) {
			const looked = was.get(scopedKey(after, element.key));
			if (looked === undefined) added.push(this.#ref(after, element.key));
			else if (looked !== looksOf(element)) changed.push(this.#ref(after, element.key));
		}
		const removed = before.elements
			.filter((element) => !now.has(scopedKey(before, element.key)) && this.#refOf.has(scopedKey(before, element.key)))
			.map((element) => this.#ref(before, element.key));
		return { added, removed, changed };
	}

	async #act(raw: unknown, signal: AbortSignal): Promise<Result<UiActResult>> {
		const checked = checkUiAct(raw);
		if (!checked.ok) return checked;
		const params = checked.value;
		const unknown = [...params.steps.map(stepRef), params.expect?.ref].find((ref) => ref !== undefined && !this.#keyOf.has(ref));
		if (unknown !== undefined) return fail("invalid", `ui.act: ${unknown} is not a ref this connection was given: observe first`);
		const held = params.state === undefined ? undefined : this.#states.get(params.state);
		const target: UiTarget | undefined = params.target ?? (held === undefined ? undefined : { app: held.app.id, window: held.window.id });
		const foreground = params.foreground === true;
		const features = this.#source.features();
		const treeOff = featureOff(features, "ui.tree");
		const waitsForWindow = params.expect?.window !== undefined;
		// A window expect reads only the window's title and role, which a source gives with the tree off too.
		if (treeOff !== undefined && params.expect !== undefined && !waitsForWindow) return fail("unsupported", `ui.act: an expect reads the window's elements, and ${treeOff}`);

		if (signal.aborted) return aborted("ui.act");
		const first = await this.#see(target, signal);
		// A wait for a window may begin with none: its app's window not there yet is what it waits for, never not_found.
		const windowless = !first.ok && first.error.code === "not_found" && waitsForWindow && params.steps.length === 0;
		if (!first.ok && !windowless) return first;
		let view: UiView | undefined = first.ok ? first.value : undefined;
		// Where the looks after a step aim. A step that ran may have changed the app in front: a nav (home, back, recents)
		// hands the act to whatever is in front, and when any other step (a key, a tap that opens another app) takes the
		// target's window away, the act runs nothing more and settles on the window in front. A step that closes the
		// aimed window hands the act to its app's next main window, as a nav does; when the app has no window left, the
		// act answers window "closed" and no state. Either way the steps that ran keep their results. An act with neither
		// target nor state is bound to the app it began on, so a step that opens another app never lets a later step
		// reach that one: only a nav hands the act on.
		// A target that names only a window is bound to the app that window is in, from the first look: a window expect and
		// a closed window's follow then read that app, never whichever is in front.
		let aim: UiTarget | undefined = target === undefined ? (view === undefined ? undefined : { app: view.app.id }) : target.app === undefined && view !== undefined ? { ...target, app: view.app.id } : target;
		/** Where the act goes once its aimed window is not found: the app's next main window, closed, or gone (out of reach). */
		const reaim = async (): Promise<Result<"followed" | "closed" | "gone">> => {
			const app = aim?.app;
			if (app !== undefined && aim?.window !== undefined) {
				const next = await this.#see({ app }, signal);
				if (next.ok) {
					aim = { app };
					return ok("followed");
				}
				if (next.error.code !== "not_found") return next;
			}
			if (app !== undefined && (await this.#source.closed?.(app, signal)) === true) return ok("closed");
			aim = undefined;
			return ok("gone");
		};
		const after = async (): Promise<Result<UiView> | "gone" | "closed"> => {
			const looked = await this.#see(aim, signal);
			if (looked.ok || looked.error.code !== "not_found" || aim === undefined) return looked;
			const where = await reaim();
			if (!where.ok) return where;
			return where.value === "followed" ? this.#see(aim, signal) : where.value;
		};
		const appName = view?.app.name ?? aim?.app ?? "the app";
		const steps: UiStepResult[] = [];
		let closed = false;
		for (const [index, step] of params.steps.entries()) {
			if (signal.aborted) return aborted("ui.act");
			if (index > 0) {
				const looked = await after();
				if (looked === "gone") {
					steps.push({ error: { kind: "stale", message: "the window this act aimed at is gone since the step before (it went to another app): observe again" } });
					break;
				}
				if (looked === "closed") {
					closed = true;
					steps.push({ error: { kind: "stale", message: `${appName} has no window left: the step before closed its last one, so this step has nothing to act on` } });
					break;
				}
				if (!looked.ok) return looked;
				view = looked.value;
			}
			if (view === undefined) break;
			const refused = this.#check(step, view, params.state, held, features);
			if (refused !== undefined) {
				steps.push({ error: refused });
				break;
			}
			const ref = stepRef(step);
			const element = ref === undefined ? undefined : this.#elementOf(view, ref);
			const ran = await this.#source.run(step, { ...(element === undefined ? {} : { element }), view, foreground }, signal);
			if (!ran.ok) {
				if (ran.error.code === "aborted") return ran;
				if (!STEP_KINDS.has(ran.error.code)) return ran;
				steps.push({ error: { kind: ran.error.code as DaemonErrorKind, message: ran.error.message } });
				break;
			}
			steps.push(ran.value);
			if ("nav" in step) aim = undefined;
		}
		const ranAny = steps.some((one) => !("error" in one));
		/** The act's window, settled: the aimed one, or the app's next main window once it closed; undefined when none is left. */
		const settleAim = async (): Promise<Result<UiView | undefined>> => {
			if (closed) return ok(undefined);
			let settled = await this.#settle(aim, signal);
			// A wait that began with no window keeps its app: it never follows the foreground and never ends as closed.
			if (!settled.ok && settled.error.code === "not_found" && aim !== undefined && !windowless) {
				const where = await reaim();
				if (!where.ok) return where;
				if (where.value === "closed") {
					closed = true;
					return ok(undefined);
				}
				if (where.value === "followed" || ranAny) settled = await this.#settle(aim, signal);
			}
			if (settled.ok || !(windowless && settled.error.code === "not_found")) return settled;
			return ok(undefined);
		};
		/** Where a window expect looks: the app's main window, whichever it is now, never the window the act was aimed at. */
		const frontOf = (): UiTarget | undefined => (aim?.app === undefined ? undefined : { app: aim.app });
		/**
		 * The act's final view, read after its last settle: the act's window, and for a window expect the app's main
		 * window, each settled. Every verdict of the act reads this one view: a set's hold, the expect, and the state it
		 * answers. A read that is not final (a poll's look) only says when to read it again.
		 */
		const final = async (): Promise<Result<{ view: UiView | undefined; front: UiView | undefined }>> => {
			const view = await settleAim();
			if (!view.ok) return view;
			if (!waitsForWindow || closed || aim?.window === undefined) return ok({ view: view.value, front: view.value });
			const front = await this.#settle(frontOf(), signal);
			if (!front.ok && front.error.code !== "not_found") return front;
			return ok({ view: view.value, front: front.ok ? front.value : undefined });
		};
		let read = await final();
		if (!read.ok) return read;
		// A set holds: the final view is read no sooner than SET_HOLD_MS after the first settle, where an app that took the
		// value back answers false. The hold is waited out even when the window closed: a value that cannot be read after
		// it is not verified.
		const sets = params.steps.flatMap((step, index) => {
			const result = steps[index];
			return "set" in step && result !== undefined && !("error" in result) && result.verified ? [index] : [];
		});
		if (sets.length > 0) {
			await sleep(SET_HOLD_MS, signal);
			if (signal.aborted) return aborted("ui.act");
			read = await final();
			if (!read.ok) return read;
		}
		let met: "met" | "unmet" | undefined;
		const refusedStep = steps.some((one) => "error" in one);
		if (params.expect !== undefined && !refusedStep) {
			const expect = params.expect;
			/** What the expect reads in a view: a window expect the app's main window, any other the act's window. */
			const judged = (seen: { view: UiView | undefined; front: UiView | undefined }) => this.#holds(expect, waitsForWindow ? seen.front : seen.view);
			/** A quick look between final reads, the same window judged reads; undefined when there is none. */
			const peek = async (): Promise<Result<UiView | undefined>> => {
				if (waitsForWindow) {
					const looked = await this.#see(frontOf(), signal);
					return looked.ok || looked.error.code !== "not_found" ? looked : ok(undefined);
				}
				const looked = await after();
				if (looked === "closed") closed = true;
				return looked === "gone" || looked === "closed" ? ok(undefined) : looked;
			};
			const until = Date.now() + (expect.timeoutMs ?? DEFAULT_EXPECT_MS);
			for (;;) {
				if (judged(read.value)) {
					met = "met";
					break;
				}
				// A window that closed shows nothing again: what it held is gone, and what it did not hold never comes.
				if (closed || Date.now() >= until) {
					met = "unmet";
					break;
				}
				// Poll with quick looks until one holds, the window closes or the time is up; then read the final view again,
				// so a look caught mid-transition never decides the act.
				for (;;) {
					await sleep(Math.min(this.#pollMs, Math.max(0, until - Date.now())), signal);
					if (signal.aborted) return aborted("ui.act");
					const looked = await peek();
					if (!looked.ok) return looked;
					if (closed || Date.now() >= until || this.#holds(expect, looked.value)) break;
				}
				read = await final();
				if (!read.ok) return read;
			}
		}
		const { view: own, front } = read.value;
		for (const index of sets) {
			if (own === undefined || !this.#setHolds(params.steps[index] as { set: UiRef; value: string }, own)) steps[index] = { ...(steps[index] as UiRun), verified: false };
		}
		// A met window expect answers the window that met it; every other act answers its own window.
		const answered = waitsForWindow && met === "met" ? front : own;
		const expectAnswer = met === undefined ? {} : { expect: met };
		if (closed || answered === undefined) return ok({ steps, window: "closed", changed: true, ...expectAnswer });
		const state = this.#remember(answered);
		return ok({ steps, state, changed: !first.ok || fingerprint(first.value) !== fingerprint(answered), ...expectAnswer });
	}

	/** Whether a set's value is still what it set: a switch's or checkbox's checked flag, else the element's value. */
	#setHolds(step: { set: UiRef; value: string }, view: UiView): boolean {
		const element = this.#elementOf(view, step.set);
		if (element === undefined) return false;
		// A secure field's value is never read (valueOf): its set stands as the source verified it.
		if (element.flags?.includes("secure")) return true;
		if (element.role === "switch" || element.role === "checkbox" || element.role === "radio") return (step.value === "on") === (element.flags?.includes("checked") ?? false);
		return valueOf(element) === step.value;
	}

	/** Why a step may not run against this look, as a refusal, or undefined. */
	#check(step: UiStep, view: UiView, stateId: string | undefined, held: UiView | undefined, features: Features): { kind: DaemonErrorKind; message: string } | undefined {
		if ("nav" in step) {
			const off = featureOff(features, "ui.nav");
			if (off !== undefined) return { kind: "unsupported", message: `nav ${step.nav}: ${off}` };
		}
		const ref = stepRef(step);
		if (ref !== undefined) {
			if (this.#elementOf(view, ref) === undefined) return { kind: "stale", message: `${ref} is gone: its element is no longer in the window. Observe again for fresh refs` };
		}
		const points = stepPoints(step);
		if (points.length > 0) {
			if (held === undefined) return { kind: "stale", message: `state ${stateId} is no longer held: observe again, and read the point from the new state` };
			if (held.window.id !== view.window.id) return { kind: "stale", message: `the window of state ${stateId} is no longer the one in front: observe again` };
		}
		for (const point of points) {
			if (held === undefined) break;
			const [x, y] = point;
			if (!sameSize(held.window.bounds, view.window.bounds)) return { kind: "stale", message: `the window changed size since state ${stateId}, so (${x}, ${y}) may not land on what it showed: observe again` };
			if (!contains([0, 0, view.window.bounds[2], view.window.bounds[3]], point)) return { kind: "invalid", message: `(${x}, ${y}) is outside the window, which is ${view.window.bounds[2]} by ${view.window.bounds[3]} points` };
			const then = under(held, point);
			const now = under(view, point);
			if (then?.key !== now?.key || (then !== undefined && now !== undefined && (!sameRect(then.bounds, now.bounds) || looksOf(then) !== looksOf(now)))) {
				return { kind: "stale", message: `what is at (${x}, ${y}) changed since state ${stateId}: observe again` };
			}
			// With no element under the point (always so with ui.tree off), only the frame can say the window still shows
			// what the state did.
			if (then === undefined && held.frame !== view.frame) {
				return { kind: "stale", message: `the window shows something else than at state ${stateId}, so (${x}, ${y}) may not land on what it showed: observe again` };
			}
		}
		return undefined;
	}

	/** Whether the expect holds on a look; no look (no window) shows nothing, so only a gone expect holds there. */
	#holds(expect: UiExpect, view: UiView | undefined): boolean {
		let seen: boolean;
		if (view === undefined) seen = false;
		else if (expect.window !== undefined) {
			const { title, role } = expect.window;
			seen = (title === undefined || (view.window.title?.includes(title) ?? false)) && (role === undefined || (view.window.role ?? "window") === role);
		} else if (expect.ref !== undefined) {
			const element = this.#elementOf(view, expect.ref);
			seen = element !== undefined && (expect.text === undefined || holdsText(element, expect.text));
		} else {
			const text = expect.text as string;
			seen = view.elements.some((element) => holdsText(element, text));
		}
		return expect.gone === true ? !seen : seen;
	}

	/** Looks until two looks quietMs apart are the same, or settleMs passes: the settled look. */
	async #settle(target: UiTarget | undefined, signal: AbortSignal): Promise<Result<UiView>> {
		const until = Date.now() + this.#settleMs;
		const looked = await this.#see(target, signal);
		if (!looked.ok) return looked;
		let last = looked.value;
		while (this.#quietMs > 0 && Date.now() < until) {
			await sleep(Math.min(this.#quietMs, Math.max(0, until - Date.now())), signal);
			if (signal.aborted) return aborted("ui.act");
			const next = await this.#see(target, signal);
			if (!next.ok) return next;
			const quiet = fingerprint(next.value) === fingerprint(last);
			last = next.value;
			if (quiet) break;
		}
		return ok(last);
	}
}
