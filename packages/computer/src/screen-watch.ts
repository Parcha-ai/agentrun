// The live view's seam for the runner's viewer: a computer's screen as frames, and its input, on one connection. The
// frames are pull-paced, as CDP screencast is: screen.watch asks for the frame after the last one given, and the next
// ask is made only when the viewer calls next() again, so each next() is the ack of the frame it drew. act() sends the
// viewer's events, already mapped to input actions, as input.actions. close() and the caller's signal end both: the
// waiting ask is cancelled, the frames end, and act() refuses in words.
//
// Every computer that answers screen.watch has a live view through this: computerd's desktops (frames as JPEG) and a
// phone client that answers it itself (frames as PNG). No error it gives holds a URL or a secret: the words are
// redacted whatever the connection said.
import type { ComputerConnection } from "./provider.js";
import type { InputAction, InputActionsResult } from "./protocol.js";
import { type ComputerErrorCode, fail, type Result } from "./result.js";

/** One whole frame of the screen. */
export interface ScreenFrame {
	/** Rises with each frame of a watch. */
	seq: number;
	format: "jpeg" | "png";
	bytes: Uint8Array;
	/** The frame's pixels. */
	frameWidth: number;
	frameHeight: number;
	/** The screen's pixels: the space every input action's coordinates are in. */
	width: number;
	height: number;
	cursor?: [number, number];
}

export interface ScreenWatch {
	/** Pull-paced: each next() is the ack for the frame before it (the viewer calls next() once it has drawn a frame). */
	frames: AsyncIterable<ScreenFrame>;
	/** The viewer's mapped events, on the same connection; per-call errors in words, never a URL or a secret. */
	act(actions: InputAction[], options?: { signal?: AbortSignal }): Promise<Result<InputActionsResult>>;
	/** Ends the frames and refuses further acts; the signal passed to watchScreen does the same. */
	close(): Promise<void>;
}

export interface ScreenWatchOptions {
	/** Ends the watch as close() does. */
	signal?: AbortSignal;
	/** The frame's width at most; the daemon's default when absent. */
	maxWidth?: number;
	/** JPEG quality, 1 to 100; the daemon's default when absent. */
	quality?: number;
}

/** A watch's frames that failed: the code, and words with no URL or secret. */
export class ScreenWatchError extends Error {
	constructor(
		readonly code: ComputerErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ScreenWatchError";
	}
}

/** Words with no URL and no secret: a URL of any scheme, a secret-named parameter and a key-shaped token are taken out. */
export function redactWords(words: string): string {
	return words
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[a URL]")
		.replace(/\b(?:token|password|passwd|secret|key|jwt|auth|code|signingKey)=[^\s&"';,]+/gi, "[a secret]")
		.replace(/\b(?:sk|pk|pck|ph|tok|pw|jwt)_[A-Za-z0-9_-]{6,}/g, "[a secret]");
}

/** The screen of the computer on `connection`, as frames and an input sink (see the top of this file). */
export function watchScreen(connection: ComputerConnection, options: ScreenWatchOptions = {}): ScreenWatch {
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
			if (!answer.changed) continue;
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
