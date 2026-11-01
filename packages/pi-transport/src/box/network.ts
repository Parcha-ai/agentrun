import { BoxError, type BoxNetwork, type BoxPort, type BoxSpec } from "./box.ts";

/** A domain, or a wildcard domain with one leading `*.`. */
const DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const CIDR_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

const isCidr = (entry: string): boolean => {
	const m = CIDR_V4.exec(entry);
	return m?.slice(1, 5).every((octet) => Number(octet) <= 255) === true && Number(m[5]) <= 32;
};

/** What a spec's `network` asks for, checked: `open`, `none`, or an allowlist split into its domains and CIDRs. */
export type ParsedNetwork =
	| { readonly kind: "open" | "none" }
	| { readonly kind: "allowlist"; readonly domains: readonly string[]; readonly cidrs: readonly string[] };

/** `invalid` for an entry that is neither a domain, a wildcard domain nor an IPv4 CIDR, or for an empty list. */
export function parseNetwork(network: BoxNetwork | undefined): ParsedNetwork | BoxError {
	if (network === undefined || network === "open") return { kind: "open" };
	if (network === "none") return { kind: "none" };
	if (typeof network !== "object" || network === null || !Array.isArray(network.allow)) {
		return new BoxError("invalid", 'network is "open", "none" or { allow: [...] }');
	}
	if (network.allow.length === 0) return new BoxError("invalid", "an allowlist names at least one destination");
	const domains: string[] = [];
	const cidrs: string[] = [];
	for (const entry of network.allow) {
		if (typeof entry === "string" && isCidr(entry)) cidrs.push(entry);
		else if (typeof entry === "string" && DOMAIN.test(entry)) domains.push(entry.toLowerCase());
		else
			return new BoxError(
				"invalid",
				`the allowlist entry ${JSON.stringify(entry)} is not a domain, a wildcard domain or an IPv4 CIDR`,
			);
	}
	return { kind: "allowlist", domains, cidrs };
}

/** The ports a spec asks for, each with its kind; `invalid` for a port outside 1-65535, a repeat, or a kind that is not `https` or `tcp`. */
export function parsePorts(
	ports: readonly BoxPort[] | undefined,
): readonly { port: number; kind: "https" | "tcp" }[] | BoxError {
	const parsed: { port: number; kind: "https" | "tcp" }[] = [];
	for (const entry of ports ?? []) {
		const port = typeof entry === "number" ? entry : entry?.port;
		const kind = typeof entry === "number" ? "https" : entry?.kind;
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			return new BoxError("invalid", `${JSON.stringify(port)} is not a port from 1 to 65535`);
		if (kind !== "https" && kind !== "tcp")
			return new BoxError("invalid", `the port kind ${JSON.stringify(kind)} is not "https" or "tcp"`);
		if (parsed.some((p) => p.port === port)) return new BoxError("invalid", `the port ${port} is listed twice`);
		parsed.push({ port, kind });
	}
	return parsed;
}

/** The most mounts one spec may name. A box needs a few: a run's directory, a home, a read-only part of it, a socket. */
export const MAX_MOUNTS = 8;

/** A spec's mount, checked, with `readOnly` read as a boolean. */
export type ParsedMount = { readonly source: string; readonly target: string; readonly readOnly: boolean };

/** What is wrong with a mount's path, or `undefined`. Normal form makes two names for one place impossible. */
function mountPathProblem(path: unknown): string | undefined {
	if (typeof path !== "string" || !path.startsWith("/")) return "is not an absolute path";
	const segments = path.slice(1).split("/");
	if (segments.includes("..")) return "has a .. segment";
	// A comma, a quote or a line break would end a field of Docker's `--mount` value; a NUL cannot reach a program at all.
	if (/[",\p{Cc}]/u.test(path)) return "holds a comma, a double quote or a control character";
	if (path !== "/" && segments.some((segment) => segment === "" || segment === ".")) {
		return "is not in normal form (an empty or . segment, or a trailing /)";
	}
	return undefined;
}

/**
 * The mounts a spec asks for; `invalid` for a path that is not absolute and in normal form, a `..` segment, a target of `/`, a target
 * named twice, a `readOnly` that is not a boolean, or more than `MAX_MOUNTS`. The paths are kept as given: nothing resolves them.
 */
export function parseMounts(mounts: BoxSpec["mounts"]): readonly ParsedMount[] | BoxError {
	if (mounts === undefined) return [];
	if (!Array.isArray(mounts)) return new BoxError("invalid", "mounts is a list of { source, target, readOnly? }");
	if (mounts.length > MAX_MOUNTS) {
		return new BoxError("invalid", `a box takes at most ${MAX_MOUNTS} mounts, the spec names ${mounts.length}`);
	}
	const parsed: ParsedMount[] = [];
	for (const mount of mounts) {
		for (const field of ["source", "target"] as const) {
			const path: unknown = mount?.[field];
			const problem = mountPathProblem(path);
			if (problem !== undefined)
				return new BoxError("invalid", `the mount ${field} ${JSON.stringify(path)} ${problem}`);
		}
		if (mount.target === "/") return new BoxError("invalid", "a mount cannot cover the box's root, /");
		if (mount.readOnly !== undefined && typeof mount.readOnly !== "boolean") {
			return new BoxError("invalid", `the mount at ${mount.target} has a readOnly that is not true or false`);
		}
		if (parsed.some((p) => p.target === mount.target)) {
			return new BoxError("invalid", `the mount target ${mount.target} is named twice`);
		}
		parsed.push({ source: mount.source, target: mount.target, readOnly: mount.readOnly === true });
	}
	return parsed;
}

/**
 * The refusal for a provider that cannot bind a path of this machine into its boxes: a malformed `mounts` is `invalid`, as on every
 * provider, and any mount at all is `unsupported`, whatever its value. A provider calls it before it makes anything.
 */
export function refuseMounts(spec: BoxSpec, provider: string): BoxError | undefined {
	const mounts = parseMounts(spec.mounts);
	if (mounts instanceof BoxError) return mounts;
	if (mounts.length > 0) {
		return new BoxError("unsupported", `a ${provider} box takes no mounts: it cannot bind a path of this machine`);
	}
	return undefined;
}

/**
 * The refusal for a provider that has no network boundary of its own, no ports and no capabilities to give: `network` other than
 * `open` and any `ports` or `capabilities` are `unsupported`, whatever their value. `none` is allowed through when `allowNone`.
 */
export function refuseNetworkFields(spec: BoxSpec, provider: string, allowNone = false): BoxError | undefined {
	const network = parseNetwork(spec.network);
	if (network instanceof BoxError) return network;
	if (network.kind === "allowlist" || (network.kind === "none" && !allowNone)) {
		return new BoxError(
			"unsupported",
			`a ${provider} box cannot restrict its network to ${network.kind === "none" ? "none" : "an allowlist"}`,
		);
	}
	const ports = parsePorts(spec.ports);
	if (ports instanceof BoxError) return ports;
	if (ports.length > 0) return new BoxError("unsupported", `a ${provider} box cannot expose a port`);
	if ((spec.capabilities ?? []).length > 0) {
		return new BoxError("unsupported", `a ${provider} box cannot give ${spec.capabilities?.join(", ")}`);
	}
	return undefined;
}
