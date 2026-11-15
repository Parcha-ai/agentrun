// A template eval's link check (template-eval.ts graderInput): each http(s) link a run's answer cites, matched in code
// against every url its calls answered (its web calls', and the URLs any other call's result holds whole), so "every link
// the answer cites appears in the run's calls" is read from one block, never judged as URL equality from a rubric's prose. A link matches a url when their canonical forms do
// (canonicalUrl): no fragment, no trailing slash on the path, scheme and host lower-cased, query keys sorted; the two key
// sets equal, and each value equal, except that a call's value read as "…" (a timeline read elides query values,
// scrubUrls) matches any value for its key. Structural only: whether a cited item is in scope stays the rubric's call.
import { lastJsonBlock } from "./answer-json.js";
import { linksOf, linksWritten, TRAILING, trimmed, wholeUrl } from "./text-urls.js";
import { scrubUrl } from "./timeline/index.js";
import { WEB_FETCH_TOOL } from "./web-fetch.js";
import { WEB_SEARCH_TOOL } from "./web-search.js";

/** A call as a grader's list holds it (template-eval.ts ToolCall): its name, arguments and output's head. */
export type CheckedCall = { tool: string; name?: string; arguments?: unknown; result?: string | null };

/** A URL's form for matching: scheme, host and path (no trailing slash), and its query values by key, each list sorted. */
export type CanonicalUrl = { base: string; query: Map<string, string[]> };

const ELIDED = "…";

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** `url` canonical (see the head of this file), or undefined for one that is not an http(s) URL. */
export function canonicalUrl(url: string): CanonicalUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const query = new Map<string, string[]>();
  for (const [key, value] of parsed.searchParams) query.set(key, [...(query.get(key) ?? []), value]);
  for (const values of query.values()) values.sort();
  return { base: `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`, query };
}

/** Whether a cited link matches a url a call answered: the same base and key set, each value equal unless the call's
 *  values are all "…". */
export function urlMatches(cited: CanonicalUrl, called: CanonicalUrl): boolean {
  if (cited.base !== called.base || cited.query.size !== called.query.size) return false;
  for (const [key, values] of called.query) {
    const mine = cited.query.get(key);
    if (!mine) return false;
    if (values.every((value) => value === ELIDED)) continue;
    if (mine.length !== values.length || mine.some((value, i) => value !== values[i])) return false;
  }
  return true;
}

/** The forms a URL found in plain text may end at, longest first: as found, then less one trailing punctuation mark at a
 *  time. A URL can end in one (`/wiki/Yahoo!`), so which is the link is read from what matches, never guessed. */
function formsOf(raw: string): string[] {
  const forms = [raw];
  for (let url = raw; url && TRAILING.includes(url.at(-1)!); ) forms.push((url = url.slice(0, -1)));
  return forms;
}

/** Every http(s) URL in `text`, in order, read as a page's links are (linksWritten, text-urls.ts), each as the forms it may
 *  end at: a markdown link's target that its ")" closed as that one form; any other as formsOf gives it. A link's text
 *  and target read as two. */
