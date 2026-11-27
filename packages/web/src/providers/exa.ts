// Exa on the run's key (https://docs.exa.ai): /search for web_search, /contents for web_fetch, each one paid request
// (fees.ts exaFeeOf) through the run's Pay, on the x-api-key header. Its settings are typed, each with a default
// (EXA_DEFAULTS); a setting it does not take is refused when the Web is made. A 401 or 403 refuses the key for the run.
import { EXA_SEARCH_TYPE_USD, type ExaSearchType, exaFeeOf, type Pay } from "../fees.js";
import { clip, linksWithin, MAX_CHARS_MIN, PAGE_READ_MAX_CHARS, type Read, TITLE_CAP, textOf, URL_MAX, withoutCredentials } from "../page.js";
import { failed, failure, type Hit, type Searched, SNIPPET_MAX, searchArgs, searchFailed, snippetOf } from "../search.js";
import { defineProvider, type ProviderRun, settingsOf } from "../provider.js";
import { linksOf } from "../text-urls.js";
import { type Check, codeOf, domains, type Keyed, keyedCall, keyedClient, type KeyedFailed, oneOf, settingsProblems, wholeIn, yesNo } from "./keyed.js";

export const EXA_API_URL = "https://api.exa.ai";
/** Exa's bound on one request: a deep search takes tens of seconds. */
export const EXA_MS = 120_000;
export const EXA_CATEGORIES = ["company", "publication", "news", "personal site", "financial report", "people"] as const;

/** How Exa searches and reads, each setting optional (EXA_DEFAULTS):
 *  - `type`: the search's depth and price (fees.ts EXA_SEARCH_TYPE_USD), default "auto";
 *  - `snippet`: each result's text for its snippet, its query-relevant `highlights` or the page's `text` from its start,
 *    default "highlights"; `snippetChars`, how many characters of it Exa gives, MAX_CHARS_MIN to SNIPPET_MAX. Unset,
 *    highlights go bare, as Exa's guidance asks (Exa sizes them to the query), and text goes at SNIPPET_MAX; a snippet
 *    keeps at most SNIPPET_MAX either way;
 *  - `maxAgeHours`: the oldest cached page Exa may answer from, for a search's contents and a fetch, -1 (cache only) to
 *    720, 0 a live crawl; unset, Exa's own (its cache, a live crawl for a page it has none of);
 *  - `includeDomains`, `excludeDomains`: the domains a search keeps to or leaves out; `category`: Exa's index to search;
 *  - `pageVerbosity`: how much of a page a fetch reads (Exa's compact, standard or full), default "compact";
 *    `pageLinks`: whether a fetched page's links stay in its text, default true. */
export type ExaSettings = {
  type?: ExaSearchType;
  snippet?: "highlights" | "text";
  snippetChars?: number;
  maxAgeHours?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  category?: (typeof EXA_CATEGORIES)[number];
  pageVerbosity?: "compact" | "standard" | "full";
  pageLinks?: boolean;
};
export const EXA_DEFAULTS = Object.freeze({ type: "auto", snippet: "highlights", pageVerbosity: "compact", pageLinks: true } as const);

const EXA_CHECKS: Readonly<Record<keyof ExaSettings, Check>> = {
  type: oneOf(Object.keys(EXA_SEARCH_TYPE_USD)),
  snippet: oneOf(["highlights", "text"]),
  snippetChars: wholeIn(MAX_CHARS_MIN, SNIPPET_MAX),
  maxAgeHours: wholeIn(-1, 720),
  includeDomains: domains(1_200),
  excludeDomains: domains(1_200),
  category: oneOf(EXA_CATEGORIES),
  pageVerbosity: oneOf(["compact", "standard", "full"]),
  pageLinks: yesNo,
};
export const exaSettingsProblems = (settings: unknown): string[] => settingsProblems("Exa", settings, EXA_CHECKS);

/** Exa on `apiKey`, each request paid through `pay`. */
export const exaClient = (apiKey: string, send: typeof fetch = fetch, pay?: Pay, base: string = EXA_API_URL): Keyed => keyedClient({ who: "Exa", base, headers: { "x-api-key": apiKey }, feeOf: exaFeeOf, timeoutMs: EXA_MS, refuseOn: [401, 403] }, send, pay);

/** The /search request for `query`, `n` results, under `settings`. */
export function exaSearchBody(query: string, n: number, settings: ExaSettings = {}): Record<string, unknown> {
  const { snippetChars } = settings;
  const content = (settings.snippet ?? EXA_DEFAULTS.snippet) === "text" ? { text: { maxCharacters: snippetChars ?? SNIPPET_MAX } } : { highlights: snippetChars === undefined ? true : { maxCharacters: snippetChars } };
  return {
    query,
    type: settings.type ?? EXA_DEFAULTS.type,
    numResults: n,
    ...(settings.includeDomains ? { includeDomains: settings.includeDomains } : {}),
    ...(settings.excludeDomains ? { excludeDomains: settings.excludeDomains } : {}),
    ...(settings.category ? { category: settings.category } : {}),
    contents: { ...content, ...(settings.maxAgeHours === undefined ? {} : { maxAgeHours: settings.maxAgeHours }) },
  };
}

/** A result's text for its snippet: the content asked first (highlights joined, or text), else the other. */
function snippetText(row: { highlights?: unknown; text?: unknown }, asked: "highlights" | "text"): string {
  const highlights = Array.isArray(row.highlights) ? row.highlights.filter((one): one is string => typeof one === "string").join(" … ") : "";
  const text = typeof row.text === "string" ? row.text : "";
  return asked === "text" ? text || highlights : highlights || text;
}

