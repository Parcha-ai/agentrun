// The address rule of a box's egress, written for AgentRun: which addresses a box may reach through its egress proxy.
// Everything public; nothing private or local. It judges the binary address a socket would connect to, never the text a
// client wrote, so a single decimal number, octal or hex parts, or a bracketed IPv6 address is the address it parses to. An IPv6 address that carries
// an IPv4 one (mapped, NAT64, 6to4) is judged by the IPv4 inside. The host's own interface addresses are refused too: the
// caller reads them at each dial and passes them in, so the table itself stays pure. This is the one place the rule
// lives; the key gate's denylist marker accepts exactly these literals, and a test pins the list against drift.
import { isIP } from "node:net";

/** Why an address is refused. */
export type EgressClass =
  | "loopback"
  | "unspecified"
  | "private"
  | "cgnat"
  | "link-local"
  | "metadata"
  | "multicast"
  | "broadcast"
  | "reserved"
  | "benchmarking"
  | "this-host"
  | "invalid";

export type EgressVerdict = { ok: true } | { ok: false; class: EgressClass };

/** How an IPv6 range that carries an IPv4 address gives it up: its last 32 bits, or (6to4) bits 16 to 47. */
type Embedded = "last32" | "6to4";

/** The refused ranges, specific ones first (the first match decides): a single metadata address before the range it sits
 *  in, the broadcast address before the reserved block. Past the table, an IPv6 address outside global unicast
 *  (2000::/3) is refused as reserved, in code: the IPv4-compatible form (::a.b.c.d) and every unassigned block among
 *  them. The mapped and NAT64 forms sit outside 2000::/3 too, and are judged by their IPv4 before that rule. */
const TABLE: readonly { cidr: string; class: EgressClass | Embedded }[] = [
  { cidr: "0.0.0.0/8", class: "unspecified" }, // key-gate: denylist unspecified, refused by the egress proxy
  { cidr: "127.0.0.0/8", class: "loopback" }, // key-gate: loopback-rule loopback, refused by the egress proxy
  { cidr: "10.0.0.0/8", class: "private" }, // key-gate: denylist RFC 1918, refused by the egress proxy
  { cidr: "172.16.0.0/12", class: "private" }, // key-gate: denylist RFC 1918, refused by the egress proxy
  { cidr: "192.168.0.0/16", class: "private" }, // key-gate: denylist RFC 1918, refused by the egress proxy
  { cidr: "192.0.0.0/24", class: "private" }, // key-gate: denylist IETF protocol assignments, refused by the egress proxy
  { cidr: "100.100.100.200/32", class: "metadata" }, // key-gate: denylist a cloud metadata address, refused by the egress proxy
  { cidr: "100.64.0.0/10", class: "cgnat" }, // key-gate: denylist shared address space, refused by the egress proxy
  { cidr: "168.63.129.16/32", class: "metadata" }, // key-gate: denylist a cloud metadata address, refused by the egress proxy
  { cidr: "169.254.0.0/16", class: "link-local" }, // key-gate: denylist link-local, refused by the egress proxy
  { cidr: "198.18.0.0/15", class: "benchmarking" }, // key-gate: denylist benchmarking, refused by the egress proxy
  { cidr: "192.0.2.0/24", class: "reserved" }, // key-gate: denylist documentation, refused by the egress proxy
  { cidr: "198.51.100.0/24", class: "reserved" }, // key-gate: denylist documentation, refused by the egress proxy
  { cidr: "203.0.113.0/24", class: "reserved" }, // key-gate: denylist documentation, refused by the egress proxy
  { cidr: "192.88.99.0/24", class: "reserved" }, // key-gate: denylist the 6to4 relay anycast, refused by the egress proxy
  { cidr: "224.0.0.0/4", class: "multicast" }, // key-gate: denylist multicast, refused by the egress proxy
  { cidr: "255.255.255.255/32", class: "broadcast" }, // key-gate: denylist broadcast, refused by the egress proxy
  { cidr: "240.0.0.0/4", class: "reserved" }, // key-gate: denylist reserved, refused by the egress proxy
  { cidr: "::1/128", class: "loopback" }, // key-gate: loopback-rule loopback, refused by the egress proxy
  { cidr: "::/128", class: "unspecified" }, // key-gate: denylist unspecified, refused by the egress proxy
  { cidr: "::ffff:0:0/96", class: "last32" }, // key-gate: denylist IPv4-mapped, judged by the IPv4 inside
  { cidr: "64:ff9b::/96", class: "last32" }, // key-gate: denylist NAT64, judged by the IPv4 inside
  // Local-use NAT64 (RFC 8215): its operator picks a prefix of /48 to /96 inside it, so where an IPv4 sits cannot be read
  // from the address alone. The whole block is refused.
  { cidr: "64:ff9b:1::/48", class: "private" }, // key-gate: denylist local-use NAT64, refused by the egress proxy
  { cidr: "2002::/16", class: "6to4" }, // key-gate: denylist 6to4, judged by the IPv4 inside
  { cidr: "2001::/32", class: "reserved" }, // key-gate: denylist Teredo, refused by the egress proxy
  { cidr: "2001:db8::/32", class: "reserved" }, // key-gate: denylist documentation, refused by the egress proxy
  { cidr: "fd00:ec2::/32", class: "metadata" }, // key-gate: denylist a cloud metadata range, refused by the egress proxy
  { cidr: "fc00::/7", class: "private" }, // key-gate: denylist unique local, refused by the egress proxy
  { cidr: "fe80::/10", class: "link-local" }, // key-gate: denylist link-local, refused by the egress proxy
  { cidr: "ff00::/8", class: "multicast" }, // key-gate: denylist multicast, refused by the egress proxy
];

