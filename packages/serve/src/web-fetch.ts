// web_fetch: the page web reads (@parcha/agentrun-web's webFetch) by the provider the run's plane resolves the tool to
// (tool-plane.ts), as order data (fetchOrderOf), with the guarded direct fetch behind it. Where it resolves to keyless
// Firecrawl (the default on a server with no Parallel key, or a pick), the page is read by Firecrawl's keyless scrape,
// which is sent the URL, and when Firecrawl answers no page, or the run's breaker holds it (its free limit spent: off for
// the run; rate-limited: until its wait passes), through the guarded direct fetch. Under --faux Firecrawl is the fake's
// URL (FAUX_FIRECRAWL_ENV), and with none named it is never asked. Where the plane resolves it to kernel, it is the
// kernel's guarded direct fetch. Where it resolves to Parallel (a pick), the page is read through Parallel's Extract API,
// and when Parallel answers no page (the URL in its `errors`, no content, a 5xx, a timeout) through the guarded direct
// fetch. A URL goes to Parallel or Firecrawl only once the public-host guard's own check passes it: a private, loopback,
// link-local or intranet URL is never sent to a third party. A 401 or 403 means the key is not served: Parallel is not
// asked again in the run. A pick of Parallel the server holds no key for answers a failed Page saying so, never a fetch
// of another kind.
// The key is the one the server hands the run's process on its decision descriptor (decisions.ts) when one of its
// capabilities resolves to Parallel, read once and held in this module's memory: never in an environment, a child or a
// file. Serve binds web's pieces to its own here: the guard is pi-browser's (web-fetch-direct.ts GUARD), a Parallel
// request is paid on the run's ledger (paid-calls.ts paidRequest), and what the model is not told goes to the server's
// log as a log line. A run's pages (web's Pages) are kept by the environment its calls are given.
import type { JsonValue } from "@earendil-works/chord/json";
import type { TSchema } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import * as web from "@parcha/agentrun-web";
import { clip, type Extract, type FetchProvider, firecrawlFetch, HTML_READ_CHARS, type KeylessFetch, MAX_CHARS_MIN, PAGE_CHARS, PAGE_READ_MAX_CHARS, type Page, type Pages, type Part, partProblem, TEXT_CAP, URL_MAX, type WebFetchOptions, webFetchText, type WebPage } from "@parcha/agentrun-web";
import { FAUX_PARALLEL_ENV, fauxFetch, parallelKeyOf } from "./decisions.js";
import { fetchOptions, GUARD, URL_PARAMETERS } from "./web-fetch-direct.js";
import { FAUX_FIRECRAWL_ENV } from "./firecrawl-keyless.js";
import { RATE_LIMITED } from "./keyless-mcp.js";
import { FAUX_ENV } from "./model.js";
import { paidRequest } from "./paid-calls.js";
import { logLine } from "./print.js";
import { forModel } from "./result.js";
import { isUnavailable, planeOf, whyUnavailable } from "./tool-plane.js";

export const WEB_FETCH_TOOL = "web_fetch";
type GuardOptions = Omit<PublicFetchOptions, "maxBytes">;

/** Parallel's extract on `apiKey` (web's parallelExtract), each request paid on the run's ledger (paid-calls.ts): held
 *  by the run's cap and booked as the call's cost at its endpoint's price. One the cap refuses is not sent. */
export function parallelExtract(apiKey: string, send: typeof fetch = fetch): Extract {
  return web.parallelExtract(apiKey, send, paidRequest);
}

/** The server's log, where a web_fetch notes what the model is not told (browser-cost.ts' lines go there too). */
const serverLog = (line: string): void => void process.stderr.write(`agentrun-serve: ${line}\n`);

/** web's webFetch through pi-browser's guard (GUARD), what the model is not told written to `log` as a log line (default
 *  the server's log). */
export function webFetch(url: unknown, { log = serverLog, ...options }: Omit<WebFetchOptions, "guard" | "log"> & { log?: (line: string) => void } = {}): Promise<WebPage> {
  return web.webFetch(url, { ...options, guard: GUARD, log: (event, fields) => log(logLine(event, fields)) });
}

