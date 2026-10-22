import type { BoxFacts } from "./box/box.ts";

/** What a box's facts say once every absent field is read the way that fails closed. */
export type FactsReading = {
	/** `true` only when the facts say `fuse: true`. Absent is `false`. */
	readonly fuse: boolean;
	/** `unknown` when the facts do not say. A caller that needs `none` or an allowlist must refuse `unknown`. */
	readonly network: "open" | "none" | "allowlist" | "unknown";
	/** `unknown` when the facts do not say. An empty list means the provider made the box with no exposed port. */
	readonly ports: BoxFacts["ports"] | "unknown";
	/** `true` only when the facts list no port. A box whose ports are unknown is not one. */
	readonly noPortExposed: boolean;
	/** `true` only when the facts say the Yama setting is 1 or more. Absent is not an assumption of 1. */
	readonly ptraceAtLeast1: boolean;
	readonly diskGb: number | null;
	/** The start the facts name, or `null`: a receipt then falls back to the time the create call answered. */
	readonly startedAt: string | null;
};

/**
 * The one reading of the optional facts: an absent field never grants anything. A consumer that chooses or admits a box
 * asks this, so a provider that does not report a fact can only be refused, never trusted.
 */
export function readFacts(facts: BoxFacts): FactsReading {
	return {
		fuse: facts.fuse === true,
		network: facts.network ?? "unknown",
		ports: facts.ports ?? "unknown",
		noPortExposed: facts.ports !== undefined && facts.ports.length === 0,
		ptraceAtLeast1: facts.ptraceScope !== undefined && facts.ptraceScope >= 1,
		diskGb: facts.diskGb ?? null,
		startedAt: facts.startedAt ?? null,
	};
}
