// What every Orgo provider (the Linux desktop with computerd, orgo.ts, and the Windows and macOS desktops Orgo's API
// answers, orgo-desktop.ts) shares about a computer with nothing run inside it: its name, which carries the run, the
// epoch and the janitor's deadline; the labels a spec may give; Orgo's record of a computer; and the labels file each
// keeps in the computer, the truth attach reads.
import { COMPUTER_LABEL } from "./drift.js";
import { EPOCH_LABEL, IDLE_TTL_LABEL, OWNER_LABEL, OWNER_SERVER_LABEL, ownerLabels, ownerOf, RUN_LABEL, runHash } from "./labels.js";
import type { ComputerClaim, ComputerOwner, ComputerRef } from "./provider.js";
import { failFor, ok, type Result, vendorFail } from "./result.js";

const fail = failFor("orgo");

/** The longest name Orgo holds. */
export const NAME_MAX = 80;
/**
 * A name of this provider's making: computer-<12 hex>, then either -o<the owner's hash> (an agent's own computer, which
 * outlives runs and has no deadline) or the run label's hash, the epoch label and the deadline (base 36 s).
 */
const NAME = /^computer-([0-9a-f]{12})(?:-o([a-z2-7]{16})|(?:-r([a-z2-7]{16}))?(?:-e(0|[1-9][0-9]{0,15}))?(?:-d([0-9a-z]{1,11}))?)$/;

/** The labels file's deadline, and its most, for an agent's own computer: it has none. */
export const NO_DEADLINE = "none";
/**
 * The hash an agent's own computer's name carries: of its owner label's value, agent:<id>, and of its server's after a
 * NUL (which neither may hold) when the owner names one, so one agent id on two servers has two hashes.
 */
export const ownerHashOf = (owner: ComputerOwner) => {
	const labels = ownerLabels(owner);
	const server = labels[OWNER_SERVER_LABEL];
	return runHash(server === undefined ? (labels[OWNER_LABEL] as string) : `${labels[OWNER_LABEL]}\0${server}`);
};
/** The owner hash these labels say (its owner's and server's, ownerHashOf), or "" when they carry no readable owner. */
export function ownerHashOfLabels(labels: Record<string, string>): string {
	const owner = ownerOf(labels);
	return owner.ok && owner.value !== undefined ? ownerHashOf(owner.value) : "";
}

/**
 * An agent's own computer as the provider's ledger keeps it (the server's computer ledger, as the phone harness's
 * sessions are kept): its labels, the owner's and the claim's among them, and when it was detached. Orgo holds no label
 * of a computer, and a detached one is never woken to read its labels file, so list reads these instead.
 */
export interface OrgoLedgerEntry {
	/** Orgo's computer id. */
	id: string;
	labels: Record<string, string>;
	/** When the computer was detached, ISO time; absent while a run holds it. */
	detachedAt?: string;
	/**
	 * While an attach or detach holds the computer (takeEntry to settleEntry), when its current step began, ISO time, and
	 * what it is doing: no other attach or detach takes it meanwhile.
	 */
	busy?: { since: string; doing: string };
}

/** Where the provider keeps its agents' computers' labels. Each call may be sync or async. */
export interface OrgoLedger {
	put(entry: OrgoLedgerEntry): void | Promise<void>;
	get(id: string): OrgoLedgerEntry | undefined | Promise<OrgoLedgerEntry | undefined>;
	list(): OrgoLedgerEntry[] | Promise<OrgoLedgerEntry[]>;
	remove(id: string): void | Promise<void>;
	/**
	 * entry put in place of `was` only while the kept entry is still `was` as it was read, in one step no other writer
	 * splits: true when it was put; false, with nothing written, when the entry changed since or is gone. Attach takes an
	 * agent's computer under a claim with it (takeEntry), so two claims that read one entry never both write it.
	 */
	swap(was: OrgoLedgerEntry, entry: OrgoLedgerEntry): boolean | Promise<boolean>;
}

/** An entry as one string, its keys and its labels' keys sorted, so two entries compare by what they hold alone. */
const canonical = (entry: OrgoLedgerEntry) =>
	JSON.stringify(entry, (_key, value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value));

