// Small readings every hosted vendor makes of what its API answers: a whole number, a value in words, a date, a size,
// and the drift list a read-back builds.
import { show } from "../drift.js";
import type { Machine } from "../host.js";

export { show };

/** A host name, as a vendor's domain option is one: DNS labels and a top-level name of letters. */
export const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const isWhole =(value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** The drift of one read-back: mismatch adds one sentence ("field: declared X, read back Y") to found. */
export function driftOf(): { found: string[]; mismatch(field: string, declared: unknown, actual: unknown): void } {
	const found: string[] = [];
	return { found, mismatch: (field, declared, actual) => void found.push(`${field}: declared ${show(declared)}, read back ${show(actual)}`) };
}

/** A time the vendor reports: a Date, an ISO string, or a whole number of ms (or seconds); undefined when it is none of them. */
export function dateOf(value: unknown, unit: "ms" | "s" = "ms"): Date | undefined {
	const at = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : isWhole(value) ? value * (unit === "s" ? 1000 : 1) : Number.NaN;
	return Number.isNaN(at) ? undefined : new Date(at);
}

/** A machine's size from the vendor's cpu count and memory in GiB; undefined when it reports neither. */
export function sizeOf(cpus: unknown, memoryGib: unknown): Machine["size"] | undefined {
	if (!isWhole(cpus) && !isWhole(memoryGib)) return undefined;
	return { ...(isWhole(cpus) ? { cpus } : {}), ...(isWhole(memoryGib) ? { memoryMb: memoryGib * 1024 } : {}) };
}
