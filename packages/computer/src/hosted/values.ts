// Small readings every hosted vendor makes of what its API answers: a whole number, a value in words, a date.
import { show } from "../drift.js";
import type { ComputerSpec, Refusal } from "../provider.js";

/** A host name, as a vendor's domain option is one: DNS labels and a top-level name of letters. */
export const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const isWhole =(value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** A vendor whose computer has its image's size: a spec's cpus or memoryMb, refused in words (computer: "an E2B computer"). */
export function sizeRefusals(spec: Partial<ComputerSpec>, computer: string, image: string): Refusal[] {
	return (["cpus", "memoryMb"] as const).filter((field) => spec[field] !== undefined).map((field) => ({ field, message: `${computer} has the size of its ${image}: name a ${image} of the size you need, not ${field}` }));
}

/** A time the vendor reports: a Date, an ISO string, or a whole number of ms (or seconds); undefined when it is none of them. */
export function dateOf(value: unknown, unit: "ms" | "s" = "ms"): Date | undefined {
	const at = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : isWhole(value) ? value * (unit === "s" ? 1000 : 1) : Number.NaN;
	return Number.isNaN(at) ? undefined : new Date(at);
}