/** `{objective, queries?, n?}` (searchArgs) searched through `client` (null: the run holds no key) under `settings`,
 *  the objective as Exa's query (Exa reads a goal in plain words), and the limit Exa answered for the run's key, if any. */
export async function exaSearched(args: Record<string, unknown>, client: Keyed | null, settings: ExaSettings = {}, signal?: AbortSignal): Promise<Searched> {
  const { objective, queries, n } = searchArgs(args);
  if (!objective) return { answer: { error: "web_search needs an objective" } };
  const got = await keyedCall(client, "Exa", "EXA_API_KEY", "search", "/search", exaSearchBody(objective, n, settings), signal);
  if ("error" in got) return searchFailed(got);
  const { results } = got.json;
  if (!Array.isArray(results)) return searchFailed(failed("error", "UNREADABLE", "Exa's search answered no results this server reads"));
  const asked = settings.snippet ?? EXA_DEFAULTS.snippet;
  const hits = results.flatMap((row: { url?: unknown; title?: unknown; publishedDate?: unknown; highlights?: unknown; text?: unknown } | null): Hit[] => {
    if (typeof row?.url !== "string" || !URL.canParse(row.url)) return [];
    return [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(snippetText(row, asked)), ...(typeof row.publishedDate === "string" ? { published: row.publishedDate } : {}) }];
  });
  return { answer: { provider: "exa", objective, queries, results: hits.slice(0, n) } };
}

/** The /contents request for `url` under `settings`: its text to the most of a page web_fetch reads and one character
 *  more (so a page Exa cut there shows as going on), at the verbosity asked, its links kept or not. */
export function exaContentsBody(url: string, settings: ExaSettings = {}): Record<string, unknown> {
  const pageVerbosity = settings.pageVerbosity ?? EXA_DEFAULTS.pageVerbosity;
  const pageLinks = settings.pageLinks ?? EXA_DEFAULTS.pageLinks;
  return {
    urls: [url],
    text: { maxCharacters: PAGE_READ_MAX_CHARS + 1, verbosity: pageVerbosity, ...(pageLinks ? { linkStyle: "full" } : {}) },
    ...(settings.maxAgeHours === undefined ? {} : { maxAgeHours: settings.maxAgeHours }),
  };
}

/** The page at `url` read through `client`'s /contents under `settings`: the page, or why there is none (its status and
 *  tag where Exa names them). */
export async function exaRead(url: string, client: Keyed | null, settings: ExaSettings = {}, signal?: AbortSignal): Promise<Read | KeyedFailed> {
  const got = await keyedCall(client, "Exa", "EXA_API_KEY", "fetch", "/contents", exaContentsBody(url, settings), signal);
  if ("error" in got) return got;
  const { results, statuses } = got.json as { results?: unknown; statuses?: unknown };
  const crawl = (Array.isArray(statuses) ? statuses : []).find((one: { status?: unknown } | null) => one?.status === "error") as { error?: { tag?: unknown; httpStatusCode?: unknown } } | undefined;
  if (crawl) {
    const tag = codeOf(crawl.error?.tag);
    const status = Number.isInteger(crawl.error?.httpStatusCode) ? crawl.error?.httpStatusCode : undefined;
    const why = [tag, status].filter((one) => one !== undefined).join(", ");
    return failed("error", tag ?? (status === undefined ? "CRAWL_FAILED" : `PAGE_${status}`), `Exa could not read the page${why ? ` (${why})` : ""}`);
  }
  const row = (Array.isArray(results) ? results : []).find((one: { text?: unknown } | null) => typeof one?.text === "string" && one.text.trim() !== "") as { url?: unknown; title?: unknown; text: string } | undefined;
  if (!row) return failed("not_text", "NO_TEXT", "Exa's fetch answered no page text");
  const asked = PAGE_READ_MAX_CHARS + 1;
  // The page's url names no user name or password: cleared first, then cut, as every client's page url is.
  return { ok: true, url: clip(withoutCredentials(typeof row.url === "string" && URL.canParse(row.url) ? row.url : url), URL_MAX), status: 200, title: clip(typeof row.title === "string" ? row.title : "", TITLE_CAP), ...textOf(row.text, row.text.length < asked), ...linksWithin(linksOf(row.text)) };
}

/** Exa on the run's key, both tools on one client. Its search keeps the caller's signal and its own bound (a paid request
 *  is not cut short by the keyless providers' deadline); a fetch it gives no page is logged with the limit it met. With
 *  no key, each request answers so, unsent. */
export const exa = defineProvider(
  { id: "exa", label: "Exa", key: { env: "EXA_API_KEY" }, ops: ["search", "fetch"], fetch: { miss: { log: "web_fetch_provider_failed", when: "failed" } }, settings: settingsOf<ExaSettings>(exaSettingsProblems) },
  ({ key, send, pay, endpoint, settings }): ProviderRun => {
    const asked = (settings ?? {}) as ExaSettings;
    const client = key === undefined ? null : exaClient(key, send ?? fetch, pay, endpoint ?? EXA_API_URL);
    return {
      search: (ask, _deadline, signal) => exaSearched(ask, client, asked, signal),
      read: (url, { signal }) => exaRead(url as string, client, asked, signal),
      unready: () => (!client ? failure("refused", "NO_KEY", "not tried: this run holds no Exa key") : client.live() ? undefined : failure("refused", "KEY_REFUSED", "not tried: refused earlier in this run")),
    };
  },
);
