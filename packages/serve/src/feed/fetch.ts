// A feed trigger's read of one feed (trigger-feed.ts): one GET, held to the address check an MCP server's requests are
// (mcp-oauth.ts feedAt: no private or link-local address, no address of this machine, every address a name resolves to
// checked and the one dialled one checked), with plain http allowed on a public address alone. Redirects are followed by
// hand, each checked again, at most FEED_MAX_REDIRECTS. The read is conditional on the last ETag and Last-Modified, a
// 304 handed back with no body; the body is read to FEED_MAX_BYTES at most, the whole read held to FEED_TIMEOUT_MS.
import { feedAt, type OAuthNetwork, type Reach } from "../mcp-oauth.js";

/** The largest body a feed may answer: past it the read stops and the check says so. */
export const FEED_MAX_BYTES = 5 * 1024 * 1024;
/** How long one read may take, its redirects and its body with it. */
export const FEED_TIMEOUT_MS = 20_000;
/** The redirects one read follows. */
export const FEED_MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Where a feed is read from: the network (the server's own, a test's), where it may go (`reach`), and `route`, a test's
 *  or an eval's seam (ServeOptions.feedsAt): the URL actually read in place of a trigger's, its answer the trigger's. */
export type FeedReach = { network: OAuthNetwork; reach: Reach; route?: (url: string) => string | undefined; signal?: AbortSignal };
/** The last read's validators, sent back so a feed that hasn't changed answers 304. */
export type Validators = { etag?: string; modified?: string };
/** A read: 200 with its body and validators, 304, or another status (with no body). */
export type FeedRead = { status: 200; body: string; etag?: string; modified?: string } | { status: number };

/** A read refused before it was sent (an address the check refused, too many redirects, too large a body): its words. */
export class FeedRefused extends Error {
  override name = "FeedRefused";
}
/** A read that got no answer: no connection, a name that does not resolve, a read cut short, out of time. */
export class FeedUnreachable extends Error {
  override name = "FeedUnreachable";
}

/** `url` read, conditional on `last`. Throws FeedRefused or FeedUnreachable, in words that name the feed's host. */
export async function readFeed(url: string, last: Validators, { network, reach, route, signal: stop }: FeedReach): Promise<FeedRead> {
  const signal = AbortSignal.any([AbortSignal.timeout(FEED_TIMEOUT_MS), ...(stop ? [stop] : [])]);
  let at: URL;
  try {
    at = new URL(route?.(url) ?? url);
  } catch {
    throw new FeedRefused(`${url.slice(0, 200)} is not a URL; refused`);
  }
  const headers: Record<string, string> = { accept: "application/atom+xml, application/rss+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5", "user-agent": "agentrun-feed/1" };
  if (last.etag) headers["if-none-match"] = last.etag;
  if (last.modified) headers["if-modified-since"] = last.modified;
  for (let hops = 0; ; hops++) {
    let checked: Awaited<ReturnType<typeof feedAt>>;
    try {
      checked = await feedAt(at, signal, network, reach);
    } catch {
      throw new FeedUnreachable(`couldn't reach ${at.host}: ${signal.aborted && !stop?.aborted ? `no answer within ${FEED_TIMEOUT_MS / 1000} s` : "stopped"}`);
    }
    if ("refused" in checked) throw checked.unresolved ? new FeedUnreachable(checked.refused.replace(/; refused$/, "")) : new FeedRefused(checked.refused);
    let res: Response;
    try {
      const init: RequestInit = { method: "GET", headers, redirect: "manual", signal };
      res = checked.address === undefined ? await fetch(at.href, init) : await (network.dial ?? network.fetch).call(network, at.href, init, checked.address);
    } catch (error) {
      throw new FeedUnreachable(`couldn't reach ${at.host}${signal.aborted ? `: no answer within ${FEED_TIMEOUT_MS / 1000} s` : causeOf(error)}`);
    }
    if (REDIRECTS.has(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (!location) return { status: res.status };
      if (hops >= FEED_MAX_REDIRECTS) throw new FeedRefused(`${at.host} sent the read through more than ${FEED_MAX_REDIRECTS} redirects; refused`);
      try {
        at = new URL(location, at);
      } catch {
        throw new FeedRefused(`${at.host} redirected to ${location.slice(0, 200)}, which is not a URL; refused`);
      }
      continue;
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 304 };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status };
    }
    const bytes = await bounded(res, at, signal);
    const etag = res.headers.get("etag") ?? undefined;
    const modified = res.headers.get("last-modified") ?? undefined;
    return { status: 200, body: decoded(bytes, res.headers.get("content-type")), ...(etag ? { etag } : {}), ...(modified ? { modified } : {}) };
  }
}

/** The connection error's code, when it names one (", ECONNREFUSED"). */
function causeOf(error: unknown): string {
  for (let at = error, depth = 0; at && typeof at === "object" && depth < 5; at = (at as { cause?: unknown }).cause, depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return ` (${code})`;
  }
  return "";
}

/** `res`'s body, read to FEED_MAX_BYTES at most: one byte more stops the read, refused. */
async function bounded(res: Response, at: URL, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  try {
    for (; reader; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.length) > FEED_MAX_BYTES) throw new FeedRefused(`the feed at ${at.host} answered more than ${FEED_MAX_BYTES / 1024 / 1024} MB; refused`);
      chunks.push(value);
    }
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    if (error instanceof FeedRefused) throw error;
    throw new FeedUnreachable(`couldn't reach ${at.host}: ${signal.aborted ? `no answer within ${FEED_TIMEOUT_MS / 1000} s` : "the answer was cut short"}`);
  }
  return Buffer.concat(chunks);
}

/** `bytes` as text in the charset the answer names, UTF-8 when it names none this runtime decodes. */
function decoded(bytes: Uint8Array, type: string | null): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(type ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
