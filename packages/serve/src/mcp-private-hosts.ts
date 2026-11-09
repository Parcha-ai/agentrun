// The owner's private-network OAuth hosts (Miguel's decision, 2026-11-09): an MCP server's authorization server on a
// private network is refused by default, and an owner can allow named hosts in Settings → MCP servers. The list is one
// row in the store (store.settings, MCP_PRIVATE_HOSTS_KEY), read by the server's sign-in and the runner's token refresh
// through privateOAuthHosts() alone, and the rule a listed host is held to is privateAllowed(), applied by mcp-oauth.ts's
// address check. A listed host may resolve to a private-network address (RFC 1918, 100.64.0.0/10, fc00::/7), still only
// over https; loopback, link-local (cloud metadata among it), unspecified, multicast, broadcast, reserved and this
// machine's own addresses stay refused whatever the list says.
import net from "node:net";
import os from "node:os";
import { invalid, type InputIssue } from "./errors.js";
import { hostKey } from "./mcp-meta.js";
import type { Settings } from "./store/index.js";
import { unknownFields } from "./validate.js";

/** The store.settings key the list lives under: `{ hosts: string[] }`, each a URL's hostname as hostKey (mcp-meta.ts)
 *  keeps it: lowercase, every final dot gone, an IPv6 literal in its URL form (`[fd00::1]`). */
export const MCP_PRIVATE_HOSTS_KEY = "mcp.private_oauth_hosts";
/** How many hosts the list holds at most. */
export const MAX_PRIVATE_HOSTS = 32;
/** Where an owner allows a host, as a refusal names it. */
export const PRIVATE_HOSTS_PAGE = "Settings → MCP servers";

/** The private-network ranges a listed host may resolve to: 10/8, 172.16/12 and 192.168/16 (RFC 1918), 100.64/10
 *  (carrier-grade NAT, RFC 6598) and fc00::/7 (unique local, RFC 4193). An IPv4-mapped IPv6 address is checked as the
 *  IPv4 address it carries (net.BlockList does). Nothing else is ever allowable. */
const ALLOWABLE = new net.BlockList();
for (const [base, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]] as const) ALLOWABLE.addSubnet(base, bits, "ipv4");
ALLOWABLE.addSubnet("fc00::", 7, "ipv6");

const familyOf = (address: string) => (net.isIPv6(address) ? "ipv6" : "ipv4");

/** Whether `address` is in a range a listed host may resolve to (ALLOWABLE). */
export const inAllowableRange = (address: string): boolean => net.isIP(address) !== 0 && ALLOWABLE.check(address, familyOf(address));

/** Every address on this machine's network interfaces: never an authorization server's, listed or not. */
export function localAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((one) => one.address.replace(/%.*$/, "")));
}

/** Whether a private address `address`, which a listed host resolves to, may be dialled: only in ALLOWABLE, and never one
 *  of `own` (this machine's addresses, and this server's own; an IPv4-mapped form is the same address). */
export function privateAllowed(address: string, own: readonly string[]): boolean {
  if (!inAllowableRange(address)) return false;
  const mine = new net.BlockList();
  for (const one of own) if (net.isIP(one)) mine.addAddress(one, familyOf(one));
  return !mine.check(address, familyOf(address));
}

/** The list as the store row holds it; a row that is not that shape reads as no host allowed (fail closed). */
function hostsOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { hosts?: unknown }).hosts)) return [];
  return ((value as { hosts: unknown[] }).hosts).filter((host): host is string => typeof host === "string");
}

/** The private-network hosts the owner allows an authorization server on: read from the store at each use, so a host
 *  removed is refused from the next request on. The one read of the setting, for the server's sign-in and the runner's
 *  refresh alike. */
export async function privateOAuthHosts(store: { settings: Pick<Settings, "get"> }): Promise<string[]> {
  return hostsOf(await store.settings.get(MCP_PRIVATE_HOSTS_KEY));
}

