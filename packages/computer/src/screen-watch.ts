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
// The most characters one typed text holds, on every kind: computerd's MaxTypeRunes, which checkActions enforces too.
import { MAX_TYPE_CHARACTERS } from "./actions.js";
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

/** The largest frame a watch reads: a frame that says more is refused before any of it is read. */
const MAX_FRAME_BYTES = 64 << 20;
/** The most input calls a watch has in flight at once: one more is refused as limit, never queued. */
const MAX_INPUTS_IN_FLIGHT = 8;

/**
 * Words with no URL and no secret: a URL of any scheme, a login, a bearer, a secret-named parameter, a key- or
 * token-shaped value and an endpoint (a host or an IPv4 address with a port) are taken out.
 */
export function redactWords(words: string): string {
	return (
		words
			.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[a URL]")
			// A login in a host's place: user:password@host.
			.replace(/[\w.+-]+:[^\s@/'"]+@[\w.-]+/g, "[a login]")
			.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[a secret]")
			// A secret-named parameter, its name with a prefix or suffix too: api_key=, access_token=, client_secret=.
			.replace(/\b[\w-]*(?:token|password|passwd|secret|key|jwt|auth|code|signingKey|credential)[\w-]*=[^\s&"';,]+/gi, "[a secret]")
			.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]*/g, "[a secret]")
			.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[a secret]")
			.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[a secret]")
			.replace(/\b(?:sk|pk|pck|ph|tok|pw|jwt)_[A-Za-z0-9_-]{6,}/g, "[a secret]")
			// An endpoint: a DNS name or an IPv4 address with a port, as adb names a phone's.
			.replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}:\d{1,5}\b/g, "[an endpoint]")
			.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[an endpoint]")
	);
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
			// The frame is read by the size it says: never past it, never over the largest frame, and whole at the end. A
			// missing eof is never taken as the end: the size says whether there is more.
			const said = answer.size;
			const sized = typeof said === "number" && Number.isSafeInteger(said) && said >= 0;
			if (sized && said > MAX_FRAME_BYTES) throw new ScreenWatchError("invalid", `frame ${answer.seq} says ${said} bytes, more than the largest frame, ${MAX_FRAME_BYTES}`);
			const parts = [Buffer.from(answer.data ?? "", "base64")];
			let size = parts[0].length;
			const past = () => new ScreenWatchError("invalid", `frame ${answer.seq} gave ${size} bytes, past the ${said} bytes it said`);
			if (sized && size > said) throw past();
			for (let eof = answer.eof ?? (!sized || size >= said); !eof; ) {
				const read = await client.call("screen.read", { id: answer.id ?? "", offset: size }, { signal: stop.signal });
				if (ended) return;
				if (!read.ok) throw new ScreenWatchError(read.error.code, redactWords(read.error.message));
				const part = Buffer.from(read.value.data, "base64");
				if (part.length === 0 && !read.value.eof) throw new ScreenWatchError("invalid", `screen.read of frame ${answer.seq} at ${size} gave no bytes and no eof`);
				parts.push(part);
				size += part.length;
				if (sized ? size > said : size > MAX_FRAME_BYTES) throw past();
				eof = read.value.eof;
			}
			if (sized && size !== said) throw new ScreenWatchError("invalid", `frame ${answer.seq} ended at ${size} bytes of the ${said} it said`);
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
	let inFlight = 0;

	return {
		frames: { [Symbol.asyncIterator]: () => generator },
		async act(actions, { signal } = {}) {
			if (ended === "closed") return fail("gone", "the screen watch is closed: nothing more is sent to the computer");
			if (ended === "aborted") return fail("aborted", "the screen watch was aborted: nothing more is sent to the computer");
			if (inFlight >= MAX_INPUTS_IN_FLIGHT) return fail("limit", `${MAX_INPUTS_IN_FLIGHT} inputs are in flight on this watch: send the next once one has answered`);
			inFlight += 1;
			try {
				const either = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
				const done = await client.call("input.actions", { actions }, { signal: either });
				if (!done.ok) return fail(done.error.code, redactWords(done.error.message));
				// A failed action's words may carry a device's stderr: redacted as an error's are.
				const failed = done.value.failed;
				return failed ? ok({ ...done.value, failed: { ...failed, message: redactWords(failed.message) } }) : done;
			} finally {
				inFlight -= 1;
			}
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

/** The longest swipe a viewer asks for, in ms. */
const MAX_SWIPE_MS = 1_000;
/** The most wheel clicks one event moves, each way. */
const MAX_WHEEL_CLICKS = 20;
/** The longest key name a viewer sends (KeyboardEvent.key). */
const MAX_KEY_LENGTH = 64;

const show = (value: unknown) => (typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : String(value));
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** A field's number, or a Refusal naming it. */
const numberOf = (event: Record<string, unknown>, field: string): number | Refusal =>
	isNumber(event[field]) ? (event[field] as number) : { field, message: `${field} ${show(event[field])} is not a number` };
const isRefusal = (value: unknown): value is Refusal => typeof value === "object" && value !== null && "field" in value;
/** The event's point at fields x and y (or x1/y1, x2/y2), rounded to whole pixels, or a Refusal naming the field. */
function pointAt(event: Record<string, unknown>, x: string, y: string): Point | Refusal {
	const px = numberOf(event, x);
	if (isRefusal(px)) return { field: x, message: `${show(event[x])},${show(event[y])} is not a point on the screen` };
	const py = numberOf(event, y);
	if (isRefusal(py)) return { field: y, message: `${show(event[x])},${show(event[y])} is not a point on the screen` };
	return [Math.round(px), Math.round(py)];
}
/** The event's modifiers (CDP's mask), or a Refusal. */
const modifiersOf = (event: Record<string, unknown>): number | Refusal => {
	const m = event.modifiers ?? 0;
	return Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 15 ? (m as number) : { field: "modifiers", message: `modifiers ${show(m)} is not CDP's mask, a whole number 0 to 15` };
};

/** The key event's input actions: a printable key's down types nothing (its char does); see toAction. */
function keyActions(event: Record<string, unknown>, kind: "desktop" | "android" | "ios"): InputAction[] | Refusal {
	if (!["down", "up", "char"].includes(event.action as string)) return { field: "action", message: `a key's action ${show(event.action)} is not down, up or char` };
	if (typeof event.key !== "string" || event.key.length > MAX_KEY_LENGTH) return { field: "key", message: `key ${show(event.key)} is not a key name of ${MAX_KEY_LENGTH} characters at most` };
	if (event.text !== undefined && typeof event.text !== "string") return { field: "text", message: `text ${show(event.text)} is not a string` };
	const modifiers = modifiersOf(event);
	if (isRefusal(modifiers)) return modifiers;
	const key = event.key;
	if (event.action === "up") return [];
	if (event.action === "char") {
		const text = (event.text as string | undefined) ?? key;
		const characters = [...text].length;
		if (characters > MAX_TYPE_CHARACTERS) return { field: "text", message: `text of ${characters} characters: one typed text holds at most ${MAX_TYPE_CHARACTERS} characters` };
		return text === "" ? [] : [{ type: "type", text }];
	}
	if (MODIFIER_KEYS.has(key)) return [];
	const named = KEY_NAMES[key];
	const printable = /^[\x21-\x7e]$/.test(key);
	const combo = comboOf(modifiers);
	if (named === undefined && !printable) return { field: "key", message: `${key} is not a key this computer takes` };
	// A viewer never ends or switches the display (the X server's own key combos), whatever the desktop.
	if (kind === "desktop" && modifiers & 2 && modifiers & 1) {
		if (key === "Backspace") return { field: "key", message: "ctrl+alt+backspace would end the display: the live view does not send it" };
		if (/^F([1-9]|1[0-2])$/.test(key)) return { field: "key", message: `ctrl+alt+${key} would switch the display: the live view does not send it` };
	}
	// A printable character with no ctrl, alt or super held is typed by its char event, which carries the layout's text;
	// with one held it is a shortcut, Shift kept: ctrl+shift+s is not ctrl+s.
	if (named === undefined && !(modifiers & (1 | 2 | 4))) return [];
	return [{ type: "key", keys: [...combo, named ?? key.toLowerCase()] } as InputAction];
}

/**
 * The viewer's event as input actions for a computer of this kind, in the screen's upright pixels: the space the
 * frames' width and height give. Points are rounded to whole pixels. What a kind cannot take is a Refusal in words,
 * naming the event's field, and so is an event whose fields are not what its type says: it never throws.
 *
 * Bounds: a typed text holds 65,536 characters at most (refused past it); a swipe takes 0 to 1,000 ms (clamped); one
 * wheel event moves 20 clicks at most each way (clamped). A shortcut keeps Shift (ctrl+shift+s). A click with a
 * modifier held is one click with its keys, on the up; its down only moves. A desktop never gets ctrl+alt+backspace or
 * ctrl+alt+F1 to F12: they end or switch the X display.
 *
 * toAction is stateless: each event on its own. A modifier released between a press and its release makes the press
 * modified and the release plain, and the click is lost; a viewer maps through createActionMapper, which remembers.
 */
export function toAction(event: ViewerEvent, kind: "desktop" | "android" | "ios"): InputAction[] | Refusal {
	// The event comes from a browser page: every field is checked here, whatever its type says.
	if (typeof event !== "object" || event === null || Array.isArray(event)) return { field: "type", message: "an event is an object with a type" };
	const e = event as unknown as Record<string, unknown>;
	const type = e.type;
	if (!["mouse", "wheel", "key", "tap", "swipe", "button"].includes(type as string)) return { field: "type", message: `${show(type)} is not an event the live view sends` };
	if (type === "key") return keyActions(e, kind);
	if (kind === "desktop") {
		switch (type) {
			case "mouse": {
				if (!["down", "up", "move"].includes(e.action as string)) return { field: "action", message: `a mouse action ${show(e.action)} is not down, up or move` };
				const at = pointAt(e, "x", "y");
				if (isRefusal(at)) return at;
				const modifiers = modifiersOf(e);
				if (isRefusal(modifiers)) return modifiers;
				if (e.action === "move") return [{ type: "move", at }];
				const button = typeof e.button === "number" ? BUTTONS[e.button] : undefined;
				if (!button) return { field: "button", message: `mouse button ${show(e.button)} is not left (0), middle (1) or right (2)` };
				if (modifiers === 0) return [{ type: "move", at }, { type: e.action as "down" | "up", button }];
				// A modified click keeps its modifiers: the protocol holds keys through a click, not across a down and an up,
				// so the down only moves and the up clicks with the keys held (a modified drag is not sent). Each up is one
				// click: a double-click is its two ups, as the X server times them, never a count (which it would repeat).
				if (e.action === "down") return [{ type: "move", at }];
				return [{ type: "move", at }, { type: "click", at, button, keys: comboOf(modifiers) } as InputAction];
			}
			case "wheel": {
				const at = pointAt(e, "x", "y");
				if (isRefusal(at)) return at;
				const dx = numberOf(e, "dx");
				if (isRefusal(dx)) return dx;
				const dy = numberOf(e, "dy");
				if (isRefusal(dy)) return dy;
				// A wheel notch is about 120 pixels of delta; X scrolls by clicks, so any movement is one click at least, and
				// one event moves MAX_WHEEL_CLICKS at most.
				const clicks = (d: number) => (d === 0 ? 0 : Math.sign(d) * Math.min(MAX_WHEEL_CLICKS, Math.max(1, Math.round(Math.abs(d) / 120))));
				return [{ type: "scroll", at, dx: clicks(dx), dy: clicks(dy), unit: "clicks" }];
			}
			default:
				return { field: "type", message: `a desktop takes the mouse, the wheel and keys, not a ${type}` };
		}
	}
	switch (type) {
		case "tap": {
			const at = pointAt(e, "x", "y");
			return isRefusal(at) ? at : [{ type: "tap", at }];
		}
		case "swipe": {
			const from = pointAt(e, "x1", "y1");
			if (isRefusal(from)) return from;
			const to = pointAt(e, "x2", "y2");
			if (isRefusal(to)) return to;
			const ms = numberOf(e, "ms");
			if (isRefusal(ms)) return ms;
			return [{ type: "swipe", path: [from, to], ms: Math.min(MAX_SWIPE_MS, Math.max(0, Math.round(ms))) }];
		}
		case "button": {
			const name = e.name;
			if (name !== "back" && name !== "home" && name !== "recents") return { field: "name", message: `button ${show(name)} is not back, home or recents` };
			return [{ type: "button", name: name === "recents" ? "app_switch" : name }];
		}
		default:
			return { field: "type", message: `a phone takes taps, swipes, its buttons and keys, not the ${type}` };
	}
}

/** Maps one viewer's events in order, remembering each mouse press until its release: one mapper is one take-over. */
export interface ActionMapper {
	/**
	 * The event as input actions, or a Refusal: toAction's answer, but for a desktop's mouse buttons, whose press decides
	 * the strategy for the press and its release together:
	 * - a down with a modifier held sends only a move and remembers the keys held then; its up is one click with those
	 *   keys, whatever is held at the up;
	 * - a down with no modifier is a plain down, and its up a plain up, even if a modifier is pressed in between;
	 * - an up with no press remembered is toAction's.
	 */
	map(event: ViewerEvent): InputAction[] | Refusal;
	/**
	 * Lets go of every button and key this mapper sent a down for and has not released (the take-over ends, or the
	 * viewer loses focus), then forgets every press: the ups to send, nothing on a second call. A key is never among
	 * them: the protocol presses and releases a key within its action, so the mapper never leaves one down.
	 */
	release(): InputAction[];
}

/** A mapper of the viewer's events for a computer of this kind; see ActionMapper. */
export function createActionMapper(kind: "desktop" | "android" | "ios"): ActionMapper {
	/** Each mouse button pressed and not released: plain (a down was sent), or the keys a modified press holds. */
	const pressed = new Map<Button, { keys?: string[] }>();
	return {
		map(event) {
			const stateless = toAction(event, kind);
			if (isRefusal(stateless) || kind !== "desktop") return stateless;
			const e = event as unknown as Record<string, unknown>;
			if (e.type !== "mouse" || (e.action !== "down" && e.action !== "up")) return stateless;
			// toAction checked the event: its point, button and modifiers are good.
			const button = BUTTONS[e.button as number] as Button;
			const at: Point = [Math.round(e.x as number), Math.round(e.y as number)];
			const modifiers = (e.modifiers as number | undefined) ?? 0;
			if (e.action === "down") {
				pressed.set(button, modifiers === 0 ? {} : { keys: comboOf(modifiers) });
				return stateless;
			}
			const press = pressed.get(button);
			if (press === undefined) return stateless;
			pressed.delete(button);
			if (press.keys === undefined) return [{ type: "move", at }, { type: "up", button }];
			return [{ type: "move", at }, { type: "click", at, button, keys: press.keys }];
		},
		release() {
			const ups: InputAction[] = [...pressed].filter(([, press]) => press.keys === undefined).map(([button]) => ({ type: "up", button }));
			pressed.clear();
			return ups;
		},
	};
}
