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
  // 6to4 (2002::/16, RFC 3056) carries an IPv4 address in its next 32 bits, which a relay delivers to: judged as that one.
  if (groups[0] === 0x2002) return isPrivateAddress([groups[1]! >> 8, groups[1]! & 0xff, groups[2]! >> 8, groups[2]! & 0xff].join("."));
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
  /** Refuse http as well, on the first hop and at every redirect: https only. Default false. */
  httpsOnly?: boolean;
  /** The most redirects followed, a whole number from 0 to 5; with 0 any redirect is refused before its target is
   *  dialled. Default 5. */
  maxRedirects?: number;
};

/** The answer that ended the redirects: its URL, status and type, and its body when it is a 2xx text answer. */
export type PublicAnswer = { url: string; status: number; contentType: string; body: string | null };

/** The content types read as text: any text/*, application/json and application/xml, and any application/<name>+xml
 *  or application/<name>+json (atom, rss, xhtml, ld+json), so a site's feed reads like its pages. Anything else (a PDF,
 *  a zip, octet-stream, an image/svg+xml) is refused. */
const TEXT_TYPE = /^(text\/|application\/(json|xml|[\w.!#$&^-]+\+(xml|json)\b))/i;
/** The types whose own <meta> may name their charset: HTML and XHTML. */
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\s*(;|$)/i;
/** How far into a page a <meta> charset counts: the first 1024 bytes, as a browser's prescan reads. */
const PRESCAN_BYTES = 1024;

/** The charset a `charset=` parameter in `words` names (a Content-Type, or a <meta http-equiv> tag's content), quotes
 *  taken off; undefined when there is none. */
const charsetParam = (words: string): string | undefined => /(?:^|[;\s])charset\s*=\s*["']?([^"';\s]+)/i.exec(words)?.[1];

/** The charset an HTML page's own <meta> names in its first 1024 bytes: a `<meta charset>`, else a
 *  `<meta http-equiv="Content-Type" content="...; charset=...">`. Undefined when neither does. */
function metaCharset(bytes: Uint8Array): string | undefined {
  // latin1 maps each byte to one char: an ASCII tag reads the same whatever the page's charset.
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, PRESCAN_BYTES)).toString("latin1");
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const [, name, double, single, bare] of tag.slice(5).matchAll(/([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const key = name!.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, (double ?? single ?? bare ?? "").trim());
    }
    const charset = attributes.get("charset");
    if (charset) return charset;
    if (attributes.get("http-equiv")?.toLowerCase() === "content-type") {
      const said = charsetParam(attributes.get("content") ?? "");
      if (said) return said;
    }
  }
  return undefined;
}

/** A decoder for `label`, or undefined when no encoding goes by it. A page's <meta> naming UTF-16 is read as UTF-8, as a
 *  browser does: a page whose bytes are UTF-16 could not have spelled the tag in ASCII. */
function decoderFor(label: string | undefined, fromMeta: boolean): TextDecoder | undefined {
  if (label === undefined) return undefined;
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(label); } catch { return undefined; }
  return fromMeta && decoder.encoding.startsWith("utf-16") ? new TextDecoder("utf-8") : decoder;
}

/** A text page's `bytes` as text, decoded by the charset it declares: its Content-Type's `charset`, else (an HTML page)
 *  its <meta> charset in the first 1024 bytes, else UTF-8. A label no encoding goes by is passed over for the next.
 *  Bytes the charset cannot read become U+FFFD. */
function pageText(bytes: Uint8Array, contentType: string): string {
  const decoder = decoderFor(charsetParam(contentType), false) ?? (HTML_TYPE.test(contentType) ? decoderFor(metaCharset(bytes), true) : undefined) ?? new TextDecoder("utf-8");
  return decoder.decode(bytes);
}

/** The answer that ended the redirects, as `publicDownload` gives it: its URL, status and type, and its bytes when it is a
 *  2xx answer (an empty array for a 2xx with no body). */
export type PublicFile = { url: string; status: number; contentType: string; bytes: Uint8Array | null };

const MIB = 1024 * 1024;

/** The options checked before any lookup: `maxBytes` (default 5 MiB) a whole number of bytes above 0, and
 *  `maxRedirects` a whole number from 0 to 5. */
function capOf(options: PublicFetchOptions): number {
  const maxBytes = options.maxBytes ?? PUBLIC_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes must be a whole number of bytes above 0, not ${maxBytes}`);
  const redirects = options.maxRedirects ?? MAX_REDIRECTS;
  if (!Number.isSafeInteger(redirects) || redirects < 0 || redirects > MAX_REDIRECTS) throw new RangeError(`maxRedirects must be a whole number from 0 to ${MAX_REDIRECTS}, not ${redirects}`);
  return maxBytes;
}

type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** One hop's checks before it is dialled: its name is not a local one, every address it resolves to is public, and its
 *  port is 80 or 443. Answers the addresses, the first of which the hop dials; throws the refusal otherwise. */
async function hopAddresses(target: URL, lookup: Lookup, signal: AbortSignal | undefined): Promise<string[]> {
  const host = target.hostname.replace(/^\[|\]$/g, "");
  // Trailing dots name the same host (WHATWG keeps them): the name checks read the host without any.
  const name = host.replace(/\.+$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) throw refusedError(`refused: ${host} is not a public host`);
  const addresses = net.isIP(host) ? [host] : await untilAborted(() => lookup(host), signal);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw refusedError(`refused: ${host} is not a public host`);
  if (!PORTS.has(target.port)) throw refusedError(`refused: port ${target.port} is not 80 or 443`);
  signal?.throwIfAborted();
  return addresses;
}

/** Whether publicFetch's first hop would be dialled for `url`: http(s), and hopAddresses' checks, with nothing sent.
 *  Resolves when it passes; throws publicFetch's own refusal when it does not. */
export async function publicCheck(url: string, options: { lookup?: Lookup; signal?: AbortSignal } = {}): Promise<void> {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw refusedError(`refused: ${target.protocol} is not http(s)`);
  await hopAddresses(target, options.lookup ?? systemLookup, options.signal);
}

/**
 * The hop loop both answers share: `url` fetched from a public host, following at most 5 redirects, each hop resolved,
 * checked and dialled at the address checked, asking for `accept`. The answer that ends the redirects goes to `answer`,
 * which reads what it needs of it; whatever it leaves unread is cancelled, and the hop's connection closed, once it
 * returns or throws.
 */
async function publicHops<T>(url: string, options: PublicFetchOptions, accept: string, answer: (res: Response, target: URL) => Promise<T>): Promise<T> {
  const lookup = options.lookup ?? systemLookup;
  const request = options.fetchImpl ?? ((target, init) => undiciFetch(target, init as never) as unknown as Promise<Response>);
  const [scheme, schemeName] = options.httpsOnly ? ([/^https:$/, "https"] as const) : ([/^https?:$/, "http(s)"] as const);
  const most = options.maxRedirects ?? MAX_REDIRECTS;
  let target = new URL(url);
  if (!scheme.test(target.protocol)) throw refusedError(`refused: ${target.protocol} is not ${schemeName}`);
  for (let hop = 0; ; hop += 1) {
    const addresses = await hopAddresses(target, lookup, options.signal);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses[0]!) } });
    let res: Response | undefined;
    try {
      res = await request(target, { redirect: "manual", signal: options.signal, dispatcher, headers: { accept, "user-agent": "pi-browser" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= most) throw refusedError(most === 0 ? "refused: a redirect, and this download follows none" : "refused: too many redirects");
        target = new URL(res.headers.get("location")!, target);
        if (!scheme.test(target.protocol)) throw refusedError(`refused: a redirect left ${schemeName}`);
        continue;
      }
      return await answer(res, target);
    } finally {
      // A reply refused unread (not text, an error status, a redirect) still holds its connection: close() waits
      // for it.
      await res?.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
    }
  }
}

/** `reader`'s next chunk; with `signal`, ended at the signal's abort with its reason (the body cancelled), whatever the
 *  fetch does with the signal. */
const nextChunk = (reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) =>
  signal ? untilAborted(() => reader.read(), signal).catch(async (error: unknown) => { await reader.cancel(error).catch(() => undefined); throw error; }) : reader.read();

/** `body` read whole, refused (`over`'s words) once it passes `maxBytes`: cut off while it is read, not after. With
 *  `signal`, each read also ends at the signal's abort, with its reason. The chunks are kept and joined at the end, so a
 *  body peaks at about twice its size in memory: readStated is the path for a body whose length is stated. */
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number, over: string, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const reader = body.getReader(); ; ) {
    const { done, value } = await nextChunk(reader, signal);
    if (done) break;
    if ((size += value.length) > maxBytes) { await reader.cancel(); throw refusedError(over); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `body`, whose host stated it is `length` bytes, read into one buffer of that length, allocated before the first chunk:
 *  the file is held once, never joined into a second copy. A chunk that runs past `length` is refused as it comes, the
 *  body cancelled; a body that ends short of it is refused at its end. `signal` as readCapped's. */
async function readStated(body: ReadableStream<Uint8Array>, length: number, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const reader = body.getReader(); ; ) {
    const { done, value } = await nextChunk(reader, signal);
    if (done) break;
    if (value.length > length - at) { await reader.cancel(); throw refusedError(`refused: the file is longer than the ${length} bytes its host stated`); }
    bytes.set(value, at);
    at += value.length;
  }
  if (at !== length) throw refusedError(`refused: the file ended at ${at} of the ${length} bytes its host stated`);
  return bytes;
}

/** The length a 2xx reply states for the body a fetch hands over: its content-length when that is a plain count and the
 *  body is not encoded (a gzip reply's length counts the bytes on the wire, not the decoded ones); else undefined. */
function statedLength(headers: Headers): number | undefined {
  const said = headers.get("content-length")?.trim();
  if (said === undefined || !/^\d{1,16}$/.test(said)) return undefined;
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return undefined;
  const length = Number(said);
  return Number.isSafeInteger(length) ? length : undefined;
}

/**
 * Fetches `url` from a public host, following at most 5 redirects (or `maxRedirects`), each hop resolved, checked and dialled at the
 * address checked. A 2xx answer of a text type is read whole, up to `maxBytes`, and
 * decoded by the charset it declares (pageText); another status comes back without its
 * body. Refused (`BrowserFailureError` `refused`), on the first hop or a redirect: a scheme other than http(s) (other
 * than https, with `httpsOnly`); a host that is local by name or resolves to any private address; a port other than 80
 * or 443; too many redirects (any, with `maxRedirects` 0); a 2xx body that is not text or is over the cap. `signal` ends the fetch at any point, a
 * hop's name lookup included (it rejects with the signal's reason), and an aborted hop is never dialled.
 */
export async function publicFetch(url: string, options: PublicFetchOptions = {}): Promise<PublicAnswer> {
  const maxBytes = capOf(options);
  return publicHops(url, options, "text/html,text/plain;q=0.9,*/*;q=0.1", async (res, target) => {
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) return { url: target.href, status: res.status, contentType, body: null };
    // A 2xx with no body at all (204, 205) is an empty page, whatever type it names.
    if (!res.body) return { url: target.href, status: res.status, contentType, body: "" };
    if (!TEXT_TYPE.test(contentType)) throw refusedError(`refused: ${contentType || "an unknown content type"} is not text`);
    const body = await readCapped(res.body, maxBytes, `refused: the page is over ${maxBytes === PUBLIC_MAX_BYTES ? "5 MiB" : `${maxBytes} bytes`}`);
    return { url: target.href, status: res.status, contentType, body: pageText(body, contentType) };
  });
}

/**
 * Downloads `url` from a public host: publicFetch's hops and refusals (scheme, local or private host, port, redirects,
 * the signal), with any content type accepted and the body kept as bytes, up to `maxBytes` (default 5 MiB). A 2xx answer
 * is read whole; another status comes back with `bytes` null. A body over the cap is refused (`refused: the file is over
 * <cap>`): before a byte is read when its content-length says so, else as soon as it passes it. A body whose length its
 * host states (an unencoded reply's content-length) is read into one buffer of that length, so it is held once; one longer
 * than stated is refused as it runs past it, one shorter at its end. With no stated length the chunks are joined at the
 * end, about twice the file's size at the peak. `signal` ends the body's read too, with its reason.
 */
export async function publicDownload(url: string, options: PublicFetchOptions = {}): Promise<PublicFile> {
  const maxBytes = capOf(options);
  const over = `refused: the file is over ${maxBytes % MIB === 0 ? `${maxBytes / MIB} MiB` : `${maxBytes} bytes`}`;
  return publicHops(url, options, "*/*", async (res, target) => {
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) return { url: target.href, status: res.status, contentType, bytes: null };
    if (!res.body) return { url: target.href, status: res.status, contentType, bytes: new Uint8Array(0) };
    const declared = Number(res.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) throw refusedError(over);
    // A stated length (at most the cap, checked above): the bytes read into one buffer of it. None: the chunks joined at
    // the end, about twice the file's size at its peak.
    const length = statedLength(res.headers);
    if (length !== undefined) return { url: target.href, status: res.status, contentType, bytes: await readStated(res.body, length, options.signal) };
    const body = await readCapped(res.body, maxBytes, over, options.signal);
    return { url: target.href, status: res.status, contentType, bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
  });
}
