// The run and its claim epoch, as two labels every computer of a run carries. The claim epoch is the one fence for runs
// and computers: a new claim is epoch + 1, and it releases every computer of the run labelled with a lower epoch
// (releaseOlder, in janitor.ts). Both names live here alone.
//
// An agent's persistent computer carries its owner as two more labels, set at create: agentrun.owner=agent:<id>, and
// the owner's idle TTL when it set one. The run and epoch labels then name the claim that holds it now.
import { epochProblem } from "./mount.js";
import { type ComputerOwner, ownerProblem } from "./provider.js";
import { fail, ok, type Result } from "./result.js";

export { epochProblem };

/** The run a computer works for. */
export const RUN_LABEL = "agentrun.run";
/** The claim epoch of the run's runner that made the computer, in decimal. */
export const EPOCH_LABEL = "agentrun.epoch";
/** The agent a persistent computer belongs to, as agent:<id>. */
export const OWNER_LABEL = "agentrun.owner";
/** The owner's idle TTL of a persistent computer, in milliseconds, in decimal: how long it may stay detached. */
export const IDLE_TTL_LABEL = "agentrun.idle-ttl-ms";

/** A whole number as a label holds it: decimal digits, no sign, no leading zero, no space. */
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** The labels of an agent's computer: its owner, and its idle TTL when the owner set one. Throws, in words, on an owner that is not one. */
export function ownerLabels(owner: ComputerOwner): Record<string, string> {
	const problem = ownerProblem(owner);
	if (problem !== undefined) throw new TypeError(problem);
	return { [OWNER_LABEL]: `agent:${owner.agent}`, ...(owner.idleTtlMs === undefined ? {} : { [IDLE_TTL_LABEL]: String(owner.idleTtlMs) }) };
}

/**
 * A computer's owner, read from its labels: undefined for a run's computer (no owner label). An owner label that is not
 * agent:<id>, or an idle TTL that is not a decimal whole number above 0, is invalid, in words naming what it reads.
 */
export function ownerOf(labels: Record<string, string> | undefined): Result<ComputerOwner | undefined> {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return fail("invalid", "the computer's labels are not a map of names to strings");
	if (!Object.hasOwn(labels, OWNER_LABEL)) return ok(undefined);
	const text: unknown = labels[OWNER_LABEL];
	const agent = typeof text === "string" && text.startsWith("agent:") ? text.slice("agent:".length) : undefined;
	if (agent === undefined || ownerProblem({ agent }) !== undefined) return fail("invalid", `the label ${OWNER_LABEL} reads ${JSON.stringify(text)}, not agent:<id>`);
	if (!Object.hasOwn(labels, IDLE_TTL_LABEL)) return ok({ agent });
	const ttl: unknown = labels[IDLE_TTL_LABEL];
	const idleTtlMs = typeof ttl === "string" && DECIMAL.test(ttl) ? Number(ttl) : Number.NaN;
	if (!(Number.isSafeInteger(idleTtlMs) && idleTtlMs > 0)) return fail("invalid", `the label ${IDLE_TTL_LABEL} reads ${JSON.stringify(ttl)}, not a whole number of milliseconds above 0`);
	return ok({ agent, idleTtlMs });
}

/** An epoch as a label holds it: decimal digits, no sign, no leading zero, no space. */
const EPOCH_TEXT = DECIMAL;

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