function linksIn(text: string): string[][] {
  return [...linksWritten(text)].flatMap(({ raw, exact }) => (/^https?:\/\//i.test(raw) ? [exact ? [raw] : formsOf(raw)] : []));
}

/** A JSON string's links: the string itself when it is one URL whole (wholeUrl: a field holding a link means all of it),
 *  else those in its text. */
const jsonLinks = (text: string): string[][] => {
  const whole = wholeUrl(text);
  return whole === undefined ? linksIn(text) : [[whole]];
};

/** Every string in `value`, property names aside. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return isObj(value) ? Object.values(value).flatMap(stringsIn) : [];
}

/** Every http(s) URL an answer cites, in order, each once, as the forms it may end at (linksIn, jsonLinks): in its text,
 *  and in any string of its JSON (the whole answer, else its last json block), read from the parsed JSON so an escape in
 *  it never cuts a URL short. */
export function citedLinks(answer: string): string[][] {
  let found: string[][];
  try {
    found = stringsIn(JSON.parse(answer)).flatMap(jsonLinks);
  } catch {
    const block = lastJsonBlock(answer);
    let parsed: unknown;
    try {
      parsed = block === undefined ? undefined : JSON.parse(block);
    } catch {
      parsed = undefined;
    }
    found = parsed === undefined ? linksIn(answer) : [...linksIn(answer.replace(block!, "")), ...stringsIn(parsed).flatMap(jsonLinks)];
  }
  return [...new Map(found.map((forms) => [forms.join("\n"), forms])).values()];
}

/** A call's urls for the check, and whether it is a web call: a web_search's results', a web_fetch's asked url, final url
 *  and page links, with how many of that page's links its output lost to a cut (`links_cut`). Any other call's are the
 *  URLs its result holds as it returned them (linksOf: a JSON string that is a URL whole counts whole). A grader reads
 *  only such a result's head (CALL_RESULT_CHARS, cut with "..." as timeline/util.ts cut ends it), so one ending in "..."
 *  may have held more past it: a cut of unknown count (1), named on a link that matches nothing, never a verdict. */
function sourceOf(call: CheckedCall): { urls: string[]; cut: number; web: boolean } {
  const tool = call.name ?? call.tool;
  const text = call.result ?? "";
  if (tool !== WEB_SEARCH_TOOL && tool !== WEB_FETCH_TOOL) return { urls: [...linksOf(text)], cut: text.endsWith("...") ? 1 : 0, web: false };
  const end = text.indexOf("\n");
  let read: unknown;
  try {
    read = JSON.parse(end < 0 ? text : text.slice(0, end));
  } catch {
    read = undefined;
  }
  const out = isObj(read) ? read : {};
  if (tool === WEB_SEARCH_TOOL) return { urls: Array.isArray(out.results) ? out.results.flatMap((hit) => (isObj(hit) && typeof hit.url === "string" ? [hit.url] : [])) : [], cut: 0, web: true };
  const asked = isObj(call.arguments) && typeof call.arguments.url === "string" ? [call.arguments.url] : [];
  return { urls: [...asked, ...(typeof out.url === "string" ? [out.url] : []), ...strings(out.links)], cut: typeof out.links_cut === "number" ? out.links_cut : 0, web: true };
}

const callsWord = (calls: readonly number[]) => (calls.length === 1 ? `call ${calls[0]}` : `calls ${calls.slice(0, -1).join(", ")} and ${calls.at(-1)}`);

/** The link check's lines for a grader, or undefined when there is nothing to check: the run made no web_search or
 *  web_fetch call, and either the answer cites no link or no call returned a URL. One line per distinct link the answer
 *  cites, shown as a call's url is (scrubUrl: no query values, fragment or userinfo), saying the first call (numbered as
 *  the grader's list numbers them) one of whose urls it matches, or that none does, naming any fetched page whose links
 *  were cut, as that page could have held it. */
export function linkCheck(answer: string, calls: readonly CheckedCall[]): string | undefined {
  const sources = calls.map(sourceOf);
  const citations = citedLinks(answer);
  if (!sources.some((source) => source.web) && !(citations.length && sources.some((source) => source.urls.length))) return undefined;
  const called = sources.map((source) => source.urls.flatMap((url) => canonicalUrl(url) ?? []));
  const cut = sources.flatMap((source, i) => (source.cut ? [i + 1] : []));
  const seen = new Set<string>();
  const lines: string[] = [];
  const matchOf = (cited: CanonicalUrl) => called.findIndex((urls) => urls.some((url) => urlMatches(cited, url)));
  for (const forms of citations) {
    // The longest form that matches a call is the link; with none, a plain-text one less the punctuation around it.
    let [link, at] = [forms.length > 1 ? trimmed(forms[0]!) : forms[0]!, -1];
    for (const form of forms) {
      const canonical = canonicalUrl(form);
      const i = canonical ? matchOf(canonical) : -1;
      if (i < 0) continue;
      [link, at] = [form, i];
      break;
    }
    const cited = canonicalUrl(link);
    if (!cited) continue;
    const key = JSON.stringify([cited.base, [...cited.query].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${scrubUrl(link)} — ${at >= 0 ? `matches call ${at + 1}` : `no matching call${cut.length ? ` (${callsWord(cut)}'s links were cut)` : ""}`}`);
  }
  const intro =
    "Each distinct http(s) link the answer cites, checked in code against every url its calls answered (a web_search's results; a web_fetch's url, its final url and its page's links; any other call's URLs as its result holds them): a fragment, a trailing slash and the order of the query are ignored, the query's keys must be the same, and a query value shown as … matches any value for its key. Links are shown with their query values elided.";
  return [intro, ...(lines.length ? lines : ["(the answer cites no http(s) link)"])].join("\n");
}
