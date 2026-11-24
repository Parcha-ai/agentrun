// Serve's one Web per run (webOf) and the parts it injects: pi-browser's guard and reader, the run's ledger as Pay,
// serve's words for a free search's limit, the server's log, and the `--faux` switches that put a test's fakes in each
// provider's place.
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { createWeb, type FetchProvider, type Guard, type KeyedProvider, MAX_CHARS_MIN, PAGE_CHARS, providerOf, type SearchBounds, type SearchProvider, TEXT_CAP, type Web } from "@parcha/agentrun-web";
import { FAUX_PARALLEL_ENV, fauxFetch, handedKeyOf } from "./decisions.js";
import { hostedSearched, type SearchModels } from "./hosted-search.js";
import { FAUX_ENV } from "./model.js";
import { paidRequest } from "./paid-calls.js";
import { logLine } from "./print.js";
import { planeOf } from "./tool-plane.js";

/** pi-browser's guard and reader, loaded at the first fetch, so a run that never fetches never loads pi-browser. */
export const GUARD: Guard = {
  fetch: async (url, options) => (await import("@parcha/pi-browser")).publicFetch(url, options),
  check: async (url, options) => (await import("@parcha/pi-browser")).publicCheck(url, options),
  html: async (html, url, options) => (await import("@parcha/pi-browser")).readPage(html, url, options),
};

export const RATE_LIMITED = "Free web search is rate-limited right now. Try again in a minute; add the free Parallel Search server in Settings → MCP servers and grant the agent its web_search; or add a Parallel key in Settings → API Keys to search with a key.";

/** Under `--faux` only: a module whose default export gives `{ lookup, fetchImpl }` for the fetch. */
export const FAUX_WEB_ENV = "AGENTRUN_SERVE_FAUX_WEB";
/** Under `--faux` only: a module whose default export is the fetch keyless Exa's MCP exchange goes through. */
export const FAUX_EXA_ENV = "AGENTRUN_SERVE_FAUX_EXA";
/** Under `--faux` only: the URL of a fake MCP server asked in place of keyless Firecrawl. With none named, Firecrawl is
 *  never asked. */
export const FAUX_FIRECRAWL_ENV = "AGENTRUN_SERVE_FAUX_FIRECRAWL";

/** The fetch's resolver and transport: the faux module's under `--faux` with one named, else none. */
export async function fetchOptions(env: NodeJS.ProcessEnv, fauxEnv: string): Promise<Omit<PublicFetchOptions, "maxBytes" | "signal">> {
  const faux = env[fauxEnv] ? env[FAUX_WEB_ENV] : undefined;
  if (!faux) return {};
  return ((await import(pathToFileURL(faux).href)) as { default: () => Omit<PublicFetchOptions, "maxBytes" | "signal"> }).default();
}

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

/** The run's models a native search goes through, asked when a search runs: ToolHost.search, EffectRun.search. */
export type SearchOn = () => Promise<SearchModels | undefined>;
/** The models of the search in flight. */
export const searchingOn = new AsyncLocalStorage<SearchOn | undefined>();

const serverLog = (line: string): void => void process.stderr.write(`agentrun-serve: ${line}\n`);

/** What each resolution of web_search asks, in turn: keyless Firecrawl has keyless Exa behind it. */
const SEARCH_CHAINS: Readonly<Record<string, readonly SearchProvider[]>> = { parallel: ["parallel"], native: ["native"], "firecrawl-keyless": ["firecrawl-keyless", "exa-keyless"], "exa-keyless": ["exa-keyless"] };
/** What each resolution of web_fetch asks, in turn: the guarded direct fetch behind any provider, and alone otherwise. */
const FETCH_CHAINS: Readonly<Record<string, readonly FetchProvider[]>> = { parallel: ["parallel", "direct"], "firecrawl-keyless": ["firecrawl-keyless", "direct"] };
/** Under --faux, the variable naming each keyless provider's fake: one with none named is left out. */
const FAUX_FAKES: Readonly<Partial<Record<string, string>>> = { "firecrawl-keyless": FAUX_FIRECRAWL_ENV, "exa-keyless": FAUX_EXA_ENV };

/** The search order a resolution of web_search names, under no --faux; none for one that runs no search. */
export const searchChainOf = (resolved: string | undefined): readonly SearchProvider[] => (resolved !== undefined && Object.hasOwn(SEARCH_CHAINS, resolved) ? SEARCH_CHAINS[resolved]! : []);

/** The providers each web tool asks where the run's plane resolves it. Under --faux, a keyless provider the server names
 *  no fake for is left out, so a test never reaches the network. */
export function ordersOf(env: NodeJS.ProcessEnv): { search: SearchProvider[]; fetch: FetchProvider[] } {
  const { web_search: search, web_fetch: fetch } = planeOf(env);
  const faked = (id: string) => !env[FAUX_ENV] || FAUX_FAKES[id] === undefined || Boolean(env[FAUX_FAKES[id]!]);
  const fetchChain = fetch !== undefined && Object.hasOwn(FETCH_CHAINS, fetch) ? FETCH_CHAINS[fetch]! : ["direct" as const];
  return { search: searchChainOf(search).filter(faked), fetch: fetchChain.filter(faked) };
}

/** One Web for each environment a run's calls are given (main's run process hands process.env; the runner hands each
 *  claim its own), so one run's key, client, pages and breakers never serve another. */
const webs = new WeakMap<NodeJS.ProcessEnv, Web>();

/** The run's Web. Each keyed provider either web tool asks has its key read here, once, from the variable its registry
 *  entry names. `bounds` applies to the Web this call makes (a test's). */
export function webOf(env: NodeJS.ProcessEnv, bounds?: SearchBounds): Web {
  let web = webs.get(env);
  if (web) return web;
  const order = ordersOf(env);
  const keys: Partial<Record<KeyedProvider, string>> = {};
  for (const id of new Set([...order.search, ...order.fetch])) {
    const named = providerOf(id).key?.env;
    const key = named ? handedKeyOf(env, named) : undefined;
    if (key !== undefined) keys[id as KeyedProvider] = key;
  }
  const fakeFirecrawl = env[FAUX_ENV] ? env[FAUX_FIRECRAWL_ENV] : undefined;
  web = createWeb({
    order,
    ...(Object.keys(keys).length ? { keys } : {}),
    native: async (query, n, signal) => hostedSearched(query, n, planeOf(env).model, signal, await searchingOn.getStore()?.()),
    guard: GUARD,
    pay: paidRequest,
    ...(fakeFirecrawl ? { endpoints: { "firecrawl-keyless": fakeFirecrawl } } : {}),
    send: {
      parallel: async (...args) => ((await fauxFetch(env, FAUX_PARALLEL_ENV)) ?? fetch)(...args),
      ...(env[FAUX_ENV] && env[FAUX_EXA_ENV] ? { "exa-keyless": async (...args: Parameters<typeof fetch>) => (await fauxFetch(env, FAUX_EXA_ENV))!(...args) } : {}),
    },
    words: { rateLimited: RATE_LIMITED },
    ...(bounds ? { bounds } : {}),
    log: (event, fields) => serverLog(logLine(event, fields)),
  });
  webs.set(env, web);
  return web;
}
