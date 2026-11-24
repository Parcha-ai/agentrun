// Serve's parts for @parcha/agentrun-web: pi-browser's public-host guard and page reader (loaded at the first fetch, so a
// run that never fetches never loads pi-browser), serve's words for a free search's limit, the `--faux` switches that
// put a test's fakes in each provider's place, and a page tool's arguments.
import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { type Guard, MAX_CHARS_MIN, PAGE_CHARS, TEXT_CAP } from "@parcha/agentrun-web";

/** pi-browser's guard and reader, as web's Guard: its publicFetch, and its readPage for an HTML page. */
export const GUARD: Guard = {
  fetch: async (url, options) => (await import("@parcha/pi-browser")).publicFetch(url, options),
  check: async (url, options) => (await import("@parcha/pi-browser")).publicCheck(url, options),
  html: async (html, url, options) => (await import("@parcha/pi-browser")).readPage(html, url, options),
};

/** What a free web search answers when its free limit holds, naming this product's ways past it (web's Words). */
export const RATE_LIMITED = "Free web search is rate-limited right now. Try again in a minute; add the free Parallel Search server in Settings → MCP servers and grant the agent its web_search; or add a Parallel key in Settings → API Keys to search with a key.";

/** Under `--faux` only: a module whose default export gives `{ lookup, fetchImpl }` for the fetch (the tests' fake
 *  network), in place of the system's resolver and undici. */
export const FAUX_WEB_ENV = "AGENTRUN_SERVE_FAUX_WEB";
/** Under `--faux` only: a module whose default export is the fetch keyless Exa's MCP exchange goes through. */
export const FAUX_EXA_ENV = "AGENTRUN_SERVE_FAUX_EXA";
/** Under `--faux` only: the URL of a fake MCP server asked in place of keyless Firecrawl's endpoint. Under --faux with
 *  none named, Firecrawl is never asked. */
export const FAUX_FIRECRAWL_ENV = "AGENTRUN_SERVE_FAUX_FIRECRAWL";

/** The fetch's resolver and fetch in the run's process: the faux module's under `--faux` with one named, else none. */
export async function fetchOptions(env: NodeJS.ProcessEnv, fauxEnv: string): Promise<Omit<PublicFetchOptions, "maxBytes" | "signal">> {
  const faux = env[fauxEnv] ? env[FAUX_WEB_ENV] : undefined;
  if (!faux) return {};
  return ((await import(pathToFileURL(faux).href)) as { default: () => Omit<PublicFetchOptions, "maxBytes" | "signal"> }).default();
}

/** A page tool's arguments: `url`, and the part of its text to read (`offset`, `max_chars`). */
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
