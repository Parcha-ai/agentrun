// What a grader reads of a web call's output (a timeline read with `calls`, tool_result_text; a template eval's
// fitCalls). A grader checks that each link a run reports is one its searches or fetches answered, so every row a
// web_search answered keeps its url, title and published date whole, and a web_fetch its url (the final one, after
// redirects) and title: only what is long gives way, a search's snippets and its provider's answer, a page's text and
// its links. The output is read as its tool writes it (web-search.ts searchText, web-fetch.ts webFetchText): its JSON
// on the first line, then the lines the tool adds after it, which stay whole. An output that is not its tool's JSON (a
// failed search's words) is none of this: it is cut as any other tool's.
type Obj = Record<string, unknown>;

const WEB_SEARCH = "web_search";
const WEB_FETCH = "web_fetch";

/** A web call's output with each text that gives way cut to `keep` characters (a cut one ending "…"), the rest whole. */
export type WebShown = (keep: number) => string;

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** `text` cut to `keep` characters and marked, never splitting a surrogate pair. */
function clip(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const code = keep > 0 ? text.charCodeAt(keep - 1) : 0;
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? keep - 1 : keep)}…`;
}

/** Every string in `value`, property names aside, through `each`. */
function eachString(value: unknown, each: (text: string) => string): unknown {
  if (typeof value === "string") return each(value);
  if (Array.isArray(value)) return value.map((item) => eachString(item, each));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, eachString(item, each)]));
  return value;
}

/** How many of `links`, in order, fit in `keep` characters of JSON. */
function linksWithin(links: readonly unknown[], keep: number): number {
  let used = 0;
  for (const [i, link] of links.entries()) {
    used += JSON.stringify(link).length + 1;
    if (used > keep) return i;
  }
  return links.length;
}

/** `text`, a call of `tool`'s output, as a grader reads it (WebShown), each of its strings through `each` first (the
 *  run's redaction, its URLs' query values elided), so a cut never falls inside what that takes out. Undefined for a
 *  tool other than web_search and web_fetch, or an output that is not its JSON. A page's links past a cut are counted
 *  in `links_cut`. */
export function webShownOf(tool: string, text: string, each: (text: string) => string = (part) => part): WebShown | undefined {
  if (tool !== WEB_SEARCH && tool !== WEB_FETCH) return undefined;
  const end = text.indexOf("\n");
  let read: unknown;
  try {
    read = JSON.parse(end < 0 ? text : text.slice(0, end));
  } catch {
    return undefined;
  }
  const shown = eachString(read, each);
  if (!isObj(shown)) return undefined;
  const after = end < 0 ? "" : each(text.slice(end));
  if (tool === WEB_SEARCH) {
    const results = shown.results;
    if (!Array.isArray(results) || !results.every(isObj)) return undefined;
    return (keep) => {
      const hits = results.map((hit) => (typeof hit.snippet === "string" ? { ...hit, snippet: clip(hit.snippet, keep) } : hit));
      return `${JSON.stringify({ ...shown, ...(typeof shown.text === "string" ? { text: clip(shown.text, keep) } : {}), results: hits })}${after}`;
    };
  }
  if (typeof shown.url !== "string" || typeof shown.text !== "string") return undefined;
  const page = shown as Obj & { text: string };
  const links = Array.isArray(page.links) ? page.links : undefined;
  return (keep) => {
    const kept = links ? linksWithin(links, keep) : 0;
    const cut = links ? links.length - kept : 0;
    const before = typeof page.links_cut === "number" ? page.links_cut : 0;
    return `${JSON.stringify({ ...page, text: clip(page.text, keep), ...(links ? { links: links.slice(0, kept) } : {}), ...(cut ? { links_cut: before + cut } : {}) })}${after}`;
  };
}

/** `shown` in `room` characters: whole when it fits, else each text that gives way cut to the longest length that
 *  fits, the same for each; past `room` only when its url lists alone pass it, every such text then cut to nothing. */
export function webWithin(shown: WebShown, room: number): string {
  const whole = shown(Number.POSITIVE_INFINITY);
  if (whole.length <= room) return whole;
  let [low, high] = [0, whole.length];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (shown(mid).length <= room) low = mid;
    else high = mid - 1;
  }
  return shown(low);
}
