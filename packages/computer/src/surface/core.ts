// The one executor behind every surface: a script's `computer`, the per-step tools (computer_observe, computer_act,
// computer_screenshot) and a claim's MCP endpoint all call `surface.call(op, args)`, so they get the same value and the
// same text. On a computer with the ui group, observe and act are ui.observe and ui.act; on one without it, observe is
// a screenshot and act maps the steps at points onto input.actions (route "input", unverified, no states).
import type { ComputerClient, DaemonMethod, DaemonMethods, FileEntry, FileStat, HelloResult, InputAction, Point, UiImage, UiObserveResult, UiStep } from "../protocol.js";
import { MAX_CHUNK_BYTES } from "../protocol.js";
import type { ActArgs, ActResult, AppInfo, Card, FileInfo, Image, ObserveArgs, RunResult, ScreenshotArgs, State, StepResult } from "./api.js";
import { outlineOf } from "./outline.js";

/** What a surface can be asked, by name: the members of Computer and the tools' calls. */
export type SurfaceOp =
	| "observe"
	| "act"
	| "screenshot"
	| "input.act"
	| "apps.list"
	| "apps.open"
	| "shell.run"
	| "files.read"
	| "files.write"
	| "files.list"
	| "files.stat";

export const SURFACE_OPS: readonly SurfaceOp[] = ["observe", "act", "screenshot", "input.act", "apps.list", "apps.open", "shell.run", "files.read", "files.write", "files.list", "files.stat"];

/** One call's answer: the value a script gets, the text a model reads, and the images that go with it. */
export interface SurfaceAnswer {
	value: unknown;
	text: string;
	images: Image[];
}

/** A call the computer refused or failed: `kind` is the protocol's error kind (stale, unsupported, ...) or the
 *  connection's (gone, timeout). */
export class SurfaceError extends Error {
	readonly kind: string;
	constructor(kind: string, message: string) {
		super(message);
		this.name = "SurfaceError";
		this.kind = kind;
	}
}

export interface Surface {
	readonly card: Card;
	/** The ops this computer answers, from its groups. */
	readonly ops: readonly SurfaceOp[];
	call(op: string, args: unknown, options?: { signal?: AbortSignal }): Promise<SurfaceAnswer>;
}

/** The most bytes files.read gathers into one answer. */
export const MAX_READ_BYTES = 16 * 1024 * 1024;
/** The most characters of a value's JSON an answer's text holds. */
const MAX_TEXT_CHARS = 40_000;
/** The default and longest a shell command runs. */
const DEFAULT_RUN_MS = 60_000;
const MAX_RUN_MS = 600_000;
/** The most pages of files.list one list gathers. */
const MAX_LIST_PAGES = 10;
/** How long raw input waits before the screenshot of an act's observe, so the screen can redraw. */
const INPUT_SETTLE_MS = 500;
/** A scroll of `distance` pixels as wheel clicks: about 120 pixels each, at least one, at most the most a driver takes in one. */
const WHEEL_PX = 120;
const MAX_WHEEL_CLICKS = 50;
const wheelClicks = (distance: number): number => Math.sign(distance) * Math.min(MAX_WHEEL_CLICKS, Math.max(1, Math.round(Math.abs(distance) / WHEEL_PX)));

/** The card of a hello. */
export function cardOf(hello: HelloResult): Card {
	return {
		kind: hello.kind,
		os: hello.os,
		...(hello.osVersion ? { osVersion: hello.osVersion } : {}),
		arch: hello.arch,
		...(hello.screen ? { screen: hello.screen } : {}),
		groups: [...hello.groups],
		features: { ...(hello.features ?? {}) },
	};
}

/** The ops a computer with these groups answers. */
export function opsOf(groups: readonly string[]): SurfaceOp[] {
	const has = (group: string) => groups.includes(group);
	const input = has("input.pointer") || has("input.touch") || has("input.keys");
	const offered: Record<SurfaceOp, boolean> = {
		observe: has("ui") || has("screen"),
		act: has("ui") || input,
		screenshot: has("screen"),
		"input.act": input,
		"apps.list": has("apps"),
		"apps.open": has("apps"),
		"shell.run": has("exec"),
		"files.read": has("files"),
		"files.write": has("files"),
		"files.list": has("files"),
		"files.stat": has("files"),
	};
	return SURFACE_OPS.filter((op) => offered[op]);
}