/** Whether two ledger entries hold the same: the same id, labels and fields, in any order. */
export const sameEntry = (a: OrgoLedgerEntry, b: OrgoLedgerEntry) => canonical(a) === canonical(b);

/** How often an attach reads an agent's computer's ledger entry again when another writer changed it under its swap. */
const SWAP_TRIES = 5;

/** A ledger call's value, or the ledger's failure in words: a provider's calls answer, never throw. */
async function ledgerCall<T>(what: "read" | "written", call: () => T | Promise<T>): Promise<Result<T>> {
	try {
		return ok(await call());
	} catch (error) {
		return vendorFail("orgo", `the ledger of agents' computers could not be ${what}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The run and epoch these labels say, in words, for a claim that lost its computer to another. */
export const holderOf = (labels: Record<string, string>) => `run ${JSON.stringify(labels[RUN_LABEL] ?? "")} at epoch ${labels[EPOCH_LABEL] ?? "none"}`;

/** How long a busy marker keeps every other attach and detach off the computer: the most one step of an attach or detach
 *  (a resume, a suspend, a stop, a daemon's replacement) is waited on, since each step renews it. A marker older is an
 *  attach or detach that died, and is taken over. */
export const BUSY_MS = 15 * 60_000;

/** Whether an entry carries a busy marker still in force. */
const busyNow = (entry: OrgoLedgerEntry) => entry.busy !== undefined && Date.now() - Date.parse(entry.busy.since) < BUSY_MS;

/**
 * An agent's computer's ledger entry as one attach, detach or delete under a claim holds it, from takeEntry to
 * settleEntry (a delete: until it forgets the entry): the entry as last written by it, its busy marker in force. One rule
 * keeps them all apart: nothing is done to the computer but under this marker, renewed (renewEntry) right before each
 * step that wakes, stops, suspends or replaces what runs in it, and only its holder settles the entry, every write a swap
 * from the entry it last wrote. A holder whose swap finds the entry changed (its marker went stale and another took it,
 * or it was removed) has lost it: it does nothing more to the computer, and its settle is an error, never a success.
 */
export interface EntryLease {
	entry: OrgoLedgerEntry;
}

/**
 * An agent's computer's ledger entry taken, before anything is done to the computer, for an attach (under `claim`, held
 * to it, claimProblem) or a detach (no claim): read, refused while another holds it busy, then swapped to carry a busy
 * marker saying `doing` (and the claim's run and epoch) only while it is still the entry read. Two claims of one run that
 * read the same entry never both write it: the one whose swap finds it changed reads it again and is held to the claim
 * again, so a lower epoch never writes over a higher one and is refused (fenced). When it was detached is kept until the
 * holder settles it (settleEntry), so an attach that fails leaves it detached. `only`: the entry is taken only while it
 * carries exactly the claim's run and epoch (a delete under a claim, which never takes a computer another claim has).
 */
export async function takeEntry(ledger: OrgoLedger, ref: ComputerRef, ownerHash: string, claim: ComputerClaim | undefined, doing: string, { only = false } = {}): Promise<Result<EntryLease>> {
	for (let tries = 1; ; tries++) {
		const read = await ledgerCall("read", () => ledger.get(ref.id));
		if (!read.ok) return read;
		const entry = read.value;
		if (entry === undefined) return fail("refused", lostEntry(ref.name));
		if (busyNow(entry)) return fail("refused", `${ref.name} is busy (${entry.busy?.doing}): try again in a moment`);
		if (claim !== undefined) {
			const fenced = only ? notClaims(ref.name, entry, claim) : claimProblem(ref.name, ownerHash, entry, claim);
			if (fenced !== undefined) return fail("refused", fenced);
		}
		// A busy marker older than BUSY_MS is an attach or detach that died: this one takes the entry over.
		const { busy: _stale, ...unmarked } = entry;
		const taken: OrgoLedgerEntry = {
			...unmarked,
			...(claim === undefined ? {} : { labels: { ...entry.labels, [RUN_LABEL]: claim.run, [EPOCH_LABEL]: String(claim.epoch) } }),
			busy: { since: new Date().toISOString(), doing },
		};
		const swapped = await ledgerCall("written", () => ledger.swap(entry, taken));
		if (!swapped.ok) return swapped;
		if (swapped.value) return ok({ entry: taken });
		if (tries >= SWAP_TRIES) return fail("refused", `${ref.name}'s ledger entry changed under each of ${SWAP_TRIES} tries to take it; nothing changed`);
	}
}

/** Why an entry that does not carry exactly `claim`'s run and epoch is not that claim's to delete, in words; else undefined. */
const notClaims = (name: string, entry: OrgoLedgerEntry, claim: ComputerClaim) =>
	entry.labels[RUN_LABEL] === claim.run && entry.labels[EPOCH_LABEL] === String(claim.epoch)
		? undefined
		: `fenced: ${name} carries ${holderOf(entry.labels)}, not this claim's (${holderOf({ [RUN_LABEL]: claim.run, [EPOCH_LABEL]: String(claim.epoch) })}): another claim has it, so it is left as it is`;

/** Why a holder's swap found its entry changed, in words: it has lost the computer, which it leaves as it is. */
const lostLease = (ref: ComputerRef, lease: EntryLease) =>
	`fenced: ${ref.name}'s ledger entry changed while this ${lease.entry.busy?.doing ?? "attach"} (${holderOf(lease.entry.labels)}) held it (its busy marker went stale and another took it, or it was removed): the computer is left as it is`;

/**
 * The held entry's busy marker renewed, saying `doing` from now, only while the entry is still the one this holder last
 * wrote: right before each step that wakes, stops, suspends or replaces what runs in the computer, so a holder that lost
 * the entry never does that step to a computer another holds.
 */
export async function renewEntry(ledger: OrgoLedger, ref: ComputerRef, lease: EntryLease, doing: string): Promise<Result<void>> {
	const renewed: OrgoLedgerEntry = { ...lease.entry, busy: { since: new Date().toISOString(), doing } };
	const swapped = await ledgerCall("written", () => ledger.swap(lease.entry, renewed));
	if (!swapped.ok) return swapped;
	if (!swapped.value) return fail("refused", lostLease(ref, lease));
	lease.entry = renewed;
	return ok(undefined);
}

/**
 * The held entry settled by its holder alone: its busy marker cleared, with `settle` applied (an attach marks it held, no
 * longer detached; a detach marks it detached), swapped only while the entry is still the one this holder last wrote. A
 * swap that finds it changed is an error: the holder lost the entry, and its attach or detach does not answer ok.
 */
export async function settleEntry(ledger: OrgoLedger, ref: ComputerRef, lease: EntryLease, settle: (entry: OrgoLedgerEntry) => OrgoLedgerEntry = (entry) => entry): Promise<Result<void>> {
	const { busy: _done, ...cleared } = lease.entry;
	const settled = settle(cleared);
	const swapped = await ledgerCall("written", () => ledger.swap(lease.entry, settled));
	if (!swapped.ok) return swapped;
	if (!swapped.value) return fail("refused", lostLease(ref, lease));
	lease.entry = settled;
	return ok(undefined);
}

/** `done`, or, where the settle after it failed, that failure: with done's own words first when done had failed too. */
export function andSettled<T>(done: Result<T>, settled: Result<void>): Result<T> {
	if (settled.ok) return done;
	return done.ok ? settled : fail(done.error.code, `${done.error.message}; and ${settled.error.message}`);
}

/**
 * `work` for one computer, taken in turn with every other of this process's for the same key (`turns` keeps each key's
 * last): one starts once the one before it has settled, whatever its outcome. `work` is told whether it waited for one,
 * so it reads again what that one may have changed.
 */
export function inTurn<T>(turns: Map<string, Promise<unknown>>, key: string, work: (waited: boolean) => Promise<T>): Promise<T> {
	const waiting = turns.get(key);
	const turn = (waiting ?? Promise.resolve()).then(() => work(waiting !== undefined));
	const settled = turn.then(
		() => undefined,
		() => undefined,
	);
	turns.set(key, settled);
	void settled.then(() => {
		if (turns.get(key) === settled) turns.delete(key);
	});
	return turn;
}

/**
 * What list() gives an agent's own computer, with nothing run inside, by filter: owned, with its ledger entry's labels
 * (the owner's and the claim's run and epoch among them), its owner, and when it was detached. With no entry its labels
 * are unknown: it is listed owned with no labels and no owner, to an unfiltered list alone, and the janitor, which never
 * deletes a computer whose owner it cannot read, keeps it. undefined when the computer does not carry every label of
 * the filter.
 */
export function ownedListing(entry: OrgoLedgerEntry | undefined, filter: Record<string, string>): { labels: Record<string, string>; owned: true; owner?: ComputerOwner; detachedAt?: Date } | undefined {
	if (entry === undefined) return Object.keys(filter).length === 0 ? { labels: {}, owned: true } : undefined;
	if (!Object.entries(filter).every(([key, value]) => entry.labels[key] === value)) return undefined;
	const detached = entry.detachedAt === undefined ? Number.NaN : Date.parse(entry.detachedAt);
	return { labels: { ...entry.labels }, owned: true, ...ownerReadBack(entry.labels), ...(Number.isNaN(detached) ? {} : { detachedAt: new Date(detached) }) };
}

/** { owner } when these labels carry a readable owner label, else nothing: for a listing or attach's read-back. */
export function ownerReadBack(labels: Record<string, string>): { owner?: ComputerOwner } {
	const owner = ownerOf(labels);
	return owner.ok && owner.value !== undefined ? { owner: owner.value } : {};
}

/** Why an agent's computer is neither attached nor detached with no ledger entry, in words: its labels are unknown. */
export const lostEntry = (name: string) =>
	`${name} is an agent's computer with no entry in the provider's ledger, so its owner and labels are unknown: it is neither attached nor detached; release it with delete`;

/**
 * Why a run cannot take this computer under claim, in words, or undefined when it can: a run's computer (no owner) is
 * its run's, never claimed; a claim of the same run below the epoch the computer carries is fenced. Nothing changes.
 */
export function claimProblem(name: string, ownerHash: string | undefined, entry: OrgoLedgerEntry | undefined, claim: { run: string; epoch: number }): string | undefined {
	if (ownerHash === undefined) return `${name} is a run's computer, which belongs to its run: no other run takes it under a claim`;
	const carried = entry?.labels ?? {};
	const epoch = Number(carried[EPOCH_LABEL]);
	if (carried[RUN_LABEL] === claim.run && Number.isSafeInteger(epoch) && claim.epoch < epoch) {
		return `fenced: ${name} is held by run ${JSON.stringify(claim.run)} at epoch ${epoch}, above this claim's ${claim.epoch}; nothing changed`;
	}
	return undefined;
}

/** A ledger in this process's memory: the default, enough for one process that makes and ends its computers. */
export function orgoMemoryLedger(): OrgoLedger {
	const entries = new Map<string, OrgoLedgerEntry>();
	return {
		put: (entry) => void entries.set(entry.id, structuredClone(entry)),
		get: (id) => structuredClone(entries.get(id)),
		list: () => [...entries.values()].map((entry) => structuredClone(entry)),
		remove: (id) => void entries.delete(id),
		swap: (was, entry) => {
			const kept = entries.get(entry.id);
			if (kept === undefined || was.id !== entry.id || !sameEntry(kept, was)) return false;
			entries.set(entry.id, structuredClone(entry));
			return true;
		},
	};
}
/** An Orgo computer's id. */
export const COMPUTER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** What the labels file holds. */
export interface LabelsFile {
	name: string;
	labels: Record<string, string>;
	deadline: string;
	maxDeadline: string;
	image: string;
	cpus?: number;
	memoryMb?: number;
}

/** What Orgo reports of a computer, as far as a provider reads it. */
export interface OrgoComputer {
	id: string;
	name: string;
	status: string;
	os?: string;
	workspace_id?: string;
	project_id?: string;
	ends_at?: string | null;
	created_at?: string;
}

export const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));

