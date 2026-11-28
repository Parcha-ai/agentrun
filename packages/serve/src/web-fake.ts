// A template eval's fake of the web tools for one case (`web:` in its case.yaml): searches, pages and web_save's files
// answer from the fixture, in the tools' own shapes and through the guarded paths' own checks. Only the eval's own
// in-process runner binds it (runner/beside.ts), so no other server's runs ever see a fake.
import { GUARD, RATE_LIMITED } from "./web-run.js";
import { askedUrl, clip, type Hit, type Page, type Part, partProblem, type Search, searchArgs, snippetOf, TITLE_CAP, webFetch, type WebPage } from "@parcha/agentrun-web";
import type { Plane } from "./tool-plane.js";
import type { PublicFetchOptions } from "@parcha/pi-browser";

export type SearchAnswer = { query: string; results: Hit[] } | { query: string; error: string };
export type FetchAnswer = { url: string; status?: number; title?: string; text: string } | { url: string; error: string };
/** A saved file's answer: its body as text or as base64, its declared type and status. */
export type FileBody = { status?: number; content_type?: string } & ({ text: string } | { base64: string });
export type SaveAnswer = ({ url: string } & FileBody) | { url: string; error: string };
export type WebFixture = {
  search: { answers: SearchAnswer[]; default: { results: Hit[] } | { error: string } };
  fetch: { answers: FetchAnswer[]; default: { status?: number; title?: string; text: string } | { error: string } };
  save?: { answers: SaveAnswer[]; default?: FileBody | { error: string } };
};
/** A case's web fake: every web call failing, or a fixture. */
export type WebFake = "unavailable" | WebFixture;

