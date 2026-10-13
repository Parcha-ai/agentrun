import { StringDecoder } from "node:string_decoder";
import type { BoxProcess } from "../box/box.ts";

/** The version of the frames a host and a runner speak. Both say it first; a mismatch ends the link. */
export const LINK_VERSION = 1;

/** One frame as it travels: a JSON object with its type in `t`. The fields of each type are in `host.ts`. */
export type Frame = { readonly t: string } & Readonly<Record<string, unknown>>;

/**
 * Both ends of a host and a runner: one JSON object per line. `JSON.stringify` never writes a raw newline, so a frame
 * is a line. A frame is sent whole or not at all; the far end reads them in order.
 *
 * Invariant: once `closed` is true no frame is delivered in either direction, and `onClose` handlers ran once.
 */
export interface Link {
	/** Send one frame. False when the link is closed: the frame was not sent. */
	send(frame: Frame): boolean;
	/** Called with each frame that arrives, in order. */
	onFrame(handler: (frame: Frame) => void): void;
	/** Called once, when the link closes from either side, with why. */
	onClose(handler: (reason: string) => void): void;
	readonly closed: boolean;
	close(reason: string): void;
}

/**
 * The common part of every link: frames from lines, handlers, and one close. `write` sends lines on; it returns false
 * when the far end is gone.
 */
class LineLink implements Link {
	readonly #frameHandlers: ((frame: Frame) => void)[] = [];
	readonly #closeHandlers: ((reason: string) => void)[] = [];
	readonly #write: (lines: string) => boolean;
	readonly #stop: () => void;
	#buffer = "";
	#closed = false;

	constructor(write: (lines: string) => boolean, stop: () => void) {
		this.#write = write;
		this.#stop = stop;
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(frame: Frame): boolean {
		if (this.#closed) return false;
		return this.#write(`${JSON.stringify(frame)}\n`);
	}

	onFrame(handler: (frame: Frame) => void): void {
		this.#frameHandlers.push(handler);
	}

	onClose(handler: (reason: string) => void): void {
		this.#closeHandlers.push(handler);
	}

	close(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#stop();
		for (const handler of this.#closeHandlers) handler(reason);
	}

	/** Text that arrived. A line may come in pieces and several may come at once. */
	receive(text: string): void {
		if (this.#closed) return;
		this.#buffer += text;
		for (let at = this.#buffer.indexOf("\n"); at >= 0 && !this.#closed; at = this.#buffer.indexOf("\n")) {
			const line = this.#buffer.slice(0, at);
			this.#buffer = this.#buffer.slice(at + 1);
			if (line.trim() === "") continue;
			let frame: unknown;
			try {
				frame = JSON.parse(line);
			} catch {
				this.close(`a line that is not JSON arrived: ${line.slice(0, 80)}`);
				return;
			}
			if (typeof frame !== "object" || frame === null || typeof (frame as { t?: unknown }).t !== "string") {
				this.close(`a frame with no type arrived: ${line.slice(0, 80)}`);
				return;
			}
			for (const handler of this.#frameHandlers) handler(frame as Frame);
		}
	}
}

/** Two links joined in this process, for a home that runs beside its host and for tests. */
export function linkPair(): readonly [Link, Link] {
	const deliver = (to: () => LineLink) => (lines: string) => {
		// Delivered on a later turn, as bytes through a pipe would be, so a handler never runs inside a send.
		queueMicrotask(() => to().receive(lines));
		return true;
	};
	const left: LineLink = new LineLink(
		deliver(() => right),
		() => queueMicrotask(() => right.close("the other end closed")),
	);
	const right: LineLink = new LineLink(
		deliver(() => left),
		() => queueMicrotask(() => left.close("the other end closed")),
	);
	return [left, right];
}

/** The runner's end over a pair of Node streams: its own stdin and stdout, or a socket. */
export function streamLink(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Link {
	const decoder = new StringDecoder("utf8");
	let open = true;
	const link = new LineLink(
		(lines) => {
			if (!open) return false;
			output.write(lines);
			return true;
		},
		() => {
			open = false;
			input.removeListener("data", onData);
		},
	);
	const onData = (chunk: Buffer | string) => link.receive(typeof chunk === "string" ? chunk : decoder.write(chunk));
	input.on("data", onData);
	input.once("end", () => link.close("the input ended"));
	input.once("error", (error: Error) => link.close(`the input failed: ${error.message}`));
	output.once("error", (error: Error) => link.close(`the output failed: ${error.message}`));
	return link;
}

/**
 * The host's end over a program it started in a box with `Box.exec`: frames go in on its input and come out on its
 * output.
 *
 * Writes are coalesced: one write is in flight at a time, and every frame sent meanwhile goes in the next one. A box
 * whose input is a buffered call of 100 ms or more (Daytona's) then carries a streamed model answer at the pace it is
 * made, not one call for each frame. The link closes when the program's output ends or a write fails.
 */
export function processLink(process: BoxProcess): Link {
	const encoder = new TextEncoder();
	let queued = "";
	let writing = false;
	let open = true;
	const flush = async (): Promise<void> => {
		if (writing) return;
		writing = true;
		try {
			while (open && queued !== "") {
				const lines = queued;
				queued = "";
				await process.stdin.write(encoder.encode(lines));
			}
		} catch (cause) {
			link.close(`could not write to the runner: ${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			writing = false;
		}
	};
	const link = new LineLink(
		(lines) => {
			if (!open) return false;
			queued += lines;
			void flush();
			return true;
		},
		() => {
			open = false;
			void process.stdin.close().catch(() => {});
		},
	);
	void (async () => {
		const decoder = new StringDecoder("utf8");
		try {
			for await (const chunk of process.stdout) link.receive(decoder.write(Buffer.from(chunk)));
			link.close("the runner's output ended");
		} catch (cause) {
			link.close(`the runner's output failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	})();
	return link;
}
