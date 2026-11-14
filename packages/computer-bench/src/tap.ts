// A tap over a computer's wire: every call through it becomes a step of the run record. The agent's tap also holds the
// task's step budget and the agent's grant (the groups it may use), and, after each act, takes a frame on the bench's
// own channel so every act has an image before and after it (pre is the frame the last act left). Images a call returns
// are kept once each as blobs. The agent's tap is its surface too: "tools" makes each call a tool call of its own, "code"
// makes calls only inside a script, one tool call however many it makes.
import { clip, type Phase, type Step, type Store, withoutBytes } from "./record.js";
import { fromBase64, groupOf, type JsonObject, offers, type Wire, type WireResult } from "./wire.js";

/** The methods that act on the screen: after each, a frame is taken (when frames are on). */
const ACTS = new Set(["ui.act", "input.actions", "apps.launch", "apps.terminate"]);
/** Calls the budget never counts. */
const FREE = new Set(["hello", "ping"]);

export interface TapOptions {
	phase: Phase;
	store: Store;
	/** When the run started, for each step's t_ms. */
	t0: number;
	/** Each step, as it ends. */
	onStep: (step: Step) => void;
	/** The next step number (shared by every tap of a run, so numbers are in one order). */
	next: () => number;
	/** The agent's tap: the calls it may make (counted from 1); past it, calls are refused `limit` and onSpent fires. */
	steps?: number;
	onSpent?: () => void;
	/** The agent's tap: the groups it may use. A method of another group is refused `denied`, in words. */
	grant?: readonly string[];
	/** Frames after acts: the bench's channel to take them on (its own tap, phase "frame"). */
	frames?: Frames;
	/** The agent's tap: the surface it is given. "tools": each call is its own tool call. "code": a call is made only
	 *  inside script(fn), one tool call however many calls it makes; a bare call is refused, as a code-mode agent has no
	 *  per-step tool. Absent (the bench's own taps): no tool calls are counted. */
	surface?: "code" | "tools";
	/** The agent's tap: a new tool call began; answers its number (shared by the run, from 1). */
	onTurn?: () => number;
}

/** The agent's wire: its calls, and on the code surface the script that makes them. */
export type AgentWire = Wire & {
	readonly used: number;
	/** "code" only: runs `fn` as one tool call; every call it makes through `computer` is a step of that call. */
	script?: <T>(fn: (computer: Wire) => Promise<T>) => Promise<T>;
};

/** Where a run's frames come from: the whole screen (group screen), or the front window's image (group ui with the
 *  feature ui.image on), for a computer with no screen group. */
export type FrameSource = "screen" | "ui";

/** The frame source a hello allows, best first; undefined when it has neither. */
export function frameSourceOf(hello: { groups: readonly string[]; features?: Record<string, unknown> }): FrameSource | undefined {
	if (hello.groups.includes("screen")) return "screen";
	if (hello.groups.includes("ui") && hello.features?.["ui.image"] === true) return "ui";
	return undefined;
}

/** The frames of one run: the last one taken, and a way to take the next. */
export class Frames {
	last: string | undefined;
	constructor(
		private readonly wire: Wire,
		private readonly store: Store,
		private readonly source: FrameSource = "screen",
	) {}

	/** Takes a whole screenshot (screen.shot, then screen.read to its end), or the front window's image, and keeps it;
	 *  undefined when it can't. */
	async take(signal?: AbortSignal): Promise<string | undefined> {
		const shot = this.source === "screen" ? await readShot(this.wire, signal) : await readWindow(this.wire, signal);
		if (shot === undefined) return undefined;
		this.last = this.store.blob(shot);
		return this.last;
	}
}

/** The front window's image from ui.observe, whole. */
async function readWindow(wire: Wire, signal?: AbortSignal): Promise<Buffer | undefined> {
	const observed = await wire.call("ui.observe", { image: true }, { signal });
	if (!observed.ok) return undefined;
	const image = (observed.value as { image?: { data?: unknown } }).image;
	return typeof image?.data === "string" ? Buffer.from(image.data, "base64") : undefined;
}

/** A whole PNG from screen.shot and screen.read. */
export async function readShot(wire: Wire, signal?: AbortSignal): Promise<Buffer | undefined> {
	const first = await wire.call("screen.shot", {}, { signal });
	if (!first.ok) return undefined;
	const shot = first.value as { id: string; data: string; eof: boolean; size: number };
	const parts = [Buffer.from(shot.data, "base64")];
	let got = parts[0]?.length ?? 0;
	let eof = shot.eof;
	while (!eof) {
		const more = await wire.call("screen.read", { id: shot.id, offset: got }, { signal });
		if (!more.ok) return undefined;
		const chunk = Buffer.from((more.value as { data: string }).data, "base64");
		if (chunk.length === 0 && !(more.value as { eof: boolean }).eof) return undefined;
		parts.push(chunk);
		got += chunk.length;
		eof = (more.value as { eof: boolean }).eof;
	}
	return Buffer.concat(parts);
}

