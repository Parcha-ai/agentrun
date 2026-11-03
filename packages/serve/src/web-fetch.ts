// web_fetch: fetch_page's Page (fetch-page.ts) plus `via`, the path that served it. It is the kernel's guarded direct
// fetch unless the run's plane resolves it to Parallel (tool-plane.ts: the agent's or the server's pick): then the page is
// read through Parallel's Extract API (https://docs.parallel.ai/api-reference/extract-beta/extract, about $0.001 a URL),
// and when Parallel answers no page (the URL in its `errors`, no content, a 5xx, a timeout) through the guarded direct
// fetch. A URL goes to Parallel only once the public-host guard's own check passes it: a URL the guard refuses is never
// sent, and is answered with the direct fetch's refusal. A 401 or 403 means the key is not served: Parallel is not asked
// again in the run. No request to Parallel is retried: one that failed goes to the direct fetch. A pick of Parallel the
// server holds no key for answers a failed Page saying so, never a fetch of another kind.
// The key is the one the server hands the run's process on its decision descriptor (decisions.ts) when one of its
// capabilities resolves to Parallel, read once and held in this module's memory: never in an environment, a child or a
// file.
//
// A page is read once a run and given in parts (fetch-page.ts): the tool's `offset` and `max_chars` name the part. The
// first call for a URL reads the page, through Parallel or the direct fetch, and the run keeps what it read by the URL
// asked for (Pages, the last PAGES_HELD pages), from the moment the read starts: every later part of that URL, and a call
// made while it is read, comes from it, with no request and, through Parallel, no bill. A read that fails is not kept.
// So a page's parts are always one read's, by one provider. Parallel's extract has no offset (its full
// content always starts at the page's start), so it is asked once for the most of a page web_fetch reads
// (PAGE_READ_MAX_CHARS) and one character more, so a page it cut there shows as going on; the page's whole length is
// known when Parallel gave less (or more) than it was asked for.
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { FAUX_PARALLEL_ENV, fauxFetch, handedKeys, PARALLEL_KEY_ENV } from "./decisions.js";
import { clip, fetchOptions, HTML_READ_CHARS, linksWithin, MAX_CHARS_MIN, PAGE_CHARS, PAGE_READ_MAX_CHARS, type Page, type Part, partOfRead, partProblem, type Read, readDirect, TEXT_CAP, TIMEOUT_MS, TITLE_CAP, textOf, type Unread, URL_MAX, URL_PARAMETERS } from "./fetch-page.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";
import { isUnavailable, planeOf } from "./tool-plane.js";

export const WEB_FETCH_TOOL = "web_fetch";
export const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const PARALLEL_TIMEOUT_MS = 60_000;
const PORTS = new Set(["", "80", "443"]);
/** How many pages a run keeps what it read of (Pages): each at most PAGE_READ_MAX_CHARS characters of text. */
export const PAGES_HELD = 8;

/** `parallel`, on a page fetched directly where Parallel was asked for one: why Parallel gave none. */
export type WebPage = Page & { via: "parallel" | "direct"; parallel?: string };
/** A page web_fetch read, and how (WebPage's `via` and `parallel`). */
export type WebRead = Read & Pick<WebPage, "via" | "parallel">;
/** A page web_fetch could not read, and how it tried. */
type WebUnread = Unread & Pick<WebPage, "via" | "parallel">;
/** The pages a run reads, by the URL asked for, each from its read's start (so calls at once share it), the last used
 *  last: at most PAGES_HELD of them. */
export type Pages = Map<string, Promise<WebRead | WebUnread>>;
type GuardOptions = Omit<PublicFetchOptions, "maxBytes">;
/** Parallel for one run, on one key: `read`, its extract of a page (one billed request), the page it read or, for any
 *  failure, why it read none; `post`, one request to another of its endpoints (web_search's, web-search.ts). Neither
 *  retries, and each stops at 60 s. `live` is false once a 401 or 403 to either said the key is not served. */
export type Extract = { live(): boolean; read(url: string, signal?: AbortSignal): Promise<Read | string>; post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> };

/** The absolute http(s) URLs a markdown text links to (`[text](url)`), each once and without its fragment, in order, as
 *  they are read (linksWithin keeps those within the caps and counts the rest). A URL ends at whitespace or at the ")"
 *  that closes the link, so parentheses it holds in pairs (a wiki title's) stay. */
function* linksOf(markdown: string): Generator<string> {
  const seen = new Set<string>();
  for (let at = markdown.indexOf("]("); at !== -1; at = markdown.indexOf("](", at + 2)) {
    let end = at + 2;
    for (let depth = 0; end < markdown.length && !/\s/.test(markdown[end]!); end++) {
      if (markdown[end] === "(") depth++;
      else if (markdown[end] === ")" && depth-- === 0) break;
    }
    const href = markdown.slice(at + 2, end);
    const link = /^https?:\/\//i.test(href) ? URL.parse(href) : null;
    if (!link) continue;
    link.hash = "";
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    yield link.href;
  }
}

