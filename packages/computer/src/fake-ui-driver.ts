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
	type HelloResult,
	JSONRPC_CODES,
	MAX_LINE_BYTES,
	PROTOCOL_VERSION,
	type UiFlag,
	type UiImage,
	type UiStep,
	type UiTarget,
} from "./protocol.js";
import { type ComputerCapabilities, type ComputerConnection, type ComputerProvider, checkLifetime, kindRefusals } from "./provider.js";
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
}

/** What one app is doing: its screen, the screens behind it, its fields' values, its switches, its focus, its window. */
interface AppState {
	screen: string;
	history: string[];
	values: Map<string, string>;
	checked: Set<string>;
	focus?: string;
	/** Until when its window is between two screens: each look then shows a different frame. */
	animateUntil: number;
	/** Where its window is, in screen points. */
	bounds: [number, number, number, number];
	timers: Set<NodeJS.Timeout>;
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
	/** Every method called, in order, with its params: what a test asserts reached the computer. */
	readonly calls: Array<[string, unknown]> = [];
	readonly #features: Features;
	readonly #quietMs: number;
	readonly #blind: boolean;
	readonly #running = new Map<string, AppState>();
	#front: string | undefined;
	#frames = 0;

	constructor(options: FakeUiOptions = {}) {
		const apps = options.apps ?? [UI_FIXTURE];
		this.apps = new Map(apps.map((app) => [app.id, app]));
		this.os = options.os ?? "macos";
		this.kind = options.kind ?? "desktop";
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
	}

