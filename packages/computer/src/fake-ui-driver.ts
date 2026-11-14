// A fake ui driver: scripted apps answered over the wire, with no Mac and no phone. It speaks protocol 0.2's hello,
// ping, apps and ui groups as JSON-RPC lines (the stdio binding's framing), and runs the ui group through UiEngine, so
// it keeps every rule a real driver keeps: refs that survive while their element exists, points refused as stale when
// the window changed under them, an act that settles before it answers, and expect polled until it holds.
//
//   const { client, hello, driver } = await fakeUiConnection();    // in process, over a real line stream
//   runConformance(fakeUiProvider(), { image: "fake-ui", only: ["ui"] })   // as a provider, each connection its own refs
//   node packages/computer/dist/fake-ui-driver.js [apps.json]      // the same driver on stdin and stdout
//
// Its default app is the ui fixture (conformance/ui-fixture.ts). Pass apps of your own to script others.
import { readFileSync } from "node:fs";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { type AttachSocket, socketStreams } from "./attach.js";
import { DaemonClient } from "./client.js";
import { type FakeApp, type FakeEffect, type FakeElement, UI_FIXTURE } from "./conformance/ui-fixture.js";
import { isCommand } from "./entry.js";
import {
	CANCEL_METHOD,
	type ComputerKind,
	type ComputerOs,
	type DaemonErrorKind,
	type Features,
	type Group,
	type HelloResult,
	JSONRPC_CODES,
	LAUNCH_WINDOW_MS,
	MAX_LINE_BYTES,
	PROTOCOL_VERSION,
	type UiFlag,
	type UiImage,
	type UiStep,
	type UiTarget,
} from "./protocol.js";
import { CreateRequests, endedWords, otherSpecWords, specDiffer } from "./create-requests.js";
import { type ComputerCapabilities, type ComputerConnection, type ComputerProvider, type ComputerSpec, checkLifetime, kindRefusals } from "./provider.js";
import { fail, ok, type Result } from "./result.js";
import { featureOff, UiEngine, type UiRun, type UiSource, type UiStepContext, type UiView } from "./ui-engine.js";

export { type FakeApp, type FakeEffect, type FakeElement, type FakeScreen, NEXT_ANIMATE_MS, NEXT_MS, SAVED_MS, UI_FIXTURE } from "./conformance/ui-fixture.js";

export interface FakeUiOptions {
	/** The apps it has installed. Default the ui fixture alone. */
	apps?: FakeApp[];
	/** Default "macos" and "desktop". */
	os?: ComputerOs;
	kind?: ComputerKind;
	/** Over the defaults: ui.image, ui.background and apps.background on; ui.foreground on; ui.nav off on a desktop. */
	features?: Features;
	/** The settle window the engine waits for; default 50 ms, so tests stay quick. */
	quietMs?: number;
	/**
	 * It cannot tell which elements background input reaches, as on a Mac, where a click posted to the app may never
	 * reach a view that takes real input only. A click on a foreground element without foreground: true then goes the
	 * background route, lands nowhere, and answers verified false. Default false: such a click is refused denied.
	 */
	blindBackground?: boolean;
	/**
	 * The groups its hello declares. Default apps and ui, the only methods it answers: a desktop or phone no agent is
	 * given (health.kind-served fails it by the groups it lacks, and serve refuses it at attach). A test of serve's side
	 * of attach declares a served kind's groups; the fake still answers only apps and ui.
	 */
	groups?: Group[];
	/**
	 * An app's window comes this long after apps.launch starts it, as a real app takes a moment to draw its first window.
	 * Launch waits for it (wire.md, apps.launch), so an observe right after it still finds the window. Default 0.
	 */
	windowAfterMs?: number;
	/**
	 * A focused text field's caret blinks: every look of its window draws a different frame, with the same tree, as a
	 * real caret does. A settle on the tree (wire.md, ui.act) is quiet anyway; one on the image would never be.
	 */
	blink?: boolean;
}

/**
 * One window of a running app, which owns everything a person sees change in it: its screen and the screens behind it,
 * its fields' values, its switches, its focus, and the effects a press in it still has pending. Two windows on one
 * screen share nothing. The main window is just the first one an app opens.
 */
interface FakeWindow {
	id: string;
	screen: string;
	history: string[];
	values: Map<string, string>;
	checked: Set<string>;
	focus?: string;
	/** Until when it is between two screens: each look then shows a different frame. */
	animateUntil: number;
	/** Where it is, in screen points. */
	bounds: [number, number, number, number];
	/** Its pending effects (a press's `after`, a value taken back): cancelled when it closes, so none outlives it. */
	timers: Set<NodeJS.Timeout>;
}

