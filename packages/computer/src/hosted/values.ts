// Small readings every hosted vendor makes of what its API answers: a whole number, a value in words, a date.
import { show } from "../drift.js";

export { show };

export const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** A time the vendor reports: a Date, an ISO string, or a whole number of ms (or seconds); undefined when it is none of them. */
export function dateOf(value: unknown, unit: "ms" | "s" = "ms"): Date | undefined {
	const at = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : isWhole(value) ? value * (unit === "s" ? 1000 : 1) : Number.NaN;
	return Number.isNaN(at) ? undefined : new Date(at);
}
