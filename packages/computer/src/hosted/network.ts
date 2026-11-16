// A hosted computer's network, as the shared adapter (./provider.ts) makes, records and reads it back. Its programs run
// in a network of their own whose loopback alone is up (isolation.ts), so "none" holds by itself. "open" and a host list
// go through one egress proxy per computer that init, still root and in the machine's own network, starts before it
// leaves it (`computerd init --own-network --network <form>`, daemon/internal/egress): the proxy runs as nobody, listens
// on a Unix socket only root and the tool user's group reach, and goes to the public internet alone, so the vendor's
// agent, metadata, the machine's own addresses and every private range stay out of reach; with a list, to its hosts
// alone, refused before any lookup. Init relays the programs' loopback port 3128 to it and tells them it is their proxy.
// The machine itself gets the vendor's egress for it. The form is recorded in a label, written to the policy file init
// leaves beside the socket, and both are read back.
import { allowOf, MAX_ALLOW } from "../docker/egress.js";
import { LISTED_PORTS } from "../docker/egress-proxy.js";
import { COMPUTER_LABEL, DAEMON_IN_COMPUTER } from "../drift.js";
import type { AllowCapability, NetworkForm, NetworkPolicy, NetworkSpec } from "../provider.js";

/** The label a computer whose network is open or a list carries: its form, as init was given it. None carries none. */
export const NETWORK_LABEL = `${COMPUTER_LABEL}.network`;

const EGRESS_DIR = `${DAEMON_IN_COMPUTER.slice(0, DAEMON_IN_COMPUTER.lastIndexOf("/"))}/egress`;
/** Where init's proxy listens, and where it writes the form it serves (daemon/internal/egress/serve.go). */
export const EGRESS_PROXY_SOCKET = `${EGRESS_DIR}/egress.sock`;
export const EGRESS_POLICY = `${EGRESS_DIR}/policy`;
/** The uid and gid init's proxy runs as, nobody (serve.go ProxyUser): no computer's user under open or a list may be it. */
export const EGRESS_PROXY_USER = 65534;
/** Init's relay on its programs' own loopback, which carries each connection to the proxy (daemon/internal/egress). */
export const EGRESS_RELAY = "127.0.0.1:3128"; // key-gate: loopback-rule the computer's own loopback, where init's egress relay listens

/** What a hosted list may hold: Docker's bounds, ports 80 and 443, names and CIDRs together. */
export const HOSTED_ALLOW: AllowCapability = {
	domains: { max: MAX_ALLOW, ports: [...LISTED_PORTS] },
	cidrs: { max: MAX_ALLOW, ports: [...LISTED_PORTS] },
	mixed: true,
};

/** A network spec as init's --network takes it: "" for none, "open", or "allow:" and the list, normalized. */
export function networkFormOf(network: NetworkSpec): string {
	if (network === "none") return "";
	if (network === "open") return "open";
	const allow = allowOf(network.allow);
	if ("problem" in allow) throw new Error(allow.problem);
	return `allow:${allow.list.join(",")}`;
}

/** A form, as a label or the policy file holds it, as a network policy: none for no form; anything else in words. */
export function networkOfForm(form: string | undefined): NetworkPolicy {
	if (form === undefined || form === "") return "none";
	if (form === "open") return "open";
	if (form.startsWith("allow:")) {
		const allow = allowOf(form.slice("allow:".length).split(","));
		if (!("problem" in allow) && `allow:${allow.list.join(",")}` === form) return { allow: allow.list };
	}
	return { other: `the network ${JSON.stringify(form.slice(0, 200))}, which this provider never makes` };
}

const FORM_WORDS: Record<NetworkForm, string> = { none: "none", open: "open", allow: "a list ({ allow: [names or CIDRs] })" };

/** The forms as a choice in words: "none", "none or open", "none, open or a list (...)". */
const choices = (forms: readonly NetworkForm[]) => {
	const words = forms.map((form) => FORM_WORDS[form]);
	return words.length <= 1 ? (words[0] ?? "none") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
};

/**
 * Why a spec's network is refused by a provider (label) that declares forms, in plain words naming it and the choices;
 * undefined when it is taken. A form the provider does not declare is refused, never widened or narrowed to another.
 */
export function networkRefusal(label: string, forms: readonly NetworkForm[], network: unknown): string | undefined {
	if (network === "none") return forms.includes("none") ? undefined : `${label} can't run with no network; choose ${choices(forms)}`;
	if (network === "open") return forms.includes("open") ? undefined : `${label} can't open the network; choose ${choices(forms)}`;
	if (typeof network === "object" && network !== null && !Array.isArray(network) && "allow" in network) {
		if (!forms.includes("allow")) return `${label} can't limit the network to a list; choose ${choices(forms)}`;
		const allow = allowOf((network as { allow: unknown }).allow, `${label}'s allowlist`);
		return "problem" in allow ? allow.problem : undefined;
	}
	return `network is required: ${choices(forms)}`;
}

/** Whether a spec's network goes out through the proxy: open, or a list. */
export const throughProxy = (network: unknown): boolean => network === "open" || (typeof network === "object" && network !== null && "allow" in network);