/** What one app is doing: its windows, the one in front last. None: it runs with no window (its last one closed). */
interface AppState {
	app: string;
	windows: FakeWindow[];
	/** When its first window shows (windowAfterMs after launch): before then it is running with no window. */
	windowAt: number;
	/** Where its main window opens, in screen points; a window a press opens is offset from it. */
	origin: [number, number, number, number];
	/** How many windows a press has opened, which names the next one. */
	opened: number;
	/** How many main windows a launch has opened: the first is <app>#main, each one after its last window closed is
	 *  <app>#main-<n>, a new window whose refs are never the closed one's. */
	mains: number;
}

const SCREEN = { width: 1440, height: 900, scale: 2 };

/** The methods the fake answers; any other is method-not-found on the wire. */
export const FAKE_UI_METHODS: ReadonlySet<string> = new Set(["hello", "ping", "apps.list", "apps.launch", "apps.terminate", "ui.observe", "ui.act"]);

/** Error kinds as JSON-RPC codes (wire.md, Errors). */
const codeOf = (kind: string): number =>
	kind === "invalid" ? JSONRPC_CODES.invalidParams : kind === "aborted" ? JSONRPC_CODES.requestCancelled : JSONRPC_CODES.server;

/** A PNG of one colour, width x height: enough for a caller to decode its size. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed) >>> 0);
		return Buffer.concat([length, typed, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A colour for a screen's name, so two screens' images differ. */
const colourOf = (name: string): [number, number, number] => {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return [hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff];
};

/** The scripted apps, and the protocol methods they answer. */
export class FakeUiDriver implements UiSource {
	readonly apps: ReadonlyMap<string, FakeApp>;
	readonly os: ComputerOs;
	readonly kind: ComputerKind;
	readonly groups: readonly Group[];
	/** Every method called, in order, with its params: what a test asserts reached the computer. */
	readonly calls: Array<[string, unknown]> = [];
	readonly #features: Features;
	readonly #quietMs: number;
	readonly #blind: boolean;
	readonly #windowAfterMs: number;
	readonly #blink: boolean;
	readonly #running = new Map<string, AppState>();
	#front: string | undefined;
	#frames = 0;