/** A public address the fake's lookup answers: the guard checks it is public, and no connection is ever made to it. */
const PUBLIC_ADDRESS = "203.0.114.1";
/** The statuses whose answer carries no body (a Response refuses one). */
const NULL_BODY = new Set([204, 205, 304]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

/** `value` checked as a web fixture: the fixture, else each problem said through `bad`, `at` naming the file. */
export function webFixtureOf(value: unknown, at: string, bad: (message: string) => void): WebFixture | undefined {
  const problems: string[] = [];
  const say = (message: string) => void problems.push(`${at}: ${message}`);
  if (!isObject(value) || !isObject(value.search) || !isObject(value.fetch)) {
    bad(`${at}: a web fixture is {search: {answers, default}, fetch: {answers, default}}`);
    return undefined;
  }
  const hitOk = (hit: unknown) => isObject(hit) && isText(hit.url) && URL.canParse(hit.url) && isText(hit.title) && isText(hit.snippet) && (hit.published === undefined || isText(hit.published));
  const searchOk = (answer: unknown, keyed: boolean) => isObject(answer) && (!keyed || isText(answer.query)) && (Array.isArray(answer.results) ? answer.results.every(hitOk) && answer.error === undefined : isText(answer.error));
  const pageOk = (answer: unknown, keyed: boolean) => isObject(answer) && (!keyed || (isText(answer.url) && URL.canParse(answer.url))) && (isText(answer.text) ? answer.error === undefined && (answer.title === undefined || isText(answer.title)) && (answer.status === undefined || (Number.isInteger(answer.status) && (answer.status as number) >= 200 && (answer.status as number) <= 599)) : isText(answer.error));
  const search = value.search;
  const fetch = value.fetch;
  if (!Array.isArray(search.answers)) say("search.answers is a list of {query, results} or {query, error}");
  else search.answers.forEach((answer, i) => {
    if (!searchOk(answer, true)) return void say(`search.answers.${i} is {query, results} or {query, error}, each result {url, title, snippet, published?}`);
    try {
      new RegExp((answer as { query: string }).query, "i");
    } catch {
      say(`search.answers.${i}.query does not compile as a regular expression`);
    }
  });
  if (!searchOk(search.default, false)) say("search.default is {results} or {error}, each result {url, title, snippet, published?}");
  if (!Array.isArray(fetch.answers)) say("fetch.answers is a list of {url, status?, title?, text} or {url, error}");
  else fetch.answers.forEach((answer, i) => {
    if (!pageOk(answer, true)) say(`fetch.answers.${i} is {url, status?, title?, text} or {url, error}, its url absolute and its status 200 to 599`);
  });
  if (!pageOk(fetch.default, false)) say("fetch.default is {status?, title?, text} or {error}");
  const statusOk = (status: unknown) => status === undefined || (Number.isInteger(status) && (status as number) >= 200 && (status as number) <= 599);
  const fileOk = (answer: unknown, keyed: boolean) => isObject(answer) && (!keyed || (isText(answer.url) && URL.canParse(answer.url)))
    && (isText(answer.error) ? answer.text === undefined && answer.base64 === undefined : (isText(answer.text) !== isText(answer.base64)) && (answer.text === undefined || isText(answer.text)) && (answer.base64 === undefined || isText(answer.base64)) && statusOk(answer.status) && (answer.content_type === undefined || isText(answer.content_type)));
  if (value.save !== undefined) {
    const save = value.save;
    if (!isObject(save) || !Array.isArray(save.answers)) say("save is {answers, default?}, answers a list of {url, content_type?, status?, text | base64} or {url, error}");
    else {
      save.answers.forEach((answer, i) => {
        if (!fileOk(answer, true)) say(`save.answers.${i} is {url, content_type?, status?, text | base64} or {url, error}, its url absolute and its status 200 to 599`);
      });
      if (save.default !== undefined && !fileOk(save.default, false)) say("save.default is {content_type?, status?, text | base64} or {error}");
    }
  }
  for (const problem of problems) bad(problem);
  return problems.length ? undefined : (value as unknown as WebFixture);
}

/** `args` searched in `fake`, as the run's web_search answers: `provider`, the one the run's plane names. An answer's
 *  `query` pattern matches the search's objective or any of its queries. */
export function fakeSearch(fake: WebFake, args: Record<string, unknown>, provider: Exclude<Search, { error: string }>["provider"]): Search {
  const { objective, queries, n } = searchArgs(args);
  if (!objective) return { error: "web_search needs an objective" };
  if (fake === "unavailable") return { error: RATE_LIMITED };
  const asked = [objective, ...queries];
  const answer = fake.search.answers.find((one) => asked.some((text) => new RegExp(one.query, "i").test(text))) ?? fake.search.default;
  if ("error" in answer) return { error: answer.error };
  const results = answer.results.slice(0, n).map((hit) => ({ url: hit.url, title: clip(hit.title, TITLE_CAP), snippet: snippetOf(hit.snippet), ...(hit.published === undefined ? {} : { published: hit.published }) }));
  return { provider, objective, queries, results };
}

/** The part `part` names of the page at `url` in `fake`, as the run's web_fetch answers, through the guarded direct
 *  fetch's own path with the fake standing in for the network. */
export async function fakeFetch(fake: WebFake, url: unknown, part: Part & { signal?: AbortSignal } = {}): Promise<WebPage | Page> {
  const problem = partProblem(part);
  if (problem) return { ok: false, url: askedUrl(url), status: 0, title: "", text: "", links: [], error: problem };
  const answer = fake === "unavailable" ? undefined : (fake.fetch.answers.find((one) => one.url === url) ?? fake.fetch.default);
  const page = await webFetch(url, {
    ...part,
    guard: GUARD,
    lookup: async () => [PUBLIC_ADDRESS],
    fetchImpl: async () => {
      // As undici's fetch rejects when a connection is refused: the guarded fetch says it in its own words.
      if (answer === undefined) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      if ("error" in answer) throw new TypeError(answer.error);
      const status = answer.status ?? 200;
      return new Response(NULL_BODY.has(status) ? null : answer.text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
    },
  });
  // A page served as text has no title of its own: the fixture's.
  return page.ok && answer && !("error" in answer) && answer.title ? { ...page, title: clip(answer.title, TITLE_CAP) } : page;
}

/** The guard's resolver and fetch for web_save in `fake`: every name a public address, each file answered from the
 *  fixture's `save` (by exact URL, else its default), every other URL a refused connection, as a host that is down. */
export function fakeSaveOptions(fake: WebFake): Pick<PublicFetchOptions, "lookup" | "fetchImpl"> {
  return {
    lookup: async () => [PUBLIC_ADDRESS],
    fetchImpl: async (url) => {
      const save = fake === "unavailable" ? undefined : fake.save;
      const answer = save?.answers.find((one) => one.url === String(url)) ?? save?.default;
      if (answer === undefined) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      if ("error" in answer) throw new TypeError(answer.error);
      const status = answer.status ?? 200;
      const body = "base64" in answer ? Buffer.from(answer.base64, "base64") : answer.text;
      return new Response(NULL_BODY.has(status) ? null : body, { status, headers: answer.content_type ? { "content-type": answer.content_type } : {} });
    },
  };
}

/** A faked run's plane: web_search never a harness's own search (Claude's or Codex's, which would answer in its stead), so
 *  the run's own web_search tool, the one the fake answers through, is the one its harness offers. */
export function fakedPlane(plane: Plane | undefined): Plane | undefined {
  return plane?.web_search === "native" ? { ...plane, web_search: "firecrawl-keyless" } : plane;
}
