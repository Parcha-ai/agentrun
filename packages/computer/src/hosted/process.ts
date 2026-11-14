// The adapter's plumbing over a MachineHost: one bounded call, a process run to its end, a file put through exec when
// the vendor has no file API, the root channel an Archil mount runs through, and the stdio bridge that carries the
// daemon's wire over one exec'd process.
import { PassThrough, Writable } from "node:stream";
import { DaemonClient } from "../client.js";
import type { HostCall, MachineHost, MachineProcess } from "../host.js";
import type { ArchilRoot } from "../mount-archil.js";
import type { ComputerConnection } from "../provider.js";
import type { HelloResult } from "../protocol.js";
import { type ComputerErrorCode, errorOf, ok, type Result } from "../result.js";

/** What a call's race adds to the bound it gives the vendor's own call, so the vendor's timeout, not the race, reports a slow call. */
export const CALL_SLACK_MS = 5_000;

export const seconds = (ms: number) => `${ms / 1000} s`;

/** An error in words, the vendor's name kept, cut to one line of 300 characters. */
export const words = (error: unknown) => {
	const name = (error as { name?: unknown } | null)?.name;
	const message = error instanceof Error ? error.message : String(error);
	return `${typeof name === "string" && name !== "Error" ? `${name}: ` : ""}${message}`.replace(/\s+/g, " ").slice(0, 300);
};

/** A pause that ends early when signal aborts; never rejects. */
export const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((done) => {
		const timer = setTimeout(finish, ms);
		function finish() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			done();
		}
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
	});

/** A signal that aborts with the caller's, or once ms pass. */
export const bounded = (ms: number, signal?: AbortSignal): AbortSignal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/**
 * A promise that rejects with an AbortError (the caller's signal aborted) or a TimeoutError (ms passed), and clear to
 * stop listening when the work finished first.
 */
export function boundOf(ms: number, signal: AbortSignal | undefined, what: string): { promise: Promise<never>; clear: () => void } {
	const bound = bounded(ms, signal);
	let onAbort: () => void = () => {};
	const promise = new Promise<never>((_, reject) => {
		onAbort = () => {
			const timedOut = !signal?.aborted;
			const error = new Error(timedOut ? `${what} did not answer within ${seconds(ms)}` : `${what} was aborted`);
			error.name = timedOut ? "TimeoutError" : "AbortError";
			reject(error);
		};
		if (bound.aborted) onAbort();
		else bound.addEventListener("abort", onAbort, { once: true });
	});
	promise.catch(() => {});
	return { promise, clear: () => bound.removeEventListener("abort", onAbort) };
}

/** The code of an error a host's client threw: AbortError and TimeoutError by name, else the host's errorCode, else "vendor". */
export function codeOfError(host: Pick<MachineHost, "errorCode">, error: unknown): ComputerErrorCode {
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "AbortError") return "aborted";
	if (name === "TimeoutError") return "timeout";
	return host.errorCode?.(error) ?? "vendor";
}

/** The failures of one host: an error of code vendor names it. */
export const failOf =
	(host: Pick<MachineHost, "id">) =>
	(code: ComputerErrorCode, message: string): Result<never> => ({ ok: false, error: errorOf(code, message, host.id) });

/**
 * Settles with the promise's result, or a timeout or abort in words once ms pass or signal aborts. A host call that
 * answers a Result is passed on as it answers; one that throws is read through the host's errorCode.
 */
export function race<T>(host: Pick<MachineHost, "id" | "errorCode">, promise: Promise<T>, what: string, ms: number, signal?: AbortSignal): Promise<Result<T>> {
	const fail = failOf(host);
	if (signal?.aborted) {
		promise.catch(() => {});
		return Promise.resolve(fail("aborted", `${what} was aborted`));
	}
	return new Promise((settle) => {
		const timer = setTimeout(() => done(fail("timeout", `${what} did not answer within ${seconds(ms)}`)), ms);
		const onAbort = () => done(fail("aborted", `${what} was aborted`));
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		function done(result: Result<T>) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			settle(result);
		}
		promise.then(
			(value) => done(ok(value)),
			(error: unknown) => done(signal?.aborted ? fail("aborted", `${what} was aborted`) : fail(codeOfError(host, error), `${what} failed: ${words(error)}`)),
		);
	});
}

