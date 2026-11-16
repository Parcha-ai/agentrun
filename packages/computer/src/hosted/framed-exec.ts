// exec for a vendor whose process comes in pieces: a call that starts it, a stream of its events, a call per write to
// its stdin, and, where the vendor has them, a call that ends its stdin and one that kills it. framedExec turns those
// pieces into the MachineProcess the adapter reads (../host.ts, exec), so a vendor writes only its own calls. It owns
// the rest: the writes go one call after another, in order, each answered before the next starts; output becomes
// bytes; and a vendor with no kill gets one by pid. PROVIDERS.md, "Exec shapes that work", has a worked example.
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
	 * Ends the process's stdin. Leave it out where the vendor has no end of file: end() then does nothing, and nothing the
	 * adapter runs waits for one (its upload reads a length; its bridge ends by kill).
	 */
	end?(handle: P): Promise<void>;
	/**
	 * Ends the process in the machine. Leave it out where the vendor has none: the process then starts under a sh that
	 * writes its pid on stderr first (framedExec reads that line and passes on the rest), and kill() starts
	 * `kill -KILL <pid>`.
	 */
	kill?(handle: P): Promise<void>;
}

/** The sh a process starts under when the vendor has no kill: its pid on stderr, one line, then the command in its place. */
const PID_WRAPPER = ["sh", "-c", 'echo "$$" >&2; exec "$@"', "sh"];

const push = (stream: PassThrough, bytes: Uint8Array) => void (stream.writableEnded || stream.write(bytes));

/** argv started through a vendor's pieces, as the MachineProcess exec answers. */
export async function framedExec<P>(pieces: ExecPieces<P>, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
	const byPid = pieces.kill === undefined;
	const handle = await pieces.start(byPid ? [...PID_WRAPPER, ...argv] : argv, ctx);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let ended = false;
	// With no vendor kill, stderr's first line is the pid: held until it ends, then the rest is the process's own.
	let pidLine: Buffer | undefined = byPid ? Buffer.alloc(0) : undefined;
	let gotPid: (pid: string | undefined) => void = () => {};
	const pid = new Promise<string | undefined>((done) => (gotPid = done));
	const toStderr = (bytes: Buffer) => {
		if (pidLine === undefined) return push(stderr, bytes);
		pidLine = Buffer.concat([pidLine, bytes]);
		const at = pidLine.indexOf(0x0a);
		if (at < 0) return;
		gotPid(pidLine.subarray(0, at).toString("latin1").trim());
		const rest = pidLine.subarray(at + 1);
		pidLine = undefined;
		if (rest.length > 0) push(stderr, rest);
	};
	const exited = (async () => {
		let code = -1;
		try {
			for await (const event of pieces.events(handle)) {
				if ("exit" in event) {
					code = event.exit;
					break;
				}
				const bytes = "text" in event ? Buffer.from(event.text, "utf8") : Buffer.from(event.base64, "base64");
				if (event.stream === "stdout") push(stdout, bytes);
				else toStderr(bytes);
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
	const decoder = new TextDecoder();
	let queue: Promise<void> = Promise.resolve();
	const send = (text: string) => {
		if (ended) return Promise.reject(new Error("the process has ended"));
		const sent = queue.then(() => (text === "" ? undefined : pieces.write(handle, text)));
		sent.catch(() => {});
		queue = sent;
		return sent;
	};
	/** The pid, once stderr's first line gives it; undefined once the process ended, or past ctx's bound. */
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
			try {
				if (pieces.kill) await pieces.kill(handle);
				else {
					const target = await pidWithin();
					if (target !== undefined && /^[1-9][0-9]*$/.test(target) && !ended) {
						const killer = await pieces.start(["kill", "-KILL", target], { timeoutMs: ctx.timeoutMs });
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
