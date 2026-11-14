// What every hosted vendor's constructor checks of its options, once: a required text, an https URL, a host name, the
// slice of an SDK it was handed, the package it imports when none was handed, and the timeouts that apply to its host.
import type { HostFacts } from "../host.js";
import type { HostedTimeouts } from "./provider.js";

/** The adapter's bounds, under a vendor's own (facts.timeouts) and the caller's (options.timeouts). */
export const TIMEOUT_DEFAULTS: HostedTimeouts = {
	requestMs: 30_000,
	createMs: 120_000,
	uploadMs: 120_000,
	execMs: 60_000,
	helloMs: 30_000,
	probeMs: 30_000,
	listMs: 60_000,
	goneMs: 120_000,
	pollMs: 1_000,
	listedMs: 15_000,
	listedStableMs: 1_000,
	mountMs: 120_000,
};

/** One timeout as it applies to a host: the adapter writes the merged set to facts.timeouts, so a host reads it at call time. */
export const timeoutOf = (facts: Pick<HostFacts, "timeouts">, key: keyof HostedTimeouts): number => facts.timeouts?.[key] ?? TIMEOUT_DEFAULTS[key];

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A non-empty text, or the error in message (which never holds the value: it may be a key). */
export function requireText(value: unknown, message: string): string {
	if (typeof value !== "string" || value === "") throw new Error(message);
	return value;
}

/** An https URL, with no query or fragment unless bare is false; the error in message otherwise. */
export function httpsUrl(value: unknown, message: string, { bare = true }: { bare?: boolean } = {}): URL {
	const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined;
	if (url === undefined || url.protocol !== "https:" || (bare && (url.search !== "" || url.hash !== ""))) throw new Error(message);
	return url;
}

/** A DNS host name of two labels or more, or an error that names it and an example. */
export function hostName(value: unknown, what: string, example: string): string {
	if (typeof value !== "string" || !DOMAIN.test(value)) throw new Error(`${what} must be a host name such as ${example}, not ${JSON.stringify(value)}`);
	return value;
}

/** Why a value is not the slice of an SDK a vendor uses: the dotted paths of the functions it lacks, in words; undefined when it has them all. */
export function sliceProblem(sdk: unknown, paths: readonly string[], what: string): string | undefined {
	const lacks = paths.filter((path) => typeof path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown> | null | undefined)?.[key], sdk) !== "function");
	return lacks.length === 0 ? undefined : `${what}; it lacks ${lacks.join(", ")}`;
}

/** The host's own package, imported by a name no bundler or type checker resolves from this package. */
export const loadPackage = <Module>(name: string): Promise<Module> => import(name) as Promise<Module>;
