// web_fetch's core: a page read once a run, given in parts, by the providers a caller names in order (data: serve maps
// its plane's resolution to one), with the guarded direct fetch behind them. A provider is asked only when its client is
// given and live, and only once the public-host guard's own check passes the URL (its name resolved, every address
// public): a private, loopback, link-local or intranet URL is never sent to a third party, and is answered with the
// direct fetch's refusal, as it is with no provider at all. With no guard given nothing passes and nothing is fetched.
// A page fetched directly where Parallel was given says why Parallel gave none (`parallel`): a picked provider that
// fails is never a silent fallback. Keyless Firecrawl is a free service with the direct fetch behind it, by design, and
// why it gave no page goes to the caller's log, never to the model.
//
// A page is read once a run and given in parts (page.ts): `offset` and `maxChars` name the part. The first call for a URL
// reads the page, and the run keeps what it read by the URL asked for (Pages, the last PAGES_HELD pages), from the
// moment the read starts: every later part of that URL, and a call made while it is read, comes from it, with no request
// and, through Parallel, no bill. A read that fails is not kept. So a page's parts are always one read's, by one
// provider.
import type { Guard, GuardOptions } from "./guard.js";
import { clip, HTML_READ_CHARS, PAGE_READ_MAX_CHARS, type Page, type Part, partOfRead, type Read, TIMEOUT_MS, type Unread, URL_MAX } from "./page.js";
import { readDirect } from "./providers/direct.js";
import type { KeylessFetch } from "./providers/firecrawl-keyless.js";
import type { Extract } from "./providers/parallel.js";

const PORTS = new Set(["", "80", "443"]);

/** How many pages a run keeps what it read of (Pages): each at most PAGE_READ_MAX_CHARS characters of text. */
export const PAGES_HELD = 8;

/** `parallel`, on a page fetched directly where Parallel was asked for one: why Parallel gave none. `via` "none": the
 *  caller's order holds no direct fetch, and no provider in it read the page. */
export type WebPage = Page & { via: "parallel" | "firecrawl-keyless" | "direct" | "stopped" | "none"; parallel?: string };
/** A page web_fetch read, and how (WebPage's `via` and `parallel`). */
export type WebRead = Read & Pick<WebPage, "via" | "parallel">;
/** A page web_fetch could not read, and how it tried. */
export type WebUnread = Unread & Pick<WebPage, "via" | "parallel">;
/** The pages a run reads, by the URL asked for, each from its read's start (so calls at once share it), the last used
 *  last: at most PAGES_HELD of them. */
export type Pages = Map<string, Promise<WebRead | WebUnread>>;
/** A fetch provider, as an order names it. */
export type FetchProvider = "firecrawl-keyless" | "parallel" | "direct";
/** The order a read takes when none is given: keyless Firecrawl, then Parallel, each where its client is given, then the
 *  guarded direct fetch. */
export const FETCH_ORDER: readonly FetchProvider[] = ["firecrawl-keyless", "parallel", "direct"];
/** Where a read notes what the model is not told: an event and its fields (serve writes them as a log line). */
export type WebLog = (event: string, fields: Record<string, string>) => void;

/** Whether `url` may go to a provider: readDirect's own refusals (port, length, a user name or password) pass it, and so
 *  does the guard's check within `ms` and the caller's signal. No guard, or a check out of time, does not pass. */
async function passes(url: string, guard: Guard | undefined, options: GuardOptions, ms: number): Promise<boolean> {
  const target = URL.parse(url);
  if (!guard || !target || !PORTS.has(target.port) || url.length > URL_MAX || target.username || target.password) return false;
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(options.signal ? [options.signal] : [])]);
  return guard.check(url, { ...(options.lookup ? { lookup: options.lookup } : {}), signal }).then(() => true, () => false);
}

/** What one read is given: the provider clients, the order they are asked in, the guard, the check's bound and the log. */
type ReadWith = { parallel?: Extract | null; firecrawl?: KeylessFetch | null; order: readonly FetchProvider[]; guard?: Guard; checkMs: number; options: GuardOptions; log?: WebLog };