/** The table's ranges as written, in order: what the no-drift test pins. */
export const EGRESS_RANGES: readonly string[] = TABLE.map((entry) => entry.cidr);

/**
 * An IP address's bytes (4 or 16), or undefined when `text` is not one. Takes what a socket or a URL could carry for a
 * host: a dotted IPv4 address, or the forms the classic resolver reads as one (a single number, 0x hex and 0 octal
 * parts, fewer than four parts with the last filling the rest), and an IPv6 address, bracketed or not, with or without a
 * zone. Never a name.
 */
export function addressBytes(text: string): Uint8Array | undefined {
  let host = text.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0 && host.includes(":")) host = host.slice(0, zone);
  if (isIP(host) === 6) return v6Bytes(host);
  return v4Bytes(host);
}

/** The classic resolver's reading of an IPv4 address (inet_aton): 1 to 4 parts, each decimal, 0x hex or 0 octal. */
function v4Bytes(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > 4) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]*$/.test(part)) value = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) value = parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) value = parseInt(part, 10);
    else return undefined;
    if (!Number.isSafeInteger(value)) return undefined;
    values.push(value);
  }
  const last = values.pop()!;
  if (values.some((v) => v > 255) || last >= 2 ** (8 * (4 - values.length))) return undefined;
  const out = new Uint8Array(4);
  values.forEach((v, i) => (out[i] = v));
  for (let i = 3, rest = last; i >= values.length; i--, rest = Math.floor(rest / 256)) out[i] = rest % 256;
  return out;
}

/** An IPv6 address's 16 bytes; `text` is one `isIP` accepts. */
function v6Bytes(text: string): Uint8Array | undefined {
  let head = text;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = v4Bytes(dotted[2]!);
    if (!v4 || dotted[2]!.split(".").length !== 4) return undefined;
    head = `${dotted[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [left, right] = head.split("::") as [string, string | undefined];
  const groups = (s: string) => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const l = groups(left);
  const r = right === undefined ? [] : groups(right);
  const fill = right === undefined ? 0 : 8 - l.length - r.length;
  const all = [...l, ...Array<number>(Math.max(fill, 0)).fill(0), ...r];
  if (all.length !== 8 || all.some((g) => !(g >= 0 && g <= 0xffff))) return undefined;
  const out = new Uint8Array(16);
  all.forEach((g, i) => {
    out[2 * i] = g >> 8;
    out[2 * i + 1] = g & 0xff;
  });
  return out;
}

const RANGES = TABLE.map((entry) => {
  const [base, bits] = entry.cidr.split("/") as [string, string];
  return { bytes: addressBytes(base)!, bits: Number(bits), class: entry.class };
});

const within = (address: Uint8Array, range: { bytes: Uint8Array; bits: number }): boolean => {
  if (address.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.bits; bit += 8) {
    const mask = range.bits - bit >= 8 ? 0xff : (0xff << (8 - (range.bits - bit))) & 0xff;
    if ((address[bit / 8]! & mask) !== (range.bytes[bit / 8]! & mask)) return false;
  }
  return true;
};

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Whether a box may reach `address` (its bytes, or an address's text: never a name). `local` is the host's own interface
 * addresses, read by the caller at the dial: an address equal to one of them is refused as "this-host". An IPv6 address
 * that carries an IPv4 one is judged by the IPv4 inside, and is then still the host's own if the host holds that IPv6
 * address itself (the dial goes to the IPv6 address, not to the IPv4 inside it).
 */
export function checkAddress(address: Uint8Array | string, local: readonly string[]): EgressVerdict {
  const bytes = typeof address === "string" ? addressBytes(address) : address;
  if (!bytes || (bytes.length !== 4 && bytes.length !== 16)) return { ok: false, class: "invalid" };
  for (const range of RANGES) {
    if (!within(bytes, range)) continue;
    if (range.class === "last32" || range.class === "6to4") {
      const inner = checkAddress(range.class === "last32" ? bytes.slice(12, 16) : bytes.slice(2, 6), local);
      return inner.ok ? ownAddress(bytes, local) : inner;
    }
    return { ok: false, class: range.class };
  }
  if (bytes.length === 16 && (bytes[0]! & 0xe0) !== 0x20) return { ok: false, class: "reserved" };
  return ownAddress(bytes, local);
}

/** Refused as "this-host" when `bytes` is one of the host's own addresses, as it is written there. */
function ownAddress(bytes: Uint8Array, local: readonly string[]): EgressVerdict {
  for (const text of local) {
    const own = addressBytes(text);
    if (own && same(own, bytes)) return { ok: false, class: "this-host" };
  }
  return { ok: true };
}
