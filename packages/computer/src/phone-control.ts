// A cloud iPhone's device channel: the phone harness's HTTPS control API (docs, guides/iphone; its open client's
// setup/api.md, remote.py and transport.py). A ready iPhone session carries control { url, token, expires_at }: GET
// <url>/ops lists the ops the phone takes, and POST <url>/op with { op, kw } runs one, answering { result }. An op the
// phone does not take answers 400 with unsupported: true; a grant that has ended answers 404. No computerd runs on the
// phone: the client here answers the protocol's methods in this process, each with one or more ops, and refuses the rest
// in words. The provider's session and ledger layer (src/phone-harness.ts) makes the phone and hands this the grant.
//
// The token is a bearer of the phone: it goes only in the Authorization header, to the API's own origin (the provider
// checks the URL), and never into a result, an error or a log. The URL's path is the grant itself, so the words name only
// its host. The phone takes one op at a time (the docs: operations on one phone are serialized), and so does the client.
//
// One space: a frame's width and height are the capture's own pixels (never downscaled), and every point the protocol
// sends is in them. frameMap, the one place they meet the phone, turns a frame's pixel into the point input.tap and
// input.drag take, by the capture's bounds (the screen in points, where taps take them): Retina scale and an origin.
// So a viewer and a model see only the frame's space.
//
// Open until the first live run on a real iPhone, each kept to one place here: which ops the phone lists; the capture's
// real scale and origin against the taps (frameMap); whether apps are named by bundle id or by name, and what launch's
// fresh does; the key names input.keys takes; and whether a double tap as two input.tap ops is one.
import { randomBytes } from "node:crypto";
import { checkActions } from "./actions.js";
import { cropPng, MAX_PNG_BYTES, readPng } from "./png.js";
import {
	type ComputerClient,
	type DaemonErrorKind,
	type DaemonMethod,
	type DaemonMethods,
	type Group,
	type HelloResult,
	type InputAction,
	type InputActionsResult,
	MAX_CHUNK_BYTES,
	type Rect,
} from "./protocol.js";
import { type ComputerErrorCode, fail, ok, type Result } from "./result.js";

/** The ops each group needs the phone to list: connect refuses a phone that lacks one, so hello claims none it cannot serve. */
export const CONTROL_OPS: Readonly<Partial<Record<Group, readonly string[]>>> = {
	screen: ["screen.capture"],
	"input.touch": ["input.tap", "input.press", "input.drag"],
	"input.keys": ["input.text", "input.keys"],
	apps: ["apps.launch", "apps.list", "apps.current"],
};

/** How long one op may take by default; the vendor's own client gives an op 60 s, and a launch or a listing 90 s. */
const OP_MS = 60_000;
const APPS_MS = 90_000;
/** The longest app id or name sent to apps.launch. */
const MAX_APP_ID = 256;

/**
 * Our key names in the vendor's (its iPhone key table, from its client's mirror.py): Return, Delete (which is
 * backspace on a Mac keyboard), the arrows. A key with no entry and no single-character name is refused in words.
 */
const IOS_KEYS: Readonly<Record<string, string>> = {
	enter: "return",
	tab: "tab",
	space: "space",
	backspace: "delete",
	escape: "escape",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
};
/** Modifiers, which only lead a combo: super is the Mac's cmd. */
const IOS_MODIFIERS: Readonly<Record<string, string>> = { shift: "shift", ctrl: "ctrl", alt: "alt", super: "cmd" };
/** The single keys the vendor's table names: lowercase letters and digits. */
const IOS_CHAR = /^[a-z0-9]$/;

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

/** A frame's space and the phone's: the frame's size in pixels, its scale, and a pixel as the point a tap takes. */
export interface FrameMap {
	width: number;
	height: number;
	/** Device pixels a point: the capture's pixels over its bounds' size; 1 when the bounds give no size. */
	scale: number;
	toDevice(point: readonly [number, number]): { x: number; y: number };
}

/**
 * The map from a capture of width x height pixels to the points its bounds ({ x, y, w, h }, the screen in the space taps
 * take) name. Bounds with no usable size map the frame's pixels to themselves.
 */
