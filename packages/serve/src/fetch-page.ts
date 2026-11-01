// fetch_page: one web page from a public host, as a Page: { ok, url, status, title, text, links, refused?, error? }.
// The fetch is pi-browser's public-host guard (publicFetch): every redirect hop resolved, checked and dialled at the
// address checked, http(s) only, a byte cap and a timeout. Before it, a URL on a port other than 80 or 443 is refused
// here as well. A refusal or a failure is a Page with ok false, never a throw, so an agent reads why and a workflow can
// branch on it.
import { pathToFileURL } from "node:url";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { forModel } from "./result.js";

export type Page = { ok: boolean; url: string; status: number; title: string; text: string; links: string[]; refused?: string; error?: string };

export const FETCH_PAGE_TOOL = "fetch_page";
/** Under `--faux` only: a module whose default export gives `{ lookup, fetchImpl }` for the fetch (the tests' fake
 *  network), in place of the system's resolver and undici. */
export const FAUX_WEB_ENV = "AGENTRUN_SERVE_FAUX_WEB";
export const TEXT_CAP = 60_000;
export const LINKS_CAP = 200;
export const TITLE_CAP = 500;
const TIMEOUT_MS = 30_000;

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The page at `url` as a Page. `options` are the guard's resolver and fetch, for a test; a signal ends it early. */
export async function fetchPage(url: unknown, options: Omit<PublicFetchOptions, "maxBytes"> = {}): Promise<Page> {
  const failed = (fields: Partial<Page> & ({ refused: string } | { error: string })): Page => ({ ok: false, url: typeof url === "string" ? url : "", status: 0, title: "", text: "", links: [], ...fields });
  if (typeof url !== "string" || !URL.canParse(url)) return failed({ error: "url is not an absolute URL" });
  const { port } = new URL(url);
  if (port && port !== "80" && port !== "443") return failed({ refused: `refused: port ${port} is not 80 or 443` });
  const { BrowserFailureError, publicFetch, readPage } = await import("@parcha/pi-browser");
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const answer = await publicFetch(url, { ...options, signal });
    if (answer.body === null) return failed({ url: answer.url, status: answer.status, error: `the page answered ${answer.status}` });
    const page = /html/i.test(answer.contentType) ? await readPage(answer.body, answer.url) : { title: "", text: answer.body, links: [] };
    return { ok: true, url: answer.url, status: answer.status, title: clip(page.title, TITLE_CAP), text: clip(page.text, TEXT_CAP), links: page.links.slice(0, LINKS_CAP) };
  } catch (error) {
    if (error instanceof BrowserFailureError && error.failure.code === "refused") return failed({ refused: error.message });
    return failed({ error: (error as Error)?.message ?? String(error) });
  }
}

/** The fetch's resolver and fetch in the run's process: the faux module's under `--faux` with one named, else none. */
export async function fetchOptions(env: NodeJS.ProcessEnv, fauxEnv: string): Promise<Omit<PublicFetchOptions, "maxBytes" | "signal">> {
  const faux = env[fauxEnv] ? env[FAUX_WEB_ENV] : undefined;
  if (!faux) return {};
  return ((await import(pathToFileURL(faux).href)) as { default: () => Omit<PublicFetchOptions, "maxBytes" | "signal"> }).default();
}

/** A page tool's one argument, `url`. */
export const URL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: { url: { type: "string", minLength: 1, description: "An absolute http(s) URL." } },
  required: ["url"],
} as unknown as TSchema;

/** The agent's tool: the Page as JSON text. */
export const fetchPageTool = (options: () => Promise<Omit<PublicFetchOptions, "maxBytes" | "signal">>) =>
  defineTool({
    name: FETCH_PAGE_TOOL,
    description: "Fetch one web page from a public host and read it. Answers JSON: ok, the final url, the HTTP status, the page's title, its readable text (cut at 60,000 characters) and the absolute links it holds. A private or local address, a port other than 80 or 443, a scheme other than http(s), or a page that is not text is refused (ok false, with refused saying why).",
    parameters: URL_PARAMETERS,
    replay: "safe",
    execute: async (args, _api, context) => {
      const page = await fetchPage((args as { url?: unknown }).url, { ...(await options()), ...(context?.abortSignal ? { signal: context.abortSignal } : {}) });
      return forModel(JSON.stringify(page), { details: page });
    },
  });