/**
 * One host call, bounded: ctx.timeoutMs is the vendor's own bound, and the race gives it CALL_SLACK_MS more. A call
 * that throws at once is an error like one that rejects; a Result the host answers keeps its own words, prefixed.
 */
export async function hostCall<T>(host: Pick<MachineHost, "id" | "errorCode">, what: string, run: (ctx: HostCall) => Promise<Result<T>>, ms: number, signal?: AbortSignal): Promise<Result<T>> {
	const fail = failOf(host);
	if (signal?.aborted) return fail("aborted", `${what} was aborted before it was called`);
	let promise: Promise<Result<T>>;
	try {
		promise = Promise.resolve(run({ timeoutMs: ms, ...(signal ? { signal } : {}) }));
	} catch (error) {
		return fail(codeOfError(host, error), `${what} failed: ${words(error)}`);
	}
	const raced = await race(host, promise, what, ms + CALL_SLACK_MS, signal);
	if (!raced.ok) return raced;
	const answered = raced.value;
	if (answered.ok) return answered;
	return { ok: false, error: { ...answered.error, message: `${what} failed: ${answered.error.message}` } };
}

/** Reads every chunk of a stream into one buffer, at most `max` bytes kept (the last ones). */
async function drain(stream: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
	let kept = Buffer.alloc(0);
	try {
		for await (const chunk of stream) {
			kept = Buffer.concat([kept, Buffer.from(chunk)]);
			if (kept.length > max) kept = kept.subarray(kept.length - max);
		}
	} catch {
		// A stream that ends in an error has given what it had.
	}
	return kept;
}

/** What one process run to its end printed: its exit code, and both streams (each cut to its last 64 KiB). */
export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const OUTPUT_MAX = 64 * 1024;

/**
 * argv run in the machine as root through exec, stdin (when given) written and ended, waited for until it ends, within
 * ms and the caller's signal; a process past them is killed, and the kill waited for at most ms (and CALL_SLACK_MS).
 * A non-zero exit is a result, not an error.
 */
export async function runToExit(host: MachineHost, id: string, argv: readonly string[], { stdin, ms, signal, what }: { stdin?: Uint8Array; ms: number; signal?: AbortSignal; what: string }): Promise<Result<RunResult>> {
	const fail = failOf(host);
	const started = await hostCall(host, what, (ctx) => host.exec(id, argv, { stdin: stdin !== undefined }, ctx), ms, signal);
	if (!started.ok) return started;
	const proc = started.value;
	const out = drain(proc.stdout, OUTPUT_MAX);
	const err = drain(proc.stderr, OUTPUT_MAX);
	const ran = (async (): Promise<RunResult> => {
		if (stdin !== undefined) {
			// In pieces, so a vendor whose stdin takes one request at a time (E2B's sendStdin) is never handed a whole binary.
			for (let at = 0; at < stdin.length; at += STDIN_CHUNK) await proc.write(stdin.subarray(at, at + STDIN_CHUNK));
			await proc.end();
		}
		const exitCode = await proc.wait();
		return { exitCode, stdout: (await out).toString("utf8"), stderr: (await err).toString("utf8") };
	})();
	const result = await race(host, ran, what, ms + CALL_SLACK_MS, signal);
	if (!result.ok) {
		// Bounded, as the bridge's close is: a kill the vendor never answers (a remote call that stalls) must not hold
		// up the caller, which may be a create on its way to deleting the whole machine.
		const killing = Promise.resolve().then(() => proc.kill());
		await race(host, killing, `${what}'s kill`, Math.min(ms, CALL_SLACK_MS));
		return result.error.code === "timeout" ? fail("timeout", `${what} did not end within ${seconds(ms)}`) : result;
	}
	return result;
}

const STDIN_CHUNK = 256 * 1024;

/** The default upload, for a vendor with no file API: the bytes streamed into `cat` as root through exec's stdin. */
export async function uploadThroughExec(host: MachineHost, id: string, path: string, bytes: Uint8Array, ms: number, signal?: AbortSignal): Promise<Result<void>> {
	const ran = await runToExit(host, id, ["sh", "-c", 'umask 077 && cat > "$1"', "sh", path], { stdin: bytes, ms, ...(signal ? { signal } : {}), what: `the upload to ${path}` });
	if (!ran.ok) return ran;
	return ran.value.exitCode === 0 ? ok(undefined) : failOf(host)("vendor", `the upload to ${path} exited with ${ran.value.exitCode}: ${`${ran.value.stdout} ${ran.value.stderr}`.trim().slice(0, 300)}`);
}

