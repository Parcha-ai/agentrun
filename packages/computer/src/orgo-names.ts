// What every Orgo provider (the Linux desktop with computerd, orgo.ts, and the Windows and macOS desktops Orgo's API
// answers, orgo-desktop.ts) shares about a computer with nothing run inside it: its name, which carries the run, the
// epoch and the janitor's deadline; the labels a spec may give; Orgo's record of a computer; and the labels file each
// keeps in the computer, the truth attach reads.
import { COMPUTER_LABEL } from "./drift.js";
import { EPOCH_LABEL, IDLE_TTL_LABEL, OWNER_LABEL, OWNER_SERVER_LABEL, ownerLabels, ownerOf, RUN_LABEL, runHash } from "./labels.js";
import type { ComputerOwner, ComputerRef } from "./provider.js";

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
}

/** Where the provider keeps its agents' computers' labels. Each call may be sync or async. */
export interface OrgoLedger {
	put(entry: OrgoLedgerEntry): void | Promise<void>;
	get(id: string): OrgoLedgerEntry | undefined | Promise<OrgoLedgerEntry | undefined>;
	list(): OrgoLedgerEntry[] | Promise<OrgoLedgerEntry[]>;
	remove(id: string): void | Promise<void>;
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
