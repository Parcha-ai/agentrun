// Serve's one Web per run (webOf) and the parts it injects: pi-browser's guard and reader, the run's ledger as Pay,
// serve's words for a free search's limit, the server's log, and the `--faux` switches that put a test's fakes in each
// provider's place.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { JEV_PUBLISHED_PRICING, jevProvider } from "@parcha/agentrun-jev";
import { createWeb, destinationsWords, type FetchProvider, type Guard, jevWebDecider, type KeyedProvider, providerOf, type SearchProvider, type Web, type WebClient } from "@parcha/agentrun-web";
import { FAUX_JEV_ENV, FAUX_PARALLEL_ENV, fauxFetch, handedKeyOf, JEV_KEY_ENV } from "./decisions.js";
import { webJevOff } from "./env-switch.js";
import { hostedSearched, type SearchModels } from "./hosted-search.js";
import { FAUX_ENV } from "./model.js";
import { paidRequest } from "./paid-calls.js";
import { logLine } from "./print.js";
import { planeOf } from "./tool-plane.js";
import { activeHolds, type HeldView, heldViewOf, holdsFromEnv, reportHold } from "./web-holds.js";

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

/** What a provider that takes them is told of the run, made once for each run's Web (webOf): `model` (Parallel's
 *  client_model), the run's model as its bare id, the last segment of its name, lowercase, none where the run names none;
 *  and `session` (Parallel's session_id, one for a task's Search and Extract, as its guidance asks), 32 random hex
 *  characters, the same on every search and fetch of this Web and another for each other run's. The session is never
 *  the run's id or made from it, so nothing of the run reaches the provider. */
export function clientOf(env: NodeJS.ProcessEnv): WebClient {
  const model = planeOf(env).model?.split("/").pop()?.trim().toLowerCase();
  return { ...(model ? { model } : {}), session: randomUUID().replaceAll("-", "") };
}

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
/** The fetch order a resolution of web_fetch names, under no --faux: the guarded direct fetch alone for any other. */
export const fetchChainOf = (resolved: string | undefined): readonly FetchProvider[] => (resolved !== undefined && Object.hasOwn(FETCH_CHAINS, resolved) ? FETCH_CHAINS[resolved]! : ["direct"]);

/** `tools`, GET /capabilities' (cached), each web tool with `held`, read live: the server's holds at `now` on any provider
 *  it asks where it resolves on some harness, or on that provider's key (web-holds.ts). None held, no field. */
export function withHeld<T extends { name: string; resolves?: Readonly<Record<string, string>> }>(tools: readonly T[], now: number = Date.now()): (T | (T & { held: HeldView[] }))[] {
  return tools.map((tool) => {
    const op = tool.name === "web_search" ? "search" : tool.name === "web_fetch" ? "fetch" : undefined;
    if (!op || !tool.resolves) return tool;
    const asked = new Set(Object.values(tool.resolves).flatMap((resolved): readonly string[] => (op === "search" ? searchChainOf(resolved) : fetchChainOf(resolved))));
    const held = heldViewOf(op, asked, now);
    return held.length ? { ...tool, held } : tool;
  });
}

/** The providers each web tool asks where the run's plane resolves it. Under --faux, a keyless provider the server names
 *  no fake for is left out, so a test never reaches the network. */
export function ordersOf(env: NodeJS.ProcessEnv): { search: SearchProvider[]; fetch: FetchProvider[] } {
  const { web_search: search, web_fetch: fetch } = planeOf(env);
  const faked = (id: string) => !env[FAUX_ENV] || FAUX_FAKES[id] === undefined || Boolean(env[FAUX_FAKES[id]!]);
  return { search: searchChainOf(search).filter(faked), fetch: fetchChainOf(fetch).filter(faked) };
}

/** Jev for the run's web tools (web's jevWebDecider: jev-1.14.0, rerank+label): on the TypeSafe key the claim handed
 *  it (handedKeyOf: in `env`, the claim's own environment, never process.env; decisions.ts' pipe path is dead), unless
 *  Jev is off, in the run's plane (the server's switch at launch, tool-plane.ts planeFor) or by AGENTRUN_WEB_JEV_OFF in
 *  `env`. None on an OpenRouter key: the web decider runs on TypeSafe's route alone. Its requests go through `env`'s
 *  faux Jev under --faux, priced at Jev's published price for the run's cap. */
export function jevWebOf(env: NodeJS.ProcessEnv): ReturnType<typeof jevWebDecider> {
  const key = planeOf(env).jev === "off" || webJevOff(env) ? undefined : handedKeyOf(env, JEV_KEY_ENV);
  if (key === undefined) return jevWebDecider(null);
  return jevWebDecider({ key, jevProvider, price: JEV_PUBLISHED_PRICING, fetch: async (...args: Parameters<typeof fetch>) => ((await fauxFetch(env, FAUX_JEV_ENV)) ?? fetch)(...args) });
}

/** One Web for each environment a run's calls are given (main's run process hands process.env; the runner hands each
 *  claim its own), so one run's key, client, pages and breakers never serve another. */
const webs = new WeakMap<NodeJS.ProcessEnv, Web>();

/** The run's Web. Each keyed provider either web tool asks has its key read here, once, from the variable its registry
 *  entry names. It starts with the server's keyless holds (web-holds.ts: its spawn environment's, and the server's own
 *  where it runs in the server), and hands each hold it meets back (reportHold), each logged as web_provider_held. Made,
 *  it writes the run's one start line, web_destinations: each tool's order, keyed or keyless, any hold known then,
 *  and its classifier (Jev's model and policy, or off); never a key. A search's deadlines are its call's
 *  (web-search.ts), never the Web's. */
export function webOf(env: NodeJS.ProcessEnv): Web {
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
  const jev = jevWebOf(env);
  web = createWeb({
    order,
    ...(jev ? { decider: jev.decider, policy: jev.policy } : {}),
    ...(Object.keys(keys).length ? { keys } : {}),
    client: clientOf(env),
    native: async (query, n, signal) => hostedSearched(query, n, planeOf(env).model, signal, await searchingOn.getStore()?.()),
    guard: GUARD,
    pay: paidRequest,
    ...(fakeFirecrawl ? { endpoints: { "firecrawl-keyless": fakeFirecrawl } } : {}),
    send: {
      parallel: async (...args) => ((await fauxFetch(env, FAUX_PARALLEL_ENV)) ?? fetch)(...args),
      ...(env[FAUX_ENV] && env[FAUX_EXA_ENV] ? { "exa-keyless": async (...args: Parameters<typeof fetch>) => (await fauxFetch(env, FAUX_EXA_ENV))!(...args) } : {}),
    },
    words: { rateLimited: RATE_LIMITED },
    log: (event, fields) => serverLog(logLine(event, fields)),
    holds: [...holdsFromEnv(env), ...activeHolds()],
    onHold: (hold) => {
      serverLog(logLine("web_provider_held", { provider: hold.provider, tool: hold.tool, kind: hold.kind, until: Number.isFinite(hold.until) ? new Date(hold.until).toISOString() : "run" }));
      reportHold(hold);
    },
  });
  webs.set(env, web);
  serverLog(logLine("web_destinations", { ...destinationsWords(web.destinations()), classifier: jev ? `jev ${jev.model} ${jev.policy}` : "off" }));
  return web;
}
