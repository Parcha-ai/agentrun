// A computer's live view, as the runner's viewer reads it (tl-browser's handler shape, final): provider.watch(ref,
// handlers, options) gives each frame to handlers.frame(frame, ack) and asks for the next one only once ack() is
// called, as CDP screencast's frames are acked; input() sends the viewer's events, mapped by toAction, on the same
// connection; close() and the caller's signal end the watch with no ended(); a computer that goes (released, gone, not
// reached) ends it once with ended(error), its code gone, unreachable, refused or unsupported.
//
// daemonWatch is the one implementation behind every provider's watch(): it opens a connection of the watch's own and
// reads screen.watch over it, which computerd answers with JPEG frames and the phone client with PNG ones. No error
// it gives holds a URL or a secret: the words are redacted, whatever the computer or the vendor said.
import type { Button, InputAction, InputActionsResult, Point } from "./protocol.js";
import type { ComputerConnection, ComputerRef } from "./provider.js";
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

/** Why a watch ended without close() or the signal. */
export type WatchEndCode = "gone" | "unreachable" | "refused" | "unsupported";

export interface ScreenWatchHandlers {
	/** The latest frame. Call ack() once it is drawn, or at once to drop it: the next frame is asked for only then. */
	frame(frame: ScreenFrame, ack: () => void): void;
	/** The watch ended without close() or the signal, once: the computer is gone or failed. In words, with no URL. */
	ended(error: ComputerError & { code: WatchEndCode }): void;
}

export interface ScreenWatch {
	/** The viewer's events, mapped by toAction, on the watch's connection; per call, its result in words with no URL. */
	input(actions: InputAction[], options?: { signal?: AbortSignal }): Promise<Result<InputActionsResult>>;
	/** Ends the watch: no frame and no ended() after it, and its connection is let go. Idempotent. */
	close(): Promise<void>;
}