/** The page at `url` read once, by the providers of `order` in turn: keyless Firecrawl or Parallel where its client is
 *  given and live and the guard passes the URL within `checkMs` (default the guarded fetch's 30 s), the guarded fetch
 *  at "direct", which answers whatever it reads. A page fetched directly where `parallel` was given says why Parallel
 *  gave none (`parallel`). */
async function readOnce(url: unknown, { parallel, firecrawl, order, guard, checkMs, options, log }: ReadWith): Promise<WebRead | WebUnread> {
  let firecrawlSaid: string | undefined;
  let why: string | undefined;
  for (const provider of order) {
    if (provider === "firecrawl-keyless") {
      if (firecrawl?.live() && typeof url === "string" && (await passes(url, guard, options, checkMs))) {
        const read = await firecrawl.read(url, options.signal);
        if (typeof read !== "string") return { ...read, via: "firecrawl-keyless" };
        firecrawlSaid = read;
      }
    } else if (provider === "parallel") {
      if (parallel && !parallel.live()) why = "not tried: refused earlier in this run";
      else if (parallel && !(typeof url === "string" && (await passes(url, guard, options, checkMs)))) why = "not tried: the URL did not pass the public-host guard";
      else if (parallel) {
        const read = await parallel.read(url as string, options.signal);
        if (typeof read !== "string") return { ...read, via: "parallel" };
        why = read;
      }
    } else {
      const direct = await readDirect(url, guard, options);
      // Why Firecrawl gave no page goes to the log, never to the model (the page is the direct fetch's); never the URL.
      if (firecrawlSaid !== undefined) log?.("web_fetch_firecrawl_failed", { said: firecrawlSaid.slice(0, 300), direct: direct.ok ? "read" : "failed" });
      return { ...direct, via: "direct", ...(why ? { parallel: why } : {}) };
    }
  }
  return { ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: "no provider in the order read the page, and it holds no direct fetch", via: "none", ...(why ? { parallel: why } : {}) };
}

/** The reads that have ended: only these leave `pages` past its bound (trim). */
const settled = new WeakSet<Promise<WebRead | WebUnread>>();
/** `pages` down to PAGES_HELD reads that have ENDED, dropping the least recently used of those first. Only ended reads
 *  count toward the bound, and only they are dropped: a read under way stays until it ends (a caller may be about to
 *  share it, and dropping it would read and bill the page again), and it never makes room by pushing out a page that has
 *  ended. So the run holds at most PAGES_HELD ended reads plus the ones still under way, and trims again as each ends. */
function trim(pages: Pages): void {
  let ended = 0;
  for (const read of pages.values()) if (settled.has(read)) ended++;
  for (const [held, read] of pages) {
    if (ended <= PAGES_HELD) return;
    if (settled.has(read)) (pages.delete(held), ended--);
  }
}

/** `reading`, or, as soon as `signal` stops this call, a failed page saying so (as a stopped read reads): the read
 *  itself goes on for the run's other callers of the URL, within its own time limits. */
function untilStopped(url: unknown, reading: Promise<WebRead | WebUnread>, signal?: AbortSignal): Promise<WebRead | WebUnread> {
  if (!signal) return reading;
  // No page came for this call, by any path: never "direct", which says the host was fetched.
  const stopped = (): WebUnread => ({ ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: "the call was stopped before the page arrived", via: "stopped" });
  if (signal.aborted) return Promise.resolve(stopped());
  return new Promise((resolve, reject) => {
    const onStop = () => resolve(stopped());
    signal.addEventListener("abort", onStop, { once: true });
    reading.then((read) => (signal.removeEventListener("abort", onStop), resolve(read)), (error: unknown) => (signal.removeEventListener("abort", onStop), reject(error)));
  });
}

/** What webFetch is given: the guard's resolver and fetch (a test's) and the part, the provider clients (`parallel`,
 *  `firecrawl`) and their `order` (FETCH_ORDER by default), the run's `pages`, the `guard`, the guard check's bound
 *  (`checkMs`) and the `log`. */
