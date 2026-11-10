// The janitor: ends computers whose deadline has passed, for a provider whose vendor does not end them itself; and, on a
// takeover, the run's computers of an older claim.
import { epochOf, epochProblem, ownerOf, RUN_LABEL, runProblem } from "./labels.js";
import type { CallContext, ComputerInfo, ComputerProvider, ComputerRef } from "./provider.js";
import { type ComputerError, fail, failAs, ok, type Result } from "./result.js";

export interface SweepOptions {
	/** Only computers with all of these labels; default every computer the provider made. */
	labels?: Record<string, string>;
	/** The time to compare deadlines with; default now. */
	now?: Date;
	/**
	 * Whether an agent is gone, by its id: the caller's answer (serve's agents). An agent's computer whose owner is gone
	 * is deleted; without this, no agent counts as gone.
	 */
	ownerGone?: (agent: string) => boolean | Promise<boolean>;
	signal?: AbortSignal;
}

export interface Swept {
	/** The names of the computers deleted. */
	deleted: string[];
	/** How many were left, their deadline still ahead. */
	kept: number;
	/** For a provider with sweepLeftovers: what its computers left behind that the sweep removed, by name. */
	leftovers?: string[];
}

/** Clock skew a deadline may carry past now + maxLifetimeMs before it counts as unreadable. */
const SKEW_MS = 60_000;

/** Whether a run's computer's deadline is ahead of at, and readable: no later than at + cap. */
const alive = (deadline: Date | undefined, at: number, cap: number): boolean => {
	const time = deadline instanceof Date ? deadline.getTime() : Number.NaN;
	return !Number.isNaN(time) && time > at && time <= at + cap;
};

/** Whether an agent's computer ends: its owner is gone, or it has been detached for longer than its idle TTL. */
async function ownerEnds(info: ComputerInfo, owner: { agent: string; idleTtlMs?: number }, at: number, ownerGone: SweepOptions["ownerGone"]): Promise<boolean> {
	if (ownerGone !== undefined && (await ownerGone(owner.agent)) === true) return true;
	const since = info.detachedAt instanceof Date ? info.detachedAt.getTime() : Number.NaN;
	return owner.idleTtlMs !== undefined && !Number.isNaN(since) && at - since >= owner.idleTtlMs;
}

/**
 * Deletes every computer the provider lists whose deadline has passed, or whose deadline is missing or unreadable
 * (fail closed); leaves the rest. A deadline more than the provider's maxLifetimeMs past now (with a minute for clock
 * skew) counts as unreadable: no computer the provider made can carry one. Only for a provider that declares lifetime
 * "janitor"; a caller runs it on a schedule. A computer that cannot be deleted does not stop the sweep: the result is
 * then an error naming it and what was deleted. A provider with sweepLeftovers then removes, with the same labels and
 * time, what its computers left behind (Docker: egress proxies and volumes whose computer is gone).
 *
 * An agent's computer (an owner label) is never deleted by a deadline: only when its owner is gone (ownerGone), or
 * once it has been detached for longer than its owner's idle TTL. One whose owner label cannot be read is kept. A
 * provider that declares persistence is swept for its agents' computers alone under lifetime "vendor", since no vendor
 * ends them.
 */
export async function sweep(provider: ComputerProvider, { labels = {}, now, ownerGone, signal }: SweepOptions = {}): Promise<Result<Swept>> {
	const { lifetime, maxLifetimeMs, persistence } = provider.capabilities();
	if (lifetime !== "janitor" && persistence === undefined) {
		return fail("refused", `the ${provider.id} provider declares lifetime "${lifetime}": its vendor ends its computers itself, so the janitor does not sweep them`);
	}
	if (now !== undefined && !(now instanceof Date && !Number.isNaN(now.getTime()))) return fail("invalid", "now must be a Date");
	const at = (now ?? new Date()).getTime();
	// A provider that declares no cap has no over-cap line: the janitor never deletes on a rule it cannot read.
	const cap = Number.isSafeInteger(maxLifetimeMs) && maxLifetimeMs > 0 ? maxLifetimeMs + SKEW_MS : Number.POSITIVE_INFINITY;
	if (signal?.aborted) return fail("aborted", "the sweep was aborted before it began");
	const listed = await provider.list(labels, { signal });
	if (!listed.ok) return listed;
	const deleted: string[] = [];
	const failed: string[] = [];
	let firstError: ComputerError | undefined;
	let kept = 0;
	for (const info of listed.value) {
		const { ref, deadline } = info;
		const owned = ownerOf(info.labels);
		// An agent's computer goes by its owner's rules, never a deadline; a run's goes by its deadline, and under lifetime
		// "vendor" its vendor ends it. An owner label the janitor cannot read keeps the computer.
		const ends = !owned.ok ? false : owned.value !== undefined ? await ownerEnds(info, owned.value, at, ownerGone) : lifetime === "janitor" ? !alive(deadline, at, cap) : false;
		if (!ends) {
			kept++;
			continue;
		}
		if (signal?.aborted) return fail("aborted", `the sweep was aborted; it had deleted ${deleted.join(", ") || "none"}`);
		const released = await provider.release(ref, "delete");
		if (released.ok) deleted.push(ref.name);
		else {
			firstError ??= released.error;
			failed.push(`${ref.name}: ${released.error.message}`);
		}
	}
	// Then what the computers left behind (a provider's own parts whose computer is gone), after the computers, since a
	// computer released above takes its own parts with it.
	let leftovers: string[] | undefined;
	let leftBehind: string | undefined;
	if (provider.sweepLeftovers) {
		if (signal?.aborted) return fail("aborted", `the sweep was aborted; it had deleted ${deleted.join(", ") || "none"}`);
		const left = await provider.sweepLeftovers({ labels, now: new Date(at), signal });
		if (left.ok) leftovers = left.value;
		else {
			firstError ??= left.error;
			leftBehind = left.error.message;
		}
	}
	if (firstError) {
		const words = [...(failed.length > 0 ? [`could not delete ${failed.join("; ")}`] : []), ...(leftBehind === undefined ? [] : [`could not remove what its computers left behind: ${leftBehind}`])];
		return failAs(firstError, `the sweep deleted ${deleted.join(", ") || "none"} but ${words.join(", and ")}`);
	}
	return ok({ deleted, kept, ...(leftovers === undefined ? {} : { leftovers }) });
}

