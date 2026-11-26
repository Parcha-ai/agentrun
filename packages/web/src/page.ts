// A page as web_fetch answers it. A page is read once (a Read, at most PAGE_READ_MAX_CHARS characters of text) and
// answered in parts (offset, maxChars). Every field of a Page is capped, so one answer stays under the host's bound.
import { linksOf } from "./text-urls.js";

/** On a page that was read, `chars`: the length of `text`, the part of the page's text this answer holds. `truncated`
 *  while more of it follows this part, and `next_offset` where that begins; `offset` where this part begins, when not 0;
 *  `original_chars` the whole text's length in characters, when it is known and this part is not all of it;
 *  `beyond_read` on the last part a read reaches of a page that goes on past PAGE_READ_MAX_CHARS; `links_omitted`, with the
 *  first part, how many of the page's links its caps left out. `html_chars`, on every part of a page whose HTML readPage
 *  cut before it was read: the page's whole length in characters. Its text, all its parts together, is then the start of
 *  the page's, so no part gives original_chars, and the last part (no truncated: no part follows) still says the page was
 *  cut. `converted: "text"` when the text is the page's plain text, its conversion to markdown having run out of time. */
export type Page = { ok: boolean; url: string; status: number; title: string; text: string; chars?: number; truncated?: true; original_chars?: number; beyond_read?: true; offset?: number; next_offset?: number; html_chars?: number; converted?: "text"; links: string[]; links_omitted?: number; refused?: string; error?: string };

/** The most of a page's text one answer holds (max_chars at most), what it holds when max_chars is not given, and the
 *  least max_chars a tool's call may ask for (a smaller one is refused, saying so). */
export const TEXT_CAP = 50_000;
export const PAGE_CHARS = 20_000;
export const MAX_CHARS_MIN = 200;
/** The most of a page's TEXT web_fetch reads, from either provider: its first million characters (not HTML_READ_CHARS,
 *  readPage's cut of the HTML before any text is read). A part reads within it, Parallel is never asked for more of a
 *  page than that and one character (providers/parallel.ts), and an offset at or past it is refused. */
export const PAGE_READ_MAX_CHARS = 1_000_000;
/** A page's links, with its first part only: at most LINKS_CAP of them, in at most LINKS_CHARS characters of the answer. */
export const LINKS_CAP = 200;
export const LINKS_CHARS = 20_000;
export const TITLE_CAP = 500;
/** The longest URL fetched: a longer one is refused before anything is sent. */
export const URL_MAX = 4_096;
export const TIMEOUT_MS = 30_000;
/** Where the HTML reader cuts a page's HTML before it reads it, scripts and styles aside (not PAGE_READ_MAX_CHARS, the
 *  most of the text read): pi-browser's READ_MAX_CHARS, the reader serve injects, held here so the tool's words name it
 *  without loading a reader where nothing is fetched (web-fetch-direct-cut.test holds the two equal). */