export type WebFetchOptions = GuardOptions & Part & { parallel?: Extract | null; firecrawl?: KeylessFetch | null; pages?: Pages; order?: readonly FetchProvider[]; guard?: Guard; checkMs?: number; log?: WebLog };

/** The part (`offset`, `maxChars`) of the page at `url` as a WebPage: from `pages`, the run's, where it holds the URL
 *  (read, or being read), with no request of its own; else read once (readOnce), kept there from the read's start. A read
 *  that fails leaves `pages`, so a later call reads again. The read is the run's, not a caller's: no caller's signal
 *  reaches it (it keeps Parallel's and the fetch's own time limits), so one caller's stop never fails another's; each
 *  caller stops waiting at its own signal (untilStopped). */
export async function webFetch(url: unknown, { parallel, firecrawl, pages, order = FETCH_ORDER, guard, checkMs = TIMEOUT_MS, offset, maxChars, signal, log, ...options }: WebFetchOptions = {}): Promise<WebPage> {
  const named = typeof url === "string" ? url : undefined;
  let reading = named === undefined ? undefined : pages?.get(named);
  if (!reading) {
    const started = readOnce(url, { parallel, firecrawl, order, guard, checkMs, options, log });
    if (pages && named !== undefined) {
      // Ahead of any caller's await, so no call sees a failed read kept.
      const drop = () => void (pages.get(named) === started && pages.delete(named));
      void started.then((read) => { settled.add(started); if (!read.ok) drop(); trim(pages); }, () => { settled.add(started); drop(); });
    }
    reading = started;
  }
  if (pages && named !== undefined) {
    // The last used last: the oldest goes past PAGES_HELD.
    pages.delete(named);
    pages.set(named, reading);
    trim(pages);
  }
  const read = await untilStopped(url, reading, signal);
  if (!read.ok) return read;
  const { via, parallel: why, ...page } = read;
  return { ...partOfRead(page, { offset, maxChars }), via, ...(why ? { parallel: why } : {}) };
}

/** What the part no part follows says of a page whose HTML readPage cut before it was read (html_chars). */
const CUT_LINE = `The page was cut at ${HTML_READ_CHARS.toLocaleString("en-US")} characters of HTML before reading; the rest wasn't read.`;

/** Where a part of a page is in it, for the model: which characters of how many, and the call that reads on; the end of
 *  the page, or where it was cut before it was read; or that the offset is past it. Nothing for a page read whole, or
 *  one that was not read. */
function partLine(page: Page, name: string): string | undefined {
  if (!page.ok || page.chars === undefined) return undefined;
  const start = page.offset ?? 0;
  const end = start + page.chars;
  if (page.truncated) return `Characters ${start}-${end} of ${page.original_chars ?? "a longer page"}: call ${name} again with offset=${page.next_offset ?? end} for the rest.`;
  // No part follows, and the page was cut before it was read: its text ends at the cut, not at the page's end.
  if (page.html_chars !== undefined) return CUT_LINE;
  if (page.beyond_read) return `Characters ${start}-${end}${page.original_chars === undefined ? "" : ` of ${page.original_chars}`}: the page goes on, but web_fetch reads only a page's first ${PAGE_READ_MAX_CHARS.toLocaleString("en-US")} characters.`;
  if (page.original_chars === undefined) return undefined;
  if (page.chars === 0) return `Nothing at offset=${start}: the page has ${page.original_chars} characters.`;
  return `Characters ${start}-${end} of ${page.original_chars}: the end of the page.`;
}

/** A page as the tool `name` answers the model: its JSON, then a line saying why Parallel gave none where it was picked,
 *  and one saying where this part is in the page when it is not all of it. */
export function webFetchText(page: WebPage | Page, name: string = "web_fetch"): string {
  const lines = [JSON.stringify(page)];
  if ("parallel" in page && page.parallel) lines.push(`Parallel was picked for web_fetch and gave no page (${page.parallel}); this one was fetched directly.`);
  const where = partLine(page, name);
  if (where) lines.push(where);
  return lines.join("\n");
}
