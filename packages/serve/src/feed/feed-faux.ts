// A feed for tests and template evals, on this machine's loopback: hand-written runtime code, as email/email-faux.ts is,
// so a template eval (eval-feed.ts) can start a feed trigger with no network. It serves one feed in one of the formats
// a feed trigger reads (RSS 2.0, Atom as Statuspage's incident history serves it, JSON Feed, or a JSON list, GitHub's
// pulls API's shape), newest first, as feeds are: `add` puts an item at the top, `update` replaces one by its id (a
// Statuspage incident keeps its id and gets a new <updated> with each status post). It answers a conditional request whose ETag still holds with 304, and records
// each request (its path, its conditionals, and whether it carried an Authorization header and what), so a test can
// read what the server sent. `fail` answers every request with a status until it is cleared (a 410, a 404, a 500);
// `moveTo` answers with a redirect to another address. Nothing here reaches the network.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The formats a feed trigger reads. */
export const FEED_FORMATS = ["rss", "atom", "json-feed", "json-list"] as const;
export type FeedFormat = (typeof FEED_FORMATS)[number];

/** An item of an RSS, Atom or JSON Feed feed, each field left out when it is undefined (a feed with no ids, say):
 *  `summary` its summary (RSS description, Atom summary, JSON Feed summary), `content` its HTML content (Atom content
 *  type="html", as Statuspage's entries carry, JSON Feed content_html). A JSON list's items are its raw objects. */
export type FauxEntry = { id?: string; link?: string; title?: string; published?: string; updated?: string; author?: string; summary?: string; content?: string; categories?: string[] };
export type FauxItem = FauxEntry | Record<string, unknown>;

export type FeedFauxOptions = {
  format: FeedFormat;
  /** The feed's own title (RSS, Atom and JSON Feed). */
  title?: string;
  /** Its items, newest first. */
  items?: FauxItem[];
  /** The loopback name it is reached at: 127.0.0.1 (the default) or localhost, another host to a URL's eye. */
  host?: "127.0.0.1" | "localhost";
  /** For a JSON list: the pointer its array is served under (`/data/items` serves {"data": {"items": [...]}}); none, the
   *  document is the array. */
  under?: string;
};

/** One request the feed was sent. */
export type FauxRequest = { path: string; method: string; status: number; authorization?: string; if_none_match?: string; if_modified_since?: string };

export type FeedFaux = {
  /** The feed's address. */
  url: string;
  /** The items it serves now, newest first. */
  items(): FauxItem[];
  /** One more item at the top, as a new post or pull request comes; the feed changes. */
  add(item: FauxItem): void;
  /** Its items replaced. */
  set(items: FauxItem[]): void;
  /** The item whose id is `item.id` replaced by `item`, in its place (an incident updated). */
  update(item: FauxItem): void;
  /** Every request answered with `status` (a 410, a 404, a 500) until it is called with none. */
  fail(status?: number): void;
  /** Every request answered with a 302 to `url` until it is called with none. */
  moveTo(url?: string): void;
  /** Every request answered 200 with `body` as it is (a feed that won't parse) until it is called with none. */
  raw(body?: string): void;
  /** The requests it was sent, in order. */
  requests(): FauxRequest[];
  close(): Promise<void>;
};

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rfc822 = (iso: string) => new Date(iso).toUTCString();
const entry = (item: FauxItem) => item as FauxEntry;

