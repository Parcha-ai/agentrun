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

/** Every string in `value` through `each`, property names too (a tool may write a value as one): two names `each` makes
 *  one are both kept, the later ones numbered, as the runner's cutDeep keeps them (runner/redact.ts). */
function eachString(value: unknown, each: (text: string) => string): unknown {
  if (typeof value === "string") return each(value);
  if (Array.isArray(value)) return value.map((item) => eachString(item, each));
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [key, item] of Object.entries(value)) {
    const once = each(key);
    let name = once;
    for (let n = 2; Object.hasOwn(out, name); n++) name = `${once} (${n})`;
    Object.defineProperty(out, name, { value: eachString(item, each), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Every string in `value` in order; with `names`, each property name before its value. */
function stringsOf(value: unknown, names: boolean, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, names, out);
  else if (isObj(value))
    for (const [key, item] of Object.entries(value)) {
      if (names) out.push(key);
      stringsOf(item, names, out);
    }
  return out;
}

/** `text`, a call of `tool`'s output, read as its tool writes it: the JSON object on its first line, and where that line
 *  ends (-1 when it is the whole text). Undefined for a tool other than web_search and web_fetch, or an output whose
 *  first line is not a JSON object. */
function webRead(tool: string, text: string): { read: Obj; end: number } | undefined {
  if (tool !== WEB_SEARCH && tool !== WEB_FETCH) return undefined;
  const end = text.indexOf("\n");
  let read: unknown;
  try {
    read = JSON.parse(end < 0 ? text : text.slice(0, end));
  } catch {
    return undefined;
  }
  return isObj(read) ? { read, end } : undefined;
}

/** Whether `text`, a web call's output, is withheld whole: `holds` (whether a text holds a held value no cut in place
 *  takes: key-refusal.ts withheldWhole) reads its JSON's strings as they came joined by line breaks, then the lines after
 *  the JSON: once its values alone, so two values side by side in the output are side by side in the join, and once with
 *  each property name before its value, so a name and its value are too. Each string is cut on its own wherever the output is shown (webCut,
 *  webShownOf), and the JSON's punctuation between two strings is no whitespace any view of the whole text joins across,
 *  so a held value split across two of them is found only here. Every reader of a web call's output asks this first:
 *  the runner before it stores the answer (adapter-run-spec.ts answersCut), a timeline before its row shows any of it
 *  (timeline.ts shownOf, resultText). False for an output that is not a web call's JSON. */
export function webHeld(tool: string, text: string, holds: (text: string) => boolean): boolean {
  const web = webRead(tool, text);
  return web ? heldIn(web, text, holds) : false;
}

/** webHeld of an output already read (webRead). */
const heldIn = (web: { read: Obj; end: number }, text: string, holds: (text: string) => boolean): boolean =>
  [false, true].some((names) => holds(`${stringsOf(web.read, names).join("\n")}${web.end < 0 ? "" : text.slice(web.end)}`));

/** What a web call withheld whole shows. */
const WITHHELD: WebShown = () => "[redacted]";

/** How many of `links`, in order, fit in `keep` characters of JSON. */
function linksWithin(links: readonly unknown[], keep: number): number {
  let used = 0;
  for (const [i, link] of links.entries()) {
    used += JSON.stringify(link).length + 1;
    if (used > keep) return i;
  }
  return links.length;
}

/** `text`, a call of `tool`'s output, with `cut` (the run's redactor) applied to each string of its JSON by itself, its
 *  property names too, and to the lines after it, never to its JSON line whole: the redactor reads a run of more than
 *  8,192 characters with no whitespace as "[redacted]" (key-refusal.ts redactedAnswer), and a JSON line, whose newlines
 *  are escapes, is one such run from its text's last space through its links, so cut whole it loses its links and no
 *  longer parses. "[redacted]" when `holds` finds a held value split across its strings (webHeld). Undefined for a tool
 *  other than web_search and web_fetch, or an output whose first line is not a JSON object: that one is cut as any other
 *  tool's. */
export function webCut(tool: string, text: string, cut: (text: string) => string, holds?: (text: string) => boolean): string | undefined {
  const web = webRead(tool, text);
  if (!web) return undefined;
  if (holds && heldIn(web, text, holds)) return "[redacted]";
  return `${JSON.stringify(eachString(web.read, cut))}${web.end < 0 ? "" : cut(text.slice(web.end))}`;
}

/** `text`, a call of `tool`'s output, as a grader reads it (WebShown), each of its strings through `each` first (the
 *  run's redaction, its URLs' query values elided), so a cut never falls inside what that takes out. Undefined for a
 *  tool other than web_search and web_fetch, or an output that is not its JSON. A page's links past a cut are counted
 *  in `links_cut`. With `holds`, an output it withholds (webHeld: a held value split across two strings, which `each`
 *  reads one at a time) shows "[redacted]". */
export function webShownOf(tool: string, text: string, each: (text: string) => string = (part) => part, holds?: (text: string) => boolean): WebShown | undefined {
  const web = webRead(tool, text);
  if (!web) return undefined;
  const shown = eachString(web.read, each) as Obj;
  const after = web.end < 0 ? "" : each(text.slice(web.end));
  const withheld = () => (holds ? heldIn(web, text, holds) : false);
  if (tool === WEB_SEARCH) {
    const results = shown.results;
    if (!Array.isArray(results) || !results.every(isObj)) return undefined;
    if (withheld()) return WITHHELD;
    return (keep) => {
      const hits = results.map((hit) => (typeof hit.snippet === "string" ? { ...hit, snippet: clip(hit.snippet, keep) } : hit));
      return `${JSON.stringify({ ...shown, ...(typeof shown.text === "string" ? { text: clip(shown.text, keep) } : {}), results: hits })}${after}`;
    };
  }
  if (typeof shown.url !== "string" || typeof shown.text !== "string") return undefined;
  const page = shown as Obj & { text: string };
  const links = Array.isArray(page.links) ? page.links : undefined;
  if (withheld()) return WITHHELD;
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
