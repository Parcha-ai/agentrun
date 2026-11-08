// A bounded wait for a state read from outside, such as a vendor reading a computer back as ended after a release.
import { fail, ok, type Result } from "./result.js";

export interface WaitOptions<S> {
	/** The longest the whole wait takes, reads included, in ms. */
	boundMs: number;
	/** Ends the wait early, as aborted. */
	signal?: AbortSignal;
	/** The first pause between two reads, in ms; each pause doubles, up to maxMs. Default 250. */
	minMs?: number;
	/** The longest pause between two reads, in ms. Default 5000. */
	maxMs?: number;
	/** What is waited for, in words, for the errors, such as "computer-0123456789ab to finish". */
	what?: string;
	/** A state in words, for the errors. Default its JSON. */
	describe?: (state: S) => string;
}

type Read<S> = { state: S } | { error: unknown } | { ended: true };

const positive = (ms: unknown) => typeof ms === "number" && Number.isFinite(ms) && ms > 0;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reads until done(state) holds and returns that state: the first read at once, then after pauses that double from
 * minMs up to maxMs, never past boundMs. Each read is given a signal that aborts when the bound passes or the caller's
 * signal aborts; a read still pending then is not waited for. A read that throws or rejects is not done, and the wait
 * reads again. Past the bound the result is a timeout, and on the caller's abort an abort, each naming what was waited
 * for and the last state read (or the last read's failure). It never reports done for a state it did not read.
 */
export async function waitUntil<S>(read: (signal: AbortSignal) => Promise<S>, done: (state: S) => boolean, options: WaitOptions<S>): Promise<Result<S>> {
	const { boundMs, signal, minMs = 250, maxMs = 5_000, what = "the wait", describe = (state: S) => JSON.stringify(state) ?? String(state) } = options;
	if (!positive(boundMs) || !positive(minMs) || !positive(maxMs) || maxMs < minMs) {
		throw new RangeError(`waitUntil takes boundMs, minMs and maxMs as positive numbers of ms, minMs at most maxMs; got ${boundMs}, ${minMs} and ${maxMs}`);
	}
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), boundMs);
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const ended = new Promise<Read<S>>((resolve) => {
		if (controller.signal.aborted) resolve({ ended: true });
		else controller.signal.addEventListener("abort", () => resolve({ ended: true }), { once: true });
	});
	let last = "no read had answered";
	let pause = minMs;
	try {
		while (!controller.signal.aborted) {
			const reading = Promise.resolve()
				.then(() => read(controller.signal))
				.then(
					(state): Read<S> => ({ state }),
					(error: unknown): Read<S> => ({ error }),
				);
			const answer = await Promise.race([reading, ended]);
			if ("ended" in answer) break;
			if ("error" in answer) last = `the read failed: ${message(answer.error)}`;
			else if (done(answer.state)) return ok(answer.state);
			else last = describe(answer.state);
			const pausing = new Promise<void>((resolve) => {
				const wake = setTimeout(resolve, pause);
				void ended.then(() => {
					clearTimeout(wake);
					resolve();
				});
			});
			await pausing;
			pause = Math.min(pause * 2, maxMs);
		}
		if (signal?.aborted) return fail("aborted", `the wait for ${what} was aborted after ${(Date.now() - started) / 1000} s; the last read: ${last}`);
		return fail("timeout", `${what} did not happen within ${boundMs / 1000} s; the last read: ${last}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
