import { MECHANICAL_PREDICATES, type FieldType } from "./vocabulary.js";

export type StopPredicate =
  | { predicate: "no_new_items"; key: string }
  | { predicate: "field_true"; path: string }
  | { predicate: "count_gte"; path: string; n: number }
  | { predicate: "empty"; path: string }
  | { predicate: "gte"; path: string; n: number }
  | { predicate: "lt"; path: string; n: number };

export type AcceptPredicate =
  | StopPredicate
  | { predicate: "field_equals"; path: string; value: string | number | boolean }
  | { predicate: "in"; path: string; values: Array<string | number | boolean> }
  | { predicate: "field_type"; path: string; type: FieldType }
  | QuoteMissingPredicate
  | NotPredicate;

/** Holds when a quote at `path` is in none of the page text at `pages`. `path` names a quote (a string) or a list of them;
 *  with `field`, a list (or one record) of records, each holding its quote at `field`. Each of `pages` names a state value
 *  this run wrote, a call's result most often: every string under it is page text. */
export type QuoteMissingPredicate = { predicate: "quote_missing"; path: string; field?: string; pages: string[] };

/** Holds when `of` does not. `of` is mechanical: a judged question never sits inside a negation. */
export type NotPredicate = { predicate: "not"; of: AcceptPredicate };


export const MECHANICAL_PREDICATE_NAMES: ReadonlySet<string> = new Set(MECHANICAL_PREDICATES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a dotted state path the one way every reader does: a record by key, an array by a
 *  non-negative integer index, anything else (a string, a number, a missing value) to undefined.
 *  `requires`, interpolation, `itemsPath`, `output.path` and predicates all read through here, so a
 *  path that names a value for one names it for all. */
export function getPath(value: unknown, key: string): unknown {
  if (!key) return value;
  return key.split(".").reduce<unknown>((current, part) => {
    if (isRecord(current)) return current[part];
    if (Array.isArray(current)) {
      // Only a position inside the array resolves: a canonical integer below its length. Anything
      // else (a property name, an out-of-range or non-canonical number) is not an element.
      if (!/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
      const index = Number(part);
      return Number.isSafeInteger(index) && index < current.length ? current[index] : undefined;
    }
    return undefined;
  }, value);
}

/** Whether a value is of a JSON type. A number is a finite one, and an absent value is of no type. */
function hasType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "null": return value === null;
    default:
      throw new Error(`agentrun: unsupported field_type type "${String(type)}" — fail closed, never silently false`);
  }
}

/** A quote shorter than this, normalised, is not checked: too short to say which page it came from. */
export const QUOTE_MIN_CHARS = 8;
const QUOTE_MARKS: Readonly<Record<string, string>> = { "‘": "'", "’": "'", "“": "\"", "”": "\"", "–": "-", "—": "-" };
/** A quote or a page as quote_missing compares them: lowercase, curly quotes straight, en and em dashes "-", each run of
 *  whitespace one space, trimmed. */
export const quoteText = (text: string): string =>
  text.toLowerCase().replace(/[‘’“”–—]/g, (mark) => QUOTE_MARKS[mark]!).replace(/\s+/g, " ").trim();
/** The looser reading: the letters and digits of `text` alone, each run joined by one space. */
const quoteTokens = (text: string): string => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
/** How deep under a page path strings are read: past it a value is no page. */
const PAGE_DEPTH = 64;

function pageStrings(value: unknown, out: string[], depth = 0): void {
  if (typeof value === "string") out.push(value);
  else if (depth < PAGE_DEPTH && value !== null && typeof value === "object") for (const inner of Array.isArray(value) ? value : Object.values(value)) pageStrings(inner, out, depth + 1);
}

function quotesAt(value: unknown, field: string | undefined): string[] {
  if (field === undefined) return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const records = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
  return records.map((record) => getPath(record, field)).filter((quote): quote is string => typeof quote === "string");
}

/** quote_missing's reading of `value`: how many quotes it checked (each at least QUOTE_MIN_CHARS once normalised) and how
 *  many of them are in no page. A quote is found when its normalised text is in one page string's (each string under the
 *  pages read alone, so no quote runs from one into the next), or when its letters and digits are in that string's; the
 *  pages are only what `value` holds, the run's own state. Counts alone: no quote or page text leaves here. */
export function quoteCheck(predicate: QuoteMissingPredicate, value: unknown): { checked: number; missed: number } {
  const quotes = quotesAt(getPath(value, predicate.path), predicate.field).map(quoteText).filter((quote) => quote.length >= QUOTE_MIN_CHARS);
  if (!quotes.length) return { checked: 0, missed: 0 };
  const strings: string[] = [];
  for (const page of predicate.pages) pageStrings(getPath(value, page), strings);
  const texts = strings.map((string) => { const text = quoteText(string); return { text, tokens: quoteTokens(text) }; });
  const missed = quotes.filter((quote) => {
    const loose = quoteTokens(quote);
    return !texts.some(({ text, tokens }) => text.includes(quote) || (loose !== "" && tokens.includes(loose)));
  }).length;
  return { checked: quotes.length, missed };
}

export function predicateMatches(predicate: StopPredicate | AcceptPredicate, value: unknown): boolean {
  switch (predicate.predicate) {
    case "field_equals":
      return getPath(value, predicate.path) === predicate.value;
    case "field_true":
      return getPath(value, predicate.path) === true;
    case "in": {
      const target = getPath(value, predicate.path);
      return (typeof target === "string" || typeof target === "number" || typeof target === "boolean") && predicate.values.includes(target);
    }
    case "empty": {
      const target = getPath(value, predicate.path);
      return Array.isArray(target) ? target.length === 0 : target === "" || target === null || target === undefined;
    }
    case "count_gte": {
      const target = getPath(value, predicate.path);
      const count = Array.isArray(target) ? target.length : typeof target === "number" ? target : 0;
      return count >= predicate.n;
    }
    case "no_new_items": {
      const target = getPath(value, predicate.key);
      return Array.isArray(target) ? target.length === 0 : !target;
    }
    case "gte":
    case "lt": {
      const target = getPath(value, predicate.path);
      if (typeof target !== "number" || !Number.isFinite(target)) return false;
      return predicate.predicate === "gte" ? target >= predicate.n : target < predicate.n;
    }
    case "field_type":
      return hasType(getPath(value, predicate.path), predicate.type);
    case "quote_missing":
      return quoteCheck(predicate, value).missed > 0;
    case "not":
      // A judged `of` reaches the default case below and throws: validation refuses it first.
      return !predicateMatches(predicate.of, value);
    default:
      throw new Error(
        `agentrun: unsupported predicate "${String((predicate as any)?.predicate ?? "")}" — fail closed, never silently false`,
      );
  }
}