/**
 * The name of a computer with these labels: computer-<hex>, then -r<the run label's hash> and -e<the epoch label> when
 * the labels carry a run and an epoch that is one, then -d<the deadline> when given: whole seconds since the epoch,
 * rounded up (never before init's own), in base 36, the janitor's deadline. Only those: a name is no place for a label's
 * value. Everything but the deadline is the name's stable part, which a rename on extend keeps. An agent's own computer
 * (owner) is computer-<hex>-o<the owner label's hash> alone, with no deadline for the janitor to end it by: the run and
 * the epoch of the claim that holds it change with each attach, so they are in the ledger (OrgoLedger), not the name.
 */
export function orgoName(labels: Record<string, string>, hex: string, deadline?: Date, owner?: ComputerOwner): string {
	if (owner !== undefined) return `computer-${hex}-o${ownerHashOf(owner)}`;
	const run = labels[RUN_LABEL];
	const epoch = labels[EPOCH_LABEL];
	const stable = `computer-${hex}${typeof run === "string" && run !== "" ? `-r${runHash(run)}` : ""}${typeof epoch === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(epoch) ? `-e${epoch}` : ""}`;
	return deadline === undefined ? stable : withDeadline(stable, deadline);
}

/** A name's stable part with this deadline. */
export function withDeadline(stable: string, deadline: Date): string {
	return `${stable}-d${Math.ceil(deadline.getTime() / 1000).toString(36)}`;
}