export function frameMap({ width, height }: { width: number; height: number }, bounds: unknown): FrameMap {
	const b = (typeof bounds === "object" && bounds !== null ? bounds : {}) as Record<string, unknown>;
	const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
	const usable = finite(b.x) && finite(b.y) && finite(b.w) && finite(b.h) && b.w > 0 && b.h > 0;
	const [x0, y0, sx, sy] = usable ? [b.x as number, b.y as number, width / (b.w as number), height / (b.h as number)] : [0, 0, 1, 1];
	return { width, height, scale: sx, toDevice: ([x, y]) => ({ x: Math.round(x / sx + x0), y: Math.round(y / sy + y0) }) };
}

/** The last shot a phone client took, read back in chunks by screen.read; a new shot replaces it. */
export class HeldShot {
	#held: { id: string; bytes: Buffer } | undefined;

	/** screen.shot's result for bytes, whose first chunk it carries; the rest is held for screen.read. */
	hold(bytes: Buffer, width: number, height: number, scale: number): DaemonMethods["screen.shot"]["result"] {
		const id = randomBytes(6).toString("hex");
		this.#held = { id, bytes };
		const data = bytes.subarray(0, MAX_CHUNK_BYTES);
		return { id, size: bytes.length, data: data.toString("base64"), eof: data.length === bytes.length, width, height, scale };
	}

	read(id: unknown, offset: unknown): Result<DaemonMethods["screen.read"]["result"]> {
		const held = this.#held;
		if (held === undefined || held.id !== id) return fail("not_found", `no shot ${show(id)} is held: take one with screen.shot`);
		if (!(Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) <= held.bytes.length)) return fail("invalid", `offset ${show(offset)} is not inside the shot's ${held.bytes.length} bytes`);
		const data = held.bytes.subarray(offset as number, (offset as number) + MAX_CHUNK_BYTES);
		const eof = (offset as number) + data.length >= held.bytes.length;
		if (eof) this.#held = undefined;
		return ok({ data: data.toString("base64"), eof });
	}

	clear(): void {
		this.#held = undefined;
	}
}

export interface ControlClientOptions {
	/** The session's control.url: its path is the grant. */
	url: string;
	/** The session's control.token: never logged, never in a result or an error. */
	token: string;
	/** The groups the provider declares for the phone, which hello repeats. */
	groups: readonly Group[];
	/** fetch; default the global one. */
	fetch?: typeof globalThis.fetch;
	/** A wait, for the wait action. */
	sleep?: (ms: number) => Promise<void>;
	/** A signal that fires after ms, which bounds an op; default AbortSignal.timeout. */
	timeout?: (ms: number) => AbortSignal;
}

/** The in-process client of one cloud iPhone over its control API. */
export function controlClient(options: ControlClientOptions): ControlClient {
	return new ControlClient(options);
}

/** An op's failure, as a result and as an action's kind. */
type OpFailure = { ok: false; error: { code: ComputerErrorCode; message: string } };
/** One op of a planned action: its name, its kw and its bound. */
type Op = { op: string; kw: Record<string, unknown>; ms?: number };
/** One action's ops, and a wait before them. */
type Plan = { ops: Op[]; waitMs?: number };