/** Parallel's extract on `apiKey`: one URL a request, each a billed extract, its full content to the most of a page
 *  web_fetch reads as the page's text (markdown), its links read from it, status 200 (Parallel answers a page it could
 *  not read in `errors`, with no content). */
export function parallelExtract(apiKey: string, send: typeof fetch = fetch): Extract {
  let refused = false;
  const post: Extract["post"] = async (url, body, signal) => {
    const response = await send(url, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(PARALLEL_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    if (response.status === 401 || response.status === 403) refused = true;
    return response;
  };
  return {
    live: () => !refused,
    post,
    async read(url, signal) {
      try {
        // The most of a page a read reaches and one character more, so a page Parallel cut there shows as going on.
        const asked = PAGE_READ_MAX_CHARS + 1;
        const response = await post(PARALLEL_EXTRACT_URL, { urls: [url], advanced_settings: { full_content: { max_chars_per_result: asked } } }, signal);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return response.status === 401 || response.status === 403 ? `refused the key (${response.status})` : `answered ${response.status}`;
        }
        const { results, errors } = (await response.json()) as { results?: Array<{ url?: unknown; title?: unknown; full_content?: unknown } | null>; errors?: unknown[] };
        const row = results?.find((r) => typeof r?.url === "string" && typeof r.full_content === "string" && r.full_content.trim() !== "");
        if (!row) return errors?.length ? "listed the URL in errors" : "answered no content";
        const text = row.full_content as string;
        return { ok: true, url: clip(row.url as string, URL_MAX), status: 200, title: clip(typeof row.title === "string" ? row.title : "", TITLE_CAP), ...textOf(text, text.length !== asked), ...linksWithin(linksOf(text)) };
      } catch (error) {
        const name = (error as Error)?.name;
        return name === "TimeoutError" ? "timed out" : name === "AbortError" ? "was stopped" : `failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
      }
    },
  };
}

/** Whether the public-host guard passes `url` within `ms` and the caller's signal: fetch_page's port check, then
 *  publicFetch's own checks of the first hop (scheme, name, every address it resolves to), stopped before it dials. A
 *  check that runs out of time (a resolver that does not answer) does not pass; publicFetch ends a lookup at the abort. */
async function passes(url: string, options: GuardOptions, ms: number): Promise<boolean> {
  const target = URL.parse(url);
  if (!target || !PORTS.has(target.port) || url.length > URL_MAX) return false;
  const { publicFetch } = await import("@parcha/pi-browser");
  const checked = new Error("checked, not dialled");
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(options.signal ? [options.signal] : [])]);
  return publicFetch(url, { ...options, signal, fetchImpl: async () => { throw checked; } }).then(() => false, (error: unknown) => error === checked);
}

/** The page at `url` read once: through `parallel` when it is given and live and the guard passes the URL within
 *  `checkMs` (default fetch_page's 30 s), else (or when it answers no page) through fetch_page's guarded fetch. A page
 *  fetched directly where `parallel` was given says why Parallel gave none (`parallel`): a picked provider that fails is
 *  never a silent fallback. */
async function readOnce(url: unknown, parallel: Extract | null | undefined, checkMs: number, options: GuardOptions): Promise<WebRead | WebUnread> {
  let why: string | undefined;
  if (parallel && !parallel.live()) why = "not tried: refused earlier in this run";
  else if (parallel && !(typeof url === "string" && (await passes(url, options, checkMs)))) why = "not tried: the URL did not pass the public-host guard";
  else if (parallel) {
    const read = await parallel.read(url as string, options.signal);
    if (typeof read !== "string") return { ...read, via: "parallel" };
    why = read;
  }
  return { ...(await readDirect(url, options)), via: "direct", ...(why ? { parallel: why } : {}) };
}

/** The part (`offset`, `maxChars`) of the page at `url` as a WebPage: from `pages`, the run's, where it holds the URL
 *  (read, or being read), with no request of its own; else read once (readOnce), kept there from the read's start. A read
 *  that fails leaves `pages`, so a later call reads again. */
export async function webFetch(url: unknown, { parallel, pages, checkMs = TIMEOUT_MS, offset, maxChars, ...options }: GuardOptions & Part & { parallel?: Extract | null; pages?: Pages; checkMs?: number } = {}): Promise<WebPage> {
  const named = typeof url === "string" ? url : undefined;
  let reading = named === undefined ? undefined : pages?.get(named);
  if (!reading) {
    const started = readOnce(url, parallel, checkMs, options);
    if (pages && named !== undefined) {
      // Ahead of any caller's await, so no call sees a failed read kept.
      const drop = () => void (pages.get(named) === started && pages.delete(named));
      void started.then((read) => { if (!read.ok) drop(); }, drop);
    }
    reading = started;
  }
  if (pages && named !== undefined) {
    // The last used last: the oldest goes past PAGES_HELD.
    pages.delete(named);
    pages.set(named, reading);
    if (pages.size > PAGES_HELD) pages.delete(pages.keys().next().value!);
  }
  const read = await reading;
  if (!read.ok) return read;
  const { via, parallel: why, ...page } = read;
  return { ...partOfRead(page, { offset, maxChars }), via, ...(why ? { parallel: why } : {}) };
}

let parallel: Extract | null | undefined;
/** The pages this run read (Pages): its process is the run's, so the agent's tool and a call node's web_fetch share them. */
export const runPages: Pages = new Map();
/** The run's Parallel extract, made once in its process so a refused key holds for the rest of the run: on the Parallel
 *  key the server handed it (handedKeys, the read the decision providers share), null without one. */
export function parallelOf(env: NodeJS.ProcessEnv): Extract | null {
  if (parallel !== undefined) return parallel;
  const key = handedKeys(env)[PARALLEL_KEY_ENV];
  return (parallel = key === undefined ? null : parallelExtract(key, async (...args) => ((await fauxFetch(env, FAUX_PARALLEL_ENV)) ?? fetch)(...args)));
}

/** The part `options` names of the page at `url` by the provider the run's plane resolves web_fetch to: Parallel's
 *  extract (with the direct fetch behind it) where it resolves to parallel, the guarded direct fetch otherwise, and a
 *  failed Page saying why where it is unavailable or the part is one a call may not ask for (partProblem), before
 *  anything is fetched. From `pages` (the run's, runPages) where they hold the URL. */
export async function fetchFor(env: NodeJS.ProcessEnv, url: unknown, options: GuardOptions & Part & { pages?: Pages } = {}): Promise<WebPage | Page> {
  const problem = partProblem(options);
  if (problem) return { ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: problem };
  const resolved = planeOf(env).web_fetch;
  if (isUnavailable(resolved)) return { ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: `web_fetch does not run here: ${resolved.slice("unavailable: ".length)}` };
  const extract = resolved === "parallel" ? parallelOf(env) : null;
  const page = await webFetch(url, { ...options, parallel: extract });
  return resolved === "parallel" && !extract ? { ...page, parallel: "not tried: this run holds no Parallel key" } : page;
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
export function webFetchText(page: WebPage | Page, name: string = WEB_FETCH_TOOL): string {
  const lines = [JSON.stringify(page)];
  if ("parallel" in page && page.parallel) lines.push(`Parallel was picked for web_fetch and gave no page (${page.parallel}); this one was fetched directly.`);
  const where = partLine(page, name);
  if (where) lines.push(where);
  return lines.join("\n");
}

/** The agent's tool: the WebPage as JSON text (webFetchText), named `name` (fetch_page, its legacy name, runs it too). A
 *  run whose web_fetch resolves to Parallel reads its key as the tool is made, when the run opens. */
/** Typed here, so its declaration names the schema type by a package serve declares (pi-ai), whatever else the build loads. */
export function webFetchTool(env: NodeJS.ProcessEnv, name = WEB_FETCH_TOOL): ToolRegistration<TSchema, JsonValue> {
  if (planeOf(env).web_fetch === "parallel") parallelOf(env);
  return defineTool({
    name,
    description: `Read one web page from a public host, a part at a time. Answers JSON: ok, the final url, the HTTP status, the page's title, text (a part of its readable text as markdown: about max_chars characters from offset, ${PAGE_CHARS.toLocaleString("en-US")} by default, at least ${MAX_CHARS_MIN} and at most ${TEXT_CAP.toLocaleString("en-US")}) and chars (that part's length), the absolute links the page holds (with the part at offset 0; links_omitted counts those its caps left out), and via: parallel when Parallel's extract read it, direct when it was fetched from the host (with parallel saying why, where Parallel was picked and gave no page). A part that is not the whole page says so: truncated is true while more follows, next_offset is where the rest begins, original_chars is the page's whole length where it is known, and a line after the JSON says which characters these are; call again with offset to read on. A page whose HTML is longer than ${HTML_READ_CHARS.toLocaleString("en-US")} characters (scripts and styles aside) is cut before it is read: html_chars gives its whole length on every part, its text is only the start of the page, and the last part's line says it was cut. converted is "text" when the text is the page's plain text, its conversion to markdown having run out of time. A page is read to its first ${PAGE_READ_MAX_CHARS.toLocaleString("en-US")} characters (beyond_read on the last part says it goes on). A page is fetched once a run, at its first call: its later parts come from that read, with no request (through Parallel, one billed extract a page). A private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused and never read (ok false, with refused saying why); so is a page fetched directly that is not text.`,
    parameters: URL_PARAMETERS,
    replay: "safe",
    execute: async (args, _api, context) => {
      const { url, offset, max_chars } = args as { url?: unknown; offset?: number; max_chars?: number };
      const page = await fetchFor(env, url, { ...(await fetchOptions(env, FAUX_ENV)), offset, maxChars: max_chars, pages: runPages, ...(context?.abortSignal ? { signal: context.abortSignal } : {}) });
      return forModel(webFetchText(page, name), { details: page });
    },
  });
}
