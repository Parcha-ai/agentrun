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
// A page is read in parts (fetch-page.ts): the tool's `offset` and `max_chars` name the part, which either path reads the
// same. Parallel is asked for the page's text up to one character past the part, so a page it cut there shows as going
// on; its whole length is known only when Parallel gave less (or more) than it was asked for.
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { FAUX_PARALLEL_ENV, fauxFetch, handedKeys, PARALLEL_KEY_ENV } from "./decisions.js";
import { clip, fetchOptions, fetchPage, HTML_READ_CHARS, LINKS_CAP, linksWithin, MAX_CHARS_MIN, PAGE_CHARS, type Page, pageText, type Part, partOf, partProblem, TEXT_CAP, TIMEOUT_MS, TITLE_CAP, URL_MAX, URL_PARAMETERS } from "./fetch-page.js";
import { FAUX_ENV } from "./model.js";
import { PaidRefused, paidRequest, parallelFeeOf } from "./paid-calls.js";
import { forModel } from "./result.js";
import { isUnavailable, planeOf } from "./tool-plane.js";

export const WEB_FETCH_TOOL = "web_fetch";
export const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const PARALLEL_TIMEOUT_MS = 60_000;
const PORTS = new Set(["", "80", "443"]);

/** `parallel`, on a page fetched directly where Parallel was asked for one: why Parallel gave none. */
export type WebPage = Page & { via: "parallel" | "direct"; parallel?: string };
type GuardOptions = Omit<PublicFetchOptions, "maxBytes">;
/** Parallel for one run, on one key: `read`, its extract of the part `part` names, a page it read or, for any failure,
 *  why it read none; `post`, one request to another of its endpoints (web_search's, web-search.ts). Neither retries, and
 *  each stops at 60 s. `live` is false once a 401 or 403 to either said the key is not served. */
export type Extract = { live(): boolean; read(url: string, signal?: AbortSignal, part?: Part): Promise<Page | string>; post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> };

/** The absolute http(s) URLs a markdown text links to (`[text](url)`), each once and without its fragment, in order. A
 *  URL ends at whitespace or at the ")" that closes the link, so parentheses it holds in pairs (a wiki title's) stay. */
function linksOf(markdown: string): string[] {
  const links = new Set<string>();
  for (let at = markdown.indexOf("]("); at !== -1 && links.size < LINKS_CAP; at = markdown.indexOf("](", at + 2)) {
    let end = at + 2;
    for (let depth = 0; end < markdown.length && !/\s/.test(markdown[end]!); end++) {
      if (markdown[end] === "(") depth++;
      else if (markdown[end] === ")" && depth-- === 0) break;
    }
    const href = markdown.slice(at + 2, end);
    const link = /^https?:\/\//i.test(href) ? URL.parse(href) : null;
    if (!link) continue;
    link.hash = "";
    links.add(link.href);
  }
  return [...links];
}

/** Parallel's extract on `apiKey`: one URL a request, its full content up to the part asked for as the page's text
 *  (markdown), its links read from it, status 200 (Parallel answers a page it could not read in `errors`, with no
 *  content). */
