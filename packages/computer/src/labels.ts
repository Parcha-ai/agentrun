// The run and its claim epoch, as two labels every computer of a run carries. The claim epoch is the one fence for runs
// and computers: a new claim is epoch + 1, and it releases every computer of the run labelled with a lower epoch
// (releaseOlder, in janitor.ts). Both names live here alone, with the run label's hash: a provider whose computers keep
// only that (Orgo's names) lists it under RUN_HASH_LABEL, so a caller can still tell whose run a computer is.
import { createHash } from "node:crypto";
import { epochProblem } from "./mount.js";
import { fail, ok, type Result } from "./result.js";

export { epochProblem };

/** The run a computer works for. */
export const RUN_LABEL = "agentrun.run";
/** The claim epoch of the run's runner that made the computer, in decimal. */
export const EPOCH_LABEL = "agentrun.epoch";
/** The run label's hash (runHash), listed in place of RUN_LABEL by a provider that keeps only the hash and is listed
 *  with no run label to match. */
export const RUN_HASH_LABEL = "agentrun.run.hash";

/** The run label's hash, as a provider keeps it where the run itself doesn't fit (a computer's name): base32 of its
 *  sha256, lower case, 16 letters. */
export function runHash(run: string): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	const bytes = createHash("sha256").update(run, "utf8").digest();
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5 && out.length < 16) {
			out += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		if (out.length >= 16) break;
	}
	return out;
}

/** An epoch as a label holds it: decimal digits, no sign, no leading zero, no space. */
const EPOCH_TEXT = /^(?:0|[1-9][0-9]*)$/;

/**
 * Why run is not a run id, in words, or undefined when it is one: a non-empty string with no NUL byte. That is the
 * strictest rule the providers share for a label's value (Docker, Daytona and Modal each refuse only a NUL), so every
 * provider takes it.
 */
export function runProblem(run: unknown): string | undefined {
	if (typeof run !== "string" || run === "") return "a run id must be a non-empty string";
	if (run.includes("\0")) return "a run id cannot hold a NUL byte: no provider takes one in a label";
	return undefined;
}

/**
 * The labels of a computer of this run, made under this claim epoch: { "agentrun.run": run, "agentrun.epoch": "<epoch>" }.
 * A run or an epoch that is not one is a caller's mistake, so it throws, in words.
 */
export function runLabels(run: string, epoch: number): Record<string, string> {
	const problem = runProblem(run) ?? epochProblem(epoch);
	if (problem !== undefined) throw new TypeError(problem);
	return { [RUN_LABEL]: run, [EPOCH_LABEL]: String(epoch) };
}

/**
 * A computer's claim epoch, read from its labels. A missing label is not_found; a value other than a decimal whole number
 * with no sign, leading zero or space, up to 2^53 - 1, is not an epoch: invalid, in words naming what it reads.
 */
export function epochOf(labels: Record<string, string> | undefined): Result<number> {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return fail("invalid", "the computer's labels are not a map of names to strings");
	if (!Object.hasOwn(labels, EPOCH_LABEL)) return fail("not_found", `the computer carries no ${EPOCH_LABEL} label`);
	const text: unknown = labels[EPOCH_LABEL];
	const epoch = typeof text === "string" && EPOCH_TEXT.test(text) ? Number(text) : Number.NaN;
	if (!Number.isSafeInteger(epoch)) {
		return fail("invalid", `the label ${EPOCH_LABEL} reads ${JSON.stringify(text)}, not an epoch: a decimal whole number with no sign, leading zero or space`);
	}
	return ok(epoch);
}