export const HTML_READ_CHARS = 1_000_000;
/** The most bytes of a page any path reads: the guarded direct fetch's bound (pi-browser's PUBLIC_MAX_BYTES, 5 MiB,
 *  held equal by web-fetch-direct-cut.test), and keyless Firecrawl's scrape's too. */
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** `text` with any URL in it stripped of its user name and password (`//user:pass@host` to `//host`). An error may quote
 *  a URL that holds them (undici's refusal of a redirect to one quotes it whole). Run it on the whole text, before any
 *  cut: a cut can end inside them, leaving no "@" for it to find. It reads on to the last "@" before the host, as a URL
 *  does: a password may hold an "@" left unencoded. */
export const withoutUserinfo = (text: string) => text.replace(/\/\/[^\s/?#]*@/g, "//");
/** `url`, a page's, with no user name or password, cleared as a URL (a URL drops a tab or a newline in them and encodes a
 *  space, where withoutUserinfo, reading free text, stops); "" where it does not parse, as no URL to name: a scrub of its
 *  text can stop short of them (at a space). A provider that followed a redirect names the URL it ended at, which may
 *  hold them. Run it before a url is cut: a cut can end inside them, leaving a url that does not parse. */
export function withoutCredentials(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return "";
  if (!parsed.username && !parsed.password) return url;
  parsed.username = "";
  parsed.password = "";
  return clip(parsed.href, URL_MAX);
}
/** The URL a call asked for, as a page names it: with no user name or password, and cut; "" where it is no string or
 *  does not parse (withoutCredentials). */
export const askedUrl = (url: unknown) => (typeof url === "string" ? clip(withoutCredentials(url), URL_MAX) : "");

/** Which part of a page's text an answer holds: from `offset` (0 by default), about `maxChars` characters (PAGE_CHARS by
 *  default, at most TEXT_CAP). */
export type Part = { offset?: number; maxChars?: number };
/** Why a tool's call may not read `part`, or undefined: an offset that is not a whole number of 0 or more, a maxChars that
 *  is not a number of MAX_CHARS_MIN or more (one past TEXT_CAP reads TEXT_CAP). */
export function partProblem({ offset, maxChars }: Part): string | undefined {
  const shown = (value: unknown) => (typeof value === "number" ? String(value) : String(JSON.stringify(value)).slice(0, 40));
  if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0)) return `offset must be a whole number, 0 or more (it was ${shown(offset)})`;
  if (offset !== undefined && offset >= PAGE_READ_MAX_CHARS) return `offset must be under ${PAGE_READ_MAX_CHARS.toLocaleString("en-US")}: web_fetch reads a page's first ${PAGE_READ_MAX_CHARS.toLocaleString("en-US")} characters (it was ${shown(offset)})`;
  if (maxChars !== undefined && !(typeof maxChars === "number" && maxChars >= MAX_CHARS_MIN)) return `max_chars must be ${typeof maxChars === "number" ? "" : "a number, "}at least ${MAX_CHARS_MIN} (it was ${shown(maxChars)})`;
  return undefined;
}

/** `part` in range: a whole offset of 0 or more, a whole maxChars of 1 to TEXT_CAP. */
export const partOf = (part: Part = {}): Required<Part> => ({
  offset: Math.max(0, Math.floor(Number(part.offset) || 0)),
  maxChars: Math.max(1, Math.min(TEXT_CAP, Math.floor(Number(part.maxChars) || PAGE_CHARS))),
});

/** Where the longest run of `text` from `start` ends whose JSON string takes at most `budget` characters (less its
 *  quotes): a character takes one, a quote, a backslash or a control character JSON writes short (\n, \t) two, any other
 *  control character or a lone surrogate six. A surrogate pair is never split. While a character is left the run holds
 *  one at least, whatever it takes, so a part always advances (only a budget under six can be passed, by that one). */
export function partEnd(text: string, start: number, budget: number): number {
  let at = start;
  for (let used = 0; at < text.length; ) {
    const unit = text.charCodeAt(at);
    let width = 1;
    let cost = 1;
    if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) [width, cost] = [2, 2];
    else if ((unit & 0xf800) === 0xd800) cost = 6;
    else if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) cost = 2;
    else if (unit < 0x20) cost = 6;
    if (used + cost > budget && at > start) break;
    used += cost;
    at += width;
  }
  return at;
}

/** A page's text as it is read once: its first PAGE_READ_MAX_CHARS characters (`text`), whether the page's text goes on
 *  past them (`beyond`), and its whole length where it is known (`length`). */
export type Text = { text: string; beyond: boolean; length?: number };
/** `text` as read: `whole` says whether it is all of the page's text, so its length is the page's (a provider that cut
 *  it, or readPage's cut of its HTML, gives none). The cut at PAGE_READ_MAX_CHARS never splits a surrogate pair: where
 *  it would, it is one unit short. */
