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
} from "./protocol.js";
import { fail, ok, type Result } from "./result.js";

/** One element as a source sees it. Bounds are in window points. */
export interface UiElement {
	/** The source's own identity for the element: the same in every look while the element exists, never reused for another. */
	key: string;
	role: UiRole;
	name?: string;
	value?: string;
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
	window: { id: string; title?: string; bounds: Rect };
	elements: UiElement[];
	/** Whatever else a person would see change (a hash of the window's pixels), so a redraw with the same tree counts. */
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
const STEP_KINDS: ReadonlySet<string> = new Set<DaemonErrorKind>(["not_found", "invalid", "timeout", "denied", "limit", "unsupported", "stale"]);

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

const show = (value: unknown) => JSON.stringify(value) ?? String(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isRef = (value: unknown): value is UiRef => typeof value === "string" && value.length > 1 && value.startsWith("@");
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isPoint = (value: unknown): value is Point => Array.isArray(value) && value.length === 2 && value.every(isWhole);

/** The step's name: the one field that says what it is. */
export function stepName(step: UiStep): StepName {
	return STEP_NAMES.find((name) => name in step) as StepName;
}

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

/** The point a step lands on, if it is aimed at one: a click or scroll at a point, a drag's first point. */
export function stepPoint(step: UiStep): Point | undefined {
	if ("click" in step) return isPoint(step.click) ? step.click : undefined;
	if ("scroll" in step) return isPoint(step.scroll) ? step.scroll : undefined;
	if ("drag" in step) return step.drag[0];
	return undefined;
}

/** A key chord's words: undefined when it is one, else why not. */
function chordWrong(chord: string): string | undefined {
	const names = chord.split("+");
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
	const extra = Object.keys(expect).find((field) => !["text", "ref", "gone", "timeoutMs"].includes(field));
	if (extra !== undefined) return `expect has no field ${show(extra)}`;
	if (expect.text === undefined && expect.ref === undefined) return "expect names neither text nor ref: it needs at least one";
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
		const index = steps.findIndex((step) => stepPoint(step) !== undefined);
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

const contains = ([x, y, w, h]: Rect, [px, py]: Point) => px >= x && py >= y && px < x + w && py < y + h;
/** The deepest element under a point: the last in order whose bounds hold it. */
const under = (view: UiView, point: Point) => view.elements.findLast((element) => contains(element.bounds, point));
const sameRect = (a: Rect, b: Rect) => a.every((value, index) => value === b[index]);
const sameSize = (a: Rect, b: Rect) => a[2] === b[2] && a[3] === b[3];
const looksOf = (element: UiElement) => JSON.stringify([element.role, element.name, element.value, element.bounds, element.flags]);
/** What a person would see of a view: the window's size, its elements and its frame. */
const fingerprint = (view: UiView) => JSON.stringify([view.window.id, view.window.bounds, view.elements.map((element) => [element.key, looksOf(element)]), view.frame]);
const holdsText = (element: UiElement, text: string) => (element.name?.includes(text) ?? false) || (element.value?.includes(text) ?? false);

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

	#ref(key: string): UiRef {
		let ref = this.#refOf.get(key);
		if (ref === undefined) {
			ref = `@e${this.#nextRef++}`;
			this.#refOf.set(key, ref);
			this.#keyOf.set(ref, key);
		}
		return ref;
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
		const wantsImage = params.image !== undefined && params.image !== false;
		if (wantsImage) {
			const off = featureOff(features, "ui.image");
			if (off !== undefined) return fail("unsupported", `ui.observe: ${off}`);
		}
		if (signal.aborted) return aborted("ui.observe");
		const looked = await this.#source.look(params.target, signal);
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
		// Keep the reply within the line limit: the image is whole, so nodes give way.
		const room = MAX_LINE_BYTES - REPLY_ROOM - (image?.data.length ?? 0);
		while (nodes.length > 0 && Buffer.byteLength(JSON.stringify(nodes)) > room) {
			nodes = nodes.slice(0, Math.floor(nodes.length * 0.9));
			truncated = true;
		}
		const state = this.#remember(view);
		return ok({
			state,
			app: view.app,
			window: view.window,
			nodes,
			...(since === undefined ? {} : { diff: this.#diff(since, view) }),
			...(image === undefined ? {} : { image }),
			truncated,
		});
	}

	/** The view's nodes, compact or full, at most MAX_UI_NODES. A compact node's parent is its nearest kept ancestor. */
	#nodes(view: UiView, full: boolean): { nodes: UiNode[]; truncated: boolean } {
		const byKey = new Map(view.elements.map((element) => [element.key, element]));
		const kept = new Set<string>();
		for (const element of view.elements) {
			if (!full && element.name === undefined && element.value === undefined && !(element.actions?.length ?? 0) && !ACTIONABLE.has(element.role)) continue;
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
				ref: this.#ref(element.key),
				role: element.role,
				...(element.name === undefined ? {} : { name: element.name }),
				...(element.value === undefined || element.flags?.includes("secure") ? {} : { value: element.value }),
				...(element.id === undefined ? {} : { id: element.id }),
				bounds: element.bounds,
				...(parent === undefined ? {} : { parent: this.#ref(parent.key) }),
				...(element.flags?.length ? { flags: element.flags } : {}),
				...(element.actions?.length ? { actions: element.actions } : {}),
			});
		}
		return { nodes, truncated };
	}

	#diff(before: UiView, after: UiView): { added: UiRef[]; removed: UiRef[]; changed: UiRef[] } {
		const was = new Map(before.elements.map((element) => [element.key, looksOf(element)]));
		const now = new Set(after.elements.map((element) => element.key));
		const added: UiRef[] = [];
		const changed: UiRef[] = [];
		for (const element of after.elements) {
			const looked = was.get(element.key);
			if (looked === undefined) added.push(this.#ref(element.key));
			else if (looked !== looksOf(element)) changed.push(this.#ref(element.key));
		}
		const removed = before.elements.filter((element) => !now.has(element.key) && this.#refOf.has(element.key)).map((element) => this.#ref(element.key));
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

		if (signal.aborted) return aborted("ui.act");
		const first = await this.#source.look(target, signal);
		if (!first.ok) return first;
		let view = first.value;
		const steps: UiStepResult[] = [];
		for (const [index, step] of params.steps.entries()) {
			if (signal.aborted) return aborted("ui.act");
			if (index > 0) {
				const looked = await this.#source.look(target, signal);
				if (!looked.ok) return looked;
				view = looked.value;
			}
			const refused = this.#check(step, view, params.state, held, features);
			if (refused !== undefined) {
				steps.push({ error: refused });
				break;
			}
			const ref = stepRef(step);
			const element = ref === undefined ? undefined : view.elements.find((one) => one.key === this.#keyOf.get(ref));
			const ran = await this.#source.run(step, { ...(element === undefined ? {} : { element }), view, foreground }, signal);
			if (!ran.ok) {
				if (ran.error.code === "aborted") return ran;
				if (!STEP_KINDS.has(ran.error.code)) return ran;
				steps.push({ error: { kind: ran.error.code as DaemonErrorKind, message: ran.error.message } });
				break;
			}
			steps.push(ran.value);
		}
		const settled = await this.#settle(target, signal);
		if (!settled.ok) return settled;
		let last = settled.value;
		let met: "met" | "unmet" | undefined;
		const refusedStep = steps.some((one) => "error" in one);
		if (params.expect !== undefined && !refusedStep) {
			const expect = params.expect;
			const until = Date.now() + (expect.timeoutMs ?? DEFAULT_EXPECT_MS);
			for (;;) {
				if (this.#holds(expect, last)) {
					met = "met";
					break;
				}
				if (Date.now() >= until) {
					met = "unmet";
					break;
				}
				await sleep(Math.min(this.#pollMs, Math.max(0, until - Date.now())), signal);
				if (signal.aborted) return aborted("ui.act");
				const looked = await this.#source.look(target, signal);
				if (!looked.ok) return looked;
				last = looked.value;
			}
		}
		const state = this.#remember(last);
		return ok({ steps, state, changed: fingerprint(first.value) !== fingerprint(last), ...(met === undefined ? {} : { expect: met }) });
	}

	/** Why a step may not run against this look, as a refusal, or undefined. */
	#check(step: UiStep, view: UiView, stateId: string | undefined, held: UiView | undefined, features: Features): { kind: DaemonErrorKind; message: string } | undefined {
		if ("nav" in step) {
			const off = featureOff(features, "ui.nav");
			if (off !== undefined) return { kind: "unsupported", message: `nav ${step.nav}: ${off}` };
		}
		const ref = stepRef(step);
		if (ref !== undefined) {
			const key = this.#keyOf.get(ref);
			if (!view.elements.some((one) => one.key === key)) return { kind: "stale", message: `${ref} is gone: its element is no longer in the window. Observe again for fresh refs` };
		}
		const point = stepPoint(step);
		if (point !== undefined) {
			if (held === undefined) return { kind: "stale", message: `state ${stateId} is no longer held: observe again, and read the point from the new state` };
			const [x, y] = point;
			if (held.window.id !== view.window.id) return { kind: "stale", message: `the window of state ${stateId} is no longer the one in front: observe again` };
			if (!sameSize(held.window.bounds, view.window.bounds)) return { kind: "stale", message: `the window changed size since state ${stateId}, so (${x}, ${y}) may not land on what it showed: observe again` };
			if (!contains([0, 0, view.window.bounds[2], view.window.bounds[3]], point)) return { kind: "invalid", message: `(${x}, ${y}) is outside the window, which is ${view.window.bounds[2]} by ${view.window.bounds[3]} points` };
			const then = under(held, point);
			const now = under(view, point);
			if (then?.key !== now?.key || (then !== undefined && now !== undefined && (!sameRect(then.bounds, now.bounds) || looksOf(then) !== looksOf(now)))) {
				return { kind: "stale", message: `what is at (${x}, ${y}) changed since state ${stateId}: observe again` };
			}
		}
		return undefined;
	}

	#holds(expect: UiExpect, view: UiView): boolean {
		let seen: boolean;
		if (expect.ref !== undefined) {
			const key = this.#keyOf.get(expect.ref);
			const element = view.elements.find((one) => one.key === key);
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
		const looked = await this.#source.look(target, signal);
		if (!looked.ok) return looked;
		let last = looked.value;
		while (this.#quietMs > 0 && Date.now() < until) {
			await sleep(Math.min(this.#quietMs, Math.max(0, until - Date.now())), signal);
			if (signal.aborted) return aborted("ui.act");
			const next = await this.#source.look(target, signal);
			if (!next.ok) return next;
			const quiet = fingerprint(next.value) === fingerprint(last);
			last = next.value;
			if (quiet) break;
		}
		return ok(last);
	}
}