/** What a name of this provider's making says, or undefined for any other name: its stable part, and its deadline. */
export function nameParts(name: unknown): { hex: string; owner?: string; run?: string; epoch?: string; stable: string; deadline?: Date } | undefined {
	const match = typeof name === "string" ? NAME.exec(name) : null;
	if (match === null) return undefined;
	const seconds = match[5] === undefined ? Number.NaN : Number.parseInt(match[5], 36);
	return {
		hex: match[1] as string,
		...(match[2] ? { owner: match[2] } : {}),
		...(match[3] ? { run: match[3] } : {}),
		...(match[4] !== undefined ? { epoch: match[4] } : {}),
		stable: (name as string).replace(/-d[0-9a-z]+$/, ""),
		...(Number.isSafeInteger(seconds) ? { deadline: new Date(seconds * 1000) } : {}),
	};
}

/** Whether two names are one computer's: their stable parts are the same (the deadline moves with extend). */
export const sameComputer = (a: string, b: string) => nameParts(a)?.stable !== undefined && nameParts(a)?.stable === nameParts(b)?.stable;

export function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key === "" || key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)} must be a non-empty name, and neither holds a NUL byte`;
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	if (key === OWNER_LABEL || key === OWNER_SERVER_LABEL || key === IDLE_TTL_LABEL) return `the label ${key} is the provider's own: a spec gives its owner, and the provider labels the computer`;
	return undefined;
}

export function filterProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (typeof value !== "string" || key === "" || key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)} must be a non-empty name and a string, with no NUL byte`;
	}
	return undefined;
}

/** Why ref is not an Orgo computer's ref, or undefined. */
export function refProblem(ref: ComputerRef): string | undefined {
	if (typeof ref?.name !== "string" || nameParts(ref.name) === undefined) return `${String(ref?.name)} is not the name of an Orgo computer of this provider (computer-<12 hex digits>...)`;
	if (typeof ref.id !== "string" || !COMPUTER_ID.test(ref.id)) return `${String(ref.id)} is not an Orgo computer id`;
	return undefined;
}

/** The labels file at path as written, or why it is not. */
export function labelsOf(text: string, path: string): LabelsFile | string {
	try {
		const value = JSON.parse(text) as Partial<LabelsFile> | null;
		if (typeof value?.name === "string" && typeof value.labels === "object" && value.labels !== null && typeof value.deadline === "string" && typeof value.maxDeadline === "string" && typeof value.image === "string") {
			return value as LabelsFile;
		}
	} catch {
		// Said below.
	}
	return `the labels file ${path} is not the one create writes`;
}