export function textOf(text: string, whole: boolean): Text {
  const beyond = text.length > PAGE_READ_MAX_CHARS;
  const split = (text.charCodeAt(PAGE_READ_MAX_CHARS - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(PAGE_READ_MAX_CHARS) & 0xfc00) === 0xdc00;
  return { text: beyond ? text.slice(0, PAGE_READ_MAX_CHARS - (split ? 1 : 0)) : text, beyond, ...(whole ? { length: text.length } : {}) };
}

/** The part of a page's text an answer holds, and what it says of the rest. */
export function pageText({ text, beyond, length }: Text, part: Part = {}): Pick<Page, "text" | "chars" | "truncated" | "original_chars" | "beyond_read" | "offset" | "next_offset"> {
  const { offset, maxChars } = partOf(part);
  const start = Math.min(offset, text.length);
  const end = partEnd(text, start, maxChars);
  const held = text.slice(start, end);
  const more = end < text.length;
  // The last part a read reaches of a page that goes on past it.
  const last = !more && beyond;
  return {
    text: held,
    chars: held.length,
    ...(more ? { truncated: true as const } : {}),
    ...(length !== undefined && (offset > 0 || more || last) ? { original_chars: length } : {}),
    ...(last ? { beyond_read: true as const } : {}),
    ...(offset > 0 ? { offset } : {}),
    ...(more ? { next_offset: end } : {}),
  };
}

/** A page's links as its first part holds them: in page order, at most LINKS_CAP of them, each one that fits in what is
 *  left of LINKS_CHARS (as JSON, with its comma); and how many of them that left out, when any. */
export function linksWithin(links: Iterable<string>): Pick<Page, "links" | "links_omitted"> {
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const link of links) {
    const cost = JSON.stringify(link).length + 1;
    if (kept.length === LINKS_CAP || used + cost > LINKS_CHARS) {
      omitted += 1;
      continue;
    }
    kept.push(link);
    used += cost;
  }
  return { links: kept, ...(omitted ? { links_omitted: omitted } : {}) };
}

/** A page read once, before any part of it is taken: its final url, status and title, its Text, the links its first part
 *  holds (linksWithin), and readPage's `html_chars` and `converted` where it gave them. `inline` where its text writes
 *  every link it holds (a reading service's markdown, writtenRead): its first part then lists only the links its own text
 *  does not write (partOfRead). */
export type Read = { ok: true; url: string; status: number; title: string; links: string[]; links_omitted?: number; html_chars?: number; converted?: "text"; inline?: true } & Text;
/** A Page that was not read, saying why. */
export type Unread = Page & { ok: false };

/** The part `part` names of a page read once, as a Page: the links with its first part only. An `inline` read's first
 *  part lists those of its text's links that the part's own text does not write, within the caps (linksWithin), and
 *  counts those the caps left out: a link the model reads in the text is never listed again beside it. */
export function partOfRead({ text, beyond, length, links, links_omitted, html_chars, converted, inline, ...page }: Read, part: Part = {}): Page {
  const first = partOf(part).offset === 0;
  const held = pageText({ text, beyond, length }, part);
  let listed: Pick<Page, "links" | "links_omitted"> = { links: [] };
  if (first && inline) {
    const written = new Set(linksOf(held.text));
    listed = linksWithin([...linksOf(text)].filter((link) => !written.has(link)));
  } else if (first) listed = { links, ...(links_omitted ? { links_omitted } : {}) };
  return { ...page, ...held, ...(html_chars === undefined ? {} : { html_chars }), ...(converted ? { converted } : {}), ...listed };
}

/** A page's text as a reading service gives it, as a Read's: textOf, the links it writes (linksWithin), and `inline`. */
export const writtenRead = (text: string, whole: boolean): Pick<Read, "links" | "links_omitted" | "inline"> & Text => ({ ...textOf(text, whole), ...linksWithin(linksOf(text)), inline: true });

/** A page a provider read for us as markdown (Parallel's extract, keyless Firecrawl's scrape), as a Read: its url,
 *  title and status, the text (`whole`: all of the page's, so its length is the page's) and the links it holds, each
 *  written in its text (writtenRead). */
export const markdownRead = (url: string, title: string, text: string, whole: boolean, status = 200): Read => ({ ok: true, url: clip(withoutCredentials(url), URL_MAX), status, title: clip(title, TITLE_CAP), ...writtenRead(text, whole) });
