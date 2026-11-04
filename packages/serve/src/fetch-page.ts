// The guarded direct fetch: one web page from a public host, as a Page: { ok, url, status, title, text, chars, links,
// refused?, error? }. web_fetch reads a page through it (web-fetch.ts); fetch_page, its legacy name, runs web_fetch. The
// fetch is pi-browser's public-host guard (publicFetch): every redirect hop resolved, checked and dialled at the address
// checked, http(s) only, a byte cap and a timeout. Before it, a URL on a port other than 80 or 443, or longer than
// URL_MAX, is refused here as well. A refusal or a failure is a Page with ok false, never a throw, so an agent reads why
// and a workflow can branch on it.
//
// A page's text comes in parts: about max_chars characters from offset (a Part), counted as the answer holds them, so a
// part is within its bound whatever the page holds. A part that is not the whole page says so: truncated while more
// follows, with the offset that reads on (next_offset), and the page's whole length (original_chars) where it is known.
// Every field of a Page is held to a cap (its text, its title, its URL, its links), so one answer is too: serve's
// host-bounds test holds it to the host's result bound.
import { pathToFileURL } from "node:url";
import type { TSchema } from "@earendil-works/pi-ai";
import type { PublicFetchOptions } from "@parcha/pi-browser";

/** On a page that was read, `chars`: the length of `text`, the part of the page's text this answer holds. `truncated`
 *  while more of it follows this part, and `next_offset` where that begins; `offset` where this part begins, when not 0;
 *  `original_chars` the whole text's length in characters, when it is known and this part is not all of it.
 *  `html_chars`, on every part of a page whose HTML readPage cut before it was read: the page's whole length in
 *  characters. Its text, all its parts together, is then the start of the page's, so no part gives original_chars, and
 *  the last part (no truncated: no part follows) still says the page was cut. `converted: "text"` when the text is the
 *  page's plain text, its conversion to markdown having run out of time. */
export type Page = { ok: boolean; url: string; status: number; title: string; text: string; chars?: number; truncated?: true; original_chars?: number; offset?: number; next_offset?: number; html_chars?: number; converted?: "text"; links: string[]; refused?: string; error?: string };

/** web_fetch's legacy name: a revision or a call node naming it runs web_fetch under it (tools.ts). */
export const FETCH_PAGE_TOOL = "fetch_page";
/** Under `--faux` only: a module whose default export gives `{ lookup, fetchImpl }` for the fetch (the tests' fake
 *  network), in place of the system's resolver and undici. */
export const FAUX_WEB_ENV = "AGENTRUN_SERVE_FAUX_WEB";
/** The most of a page's text one answer holds (max_chars at most), what it holds when max_chars is not given, and the
 *  least max_chars a tool's call may ask for (a smaller one is refused, saying so). */
export const TEXT_CAP = 50_000;
export const PAGE_CHARS = 20_000;
export const MAX_CHARS_MIN = 200;
/** A page's links, with its first part only: at most LINKS_CAP of them, in at most LINKS_CHARS characters of the answer. */
export const LINKS_CAP = 200;
export const LINKS_CHARS = 20_000;
export const TITLE_CAP = 500;
/** The longest URL fetched: a longer one is refused before anything is sent. */
export const URL_MAX = 4_096;
export const TIMEOUT_MS = 30_000;
/** Where readPage cuts a page's HTML before it reads it, scripts and styles aside: pi-browser's READ_MAX_CHARS, held here
 *  so the tool's words name it without loading pi-browser where nothing is fetched (fetch-page-cut.test holds the two
 *  equal). */
export const HTML_READ_CHARS = 1_000_000;

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Which part of a page's text an answer holds: from `offset` (0 by default), about `maxChars` characters (PAGE_CHARS by
 *  default, at most TEXT_CAP). */
export type Part = { offset?: number; maxChars?: number };
/** Why a tool's call may not read `part`, or undefined: an offset that is not a whole number of 0 or more, a maxChars that
 *  is not a number of MAX_CHARS_MIN or more (one past TEXT_CAP reads TEXT_CAP). */
export function partProblem({ offset, maxChars }: Part): string | undefined {
  const shown = (value: unknown) => (typeof value === "number" ? String(value) : String(JSON.stringify(value)).slice(0, 40));
  if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0)) return `offset must be a whole number, 0 or more (it was ${shown(offset)})`;
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

/** The part of a page's `text` an answer holds, and what it says of the rest. `whole`: whether `text` is all of the
 *  page's text, so its length is the page's (a provider that cut it has none to give). */
