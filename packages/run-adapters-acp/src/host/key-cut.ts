// The keys the adapter handed an agent (its recipe's keys, read by name), cut from what the agent says before any of it is
// shortened: a cut inside a key would leave a piece that no longer matches it, so nothing downstream (a host's own
// redactor, which still runs over what it keeps) could find it. Written for AgentRun.

/** A value shorter than this matches too much text by chance and is left as it is (as a host's redactor leaves it). */
export const KEY_CUT_MIN = 8;
export const KEY_CUT = "[redacted]";

/** The values worth cutting: those at least KEY_CUT_MIN long, longest first (a key holding another is cut whole). */
export const keysToCut = (values: readonly (string | undefined)[]): string[] =>
  [...new Set(values.filter((value): value is string => typeof value === "string" && value.length >= KEY_CUT_MIN))].sort((a, b) => b.length - a.length);

/** Which pieces at the text's edges go too, beside whole keys. `head`: a key's end at its start (a tail whose start was
 *  cut). `tail`: a key's start at its end (a key still being written, read mid-run). Neither matches a whole key. */
export interface KeyEdges {
  readonly head?: boolean;
  readonly tail?: boolean;
}

/** `text` with each whole key of `keys` (keysToCut), as written, made KEY_CUT, and a piece of one at an edge named in
 *  `edges` dropped. A piece inside the text stays, as does a key spelled another way (a host's redactor cuts the
 *  spellings it knows, whole).
 *  Every key is found in `text` as written before any is cut, so keys that overlap, or one that holds another's start
 *  or end, can't hide each other. A run of marked text that reaches into an edge piece is dropped whole; any other run
 *  becomes one KEY_CUT. */
export function cutKeys(text: string, keys: readonly string[], edges: KeyEdges = {}): string {
  const WHOLE = 1;
  const EDGE = 2;
  const mark = new Uint8Array(text.length);
  for (const key of keys) {
    // An empty key is no key, and "".indexOf past the end returns the end, never -1.
    if (!key) continue;
    for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) mark.fill(WHOLE, at, at + key.length);
  }
  if (edges.head) mark.fill(EDGE, 0, edgeLength(keys, text.length, (key, n) => text.startsWith(key.slice(-n))));
  if (edges.tail) mark.fill(EDGE, text.length - edgeLength(keys, text.length, (key, n) => text.endsWith(key.slice(0, n))));
  let out = "";
  for (let from = 0, to = 0; from < text.length; from = to) {
    const marked = mark[from] !== 0;
    let edge = false;
    for (; to < text.length && (mark[to] !== 0) === marked; to++) edge ||= mark[to] === EDGE;
    out += !marked ? text.slice(from, to) : edge ? "" : KEY_CUT;
  }
  return out;
}

/** The longest n, shorter than its key, for which `fits(key, n)` holds for one of `keys`; 0 if none does. */
function edgeLength(keys: readonly string[], max: number, fits: (key: string, n: number) => boolean): number {
  let longest = 0;
  for (const key of keys) {
    for (let n = Math.min(key.length - 1, max); n > longest; n--) {
      if (fits(key, n)) {
        longest = n;
        break;
      }
    }
  }
  return longest;
}