export interface ReleasedOlder {
	/** The run's computers deleted: each with a lower epoch, and each that carries no epoch it can read. */
	released: ComputerRef[];
	/** The agents' computers among them, detached instead of deleted: their state kept for the claim to attach. */
	detached: ComputerRef[];
	/** The run's computers of this very epoch, left as they are. */
	kept: ComputerRef[];
	/** Of those released, each whose epoch label was missing or not an epoch, with what was wrong: it could not prove it is current. */
	unproven: Array<{ ref: ComputerRef; problem: string }>;
}

/**
 * A takeover's first step, for a new claim of run at epoch: deletes every computer of the run labelled with a lower
 * epoch, and every one of the run whose epoch label is missing or unreadable, since it cannot prove it is current. The
 * run's computers of this epoch are kept. A computer of the run with a higher epoch means a later claim holds the run:
 * the call is refused as fenced before it releases anything. It lists by the run's label, and still holds each listed
 * computer to it: a computer of another run is never touched, whatever list gives.
 *
 * Every release is attempted. When any fails, the result is an error naming each computer left and why, and what was
 * released: a partial cleanup is never a success, so a caller revokes nothing and mounts nothing after it. An aborted
 * call starts no further release and says which ran. It revokes no mount: that is the root helper's, inside the
 * computer, and a deleted computer holds none.
 *
 * An agent's computer (an owner label, readable or not) of a lower epoch is detached, never deleted: its state is the
 * agent's, and the new claim attaches it.
 */
export async function releaseOlder(provider: ComputerProvider, run: string, epoch: number, { signal }: CallContext = {}): Promise<Result<ReleasedOlder>> {
	const problem = runProblem(run) ?? epochProblem(epoch);
	if (problem !== undefined) return fail("invalid", problem);
	const what = `the release of run ${JSON.stringify(run)}'s computers below epoch ${epoch}`;
	if (signal?.aborted) return fail("aborted", `${what} was aborted before it began`);
	const listed = await provider.list({ [RUN_LABEL]: run }, { signal });
	if (!listed.ok) return failAs(listed.error, `could not list run ${JSON.stringify(run)}'s computers: ${listed.error.message}`);

	const older: Array<{ ref: ComputerRef; epoch?: number; owned: boolean }> = [];
	const kept: ComputerRef[] = [];
	const unproven: ReleasedOlder["unproven"] = [];
	const newer: string[] = [];
	for (const { ref, labels } of listed.value) {
		if (labels?.[RUN_LABEL] !== run) continue;
		const read = epochOf(labels);
		const owner = ownerOf(labels);
		const owned = !owner.ok || owner.value !== undefined;
		if (!read.ok) {
			older.push({ ref, owned });
			unproven.push({ ref, problem: read.error.message });
		} else if (read.value < epoch) older.push({ ref, epoch: read.value, owned });
		else if (read.value === epoch) kept.push(ref);
		else newer.push(`${ref.name} at epoch ${read.value}`);
	}
	if (newer.length > 0) {
		return fail("refused", `fenced: run ${JSON.stringify(run)} has ${newer.join(", ")}, above this claim's epoch ${epoch}; a later claim holds the run, so nothing was released`);
	}

	const released: ComputerRef[] = [];
	const detached: ComputerRef[] = [];
	const failed: string[] = [];
	let firstError: ComputerError | undefined;
	const done = () =>
		`it released ${released.map((ref) => ref.name).join(", ") || "none"}${detached.length > 0 ? `, detached the agents' ${detached.map((ref) => ref.name).join(", ")}` : ""}${failed.length > 0 ? `, and could not release ${failed.join("; ")}` : ""}`;
	for (const [at, { ref, epoch: was, owned }] of older.entries()) {
		if (signal?.aborted) {
			const left = older.slice(at).map((one) => one.ref.name);
			return fail("aborted", `${what} was aborted: ${done()}; it did not start ${left.join(", ")}`);
		}
		const result = await provider.release(ref, owned ? "detach" : "delete");
		if (result.ok) (owned ? detached : released).push(ref);
		else {
			firstError ??= result.error;
			failed.push(`${ref.name} (${was === undefined ? "no epoch" : `epoch ${was}`}): ${result.error.message}`);
		}
	}
	if (firstError) return failAs(firstError, `${what} is incomplete: ${done()}`);
	return ok({ released, detached, kept, unproven });
}