export interface WatchOptions {
	/** Ends the watch as close() does. */
	signal?: AbortSignal;
	/** The frame's width at most; the computer's default (1280) when absent. */
	maxWidth?: number;
	/** JPEG quality, 1 to 100; the computer's default (60) when absent. */
	quality?: number;
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

/**
 * The live view of the computer at ref, through provider's connect(): the one implementation behind every provider's
 * watch(). A computer whose hello declares no screen is refused as unsupported; a connect that fails keeps its code,
 * in words with no URL.
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
	return ok(watchConnection(connection, handlers, options));
}

/** The watch over one connection, which it owns: the connection is closed when the watch ends, however it ends. */
function watchConnection(connection: ComputerConnection, handlers: ScreenWatchHandlers, options: WatchOptions): ScreenWatch {
	const { client } = connection;
	const stop = new AbortController();
	const stopped = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
	let ended: { why: "closed" | "aborted" } | { why: "lost"; error: ComputerError } | undefined;
	let released: Promise<void> | undefined;
	const release = () => {
		released ??= connection.close().catch(() => undefined);
		return released;
	};
	const onAbort = () => end("aborted");
	const end = (why: "closed" | "aborted") => {
		if (ended) return;
		ended = { why };
		options.signal?.removeEventListener("abort", onAbort);
		stop.abort();
		void release();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	/** The computer went: ended() once, with a code it may end with and words with no URL. */
	const lost = (error: ComputerError) => {
		if (ended) return;
		const given = { code: watchEndCode(error.code), message: redactWords(error.message) };
		ended = { why: "lost", error: given };
		options.signal?.removeEventListener("abort", onAbort);
		stop.abort();
		void release();
		try {
			handlers.ended(given);
		} catch {
			// The handler's own failure is the viewer's; the watch is over either way.
		}
	};
	const params = {
		...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
		...(options.quality === undefined ? {} : { quality: options.quality }),
	};

	const run = async () => {
		let after = 0;
		while (!ended) {
			const asked = await client.call("screen.watch", { after, ...params }, { signal: stop.signal });
			if (ended) return;
			if (!asked.ok) return lost(asked.error);
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
				if (!read.ok) return lost(read.error);
				const part = Buffer.from(read.value.data, "base64");
				if (part.length === 0 && !read.value.eof) return lost({ code: "invalid", message: `screen.read of frame ${answer.seq} at ${size} gave no bytes and no eof` });
				parts.push(part);
				size += part.length;
				eof = read.value.eof;
			}
			after = answer.seq;
			let acked!: () => void;
			const ackedOnce = new Promise<void>((resolve) => (acked = resolve));
			const frame: ScreenFrame = {
				seq: answer.seq,
				format: answer.format ?? "jpeg",
				bytes: Buffer.concat(parts),
				width: answer.width,
				height: answer.height,
				frameWidth: answer.frameWidth ?? answer.width,
				frameHeight: answer.frameHeight ?? answer.height,
				...(answer.cursor ? { cursor: [answer.cursor[0], answer.cursor[1]] as [number, number] } : {}),
			};
			try {
				handlers.frame(frame, () => acked());
			} catch {
				// A handler that throws drops the frame: the next is asked for at once.
				acked();
			}
			await Promise.race([ackedOnce, stopped]);
		}
	};
	void run().catch((error: unknown) => lost({ code: "unreachable", message: error instanceof Error ? error.message : String(error) }));

	return {
		async input(actions, { signal } = {}) {
			if (ended?.why === "closed") return fail("gone", "the screen watch is closed: nothing more is sent to the computer");
			if (ended?.why === "aborted") return fail("aborted", "the screen watch was aborted: nothing more is sent to the computer");
			if (ended?.why === "lost") return fail(ended.error.code, `the screen watch ended: ${ended.error.message}`);
			const either = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
			const done = await client.call("input.actions", { actions }, { signal: either });
			return done.ok ? done : fail(done.error.code, redactWords(done.error.message));
		},
		async close() {
			end("closed");
			await release();
		},
	};
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

/** The key event's input actions, the same for every kind: a printable key's down types nothing (its char does). */
function keyActions(event: Extract<ViewerEvent, { type: "key" }>): Result<InputAction[]> {
	if (event.action === "up") return ok([]);
	if (event.action === "char") {
		const text = event.text ?? event.key;
		return ok(text === "" ? [] : [{ type: "type", text }]);
	}
	if (MODIFIER_KEYS.has(event.key)) return ok([]);
	const named = KEY_NAMES[event.key];
	const printable = /^[\x21-\x7e]$/.test(event.key);
	const combo = comboOf(event.modifiers ?? 0);
	const held = combo.filter((k) => k !== "shift");
	if (named === undefined && !printable) return fail("invalid", `${event.key} is not a key this computer takes`);
	// A printable character with no ctrl, alt or super held is typed by its char event, which carries the layout's text.
	if (named === undefined && held.length === 0) return ok([]);
	const key = named ?? event.key.toLowerCase();
	return ok([{ type: "key", keys: [...(named === undefined ? held : combo), key] } as InputAction]);
}

/**
 * The viewer's event as input actions for a computer of this kind, in the screen's upright pixels: the space the
 * frames' width and height give. Points are rounded to whole pixels. What a kind cannot take is refused in words.
 */
export function toAction(event: ViewerEvent, kind: "desktop" | "android" | "ios"): Result<InputAction[]> {
	if (event.type === "key") return keyActions(event);
	if (kind === "desktop") {
		switch (event.type) {
			case "mouse": {
				const at = pointOf(event.x, event.y);
				if (!at) return fail("invalid", `${event.x},${event.y} is not a point on the screen`);
				if (event.action === "move") return ok([{ type: "move", at }]);
				const button = BUTTONS[event.button];
				if (!button) return fail("invalid", `mouse button ${event.button} is not left (0), middle (1) or right (2)`);
				return ok([{ type: "move", at }, { type: event.action, button }]);
			}
			case "wheel": {
				const at = pointOf(event.x, event.y);
				if (!at || !Number.isFinite(event.dx) || !Number.isFinite(event.dy)) return fail("invalid", `the wheel at ${event.x},${event.y} by ${event.dx},${event.dy} is not a point and a delta`);
				// A wheel notch is about 120 pixels of delta; X scrolls by clicks, so any movement is one click at least.
				const clicks = (d: number) => (d === 0 ? 0 : Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / 120)));
				return ok([{ type: "scroll", at, dx: clicks(event.dx), dy: clicks(event.dy), unit: "clicks" }]);
			}
			default:
				return fail("unsupported", `a desktop takes the mouse, the wheel and keys, not a ${event.type}`);
		}
	}
	switch (event.type) {
		case "tap": {
			const at = pointOf(event.x, event.y);
			return at ? ok([{ type: "tap", at }]) : fail("invalid", `${event.x},${event.y} is not a point on the screen`);
		}
		case "swipe": {
			const from = pointOf(event.x1, event.y1);
			const to = pointOf(event.x2, event.y2);
			if (!from || !to) return fail("invalid", `a swipe from ${event.x1},${event.y1} to ${event.x2},${event.y2} is not two points on the screen`);
			const ms = Number.isFinite(event.ms) && event.ms >= 0 ? Math.round(event.ms) : 300;
			return ok([{ type: "swipe", path: [from, to], ms }]);
		}
		case "button":
			return ok([{ type: "button", name: event.name === "recents" ? "app_switch" : event.name }]);
		default:
			return fail("unsupported", `a phone takes taps, swipes, its buttons and keys, not the ${event.type}`);
	}
}
