// A page from a public host only, so a page-steered agent never reaches the owner's private network: every hop's name
// is resolved once, each address it resolves to is checked, and the connection is dialled at the address checked.
// http(s) on ports 80 and 443 only, no cookies or credentials, a byte cap on the body, and the caller's signal bounds
// every hop, its name lookup included.
import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { refusedError } from "./custody.js";

/** 0.0.0.0/8 this network, 10/8, 100.64/10 carrier-grade, 127/8, 169.254/16 link-local, 172.16/12, 192.0.0.0/24
 *  protocol assignments, 192.168/16, 198.18/15 benchmarking, 224/4 multicast and 240/4 reserved (the broadcast address
 *  included). */
const V4_PRIVATE: ReadonlyArray<readonly [number, number]> = [[0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4]];
/** ::/8 reserved by the IETF (the unspecified and loopback addresses, IPv4-compatible ones, and the NAT64 prefixes
 *  64:ff9b::/96 and 64:ff9b:1::/48), fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local and ff00::/8
 *  multicast. An IPv4-mapped address (::ffff:0:0/96) is checked as the IPv4 address it carries. */
const V6_PRIVATE: ReadonlyArray<readonly [string, number]> = [["::", 8], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]];
const v4 = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
/** An IPv6 address's eight 16-bit groups, read through the URL parser's canonical form; null when it does not parse
 *  (a zone index among them). */
function v6Groups(ip: string): number[] | null {
  let canonical: string;
  try { canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
  const groups = (part: string) => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
  if (!canonical.includes("::")) return groups(canonical);
  const [head, tail] = canonical.split("::").map(groups) as [number[], number[]];
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}
const inV6 = (groups: number[], base: number[], bits: number) =>
  groups.every((group, i) => { const span = Math.max(0, Math.min(16, bits - 16 * i)); const mask = (0xffff << (16 - span)) & 0xffff; return (group & mask) === (base[i]! & mask); });
/** Any address but a public unicast one, v4 and v6 (see V4_PRIVATE and V6_PRIVATE); what does not parse as one too. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return V4_PRIVATE.some(([base, bits]) => Math.floor(v4(ip) / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  const groups = net.isIPv6(ip) ? v6Groups(ip) : null;
  if (!groups) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return isPrivateAddress([groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join("."));
  return V6_PRIVATE.some(([base, bits]) => inV6(groups, v6Groups(base)!, bits));
}

/** Answers `address` for any name: the address a request was checked against is the one it connects to. */
export const pinnedLookup = (address: string) => (_host: string, options: { all?: boolean }, callback: (...args: any[]) => void): void => {
  const family = net.isIPv6(address) ? 6 : 4;
  if (options?.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};

export const PUBLIC_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PORTS = new Set(["", "80", "443"]);

/** `work()`'s answer, or the signal's reason as soon as it aborts: a resolver that never answers cannot outlast the
 *  caller. A signal already aborted starts no work. */
function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export type PublicFetchOptions = {
  /** Every address a name resolves to; default the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Default undici's fetch, dialled through the pinned lookup. */
  fetchImpl?: (url: URL, init: Record<string, unknown>) => Promise<Response>;
  signal?: AbortSignal;
  /** Default 5 MiB. */
  maxBytes?: number;
};

/** The answer that ended the redirects: its URL, status and type, and its body when it is a 2xx text answer. */
export type PublicAnswer = { url: string; status: number; contentType: string; body: string | null };

/**
 * Fetches `url` from a public host, following at most 5 redirects, each hop resolved, checked and dialled at the
 * address checked. A 2xx answer of a text type is read whole, up to `maxBytes`; another status comes back without its
 * body. Refused (`BrowserFailureError` `refused`), on the first hop or a redirect: a scheme other than http(s); a host
 * that is local by name or resolves to any private address; a port other than 80 or 443; too many redirects; a 2xx body
 * that is not text or is over the cap. `signal` ends the fetch at any point, a hop's name lookup included (it rejects
 * with the signal's reason), and an aborted hop is never dialled.
 */
export async function publicFetch(url: string, options: PublicFetchOptions = {}): Promise<PublicAnswer> {
  const lookup = options.lookup ?? (async (host: string) => (await dns.lookup(host, { all: true })).map((a) => a.address));
  const request = options.fetchImpl ?? ((target, init) => undiciFetch(target, init as never) as unknown as Promise<Response>);
  const maxBytes = options.maxBytes ?? PUBLIC_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes must be a whole number of bytes above 0, not ${maxBytes}`);
  let target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw refusedError(`refused: ${target.protocol} is not http(s)`);
  for (let hop = 0; ; hop += 1) {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw refusedError(`refused: ${host} is not a public host`);
    const addresses = net.isIP(host) ? [host] : await untilAborted(() => lookup(host), options.signal);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw refusedError(`refused: ${host} is not a public host`);
    if (!PORTS.has(target.port)) throw refusedError(`refused: port ${target.port} is not 80 or 443`);
    options.signal?.throwIfAborted();
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses[0]!) } });
    let res: Response | undefined;
    try {
      res = await request(target, { redirect: "manual", signal: options.signal, dispatcher, headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": "pi-browser" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= MAX_REDIRECTS) throw refusedError("refused: too many redirects");
        target = new URL(res.headers.get("location")!, target);
        if (!/^https?:$/.test(target.protocol)) throw refusedError("refused: a redirect left http(s)");
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) return { url: target.href, status: res.status, contentType, body: null };
      if (!/^(text\/|application\/(xhtml\+xml|json|xml))/i.test(contentType)) throw refusedError(`refused: ${contentType || "an unknown content type"} is not text`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (const reader = res.body!.getReader(); ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.length) > maxBytes) { await reader.cancel(); throw refusedError(`refused: the page is over ${maxBytes === PUBLIC_MAX_BYTES ? "5 MiB" : `${maxBytes} bytes`}`); }
        chunks.push(value);
      }
      return { url: target.href, status: res.status, contentType, body: Buffer.concat(chunks).toString("utf8") };
    } finally {
      // A reply refused unread (not text, an error status, a redirect) still holds its connection: close() waits
      // for it.
      await res?.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
    }
  }
}

/** An HTML page's title, its text as markdown, and the absolute http(s) URLs it links to (resolved against its
 *  `<base href>` or `url`), each once, in page order. */
export async function readPage(html: string, url: string): Promise<{ title: string; text: string; links: string[] }> {
  const [{ parse }, { NodeHtmlMarkdown }] = await Promise.all([import("node-html-parser"), import("node-html-markdown")]);
  const root = parse(html);
  let base = url;
  const baseHref = root.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) { try { base = new URL(baseHref, url).href; } catch { /* a base that does not parse: the page's own URL stands */ } }
  const links = new Set<string>();
  for (const anchor of root.querySelectorAll("a[href]")) {
    try {
      const link = new URL(anchor.getAttribute("href")!, base);
      link.hash = "";
      if (/^https?:$/.test(link.protocol)) links.add(link.href);
    } catch { /* an href that does not parse is no link */ }
  }
  return { title: root.querySelector("title")?.text.trim() ?? "", text: NodeHtmlMarkdown.translate(html, { keepDataImages: false }).trim(), links: [...links] };
}
