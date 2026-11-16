// exec for a vendor whose process comes in pieces: a call that starts it, a stream of its events, a call per write to
// its stdin, and, where the vendor has them, a call that ends its stdin and one that kills it. framedExec turns those
// pieces into the MachineProcess the adapter reads (../host.ts, exec), so a vendor writes only its own calls. It owns
// the rest: the writes go one call after another, in order, each answered before the next starts; output becomes
// bytes, its events read no faster than the caller reads it; and a vendor with no kill gets one by pid. PROVIDERS.md, "Exec shapes that work", has a worked example.
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type { HostCall, MachineProcess } from "../host.js";
import { PID_WRAPPER, pidKill, pidLine } from "./scripts.js";

/** One event of a process: output on stdout or stderr, as text or as the base64 of its bytes; or its exit code. */
export type FramedEvent = { stream: "stdout" | "stderr"; text: string } | { stream: "stdout" | "stderr"; base64: string } | { exit: number };

/** A vendor's exec, as calls about one process: P is what start answers, the vendor's own handle on it (an id). */
export interface ExecPieces<P> {
	/** Starts argv in the machine as root, within ctx, and answers once it has started. */
	start(argv: readonly string[], ctx: HostCall): Promise<P>;
	/**
	 * The process's events from its start, in order; an end with no exit event is an exit the vendor never read (-1),
	 * and one that throws fails wait() with its error. framedExec stops reading at the exit event, which returns the
	 * iterator: a generator's finally lets go of what it holds.
	 */
	events(handle: P): AsyncIterable<FramedEvent>;
	/** One call that hands text to the process's stdin, answered once the vendor took it. */
	write(handle: P, text: string): Promise<void>;
	/**
	 * Ends the process's stdin. Leave it out where the vendor has no end of file: end() then does nothing. The cost: a
	 * command that reads stdin to its end (cat, a sh reading its script) never ends, and only kill() stops it. Nothing
	 * the adapter runs does (its upload reads a length, a root command's input is one line, its bridge ends by kill).
	 */
	end?(handle: P): Promise<void>;
	/**
	 * Ends the process in the machine. Leave it out where the vendor has none: the process then starts under
	 * PID_WRAPPER (./scripts.ts), which writes its pid and its start time on stderr first (framedExec takes that line off),
	 * and kill() starts pidKill, which kills that pid, and every process under it, only while that pid has that start time.
	 */
	kill?(handle: P): Promise<void>;
}

/** argv started through a vendor's pieces, as the MachineProcess exec answers. */
export async function framedExec<P>(pieces: ExecPieces<P>, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
	// With no vendor kill, stderr's first line is the pid and its start time (./scripts.ts, PID_WRAPPER): taken off, and
	// the rest is the process's own.
	const line = pieces.kill === undefined ? pidLine() : undefined;
	const handle = await pieces.start(line ? [...PID_WRAPPER, ...argv] : argv, ctx);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	// ended: the events stopped, so output and writes are done with. exitRead: the process's own exit came among them; a
	// stream that broke without one leaves a process that may still run, which kill() still ends by its pid.
	let ended = false;
	let exitRead = false;
	const killed = new AbortController();
	/**
	 * Output on: while its reader is behind (the stream's buffer full), the events wait, until it drains or kill(). A
	 * reader that let go (a stream destroyed) drops the rest, so the exit still comes.
	 */
	const push = async (stream: PassThrough, bytes: Uint8Array) => {
		if (stream.writableEnded || stream.destroyed || stream.write(bytes)) return;
		// One signal for both waits, aborted after: the one that lost leaves no listener behind.
		const waited = new AbortController();
		const signal = AbortSignal.any([killed.signal, waited.signal]);
		await Promise.race([once(stream, "drain", { signal }), once(stream, "close", { signal })]).catch(() => {});
		waited.abort();
	};
	const toStderr = async (bytes: Buffer) => {
		const own = line ? line.take(bytes) : bytes;
		if (own.length > 0) await push(stderr, own);
	};
	const exited = (async () => {
		let code = -1;
		let broke: unknown;
		try {
			for await (const event of pieces.events(handle)) {
				if ("exit" in event) {
					code = event.exit;
					exitRead = true;
					break;
				}
				const bytes = "text" in event ? Buffer.from(event.text, "utf8") : Buffer.from(event.base64, "base64");
				if (event.stream === "stdout") await push(stdout, bytes);
				else await toStderr(bytes);
			}
		} catch (error) {
			// A stream that broke: no exit code was read, and wait() fails in its words.
			broke = error;
		}
		ended = true;
		line?.end();
		stdout.end();
		stderr.end();
		if (broke !== undefined) throw broke;
		return code;
	})();
	// Nobody may wait (the bridge ends by kill): a broken stream is then no unhandled rejection.
	exited.catch(() => {});
	// The writes as one queue: each call starts once the one before it answered, and one that failed fails every one after.
	// ignoreBOM: a U+FEFF that starts stdin is text like any other, never a mark to drop.
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let queue: Promise<void> = Promise.resolve();
	const send = (text: string) => {
		if (ended) return Promise.reject(new Error("the process has ended"));
		const sent = queue.then(() => (text === "" ? undefined : pieces.write(handle, text)));
		sent.catch(() => {});
		queue = sent;
		return sent;
	};
	return {
		stdout,
		stderr,
		write: (bytes) => send(decoder.decode(bytes, { stream: true })),
		end: async () => {
			// A process that has ended, as one that read all it wanted can before its end (the upload), has no stdin to end.
			if (ended) return;
			await send(decoder.decode());
			await pieces.end?.(handle);
		},
		wait: () => exited,
		kill: async () => {
			killed.abort();
			try {
				if (pieces.kill) await pieces.kill(handle);
				else if (line) {
					// Not once its exit was read; and after a stream that broke, only while the pid still has its start time: by
					// then the pid may be another process's.
					const target = await line.pid(ctx.timeoutMs);
					if (target !== undefined && !exitRead) {
						const killer = await pieces.start(pidKill(target), { timeoutMs: ctx.timeoutMs });
						for await (const event of pieces.events(killer)) if ("exit" in event) break;
					}
				}
			} catch {
				// Best effort: kill never throws.
			}
			stdout.end();
			stderr.end();
		},
	};
}