	/** A connection's own ui engine: its refs and states are that connection's alone (wire.md, The ui group). */
	engine(): UiEngine {
		return new UiEngine(this, { quietMs: this.#quietMs, pollMs: 20 });
	}

	hello(): HelloResult {
		return { protocol: PROTOCOL_VERSION, version: "fake", os: this.os, kind: this.kind, arch: "arm64", groups: ["apps", "ui"], screen: SCREEN, osVersion: this.os === "android" ? "15 (API 35)" : "26.1 (25B78)", features: this.#features, device: { maker: "AgentRun", model: "Fake ui driver" } };
	}

	/** The screen an app shows now, by its name; undefined when it is not running. */
	screenOf(app: string): string | undefined {
		return this.#running.get(app)?.screen;
	}

	/** Moves an app's window, or changes its size (points): a point read before a size change is then stale. */
	place(app: string, bounds: [number, number, number, number]): void {
		const state = this.#running.get(app);
		if (state !== undefined) state.bounds = bounds;
	}

	/** Ends every app and its timers. */
	close(): void {
		for (const state of this.#running.values()) for (const timer of state.timers) clearTimeout(timer);
		this.#running.clear();
		this.#front = undefined;
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
			case "apps.launch":
				return this.#launch(p);
			case "apps.terminate": {
				if (typeof p.id !== "string") return fail("invalid", "apps.terminate: id is not a string");
				const state = this.#running.get(p.id);
				for (const timer of state?.timers ?? []) clearTimeout(timer);
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
			// look() shows checked and focused from this state alone, never the script's flags: the state starts from them.
			const scriptedWith = (flag: UiFlag) => Object.values(app.screens).flatMap((screen) => screen.elements.filter((element) => element.flags?.includes(flag)).map((element) => element.key));
			const focus = app.screens[app.start]?.elements.find((element) => element.flags?.includes("focused"))?.key;
			this.#running.set(app.id, {
				screen: app.start,
				history: [],
				values: new Map(),
				checked: new Set(scriptedWith("checked")),
				...(focus === undefined ? {} : { focus }),
				animateUntil: 0,
				bounds: [100 + offset, 80 + offset, ...app.size],
				timers: new Set(),
			});
		}
		if (p.background !== true) this.#front = app.id;
		return ok({});
	}

	// --- the ui source ---------------------------------------------------------------------------------------------

	features(): Features {
		return this.#features;
	}

	async look(target: UiTarget | undefined): Promise<Result<UiView>> {
		const id = target?.app ?? this.#front;
		const touch = this.kind === "android" || this.kind === "ios";
		// A phone reads only the app in front, as its accessibility dump does (phone-ui.ts): an app behind is not found.
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
		const windowId = `${id}#main`;
		if (target?.window !== undefined && target.window !== windowId) return fail("not_found", `${id} has no window ${target.window}; its window is ${windowId}`);
		const screen = app.screens[state.screen];
		// Checked and focused are the state's alone (seeded from the script at launch): the scripted flags never show through.
		const elements = screen.elements.map(({ press: _press, enter: _enter, route: _route, counts: _counts, flags: scriptedFlags, ...element }) => {
			const value = state.values.get(element.key) ?? element.value;
			const flags = [...(scriptedFlags ?? []).filter((flag) => flag !== "checked" && flag !== "focused"), ...(state.checked.has(element.key) ? (["checked"] as const) : []), ...(state.focus === element.key ? (["focused"] as const) : [])];
			return { ...element, ...(value === undefined ? {} : { value }), ...(flags.length > 0 ? { flags } : {}) };
		});
		const between = Date.now() < state.animateUntil;
		return ok({
			app: { id, name: app.name },
			window: { id: windowId, ...(screen.title === undefined ? {} : { title: screen.title }), bounds: state.bounds },
			elements,
			frame: between ? `between:${this.#frames++}` : state.screen,
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
		const scripted = (key: string | undefined) => app.screens[state.screen].elements.find((one) => one.key === key);
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
			this.#press(state, hit);
			if (hit.counts !== true) return { route, verified: false };
			state.values.set(hit.key, String(Number(state.values.get(hit.key) ?? hit.value ?? "0") + 1));
			return { route, verified: true };
		};
		const target = scripted(element?.key);
		if (target !== undefined && disabled(target)) return fail("invalid", `${target.name ?? "the element"} is disabled`);
		if ("press" in step || ("perform" in step && step.action === target?.actions?.[0])) {
			if (target?.route === "foreground") {
				const route = pointer(target);
				return route.ok ? ok(land(target, route.value)) : route;
			}
			this.#press(state, target as FakeElement);
			return ok({ route: "semantic", verified: this.#shownAtOnce(target as FakeElement) });
		}
		if ("perform" in step) {
			if (!(target?.actions ?? []).includes(step.action)) return fail("unsupported", `${target?.name ?? "the element"} has no action ${step.action}`);
			return ok({ route: "semantic", verified: false });
		}
		if ("set" in step) {
			const scriptedTarget = target as FakeElement;
			if (scriptedTarget.role === "switch" || scriptedTarget.role === "checkbox") {
				if (step.value !== "on" && step.value !== "off") return fail("invalid", `a ${scriptedTarget.role} is set to "on" or "off", not ${JSON.stringify(step.value)}`);
				if (step.value === "on") state.checked.add(scriptedTarget.key);
				else state.checked.delete(scriptedTarget.key);
				return ok({ route: "semantic", verified: true });
			}
			if (scriptedTarget.role !== "textbox" && scriptedTarget.role !== "searchbox") return fail("unsupported", `a ${scriptedTarget.role} has no value to set`);
			state.values.set(scriptedTarget.key, step.value);
			return ok({ route: "semantic", verified: true });
		}
		if ("click" in step) {
			// A point lands on what the app draws there, whether or not the view carries its elements (ui.tree off).
			const hit = target ?? (Array.isArray(step.click) ? app.screens[state.screen].elements.findLast((one) => this.#inside(one.bounds, step.click as [number, number])) : undefined);
			const route = pointer(hit);
			if (!route.ok) return route;
			// A double or triple click lands as many times; a right click once.
			let landed = land(hit, route.value, step.button === "right");
			for (let more = step.button === "right" ? 0 : (step.count ?? 1) - 1; more > 0; more--) landed = land(hit, route.value);
			return ok(landed);
		}
		if ("type" in step) {
			const into = target ?? scripted(state.focus);
			const route = pointer(into);
			if (!route.ok) return route;
			if (into === undefined || !takes(into, route.value) || (into.role !== "textbox" && into.role !== "searchbox")) return ok({ route: route.value, verified: false });
			state.focus = into.key;
			state.values.set(into.key, `${state.values.get(into.key) ?? into.value ?? ""}${step.type}`);
			return ok({ route: route.value, verified: true });
		}
		if ("key" in step) {
			const focused = scripted(state.focus);
			const route = pointer(focused);
			if (!route.ok) return route;
			if (step.key === "enter" && focused?.enter !== undefined && takes(focused, route.value)) this.#apply(state, focused.enter);
			return ok({ route: route.value, verified: false });
		}
		if ("nav" in step) {
			if (step.nav === "back") {
				const back = state.history.pop();
				if (back !== undefined) state.screen = back;
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

	#press(state: AppState, element: FakeElement): void {
		if (element.role === "switch" || element.role === "checkbox") {
			if (state.checked.has(element.key)) state.checked.delete(element.key);
			else state.checked.add(element.key);
		}
		if (element.role === "textbox" || element.role === "searchbox") state.focus = element.key;
		if (element.press !== undefined) this.#apply(state, element.press);
	}

	#apply(state: AppState, effect: FakeEffect): void {
		const go = () => {
			state.history.push(state.screen);
			state.screen = effect.go;
			state.focus = undefined;
			state.animateUntil = Date.now() + (effect.animateMs ?? 0);
		};
		if (!effect.after) return go();
		const timer = setTimeout(() => {
			state.timers.delete(timer);
			go();
		}, effect.after);
		state.timers.add(timer);
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
 * provider: groups apps and ui, no daemon, deleted on release. Every computer has the options' apps and features; `make`
 * builds each one's driver (a subclass, for a test of what a broken driver fails).
 */
export function fakeUiProvider(options: FakeUiOptions = {}, make: (options: FakeUiOptions) => FakeUiDriver = (given) => new FakeUiDriver(given)): ComputerProvider & { drivers: ReadonlyMap<string, FakeUiDriver> } {
	const drivers = new Map<string, FakeUiDriver>();
	const labelsOf = new Map<string, Record<string, string>>();
	const deadlines = new Map<string, Date>();
	let next = 1;
	const capabilities: ComputerCapabilities = {
		kind: options.kind ?? "desktop",
		lifetime: "vendor",
		network: ["none", "open"],
		isolation: "machine",
		os: options.os ?? "macos",
		daemon: "none",
		groups: ["apps", "ui"],
		maxLifetimeMs: 60 * 60_000,
		release: ["delete"],
	};
	const networks = new Map<string, "none" | "open">();
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
		async create(spec) {
			const refusals = this.check(spec);
			if (refusals.length > 0) return fail("refused", refusals.map((refusal) => refusal.message).join("; "));
			const id = `fake-ui-${next++}`;
			drivers.set(id, make(options));
			labelsOf.set(id, { ...spec.labels });
			deadlines.set(id, new Date(Date.now() + (spec.lifetimeMs ?? capabilities.maxLifetimeMs)));
			networks.set(id, spec.network as "none" | "open");
			return ok({ id, name: id });
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
			if (policy !== undefined && policy !== "none" && policy !== "open") return fail("refused", allowRefused);
			if (policy !== undefined) networks.set(ref.id, policy);
			return ok(networks.get(ref.id) ?? "none");
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
