export type Obj = Record<string, unknown>;

export const obj = (value: unknown): Obj | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
export const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
/** The summary of the agent's words (an answer, a text block): their first line; words that open with a fenced code block
 *  (a JSON answer's ```json … ```) the code inside the fence, up to its closing fence, each whitespace run one space, so
 *  the row previews the code itself, never the fence's label. The row's text keeps the words whole. */
export const saidSummary = (text: string): string => {
  // A fence's info string (its language) holds no backtick, so an inline ```code``` on one line is no fence.
  const open = /^\s*(`{3,}|~{3,})[^\n`]*\n/.exec(text);
  if (!open) return firstLine(text);
  const body = text.slice(open[0].length);
  // Its closing fence (CommonMark): the same character, at least as many of it as the opening fence, alone on its line,
  // indented at most 3 spaces (4 or a tab is code inside the fence, not its close).
  const close = body.search(new RegExp(`^ {0,3}\\${open[1]![0]}{${open[1]!.length},}[ \\t]*$`, "m"));
  return (close >= 0 ? body.slice(0, close) : body).replace(/\s+/g, " ").trim() || firstLine(text);
};
export const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
};

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function json(text: string): Obj | undefined {
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined;
  }
}

const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]+)([^?#]*)/i;

/** `host/path` of a URL: no scheme, no credentials, no query, no fragment. */
export function where(url: string): string {
  const parts = URL_SHAPE.exec(url.trim());
  return cut(parts ? `${parts[1]}${parts[2] === "/" ? "" : parts[2]}` : (url.split(/[?#]/)[0] ?? ""), 80);
}

const ELIDED = "\u2026";
// An apostrophe is part of a URL (a path's O'Reilly, a query's quoted word): a URL that stopped at one would leave the query
// after it unscrubbed. One that closes a quote around the URL is in its tail, as a sentence's punctuation is (scrubUrl).
const TEXT_URL = /https?:\/\/[^\s"`<>\\]+/gi;
const SCHEME = /https?:\/\//gi;
const URL_PARTS = /^(https?:\/\/)(?:[^@/?#]*@)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;
/** The userinfo of a URL run into another's host, path or query key. */
const INNER_USERINFO = /(https?:\/\/)[^@/?#\s]*@/gi;
const TAIL = ".,;:!?)]}'";
const ALNUM = /[A-Za-z0-9]/;

/**
 * Every http(s) URL in `text` keeps its origin, its path and its query keys. Query values, the fragment and the
 * userinfo are dropped, the rule pi-browser applies to the URLs a model sees.
 */
export function scrubUrls(text: string): string {
  return text.replace(TEXT_URL, (raw) => {
    // A URL that starts after nothing but punctuation holding an apostrophe is the next of a compact quoted list
    // (`'https://a','https://b'`): each is scrubbed alone. Never one past a "?" or "#" of the URL before it: that one is
    // in its query or fragment (`?next='https://b/...'`), a value dropped with it. Each look back stops at a letter or a
    // digit, and the scan for "?" and "#" goes once through `raw`, so this is linear.
    const starts = [0];
    let [scanned, valued] = [0, false];
    for (const found of raw.matchAll(SCHEME)) {
      if (found.index === 0) continue;
      for (; scanned < found.index; scanned++) valued ||= raw[scanned] === "?" || raw[scanned] === "#";
      if (valued) continue;
      let quoted = false;
      for (let i = found.index - 1; i > starts.at(-1)! && !ALNUM.test(raw[i]!); i--) quoted ||= raw[i] === "'";
      if (quoted) starts.push(found.index);
    }
    return starts.map((start, i) => scrubUrl(raw.slice(start, starts[i + 1] ?? raw.length))).join("");
  });
}

/**
 * One http(s) URL, as scrubUrls shows each it finds: its origin, its path and its query keys alone. Trailing punctuation
 * (a closing quote's among it) is kept as it was, outside the URL.
 */
export function scrubUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && TAIL.includes(raw[end - 1]!)) end--;
  const parts = URL_PARTS.exec(raw.slice(0, end));
  if (!parts) return raw;
  // Another URL run into this one, in its host, its path or a query key with no "=" (after a comma or a quote, say),
  // loses its userinfo; what follows a "=" or a "#" of either is dropped as this one's.
  const bare = (text: string) => text.replace(INNER_USERINFO, "$1");
  const keys = [...new Set((parts[4] ?? "").split("&").map((pair) => bare(pair.split("=")[0]!)).filter(Boolean))];
  return `${parts[1]}${bare(`${parts[2]}${parts[3]}`)}${keys.length ? `?${keys.map((key) => `${key}=${ELIDED}`).join("&")}` : ""}${raw.slice(end)}`;
}

/** `a, b, +2 more`. */
export const list = (items: readonly string[]): string =>
  items.length > 2 ? `${items.slice(0, 2).join(", ")}, +${items.length - 2} more` : items.join(", ");
