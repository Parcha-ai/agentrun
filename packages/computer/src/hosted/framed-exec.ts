// exec for a vendor whose process comes in pieces: a call that starts it, a stream of its events, a call per write to
// its stdin, and, where the vendor has them, a call that ends its stdin and one that kills it. framedExec turns those
// pieces into the MachineProcess the adapter reads (../host.ts, exec), so a vendor writes only its own calls. It owns
// the rest: the writes go one call after another, in order, each answered before the next starts; output becomes
// bytes, its events read no faster than the caller reads it; and a vendor with no kill gets one by pid. PROVIDERS.md, "Exec shapes that work", has a worked example.
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type { HostCall, MachineProcess } from "../host.js";

/** One event of a process: output on stdout or stderr, as text or as the base64 of its bytes; or its exit code. */
export type FramedEvent = { stream: "stdout" | "stderr"; text: string } | { stream: "stdout" | "stderr"; base64: string } | { exit: number };

/** A vendor's exec, as calls about one process: P is what start answers, the vendor's own handle on it (an id). */
export interface ExecPieces<P> {
	/** Starts argv in the machine as root, within ctx, and answers once it has started. */
	start(argv: readonly string[], ctx: HostCall): Promise<P>;
	/** The process's events from its start, in order; an end with no exit event is an exit the vendor never read (-1). */
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
	 * Ends the process in the machine. Leave it out where the vendor has none: the process then starts under a sh that
	 * writes its pid and its start time on stderr first (framedExec reads that line and passes on the rest), and kill()
	 * starts a sh that sends `kill -KILL <pid>` only while that pid still has that start time.
	 */
	kill?(handle: P): Promise<void>;
}

/**
 * The sh a process starts under when the vendor has no kill: one line on stderr, its pid and its start time (field 22
 * of /proc/<pid>/stat, counted past the command's name in parentheses, which may hold spaces), then the command in its
 * place, which keeps both.
 */
export const PID_WRAPPER = ["sh", "-c", 'echo "$$ $(s=$(cat /proc/$$/stat) && set -- ${s##*") "} && echo "${20}")" >&2; exec "$@"', "sh"];

/** The sh kill() starts, given the pid and start time: a pid whose process has ended, and may be another's now, is let be. */
export const PID_KILL = 's=$(cat "/proc/$1/stat" 2>/dev/null) || exit 0; pid=$1 start=$2; set -- ${s##*") "}; [ "${20}" = "$start" ] && kill -KILL "$pid"; exit 0';

/** argv started through a vendor's pieces, as the MachineProcess exec answers. */
export async function framedExec<P>(pieces: ExecPieces<P>, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
	const byPid = pieces.kill === undefined;
	const handle = await pieces.start(byPid ? [...PID_WRAPPER, ...argv] : argv, ctx);
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
	// With no vendor kill, stderr's first line is the pid and its start time: held until it ends, then the rest is the
	// process's own.
	let pidLine: Buffer | undefined = byPid ? Buffer.alloc(0) : undefined;
	let gotPid: (pid: string | undefined) => void = () => {};
	const pid = new Promise<string | undefined>((done) => (gotPid = done));
	const toStderr = async (bytes: Buffer) => {
		if (pidLine === undefined) return push(stderr, bytes);
		pidLine = Buffer.concat([pidLine, bytes]);
		const at = pidLine.indexOf(0x0a);
		if (at < 0) return;
		gotPid(pidLine.subarray(0, at).toString("latin1").trim());
		const rest = pidLine.subarray(at + 1);
		pidLine = undefined;
		if (rest.length > 0) await push(stderr, rest);
	};
	const exited = (async () => {
		let code = -1;
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
		} catch {
			// A stream that broke: no exit code was read.
		}
		ended = true;
		gotPid(undefined);
		stdout.end();
		stderr.end();
		return code;
	})();
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
	/** "<pid> <start time>", once stderr's first line gives it; undefined once the process ended, or past ctx's bound. */
	const pidWithin = async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), ctx.timeoutMs)));
		try {
			return await Promise.race([pid, late]);
		} finally {
			clearTimeout(timer);
		}
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
				else {
					// Not once its exit was read; and after a stream that broke, only while the pid still has its start time: by
					// then the pid may be another process's.
					const target = /^([1-9][0-9]*) ([0-9]+)$/.exec((await pidWithin()) ?? "");
					if (target !== null && !exitRead) {
						const killer = await pieces.start(["sh", "-c", PID_KILL, "sh", target[1] as string, target[2] as string], { timeoutMs: ctx.timeoutMs });
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

/** The JSON value of each line of a body of newline-delimited JSON, as the lines come; a line that is not JSON throws. */
export async function* ndjson(body: AsyncIterable<Uint8Array>): AsyncIterable<unknown> {
	const decoder = new TextDecoder();
	let rest = "";
	for await (const chunk of body) {
		rest += decoder.decode(chunk, { stream: true });
		let at = rest.indexOf("\n");
		while (at >= 0) {
			const line = rest.slice(0, at).trim();
			rest = rest.slice(at + 1);
			if (line !== "") yield JSON.parse(line);
			at = rest.indexOf("\n");
		}
	}
	rest += decoder.decode();
	if (rest.trim() !== "") yield JSON.parse(rest);
}
