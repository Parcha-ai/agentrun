// web_fetch's core: a page read once a run by the providers named in order, the guarded direct fetch behind them, given
// in parts. A URL goes to a provider only once the guard's check passes it, and a read that fails is not kept.
import type { Guard, GuardOptions } from "./guard.js";
import { askedUrl, HTML_READ_CHARS, PAGE_READ_MAX_CHARS, type Page, type Part, partOfRead, type Read, TIMEOUT_MS, type Unread, URL_MAX, withoutCredentials, withoutUserinfo } from "./page.js";
import { readDirect } from "./providers/direct.js";
import type { KeylessFetch } from "./providers/firecrawl-keyless.js";
import type { Extract } from "./providers/parallel.js";

const PORTS = new Set(["", "80", "443"]);

/** How many pages a run keeps what it read of (Pages): each at most PAGE_READ_MAX_CHARS characters of text. */
export const PAGES_HELD = 8;

/** `parallel`, where Parallel was asked for the page and gave none: why, on the page fetched directly after it, or on
 *  the failed page ("none") where nothing after it read one. `via` "none": the caller's order holds no direct fetch,
 *  and no provider in it read the page. */
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
/** One provider a read asked, as it answered, or Parallel passed over with why (its "not tried: ..."): a turn of a
 *  fetch's receipt. */
export type FetchTry = { provider: FetchProvider; outcome: "ok" | "error"; error?: string };

/** The URL a provider is sent for `url`, as parsed (its `href`), so the provider reads the host the guard checked; or
 *  `why` it may not go: readDirect's own refusals, in its words (not a URL, the href's length, the port, a user name or
 *  password), no guard, or the guard's check failing within `ms` and the caller's signal (a check out of time too). */
async function passes(url: unknown, guard: Guard | undefined, options: GuardOptions, ms: number): Promise<{ href: string } | { why: string }> {
  const target = typeof url === "string" ? URL.parse(url) : null;
  if (!target) return { why: "url is not an absolute URL" };
  if (target.href.length > URL_MAX) return { why: `url is longer than ${URL_MAX.toLocaleString("en-US")} characters` };
  if (!PORTS.has(target.port)) return { why: `port ${target.port} is not 80 or 443` };
  if (target.username || target.password) return { why: "the URL holds a user name or password" };
  if (!guard) return { why: "no public-host guard was given" };
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(options.signal ? [options.signal] : [])]);
  return guard.check(target.href, { ...(options.lookup ? { lookup: options.lookup } : {}), signal }).then(() => ({ href: target.href }), () => ({ why: "the URL did not pass the public-host guard" }));
}

/** What one read is given: the provider clients, the order they are asked in, the guard, the check's bound, the log,
 *  `tried` (told each turn as it ends) and `noParallel` (why the order's Parallel has no client, where the caller knows). */
type ReadWith = { parallel?: Extract | null; firecrawl?: KeylessFetch | null; order: readonly FetchProvider[]; guard?: Guard; checkMs: number; options: GuardOptions; log?: WebLog; tried?: (one: FetchTry) => void; noParallel?: string };

/** The page at `url` read once, by the providers of `order` in turn: keyless Firecrawl or Parallel where its client is
 *  given and live and the guard passes the URL within `checkMs` (default the guarded fetch's 30 s), the guarded fetch
 *  at "direct", which answers whatever it reads. A page fetched directly where `parallel` was given says why Parallel
 *  gave none (`parallel`). */
