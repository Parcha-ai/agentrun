// web_fetch: fetch_page's Page (fetch-page.ts) plus `via`, the path that served it. Where the run holds Parallel's key,
// the page is read through Parallel's Extract API (https://docs.parallel.ai/api-reference/extract-beta/extract, about
// $0.001 a URL); without the key, or when Parallel answers no page (the URL in its `errors`, no content, a 5xx, a
// timeout), it is fetch_page's guarded direct fetch. A URL goes to Parallel only once the public-host guard's own check
// passes it: a URL the guard refuses is never sent, and is answered with the direct fetch's refusal. A 401 or 403 means
// the key is not served: Parallel is not asked again in the run. No request to Parallel is retried: one that failed
// goes to the direct fetch.
// The key is the one the server hands the run's process on its decision descriptor (decisions.ts), read once and held
// in this module's memory: never in an environment, a child or a file.
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { FAUX_PARALLEL_ENV, fauxFetch, handedKeys, PARALLEL_KEY_ENV } from "./decisions.js";
import { clip, fetchOptions, fetchPage, LINKS_CAP, type Page, TEXT_CAP, TIMEOUT_MS, TITLE_CAP, URL_PARAMETERS } from "./fetch-page.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";

export const WEB_FETCH_TOOL = "web_fetch";
export const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const PARALLEL_TIMEOUT_MS = 60_000;
const PORTS = new Set(["", "80", "443"]);

export type WebPage = Page & { via: "parallel" | "direct" };
type GuardOptions = Omit<PublicFetchOptions, "maxBytes">;
/** Parallel's extract for one run: a page it read, or undefined for any failure; `live` is false once a 401 or 403 said
 *  the key is not served. */
export type Extract = { live(): boolean; read(url: string, signal?: AbortSignal): Promise<Page | undefined> };

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
  return {
    live: () => !refused,
    async read(url, signal) {
      try {
        const response = await send(PARALLEL_EXTRACT_URL, {
          method: "POST",
          headers: { "x-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({ urls: [url], advanced_settings: { full_content: { max_chars_per_result: TEXT_CAP } } }),
          signal: AbortSignal.any([AbortSignal.timeout(PARALLEL_TIMEOUT_MS), ...(signal ? [signal] : [])]),
        });
        if (response.status === 401 || response.status === 403) refused = true;
        if (!response.ok) return void (await response.body?.cancel().catch(() => undefined));
        const { results } = (await response.json()) as { results?: Array<{ url?: unknown; title?: unknown; full_content?: unknown } | null> };
        const row = results?.find((r) => typeof r?.url === "string" && typeof r.full_content === "string" && r.full_content.trim() !== "");
        if (!row) return undefined;
        const text = row.full_content as string;
        return { ok: true, url: row.url as string, status: 200, title: clip(typeof row.title === "string" ? row.title : "", TITLE_CAP), text: clip(text, TEXT_CAP), links: linksOf(text) };
      } catch {
        return undefined;
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
 *  `checkMs` (default fetch_page's 30 s), else (or when it answers no page) through fetch_page's guarded fetch. */
export async function webFetch(url: unknown, { parallel, checkMs = TIMEOUT_MS, ...options }: GuardOptions & { parallel?: Extract | null; checkMs?: number } = {}): Promise<WebPage> {
  if (parallel?.live() && typeof url === "string" && (await passes(url, options, checkMs))) {
    const page = await parallel.read(url, options.signal);
    if (page) return { ...page, via: "parallel" };
  }
  return { ...(await fetchPage(url, options)), via: "direct" };
}

let parallel: Extract | null | undefined;
/** The run's Parallel extract, made once in its process so a refused key holds for the rest of the run: on the Parallel
 *  key the server handed it (handedKeys, the read the decision providers share), null without one. */
export function parallelOf(env: NodeJS.ProcessEnv): Extract | null {
  if (parallel !== undefined) return parallel;
  const key = handedKeys(env)[PARALLEL_KEY_ENV];
  return (parallel = key === undefined ? null : parallelExtract(key, async (...args) => ((await fauxFetch(env, FAUX_PARALLEL_ENV)) ?? fetch)(...args)));
}

/** The agent's tool: the WebPage as JSON text. The run's key is read as the tool is made, when the run opens. */
/** Typed here, so its declaration names the schema type by a package serve declares (pi-ai), whatever else the build loads. */
export function webFetchTool(env: NodeJS.ProcessEnv): ToolRegistration<TSchema, JsonValue> {
  const extract = parallelOf(env);
  return defineTool({
    name: WEB_FETCH_TOOL,
    description: "Read one web page from a public host. Answers JSON: ok, the final url, the HTTP status, the page's title, its readable text as markdown (cut at 60,000 characters), the absolute links it holds, and via: parallel when Parallel's extract read it, direct when it was fetched from the host. A private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused and never read (ok false, with refused saying why); so is a page fetched directly that is not text.",
    parameters: URL_PARAMETERS,
    replay: "safe",
    execute: async (args, _api, context) => {
      const page = await webFetch((args as { url?: unknown }).url, { ...(await fetchOptions(env, FAUX_ENV)), parallel: extract, ...(context?.abortSignal ? { signal: context.abortSignal } : {}) });
      return forModel(JSON.stringify(page), { details: page });
    },
  });
}