/** The feed's body in `format`. */
function bodyOf(format: FeedFormat, title: string, items: FauxItem[], under: string | undefined, url: string): { body: string; type: string } {
  if (format === "json-list") {
    let doc: unknown = items;
    for (const part of (under ?? "").split("/").slice(1).reverse()) doc = { [part.replace(/~1/g, "/").replace(/~0/g, "~")]: doc };
    return { body: JSON.stringify(doc), type: "application/json; charset=utf-8" };
  }
  if (format === "json-feed") {
    const list = items.map(entry).map((i) => ({
      ...(i.id !== undefined ? { id: i.id } : {}), ...(i.link !== undefined ? { url: i.link } : {}), ...(i.title !== undefined ? { title: i.title } : {}),
      ...(i.published !== undefined ? { date_published: i.published } : {}), ...(i.updated !== undefined ? { date_modified: i.updated } : {}),
      ...(i.author !== undefined ? { authors: [{ name: i.author }] } : {}), ...(i.summary !== undefined ? { summary: i.summary } : {}), ...(i.content !== undefined ? { content_html: i.content } : {}), ...(i.categories ? { tags: i.categories } : {}),
    }));
    return { body: JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title, home_page_url: url, feed_url: url, items: list }), type: "application/feed+json; charset=utf-8" };
  }
  if (format === "atom") {
    const entries = items.map(entry).map((i) => [
      "<entry>",
      i.id !== undefined ? `<id>${xml(i.id)}</id>` : "",
      i.link !== undefined ? `<link rel="alternate" type="text/html" href="${xml(i.link)}"/>` : "",
      i.title !== undefined ? `<title type="text">${xml(i.title)}</title>` : "",
      i.published !== undefined ? `<published>${xml(i.published)}</published>` : "",
      i.updated !== undefined ? `<updated>${xml(i.updated)}</updated>` : "",
      i.author !== undefined ? `<author><name>${xml(i.author)}</name></author>` : "",
      i.summary !== undefined ? `<summary type="html">${xml(i.summary)}</summary>` : "",
      i.content !== undefined ? `<content type="html">${xml(i.content)}</content>` : "",
      ...(i.categories ?? []).map((c) => `<category term="${xml(c)}"/>`),
      "</entry>",
    ].join(""));
    // As Statuspage's /history.atom: a tag: id, an alternate and a self link, then the entries.
    const home = new URL(url).origin;
    return { body: `<?xml version="1.0" encoding="UTF-8"?>\n<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom"><id>tag:${xml(new URL(url).hostname)},2005:/history</id><link rel="alternate" type="text/html" href="${xml(home)}"/><link rel="self" type="application/atom+xml" href="${xml(url)}"/><title>${xml(title)}</title><updated>2026-01-01T00:00:00Z</updated>${entries.join("")}</feed>`, type: "application/atom+xml; charset=utf-8" };
  }
  const rssItems = items.map(entry).map((i) => [
    "<item>",
    i.id !== undefined ? `<guid isPermaLink="false">${xml(i.id)}</guid>` : "",
    i.link !== undefined ? `<link>${xml(i.link)}</link>` : "",
    i.title !== undefined ? `<title>${xml(i.title)}</title>` : "",
    i.published !== undefined ? `<pubDate>${rfc822(i.published)}</pubDate>` : "",
    i.author !== undefined ? `<dc:creator>${xml(i.author)}</dc:creator>` : "",
    i.summary !== undefined || i.content !== undefined ? `<description><![CDATA[${i.summary ?? i.content}]]></description>` : "",
    ...(i.categories ?? []).map((c) => `<category>${xml(c)}</category>`),
    "</item>",
  ].join(""));
  return { body: `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${xml(title)}</title><link>${xml(url)}</link><description>${xml(title)}</description>${rssItems.join("")}</channel></rss>`, type: "application/rss+xml; charset=utf-8" };
}

/** A feed on loopback, closed with `close`. */
export async function startFeedFaux(options: FeedFauxOptions): Promise<FeedFaux> {
  const host = options.host ?? "127.0.0.1";
  let items = [...(options.items ?? [])];
  let failing: number | undefined;
  let moved: string | undefined;
  let rawBody: string | undefined;
  let changed = new Date(Date.UTC(2026, 0, 1)).toUTCString();
  const requests: FauxRequest[] = [];
  const title = options.title ?? "Faux feed";
  let url = "";
  const header = (req: IncomingMessage, name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
  const answer = (req: IncomingMessage, res: ServerResponse) => {
    const seen: FauxRequest = { path: req.url ?? "/", method: req.method ?? "GET", status: 200 };
    const authorization = header(req, "authorization");
    const ifNoneMatch = header(req, "if-none-match");
    const ifModifiedSince = header(req, "if-modified-since");
    if (authorization !== undefined) seen.authorization = authorization;
    if (ifNoneMatch !== undefined) seen.if_none_match = ifNoneMatch;
    if (ifModifiedSince !== undefined) seen.if_modified_since = ifModifiedSince;
    requests.push(seen);
    if (moved !== undefined) return void ((seen.status = 302), res.writeHead(302, { location: moved }).end());
    if (failing !== undefined) return void ((seen.status = failing), res.writeHead(failing, { "content-type": "text/plain" }).end(`HTTP ${failing}`));
    if (rawBody !== undefined) return void res.writeHead(200, { "content-type": "application/xml" }).end(rawBody);
    const { body, type } = bodyOf(options.format, title, items, options.under, url);
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
    if (ifNoneMatch === etag) return void ((seen.status = 304), res.writeHead(304, { etag, "last-modified": changed }).end());
    res.writeHead(200, { "content-type": type, etag, "last-modified": changed, "cache-control": "no-cache" }).end(body);
  };
  const http = createServer((req, res) => {
    req.resume();
    req.on("end", () => answer(req, res));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://${host}:${(http.address() as AddressInfo).port}/feed`;
  const touch = () => void (changed = new Date().toUTCString());
  return {
    url,
    items: () => [...items],
    add: (item) => void ((items = [item, ...items]), touch()),
    set: (next) => void ((items = [...next]), touch()),
    update: (item) => void ((items = items.map((one) => ((one as { id?: unknown }).id === (item as { id?: unknown }).id ? item : one))), touch()),
    fail: (status) => void (failing = status),
    moveTo: (to) => void (moved = to),
    raw: (body) => void ((rawBody = body), touch()),
    requests: () => requests.map((one) => ({ ...one })),
    close: () => new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    }),
  };
}