/** Each run's Parallel extract, by the environment its calls are given: one object per run (main's run process hands
 *  process.env; the runner hands each claim its own, claim-secrets.ts), so one claim's key or client never serves another. */
const parallels = new WeakMap<NodeJS.ProcessEnv, Extract | null>();
/** Each run's pages, by the environment its calls are given (one object per run: main's run process hands process.env,
 *  the runner hands each claim its own), so the pages one run read never serve another's. */
const pagesByRun = new WeakMap<NodeJS.ProcessEnv, Pages>();
/** The pages the run whose calls are given `env` read (Pages): the agent's tool and a call node's web_fetch of that run
 *  share them, another run's never. */
export function pagesOf(env: NodeJS.ProcessEnv): Pages {
  let pages = pagesByRun.get(env);
  if (!pages) pagesByRun.set(env, (pages = new Map()));
  return pages;
}
/** Each run's keyless Firecrawl scrape (and its breaker), by the environment its calls are given, as parallels. */
const firecrawls = new WeakMap<NodeJS.ProcessEnv, Promise<KeylessFetch | null>>();
/** The run's keyless Firecrawl scrape, made once for the environment its calls are given, so its breaker holds for the
 *  rest of the run (firecrawlFetch). Under --faux it asks the fake whose URL FAUX_FIRECRAWL_ENV names, and with none
 *  named it is null: a test never reaches the network. Its rate limit answers serve's words (RATE_LIMITED). */
export function firecrawlOf(env: NodeJS.ProcessEnv): Promise<KeylessFetch | null> {
  let made = firecrawls.get(env);
  if (!made) {
    const fake = env[FAUX_ENV] ? env[FAUX_FIRECRAWL_ENV] : undefined;
    made = Promise.resolve(env[FAUX_ENV] && !fake ? null : firecrawlFetch({ ...(fake ? { endpoint: fake } : {}), words: { rateLimited: RATE_LIMITED } }));
    firecrawls.set(env, made);
  }
  return made;
}
/** The run's Parallel extract, made once for the environment its calls are given, so a refused key holds for the rest of
 *  the run: on the Parallel key that environment holds (parallelKeyOf: the per-run pipe, or the claim's own), null
 *  without one. */
export function parallelOf(env: NodeJS.ProcessEnv): Extract | null {
  const made = parallels.get(env);
  if (made !== undefined) return made;
  const key = parallelKeyOf(env);
  const extract = key === undefined ? null : parallelExtract(key, async (...args) => ((await fauxFetch(env, FAUX_PARALLEL_ENV)) ?? fetch)(...args));
  parallels.set(env, extract);
  return extract;
}

/** The providers web_fetch asks in turn where the run's plane resolves it to `resolved`, as web reads an order: keyless
 *  Firecrawl or Parallel with the guarded direct fetch behind it, else (kernel) the guarded direct fetch alone. */
export function fetchOrderOf(resolved: string | undefined): readonly FetchProvider[] {
  if (resolved === "firecrawl-keyless") return ["firecrawl-keyless", "direct"];
  if (resolved === "parallel") return ["parallel", "direct"];
  return ["direct"];
}

/** The part `options` names of the page at `url` by the provider the run's plane resolves web_fetch to: Parallel's
 *  extract (with the direct fetch behind it) where it resolves to parallel, keyless Firecrawl's scrape (the same) where
 *  it resolves to firecrawl-keyless, the guarded direct fetch otherwise, and a
 *  failed Page saying why where it is unavailable or the part is one a call may not ask for (partProblem), before
 *  anything is fetched. From `pages` (the run's, pagesOf) where they hold the URL. */
