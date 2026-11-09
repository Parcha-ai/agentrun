// A computer's live view, in two layers.
//
// watchScreen(connection, options) is the internal seam: the screen as pull-paced frames and an input sink on one
// connection. screen.watch asks for the frame after the last one given, and the next ask is made only when the caller
// calls next() again, so each next() is the ack of the frame before it. act() sends input.actions on the same
// connection. close() and the caller's signal end both: the waiting ask is cancelled, the frames end, and act()
// refuses in words. A computer that fails makes next() reject with a ScreenWatchError.
//
// provider.watch(ref, handlers, options) is what the runner's viewer calls (tl-browser's handler shape, final), built
// once, by daemonWatch, as an adapter over watchScreen: each frame goes to handlers.frame(frame, ack), and the next is
// asked for only once ack() is called; a computer that goes ends it once with handlers.ended(error), its code gone,
// unreachable, refused or unsupported; close() and the signal end it with no ended(). Every computerd provider and the
// phone answer watch() through daemonWatch, on a connection of the watch's own: computerd gives JPEG frames, the phone
// client PNG ones. No error in either layer holds a URL or a secret.
import type { Button, InputAction, InputActionsResult, Point } from "./protocol.js";
import type { ComputerConnection, ComputerRef, Refusal } from "./provider.js";
import { type ComputerError, type ComputerErrorCode, fail, ok, type Result } from "./result.js";

/** One whole frame of the screen. */
export interface ScreenFrame {
	/** Rises with each frame of a watch. */
	seq: number;
	format: "jpeg" | "png";
	bytes: Uint8Array;
	/** The screen's real pixels, unscaled: the space every input action's coordinates are in. */
	width: number;
	height: number;
	/** The image's own pixels, scaled down to maxWidth at most. */
	frameWidth: number;
	frameHeight: number;
	cursor?: [number, number];
}

export interface WatchOptions {
	/** Ends the watch as close() does. */
	signal?: AbortSignal;
	/** The frame's width at most; the computer's default (1280) when absent. */
	maxWidth?: number;
	/** JPEG quality, 1 to 100; the computer's default (60) when absent. */
	quality?: number;
}

/** watchScreen's answer: pull-paced frames and an input sink on one connection. */
export interface ScreenFrames {
	/** Pull-paced: each next() is the ack for the frame before it (the caller calls next() once it has drawn a frame). */
	frames: AsyncIterable<ScreenFrame>;
	/** The viewer's mapped events, on the same connection; per-call errors in words, never a URL or a secret. */
	act(actions: InputAction[], options?: { signal?: AbortSignal }): Promise<Result<InputActionsResult>>;
	/** Ends the frames and refuses further acts; the signal passed to watchScreen does the same. */
	close(): Promise<void>;
}

/** Frames that failed: the code, and words with no URL or secret. */
export class ScreenWatchError extends Error {
	constructor(
		readonly code: ComputerErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ScreenWatchError";
	}
}

/** Why a watch ended without close() or the signal. */
export type WatchEndCode = "gone" | "unreachable" | "refused" | "unsupported";

export interface ScreenWatchHandlers {
	/** The latest frame. Call ack() once it is drawn, or at once to drop it: the next frame is asked for only then. */
	frame(frame: ScreenFrame, ack: () => void): void;
	/** The watch ended without close() or the signal, once: the computer is gone or failed. In words, with no URL. */
	ended(error: ComputerError & { code: WatchEndCode }): void;
}

/** provider.watch's answer. */
export interface ScreenWatch {
	/** The viewer's events, mapped by toAction, on the watch's connection; per call, its result in words with no URL. */
	input(actions: InputAction[], options?: { signal?: AbortSignal }): Promise<Result<InputActionsResult>>;
	/** Ends the watch: no frame and no ended() after it, and its connection is let go. Idempotent. */
	close(): Promise<void>;
}

