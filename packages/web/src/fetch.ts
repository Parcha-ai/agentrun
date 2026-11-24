// web_fetch's core: a page read once a run by the providers named in order, the guarded direct fetch behind them, given
// in parts. A URL goes to a provider only once the guard's check passes it, and a read that fails is not kept.
import type { FoundPage } from "./decide/fetch.js";
import { unmetered } from "./fees.js";
import type { Guard, GuardOptions } from "./guard.js";
import { clip, HTML_READ_CHARS, PAGE_READ_MAX_CHARS, type Page, type Part, partOfRead, type Read, TIMEOUT_MS, type Unread, URL_MAX } from "./page.js";
import { HELD_CODE, holdingWords, type Reader } from "./provider.js";
import { AHEAD, type AheadProvider, type FetchProvider, providerName, providerOf } from "./providers/registry.js";
import { type Failure, failure, type Limit, type Try } from "./search.js";

const PORTS = new Set(["", "80", "443"]);

/** How many pages a run keeps what it read of (Pages): each at most PAGE_READ_MAX_CHARS characters of text. */
export const PAGES_HELD = 8;

/** How a page came: `via`, the provider that gave it ("none": the caller's order holds no provider that ends it, and no
 *  provider in it read the page; "stopped": the call was stopped first); under the id of each provider asked ahead of it
 *  (AheadProvider, provider.ts FetchShape) that gave none, why, where the guarded direct fetch answered or none did
 *  (never on a page another provider read). */
export type Via = { via: FetchProvider | "stopped" | "none" } & Partial<Record<AheadProvider, string>>;
export type WebPage = Page & Via;
/** A page web_fetch read, and how. */
export type WebRead = Read & Via;
/** A page web_fetch could not read, and how it tried. */
export type WebUnread = Unread & Via;
/** The pages a run reads, by the URL asked for, each from its read's start (so calls at once share it), the last used
 *  last: at most PAGES_HELD of them. */
export type Pages = Map<string, Promise<WebRead | WebUnread>>;
/** The readers a read asks, by provider: each held or not, each read one page (provider.ts Reader). */
export type Readers = Partial<Record<FetchProvider, Reader>>;
/** The order a read takes when none is given: keyless Firecrawl, then Parallel, each where its reader is given, then the
 *  guarded direct fetch. */
export const FETCH_ORDER: readonly FetchProvider[] = ["firecrawl-keyless", "parallel", "direct"];
/** Where a read notes what the model is not told: an event and its fields (serve writes them as a log line). A provider
 *  whose misses are logged (provider.ts FetchShape) notes its event with what it `said` (in our words, at most 300
 *  characters) and, logged at once, its `provider` and the `limit` it met, as JSON, if any; logged once a provider that
 *  ends the order answered, whether that one `direct`ly "read" the page or "failed". */
export type WebLog = (event: string, fields: Record<string, string>) => void;

/** Whether `url` may go to a provider: readDirect's own refusals (port, length, a user name or password) pass it, and so
 *  does the guard's check within `ms` and the caller's signal. No guard, or a check out of time, does not pass. */
async function passes(url: string, guard: Guard | undefined, options: GuardOptions, ms: number): Promise<boolean> {
  const target = URL.parse(url);
  if (!guard || !target || !PORTS.has(target.port) || url.length > URL_MAX || target.username || target.password) return false;
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(options.signal ? [options.signal] : [])]);
  return guard.check(url, { ...(options.lookup ? { lookup: options.lookup } : {}), signal }).then(() => true, () => false);
}

/** What one read is given: the readers, the order they are asked in, the guard, the check's bound, the log, and where its
 *  turns go. */
type ReadWith = { readers: Readers; order: readonly FetchProvider[]; guard?: Guard; checkMs: number; options: GuardOptions; log?: WebLog; tries: Try[] };

/** The page at `url` read once, by the providers of `order` in turn, each turn recorded in `tries` as it is taken. A
 *  provider that ends the order (the guarded direct fetch) answers whatever it reads. Any other is asked where its reader
 *  is given and not held and the guard passes the URL within `checkMs`; why a read gave no page, or why a turn was not
 *  asked, is said on the page, and logged or recorded as its FetchShape says. */