export class ControlClient implements ComputerClient {
	readonly #url: string;
	readonly #token: string;
	readonly #origin: string;
	readonly #path: string;
	readonly #groups: readonly Group[];
	readonly #fetch: typeof globalThis.fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #timeout: (ms: number) => AbortSignal;
	readonly #shot = new HeldShot();
	#ops = new Set<string>();
	#hello: HelloResult | undefined;
	/** The latest capture's map: a point is sent only through it. */
	#map: FrameMap | undefined;
	#closed = false;
	/** The op in flight: the next waits for it, so the phone takes one at a time. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: ControlClientOptions) {
		const url = new URL(options.url);
		this.#url = options.url.replace(/\/+$/, "");
		this.#origin = url.origin;
		this.#path = url.pathname.replace(/\/+$/, "");
		this.#token = options.token;
		this.#groups = [...options.groups];
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#timeout = options.timeout ?? ((ms) => AbortSignal.timeout(ms));
	}

	/** Words without the token or the grant, whatever the vendor echoed: the URL is named by its host alone. */
	#clean(text: string): string {
		let out = text.replaceAll(this.#token, "[the token]");
		if (this.#path !== "" && this.#path !== "/") out = out.replaceAll(this.#path, "/[the grant]");
		return out;
	}

	/** One request to the control API, after the one before it: its JSON, or a failure in words. */
	#request(method: "GET" | "POST", path: string, body: unknown, what: string, ms: number, signal?: AbortSignal): Promise<Result<unknown>> {
		const turn = this.#queue.then(() => this.#send(method, path, body, what, ms, signal));
		this.#queue = turn.catch(() => undefined);
		return turn;
	}

