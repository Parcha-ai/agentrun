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
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { FAUX_PARALLEL_ENV, fauxFetch, handedKeys, PARALLEL_KEY_ENV } from "./decisions.js";
import { clip, fetchOptions, fetchPage, LINKS_CAP, type Page, pageText, TEXT_CAP, TIMEOUT_MS, TITLE_CAP, URL_PARAMETERS } from "./fetch-page.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";
import { isUnavailable, planeOf } from "./tool-plane.js";

export const WEB_FETCH_TOOL = "web_fetch";
export const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const PARALLEL_TIMEOUT_MS = 60_000;
const PORTS = new Set(["", "80", "443"]);

/** `parallel`, on a page fetched directly where Parallel was asked for one: why Parallel gave none. */
export type WebPage = Page & { via: "parallel" | "direct"; parallel?: string };
type GuardOptions = Omit<PublicFetchOptions, "maxBytes">;
/** Parallel for one run, on one key: `read`, its extract, a page it read or, for any failure, why it read none; `post`,
 *  one request to another of its endpoints (web_search's, web-search.ts). Neither retries, and each stops at 60 s. `live`
 *  is false once a 401 or 403 to either said the key is not served. */
export type Extract = { live(): boolean; read(url: string, signal?: AbortSignal): Promise<Page | string>; post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> };

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

/** Parallel's extract on `apiKey`: one URL a request, its full content as the page's text (markdown), its links read
 *  from it, status 200 (Parallel answers a page it could not read in `errors`, with no content). */
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
        // One character past the cap, so a page Parallel cut shows as cut (its whole length Parallel does not give).
        const response = await post(PARALLEL_EXTRACT_URL, { urls: [url], advanced_settings: { full_content: { max_chars_per_result: TEXT_CAP + 1 } } }, signal);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return response.status === 401 || response.status === 403 ? `refused the key (${response.status})` : `answered ${response.status}`;
        }
        const { results, errors } = (await response.json()) as { results?: Array<{ url?: unknown; title?: unknown; full_content?: unknown } | null>; errors?: unknown[] };
        const row = results?.find((r) => typeof r?.url === "string" && typeof r.full_content === "string" && r.full_content.trim() !== "");
        if (!row) return errors?.length ? "listed the URL in errors" : "answered no content";
        const text = row.full_content as string;
        return { ok: true, url: row.url as string, status: 200, title: clip(typeof row.title === "string" ? row.title : "", TITLE_CAP), ...pageText(text, text.length > TEXT_CAP + 1), links: linksOf(text) };
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
  if (!target || !PORTS.has(target.port)) return false;
  const { publicFetch } = await import("@parcha/pi-browser");
  const checked = new Error("checked, not dialled");
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(options.signal ? [options.signal] : [])]);
  return publicFetch(url, { ...options, signal, fetchImpl: async () => { throw checked; } }).then(() => false, (error: unknown) => error === checked);
}

/** The page at `url` as a WebPage: through `parallel` when it is given and live and the guard passes the URL within
 *  `checkMs` (default fetch_page's 30 s), else (or when it answers no page) through fetch_page's guarded fetch. A page
 *  fetched directly where `parallel` was given says why Parallel gave none (`parallel`): a picked provider that fails is
 *  never a silent fallback. */
export async function webFetch(url: unknown, { parallel, checkMs = TIMEOUT_MS, ...options }: GuardOptions & { parallel?: Extract | null; checkMs?: number } = {}): Promise<WebPage> {
  let why: string | undefined;
  if (parallel && !parallel.live()) why = "not tried: refused earlier in this run";
  else if (parallel && !(typeof url === "string" && (await passes(url, options, checkMs)))) why = "not tried: the URL did not pass the public-host guard";
  else if (parallel) {
    const read = await parallel.read(url as string, options.signal);
    if (typeof read !== "string") return { ...read, via: "parallel" };
    why = read;
  }
  return { ...(await fetchPage(url, options)), via: "direct", ...(why ? { parallel: why } : {}) };
}

let parallel: Extract | null | undefined;
/** The run's Parallel extract, made once in its process so a refused key holds for the rest of the run: on the Parallel
 *  key the server handed it (handedKeys, the read the decision providers share), null without one. */
export function parallelOf(env: NodeJS.ProcessEnv): Extract | null {
  if (parallel !== undefined) return parallel;
  const key = handedKeys(env)[PARALLEL_KEY_ENV];
  return (parallel = key === undefined ? null : parallelExtract(key, async (...args) => ((await fauxFetch(env, FAUX_PARALLEL_ENV)) ?? fetch)(...args)));
}

/** The page at `url` by the provider the run's plane resolves web_fetch to: Parallel's extract (with the direct fetch
 *  behind it) where it resolves to parallel, the guarded direct fetch otherwise, and a failed Page saying why where it
 *  is unavailable. */
export async function fetchFor(env: NodeJS.ProcessEnv, url: unknown, options: GuardOptions = {}): Promise<WebPage | Page> {
  const resolved = planeOf(env).web_fetch;
  if (isUnavailable(resolved)) return { ok: false, url: typeof url === "string" ? url : "", status: 0, title: "", text: "", links: [], error: `web_fetch does not run here: ${resolved.slice("unavailable: ".length)}` };
  const extract = resolved === "parallel" ? parallelOf(env) : null;
  const page = await webFetch(url, { ...options, parallel: extract });
  return resolved === "parallel" && !extract ? { ...page, parallel: "not tried: this run holds no Parallel key" } : page;
}

/** The agent's tool: the WebPage as JSON text, named `name` (fetch_page, its legacy name, runs it too). A run whose
 *  web_fetch resolves to Parallel reads its key as the tool is made, when the run opens. */
/** Typed here, so its declaration names the schema type by a package serve declares (pi-ai), whatever else the build loads. */
export function webFetchTool(env: NodeJS.ProcessEnv, name = WEB_FETCH_TOOL): ToolRegistration<TSchema, JsonValue> {
  if (planeOf(env).web_fetch === "parallel") parallelOf(env);
  return defineTool({
    name,
    description: "Read one web page from a public host. Answers JSON: ok, the final url, the HTTP status, the page's title, its readable text as markdown (cut at 60,000 characters; then truncated is true and original_chars its whole length; when the page's HTML was too long to read whole and was cut before it was read, truncated is true and html_chars is the page's whole length in characters of HTML, with no original_chars, since its whole text was never read; converted is \"text\" when the text is the page's plain text, not markdown, its conversion having run out of time), the absolute links it holds, and via: parallel when Parallel's extract read it, direct when it was fetched from the host (with parallel saying why, where Parallel was picked and gave no page). A private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused and never read (ok false, with refused saying why); so is a page fetched directly that is not text.",
    parameters: URL_PARAMETERS,
    replay: "safe",
    execute: async (args, _api, context) => {
      const page = await fetchFor(env, (args as { url?: unknown }).url, { ...(await fetchOptions(env, FAUX_ENV)), ...(context?.abortSignal ? { signal: context.abortSignal } : {}) });
      const skipped = "parallel" in page && page.parallel ? `\nParallel was picked for web_fetch and gave no page (${page.parallel}); this one was fetched directly.` : "";
      return forModel(`${JSON.stringify(page)}${skipped}`, { details: page });
    },
  });
}