export async function fetchFor(env: NodeJS.ProcessEnv, url: unknown, options: GuardOptions & Part & { pages?: Pages } = {}): Promise<WebPage | Page> {
  const problem = partProblem(options);
  if (problem) return { ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: problem };
  const resolved = planeOf(env).web_fetch;
  if (isUnavailable(resolved)) return { ok: false, url: typeof url === "string" ? clip(url, URL_MAX) : "", status: 0, title: "", text: "", links: [], error: `web_fetch does not run here: ${whyUnavailable(resolved)}` };
  const extract = resolved === "parallel" ? parallelOf(env) : null;
  const page = await webFetch(url, { ...options, order: fetchOrderOf(resolved), parallel: extract, firecrawl: resolved === "firecrawl-keyless" ? await firecrawlOf(env) : null });
  return resolved === "parallel" && !extract ? { ...page, parallel: "not tried: this run holds no Parallel key" } : page;
}

/** The agent's tool: the WebPage as JSON text (webFetchText), named `name`. A
 *  run whose web_fetch resolves to Parallel reads its key as the tool is made, when the run opens. */
/** Typed here, so its declaration names the schema type by a package serve declares (pi-ai), whatever else the build loads. */
/** `fake`: what reads each page in the provider's place (a template eval's web fake, web-fake.ts), the tool otherwise
 *  the same. */
export function webFetchTool(env: NodeJS.ProcessEnv, name = WEB_FETCH_TOOL, fake?: (url: unknown, part: Part & { signal?: AbortSignal }) => Promise<WebPage | Page>): ToolRegistration<TSchema, JsonValue> {
  if (planeOf(env).web_fetch === "parallel" && !fake) parallelOf(env);
  return defineTool({
    name,
    description: `Read one web page from a public host, a part at a time. It has no cookies, sign-ins or session: it reads one page cold, so a page behind a sign-in, or one that depends on an earlier page, needs the browser tool, where this run has it. Answers JSON: ok, the final url, the HTTP status, the page's title, text (a part of its readable text as markdown: about max_chars characters from offset, ${PAGE_CHARS.toLocaleString("en-US")} by default, at least ${MAX_CHARS_MIN} and at most ${TEXT_CAP.toLocaleString("en-US")}) and chars (that part's length), the absolute links the page holds (its link targets and the URLs written out in its text, a JSON body's strings and an XML feed's links among them, where an HTML page fetched directly gives its link targets alone; with the part at offset 0; links_omitted counts those its caps left out), and via: parallel when Parallel's extract read it, firecrawl-keyless when Firecrawl's keyless service read it (it is sent the URL), direct when it was fetched from the host (with parallel saying why, where Parallel was picked and gave no page), stopped when the call was stopped before its page arrived. A part that is not the whole page says so: truncated is true while more follows, next_offset is where the rest begins, original_chars is the page's whole length where it is known, and a line after the JSON says which characters these are; call again with offset to read on. A page whose HTML is longer than ${HTML_READ_CHARS.toLocaleString("en-US")} characters (scripts and styles aside) is cut before it is read: html_chars gives its whole length on every part, its text is only the start of the page, and the last part's line says it was cut. converted is "text" when the text is the page's plain text, its conversion to markdown having run out of time. A page is read to its first ${PAGE_READ_MAX_CHARS.toLocaleString("en-US")} characters (beyond_read on the last part says it goes on). A page is fetched once a run, at its first call: its later parts come from that read, with no request (through Parallel, one billed extract a page). A private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused, never read and never sent to a third party (ok false, with refused saying why); so is a page fetched directly that is not text.`,
    parameters: URL_PARAMETERS,
    replay: "safe",
    execute: async (args, _api, context) => {
      const { url, offset, max_chars } = args as { url?: unknown; offset?: number; max_chars?: number };
      const signal = context?.abortSignal ? { signal: context.abortSignal } : {};
      const page = fake ? await fake(url, { offset, maxChars: max_chars, ...signal }) : await fetchFor(env, url, { ...(await fetchOptions(env, FAUX_ENV)), offset, maxChars: max_chars, pages: pagesOf(env), ...signal });
      return forModel(webFetchText(page, name), { details: page });
    },
  });
}