async function readOnce(url: unknown, { readers, order, guard, checkMs, options, log, tries }: ReadWith): Promise<WebRead | WebUnread> {
  const said: Partial<Record<AheadProvider, string>> = {};
  const logged: { event: string; said: string }[] = [];
  for (const id of order) {
    const shape = providerOf(id).fetch;
    const reader = readers[id];
    if (!shape || !reader) continue;
    if (shape.ends) {
      // Its failure, typed, is the receipt's, never the page's.
      const { failure, ...read } = (await reader.read(url, options)) as (Read | Unread) & { failure?: Failure };
      // Why a provider ahead gave no page is logged as well as said, never with the URL.
      for (const miss of logged) log?.(miss.event, { said: miss.said, direct: read.ok ? "read" : "failed" });
      tries.push({ provider: id, outcome: read.ok ? "ok" : "error", ...(read.ok ? {} : { error: read.refused ?? read.error ?? "" }), ...(failure ? { failure } : {}) });
      return { ...read, via: id, ...said };
    }
    const held = reader.held();
    const why = held ?? (typeof url === "string" && (await passes(url, guard, options, checkMs)) ? undefined : failure("refused", "GUARD", "not tried: the URL did not pass the public-host guard"));
    if (why !== undefined) {
      if (shape.miss === "said" || held) said[id as AheadProvider] = why.message;
      // A turn its breaker holds is on the receipt as search's is; a said provider's other unasked turns are failed ones.
      if (held?.code === HELD_CODE) tries.push({ provider: id, outcome: "held", failure: held, ms: 0 });
      else if (shape.miss === "said") tries.push({ provider: id, outcome: "error", error: why.message, failure: why });
      continue;
    }
    const read = await reader.read(url, options);
    if ("ok" in read && read.ok) {
      tries.push({ provider: id, outcome: "ok" });
      // A reason is said only beside the direct fetch's answer or none's: webFetchText's line says it was fetched directly.
      return { ...read, via: id };
    }
    const error = read.error ?? "";
    const limit: Limit | undefined = "limit" in read ? read.limit : undefined;
    const typed = "failure" in read && read.failure ? { failure: read.failure } : {};
    // A read that met a limit is said by what holds the provider now, never by the provider's words for it.
    const holding = limit ? reader.holding?.() : undefined;
    const words = holding ? holdingWords(holding) : error;
    if (shape.miss === "said") {
      said[id as AheadProvider] = words;
      tries.push({ provider: id, outcome: "error", error, ...typed });
      continue;
    }
    said[id as AheadProvider] = words.slice(0, 300);
    tries.push({ provider: id, outcome: "error", ...(error ? { error: error.slice(0, 300) } : {}), ...typed, ...(limit ? { limit } : {}) });
    if (shape.miss.when === "failed") log?.(shape.miss.log, { provider: id, said: error.slice(0, 300), ...(limit ? { limit: JSON.stringify(limit) } : {}) });
    else logged.push({ event: shape.miss.log, said: error.slice(0, 300) });
  }
  return { ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: "no provider in the order read the page, and it holds no direct fetch", via: "none", ...said };
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

/** What webFetch is given: the guard's resolver and fetch (a test's) and the part, the `readers` and their `order`
 *  (FETCH_ORDER by default; a provider that ends it is made here where no reader is given for it), the run's `pages`,
 *  the `guard`, the guard check's bound (`checkMs`), the `log`, and `tries`, where a read this call starts records its
 *  turns (a call answered from `pages` records none). */
export type WebFetchOptions = GuardOptions & Part & { readers?: Readers; pages?: Pages; order?: readonly FetchProvider[]; guard?: Guard; checkMs?: number; log?: WebLog; tries?: Try[] };

/** The page at `url` as read once a run: from `pages`, the run's, where it holds the URL (read, or being read), with no
 *  request of its own; else read once (readOnce), kept there from the read's start. A read that fails leaves `pages`, so
 *  a later call reads again. The read is the run's, not a caller's: no caller's signal reaches it (it keeps Parallel's
 *  and the fetch's own time limits), so one caller's stop never fails another's; each caller stops waiting at its own
 *  signal (untilStopped). */
export async function webRead(url: unknown, { readers = {}, pages, order = FETCH_ORDER, guard, checkMs = TIMEOUT_MS, signal, log, tries = [], ...options }: Omit<WebFetchOptions, keyof Part> = {}): Promise<WebRead | WebUnread> {
  const named = typeof url === "string" ? url : undefined;
  let reading = named === undefined ? undefined : pages?.get(named);
  if (!reading) {
    const ending = order.filter((id) => !readers[id] && providerOf(id).fetch?.ends).map((id) => [id, endingReader(id, guard)] as const);
    const started = readOnce(url, { readers: { ...readers, ...Object.fromEntries(ending) }, order, guard, checkMs, options, log, tries });
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
  return untilStopped(url, reading, signal);
}

/** A provider that ends the order, made for one read through `guard`: never held. */
function endingReader(id: FetchProvider, guard: Guard | undefined): Reader {
  const run = providerOf(id).make({ ...(guard ? { guard } : {}), pay: unmetered, now: Date.now });
  return { held: () => undefined, read: (url, options) => run.read!(url, options) };
}

/** The part `part` names of a page read once (webRead), as a WebPage, how it came after it; a read that failed as it is. */
export function webPart(read: WebRead | WebUnread, part: Part = {}): WebPage {
  if (!read.ok) return read;
  const { via, ...page } = read;
  const said = missesOf(read);
  for (const id of AHEAD) delete page[id];
  return { ...partOfRead(page, part), via, ...said };
}

const AHEAD_IDS: ReadonlySet<string> = new Set(AHEAD);
/** Why each provider asked ahead of the one that gave `page` gave none, by its id (Via), in the order they were asked. */
export function missesOf(page: object): Partial<Record<AheadProvider, string>> {
  return Object.fromEntries(Object.entries(page).filter(([id, why]) => AHEAD_IDS.has(id) && typeof why === "string"));
}

/** The part (`offset`, `maxChars`) of the page at `url` as a WebPage: webPart of webRead. */
export async function webFetch(url: unknown, { offset, maxChars, ...options }: WebFetchOptions = {}): Promise<WebPage> {
  return webPart(await webRead(url, options), { offset, maxChars });
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

/** What answered after the providers ahead gave no page: the direct fetch, or nothing (Via: reasons are said only there). */
function cameBy(via: unknown): string {
  return via === "none" ? "no provider after it read the page" : "this one was fetched directly";
}

/** A page as the tool `name` answers the model: its JSON, then a line for each picked provider that gave none saying why
 *  and what gave the page instead, and one saying where this part is in the page when it is not all of it. */
export function webFetchText(page: WebPage | Page | FoundPage, name: string = "web_fetch"): string {
  const lines = [JSON.stringify(page)];
  const came = cameBy((page as { via?: unknown }).via);
  for (const [id, why] of Object.entries(missesOf(page))) {
    if (why) lines.push(`${providerName(id)} was picked for web_fetch and gave no page (${why}); ${came}.`);
  }
  const where = "found" in page ? undefined : partLine(page, name);
  if (where) lines.push(where);
  return lines.join("\n");
}
