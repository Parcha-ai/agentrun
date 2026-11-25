// The exec pre-check: the one thing a new vendor proves before writing anything else of its host. AgentRun installs its
// daemon through MachineHost.exec and then talks to it over that one process's stdin and stdout for the computer's whole
// life, so exec must be a live, two-way stream that keeps UTF-8 text intact, with no timeout (the contract is exec's doc
// comment in ../host.ts). This runs exec alone, on a machine the vendor made by hand, and says in plain words what it
// did wrong:
//
//   pnpm --filter @parcha/agentrun-computer run conformance --provider <id | ./module.js> --exec-stream --machine <id> [--quick]
//
// It calls nothing but host.exec, so a host whose other members are still stubs can run it. Each check starts its own
// process and kills it when it is done with it, pass or fail. No check ends stdin: the adapter never needs a vendor's
// end of file, so one with none passes. After the checks, one more exec reads what the machine offers the rest of the
// host (root's network namespace, /dev/fuse, the arch, the kernel, the TCP listeners): facts, each with what it means
// for the provider, never a pass or a fail of exec.
import { createHash, randomBytes } from "node:crypto";
import type { MachineHost, MachineProcess } from "../host.js";
import { execOf, words } from "../hosted/process.js";

/** The checks, in the order they run. */
export const EXEC_STREAM_CHECKS = ["stdout-text", "stdin-text", "large", "stdout-live", "stdin-live", "stdout-unread", "stderr", "exit-code", "kill", "no-timeout"] as const;
export type ExecStreamCheckId = (typeof EXEC_STREAM_CHECKS)[number];

/** What the capability probe reads, in the order the report gives it. */
export const EXEC_STREAM_FACTS = ["root", "netns", "fuse", "arch", "kernel", "listeners"] as const;
export type ExecStreamFactId = (typeof EXEC_STREAM_FACTS)[number];

/** One thing the machine offers: what was read, and what it means for the provider. */
export interface ExecStreamFact {
	id: ExecStreamFactId;
	value: string;
	means: string;
}

export interface ExecStreamCheck {
	id: ExecStreamCheckId;
	status: "pass" | "fail";
	/** What passed, or what the vendor's exec did wrong, in words a person can act on. */
	words: string;
	ms: number;
}

export interface ExecStreamReport {
	host: string;
	machine: string;
	checks: ExecStreamCheck[];
	pass: boolean;
	/** What the capability probe read; empty when it could not run, with why in factsProblem. */
	facts: ExecStreamFact[];
	factsProblem?: string;
}

export interface ExecStreamOptions {
	/** How long the no-timeout check's process runs, silent, before it prints and exits; default 75 s. */
	longMs?: number;
	/** How long one step waits: exec's answer, bytes coming back, wait() after the end; default 30 s. */
	stepMs?: number;
	/** The large check's payload, in bytes of random UTF-8 text; default 8 MiB. */
	largeBytes?: number;
	/** How long the large check may take in all; default 180 s. */
	largeMs?: number;
	/** How long stdout-unread writes to stdin with stdout left unread, before it reads; default 10 s. */
	unreadMs?: number;
	signal?: AbortSignal;
	/** Told of each check as it ends. */
	onCheck?: (check: ExecStreamCheck) => void;
}

export const DEFAULT_LONG_MS = 75_000;
/** --quick's no-timeout check: long enough to cross a second, short enough for CI. */
export const QUICK_LONG_MS = 5_000;
const DEFAULT_STEP_MS = 30_000;
const DEFAULT_LARGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_LARGE_MS = 180_000;
const DEFAULT_UNREAD_MS = 10_000;
/** stdout-unread's writes: this many, of UNREAD_CHUNK bytes each, spread over unreadMs; 4 MiB, far past a 64 KiB window. */
const UNREAD_WRITES = 64;
const UNREAD_CHUNK = 64 * 1024;
/** What one write gives exec's stdin, as the adapter's own upload does (runToExit). */
const WRITE_CHUNK = 256 * 1024;
/** How long stdout-live watches, after "early", that stdout stays open and wait() has no answer. */
const LIVE_GRACE_MS = 1_000;

/**
 * kill's probe, `sh -c PID_STATE_SCRIPT sh <pid>`: "running" or "gone". A killed process its parent has not reaped yet
 * is a zombie, which kill -0 still finds; it has ended, so its /proc state (Z, or X) reads gone, and any other state
 * running. Its state is read first, in one read, so a reap during the probe never reads as running; where there is no
 * state to read (no /proc, a status hidden, or the process already gone), kill -0 answers.
 */
export const PID_STATE_SCRIPT =
	'st=$(sed -n "s/^State:[[:space:]]*\\([A-Z]\\).*/\\1/p" "/proc/$1/status" 2>/dev/null); case "$st" in Z|X) echo gone ;; ?) echo running ;; *) if kill -0 "$1" 2>/dev/null; then echo running; else echo gone; fi ;; esac';

