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
/** The names eachString has tried for a property, counted so a test can bound the work, not time it. */
export const namesTried = { count: 0 };

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
  let next: Map<string, number> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const once = each(key);
    let name = once;
    // Each name's count goes on from its last free number: no name is taken back, so every number below it is still taken.
    for (let n = next?.get(once) ?? 2; (namesTried.count++, Object.hasOwn(out, name)); n++) {
      name = `${once} (${n})`;
      (next ??= new Map()).set(once, n + 1);
    }
    Object.defineProperty(out, name, { value: eachString(item, each), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Every string in `value` in the order its object reads (Object.entries: integer-like names first, a name written twice
 *  once, with its last value): the order JSON.stringify writes it back in (webCut, webShownOf). With `names`, each
 *  property name before its value. */
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

/** A JSON string as written, and the colon after it when it is a property name. */
const JSON_STRING = /("(?:[^"\\]|\\.)*")(\s*:)?/g;

/** Every string in `line`, a JSON text that parses, in the order it is written, each value of a name written twice too;
 *  with `names`, each property name as well, before its value. In JSON that parses, a quote outside a string only
 *  ever opens one, so the strings are read by JSON_STRING alone. */
function writtenStrings(line: string, names: boolean): string[] {
  const out: string[] = [];
  for (const [, quoted, colon] of line.matchAll(JSON_STRING)) if (names || !colon) out.push(JSON.parse(quoted!) as string);
  return out;
}

/** Whether a text holds a held value no cut in place takes (key-refusal.ts withheldWhole): `joined` is `parts` joined
 *  by line breaks, for a reader that reads each part by itself too (adapter-run-spec.ts answersCut). */
export type WebHolds = (joined: string, parts: readonly string[]) => boolean;

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

/** Whether `text`, a web call's output, is withheld whole: `holds` (key-refusal.ts withheldWhole) reads the output as it
 *  came, through the matcher's join view (redact/match.ts joinOf: a JSON text's strings joined), then its JSON's strings
 *  joined by line breaks with the lines after the JSON, once its values alone and once with each property name before its
 *  value. They are read in the order the output is written back in (stringsOf) and, where that differs, in the order it
 *  was written (writtenStrings). Every reader asks this first: the runner before it stores the answer (answersCut), a
 *  timeline before its row shows. Each string is cut on its own wherever the output is shown, so a held value split across
 *  two of them, or across a property name and its value, is found only here. False for an output that is not a web
 *  call's JSON. */
export function webHeld(tool: string, text: string, holds: WebHolds): boolean {
  const web = webRead(tool, text);
  return web ? heldIn(web, text, holds) : false;
}

/** webHeld of an output already read (webRead). */
function heldIn(web: { read: Obj; end: number }, text: string, holds: WebHolds): boolean {
  if (holds(text, [text])) return true;
  const after = web.end < 0 ? [] : [text.slice(web.end + 1)];
  const line = web.end < 0 ? text : text.slice(0, web.end);
  const asked = (strings: readonly string[]): boolean => {
    const parts = [...strings, ...after];
    return holds(parts.join("\n"), parts);
  };
  return [false, true].some((names) => {
    const back = stringsOf(web.read, names);
    const written = writtenStrings(line, names);
    return asked(back) || (!sameStrings(back, written) && asked(written));
  });
}

/** Whether two lists hold the same strings in the same order. */
const sameStrings = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((one, i) => one === b[i]);

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
export function webCut(tool: string, text: string, cut: (text: string) => string, holds?: WebHolds): string | undefined {
  const web = webRead(tool, text);
  if (!web) return undefined;
  if (holds && heldIn(web, text, holds)) return "[redacted]";
  return `${JSON.stringify(eachString(web.read, cut))}${web.end < 0 ? "" : cut(text.slice(web.end))}`;
}

/** `text`, a call of `tool`'s output, as a grader reads it (WebShown), each of its strings through `each` first (the
 *  run's redaction, its URLs' query values elided), so a cut never falls inside what that takes out. Undefined for a
 *  tool other than web_search and web_fetch, or an output that is not its JSON. A page's links past a cut are counted
 *  in `links_cut`. */
export function webShownOf(tool: string, text: string, each: (text: string) => string = (part) => part): WebShown | undefined {
  const web = webRead(tool, text);
  if (!web) return undefined;
  const shown = eachString(web.read, each) as Obj;
  const after = web.end < 0 ? "" : each(text.slice(web.end));
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