export function parallelExtract(apiKey: string, send: typeof fetch = fetch): Extract {
  let refused = false;
  // Each request is a paid one (paid-calls.ts): held by the run's cap and booked as the call's cost at its endpoint's
  // price. One the cap refuses is not sent: it throws its refusal (PaidRefused).
  const post: Extract["post"] = async (url, body, signal) => {
    const sent = async () => {
      const response = await send(url, {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(PARALLEL_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      });
      if (response.status === 401 || response.status === 403) refused = true;
      return response;
    };
    const fee = parallelFeeOf(url, body);
    if (!fee) throw new PaidRefused(`Parallel's ${URL.parse(url)?.pathname ?? url} was not sent: it has no price here`);
    return paidRequest(fee, sent);
  };
  return {
    live: () => !refused,
    post,
    async read(url, signal, part = {}) {
      try {
        // One character past the part, so a page Parallel cut shows as going on (its whole length Parallel does not give).
        const { offset, maxChars } = partOf(part);
        const asked = offset + maxChars + 1;
        const response = await post(PARALLEL_EXTRACT_URL, { urls: [url], advanced_settings: { full_content: { max_chars_per_result: asked } } }, signal);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return response.status === 401 || response.status === 403 ? `refused the key (${response.status})` : `answered ${response.status}`;
        }
        const { results, errors } = (await response.json()) as { results?: Array<{ url?: unknown; title?: unknown; full_content?: unknown } | null>; errors?: unknown[] };
        const row = results?.find((r) => typeof r?.url === "string" && typeof r.full_content === "string" && r.full_content.trim() !== "");
        if (!row) return errors?.length ? "listed the URL in errors" : "answered no content";
        const text = row.full_content as string;
        return { ok: true, url: clip(row.url as string, URL_MAX), status: 200, title: clip(typeof row.title === "string" ? row.title : "", TITLE_CAP), ...pageText(text, part, text.length !== asked), links: linksWithin(linksOf(text), part) };
      } catch (error) {
        if (error instanceof PaidRefused) return error.message;
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

/** The part (`offset`, `maxChars`) of the page at `url` as a WebPage: through `parallel` when it is given and live and the
 *  guard passes the URL within `checkMs` (default fetch_page's 30 s), else (or when it answers no page) through
 *  fetch_page's guarded fetch. A page fetched directly where `parallel` was given says why Parallel gave none
 *  (`parallel`): a picked provider that fails is never a silent fallback. */
export async function webFetch(url: unknown, { parallel, checkMs = TIMEOUT_MS, offset, maxChars, ...options }: GuardOptions & Part & { parallel?: Extract | null; checkMs?: number } = {}): Promise<WebPage> {
  const part = { offset, maxChars };
  let why: string | undefined;
  if (parallel && !parallel.live()) why = "not tried: refused earlier in this run";
  else if (parallel && !(typeof url === "string" && (await passes(url, options, checkMs)))) why = "not tried: the URL did not pass the public-host guard";
  else if (parallel) {
    const read = await parallel.read(url as string, options.signal, part);
    if (typeof read !== "string") return { ...read, via: "parallel" };
    why = read;
  }
  return { ...(await fetchPage(url, { ...options, ...part })), via: "direct", ...(why ? { parallel: why } : {}) };
}

let parallel: Extract | null | undefined;
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
 *  anything is fetched. */
export async function fetchFor(env: NodeJS.ProcessEnv, url: unknown, options: GuardOptions & Part = {}): Promise<WebPage | Page> {
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
    description: `Read one web page from a public host, a part at a time. Answers JSON: ok, the final url, the HTTP status, the page's title, text (a part of its readable text as markdown: about max_chars characters from offset, ${PAGE_CHARS.toLocaleString("en-US")} by default, at least ${MAX_CHARS_MIN} and at most ${TEXT_CAP.toLocaleString("en-US")}) and chars (that part's length), the absolute links the page holds (with the part at offset 0), and via: parallel when Parallel's extract read it, direct when it was fetched from the host (with parallel saying why, where Parallel was picked and gave no page). A part that is not the whole page says so: truncated is true while more follows, next_offset is where the rest begins, original_chars is the page's whole length where it is known, and a line after the JSON says which characters these are; call again with offset to read on. A page whose HTML is longer than ${HTML_READ_CHARS.toLocaleString("en-US")} characters (scripts and styles aside) is cut before it is read: html_chars gives its whole length on every part, its text is only the start of the page, and the last part's line says it was cut. converted is "text" when the text is the page's plain text, its conversion to markdown having run out of time. A private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused and never read (ok false, with refused saying why); so is a page fetched directly that is not text.`,
    parameters: URL_PARAMETERS,
    replay: "safe",
    execute: async (args, _api, context) => {
      const { url, offset, max_chars } = args as { url?: unknown; offset?: number; max_chars?: number };
      const page = await fetchFor(env, url, { ...(await fetchOptions(env, FAUX_ENV)), offset, maxChars: max_chars, ...(context?.abortSignal ? { signal: context.abortSignal } : {}) });
      return forModel(webFetchText(page, name), { details: page });
    },
  });
}
