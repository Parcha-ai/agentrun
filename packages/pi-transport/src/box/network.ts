import { BoxError, type BoxNetwork, type BoxPort, type BoxSpec } from "./box.ts";

/** A domain, or a wildcard domain with one leading `*.`. */
const DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const CIDR_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

const isCidr = (entry: string): boolean => {
	const m = CIDR_V4.exec(entry);
	return m !== null && m.slice(1, 5).every((octet) => Number(octet) <= 255) && Number(m[5]) <= 32;
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