/** The list replaced with `hosts` (already checked: checkPrivateHosts). */
export async function savePrivateOAuthHosts(store: { settings: Pick<Settings, "put"> }, hosts: readonly string[]): Promise<void> {
  await store.settings.put(MCP_PRIVATE_HOSTS_KEY, { hosts: [...hosts] });
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** For an entry's words only: the literals listing could never help (this network, loopback, link-local, multicast,
 *  reserved and broadcast; the IPv6 unspecified, loopback, link-local and multicast). The address check refuses every
 *  address outside ALLOWABLE whatever it is. */
const NEVER_RANGES = new net.BlockList();
for (const [base, bits] of [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) NEVER_RANGES.addSubnet(base, bits, "ipv4");
for (const [base, bits] of [["::", 127], ["fe80::", 10], ["ff00::", 8]] as const) NEVER_RANGES.addSubnet(base, bits, "ipv6");
const NEVER = "an authorization server is never let reach this machine, a link-local address (cloud metadata among them), or an unspecified, multicast or broadcast address";

/** One entry, as the list keeps it (hostKey), or why it can't be one. */
function entryOf(value: unknown, field: string): { host: string } | { issue: InputIssue } {
  const bad = (reason: string, message: string) => ({ issue: { field, reason, message } });
  if (typeof value !== "string") return bad("wrong_type", `${field} is a host name or an IP address, as text.`);
  if (value === "" || value.length > 253) return bad("invalid", `${field} is a host name or an IP address, 1 to 253 characters.`);
  if (value.includes("*")) return bad("invalid", `${value} holds a wildcard: name each host on its own.`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return bad("invalid", `${value} has a scheme: give the host alone, as in as.example.internal.`);
  if (value.includes("/")) return bad("invalid", `${value} is not a host: no address ranges (CIDR) or paths, name each host on its own.`);
  const inner = value.replace(/^\[(.*)\]$/, "$1");
  let host: string;
  if (net.isIPv6(inner)) {
    const parsed = URL.parse(`https://[${inner}]/`);
    if (!parsed) return bad("invalid", `${value} is not an IPv6 address a URL can name (no zone index).`);
    host = parsed.hostname;
  } else if (value.includes(":")) return bad("invalid", `${value} has a port: give the host alone, which is allowed on any port.`);
  else {
    const parsed = URL.parse(`https://${value}/`);
    const named = parsed ? hostKey(parsed.hostname) : undefined;
    if (!named || named !== hostKey(value)) return bad("invalid", `${value} is not a host name or an IP address${named ? `; write it as ${named}` : ""}.`);
    if (!net.isIPv4(named) && !named.split(".").every((label) => LABEL.test(label))) return bad("invalid", `${value} is not a host name: letters, digits and dashes, in dot-separated labels.`);
    host = named;
  }
  const address = host.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(address) && !inAllowableRange(address)) {
    return bad("invalid", NEVER_RANGES.check(address, familyOf(address)) ? `${host} can't be allowed: ${NEVER}.` : `${host} is not in a range a listed host may resolve to (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7), so there is nothing to allow.`);
  }
  if (host === "localhost" || host.endsWith(".localhost")) return bad("invalid", `${host} can't be allowed: ${NEVER}.`);
  return { host };
}

/** A PUT body `{ hosts }` checked: the list as kept (each entry hostKey'd, the first of any repeat kept), or 422 with
 *  every entry that is not a host name or an IP address on a private network, in words. */
export function checkPrivateHosts(body: Record<string, unknown>): string[] {
  const issues: InputIssue[] = unknownFields(body, ["hosts"]);
  const { hosts } = body;
  if (!Array.isArray(hosts)) {
    issues.push({ field: "hosts", reason: hosts === undefined ? "missing" : "wrong_type", message: "hosts is a list of host names or IP addresses (an empty list allows none)." });
    throw invalid(issues);
  }
  if (hosts.length > MAX_PRIVATE_HOSTS) issues.push({ field: "hosts", reason: "too_long", message: `hosts holds at most ${MAX_PRIVATE_HOSTS} hosts; it holds ${hosts.length}.` });
  const kept: string[] = [];
  hosts.forEach((value, i) => {
    const entry = entryOf(value, `hosts[${i}]`);
    if ("issue" in entry) issues.push(entry.issue);
    else if (!kept.includes(entry.host)) kept.push(entry.host);
  });
  if (issues.length) throw invalid(issues);
  return kept;
}