/** A failed check: its words are the report's. */
class Problem extends Error {}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const secondsOf = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const shown = (argv: readonly string[]) => argv.map((word) => (/^[\w./=:-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(" ");
const range = (from: number, to: number) => String.fromCodePoint(...Array.from({ length: to - from + 1 }, (_, i) => from + i));

/**
 * A BOM first, which a TextDecoder drops from the start of a stream unless told to keep it (ignoreBOM). Then one of
 * each class of code point: all of ASCII but NUL (no text the adapter carries holds one: JSON escapes it), all of
 * Latin-1, the BMP's scripts and its odd ones (the line and paragraph separators, a BOM, U+FFFD), astral ones, and
 * combining marks and a joined emoji, which a normalizer would change. Then \r alone and \r\n, which a terminal changes.
 */
const CODE_POINTS = `\u{feff}${range(0x01, 0x7f)}${range(0x80, 0xff)}ĀſΩЖאعह中文日本語한국어€  ﻿�𝄞😀\u{10ffff}éä\u{1f469}‍\u{1f4bb}carriage\rreturn\r\nline`;
/** 16 KiB of text of every width (1, 2, 3 and 4 bytes a character), no newline: 64 of them are the 1 MiB line. */
const LONG_UNIT = "aé€𝄞";
const LONG_UNITS = 1638;
/** ASCII, so the script writes it as it is. */
const LONG_TAIL = "abcd";
const LONG_PIECE = `${LONG_UNIT.repeat(LONG_UNITS)}${LONG_TAIL}`;
const LONG_PIECES = 64;
/** What stdout-text and stdin-text carry: every class of code point, \r and \r\n, a line of 1 MiB, and a lone \n at the end. */
const TEXT = Buffer.from(`${CODE_POINTS}${LONG_PIECE.repeat(LONG_PIECES)}\n`, "utf8");
/**
 * length bytes of random UTF-8 text: characters of 1, 2, 3 and 4 bytes at random, any code point of each width but NUL
 * and the surrogates (which are no text).
 */
export function randomText(length: number): Buffer {
	const text = Buffer.alloc(length);
	const random = randomBytes(4 * length);
	let r = 0;
	const next = (bytes: number) => {
		let value = 0;
		for (let i = 0; i < bytes; i++) value = value * 256 + (random[r++] as number);
		return value;
	};
	for (let at = 0; at < length; ) {
		const width = Math.min(length - at, 1 + (next(1) & 3));
		if (width === 1) text[at] = 1 + (next(1) % 0x7f);
		else if (width === 2) text.write(String.fromCodePoint(0x80 + (next(2) % 0x780)), at, "utf8");
		else if (width === 3) {
			const point = 0x800 + (next(2) % 0xf000);
			text.write(String.fromCodePoint(point >= 0xd800 ? point + 0x800 : point), at, "utf8");
		} else text.write(String.fromCodePoint(0x10000 + (next(3) % 0x100000)), at, "utf8");
		at += width;
	}
	return text;
}

/** printf's format for text: each of its UTF-8 bytes as an octal escape, which dash, bash and busybox all read. */
const printfOf = (text: string) => [...Buffer.from(text, "utf8")].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("");

/** The code point of the character the byte at i is part of, as U+XXXX, and where that character starts. */
function characterAt(bytes: Uint8Array, i: number): { name: string; start: number } {
	let start = i;
	while (start > 0 && ((bytes[start] as number) & 0xc0) === 0x80) start--;
	const point = Buffer.from(bytes.subarray(start, start + 4)).toString("utf8").codePointAt(0) ?? 0;
	return { name: `U+${point.toString(16).toUpperCase().padStart(4, "0")}`, start };
}

/**
 * Why `got` is not `sent`, in words, or undefined when they are the same text. Both are UTF-8; `way` is where it went
 * ("on stdout"). The first character that differs is named, and the usual ways an exec changes text are named for what
 * they are.
 */
export function textProblem(sent: Uint8Array, got: Uint8Array, way: string): string | undefined {
	let i = 0;
	while (i < sent.length && i < got.length && sent[i] === got[i]) i++;
	if (i === sent.length && i === got.length) return undefined;
	if (i === got.length) return `only ${got.length} of ${sent.length} bytes of text came back ${way}. Pass every character on as it comes`;
	if (i === sent.length) return `${got.length - sent.length} bytes came back ${way} that were never sent, after all ${sent.length} that were (${hex(got.subarray(i, i + 8))}): your exec adds output of its own (a shell's login banner, a prompt). Pass only the process's own output`;
	const { name, start } = characterAt(sent, i);
	const was = got.subarray(start, start + 4);
	const said = `${name} (at byte ${start}) came back ${way} as ${hex(was)}`;
	const b = sent[start] as number;
	if (b === 0x0a && was[0] === 0x0d && was[1] === 0x0a) return `${said}: your exec turns \\n into \\r\\n, as a terminal does. Run the process on pipes, not a terminal`;
	if (b === 0x0d && was[0] === 0x0a) return `${said}: your exec turns \\r into \\n, as newline translation does. Pass every character on as it comes`;
	if (b === 0x0d) return `${said}: your exec drops \\r, as newline translation does. Pass every character on as it comes`;
	if (b >= 0x80 && was[0] === (0xc0 | (b >> 6)) && was[1] === (0x80 | (b & 0x3f))) {
		return `${said}: your exec reads UTF-8 as Latin-1 and writes it back as UTF-8 again. Read the process's output as UTF-8`;
	}
	if (name === "U+FEFF" && Buffer.from(got.subarray(start, start + 8)).equals(Buffer.from(sent.subarray(start + 3, start + 11)))) {
		return `${said}: your exec drops a U+FEFF that starts its text, as a TextDecoder does unless given ignoreBOM: true. Keep it: it is text like any other`;
	}
	if (was[0] === 0xef && was[1] === 0xbf && was[2] === 0xbd) {
		return `${said}: U+FFFD (ef bf bd), as a decoder makes of half a character: your exec decodes each piece of output as text on its own. Decode the stream as one (TextDecoder's stream: true)`;
	}
	return `${said}: your exec changes text (a terminal, a normalizer, an escape filter). Pass every character on as it comes, unchanged`;
}

/** One output stream of a process, read as it comes: its bytes so far, whether it ended, and a wait for more. */
class Reader {
	readonly #chunks: Buffer[] = [];
	length = 0;
	ended = false;
	error: unknown;
	#wake: Array<() => void> = [];

	/** Reads the stream as it comes; with `from`, not a byte until it settles: the stream is left unread until then. */
	constructor(stream: AsyncIterable<Uint8Array>, from?: Promise<void>) {
		void this.#pump(stream, from);
	}

	async #pump(stream: AsyncIterable<Uint8Array>, from?: Promise<void>) {
		await from;
		try {
			for await (const chunk of stream) {
				// A copy: a vendor's client may reuse its buffer.
				this.#chunks.push(Buffer.from(chunk));
				this.length += chunk.byteLength;
				this.#nudge();
			}
		} catch (error) {
			this.error = error;
		}
		this.ended = true;
		this.#nudge();
	}

	#nudge() {
		const waiting = this.#wake;
		this.#wake = [];
		for (const wake of waiting) wake();
	}

	bytes(): Buffer {
		return Buffer.concat(this.#chunks);
	}

	/** Waits until `enough` holds, the stream ends, or ms pass; answers whether `enough` holds. */
	async until(enough: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (!enough() && !this.ended && Date.now() < deadline && !signal?.aborted) {
			await new Promise<void>((done) => {
				const timer = setTimeout(done, Math.max(1, deadline - Date.now()));
				const finish = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", finish);
					done();
				};
				signal?.addEventListener("abort", finish, { once: true });
				this.#wake.push(finish);
			});
		}
		return enough();
	}

	/** Waits for the stream's end, at most ms; answers whether it ended. */
	end(ms: number, signal?: AbortSignal): Promise<boolean> {
		return this.until(() => this.ended, ms, signal);
	}
}

/** A process the pre-check started: the vendor's, its two streams read as they come. */
interface Run {
	proc: MachineProcess;
	out: Reader;
	err: Reader;
	/** wait()'s answer, once it gives one; a wait() that throws is a Problem in words. */
	exited: Promise<number>;
	exitCode?: number;
}

/** A promise's value (or its rejection), or `late` once ms pass or signal aborts. */
function within<T, L>(promise: Promise<T>, ms: number, late: L, signal?: AbortSignal): Promise<T | L> {
	return new Promise((settle, reject) => {
		const timer = setTimeout(() => finish(() => settle(late)), ms);
		const onAbort = () => finish(() => settle(late));
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		function finish(then: () => void) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			then();
		}
		promise.then(
			(value) => finish(() => settle(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

const LATE = Symbol("late");

/** Waits ms, or less when signal aborts. */
const pause = (ms: number, signal?: AbortSignal) => within(new Promise<never>(() => {}), Math.max(0, ms), undefined, signal);

/** The pre-check's run of host.exec on one machine. */
class Session {
	readonly #host: MachineHost;
	readonly #machine: string;
	readonly #stepMs: number;
	readonly #signal: AbortSignal | undefined;
	readonly #runs: Run[] = [];

	constructor(host: MachineHost, machine: string, stepMs: number, signal: AbortSignal | undefined) {
		this.#host = host;
		this.#machine = machine;
		this.#stepMs = stepMs;
		this.#signal = signal;
	}

	get stepMs() {
		return this.#stepMs;
	}

	get signal() {
		return this.#signal;
	}

	/**
	 * exec(argv), answered within the step's bound; any failure (a throw) is a Problem naming the command. Without stdin,
	 * end() is called at once, as the adapter does. With `readFrom`, stdout is left unread until it settles.
	 */
	async start(argv: readonly string[], stdin: boolean, readFrom?: Promise<void>): Promise<Run> {
		const what = `exec of ${shown(argv)}`;
		let answer: Promise<MachineProcess>;
		try {
			answer = Promise.resolve(execOf(this.#host)(this.#machine, argv, { timeoutMs: this.#stepMs, ...(this.#signal ? { signal: this.#signal } : {}) }));
		} catch (error) {
			throw new Problem(`${what} threw: ${words(error)}`);
		}
		let answered: MachineProcess | typeof LATE;
		try {
			answered = await within(answer, this.#stepMs + 5_000, LATE, this.#signal);
		} catch (error) {
			throw new Problem(`${what} failed: ${words(error)}`);
		}
		if (answered === LATE) {
			// One that answers after this gave up is killed as it lands.
			answer.then((late) => late?.kill?.()).catch(() => {});
			throw new Problem(`${what} did not answer within ${secondsOf(this.#stepMs)}: exec answers once the process has started, not when it ends`);
		}
		if (answered === undefined || answered === null || typeof answered !== "object") throw new Problem(`${what} answered ${String(answered)}, not a process: answer the MachineProcess or throw`);
		const proc = answered;
		const lacks = ["write", "end", "wait", "kill"].filter((name) => typeof (proc as unknown as Record<string, unknown>)?.[name] !== "function");
		if (proc?.stdout?.[Symbol.asyncIterator] === undefined) lacks.unshift("stdout");
		if (proc?.stderr?.[Symbol.asyncIterator] === undefined) lacks.unshift("stderr");
		if (lacks.length > 0) throw new Problem(`${what} answered a process that lacks ${lacks.join(", ")}: a MachineProcess (src/host.ts) has stdout, stderr, write, end, wait and kill`);
		const run: Run = { proc, out: new Reader(proc.stdout, readFrom), err: new Reader(proc.stderr), exited: Promise.resolve(0) };
		run.exited = Promise.resolve()
			.then(() => proc.wait())
			.then((code) => {
				run.exitCode = code;
				return code;
			});
		run.exited.catch(() => {});
		this.#runs.push(run);
		// Not awaited: a command that reads no input runs on whether or not the vendor answers the close.
		if (!stdin) Promise.resolve().then(() => proc.end()).catch(() => {});
		return run;
	}

	/**
	 * Writes UTF-8 text to the process's stdin, in pieces of at most WRITE_CHUNK bytes, each whole characters as the
	 * adapter's are, one after another; a refusal is a Problem. Each write is bounded by the step, and by `by` when the
	 * check has one deadline for all of its steps.
	 */
	async write(run: Run, bytes: Uint8Array, what: string, by?: Deadline): Promise<void> {
		for (let at = 0, end = 0; at < bytes.length; at = end) {
			end = Math.min(at + WRITE_CHUNK, bytes.length);
			while (end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end--;
			const piece = bytes.subarray(at, end);
			const ms = by ? by.left(this.#stepMs) : this.#stepMs;
			// Whether the deadline, not the step, set this bound. Asking by.passed() after the timeout is not enough: a
			// timer can fire a millisecond before Date.now() reads the deadline.
			const deadlineBound = by !== undefined && ms < this.#stepMs;
			const written = await within(
				Promise.resolve().then(() => run.proc.write(piece)),
				ms,
				LATE,
				this.#signal,
			).catch((error: unknown) => {
				throw new Problem(`write() of ${what} failed while the process ran: ${words(error)}`);
			});
			// within() answers LATE for an abort too: a stopped write names no bound that did not run out.
			if (written === LATE && this.#signal?.aborted) throw new Problem(`writing ${what} was stopped, with ${at} bytes written`);
			if (written === LATE) throw new Problem(by && (deadlineBound || by.passed()) ? `writing ${what} ran past ${secondsOf(by.ms)}, with ${at} bytes written` : `write() of ${what} did not answer within ${secondsOf(ms)}`);
		}
	}

	/** wait()'s exit code within ms; one that never comes, or a wait() that throws, is a Problem. */
	async exit(run: Run, ms: number, what: string): Promise<number> {
		let code: number | typeof LATE;
		try {
			code = await within(run.exited, ms, LATE, this.#signal);
		} catch (error) {
			throw new Problem(`wait() for ${what} threw: ${words(error)}`);
		}
		if (code === LATE) throw new Problem(`wait() for ${what} gave no exit code within ${secondsOf(ms)}`);
		if (typeof code !== "number" || !Number.isInteger(code)) throw new Problem(`wait() for ${what} answered ${String(code)}, not an exit code`);
		return code;
	}

	/**
	 * Kills every process this session started, after each check, pass or fail. Every one, ended or not: an exit code
	 * from the wait() under test is no proof the process is gone, and kill() of an ended one costs nothing.
	 */
	async killAll(): Promise<void> {
		const runs = this.#runs.splice(0);
		await Promise.all(runs.map((run) => within(Promise.resolve().then(() => run.proc.kill()), 10_000, undefined).catch(() => {})));
	}
}

/** One deadline for every step of a check: what is left of it, at most a step's bound. */
class Deadline {
	readonly ms: number;
	readonly #at: number;
	constructor(ms: number) {
		this.ms = ms;
		this.#at = Date.now() + ms;
	}
	left(most: number): number {
		return Math.max(1, Math.min(most, this.#at - Date.now()));
	}
	passed(): boolean {
		return Date.now() >= this.#at;
	}
}

type CheckBody = (session: Session, options: Required<Pick<ExecStreamOptions, "longMs" | "largeBytes" | "largeMs" | "unreadMs">>, earlier: Map<ExecStreamCheckId, ExecStreamCheck>) => Promise<string>;

const CHECKS: Record<ExecStreamCheckId, CheckBody> = {
	/**
	 * Text of every kind out, on stdout alone: printf in the machine writes it, the 1 MiB line a piece at a time. Only the
	 * piece's short unit crosses argv; sh repeats it, doubling, into the piece, so the command stays far under a vendor's
	 * 64 KiB argv cap (Modal's).
	 */
	async "stdout-text"(s) {
		const script = `printf "$1"; u=$(printf "$2"); n=${LONG_UNITS}; p=; while [ "$n" -gt 0 ]; do if [ $((n % 2)) -eq 1 ]; then p="$p$u"; fi; u="$u$u"; n=$((n / 2)); done; p="$p"${LONG_TAIL}; i=0; while [ "$i" -lt ${LONG_PIECES} ]; do printf '%s' "$p"; i=$((i+1)); done; printf '\\n'`;
		const run = await s.start(["sh", "-c", script, "sh", printfOf(CODE_POINTS), printfOf(LONG_UNIT)], false);
		if (!(await run.out.end(s.stepMs, s.signal))) throw new Problem(`stdout of printf did not end within ${secondsOf(s.stepMs)} of its start`);
		const code = await s.exit(run, s.stepMs, "printf");
		if (code !== 0) throw new Problem(`printf of the text exited ${code} (stderr: ${run.err.bytes().toString("utf8").trim().slice(0, 200) || "none"})`);
		const problem = textProblem(TEXT, run.out.bytes(), "on stdout");
		if (problem) throw new Problem(problem);
		return "text of every class of code point, \\r and \\r\\n, and a 1 MiB line, printed in the machine, came back unchanged on stdout";
	},
	/** The same text in on stdin and out again, through cat, read until it has all come back: no end of stdin. */
	async "stdin-text"(s, _options, earlier) {
		const run = await s.start(["cat"], true);
		await s.write(run, TEXT, "the text");
		const came = await run.out.until(() => run.out.length >= TEXT.length, s.stepMs, s.signal);
		const got = run.out.bytes();
		// What came back is checked as far as it goes: a character changed on the way says so, before any that never came.
		const problem = textProblem(came ? TEXT : TEXT.subarray(0, got.length), got, "through cat");
		if (problem) throw new Problem(earlier.get("stdout-text")?.status === "pass" ? `${problem}. stdout alone passes it (stdout-text), so it changed on the way in, on stdin` : problem);
		if (!came) throw new Problem(`only ${got.length} of ${TEXT.length} bytes of text came back through cat within ${secondsOf(s.stepMs)} of the last write: your exec holds stdin, or drops some of it. Pass each write on as it comes`);
		return "the same text written to stdin came back unchanged through cat";
	},
	/** Large random text through cat, read while it is written, compared by sha256, all within largeMs. */
	async large(s, { largeBytes, largeMs }) {
		const payload = randomText(largeBytes);
		const started = Date.now();
		const by = new Deadline(largeMs);
		const run = await s.start(["cat"], true);
		await s.write(run, payload, `${largeBytes} bytes of random text`, by);
		if (!(await run.out.until(() => run.out.length >= largeBytes, by.left(largeMs), s.signal))) {
			throw new Problem(`${run.out.length} of ${largeBytes} bytes of text came back through cat within ${secondsOf(largeMs)}: your exec is too slow, or stops passing output on`);
		}
		const got = run.out.bytes();
		const sent = createHash("sha256").update(payload).digest("hex");
		const back = createHash("sha256").update(got).digest("hex");
		if (sent !== back) {
			throw new Problem(`${largeBytes} bytes of random text went in, ${got.length} came back with sha256 ${back.slice(0, 16)}…, not ${sent.slice(0, 16)}…: ${textProblem(payload, got, "through cat") ?? "they differ"}`);
		}
		return `${largeBytes} bytes of random text came back through cat with the same sha256 in ${secondsOf(Date.now() - started)}`;
	},
	/** Output comes back while the process runs: printf, then a sleep that never ends on its own. */
	async "stdout-live"(s) {
		const run = await s.start(["sh", "-c", "printf early; exec sleep 600"], false);
		const came = await run.out.until(() => run.out.length >= 5, s.stepMs, s.signal);
		if (!came) {
			if (run.out.ended) throw new Problem(`stdout ended with ${JSON.stringify(run.out.bytes().toString("latin1"))} before the process did: stdout must stay open until the process ends`);
			throw new Problem(`the process printed "early" at once, then slept, and nothing came back on stdout in ${secondsOf(s.stepMs)}: your exec holds output until the process exits. Pass each byte on as it comes`);
		}
		const got = run.out.bytes().toString("latin1");
		if (got !== "early") throw new Problem(`stdout read ${JSON.stringify(got)}, not "early"`);
		// "early" alone is not live: the sleep still runs, so stdout stays open and wait() has no answer yet.
		if (await run.out.end(LIVE_GRACE_MS, s.signal)) throw new Problem(`stdout ended right after "early", while the process still slept: stdout must stay open until the process ends`);
		if (run.exitCode !== undefined) throw new Problem(`wait() answered ${run.exitCode} right after "early", while the process still slept: wait() answers once the process ends`);
		return `"early" came back while the process still ran`;
	},
	/** stdin reaches the process as it is written: cat echoes one write, then another, with stdin still open. */
	async "stdin-live"(s, _options, earlier) {
		const run = await s.start(["cat"], true);
		const outLive = earlier.get("stdout-live")?.status === "pass";
		const rounds = [Buffer.from("first write\n"), Buffer.from("second write\n")];
		let want = 0;
		for (const [i, chunk] of rounds.entries()) {
			await s.write(run, chunk, `write ${i + 1}`);
			want += chunk.length;
			const came = await run.out.until(() => run.out.length >= want, s.stepMs, s.signal);
			if (!came) {
				if (run.out.ended) throw new Problem(`cat's stdout ended after write ${i + 1}, with stdin still open: exec must keep the process and its stdin open until end()`);
				throw new Problem(
					outLive
						? `write ${i + 1} to cat, with stdin still open, never came back on stdout in ${secondsOf(s.stepMs)}, though output does come back as it is printed: your exec holds stdin until end(). Pass each write on as it comes`
						: `write ${i + 1} to cat, with stdin still open, never came back on stdout in ${secondsOf(s.stepMs)}: your exec holds stdin until end(), or output until the process exits (see stdout-live)`,
				);
			}
		}
		const problem = textProblem(Buffer.concat(rounds), run.out.bytes(), "through cat");
		if (problem) throw new Problem(problem);
		return "two writes came back through cat, each before the next was written, while stdin stayed open";
	},
	/**
	 * stdin keeps coming while stdout is left unread for unreadMs; then stdout is read, and every byte comes back, in
	 * order. A write may wait while nobody reads stdout, but once stdout is read it goes on: an exec whose stdin waits on
	 * a stalled reader for good deadlocks the daemon's one stream (microsandbox holds a 64 KiB stdin window per execution).
	 */
	async "stdout-unread"(s, { unreadMs }) {
		let read = () => {};
		const run = await s.start(["cat"], true, new Promise<void>((done) => (read = done)));
		const started = Date.now();
		const readAt = started + unreadMs;
		const reading = setTimeout(read, unreadMs);
		const sent: Buffer[] = [];
		let written = 0;
		try {
			// Every write, paced over unreadMs: one that waits for the reader goes on once stdout is read, and the rest follow.
			// All of them are answered within stepMs of stdout being read: one deadline, not a step per write.
			for (let i = 0; i < UNREAD_WRITES && !s.signal?.aborted; i++) {
				await pause(started + (i * unreadMs) / UNREAD_WRITES - Date.now(), s.signal);
				const chunk = Buffer.alloc(UNREAD_CHUNK, `write ${String(i + 1).padStart(2, "0")} `);
				const madeUnread = Date.now() < readAt;
				const answered = await within(
					Promise.resolve().then(() => run.proc.write(chunk)),
					Math.max(1, readAt + s.stepMs - Date.now()),
					LATE,
					s.signal,
				).catch((error: unknown) => {
					throw new Problem(`write() to cat failed while its stdout was left unread, with ${written} bytes written: ${words(error)}`);
				});
				if (answered === LATE && s.signal?.aborted) throw new Problem(`writing to cat was stopped, with ${written} bytes written`);
				if (answered === LATE && !madeUnread) throw new Problem(`the ${UNREAD_WRITES} writes to cat ran past ${secondsOf(s.stepMs)} after stdout was read, with ${written} bytes written: your exec's writes are too slow`);
				if (answered === LATE) {
					throw new Problem(
						`write ${i + 1} to cat, made while its stdout was left unread, still had no answer ${secondsOf(s.stepMs)} after stdout was read again (${written} bytes written): your exec's stdin waits for stdout to be read and does not go on once it is, so one stalled reader deadlocks the stream. Let stdin wait only until stdout is read`,
					);
				}
				sent.push(chunk);
				written += chunk.length;
			}
			await pause(readAt - Date.now(), s.signal);
		} finally {
			clearTimeout(reading);
			read();
		}
		if (!(await run.out.until(() => run.out.length >= written, s.stepMs, s.signal))) {
			throw new Problem(`${run.out.length} of ${written} bytes came back through cat within ${secondsOf(s.stepMs)} of stdout being read`);
		}
		const problem = textProblem(Buffer.concat(sent), run.out.bytes(), "through cat");
		if (problem) throw new Problem(`${problem}; stdout was left unread ${secondsOf(unreadMs)} while stdin was written: output nobody reads yet is held until it is read, never dropped`);
		return `${written} bytes written to cat while its stdout was left unread for ${secondsOf(unreadMs)} all came back, in order, once it was read`;
	},
	/** stderr comes back apart from stdout. */
	async stderr(s) {
		const run = await s.start(["sh", "-c", "printf to-stdout; printf to-stderr >&2"], false);
		await run.out.end(s.stepMs, s.signal);
		await run.err.end(s.stepMs, s.signal);
		await s.exit(run, s.stepMs, "the two printfs");
		const out = run.out.bytes().toString("latin1");
		const err = run.err.bytes().toString("latin1");
		if (out.includes("to-stderr")) throw new Problem(`what the process wrote to stderr came back on stdout (stdout read ${JSON.stringify(out)}): your exec merges the two streams. Keep them apart`);
		if (err.includes("to-stdout")) throw new Problem(`what the process wrote to stdout came back on stderr (stderr read ${JSON.stringify(err)}): keep the two streams apart`);
		if (out !== "to-stdout") throw new Problem(`stdout read ${JSON.stringify(out)}, not "to-stdout"`);
		if (err !== "to-stderr") throw new Problem(`stderr read ${JSON.stringify(err)}, not "to-stderr": your exec drops or changes stderr`);
		return "stdout and stderr came back apart, each with its own bytes";
	},
	/** wait() gives the process's own exit code. */
	async "exit-code"(s) {
		const run = await s.start(["sh", "-c", "exit 7"], false);
		const code = await s.exit(run, s.stepMs, "sh -c 'exit 7'");
		if (code !== 7) throw new Problem(`sh -c 'exit 7' gave ${code} from wait(), not 7: wait() answers the process's own exit code`);
		return "wait() gave 7 for sh -c 'exit 7'";
	},
	/** kill() ends a process that would run for ten minutes, wait() then answers, and the process is gone. */
	async kill(s) {
		const run = await s.start(["sh", "-c", "echo $$; exec sleep 600"], false);
		const line = await run.out.until(() => run.out.bytes().includes(0x0a), s.stepMs, s.signal);
		if (!line) throw new Problem(`the process's pid never came back on stdout in ${secondsOf(s.stepMs)}`);
		const pid = run.out.bytes().toString("latin1").trim();
		if (!/^[1-9][0-9]*$/.test(pid)) throw new Problem(`the process printed ${JSON.stringify(pid)}, not its pid`);
		const killed = await within(
			Promise.resolve().then(() => run.proc.kill()),
			s.stepMs,
			LATE,
			s.signal,
		).catch((error: unknown) => {
			throw new Problem(`kill() threw: ${words(error)}. It ends the process best effort and never throws`);
		});
		if (killed === LATE) throw new Problem(`kill() did not answer within ${secondsOf(s.stepMs)}`);
		// wait() after kill, then the machine's own word on the pid, whichever fails first named by the second.
		const waited = await s.exit(run, s.stepMs, "the killed sleep").then(
			() => undefined,
			(error: unknown) => error,
		);
		const probe = await s.start(["sh", "-c", PID_STATE_SCRIPT, "sh", pid], false);
		await probe.out.end(s.stepMs, s.signal);
		await s.exit(probe, s.stepMs, "kill -0");
		const state = probe.out.bytes().toString("latin1").trim();
		if (state === "running") throw new Problem(`kill() answered, but process ${pid} still runs in the machine: kill() must end the process, not only let go of its streams`);
		if (state !== "gone") throw new Problem(`kill -0 ${pid} printed ${JSON.stringify(state)}, not "gone"`);
		if (waited !== undefined) throw waited;
		return `kill() ended a sleep of 600 s, wait() answered, and process ${pid} is gone`;
	},
	/** A process that runs, silent, past the usual command and idle timeouts is not cut off. */
	async "no-timeout"(s, { longMs }) {
		const seconds = Math.max(1, Math.round(longMs / 1000));
		const started = Date.now();
		const run = await s.start(["sh", "-c", `sleep ${seconds}; printf done`], false);
		await run.out.end(seconds * 1000 + s.stepMs, s.signal);
		const code = await s.exit(run, s.stepMs, `sleep ${seconds}`);
		const ran = Date.now() - started;
		const out = run.out.bytes().toString("latin1");
		if (code !== 0 || out !== "done") {
			const how = code !== 0 ? `exited ${code}` : `printed ${JSON.stringify(out)}`;
			throw new Problem(`a process that sleeps ${seconds} s, silent, then prints "done", ${how} after ${secondsOf(ran)}: your exec has a command timeout, or the stream an idle timeout. Turn both off: AgentRun's daemon talks over one exec for the computer's whole life`);
		}
		if (ran < seconds * 1000 - 1000) throw new Problem(`a sleep of ${seconds} s ended after ${secondsOf(ran)}`);
		return `a process that slept ${seconds} s, silent, ran to its end and printed "done"`;
	},
};

/**
 * The capability probe, one sh script run through exec (as root, as exec runs): a tab-separated line for each thing it
 * reads, each value on one line, and every line of the kernel's TCP tables as a "tcp" line. readFacts reads it. It needs
 * no ss, ip or util-linux beyond unshare, and says "none" where the machine lacks unshare.
 */
export const CAPABILITY_SCRIPT = [
	`line() { printf '%s\\t%s\\n' "$1" "$(printf '%s' "$2" | tr '\\n\\t' '  ')"; }`,
	'line uid "$(id -u 2>&1)"',
	'line arch "$(uname -m 2>&1)"',
	'line kernel "$(uname -sr 2>&1)"',
	`if d=$(dmesg 2>/dev/null); then line gvisor "$(printf '%s' "$d" | grep -i gvisor | head -n 1)"; else line gvisor unread; fi`,
	'if command -v unshare >/dev/null 2>&1; then e=$(unshare -n true 2>&1); line netns "$? $e"; e=$(unshare -Urn true 2>&1); line userns "$? $e"; else line netns none; fi',
	'if [ -e /dev/fuse ]; then e=$( (: <>/dev/fuse) 2>&1); line fuse "$? $e"; else line fuse absent; fi',
	`for f in /proc/net/tcp /proc/net/tcp6; do if [ -r "$f" ]; then line table "$f"; while read -r l; do printf 'tcp\\t%s\\n' "$l"; done < "$f"; else line unreadable "$f"; fi; done`,
	"true",
].join("\n");

/** A /proc/net/tcp{,6} address, hex as the kernel writes it (each 32-bit word in host order, little-endian here), as text. */
function tcpAddress(hex: string): string {
	const bytes = Buffer.from(hex, "hex");
	for (let at = 0; at + 4 <= bytes.length; at += 4) bytes.subarray(at, at + 4).reverse();
	if (bytes.length === 4) return [...bytes].join(".");
	const groups = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16));
	return new URL(`http://[${groups.join(":")}]`).hostname;
}

/** The most listeners the report names; a vendor's machine has a handful, a developer's box hundreds. */
const MAX_LISTENERS_SHOWN = 24;

/** The TCP listeners in the probe's "tcp" lines: address:port, each once, in the order the kernel lists them. */
export function tcpListeners(lines: readonly string[]): string[] {
	const found: string[] = [];
	for (const line of lines) {
		const [, local = "", , state] = line.trim().split(/\s+/);
		const match = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(local);
		if (state !== "0A" || match === null) continue;
		const at = `${tcpAddress(match[1] as string)}:${Number.parseInt(match[2] as string, 16)}`;
		if (!found.includes(at)) found.push(at);
	}
	return found;
}

/** What `<code> <words>` says of a command the probe ran: whether it worked, and its words. */
function ranOf(text: string | undefined): { ok: boolean; said: string } | undefined {
	const match = /^(\d+) ?(.*)$/.exec(text ?? "");
	return match === null ? undefined : { ok: match[1] === "0", said: (match[2] as string).trim() };
}

/** The probe's output as facts, each with what it means for the provider. */
export function readFacts(output: string): ExecStreamFact[] {
	const values = new Map<string, string>();
	const tcp: string[] = [];
	/** The TCP tables read, and those that could not be. */
	const tables = { read: [] as string[], unreadable: [] as string[] };
	for (const line of output.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const [key, value] = [line.slice(0, tab), line.slice(tab + 1).trim()];
		if (key === "tcp") tcp.push(value);
		else if (key === "table") tables.read.push(value);
		else if (key === "unreadable") tables.unreadable.push(value);
		else if (!values.has(key)) values.set(key, value);
	}
	const facts: ExecStreamFact[] = [];
	const uid = values.get("uid") ?? "";
	facts.push(
		uid === "0"
			? { id: "root", value: "uid 0", means: "exec runs as root, as the adapter needs: the lines below are what root can do" }
			: { id: "root", value: uid === "" ? "not read" : `uid ${uid}`, means: "exec does not run as root: the adapter installs its daemon as root through exec, so run it as root (or through passwordless sudo); the lines below are what this user can do" },
	);
	const netns = values.get("netns");
	const own = ranOf(netns);
	const inUser = ranOf(values.get("userns"));
	if (netns === "none") facts.push({ id: "netns", value: "no unshare program", means: "not read: the machine has no unshare (util-linux), so whether root can make a network namespace shows only at the Core run" });
	else if (own?.ok) facts.push({ id: "netns", value: "unshare -n works", means: "root makes a network namespace: our fence holds network none, open and allow (netns)" });
	else if (own !== undefined && inUser?.ok) {
		facts.push({ id: "netns", value: `unshare -n failed (${own.said || "no words"}); unshare -Urn works`, means: "root makes a network namespace only inside a user namespace, as on gVisor: our fence holds network none, open and allow there (userns-netns)" });
	} else {
		const why = [own && `unshare -n failed (${own.said || "no words"})`, inUser && `unshare -Urn failed (${inUser.said || "no words"})`].filter(Boolean).join("; ") || "not read";
		facts.push({ id: "netns", value: why, means: "no netns: network none, open and allow can't be held by our fence on this vendor" });
	}
	const fuse = values.get("fuse");
	const opened = ranOf(fuse);
	if (fuse === "absent") facts.push({ id: "fuse", value: "no /dev/fuse", means: "no Archil mount (mount:archil) on this vendor: the Archil client needs /dev/fuse" });
	else if (opened?.ok) facts.push({ id: "fuse", value: "/dev/fuse opens", means: "an Archil mount (mount:archil) can be made here" });
	else facts.push({ id: "fuse", value: opened ? `/dev/fuse does not open (${opened.said || "no words"})` : "not read", means: "no Archil mount (mount:archil) on this vendor until root can open /dev/fuse" });
	const arch = values.get("arch") ?? "";
	const goArch = arch === "x86_64" || arch === "amd64" ? "amd64" : arch === "aarch64" || arch === "arm64" ? "arm64" : undefined;
	facts.push({ id: "arch", value: arch || "not read", means: goArch ? `facts.arch "${goArch}"` : "neither amd64 nor arm64: computerd is built for those two alone" });
	const kernel = values.get("kernel") || "not read";
	const gvisor = values.get("gvisor") ?? "unread";
	const isolationCases = "the isolation cases show how its fences hold";
	if (gvisor !== "unread" && gvisor !== "") {
		facts.push({ id: "kernel", value: `gVisor (${kernel} as it reports; dmesg: ${gvisor.slice(0, 80)})`, means: "gVisor: root has no CAP_SYS_ADMIN and the network stack is gVisor's own, so run the isolation cases here; a Docker stand-in does not show how it behaves" });
	} else {
		const marker = gvisor === "" ? "no gVisor marker in dmesg" : "dmesg could not be read, so gVisor is not ruled out";
		facts.push({ id: "kernel", value: `${kernel} (${marker})`, means: `the kernel as it reports itself: ${isolationCases}` });
	}
	const listeners = tcpListeners(tcp);
	const shownListeners = listeners.length > MAX_LISTENERS_SHOWN ? `${listeners.slice(0, MAX_LISTENERS_SHOWN).join(", ")} and ${listeners.length - MAX_LISTENERS_SHOWN} more` : listeners.join(", ");
	const unread = tables.unreadable.length > 0 ? ` (${tables.unreadable.join(" and ")} could not be read)` : "";
	if (tables.read.length === 0) {
		facts.push({ id: "listeners", value: `not read${unread}`, means: "the listeners are unknown: find the vendor agent's ports some other way before you set facts.vendorAgentPorts" });
	} else if (listeners.length > 0) {
		facts.push({ id: "listeners", value: `${shownListeners}${unread}`, means: "TCP listeners before AgentRun runs anything: the vendor's agent and services. Put the agent's ports in facts.vendorAgentPorts, so isolation.vendor-agent checks the computer's programs reach none of them" });
	} else {
		facts.push({ id: "listeners", value: `none${unread}`, means: unread === "" ? "no TCP listener before AgentRun runs anything: facts.vendorAgentPorts may be []" : `no TCP listener in ${tables.read.join(" or ")}: check the table that could not be read before you set facts.vendorAgentPorts to []` });
	}
	return facts;
}

/** The capability probe through exec: its facts, or a Problem in words when exec could not run it. */
async function probe(session: Session): Promise<ExecStreamFact[]> {
	const run = await session.start(["sh", "-c", CAPABILITY_SCRIPT], false);
	if (!(await run.out.end(session.stepMs, session.signal))) throw new Problem(`its stdout did not end within ${secondsOf(session.stepMs)}`);
	// The script ends in `true`: any other exit is a shell that broke partway, whose output is not read as facts.
	const code = await session.exit(run, session.stepMs, "the probe");
	if (code !== 0) throw new Problem(`the probe's sh exited ${code} (stderr: ${run.err.bytes().toString("utf8").trim().slice(0, 200) || "none"})`);
	return readFacts(run.out.bytes().toString("utf8"));
}

/**
 * The exec pre-check on one machine: each check in EXEC_STREAM_CHECKS runs in turn, and the report passes when every one
 * does; then the capability probe, which passes or fails nothing. host.exec is the only member called.
 */
export async function checkExecStream(host: MachineHost, machine: string, options: ExecStreamOptions = {}): Promise<ExecStreamReport> {
	const { longMs = DEFAULT_LONG_MS, stepMs = DEFAULT_STEP_MS, largeBytes = DEFAULT_LARGE_BYTES, largeMs = DEFAULT_LARGE_MS, unreadMs = DEFAULT_UNREAD_MS, signal, onCheck } = options;
	const session = new Session(host, machine, stepMs, signal);
	const done = new Map<ExecStreamCheckId, ExecStreamCheck>();
	for (const id of EXEC_STREAM_CHECKS) {
		const started = Date.now();
		let check: ExecStreamCheck;
		if (signal?.aborted) check = { id, status: "fail", words: "the run was aborted before this check", ms: 0 };
		else {
			try {
				const said = await CHECKS[id](session, { longMs, largeBytes, largeMs, unreadMs }, done);
				check = { id, status: "pass", words: said, ms: Date.now() - started };
			} catch (error) {
				const said = error instanceof Problem ? error.message : `the check itself failed: ${words(error)}`;
				check = { id, status: "fail", words: signal?.aborted ? `aborted: ${said}` : said, ms: Date.now() - started };
			}
			await session.killAll();
		}
		done.set(id, check);
		onCheck?.(check);
	}
	const checks = [...done.values()];
	const report: ExecStreamReport = { host: host.descriptor.id, machine, checks, pass: checks.every((check) => check.status === "pass"), facts: [] };
	if (signal?.aborted) report.factsProblem = "the run was aborted before the probe";
	else {
		try {
			report.facts = await probe(session);
		} catch (error) {
			report.factsProblem = error instanceof Problem ? error.message : `the probe itself failed: ${words(error)}`;
		}
		await session.killAll();
	}
	return report;
}

/** The report as a person reads it: one line per check, what failed in words, the machine's facts, the verdict last. */
export function formatExecStream(report: ExecStreamReport): string {
	const width = Math.max(...EXEC_STREAM_CHECKS.map((id) => id.length));
	const lines = [`exec pre-check · ${report.host} · machine ${report.machine}`];
	for (const check of report.checks) lines.push(`${check.status === "pass" ? "✓" : "✗"} ${check.id.padEnd(width)}  ${check.words}`);
	lines.push("what the machine offers (facts for the rest of your host, not checks of exec):");
	if (report.factsProblem !== undefined) lines.push(`  not read: ${report.factsProblem}`);
	for (const fact of report.facts) lines.push(`· ${fact.id.padEnd(width)}  ${fact.value}: ${fact.means}`);
	const failed = report.checks.filter((check) => check.status === "fail").length;
	lines.push(
		report.pass
			? "exec PASS: a live, two-way stream that keeps text intact, with no timeout. Write the rest of your host next."
			: `exec FAIL: ${failed} of ${report.checks.length} checks failed. Fix exec before you write the rest of your host: AgentRun reaches its daemon through it.`,
	);
	return `${lines.join("\n")}\n`;
}