	async #send(method: "GET" | "POST", path: string, body: unknown, what: string, ms: number, signal?: AbortSignal): Promise<Result<unknown>> {
		if (this.#closed) return fail("gone", "the connection to the iPhone is closed");
		if (signal?.aborted) return fail("aborted", `${what} was aborted`);
		const bound = this.#timeout(ms);
		let response: Response;
		try {
			response = await this.#fetch(`${this.#url}${path}`, {
				method,
				headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: signal ? AbortSignal.any([signal, bound]) : bound,
			});
		} catch (error) {
			if (signal?.aborted) return fail("aborted", `${what} was aborted`);
			if (bound.aborted) return fail("timeout", `${what}: the iPhone did not answer within ${ms / 1000} s`);
			return fail("unreachable", `${what}: the iPhone's control API could not be reached: ${this.#clean((error as Error)?.message ?? String(error))}`);
		}
		let text = "";
		try {
			text = await response.text();
		} catch {
			// A body that broke has no words.
		}
		let json: unknown;
		try {
			json = text === "" ? undefined : JSON.parse(text);
		} catch {
			json = undefined;
		}
		if (response.ok) {
			if (typeof json !== "object" || json === null) return fail("phone", `${what}: the iPhone answered ${response.status} with no JSON`);
			return ok(json);
		}
		const answer = (typeof json === "object" && json !== null ? json : {}) as { error?: unknown; unsupported?: unknown };
		const said = this.#clean(typeof answer.error === "string" && answer.error !== "" ? answer.error : text.slice(0, 200) || response.statusText || "no words");
		if (response.status === 404) return fail("gone", `${what}: the iPhone's session has ended, or its control grant expired (404): ${said}`);
		if (response.status === 401 || response.status === 403) return fail("denied", `${what}: the iPhone's control API refused its token (${response.status}): ${said}`);
		if (answer.unsupported === true) return fail("unsupported", `${what}: ${said}`);
		// The vendor's words for an app that is not there (its client, remote.py: "no installed app matches 'Notes'").
		if (/\bno installed app matches\b/.test(said)) return fail("not_found", `${what}: ${said}`);
		return fail("phone", `${what}: ${said} (${response.status})`);
	}

	/** One op: its result. */
	async #op(op: string, kw: Record<string, unknown> = {}, ms = OP_MS, signal?: AbortSignal): Promise<Result<unknown>> {
		const answered = await this.#request("POST", "/op", { op, kw }, op, ms, signal);
		if (!answered.ok) return answered;
		const body = answered.value as { result?: unknown };
		return ok(body.result ?? null);
	}

	/** GET /ops; then the hello, once every op the groups need is listed. */
	async open(version: string): Promise<Result<HelloResult>> {
		const listed = await this.#request("GET", "/ops", undefined, "GET /ops", OP_MS);
		if (!listed.ok) return listed;
		const ops = (listed.value as { ops?: unknown }).ops;
		if (!Array.isArray(ops) || !ops.every((op) => typeof op === "string")) return fail("phone", "GET /ops: the iPhone answered no list of ops");
		this.#ops = new Set(ops as string[]);
		const missing = this.#groups.flatMap((group) => (CONTROL_OPS[group] ?? []).filter((op) => !this.#ops.has(op)).map((op) => `${op} (${group})`));
		if (missing.length > 0) {
			const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
			return fail("unsupported", `the iPhone's control API does not list ${list}, which the groups the provider declares for it need`);
		}
		this.#hello = { version, os: "ios", kind: "ios", arch: "arm64", groups: [...this.#groups] };
		return ok(this.#hello);
	}

	close(): void {
		this.#closed = true;
		this.#shot.clear();
	}

	async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options: { signal?: AbortSignal } = {}): Promise<Result<DaemonMethods[M]["result"]>> {
		if (this.#closed) return fail("gone", "the connection to the iPhone is closed");
		if (options.signal?.aborted) return fail("aborted", `${method} was aborted`);
		return (await this.#answer(method as string, (params ?? {}) as Record<string, unknown>, options.signal)) as Result<DaemonMethods[M]["result"]>;
	}

	async #answer(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
		switch (method) {
			case "hello":
				return this.#hello ? ok(this.#hello) : fail("gone", "the iPhone's connection was never opened");
			case "ping":
				return ok({});
			case "screen.shot":
				return this.#screenShot(params.region, signal);
			case "screen.read":
				return this.#shot.read(params.id, params.offset);
			case "input.actions":
				return this.#actions(params.actions, signal);
			case "apps.list":
				return this.#appsList(signal);
			case "apps.launch":
				return this.#launch(params.id, signal);
			case "apps.terminate":
				return fail("unsupported", "apps.terminate: the iPhone's control API has no op that ends an app, so the provider does not declare apps.terminate");
			case "apps.ui_tree":
				return fail("unsupported", "apps.ui_tree: not declared for an iPhone until a live run shows its control API's tree");
			case "apps.install":
				return fail("unsupported", "apps.install: this iPhone takes no files to install from");
			case "deadline.extend":
				return fail("unsupported", "deadline.extend: a cloud phone's session ends when the phone harness says; it has no extend");
		}
		if (["exec", "files", "process", "tar"].includes(method.split(".")[0] as string)) return fail("unsupported", `${method}: an iPhone has no shell in the computer protocol, so it offers no exec, files or processes`);
		return fail("unsupported", `${method} is not a method this iPhone answers`);
	}

	// --- screen ----------------------------------------------------------------------------------------------------

	/** One screen.capture: its PNG, read, and the frame's map, which every later point goes through. */
	async #capture(signal?: AbortSignal): Promise<Result<{ bytes: Buffer; png: ReturnType<typeof readPng>; map: FrameMap }>> {
		const captured = await this.#op("screen.capture", {}, OP_MS, signal);
		if (!captured.ok) return captured;
		const { png_b64: b64, bounds } = (captured.value ?? {}) as { png_b64?: unknown; bounds?: unknown };
		if (typeof b64 !== "string" || b64.length > (MAX_PNG_BYTES * 4) / 3 + 4) return fail("phone", "screen.capture answered no PNG");
		const bytes = Buffer.from(b64, "base64");
		let png: ReturnType<typeof readPng>;
		try {
			png = readPng(bytes);
		} catch (error) {
			return fail("phone", `screen.capture: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#map = frameMap(png, bounds);
		return ok({ bytes, png, map: this.#map });
	}

	async #screenShot(region: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
		const captured = await this.#capture(signal);
		if (!captured.ok) return captured;
		const { bytes, png, map } = captured.value;
		const { width, height, scale } = map;
		if (region === undefined) return ok(this.#shot.hold(bytes, width, height, scale));
		const r = region as number[];
		if (!(Array.isArray(r) && r.length === 4 && r.every((v) => Number.isSafeInteger(v)) && r[0]! >= 0 && r[1]! >= 0 && r[2]! > 0 && r[3]! > 0 && r[0]! + r[2]! <= width && r[1]! + r[3]! <= height)) {
			return fail("invalid", `region ${show(region)} is not [x, y, w, h] inside the ${width}x${height} screen`);
		}
		return ok(this.#shot.hold(cropPng(png, r as Rect), r[2] as number, r[3] as number, scale));
	}

	// --- input -----------------------------------------------------------------------------------------------------

	/** A key action's op, or why the phone cannot press it. */
	#keyOp(keys: string[]): Op | string {
		const last = keys.at(-1) as string;
		if (keys.length === 1) {
			if (IOS_KEYS[last] !== undefined || IOS_CHAR.test(last)) return { op: "input.keys", kw: { combo: IOS_KEYS[last] ?? last } };
			// One printable character the table does not name is typed, as a keystroke.
			if (last.length === 1) return { op: "input.text", kw: { s: last, keystrokes: true } };
			return `key ${show(last)}: the iPhone's control API names no such key`;
		}
		const modifiers = keys.slice(0, -1);
		if (modifiers.some((key) => IOS_MODIFIERS[key] === undefined) || IOS_MODIFIERS[last] !== undefined) return `key ${show(keys)}: a combo on an iPhone is modifiers and then one key`;
		const key = IOS_KEYS[last] ?? (IOS_CHAR.test(last) ? last : undefined);
		if (key === undefined) return `key ${show(keys)}: the iPhone's control API names no such key as ${show(last)} in a combo`;
		return { op: "input.keys", kw: { combo: [...modifiers.map((one) => IOS_MODIFIERS[one]), key].join("+") } };
	}

	/** A frame's point as the phone's op takes it, through the latest capture's map (#actions has made one first). */
	#point(at: [number, number]): { x: number; y: number } {
		return (this.#map as FrameMap).toDevice(at);
	}

	/** One action's ops, or why the phone cannot do it. */
	#plan(action: InputAction): Plan | string {
		switch (action.type) {
			case "tap":
				return { ops: Array.from({ length: action.count ?? 1 }, () => ({ op: "input.tap", kw: this.#point(action.at) })) };
			case "long_press":
				return { ops: [{ op: "input.press", kw: { ...this.#point(action.at), duration: (action.ms ?? 800) / 1000 }, ms: OP_MS + (action.ms ?? 800) }] };
			case "swipe": {
				if (action.path.length !== 2) return `swipe: the iPhone's control API drags along one straight line, so a path of ${action.path.length} points is not offered`;
				const [from, to] = [this.#point(action.path[0] as [number, number]), this.#point(action.path[1] as [number, number])];
				return { ops: [{ op: "input.drag", kw: { x1: from.x, y1: from.y, x2: to.x, y2: to.y, duration: (action.ms ?? 300) / 1000 }, ms: OP_MS + (action.ms ?? 300) }] };
			}
			case "button": {
				const op = { home: "nav.home", app_switch: "nav.recents", back: "nav.back" }[action.name];
				if (!this.#ops.has(op)) {
					if (action.name === "back") return "button back: an iPhone has no system Back button, and its control API lists no nav.back";
					return `button ${action.name}: the iPhone's control API lists no ${op}`;
				}
				return { ops: [{ op, kw: {} }] };
			}
			case "type":
				return { ops: [{ op: "input.text", kw: { s: action.text }, ms: Math.max(OP_MS, 200 * action.text.length + 30_000) }] };
			case "key": {
				const op = this.#keyOp(action.keys);
				return typeof op === "string" ? op : { ops: Array.from({ length: action.repeat ?? 1 }, () => op) };
			}
			case "wait":
				return { ops: [], waitMs: action.ms };
			case "pinch":
				return "pinch: the iPhone's control API takes one finger";
			case "hold":
				return "hold: the iPhone's control API cannot keep a key down";
			default:
				return `${(action as { type: string }).type} is not an action this iPhone takes`;
		}
	}

	/** A wait of ms, which ends early when signal fires. */
	async #pause(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal === undefined) return this.#sleep(ms);
		if (signal.aborted) return;
		let stop = () => {};
		const stopped = new Promise<void>((resolve) => {
			stop = resolve;
			signal.addEventListener("abort", stop, { once: true });
		});
		try {
			await Promise.race([this.#sleep(ms), stopped]);
		} finally {
			signal.removeEventListener("abort", stop);
		}
	}

	async #actions(actions: unknown, signal?: AbortSignal): Promise<Result<InputActionsResult>> {
		const refused = checkActions(actions, this.#groups);
		if (refused !== undefined) return ok({ done: 0, failed: refused });
		const list = actions as InputAction[];
		const pointsOf = (action: InputAction) => (action.type === "tap" || action.type === "long_press" ? [action.at] : action.type === "swipe" ? action.path : []);
		// A point goes only through a capture's map: with none yet, one capture first, which only looks.
		const first = list.findIndex((action) => pointsOf(action).length > 0);
		if (first !== -1 && this.#map === undefined) {
			const captured = await this.#capture(signal);
			if (!captured.ok) return ok({ done: 0, failed: { index: first, kind: kindOf(captured), message: `action ${first}: the frame's space could not be read: ${captured.error.message}` } });
		}
		const plans: Plan[] = [];
		for (const [index, action] of list.entries()) {
			const map = this.#map;
			for (const at of map === undefined ? [] : pointsOf(action)) {
				if (at[0] < 0 || at[1] < 0 || at[0] >= map!.width || at[1] >= map!.height) {
					return ok({ done: 0, failed: { index, kind: "invalid", message: `action ${index}: ${show(at)} is off the ${map!.width}x${map!.height} screen` } });
				}
			}
			const plan = this.#plan(action);
			if (typeof plan === "string") return ok({ done: 0, failed: { index, kind: "unsupported", message: `action ${index}: ${plan}` } });
			plans.push(plan);
		}
		const cancelled = (index: number) => ok({ done: index, failed: { index, kind: "aborted" as const, message: `action ${index}: the batch was aborted; actions ${index} on did not run` } });
		for (const [index, plan] of plans.entries()) {
			if (signal?.aborted) return cancelled(index);
			if (plan.waitMs !== undefined) {
				await this.#pause(plan.waitMs, signal);
				if (signal?.aborted) return cancelled(index);
			}
			for (const { op, kw, ms } of plan.ops) {
				if (signal?.aborted) return cancelled(index);
				const ran = await this.#op(op, kw, ms, signal);
				if (!ran.ok) return ok({ done: index, failed: { index, kind: kindOf(ran), message: `action ${index}: ${ran.error.message}` } });
			}
		}
		return ok({ done: plans.length });
	}

	// --- apps ------------------------------------------------------------------------------------------------------

	async #appsList(signal?: AbortSignal): Promise<Result<unknown>> {
		const listed = await this.#op("apps.list", { include_system: true }, APPS_MS, signal);
		if (!listed.ok) return listed;
		if (!Array.isArray(listed.value) || !listed.value.every((id) => typeof id === "string")) return fail("phone", "apps.list answered no list of app ids");
		const apps = [...new Set(listed.value as string[])].sort().map((id) => ({ id }));
		const current = await this.#op("apps.current", {}, OP_MS, signal);
		if (!current.ok) return current;
		return ok({ apps, foreground: typeof current.value === "string" && current.value !== "" ? current.value : null });
	}

	async #launch(id: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
		// Whether the phone takes a bundle id or an app's name is open until a live run; either is sent as given. fresh, as
		// Android's launch clears the app's task: the app itself comes to the front, not what a never-wiped phone left open.
		if (typeof id !== "string" || id === "" || id.length > MAX_APP_ID || /[\x00-\x1f\x7f]/.test(id)) return fail("invalid", `id ${show(id).slice(0, 80)} is not an app's id: a line of at most ${MAX_APP_ID} characters`);
		const launched = await this.#op("apps.launch", { name: id, fresh: true }, APPS_MS, signal);
		return launched.ok ? ok({}) : launched;
	}
}

/** An op's failure as an action's kind. */
function kindOf(failed: OpFailure): DaemonErrorKind {
	const code = failed.error.code;
	return code === "timeout" || code === "aborted" || code === "not_found" || code === "unsupported" || code === "denied" ? code : "invalid";
}