async function readOnce(url: unknown, { parallel, firecrawl, order, guard, checkMs, options, log, tried, noParallel }: ReadWith): Promise<WebRead | WebUnread> {
  let firecrawlSaid: string | undefined;
  let why: string | undefined;
  // Each turn told where it ends, so every provider asked is told, whichever answers the page or none does. What a
  // provider says reaches it with no URL's user name or password in it: scrubbed whole as it is read, before any cut
  // (withoutUserinfo; readDirect scrubs its own).
  const turn = (provider: FetchProvider, read: Read | Unread | string) =>
    tried?.(typeof read === "string" ? { provider, outcome: "error", error: read } : read.ok ? { provider, outcome: "ok" } : { provider, outcome: "error", error: read.refused ?? read.error ?? "" });
  for (const provider of order) {
    if (provider === "firecrawl-keyless") {
      const sent = firecrawl?.live() ? await passes(url, guard, options, checkMs) : null;
      if (firecrawl && sent && "href" in sent) {
        const read = await firecrawl.read(sent.href, options.signal);
        if (typeof read !== "string") {
          turn("firecrawl-keyless", read);
          // A second scrub behind the client's own, kept on purpose: it covers a url the client did not clear and has not cut.
          return { ...read, url: withoutCredentials(read.url), via: "firecrawl-keyless" };
        }
        firecrawlSaid = withoutUserinfo(read);
        turn("firecrawl-keyless", firecrawlSaid.slice(0, 300));
      }
    } else if (provider === "parallel") {
      const sent = parallel?.live() ? await passes(url, guard, options, checkMs) : null;
      if (!parallel) why = noParallel;
      // Asked again after the check: a refusal while it ran turns Parallel off for this read too.
      else if (!parallel.live() || !sent) why = "not tried: refused earlier in this run";
      else if ("why" in sent) why = `not tried: ${sent.why}`;
      else {
        const read = await parallel.read(sent.href, options.signal);
        if (typeof read !== "string") {
          turn("parallel", read);
          // A second scrub behind the client's own, kept on purpose: it covers a url the client did not clear and has not cut.
          return { ...read, url: withoutCredentials(read.url), via: "parallel" };
        }
        why = withoutUserinfo(read);
      }
      if (why !== undefined) turn("parallel", why);
    } else {
      const direct = await readDirect(url, guard, options);
      turn("direct", direct);
      // Why Firecrawl gave no page goes to the log, never to the model (the page is the direct fetch's); never the URL.
      if (firecrawlSaid !== undefined) log?.("web_fetch_firecrawl_failed", { said: firecrawlSaid.slice(0, 300), direct: direct.ok ? "read" : "failed" });
      // A second scrub behind readDirect's own, kept on purpose: it covers a url readDirect did not clear and has not cut.
      // No test reaches it: readDirect clears every url it names, the URL asked and the one its fetch ended at alike.
      return { ...direct, url: withoutCredentials(direct.url), via: "direct", ...(why ? { parallel: why } : {}) };
    }
  }
  return { ok: false, url: askedUrl(url), status: 0, title: "", text: "", links: [], error: "no provider in the order read the page, and it holds no direct fetch", via: "none", ...(why ? { parallel: why } : {}) };
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
  const stopped = (): WebUnread => ({ ok: false, url: askedUrl(url), status: 0, title: "", text: "", links: [], error: "the call was stopped before the page arrived", via: "stopped" });
  if (signal.aborted) return Promise.resolve(stopped());
  return new Promise((resolve, reject) => {
    const onStop = () => resolve(stopped());
    signal.addEventListener("abort", onStop, { once: true });
    reading.then((read) => (signal.removeEventListener("abort", onStop), resolve(read)), (error: unknown) => (signal.removeEventListener("abort", onStop), reject(error)));
  });
}

/** What webFetch is given: the guard's resolver and fetch (a test's) and the part, the provider clients (`parallel`,
 *  `firecrawl`) and their `order` (FETCH_ORDER by default), the run's `pages`, the `guard`, the guard check's bound
 *  (`checkMs`), the `log`, `tried`, told each provider the read asks as it answers (never on a page from `pages`), and
 *  `noParallel`, what a page fetched past an order's Parallel with no client says of it. */
export type WebFetchOptions = GuardOptions & Part & { parallel?: Extract | null; firecrawl?: KeylessFetch | null; pages?: Pages; order?: readonly FetchProvider[]; guard?: Guard; checkMs?: number; log?: WebLog; tried?: (one: FetchTry) => void; noParallel?: string };

/** The part (`offset`, `maxChars`) of the page at `url` as a WebPage: from `pages`, the run's, where it holds the URL
 *  (read, or being read), with no request of its own; else read once (readOnce), kept there from the read's start. A read
 *  that fails leaves `pages`, so a later call reads again. The read is the run's, not a caller's: no caller's signal
 *  reaches it (it keeps Parallel's and the fetch's own time limits), so one caller's stop never fails another's; each
 *  caller stops waiting at its own signal (untilStopped). */
export async function webFetch(url: unknown, { parallel, firecrawl, pages, order = FETCH_ORDER, guard, checkMs = TIMEOUT_MS, offset, maxChars, signal, log, tried, noParallel, ...options }: WebFetchOptions = {}): Promise<WebPage> {
  const named = typeof url === "string" ? url : undefined;
  let reading = named === undefined ? undefined : pages?.get(named);
  if (!reading) {
    const started = readOnce(url, { parallel, firecrawl, order, guard, checkMs, options, log, tried, noParallel });
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

/** A page as the tool `name` answers the model: its JSON, then a line saying why Parallel gave none where it was picked
 *  (and that the page was fetched directly, only where it was), and one saying where this part is in the page when it
 *  is not all of it. */
export function webFetchText(page: WebPage | Page, name: string = "web_fetch"): string {
  const lines = [JSON.stringify(page)];
  if ("parallel" in page && page.parallel) lines.push(`Parallel was picked for web_fetch and gave no page (${page.parallel})${page.via === "direct" ? "; this one was fetched directly" : ""}.`);
  const where = partLine(page, name);
  if (where) lines.push(where);
  return lines.join("\n");
}
