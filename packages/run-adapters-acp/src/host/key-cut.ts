// The keys the adapter handed an agent (its recipe's keys, read by name), cut from what the agent says before any of it is
// shortened: a cut inside a key would leave a piece that no longer matches it, so nothing downstream (a host's own
// redactor, which still runs over what it keeps) could find it. Written for AgentRun.

/** A value shorter than this matches too much text by chance and is left as it is (as a host's redactor leaves it). */
export const KEY_CUT_MIN = 8;
export const KEY_CUT = "[redacted]";

/** The values worth cutting: those at least KEY_CUT_MIN long, longest first (a key holding another is cut whole). */
export const keysToCut = (values: readonly (string | undefined)[]): string[] =>
  [...new Set(values.filter((value): value is string => typeof value === "string" && value.length >= KEY_CUT_MIN))].sort((a, b) => b.length - a.length);

/** `text` with each of `keys` (keysToCut) replaced, as written. */
export function cutKeys(text: string, keys: readonly string[]): string {
  let out = text;
  for (const key of keys) out = out.split(key).join(KEY_CUT);
  return out;
}

/** `text`, a tail whose start was cut, without the end of a key at its head: the longest piece that ends one of `keys`
 *  and starts the text goes (a key's end matches no key, so no cut of whole keys finds it). */
export function cutKeyEndAtHead(text: string, keys: readonly string[]): string {
  let drop = 0;
  for (const key of keys) {
    for (let n = Math.min(key.length - 1, text.length); n > drop; n--) {
      if (text.startsWith(key.slice(-n))) {
        drop = n;
        break;
      }
    }
  }
  return text.slice(drop);
}

/** `text` without the start of a key at its end: the longest piece that starts one of `keys` and ends the text goes (a
 *  key still being written, read mid-run, matches no key either). */
export function cutKeyEndAtTail(text: string, keys: readonly string[]): string {
  let drop = 0;
  for (const key of keys) {
    for (let n = Math.min(key.length - 1, text.length); n > drop; n--) {
      if (text.endsWith(key.slice(0, n))) {
        drop = n;
        break;
      }
    }
  }
  return text.slice(0, text.length - drop);
}