	constructor(options: FakeUiOptions = {}) {
		const apps = options.apps ?? [UI_FIXTURE];
		this.apps = new Map(apps.map((app) => [app.id, app]));
		this.os = options.os ?? "macos";
		this.kind = options.kind ?? "desktop";
		this.groups = options.groups ?? ["apps", "ui"];
		const touch = this.kind === "android" || this.kind === "ios";
		this.#features = {
			"apps.background": touch ? { off: "an app a phone opens comes to the front" } : true,
			"ui.tree": true,
			"ui.image": true,
			"ui.background": true,
			"ui.foreground": true,
			"ui.nav": touch ? true : { off: "a desktop has no system back, home or app switch" },
			...options.features,
		};
		this.#quietMs = options.quietMs ?? 50;
		this.#blind = options.blindBackground ?? false;
		this.#windowAfterMs = options.windowAfterMs ?? 0;
		this.#blink = options.blink ?? false;
	}

	/** Whether the app runs with no window left: a press closed its last one (UiSource.closed). */
	async closed(app: string): Promise<boolean> {
		return this.#running.get(app)?.windows.length === 0;
	}

	/** A connection's own ui engine: its refs and states are that connection's alone (wire.md, The ui group). */
	engine(): UiEngine {
		return new UiEngine(this, { quietMs: this.#quietMs, pollMs: 20 });
	}

	hello(): HelloResult {
		return { protocol: PROTOCOL_VERSION, version: "fake", os: this.os, kind: this.kind, arch: "arm64", groups: [...this.groups], screen: SCREEN, osVersion: this.os === "android" ? "15 (API 35)" : "26.1 (25B78)", features: this.#features, device: { maker: "AgentRun", model: "Fake ui driver" } };
	}

	/** The screen an app's window in front shows now, by its name; undefined when it is not running or has no window. */
	screenOf(app: string): string | undefined {
		return this.#running.get(app)?.windows.at(-1)?.screen;
	}

	/** Moves an app's window in front, or changes its size (points): a point read before a size change is then stale. */
	place(app: string, bounds: [number, number, number, number]): void {
		const win = this.#running.get(app)?.windows.at(-1);
		if (win !== undefined) win.bounds = bounds;
	}

	/** Ends every app, and every effect its windows had pending. */
	close(): void {
		for (const state of this.#running.values()) this.#end(state);
		this.#running.clear();
		this.#front = undefined;
	}

	/** Ends an app's windows: each one's pending effects are cancelled. */
	#end(state: AppState): void {
		for (const win of [...state.windows]) this.#closeWindow(state, win);
	}

	/** Closes one window: its pending effects are cancelled, so a delayed press in it never lands anywhere else. */
	#closeWindow(state: AppState, win: FakeWindow): void {
		for (const timer of win.timers) clearTimeout(timer);
		win.timers.clear();
		state.windows = state.windows.filter((one) => one !== win);
	}

	/** A new window of the app on a screen, in front: its checked and focused start from the script, and nothing else is shared. */
	#openWindow(state: AppState, app: FakeApp, id: string, screen: string, bounds: [number, number, number, number]): FakeWindow {
		// look() shows checked and focused from the window's state alone, never the script's flags: the state starts from them.
		const scriptedWith = (flag: UiFlag) => Object.values(app.screens).flatMap((one) => one.elements.filter((element) => element.flags?.includes(flag)).map((element) => element.key));
		const focus = app.screens[screen]?.elements.find((element) => element.flags?.includes("focused"))?.key;
		const win: FakeWindow = { id, screen, history: [], values: new Map(), checked: new Set(scriptedWith("checked")), ...(focus === undefined ? {} : { focus }), animateUntil: 0, bounds, timers: new Set() };
		state.windows.push(win);
		return win;
	}

	/** Runs effect ms from now as a pending effect of window: never once the window closed (its timers are cancelled then). */
	#later(state: AppState, win: FakeWindow, ms: number, effect: () => void): void {
		const timer = setTimeout(() => {
			win.timers.delete(timer);
			if (state.windows.includes(win)) effect();
		}, ms);
		win.timers.add(timer);
	}

	/** One method call on a connection, as a computer answers it; ui calls go through that connection's engine. */
	async handle(engine: UiEngine, method: string, params: unknown, signal: AbortSignal = new AbortController().signal): Promise<Result<unknown>> {
		this.calls.push([method, params]);
		const p = (params ?? {}) as Record<string, unknown>;
		switch (method) {
			case "hello":
				return ok(this.hello());
			case "ping":
				return ok({});
			case "apps.list":
				return ok({ apps: [...this.apps.values()].map(({ id, name }) => ({ id, name })), foreground: this.#front ?? null });
			case "apps.launch": {
				const launched = this.#launch(p);
				return launched.ok ? this.windowOf(p.id as string, signal) : launched;
			}
			case "apps.terminate": {
				if (typeof p.id !== "string") return fail("invalid", "apps.terminate: id is not a string");
				const state = this.#running.get(p.id);
				if (state !== undefined) this.#end(state);
				this.#running.delete(p.id);
				if (this.#front === p.id) this.#front = undefined;
				return ok({});
			}
			case "ui.observe":
				return engine.observe(params, signal);
			case "ui.act":
				return engine.act(params, signal);
			default:
				return fail("unsupported", `${method} is not a method this computer answers: it offers apps and ui`);
		}
	}

	#launch(p: Record<string, unknown>): Result<unknown> {
		if (typeof p.id !== "string") return fail("invalid", "apps.launch: id is not a string");
		const app = this.apps.get(p.id);
		if (app === undefined) return fail("not_found", `${p.id} is not installed`);
		if (p.background === true) {
			const off = this.#features["apps.background"];
			if (off !== true) return fail("unsupported", `apps.launch: apps.background is off here${off === undefined ? "" : `: ${off.off}`}`);
		}
		if (!this.#running.has(app.id)) {
			const offset = 40 * this.#running.size;
			this.#running.set(app.id, { app: app.id, windows: [], windowAt: Date.now() + this.#windowAfterMs, origin: [100 + offset, 80 + offset, ...app.size], opened: 0, mains: 0 });
		}
		const state = this.#running.get(app.id) as AppState;
		// A running app with no window opens its main one, on its first screen: at launch, and again once its last one
		// closed, as a Mac app does when launched.
		if (state.windows.length === 0) {
			state.mains += 1;
			this.#openWindow(state, app, state.mains === 1 ? `${app.id}#main` : `${app.id}#main-${state.mains}`, app.start, [...state.origin]);
		}
		if (p.background !== true) this.#front = app.id;
		return ok({});
	}

	/**
	 * apps.launch's answer once the app it started has a window (wire.md, apps.launch): ok when it shows, timeout naming
	 * the app when none came within LAUNCH_WINDOW_MS. A test's driver that answers before its window overrides it.
	 */
	async windowOf(id: string, signal: AbortSignal): Promise<Result<unknown>> {
		const until = Date.now() + LAUNCH_WINDOW_MS;
		for (;;) {
			const state = this.#running.get(id);
			if (state === undefined) return fail("not_found", `${id} ended before it showed a window`);
			if (Date.now() >= state.windowAt) return ok({});
			if (Date.now() >= until) return fail("timeout", `${this.apps.get(id)?.name ?? id} (${id}) showed no window within ${LAUNCH_WINDOW_MS / 1000} s of apps.launch`);
			await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, state.windowAt - Date.now()))));
			if (signal.aborted) return fail("aborted", "apps.launch was cancelled");
		}
	}

	// --- the ui source ---------------------------------------------------------------------------------------------

	features(): Features {
		return this.#features;
	}

	async look(target: UiTarget | undefined): Promise<Result<UiView>> {
		const touch = this.kind === "android" || this.kind === "ios";
		// A window named alone is found in whichever running app has it, as a desktop's window list names it; a phone sees
		// only the app in front.
		const owner = target?.app === undefined && target?.window !== undefined && !touch ? [...this.#running].find(([, state]) => state.windows.some((one) => one.id === target.window))?.[0] : undefined;
		const id = target?.app ?? owner ?? this.#front;
		// A phone reads only the app in front, as its accessibility tree does: an app behind is not found.
		const front = this.#front ?? "home";
		if (touch && target?.app !== undefined && target.app !== front) return fail("not_found", `${target.app} is not in front on this phone (${front} is): launch it with apps.launch first`);
		if (id === undefined || (id === "home" && this.#front === undefined)) {
			if (target?.window !== undefined && target.window !== "home#main") return fail("not_found", `the home screen has no window ${target.window}; its window is home#main`);
			// With no app in front a computer shows its home screen or desktop (after nav home, or terminating the app in
			// front): a window to observe and settle on, as on a real one.
			const [width, height] = [this.hello().screen?.width ?? 0, this.hello().screen?.height ?? 0];
			return ok({ app: { id: "home", name: touch ? "Home screen" : "Desktop" }, window: { id: "home#main", bounds: [0, 0, width, height] }, elements: [], frame: "home" });
		}
		const state = this.#running.get(id);
		const app = this.apps.get(id);
		if (state === undefined || app === undefined) return fail("not_found", `${id} is not running: launch it with apps.launch`);
		if (Date.now() < state.windowAt) return fail("not_found", `${id} is running and has no window yet`);
		if (state.windows.length === 0) return fail("not_found", `${id} is running with no window: its last one closed, and apps.launch opens it again`);
		const shown = target?.window === undefined ? state.windows.at(-1) : state.windows.find((one) => one.id === target.window);
		if (shown === undefined) return fail("not_found", `${id} has no window ${target?.window}; its windows are ${state.windows.map((one) => one.id).join(", ")}`);
		const screen = app.screens[shown.screen];
		// Between two screens the window slides: each look shows its elements a point or two lower than the last, as a real
		// transition moves them, so a settle on the tree waits it out.
		const between = Date.now() < shown.animateUntil;
		const slide = between ? 1 + (this.#frames % 2) : 0;
		// Values, checked and focused are the window's alone (checked and focused seeded from the script when it opened):
		// the scripted flags never show through, and another window's never do.
		const elements = screen.elements.map(({ press: _press, enter: _enter, route: _route, counts: _counts, takesBack: _takesBack, flags: scriptedFlags, ...element }) => {
			const value = shown.values.get(element.key) ?? element.value;
			const flags = [...(scriptedFlags ?? []).filter((flag) => flag !== "checked" && flag !== "focused"), ...(shown.checked.has(element.key) ? (["checked"] as const) : []), ...(shown.focus === element.key ? (["focused"] as const) : [])];
			const [x, y, w, h] = element.bounds;
			return { ...element, bounds: [x, y + slide, w, h] as typeof element.bounds, ...(value === undefined ? {} : { value }), ...(flags.length > 0 ? { flags } : {}) };
		});
		return ok({
			app: { id, name: app.name },
			window: { id: shown.id, ...(screen.title === undefined ? {} : { title: screen.title }), bounds: shown.bounds },
			elements,
			// A blinking caret changes what the window draws on every look, and nothing in its tree.
			frame: between ? `between:${this.#frames++}` : this.#blink && shown.focus !== undefined ? `${shown.screen}|caret:${this.#frames++ % 2}` : shown.screen,
		});
	}

	async image(view: UiView, maxEdge: number): Promise<Result<UiImage>> {
		const [, , w, h] = view.window.bounds;
		const fit = Math.min(1, maxEdge / Math.max(w, h));
		const [width, height] = [Math.max(1, Math.round(w * fit)), Math.max(1, Math.round(h * fit))];
		return ok({ format: "png", width, height, data: solidPng(width, height, colourOf(view.frame ?? "")).toString("base64") });
	}

	async run(step: UiStep, { element, view, foreground }: UiStepContext): Promise<Result<UiRun>> {
		const running = this.#running.get(view.app.id);
		if (running === undefined) {
			// The home screen or desktop: nav runs (there is nowhere further to go), anything else has nothing to land on.
			if ("nav" in step) return ok({ route: "semantic", verified: true });
			return fail("unsupported", `the fake's ${view.app.name.toLowerCase()} takes no input but nav: launch an app with apps.launch`);
		}
		const state = running;
		const app = this.apps.get(view.app.id) as FakeApp;
		// The window the step lands in, which it changes alone: a press there goes, opens or closes from it.
		const win = state.windows.find((one) => one.id === view.window.id);
		if (win === undefined) return fail("stale", `${view.window.id} closed before this step ran: observe again`);
		const shown = app.screens[win.screen];
		const scripted = (key: string | undefined) => shown.elements.find((one) => one.key === key);
		/** A disabled element takes no effect by any route: by its ref it is refused, by a point or the focus it is ignored. */
		const disabled = (one: FakeElement) => one.flags?.includes("disabled") ?? false;
		/** The route an input step (a pointer, typing, a key) takes, or why it may not run, in the off features' words. */
		const pointer = (target: FakeElement | undefined): Result<UiRun["route"]> => {
			const only = target?.route === "foreground";
			const backgroundOff = featureOff(this.#features, "ui.background");
			if (only && this.#blind && !foreground && backgroundOff === undefined) return ok("background");
			if (!only && backgroundOff === undefined) return ok("background");
			const why = only ? `${target?.name ?? "it"} takes foreground input only` : backgroundOff;
			const foregroundOff = featureOff(this.#features, "ui.foreground");
			if (foregroundOff !== undefined) return fail("unsupported", `no route reaches it: ${why}, and ${foregroundOff}`);
			if (!foreground) return fail("denied", `${why}, so only the foreground route reaches it, which moves the user's pointer, and this call does not allow it: pass foreground: true`);
			return ok("foreground");
		};
		/** A pointer step by its route: an element it reaches is pressed, and a counting one verified by its count. */
		/**
		 * Whether input by this route has an effect on the element: a disabled control takes it and does nothing, and a
		 * view that takes real input only never sees input posted by another route (blindBackground lets one through).
		 * Every input step (a point, typing, a key) applies its effect only through this.
		 */
		const takes = (one: FakeElement, route: UiRun["route"]) => !disabled(one) && !(one.route === "foreground" && route !== "foreground");
		const land = (hit: FakeElement | undefined, route: UiRun["route"], right = false): UiRun => {
			if (hit === undefined || right || !takes(hit, route)) return { route, verified: false };
			this.#press(state, win, hit);
			if (hit.counts !== true) return { route, verified: false };
			win.values.set(hit.key, String(Number(win.values.get(hit.key) ?? hit.value ?? "0") + 1));
			return { route, verified: true };
		};
		const target = scripted(element?.key);
		if (target !== undefined && disabled(target)) return fail("refused", `${target.name ?? "the element"} is disabled: a step on it does nothing, so none ran`);
		if ("press" in step || ("perform" in step && step.action === target?.actions?.[0])) {
			if (target?.route === "foreground") {
				const route = pointer(target);
				return route.ok ? ok(land(target, route.value)) : route;
			}
			this.#press(state, win, target as FakeElement);
			return ok({ route: "semantic", verified: this.#shownAtOnce(target as FakeElement) });
		}
		if ("perform" in step) {
			if (!(target?.actions ?? []).includes(step.action)) return fail("unsupported", `${target?.name ?? "the element"} has no action ${step.action}`);
			return ok({ route: "semantic", verified: false });
		}
		if ("set" in step) {
			const scriptedTarget = target as FakeElement;
			const toggle = scriptedTarget.role === "switch" || scriptedTarget.role === "checkbox";
			if (toggle && step.value !== "on" && step.value !== "off") return fail("invalid", `a ${scriptedTarget.role} is set to "on" or "off", not ${JSON.stringify(step.value)}`);
			if (!toggle && scriptedTarget.role !== "textbox" && scriptedTarget.role !== "searchbox") return fail("unsupported", `a ${scriptedTarget.role} has no value to set`);
			// A view that takes real input only is set by real input, as a press is: never by the semantic route.
			const via: Result<UiRun["route"]> = scriptedTarget.route === "foreground" ? pointer(scriptedTarget) : ok("semantic");
			if (!via.ok) return via;
			if (!takes(scriptedTarget, via.value)) return ok({ route: via.value, verified: false });
			if (toggle && step.value === "on") win.checked.add(scriptedTarget.key);
			else if (toggle) win.checked.delete(scriptedTarget.key);
			else {
				const was = win.values.get(scriptedTarget.key);
				win.values.set(scriptedTarget.key, step.value);
				// An app that refuses the value takes it back a moment later: the set ran, and does not hold (SET_HOLD_MS).
				if (scriptedTarget.takesBack !== undefined) {
					this.#later(state, win, scriptedTarget.takesBack, () => {
						if (was === undefined) win.values.delete(scriptedTarget.key);
						else win.values.set(scriptedTarget.key, was);
					});
				}
			}
			return ok({ route: via.value, verified: true });
		}
		if ("click" in step) {
			// A point lands on what the app draws there, whether or not the view carries its elements (ui.tree off).
			const hit = target ?? (Array.isArray(step.click) ? shown.elements.findLast((one) => this.#inside(one.bounds, step.click as [number, number])) : undefined);
			const route = pointer(hit);
			if (!route.ok) return route;
			// A double or triple click lands as many times; a right click once.
			let landed = land(hit, route.value, step.button === "right");
			for (let more = step.button === "right" ? 0 : (step.count ?? 1) - 1; more > 0; more--) landed = land(hit, route.value);
			return ok(landed);
		}
		if ("type" in step) {
			const field = (one: FakeElement) => one.role === "textbox" || one.role === "searchbox";
			if (target !== undefined && !field(target)) return fail("refused", `${step.into} is a ${target.role}, not a text field: type into a field`);
			const into = target ?? scripted(win.focus);
			const route = pointer(into);
			if (!route.ok) return route;
			if (into === undefined || !takes(into, route.value) || !field(into)) return ok({ route: route.value, verified: false });
			// A field named by its ref is focused first, as a tap does, which runs what pressing it does: a field whose
			// press opens another screen leaves the focus there, and nothing is typed.
			if (target !== undefined) {
				this.#press(state, win, target);
				if (win.focus !== target.key) return fail("refused", `${step.into} did not take focus: nothing typed`);
			}
			win.values.set(into.key, `${win.values.get(into.key) ?? into.value ?? ""}${step.type}`);
			return ok({ route: route.value, verified: true });
		}
		if ("key" in step) {
			const focused = scripted(win.focus);
			const route = pointer(focused);
			if (!route.ok) return route;
			if (step.key === "enter" && focused?.enter !== undefined && takes(focused, route.value)) this.#apply(state, win, focused.enter);
			return ok({ route: route.value, verified: false });
		}
		if ("nav" in step) {
			if (step.nav === "back") {
				const back = win.history.pop();
				if (back !== undefined) win.screen = back;
			} else if (step.nav === "home") this.#front = undefined;
			return ok({ route: "semantic", verified: true });
		}
		if ("scroll" in step) return ok({ route: "semantic", verified: false });
		const route = pointer(undefined);
		return route.ok ? ok({ route: route.value, verified: false }) : route;
	}

	#inside([x, y, w, h]: [number, number, number, number], [px, py]: [number, number]): boolean {
		return px >= x && py >= y && px < x + w && py < y + h;
	}

	/** Whether a press's effect is there to read back as soon as it ran: a toggle, a focus, or a screen opened at once. */
	#shownAtOnce(element: FakeElement): boolean {
		if (["switch", "checkbox", "textbox", "searchbox"].includes(element.role)) return true;
		return element.press !== undefined && (element.press.after ?? 0) === 0;
	}

	#press(state: AppState, win: FakeWindow, element: FakeElement): void {
		if (element.role === "switch" || element.role === "checkbox") {
			if (win.checked.has(element.key)) win.checked.delete(element.key);
			else win.checked.add(element.key);
		}
		if (element.role === "textbox" || element.role === "searchbox") win.focus = element.key;
		if (element.press !== undefined) this.#apply(state, win, element.press);
	}

	/**
	 * A press's effect, from the window it landed in: go to a screen in that window, open another window, or close that
	 * one. A delayed effect is that window's pending effect: it never lands once the window closed.
	 */
	#apply(state: AppState, win: FakeWindow, effect: FakeEffect): void {
		const go = () => {
			if (effect.close === true) return this.#closeWindow(state, win);
			if (effect.open !== undefined) {
				state.opened += 1;
				const [x, y, w, h] = state.origin;
				const app = this.apps.get(state.app) as FakeApp;
				this.#openWindow(state, app, `${state.app}#${state.opened + 1}`, effect.open, [x + 30 * state.opened, y + 30 * state.opened, w, h]);
				return;
			}
			if (effect.go === undefined) return;
			win.history.push(win.screen);
			win.screen = effect.go;
			win.focus = undefined;
			win.animateUntil = Date.now() + (effect.animateMs ?? 0);
		};
		if (!effect.after) return go();
		this.#later(state, win, effect.after, go);
	}
}

/**
 * Serves a driver's methods as JSON-RPC lines from input to output (the stdio binding's framing): requests run at once,
 * replies in any order, $/cancelRequest aborts one, a line over the limit or not JSON gets its error reply.
 */
export function serveUiLines(driver: FakeUiDriver, input: Readable, output: Writable): void {
	const engine = driver.engine();
	const running = new Map<number | string, AbortController>();
	let buffered = "";
	/** A line already over the limit: dropped up to its newline, then answered once. */
	let overLong = false;
	const reply = (message: unknown) => {
		if (output.writable) output.write(`${JSON.stringify(message)}\n`);
	};
	const error = (id: unknown, kind: DaemonErrorKind, message: string, code = codeOf(kind)) => reply({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data: { kind } } });
	const line = async (text: string) => {
		if (Buffer.byteLength(text) > MAX_LINE_BYTES) return error(null, "limit", "the request is over the line limit", JSONRPC_CODES.invalidRequest);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return error(null, "invalid", "the line is not JSON", JSONRPC_CODES.parse);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return error(null, "invalid", "a request is a JSON object", JSONRPC_CODES.invalidRequest);
		const message = parsed as { id?: number | string; method?: unknown; params?: unknown };
		if (message.method === CANCEL_METHOD) {
			running.get((message.params as { id?: number | string } | undefined)?.id ?? "")?.abort();
			return;
		}
		if (typeof message.method !== "string" || message.id === undefined) return error(message.id, "invalid", "a request has a method and an id", JSONRPC_CODES.invalidRequest);
		const controller = new AbortController();
		running.set(message.id, controller);
		try {
			const answered = await driver.handle(engine, message.method, message.params, controller.signal);
			if (answered.ok) return reply({ jsonrpc: "2.0", id: message.id, result: answered.value });
			const kind = answered.error.code as DaemonErrorKind;
			const code = FAKE_UI_METHODS.has(message.method) ? codeOf(kind) : JSONRPC_CODES.methodNotFound;
			return error(message.id, kind, answered.error.message, code);
		} finally {
			running.delete(message.id);
		}
	};
	input.setEncoding("utf8");
	input.on("data", (chunk: string) => {
		buffered += chunk;
		for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
			const text = buffered.slice(0, at).replace(/\r$/, "");
			buffered = buffered.slice(at + 1);
			if (overLong) {
				overLong = false;
				error(null, "limit", "the request is over the line limit", JSONRPC_CODES.invalidRequest);
			} else if (text.trim() !== "") void line(text);
		}
		// A character is a byte or more, so a buffer longer than the limit in characters is over it in bytes.
		if (buffered.length > MAX_LINE_BYTES) {
			overLong = true;
			buffered = "";
		}
	});
	input.on("end", () => {
		for (const controller of running.values()) controller.abort();
		output.end();
	});
}

/** Serves a driver over an attach socket (spec/computer/attach.md): the driver's end of the binding, as a driver that dialed out. */
export function serveUiSocket(driver: FakeUiDriver, socket: AttachSocket): void {
	const { readable, writable } = socketStreams(socket);
	serveUiLines(driver, readable, writable);
}

/** A connection over a real line stream to a driver: its client after hello. Closing it leaves the driver's apps running. */
export async function connectUi(driver: FakeUiDriver): Promise<Result<ComputerConnection>> {
	const requests = new PassThrough();
	const replies = new PassThrough();
	serveUiLines(driver, requests, replies);
	const client = new DaemonClient({ readable: replies, writable: requests });
	const hello = await client.call("hello", { client: "fake-ui-driver" });
	if (!hello.ok) return hello;
	return ok({ client, hello: hello.value, close: async () => client.close() });
}

/** A fake ui computer of its own in this process: its connection (after hello), and its driver, ended on close. */
export async function fakeUiConnection(options: FakeUiOptions = {}): Promise<ComputerConnection & { driver: FakeUiDriver }> {
	const driver = new FakeUiDriver(options);
	const connected = await connectUi(driver);
	if (!connected.ok) throw new Error(`the fake ui driver's hello failed: ${connected.error.message}`);
	return {
		...connected.value,
		driver,
		close: async () => {
			await connected.value.close();
			driver.close();
		},
	};
}

/**
 * A provider whose computers are fake ui drivers in this process, for the conformance suite and for tools that need a
 * provider: the options' groups (apps and ui by default), no daemon, deleted on release. Every computer has the options' apps and features; `make`
 * builds each one's driver (a subclass, for a test of what a broken driver fails).
 */
export function fakeUiProvider(options: FakeUiOptions = {}, make: (options: FakeUiOptions) => FakeUiDriver = (given) => new FakeUiDriver(given)): ComputerProvider & { drivers: ReadonlyMap<string, FakeUiDriver> } {
	const drivers = new Map<string, FakeUiDriver>();
	const labelsOf = new Map<string, Record<string, string>>();
	const deadlines = new Map<string, Date>();
	/** Every computer a request made, ended or not: a request id makes one computer, ever. */
	const made = new Set<string>();
	/** The request id checked, and a create of a request in flight shared (create-requests.ts). */
	const requests = new CreateRequests();
	const capabilities: ComputerCapabilities = {
		kind: options.kind ?? "desktop",
		lifetime: "vendor",
		network: ["none", "open"],
		isolation: "machine",
		os: options.os ?? "macos",
		daemon: "none",
		groups: options.groups ?? ["apps", "ui"],
		maxLifetimeMs: 60 * 60_000,
		release: ["delete"],
	};
	const networks = new Map<string, "none" | "open">();
	/** The spec each computer was made with, kept past its end: a retry of its request is held to all of it. */
	const specs = new Map<string, ComputerSpec>();
	const missing = (id: string) => fail("not_found", `no fake ui computer ${id}`);
	const end = (id: string) => {
		drivers.get(id)?.close();
		drivers.delete(id);
		labelsOf.delete(id);
		deadlines.delete(id);
		networks.delete(id);
	};
	/** Whether the computer is there: one past its deadline is ended then (its lifetime is the vendor's), and is not. */
	const live = (id: string) => {
		const deadline = deadlines.get(id);
		if (deadline !== undefined && deadline.getTime() <= Date.now()) end(id);
		return drivers.has(id);
	};
	const allowRefused = "a fake ui computer's network is none or open, never an allowlist";
	return {
		id: "fake-ui",
		version: "fake",
		drivers,
		capabilities: () => capabilities,
		check: (spec) => [
			...kindRefusals(capabilities),
			...checkLifetime(spec.lifetimeMs, capabilities),
			...(spec.network === "none" || spec.network === "open" ? [] : [{ field: "network", message: typeof spec.network === "object" ? allowRefused : `network is "none" or "open", not ${JSON.stringify(spec.network)}` }]),
		],
		async create(spec, context) {
			const refusals = this.check(spec);
			// One computer per request id, named for it (provider.md, Idempotent create): what the fake's vendor holds is
			// every computer a request made, ended or not.
			return requests.create(spec, context, {
				refuse: fail,
				...(refusals.length > 0 ? { refused: refusals.map((refusal) => refusal.message).join("; ") } : {}),
				make: async (id) => {
					if (made.has(id)) {
						if (!live(id)) return fail("exists", endedWords(id));
						// The fake's vendor holds the whole spec a computer was made with: a retry is held to all of it.
						const differ = specDiffer(spec, specs.get(id) as ComputerSpec, { seen: "read back" });
						if (differ.length > 0) return fail("exists", otherSpecWords(id, "was made", differ));
						return ok({ id, name: id });
					}
					made.add(id);
					specs.set(id, spec);
					drivers.set(id, make(options));
					labelsOf.set(id, { ...spec.labels });
					deadlines.set(id, new Date(Date.now() + (spec.lifetimeMs ?? capabilities.maxLifetimeMs)));
					networks.set(id, spec.network as "none" | "open");
					return ok({ id, name: id });
				},
			});
		},
		async attach(ref) {
			const id = "id" in ref ? ref.id : [...labelsOf].find(([found, labels]) => live(found) && Object.entries(ref.labels).every(([key, value]) => labels[key] === value))?.[0];
			if (id === undefined || !live(id)) return missing("id" in ref ? ref.id : JSON.stringify(ref.labels));
			return ok({ id, name: id, spec: { image: "fake-ui", user: "501", network: networks.get(id) ?? "none", kind: capabilities.kind, deadline: deadlines.get(id) } });
		},
		async list(labels) {
			const matching = [...labelsOf].filter(([id, have]) => live(id) && Object.entries(labels).every(([key, value]) => have[key] === value));
			return ok(matching.map(([id, have]) => ({ ref: { id, name: id }, labels: have, deadline: deadlines.get(id), state: "running" as const, network: networks.get(id) ?? "none" })));
		},
		async network(ref, policy) {
			if (!live(ref.id)) return missing(ref.id);
			const now = networks.get(ref.id) ?? "none";
			if (policy !== undefined && policy !== "none" && policy !== "open") return fail("refused", allowRefused);
			// A remote computer's network is fixed at create: asking for the one it has is ok, a change is refused.
			if (policy !== undefined && policy !== now) return fail("refused", `${ref.id}'s network is ${now}, fixed when it was made: create a computer with network ${policy}`);
			return ok(now);
		},
		async connect(ref) {
			if (!live(ref.id)) return missing(ref.id);
			return connectUi(drivers.get(ref.id) as FakeUiDriver);
		},
		async release(ref, how) {
			if (how === "stop") return fail("unsupported", "a fake ui computer is deleted on release, never stopped");
			end(ref.id);
			return ok(undefined);
		},
	};
}

// node dist/fake-ui-driver.js [apps.json]: the driver on stdin and stdout, its apps from a JSON file of FakeApp[].
if (isCommand(import.meta)) {
	const file = process.argv[2];
	const apps = file === undefined ? undefined : (JSON.parse(readFileSync(file, "utf8")) as FakeApp[]);
	const driver = new FakeUiDriver(apps === undefined ? {} : { apps });
	serveUiLines(driver, process.stdin, process.stdout);
	process.stdin.on("end", () => driver.close());
}
