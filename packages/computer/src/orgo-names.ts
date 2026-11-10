// What every Orgo provider (the Linux desktop with computerd, orgo.ts, and the Windows and macOS desktops Orgo's API
// answers, orgo-desktop.ts) shares about a computer with nothing run inside it: its name, which carries the run, the
// epoch and the janitor's deadline; the labels a spec may give; Orgo's record of a computer; and the labels file each
// keeps in the computer, the truth attach reads.
import { createHash } from "node:crypto";
import { COMPUTER_LABEL } from "./drift.js";
import { EPOCH_LABEL, RUN_LABEL } from "./labels.js";
import type { ComputerRef } from "./provider.js";

/** The longest name Orgo holds. */
export const NAME_MAX = 80;
/** A name of this provider's making: computer-<12 hex>, the run label's hash, the epoch label, the deadline (base 36 s). */
const NAME = /^computer-([0-9a-f]{12})(?:-r([a-z2-7]{16}))?(?:-e(0|[1-9][0-9]{0,15}))?(?:-d([0-9a-z]{1,11}))?$/;
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

/** The run label's hash, as a name carries it: base32 of its sha256, lower case, 16 letters. */
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

/**
 * The name of a computer with these labels: computer-<hex>, then -r<the run label's hash> and -e<the epoch label> when
 * the labels carry a run and an epoch that is one, then -d<the deadline> when given: whole seconds since the epoch,
 * rounded up (never before init's own), in base 36, the janitor's deadline. Only those: a name is no place for a label's
 * value. Everything but the deadline is the name's stable part, which a rename on extend keeps.
 */
export function orgoName(labels: Record<string, string>, hex: string, deadline?: Date): string {
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
export function nameParts(name: unknown): { hex: string; run?: string; epoch?: string; stable: string; deadline?: Date } | undefined {
	const match = typeof name === "string" ? NAME.exec(name) : null;
	if (match === null) return undefined;
	const seconds = match[4] === undefined ? Number.NaN : Number.parseInt(match[4], 36);
	return {
		hex: match[1] as string,
		...(match[2] ? { run: match[2] } : {}),
		...(match[3] !== undefined ? { epoch: match[3] } : {}),
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
