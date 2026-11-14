// The exec pre-check: the one thing a new vendor proves before writing anything else of its host. AgentRun installs its
// daemon through MachineHost.exec and then talks to it over that one process's stdin and stdout for the computer's whole
// life, so exec must be a live, two-way, byte-exact stream with no timeout (the contract is exec's doc comment in
// ../host.ts). This runs exec alone, on a machine the vendor made by hand, and says in plain words what it did wrong:
//
//   npm run conformance -w @parcha/agentrun-computer -- --provider <id | ./module.js> --exec-stream --machine <id> [--quick]
//
// It calls nothing but host.exec, so a host whose other members are still stubs can run it. Each check starts its own
// process and kills it when it is done with it, pass or fail.
import { createHash, randomBytes } from "node:crypto";
import type { MachineHost, MachineProcess } from "../host.js";
import { words } from "../hosted/process.js";

/** The checks, in the order they run. */
export const EXEC_STREAM_CHECKS = ["stdout-bytes", "stdin-bytes", "large", "stdout-live", "stdin-live", "stderr", "exit-code", "kill", "no-timeout"] as const;
export type ExecStreamCheckId = (typeof EXEC_STREAM_CHECKS)[number];

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
}

export interface ExecStreamOptions {
	/** How long the no-timeout check's process runs, silent, before it prints and exits; default 75 s. */
	longMs?: number;
	/** How long one step waits: exec's answer, bytes coming back, wait() after the end; default 30 s. */
	stepMs?: number;
	/** The large check's payload, in bytes; default 8 MiB. */
	largeBytes?: number;
	/** How long the large check may take in all; default 180 s. */
	largeMs?: number;
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
/** What one write gives exec's stdin, as the adapter's own upload does (runToExit). */
const WRITE_CHUNK = 256 * 1024;
/** How long stdout-live watches, after "early", that stdout stays open and wait() has no answer. */
const LIVE_GRACE_MS = 1_000;

/** A failed check: its words are the report's. */
class Problem extends Error {}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const byte = (b: number) => `0x${b.toString(16).padStart(2, "0")}`;
const secondsOf = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const shown = (argv: readonly string[]) => argv.map((word) => (/^[\w./=:-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(" ");
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);
/** printf's format for every byte value, 0 to 255, each as an octal escape: dash, bash and busybox all read it. */
const PRINTF_ALL = [...ALL_BYTES].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("");

/**
 * Why `got` is not `sent`, in words, or undefined when they are the same bytes. `way` is where they went ("on stdout");
 * the first byte that differs is named, and the usual ways an exec mangles bytes are named for what they are.
 */
export function bytesProblem(sent: Uint8Array, got: Uint8Array, way: string): string | undefined {
	let i = 0;
	while (i < sent.length && i < got.length && sent[i] === got[i]) i++;
	if (i === sent.length && i === got.length) return undefined;
	if (i === got.length) {
		const nul = sent[i] === 0 ? ": the first missing byte is 0x00, so your exec may treat output as C strings and stop at a NUL" : "";
		return `only ${got.length} of ${sent.length} bytes came back ${way}${nul}. Pass every byte on as it comes`;
	}
	if (i === sent.length) return `${got.length - sent.length} bytes came back ${way} that were never sent, after all ${sent.length} that were (${hex(got.subarray(i, i + 8))}): your exec adds output of its own (a shell's login banner, a prompt). Pass only the process's own bytes`;
	const b = sent[i] as number;
	const at = got.subarray(i, i + 3);
	const was = `byte ${byte(b)} came back ${way} as ${hex(at)}`;
	if (b >= 0x80 && at[0] === 0xef && at[1] === 0xbf && at[2] === 0xbd) {
		return `${was}: your exec decodes UTF-8, which turns each byte that is not UTF-8 into U+FFFD (ef bf bd). Pass the bytes on as bytes, never as text`;
	}
	if (b >= 0x80 && at[0] === (0xc0 | (b >> 6)) && at[1] === (0x80 | (b & 0x3f))) {
		return `${was}: your exec reads bytes as Latin-1 text and writes them back as UTF-8. Pass the bytes on as bytes, never as text`;
	}
	if (b === 0x0a && at[0] === 0x0d && at[1] === 0x0a) return `${was}: your exec turns \\n into \\r\\n, as a terminal does. Run the process on pipes, not a terminal`;
	if (b === 0x0d && at[0] === 0x0a) return `${was}: your exec drops \\r, as newline translation does. Pass every byte on as it comes`;
	return `${was} (offset ${i}): your exec changes bytes. Pass every byte on as it comes, unchanged`;
}

/** One output stream of a process, read as it comes: its bytes so far, whether it ended, and a wait for more. */
class Reader {
	readonly #chunks: Buffer[] = [];
	length = 0;
	ended = false;
	error: unknown;
	#wake: Array<() => void> = [];

	constructor(stream: AsyncIterable<Uint8Array>) {
		void this.#pump(stream);
	}

	async #pump(stream: AsyncIterable<Uint8Array>) {
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

	/** exec(argv), answered within the step's bound; any failure is a Problem naming the command. */
	async start(argv: readonly string[], stdin: boolean): Promise<Run> {
		const what = `exec of ${shown(argv)}`;
		let answer: Promise<Awaited<ReturnType<MachineHost["exec"]>>>;
		try {
			answer = Promise.resolve(this.#host.exec(this.#machine, argv, { stdin }, { timeoutMs: this.#stepMs, ...(this.#signal ? { signal: this.#signal } : {}) }));
		} catch (error) {
			throw new Problem(`${what} threw: ${words(error)}`);
		}
		let answered: Awaited<typeof answer> | typeof LATE;
		try {
			answered = await within(answer, this.#stepMs + 5_000, LATE, this.#signal);
		} catch (error) {
			throw new Problem(`${what} threw: ${words(error)}`);
		}
		if (answered === LATE) {
			// One that answers after this gave up is killed as it lands.
			answer.then((late) => (late?.ok ? late.value.kill() : undefined)).catch(() => {});
			throw new Problem(`${what} did not answer within ${secondsOf(this.#stepMs)}: exec answers once the process has started, not when it ends`);
		}
		if (answered === undefined || typeof answered !== "object" || !("ok" in answered)) throw new Problem(`${what} answered ${String(answered)}, not a Result: answer ok(process) or a failure`);
		if (!answered.ok) throw new Problem(`${what} failed: ${answered.error.message}`);
		const proc = answered.value;
		const lacks = ["write", "end", "wait", "kill"].filter((name) => typeof (proc as unknown as Record<string, unknown>)?.[name] !== "function");
		if (proc?.stdout?.[Symbol.asyncIterator] === undefined) lacks.unshift("stdout");
		if (proc?.stderr?.[Symbol.asyncIterator] === undefined) lacks.unshift("stderr");
		if (lacks.length > 0) throw new Problem(`${what} answered a process that lacks ${lacks.join(", ")}: a MachineProcess (src/host.ts) has stdout, stderr, write, end, wait and kill`);
		const run: Run = { proc, out: new Reader(proc.stdout), err: new Reader(proc.stderr), exited: Promise.resolve(0) };
		run.exited = Promise.resolve()
			.then(() => proc.wait())
			.then((code) => {
				run.exitCode = code;
				return code;
			});
		run.exited.catch(() => {});
		this.#runs.push(run);
		return run;
	}

	/**
	 * Writes bytes to the process's stdin, in WRITE_CHUNK pieces, one after another; a refusal is a Problem. Each write
	 * is bounded by the step, and by `by` when the check has one deadline for all of its steps.
	 */
	async write(run: Run, bytes: Uint8Array, what: string, by?: Deadline): Promise<void> {
		for (let at = 0; at < bytes.length; at += WRITE_CHUNK) {
			const ms = by ? by.left(this.#stepMs) : this.#stepMs;
			// Whether the deadline, not the step, set this bound. Asking by.passed() after the timeout is not enough: a
			// timer can fire a millisecond before Date.now() reads the deadline.
			const deadlineBound = by !== undefined && ms < this.#stepMs;
			const written = await within(
				Promise.resolve().then(() => run.proc.write(bytes.subarray(at, at + WRITE_CHUNK))),
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

	/** Ends the process's stdin; a refusal is a Problem. */
	async end(run: Run, by?: Deadline): Promise<void> {
		const ms = by ? by.left(this.#stepMs) : this.#stepMs;
		const ended = await within(
			Promise.resolve().then(() => run.proc.end()),
			ms,
			LATE,
			this.#signal,
		).catch((error: unknown) => {
			throw new Problem(`end() failed: ${words(error)}`);
		});
		if (ended === LATE) throw new Problem(`end() did not answer within ${secondsOf(ms)}`);
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

type CheckBody = (session: Session, options: Required<Pick<ExecStreamOptions, "longMs" | "largeBytes" | "largeMs">>, earlier: Map<ExecStreamCheckId, ExecStreamCheck>) => Promise<string>;

const CHECKS: Record<ExecStreamCheckId, CheckBody> = {
	/** Every byte value out, on stdout alone: printf in the machine writes them. */
	async "stdout-bytes"(s) {
		const argv = ["sh", "-c", 'printf "$1"', "sh", PRINTF_ALL];
		const run = await s.start(argv, false);
		if (!(await run.out.end(s.stepMs, s.signal))) throw new Problem(`stdout of printf did not end within ${secondsOf(s.stepMs)} of its start`);
		const code = await s.exit(run, s.stepMs, "printf");
		if (code !== 0) throw new Problem(`printf of the 256 byte values exited ${code} (stderr: ${run.err.bytes().toString("utf8").trim().slice(0, 200) || "none"})`);
		const problem = bytesProblem(ALL_BYTES, run.out.bytes(), "on stdout");
		if (problem) throw new Problem(problem);
		return "all 256 byte values printed in the machine came back unchanged on stdout";
	},
	/** Every byte value in on stdin and out again, through cat. */
	async "stdin-bytes"(s, _options, earlier) {
		const run = await s.start(["cat"], true);
		await s.write(run, ALL_BYTES, "the 256 byte values");
		await s.end(run);
		if (!(await run.out.end(s.stepMs, s.signal))) throw new Problem(`cat's stdout did not end within ${secondsOf(s.stepMs)} of end(): end() must close the process's stdin, so it reads end of file`);
		await s.exit(run, s.stepMs, "cat");
		const outOk = earlier.get("stdout-bytes")?.status === "pass";
		const problem = bytesProblem(ALL_BYTES, run.out.bytes(), "through cat");
		if (problem) throw new Problem(outOk ? `${problem}. stdout alone passes every byte (stdout-bytes), so they changed on the way in, on stdin` : problem);
		return "all 256 byte values written to stdin came back unchanged through cat";
	},
	/** A large random payload through cat, read while it is written, compared by sha256, all within largeMs. */
	async large(s, { largeBytes, largeMs }) {
		const payload = randomBytes(largeBytes);
		const started = Date.now();
		const by = new Deadline(largeMs);
		const run = await s.start(["cat"], true);
		await s.write(run, payload, `${largeBytes} random bytes`, by);
		await s.end(run, by);
		if (!(await run.out.end(by.left(largeMs), s.signal))) {
			throw new Problem(`${run.out.length} of ${largeBytes} bytes came back through cat within ${secondsOf(largeMs)}, and its stdout had not ended: your exec is too slow, or stops passing output on`);
		}
		await s.exit(run, by.left(s.stepMs), "cat");
		if (by.passed()) throw new Problem(`${largeBytes} bytes through cat took ${secondsOf(Date.now() - started)}, past ${secondsOf(largeMs)}: your exec is too slow`);
		const got = run.out.bytes();
		const sent = createHash("sha256").update(payload).digest("hex");
		const back = createHash("sha256").update(got).digest("hex");
		if (sent !== back) {
			throw new Problem(`${largeBytes} random bytes went in, ${got.length} came back with sha256 ${back.slice(0, 16)}…, not ${sent.slice(0, 16)}…: ${bytesProblem(payload, got, "through cat") ?? "they differ"}`);
		}
		return `${largeBytes} random bytes came back through cat with the same sha256 in ${secondsOf(Date.now() - started)}`;
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
		const problem = bytesProblem(Buffer.concat(rounds), run.out.bytes(), "through cat");
		if (problem) throw new Problem(problem);
		await s.end(run);
		const code = await s.exit(run, s.stepMs, "cat");
		if (code !== 0) throw new Problem(`cat exited ${code} after end(), not 0`);
		return "two writes came back through cat, each before the next was written, while stdin stayed open";
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
		const probe = await s.start(["sh", "-c", 'if kill -0 "$1" 2>/dev/null; then echo running; else echo gone; fi', "sh", pid], false);
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
 * The exec pre-check on one machine: each check in EXEC_STREAM_CHECKS runs in turn, and the report passes when every one
 * does. host.exec is the only member called.
 */
export async function checkExecStream(host: MachineHost, machine: string, options: ExecStreamOptions = {}): Promise<ExecStreamReport> {
	const { longMs = DEFAULT_LONG_MS, stepMs = DEFAULT_STEP_MS, largeBytes = DEFAULT_LARGE_BYTES, largeMs = DEFAULT_LARGE_MS, signal, onCheck } = options;
	const session = new Session(host, machine, stepMs, signal);
	const done = new Map<ExecStreamCheckId, ExecStreamCheck>();
	for (const id of EXEC_STREAM_CHECKS) {
		const started = Date.now();
		let check: ExecStreamCheck;
		if (signal?.aborted) check = { id, status: "fail", words: "the run was aborted before this check", ms: 0 };
		else {
			try {
				const said = await CHECKS[id](session, { longMs, largeBytes, largeMs }, done);
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
	return { host: host.descriptor.id, machine, checks, pass: checks.every((check) => check.status === "pass") };
}

/** The report as a person reads it: one line per check, what failed in words, the verdict last. */
export function formatExecStream(report: ExecStreamReport): string {
	const width = Math.max(...EXEC_STREAM_CHECKS.map((id) => id.length));
	const lines = [`exec pre-check · ${report.host} · machine ${report.machine}`];
	for (const check of report.checks) lines.push(`${check.status === "pass" ? "✓" : "✗"} ${check.id.padEnd(width)}  ${check.words}`);
	const failed = report.checks.filter((check) => check.status === "fail").length;
	lines.push(
		report.pass
			? "exec PASS: a live, two-way, byte-exact stream with no timeout. Write the rest of your host next."
			: `exec FAIL: ${failed} of ${report.checks.length} checks failed. Fix exec before you write the rest of your host: AgentRun reaches its daemon through it.`,
	);
	return `${lines.join("\n")}\n`;
}
