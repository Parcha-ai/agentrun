// exec for a vendor whose process comes in pieces: a call that starts it, a stream of its events, a call per write to
// its stdin, and, where the vendor has them, a call that ends its stdin and one that kills it. framedExec turns those
// pieces into the MachineProcess the adapter reads (../host.ts, exec), so a vendor writes only its own calls. It owns
// the rest: the writes go one call after another, in order, each answered before the next starts; output becomes
// bytes, its events read no faster than the caller reads it; and a vendor with no kill gets one by pid. A vendor with no
// call that writes to stdin gets one from fifoStdin. PROVIDERS.md, "Exec shapes that work", has worked examples.
import { randomBytes } from "node:crypto";
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
	 * starts a sh that kills that pid, and every process under it, only while that pid still has that start time.
	 */
	kill?(handle: P): Promise<void>;
}

/**
 * The sh a process starts under when the vendor has no kill: one line on stderr, its pid and its start time (field 22
 * of /proc/<pid>/stat, counted past the command's name in parentheses, which may hold spaces), then the command in its
 * place, which keeps both.
 */
export const PID_WRAPPER = ["sh", "-c", 'echo "$$ $(s=$(cat /proc/$$/stat) && set -- ${s##*") "} && echo "${20}")" >&2; exec "$@"', "sh"];

/**
 * The sh kill() starts, given the pid and start time: a pid whose process has ended, and may be another's now, is let
 * be. Otherwise it kills the process and every process under it (an upload's head and base64 would wait on the open
 * stdin, and hold stderr open, past their sh): each is stopped as it is found, so none forks away, by its parent pid
 * (field 4 of its stat) until a pass over /proc finds no more, and then all are killed.
 */
export const PID_KILL = [
	"pid=$1 start=$2",
	'read -r s 2>/dev/null <"/proc/$pid/stat" || exit 0',
	'set -- ${s##*") "}',
	'[ "${20}" = "$start" ] || exit 0',
	'kill -STOP "$pid" 2>/dev/null',
	'all=" $pid " new=$pid',
	'while [ -n "$new" ]; do',
	"\tnew=",
	"\tfor f in /proc/[0-9]*/stat; do",
	'\t\tread -r s 2>/dev/null <"$f" || continue',
	"\t\tp=${s%% *}",
	'\t\tset -- ${s##*") "}',
	'\t\tcase "$all" in *" $p "*) continue ;; esac',
	'\t\tcase "$all" in *" $2 "*) all="$all$p " new="$new $p"; kill -STOP "$p" 2>/dev/null ;; esac',
	"\tdone",
	"done",
	"kill -KILL $all 2>/dev/null",
	"exit 0",
].join("\n");

/**
 * The sh a process starts under when the vendor has no call that writes to its stdin, given a fifo's path and argv: it
 * makes the fifo, holds it open both ways (so no write's end is an end of file), and feeds the process what comes into
 * it, a length line and that many bytes at a time, until a line "e", which ends the process's stdin.
 */
export const FIFO_STDIN = [
	'f=$1; shift',
	'mkfifo "$f" 2>/dev/null; mkfifo "$f.0" && [ -p "$f" ] || exit 1',
	'exec 3<>"$f"',
	'{ while read -r n <&3 && [ "$n" != e ]; do head -c "$n" <&3; done >"$f.0"; } &',
	'"$@" <"$f.0" 3<&-',
	'c=$?',
	'printf "e\\n" >&3',
	'rm -f "$f" "$f.0"',
	'exit $c',
].join("\n");

/** The short exec that hands the fifo one piece, given its path, its length line and its text; it waits for the fifo's start. */
export const FIFO_WRITE = 'i=0; until [ -p "$1" ]; do i=$((i+1)); [ $i -le 100 ] || exit 1; sleep 0.1; done; printf "%s\\n%s" "$2" "$3" >"$1"';

/** The most UTF-8 bytes one write's exec carries in its argv, well under Linux's 128 KiB for one word. */
const FIFO_PIECE = 64 * 1024;

/**
 * Pieces for a vendor that starts a process and streams its events but has no call that writes to its stdin: the
 * process starts under FIFO_STDIN, and each write is a second, short exec of FIFO_WRITE, one after another, as text.
 * end() is one more, of the line "e". There is no kill: framedExec kills by pid.
 */
export function fifoStdin<P>(pieces: Pick<ExecPieces<P>, "start" | "events">): ExecPieces<{ handle: P; path: string; ctx: HostCall }> {
	const run = async (path: string, head: string, text: string, ctx: HostCall) => {
		const handle = await pieces.start(["sh", "-c", FIFO_WRITE, "sh", path, head, text], ctx);
		let code = -1;
		let said = "";
		for await (const event of pieces.events(handle)) {
			if ("exit" in event) code = event.exit;
			else if (event.stream === "stderr") said += "text" in event ? event.text : Buffer.from(event.base64, "base64").toString("utf8");
		}
		if (code !== 0) throw new Error(`the write to the process's stdin exited ${code}${said === "" ? "" : `: ${said.trim().slice(0, 200)}`}`);
	};
	return {
		async start(argv, ctx) {
			const path = `/tmp/agentrun-stdin-${randomBytes(8).toString("hex")}`;
			return { handle: await pieces.start(["sh", "-c", FIFO_STDIN, "sh", path, ...argv], ctx), path, ctx };
		},
		events: ({ handle }) => pieces.events(handle),
		async write({ path, ctx }, text) {
			const bytes = Buffer.from(text, "utf8");
			for (let at = 0, end = 0; at < bytes.length; at = end) {
				end = Math.min(at + FIFO_PIECE, bytes.length);
				while (end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end--;
				await run(path, String(end - at), bytes.subarray(at, end).toString("utf8"), ctx);
			}
		},
		end: ({ path, ctx }) => run(path, "e", "", ctx),
	};
}

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
