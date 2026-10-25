// A page from a public host only, so a page-steered agent never reaches the owner's private network: every hop's name
// is resolved once, each address it resolves to is checked, and the connection is dialled at the address checked.
// http(s) only, no cookies or credentials, a byte cap on the body.
import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { refusedError } from "./custody.js";

const V4_PRIVATE: ReadonlyArray<readonly [number, number]> = [[0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16], [0x00000000, 8], [0xe0000000, 4]];
const v4 = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
/** Loopback, private, link-local, carrier-grade and multicast addresses, v4 and v6, v4-mapped included. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (net.isIPv4(ip)) return V4_PRIVATE.some(([base, bits]) => Math.floor(v4(ip) / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  if (net.isIPv6(ip)) return /^(::1?|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|ff[0-9a-f]{2}:)/i.test(ip) || ip === "::";
  return true;
}

/** Answers `address` for any name: the address a request was checked against is the one it connects to. */
export const pinnedLookup = (address: string) => (_host: string, options: { all?: boolean }, callback: (...args: any[]) => void): void => {
  const family = net.isIPv6(address) ? 6 : 4;
  if (options?.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};

export const PUBLIC_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

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
 * body. Refused (`BrowserFailureError` `refused`): a scheme other than http(s), on the first hop or a redirect; a host
 * that is local by name or resolves to any private address; too many redirects; a 2xx body that is not text or is over
 * the cap.
 */
export async function publicFetch(url: string, options: PublicFetchOptions = {}): Promise<PublicAnswer> {
  const lookup = options.lookup ?? (async (host: string) => (await dns.lookup(host, { all: true })).map((a) => a.address));
  const request = options.fetchImpl ?? ((target, init) => undiciFetch(target, init as never) as unknown as Promise<Response>);
  const maxBytes = options.maxBytes ?? PUBLIC_MAX_BYTES;
  let target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw refusedError(`refused: ${target.protocol} is not http(s)`);
  for (let hop = 0; ; hop += 1) {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw refusedError(`refused: ${host} is not a public host`);
    const addresses = net.isIP(host) ? [host] : await lookup(host);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw refusedError(`refused: ${host} is not a public host`);
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