/** What a result says about routes, state and change, read from ui.act's and ui.observe's answers. */
function readAnswer(method: string, params: JsonObject, value: unknown, step: Step): void {
	const v = (value ?? {}) as Record<string, unknown>;
	if (method === "ui.act") {
		const steps = Array.isArray(v.steps) ? (v.steps as Record<string, unknown>[]) : [];
		// One result per step tried; a refused step is the last, and the steps after it are not listed.
		step.routes = steps.map((one) => (typeof one.route === "string" ? one.route : "error"));
		step.verified = steps.filter((one) => one.verified === true).length;
		step.ran = steps.filter((one) => typeof one.route === "string").length;
		if (typeof v.changed === "boolean") step.changed = v.changed;
		if (v.expect === "met" || v.expect === "unmet") step.expect = v.expect;
		const stale = steps.filter((one) => (one.error as { kind?: string } | undefined)?.kind === "stale").length;
		if (stale > 0) step.stale = stale;
		step.state = { before: typeof params.state === "string" ? params.state : undefined, after: typeof v.state === "string" ? v.state : undefined };
	} else if (method === "ui.observe") {
		step.state = { before: typeof params.since === "string" ? params.since : undefined, after: typeof v.state === "string" ? v.state : undefined };
		const nodes = Array.isArray(v.nodes) ? v.nodes.length : 0;
		step.note = `${nodes} nodes${v.truncated ? " (truncated)" : ""}`;
	} else if (method === "exec.run") {
		step.note = clip(`exit ${String(v.exitCode)}${fromBase64(v.stdout) ? `: ${fromBase64(v.stdout).trim()}` : ""}${fromBase64(v.stderr) ? ` [stderr: ${fromBase64(v.stderr).trim()}]` : ""}`, 400);
	} else if (method === "input.actions") {
		const done = typeof v.done === "number" ? v.done : undefined;
		step.ran = done;
		const failed = v.failed as { kind?: string } | undefined;
		if (failed?.kind === "stale") step.stale = 1;
	}
	if (typeof v.elapsedMs === "number") step.daemon_ms = v.elapsedMs;
}

/** Wraps `inner`: every call is recorded; the agent's is budgeted, granted and framed, and its tool calls counted. */
export function tap(inner: Wire, options: TapOptions): AgentWire {
	let used = 0;
	// screen.shot answers in chunks: a shot's chunks are gathered by id until eof, then kept as one blob.
	const shots = new Map<string, Buffer[]>();
	const turnOf = () => options.onTurn?.();
	const wire: AgentWire = {
		get used() {
			return used;
		},
		async call(method: string, params: JsonObject, callOptions: { signal?: AbortSignal } = {}): Promise<WireResult> {
			if (options.surface === "code") return { ok: false, error: { code: "denied", message: `${method}: in code mode the agent's computer calls go through a script (script(fn)), one tool call however many calls it makes; there is no per-step tool` } };
			return send(method, params, callOptions, FREE.has(method) ? undefined : turnOf());
		},
		...(options.surface === "code"
			? {
					async script<T>(fn: (computer: Wire) => Promise<T>): Promise<T> {
						const turn = turnOf();
						return fn({ call: (method, params, callOptions) => send(method, params, callOptions, turn) });
					},
				}
			: {}),
	};
	return wire;

	async function send(method: string, params: JsonObject, callOptions: { signal?: AbortSignal } = {}, turn?: number): Promise<WireResult> {
		const n = options.next();
		const sent = Date.now();
		const step: Step = { n, phase: options.phase, method, params: withoutBytes(params), t_ms: sent - options.t0, ms: 0, ok: false, ...(turn === undefined ? {} : { turn }) };
		const finish = (result: WireResult): WireResult => {
			step.ms = Date.now() - sent;
			step.ok = result.ok;
			if (!result.ok) {
				step.error = { code: result.error.code, message: clip(result.error.message, 300) };
				if (result.error.code === "stale") step.stale = (step.stale ?? 0) + 1;
			}
			options.onStep(step);
			return result;
		};
		if (!FREE.has(method)) {
			if (options.grant && !offers(options.grant, method)) {
				return finish({ ok: false, error: { code: "denied", message: `${method} is not given to the agent here (its group ${groupOf(method)} is the bench's)` } });
			}
			if (options.steps !== undefined) {
				used += 1;
				if (used > options.steps) {
					options.onSpent?.();
					return finish({ ok: false, error: { code: "limit", message: `the task's budget of ${options.steps} computer calls is spent` } });
				}
			}
		}
		const pre = options.frames?.last;
		const result = await inner.call(method, params, callOptions);
		if (result.ok) {
			readAnswer(method, params, result.value, step);
			const v = result.value as Record<string, unknown>;
			if (method === "screen.shot" && typeof v.data === "string") {
				const chunk = Buffer.from(v.data, "base64");
				if (v.eof) step.image = { got: options.store.blob(chunk) };
				else shots.set(String(v.id), [chunk]);
			} else if (method === "screen.read" && typeof v.data === "string") {
				const parts = shots.get(String(params.id));
				if (parts) {
					parts.push(Buffer.from(v.data, "base64"));
					if (v.eof) {
						shots.delete(String(params.id));
						step.image = { got: options.store.blob(Buffer.concat(parts)) };
					}
				}
			} else if (method === "ui.observe" && v.image && typeof v.image === "object") {
				const image = v.image as Record<string, unknown>;
				// A window's image comes whole (PNG or JPEG), never in chunks.
				if (typeof image.data === "string") step.image = { got: options.store.blob(Buffer.from(image.data, "base64")) };
			}
		}
		if (options.frames && ACTS.has(method)) {
			const post = await options.frames.take(callOptions.signal);
			step.image = { ...step.image, pre, post };
			if (step.changed === undefined && pre !== undefined && post !== undefined) step.changed = pre !== post;
		}
		return finish(result);
	}
}
