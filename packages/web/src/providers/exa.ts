// Exa on the run's key (https://docs.exa.ai): /search for web_search, /contents for web_fetch, each one paid request
// (fees.ts exaFeeOf) through the run's Pay, on the x-api-key header. Its settings are typed, each with a default
// (EXA_DEFAULTS); a setting it does not take is refused when the Web is made. A 401 or 403 refuses the key for the run.
import { EXA_SEARCH_TYPE_USD, type ExaSearchType, exaFeeOf, type Pay } from "../fees.js";
import { clip, linksWithin, MAX_CHARS_MIN, PAGE_READ_MAX_CHARS, type Read, TITLE_CAP, textOf, URL_MAX } from "../page.js";
import { type Hit, type Searched, SNIPPET_MAX, searchArgs, snippetOf } from "../search.js";
import { linksOf } from "../text-urls.js";
import { type Check, codeOf, domains, type Keyed, keyedCall, keyedClient, type KeyedFailed, oneOf, settingsProblems, wholeIn, yesNo } from "./keyed.js";

export const EXA_API_URL = "https://api.exa.ai";
/** Exa's bound on one request: a deep search takes tens of seconds. */
export const EXA_MS = 120_000;
export const EXA_CATEGORIES = ["company", "publication", "news", "personal site", "financial report", "people"] as const;

/** How Exa searches and reads, each setting optional (EXA_DEFAULTS):
 *  - `type`: the search's depth and price (fees.ts EXA_SEARCH_TYPE_USD), default "auto";
 *  - `snippet`: each result's text for its snippet, its query-relevant `highlights` or the page's `text` from its start,
 *    default "highlights"; `snippetChars`, how many characters of it Exa gives, MAX_CHARS_MIN to SNIPPET_MAX, default
 *    SNIPPET_MAX (a snippet keeps at most SNIPPET_MAX);
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
export const EXA_DEFAULTS = Object.freeze({ type: "auto", snippet: "highlights", snippetChars: SNIPPET_MAX, pageVerbosity: "compact", pageLinks: true } as const);

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
  const { type, snippet, snippetChars } = { ...EXA_DEFAULTS, ...settings };
  const content = snippet === "text" ? { text: { maxCharacters: snippetChars } } : { highlights: { maxCharacters: snippetChars } };
  return {
    query,
    type,
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

/** `{query, n?}` searched through `client` (null: the run holds no key) under `settings`, and the limit Exa answered for
 *  the run's key, if any. */
export async function exaSearched(args: Record<string, unknown>, client: Keyed | null, settings: ExaSettings = {}, signal?: AbortSignal): Promise<Searched> {
  const { query, n } = searchArgs(args);
  if (!query) return { answer: { error: "web_search needs a query" } };
  const got = await keyedCall(client, "Exa", "EXA_API_KEY", "search", "/search", exaSearchBody(query, n, settings), signal);
  if ("error" in got) return { answer: { error: got.error }, ...(got.limit ? { limit: got.limit } : {}) };
  const { results } = got.json;
  if (!Array.isArray(results)) return { answer: { error: "Exa's search answered no results this server reads" } };
  const asked = settings.snippet ?? EXA_DEFAULTS.snippet;
  const hits = results.flatMap((row: { url?: unknown; title?: unknown; publishedDate?: unknown; highlights?: unknown; text?: unknown } | null): Hit[] => {
    if (typeof row?.url !== "string" || !URL.canParse(row.url)) return [];
    return [{ url: row.url, title: typeof row.title === "string" ? clip(row.title, TITLE_CAP) : "", snippet: snippetOf(snippetText(row, asked)), ...(typeof row.publishedDate === "string" ? { published: row.publishedDate } : {}) }];
  });
  return { answer: { provider: "exa", query, results: hits.slice(0, n) } };
}

/** The /contents request for `url` under `settings`: its text to the most of a page web_fetch reads and one character
 *  more (so a page Exa cut there shows as going on), at the verbosity asked, its links kept or not. */
export function exaContentsBody(url: string, settings: ExaSettings = {}): Record<string, unknown> {
  const { pageVerbosity, pageLinks } = { ...EXA_DEFAULTS, ...settings };
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
  const failed = (Array.isArray(statuses) ? statuses : []).find((one: { status?: unknown } | null) => one?.status === "error") as { error?: { tag?: unknown; httpStatusCode?: unknown } } | undefined;
  if (failed) {
    const tag = codeOf(failed.error?.tag);
    const status = Number.isInteger(failed.error?.httpStatusCode) ? failed.error?.httpStatusCode : undefined;
    const why = [tag, status].filter((one) => one !== undefined).join(", ");
    return { error: `Exa could not read the page${why ? ` (${why})` : ""}` };
  }
  const row = (Array.isArray(results) ? results : []).find((one: { text?: unknown } | null) => typeof one?.text === "string" && one.text.trim() !== "") as { url?: unknown; title?: unknown; text: string } | undefined;
  if (!row) return { error: "Exa's fetch answered no page text" };
  const asked = PAGE_READ_MAX_CHARS + 1;
  return { ok: true, url: clip(typeof row.url === "string" && URL.canParse(row.url) ? row.url : url, URL_MAX), status: 200, title: clip(typeof row.title === "string" ? row.title : "", TITLE_CAP), ...textOf(row.text, row.text.length < asked), ...linksWithin(linksOf(row.text)) };
}