const imageOf = (image: UiImage): Image => ({ type: "image", mimeType: image.format === "png" ? "image/png" : "image/jpeg", data: image.data, width: image.width, height: image.height });

/** A value's JSON for a model, cut at MAX_TEXT_CHARS. */
function jsonText(value: unknown): string {
	const text = JSON.stringify(value) ?? "null";
	return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}… (${text.length - MAX_TEXT_CHARS} more characters: return less)` : text;
}

/** The name of a step: its first key ("press", "click", ...). */
export const stepName = (step: UiStep): string => Object.keys(step)[0] ?? "step";

/** An act's answer as lines: one per step (named by `names`), then the expect, then whether it changed and the new
 *  state, then the new observation's outline when there is one. */
export function actText(names: readonly string[], result: ActResult): string {
	const lines = result.steps.map((outcome, index) => {
		const name = names[index] ?? "step";
		return "error" in outcome
			? `${index + 1}. ${name}: refused (${outcome.error.kind}): ${outcome.error.message}`
			: `${index + 1}. ${name}: ${outcome.route}${outcome.verified ? ", verified" : ""}`;
	});
	const refused = result.steps.some((outcome) => "error" in outcome);
	const skipped = names.length - result.steps.length;
	if (skipped > 0) lines.push(refused ? `${skipped} later steps did not run` : `${skipped} steps did not run`);
	if (result.expect) lines.push(`expect: ${result.expect}`);
	if (result.changed !== undefined || result.state !== undefined) {
		lines.push([result.changed === undefined ? "" : result.changed ? "changed" : "unchanged", result.state ? `state ${result.state}` : ""].filter(Boolean).join(" · "));
	}
	if (names.length === 0 && !result.expect) lines.push("no steps");
	if (result.after) lines.push("", result.after.outline);
	return lines.join("\n");
}

/** A chord's keys: "ctrl+shift+t" is ctrl, shift, t; a trailing "+" is the plus key ("ctrl++"). */
export const chordKeys = (chord: string): string[] => chord.split(/\+(?=.)/).filter((key) => key !== "");

/** The surface of one computer, over its connection. */
export function createSurface(client: ComputerClient, hello: HelloResult): Surface {
	const card = cardOf(hello);
	const has = (group: string) => card.groups.includes(group);
	const ops = opsOf(card.groups);
	const touchOnly = has("input.touch") && !has("input.pointer");
	/** The last state observed, by app, and the last app: an act at points defaults to its app's last state. */
	const lastState = new Map<string, string>();
	let lastApp: string | undefined;

	async function call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], signal?: AbortSignal): Promise<DaemonMethods[M]["result"]> {
		const result = await client.call(method, params, { signal });
		if (!result.ok) throw new SurfaceError(result.error.code, result.error.message);
		return result.value;
	}

	async function shot(region: ScreenshotArgs["region"], signal?: AbortSignal): Promise<Image> {
		const first = await call("screen.shot", region ? { region } : {}, signal);
		const parts = [Buffer.from(first.data, "base64")];
		let read = parts[0]!.length;
		let eof = first.eof;
		while (!eof) {
			const next = await call("screen.read", { id: first.id, offset: read }, signal);
			const bytes = Buffer.from(next.data, "base64");
			if (bytes.length === 0 && !next.eof) throw new SurfaceError("invalid", "the computer's screenshot stopped short of its end");
			parts.push(bytes);
			read += bytes.length;
			eof = next.eof;
		}
		const data = parts.length === 1 ? first.data : Buffer.concat(parts).toString("base64");
		return { type: "image", mimeType: "image/png", data, width: first.width, height: first.height };
	}

	function stateOf(result: UiObserveResult): State {
		const window = result.window;
		const head = [`state ${result.state}`, `${result.app.id}${result.app.name ? ` "${result.app.name}"` : ""}`, `window${window.title ? ` "${window.title}"` : ""} ${window.bounds[2]}×${window.bounds[3]} pt`].join(" · ");
		lastState.set(result.app.id, result.state);
		lastApp = result.app.id;
		const outline = outlineOf(head, result.nodes, result.truncated, result.empty);
		const imageNote = result.image ? `\nimage: ${result.image.width}×${result.image.height} px of the window's ${window.bounds[2]}×${window.bounds[3]} points` : "";
		return {
			id: result.state,
			app: { id: result.app.id, name: result.app.name },
			window: { id: window.id, ...(window.title ? { title: window.title } : {}), bounds: window.bounds },
			elements: result.nodes,
			truncated: result.truncated,
			outline: `${outline}${imageNote}`,
			...(result.image ? { image: imageOf(result.image) } : {}),
		};
	}

	/** The screen as a state, for a computer with no ui group: its image, no elements. */
	async function screenState(signal?: AbortSignal): Promise<State> {
		const image = await shot(undefined, signal);
		const app = has("apps") ? ((await call("apps.list", {}, signal)).foreground ?? "") : "";
		const head = `screen ${image.width}×${image.height} px${app ? ` · ${app} in front` : ""} · this computer has no ui group: no elements; act at points of this image`;
		return { id: "screen", app: { id: app, name: "" }, window: { id: "screen", bounds: [0, 0, image.width, image.height] }, elements: [], truncated: false, outline: head, image };
	}

	async function observe(args: ObserveArgs, signal?: AbortSignal): Promise<State> {
		if (!has("ui")) return screenState(signal);
		const imageInUi = args.image === true && card.features["ui.image"] === true;
		const result = await call("ui.observe", { ...(args.app ? { target: { app: args.app } } : {}), ...(imageInUi ? { image: true } : {}), ...(args.full ? { full: true } : {}) }, signal);
		const state = stateOf(result);
		if (args.image === true && !imageInUi && has("screen")) {
			// No window image here (ui.image is off): the whole screen instead, which the outline says.
			const image = await shot(undefined, signal);
			return { ...state, image, outline: `${state.outline}\nimage: the whole screen, ${image.width}×${image.height} px (this computer gives no window image)` };
		}
		return state;
	}

	const observeAnswer = (state: State): SurfaceAnswer => ({ value: state, text: state.outline, images: state.image ? [state.image] : [] });

	/** Steps at points on a computer without the ui group: input.actions, or a refusal naming the step that can't map. */
	function inputActionsOf(steps: readonly UiStep[]): InputAction[] {
		const atPoint = (at: unknown, index: number): Point => {
			if (Array.isArray(at)) return at as Point;
			throw new SurfaceError("unsupported", `step ${index + 1} names an element (${String(at)}): this computer has no ui group, so steps act at points of the screenshot's pixels`);
		};
		return steps.map((step, index): InputAction => {
			if ("click" in step) {
				const at = atPoint(step.click, index);
				if (touchOnly) return step.button === "right" ? { type: "long_press", at } : { type: "tap", at, ...(step.count && step.count > 1 ? { count: 2 } : {}) };
				return { type: "click", at, ...(step.button ? { button: step.button } : {}), ...(step.count ? { count: step.count } : {}) };
			}
			if ("type" in step) {
				if (step.into !== undefined) throw new SurfaceError("unsupported", `step ${index + 1} types into an element: this computer has no ui group; click the field first, then type`);
				return { type: "type", text: step.type };
			}
			if ("key" in step) return { type: "key", keys: chordKeys(step.key) };
			if ("nav" in step) return { type: "button", name: step.nav };
			if ("scroll" in step && touchOnly) {
				// A touch-only phone has no wheel: the finger moves the other way, over the distance (dy > 0 shows what is below).
				const [x, y] = atPoint(step.scroll, index);
				return { type: "swipe", path: [[x, y], [Math.max(0, x - (step.dx ?? 0)), Math.max(0, y - (step.dy ?? 0))]] };
			}
			// By wheel clicks: every driver takes them, and several (X11's, Orgo's) refuse pixels. A click is about 120 pixels.
			if ("scroll" in step) return { type: "scroll", at: atPoint(step.scroll, index), unit: "clicks", ...(step.dx ? { dx: wheelClicks(step.dx) } : {}), ...(step.dy ? { dy: wheelClicks(step.dy) } : {}) };
			if ("drag" in step) return touchOnly ? { type: "swipe", path: step.drag, ...(step.ms ? { ms: step.ms } : {}) } : { type: "drag", path: step.drag };
			throw new SurfaceError("unsupported", `step ${index + 1} (${stepName(step)}) needs the ui group, which this computer does not have: click, type, key, scroll and drag at points instead`);
		});
	}

	async function runInput(actions: InputAction[], observeAfter: boolean, signal?: AbortSignal): Promise<ActResult> {
		const result = await call("input.actions", { actions }, signal);
		const steps: StepResult[] = [];
		for (let index = 0; index < Math.min(result.done, actions.length); index += 1) steps.push({ route: "input", verified: false });
		// A batch the computer refused whole (a full batch, past the limit) says so: its reason is the one step's error.
		if (result.failed) steps.push({ error: { kind: result.failed.kind, message: result.failed.message } });
		const done: ActResult = { steps };
		if (observeAfter && !result.failed) {
			// The settling wait is a batch of its own, so a full batch of actions still fits the computer's limit.
			await call("input.actions", { actions: [{ type: "wait", ms: INPUT_SETTLE_MS } as InputAction] }, signal);
			done.after = await screenState(signal);
		}
		return done;
	}

	const hasPoint = (steps: readonly UiStep[]) => steps.some((step) => ("click" in step && Array.isArray(step.click)) || ("scroll" in step && Array.isArray(step.scroll)) || "drag" in step);

	async function act(args: ActArgs, signal?: AbortSignal): Promise<ActResult> {
		const steps = args.steps ?? [];
		if (!Array.isArray(steps)) throw new SurfaceError("invalid", "steps is a list of steps");
		if (!has("ui")) {
			if (args.expect) throw new SurfaceError("unsupported", "this computer has no ui group, so it can't check an expect: take a screenshot to see the effect");
			return runInput(inputActionsOf(steps), Boolean(args.observe), signal);
		}
		const app = args.app;
		const state = args.state ?? (hasPoint(steps) ? lastState.get(app ?? lastApp ?? "") : undefined);
		const result = await call(
			"ui.act",
			{
				...(app ? { target: { app } } : {}),
				...(state ? { state } : {}),
				steps,
				...(args.expect ? { expect: args.expect } : {}),
				...(args.foreground ? { foreground: true } : {}),
			},
			signal,
		);
		const done: ActResult = { steps: result.steps, ...(result.expect ? { expect: result.expect } : {}), changed: result.changed, state: result.state };
		// The default state of a later point step stays the last observation's (stateOf): a state this act returned was never seen.
		// A script may ask observe as options ({ image: true }); the tool's schema offers only true.
		const again: unknown = args.observe;
		if (again) done.after = await observe({ ...(typeof again === "object" ? (again as ObserveArgs) : {}), ...(app ? { app } : {}) }, signal);
		return done;
	}

	async function readFile(path: string, encoding: string | undefined, signal?: AbortSignal): Promise<string> {
		const parts: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const chunk = await call("files.read", { path, offset, length: MAX_CHUNK_BYTES }, signal);
			const bytes = Buffer.from(chunk.data, "base64");
			parts.push(bytes);
			offset += bytes.length;
			if (chunk.eof || bytes.length === 0) break;
			if (offset >= MAX_READ_BYTES) throw new SurfaceError("limit", `${path} is past ${MAX_READ_BYTES} bytes: read it with the shell in parts`);
		}
		const all = Buffer.concat(parts);
		return encoding === "base64" ? all.toString("base64") : all.toString("utf8");
	}

	async function writeFile(path: string, data: string, encoding: string | undefined, signal?: AbortSignal): Promise<void> {
		const bytes = encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
		let offset = 0;
		do {
			const part = bytes.subarray(offset, offset + MAX_CHUNK_BYTES);
			await call("files.write", { path, data: part.toString("base64"), parents: true, ...(offset > 0 ? { offset } : {}) }, signal);
			offset += part.length;
		} while (offset < bytes.length);
	}

	const infoOf = (path: string, stat: FileStat): FileInfo => ({ path, type: stat.type, size: stat.size, mtimeMs: stat.mtimeMs });

	async function listFiles(path: string, signal?: AbortSignal): Promise<FileInfo[]> {
		const entries: FileEntry[] = [];
		for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
			const result = await call("files.list", { path, ...(entries.length > 0 ? { offset: entries.length } : {}) }, signal);
			entries.push(...result.entries);
			if (!result.truncated || result.entries.length === 0) break;
		}
		return entries.map((entry) => infoOf(entry.path, entry));
	}

	async function run(args: { command?: unknown; cwd?: string; timeoutMs?: number; env?: Record<string, string> }, signal?: AbortSignal): Promise<RunResult> {
		const command = args.command;
		const argv = typeof command === "string" ? (card.os === "windows" ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command]) : Array.isArray(command) && command.every((part) => typeof part === "string") ? (command as string[]) : undefined;
		if (!argv || argv.length === 0) throw new SurfaceError("invalid", "command is a string (run by the shell) or a list: the program and its arguments");
		const timeoutMs = Math.min(Math.max(1, args.timeoutMs ?? DEFAULT_RUN_MS), MAX_RUN_MS);
		const result = await call("exec.run", { argv, timeoutMs, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.env ? { env: args.env } : {}) }, signal);
		return {
			stdout: Buffer.from(result.stdout, "base64").toString("utf8"),
			stderr: Buffer.from(result.stderr, "base64").toString("utf8"),
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			truncated: result.truncated,
		};
	}

	const pathOf = (args: Record<string, unknown>): string => {
		if (typeof args.path !== "string" || args.path === "") throw new SurfaceError("invalid", "path is an absolute path on the computer");
		return args.path;
	};

	async function answer(op: SurfaceOp, args: Record<string, unknown>, signal?: AbortSignal): Promise<SurfaceAnswer> {
		switch (op) {
			case "observe":
				return observeAnswer(await observe(args as ObserveArgs, signal));
			case "act": {
				const result = await act(args as unknown as ActArgs, signal);
				const names = ((args.steps as UiStep[] | undefined) ?? []).map(stepName);
				return { value: result, text: actText(names, result), images: result.after?.image ? [result.after.image] : [] };
			}
			case "input.act": {
				const actions = args.actions;
				if (!Array.isArray(actions)) throw new SurfaceError("invalid", "actions is a list of input actions");
				const result = await runInput(actions as InputAction[], false, signal);
				return { value: result, text: actText((actions as InputAction[]).map((action) => String(action?.type ?? "action")), result), images: [] };
			}
			case "screenshot": {
				const image = await shot((args as ScreenshotArgs).region, signal);
				return { value: image, text: `screenshot ${image.width}×${image.height} px`, images: [image] };
			}
			case "apps.list": {
				const result = await call("apps.list", {}, signal);
				const apps: AppInfo[] = result.apps.map((app) => ({ id: app.id, ...(app.name ? { name: app.name } : {}) }));
				const value = { apps, foreground: result.foreground };
				return { value, text: jsonText(value), images: [] };
			}
			case "apps.open": {
				if (typeof args.id !== "string" || args.id === "") throw new SurfaceError("invalid", "id is the app's bundle id or package name");
				await call("apps.launch", { id: args.id, ...(typeof args.url === "string" ? { url: args.url } : {}), ...(args.background === true ? { background: true } : {}) }, signal);
				return { value: { id: args.id }, text: `opened ${args.id}`, images: [] };
			}
			case "shell.run": {
				const value = await run(args, signal);
				return { value, text: jsonText(value), images: [] };
			}
			case "files.read": {
				const value = await readFile(pathOf(args), args.encoding as string | undefined, signal);
				return { value, text: value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}… (${value.length - MAX_TEXT_CHARS} more characters)` : value, images: [] };
			}
			case "files.write": {
				if (typeof args.data !== "string") throw new SurfaceError("invalid", "data is the file's text, or its bytes as base64");
				const path = pathOf(args);
				await writeFile(path, args.data, args.encoding as string | undefined, signal);
				return { value: null, text: `wrote ${path}`, images: [] };
			}
			case "files.list": {
				const value = await listFiles(pathOf(args), signal);
				return { value, text: jsonText(value), images: [] };
			}
			case "files.stat": {
				const path = pathOf(args);
				const value = infoOf(path, await call("files.stat", { path }, signal));
				return { value, text: jsonText(value), images: [] };
			}
		}
	}

	return {
		card,
		ops,
		async call(op, args, options = {}) {
			if (!(SURFACE_OPS as readonly string[]).includes(op)) throw new SurfaceError("invalid", `no such call: ${op}`);
			const known = op as SurfaceOp;
			if (!ops.includes(known)) throw new SurfaceError("unsupported", `this computer can't ${op}: it offers ${card.groups.join(", ") || "no groups"}`);
			const given = args === undefined || args === null ? {} : args;
			if (typeof given !== "object" || Array.isArray(given)) throw new SurfaceError("invalid", `${op} takes an object of arguments`);
			return answer(known, given as Record<string, unknown>, options.signal);
		},
	};
}

/** A value with its images' data left out: the structured half of an answer whose images travel beside it. */
export function withoutImageData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutImageData);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (record.type === "image" && typeof record.data === "string") {
		const { data: _data, ...rest } = record;
		return rest;
	}
	return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, withoutImageData(entry)]));
}