/** Words with no URL and no secret: a URL of any scheme, a secret-named parameter and a key-shaped token are taken out. */
export function redactWords(words: string): string {
	return words
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[a URL]")
		.replace(/\b(?:token|password|passwd|secret|key|jwt|auth|code|signingKey)=[^\s&"';,]+/gi, "[a secret]")
		.replace(/\b(?:sk|pk|pck|ph|tok|pw|jwt)_[A-Za-z0-9_-]{6,}/g, "[a secret]");
}

/** The code a watch ends with for an error the computer gave. */
export function watchEndCode(code: ComputerErrorCode): WatchEndCode {
	switch (code) {
		case "gone":
		case "not_found":
			return "gone";
		case "unsupported":
			return "unsupported";
		case "refused":
		case "denied":
		case "unauthorized":
		case "invalid":
		case "limit":
			return "refused";
		default:
			return "unreachable";
	}
}

/** The screen of the computer on `connection`, as pull-paced frames and an input sink (see the top of this file). */
export function watchScreen(connection: ComputerConnection, options: WatchOptions = {}): ScreenFrames {
	const { client } = connection;
	const stop = new AbortController();
	let ended: "closed" | "aborted" | undefined;
	const end = (why: "closed" | "aborted") => {
		ended ??= why;
		stop.abort();
	};
	const onAbort = () => end("aborted");
	if (options.signal?.aborted) end("aborted");
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	const params = {
		...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
		...(options.quality === undefined ? {} : { quality: options.quality }),
	};

	async function* frames(): AsyncGenerator<ScreenFrame, void, undefined> {
		let after = 0;
		for (;;) {
			if (ended) return;
			const asked = await client.call("screen.watch", { after, ...params }, { signal: stop.signal });
			if (ended) return;
			if (!asked.ok) throw new ScreenWatchError(asked.error.code, redactWords(asked.error.message));
			const answer = asked.value;
			if (!answer.changed) {
				// The computer waited its waitMs; one that answers at once must not spin: timers and the signal run first.
				await new Promise((resolve) => setImmediate(resolve));
				continue;
			}
			const parts = [Buffer.from(answer.data ?? "", "base64")];
			let size = parts[0].length;
			for (let eof = answer.eof ?? true; !eof; ) {
				const read = await client.call("screen.read", { id: answer.id ?? "", offset: size }, { signal: stop.signal });
				if (ended) return;
				if (!read.ok) throw new ScreenWatchError(read.error.code, redactWords(read.error.message));
				const part = Buffer.from(read.value.data, "base64");
				if (part.length === 0 && !read.value.eof) throw new ScreenWatchError("invalid", `screen.read of frame ${answer.seq} at ${size} gave no bytes and no eof`);
				parts.push(part);
				size += part.length;
				eof = read.value.eof;
			}
			after = answer.seq;
			yield {
				seq: answer.seq,
				format: answer.format ?? "jpeg",
				bytes: Buffer.concat(parts),
				frameWidth: answer.frameWidth ?? answer.width,
				frameHeight: answer.frameHeight ?? answer.height,
				width: answer.width,
				height: answer.height,
				...(answer.cursor ? { cursor: [answer.cursor[0], answer.cursor[1]] as [number, number] } : {}),
			};
		}
	}
	const generator = frames();

	return {
		frames: { [Symbol.asyncIterator]: () => generator },
		async act(actions, { signal } = {}) {
			if (ended === "closed") return fail("gone", "the screen watch is closed: nothing more is sent to the computer");
			if (ended === "aborted") return fail("aborted", "the screen watch was aborted: nothing more is sent to the computer");
			const either = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
			const done = await client.call("input.actions", { actions }, { signal: either });
			return done.ok ? done : fail(done.error.code, redactWords(done.error.message));
		},
		async close() {
			options.signal?.removeEventListener("abort", onAbort);
			end("closed");
			await generator.return(undefined).catch(() => undefined);
		},
	};
}

/**
 * The live view of the computer at ref, through provider's connect(): the one implementation behind every provider's
 * watch(), an adapter over watchScreen on a connection of the watch's own, which it lets go however the watch ends. A
 * computer whose hello declares no screen is refused as unsupported; a connect that fails keeps its code, in words with
 * no URL.
 */
export async function daemonWatch(
	provider: { connect(ref: ComputerRef): Promise<Result<ComputerConnection>> },
	ref: ComputerRef,
	handlers: ScreenWatchHandlers,
	options: WatchOptions = {},
): Promise<Result<ScreenWatch>> {
	if (options.signal?.aborted) return fail("aborted", "the screen watch was aborted before it started");
	const connected = await provider.connect(ref);
	if (!connected.ok) return fail(connected.error.code, redactWords(connected.error.message));
	const connection = connected.value;
	const groups = Array.isArray(connection.hello?.groups) ? connection.hello.groups : [];
	if (!groups.includes("screen")) {
		await connection.close().catch(() => undefined);
		return fail("unsupported", `${ref.name} has no screen to watch: its computer declares ${groups.join(", ") || "no group"}`);
	}
	if (options.signal?.aborted) {
		await connection.close().catch(() => undefined);
		return fail("aborted", "the screen watch was aborted before it started");
	}

	const screen = watchScreen(connection, options);
	const stop = new AbortController();
	const stopped = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
	let lost: ComputerError | undefined;
	let released: Promise<void> | undefined;
	const release = () => {
		released ??= screen
			.close()
			.then(() => connection.close())
			.catch(() => undefined);
		return released;
	};
	// The caller's signal ends the watch as close() does: watchScreen stops on it, and the connection is let go here.
	const onAbort = () => {
		stop.abort();
		void release();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const run = async () => {
		const frames = screen.frames[Symbol.asyncIterator]();
		for (;;) {
			let next: IteratorResult<ScreenFrame>;
			try {
				next = await frames.next();
			} catch (error) {
				if (stop.signal.aborted) return;
				const code = error instanceof ScreenWatchError ? error.code : "unreachable";
				const words = redactWords(error instanceof Error ? error.message : String(error));
				lost = { code: watchEndCode(code), message: words };
				options.signal?.removeEventListener("abort", onAbort);
				stop.abort();
				void release();
				try {
					handlers.ended(lost as ComputerError & { code: WatchEndCode });
				} catch {
					// The handler's own failure is the viewer's; the watch is over either way.
				}
				return;
			}
			if (next.done || stop.signal.aborted) return;
			let acked!: () => void;
			const ack = new Promise<void>((resolve) => (acked = resolve));
			try {
				handlers.frame(next.value, () => acked());
			} catch {
				// A handler that throws drops the frame: the next is asked for at once.
				acked();
			}
			await Promise.race([ack, stopped]);
			if (stop.signal.aborted) return;
		}
	};
	void run();

	return ok({
		async input(actions, { signal } = {}) {
			if (lost) return fail(lost.code, `the screen watch ended: ${lost.message}`);
			return screen.act(actions, signal ? { signal } : {});
		},
		async close() {
			options.signal?.removeEventListener("abort", onAbort);
			stop.abort();
			await release();
		},
	});
}

/** An event as the live view's viewer emits it, in the screen's pixels (the frame's width and height). */
export type ViewerEvent =
	| { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button: number; buttons: number; clickCount: number; modifiers: number }
	| { type: "wheel"; x: number; y: number; dx: number; dy: number }
	| { type: "key"; action: "down" | "up" | "char"; key: string; code: string; text?: string; modifiers: number }
	| { type: "tap"; x: number; y: number }
	| { type: "swipe"; x1: number; y1: number; x2: number; y2: number; ms: number }
	| { type: "button"; name: "back" | "home" | "recents" };

/** The viewer's mouse buttons (MouseEvent.button) as the protocol names them. */
const BUTTONS: Record<number, Button> = { 0: "left", 1: "middle", 2: "right" };

/** The viewer's key names (KeyboardEvent.key) that are not one printable character, as the protocol's KEYS name them. */
const KEY_NAMES: Record<string, string> = {
	Enter: "enter",
	Tab: "tab",
	" ": "space",
	Backspace: "backspace",
	Delete: "delete",
	Escape: "escape",
	Insert: "insert",
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	Home: "home",
	End: "end",
	PageUp: "pageup",
	PageDown: "pagedown",
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`])),
};
/** Keys pressed alone do nothing a viewer means: they ride a combo as modifiers. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "OS"]);

/** The modifiers of a key event (CDP's mask: Alt 1, Control 2, Meta 4, Shift 8) as combo keys, in order. */
const comboOf = (modifiers: number) => [...(modifiers & 2 ? ["ctrl"] : []), ...(modifiers & 1 ? ["alt"] : []), ...(modifiers & 8 ? ["shift"] : []), ...(modifiers & 4 ? ["super"] : [])];

const pointOf = (x: number, y: number): Point | undefined => (Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x), Math.round(y)] : undefined);
const notAPoint = (x: number, y: number): Refusal => ({ field: "x", message: `${x},${y} is not a point on the screen` });

/** The key event's input actions, the same for every kind: a printable key's down types nothing (its char does). */
function keyActions(event: Extract<ViewerEvent, { type: "key" }>): InputAction[] | Refusal {
	if (event.action === "up") return [];
	if (event.action === "char") {
		const text = event.text ?? event.key;
		return text === "" ? [] : [{ type: "type", text }];
	}
	if (MODIFIER_KEYS.has(event.key)) return [];
	const named = KEY_NAMES[event.key];
	const printable = /^[\x21-\x7e]$/.test(event.key);
	const combo = comboOf(event.modifiers ?? 0);
	const held = combo.filter((k) => k !== "shift");
	if (named === undefined && !printable) return { field: "key", message: `${event.key} is not a key this computer takes` };
	// A printable character with no ctrl, alt or super held is typed by its char event, which carries the layout's text.
	if (named === undefined && held.length === 0) return [];
	const key = named ?? event.key.toLowerCase();
	return [{ type: "key", keys: [...(named === undefined ? held : combo), key] } as InputAction];
}

/**
 * The viewer's event as input actions for a computer of this kind, in the screen's upright pixels: the space the
 * frames' width and height give. Points are rounded to whole pixels. What a kind cannot take is a Refusal in words,
 * naming the event's field.
 */
export function toAction(event: ViewerEvent, kind: "desktop" | "android" | "ios"): InputAction[] | Refusal {
	if (event.type === "key") return keyActions(event);
	if (kind === "desktop") {
		switch (event.type) {
			case "mouse": {
				const at = pointOf(event.x, event.y);
				if (!at) return notAPoint(event.x, event.y);
				if (event.action === "move") return [{ type: "move", at }];
				const button = BUTTONS[event.button];
				if (!button) return { field: "button", message: `mouse button ${event.button} is not left (0), middle (1) or right (2)` };
				return [{ type: "move", at }, { type: event.action, button }];
			}
			case "wheel": {
				const at = pointOf(event.x, event.y);
				if (!at) return notAPoint(event.x, event.y);
				if (!Number.isFinite(event.dx) || !Number.isFinite(event.dy)) return { field: "dx", message: `the wheel's delta ${event.dx},${event.dy} is not two numbers` };
				// A wheel notch is about 120 pixels of delta; X scrolls by clicks, so any movement is one click at least.
				const clicks = (d: number) => (d === 0 ? 0 : Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 120)));
				return [{ type: "scroll", at, dx: clicks(event.dx), dy: clicks(event.dy), unit: "clicks" }];
			}
			default:
				return { field: "type", message: `a desktop takes the mouse, the wheel and keys, not a ${event.type}` };
		}
	}
	switch (event.type) {
		case "tap": {
			const at = pointOf(event.x, event.y);
			return at ? [{ type: "tap", at }] : notAPoint(event.x, event.y);
		}
		case "swipe": {
			const from = pointOf(event.x1, event.y1);
			const to = pointOf(event.x2, event.y2);
			if (!from || !to) return { field: "x1", message: `a swipe from ${event.x1},${event.y1} to ${event.x2},${event.y2} is not two points on the screen` };
			const ms = Number.isFinite(event.ms) && event.ms >= 0 ? Math.round(event.ms) : 300;
			return [{ type: "swipe", path: [from, to], ms }];
		}
		case "button":
			return [{ type: "button", name: event.name === "recents" ? "app_switch" : event.name }];
		default:
			return { field: "type", message: `a phone takes taps, swipes, its buttons and keys, not the ${event.type}` };
	}
}