export function pageText(text: string, part: Part = {}, whole = true): Pick<Page, "text" | "chars" | "truncated" | "original_chars" | "offset" | "next_offset"> {
  const { offset, maxChars } = partOf(part);
  const start = Math.min(offset, text.length);
  const end = partEnd(text, start, maxChars);
  const held = text.slice(start, end);
  const more = end < text.length;
  return {
    text: held,
    chars: held.length,
    ...(more ? { truncated: true as const } : {}),
    ...(whole && (offset > 0 || more) ? { original_chars: text.length } : {}),
    ...(offset > 0 ? { offset } : {}),
    ...(more ? { next_offset: end } : {}),
  };
}

/** A page's links as an answer holds them: with its first part only, in page order, at most LINKS_CAP of them, each one
 *  that fits in what is left of LINKS_CHARS (as JSON, with its comma). */
export function linksWithin(links: Iterable<string>, part: Part = {}): string[] {
  if (partOf(part).offset > 0) return [];
  const kept: string[] = [];
  let used = 0;
  for (const link of links) {
    if (kept.length === LINKS_CAP) break;
    const cost = JSON.stringify(link).length + 1;
    if (used + cost > LINKS_CHARS) continue;
    kept.push(link);
    used += cost;
  }
  return kept;
}

/** The part `options` names of the page at `url`, as a Page. The rest of `options` are the guard's resolver and fetch,
 *  for a test; a signal ends it early. */
export async function fetchPage(url: unknown, { offset, maxChars, ...options }: Omit<PublicFetchOptions, "maxBytes"> & Part = {}): Promise<Page> {
  const failed = (fields: Partial<Page> & ({ refused: string } | { error: string })): Page => ({ ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], ...fields });
  if (typeof url !== "string" || !URL.canParse(url)) return failed({ error: "url is not an absolute URL" });
  if (url.length > URL_MAX) return failed({ error: `url is longer than ${URL_MAX.toLocaleString("en-US")} characters` });
  const { port } = new URL(url);
  if (port && port !== "80" && port !== "443") return failed({ refused: `refused: port ${port} is not 80 or 443` });
  const { BrowserFailureError, publicFetch, readPage } = await import("@parcha/pi-browser");
  const part = { offset, maxChars };
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const answer = await publicFetch(url, { ...options, signal });
    if (answer.body === null) return failed({ url: clip(answer.url, URL_MAX), status: answer.status, error: `the page answered ${answer.status}` });
    // The caller's stop reaches the read too; the timeout is the network's, and readPage keeps its own deadline.
    const read = /html/i.test(answer.contentType) ? await readPage(answer.body, answer.url, options.signal ? { signal: options.signal } : {}) : null;
    const page = read ?? { title: "", text: answer.body, links: [] };
    return { ok: true, url: clip(answer.url, URL_MAX), status: answer.status, title: clip(page.title, TITLE_CAP), ...pageText(page.text, part, !read?.truncated), ...(read?.truncated ? { html_chars: read.html_chars! } : {}), ...(read?.converted === "text" ? { converted: "text" as const } : {}), links: linksWithin(page.links, part) };
  } catch (error) {
    if (error instanceof BrowserFailureError && error.failure.code === "refused") return failed({ refused: error.message });
    return failed({ error: (error as Error)?.message ?? String(error) });
  }
}

/** The fetch's resolver and fetch in the run's process: the faux module's under `--faux` with one named, else none. */
export async function fetchOptions(env: NodeJS.ProcessEnv, fauxEnv: string): Promise<Omit<PublicFetchOptions, "maxBytes" | "signal">> {
  const faux = env[fauxEnv] ? env[FAUX_WEB_ENV] : undefined;
  if (!faux) return {};
  return ((await import(pathToFileURL(faux).href)) as { default: () => Omit<PublicFetchOptions, "maxBytes" | "signal"> }).default();
}

/** A page tool's arguments: `url`, and the part of its text to read (`offset`, `max_chars`). */
export const URL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1, description: "An absolute http(s) URL." },
    offset: { type: "integer", minimum: 0, description: "Where in the page's text to start, in characters (default 0). An answer that stops short of the page's end gives the offset that reads on." },
    max_chars: { type: "integer", minimum: MAX_CHARS_MIN, maximum: TEXT_CAP, description: `About how many characters of the page's text to read (default ${PAGE_CHARS.toLocaleString("en-US")}, at least ${MAX_CHARS_MIN}, at most ${TEXT_CAP.toLocaleString("en-US")}).` },
  },
  required: ["url"],
} as unknown as TSchema;