/**
 * The root channel into a machine (for the shared Archil steps): argv as root through exec, stdin (one line, then
 * closed) when given. What it printed is both streams, stdout first; a non-zero exit is a result. An error never holds
 * what stdin was given.
 */
export function rootOf(host: MachineHost, id: string, name: string): ArchilRoot {
	return {
		run: async (argv, { stdin, timeoutMs, signal }) => {
			const ran = await runToExit(host, id, argv, { ...(stdin === undefined ? {} : { stdin: new Uint8Array(Buffer.from(stdin, "utf8")) }), ms: timeoutMs, ...(signal ? { signal } : {}), what: `root's ${argv[0] === undefined ? "command" : argv[0].split("/").pop()} in ${name}` });
			return ran.ok ? ok({ exitCode: ran.value.exitCode, output: `${ran.value.stdout}${ran.value.stderr}` }) : ran;
		},
	};
}

/** A connection the bridge opened, with why it could not be: notListening when no daemon listens yet (try again). */
export type Opened = Result<ComputerConnection> & { notListening?: true };

/**
 * One connection to the daemon over a process the stdio command runs: its stdout is what the client reads, writes go to
 * its stdin in order, and close kills it. Hello is asked within helloMs; a bridge that ended before hello, with no
 * daemon to reach, is notListening.
 */
export async function openBridge(
	host: MachineHost,
	id: string,
	{ argv, name, version, requestMs, helloMs, signal }: { argv: readonly string[]; name: string; version: string; requestMs: number; helloMs: number; signal?: AbortSignal },
): Promise<Opened> {
	const fail = failOf(host);
	const what = `starting the daemon's stdio bridge in ${name}`;
	if (signal?.aborted) return fail("aborted", `${what} was aborted before it was called`);
	let starting: Promise<Result<MachineProcess>>;
	try {
		starting = Promise.resolve(host.exec(id, argv, { stdin: true }, { timeoutMs: requestMs }));
	} catch (error) {
		return fail(codeOfError(host, error), `${what} failed: ${words(error)}`);
	}
	const raced = await race(host, starting, what, requestMs + CALL_SLACK_MS, signal);
	if (!raced.ok) {
		// The bridge has no command timeout: one the vendor starts after this was given up on is killed as it lands.
		if (raced.error.code === "timeout" || raced.error.code === "aborted") {
			starting.then(
				(late) => (late.ok ? late.value.kill() : undefined),
				() => {},
			);
			return fail(raced.error.code, `${raced.error.message}; a bridge that starts after this is killed`);
		}
		return raced;
	}
	if (!raced.value.ok) return fail(raced.value.error.code, `${what} failed: ${raced.value.error.message}`);
	const proc = raced.value.value;
	const readable = new PassThrough();
	let stderr = "";
	void (async () => {
		try {
			for await (const chunk of proc.stdout) if (!readable.destroyed) readable.write(Buffer.from(chunk));
		} catch {
			// The bridge's end, for any reason, ends what the client reads.
		}
		readable.end();
	})();
	void (async () => {
		try {
			for await (const chunk of proc.stderr) stderr = (stderr + Buffer.from(chunk).toString("utf8")).slice(-4096);
		} catch {
			// Its words are what came before.
		}
	})();
	const writable = new Writable({
		write(chunk: Buffer, _encoding, done) {
			proc.write(new Uint8Array(chunk)).then(
				() => done(),
				(error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
			);
		},
	});
	const client = new DaemonClient({ readable, writable });
	let closed: Promise<void> | undefined;
	const close = () =>
		(closed ??= (async () => {
			client.close();
			await race(host, proc.kill(), "the stdio bridge's kill", requestMs).catch(() => {});
		})());
	const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${version}` }, { signal: bounded(helloMs, signal) });
	if (!hello.ok) {
		await close();
		if (signal?.aborted) return fail("aborted", `hello to the daemon in ${name} was aborted`);
		if (hello.error.code === "aborted") return fail("timeout", `the daemon in ${name} did not answer hello within ${seconds(helloMs)}`);
		if (hello.error.code !== "gone") return hello;
		// Its stderr may come a moment after its stdout ended.
		await pause(20);
		return { ...fail("vendor", `cannot reach the daemon in ${name}: ${stderr.trim() || hello.error.message}`), notListening: true };
	}
	return ok({ client, hello: hello.value as HelloResult, close });
}
