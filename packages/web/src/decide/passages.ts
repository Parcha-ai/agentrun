export const PASSAGE_CHARS = 1_000;
export const PASSAGES_MAX = 50;

const isLow = (text: string, at: number) => (text.charCodeAt(at) & 0xfc00) === 0xdc00;

/** Where the paragraphs of `text` end: after each blank line (and the blank lines that follow it), and at its end. */
function paragraphEnds(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(/\n[ \t]*\n\s*/g)) ends.push(match.index + match[0].length);
  if (ends.at(-1) !== text.length) ends.push(text.length);
  return ends;
}

/** The pieces of [start, end), none over `size`: cut after the last whitespace within `size`, else at `size` itself,
 *  one short where that would split a surrogate pair. */
function cut(text: string, start: number, end: number, size: number): number[] {
  const ends: number[] = [];
  for (let at = start; end - at > size; ) {
    const window = text.slice(at, at + size);
    const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"), window.lastIndexOf("\t"));
    let next = space > 0 ? at + space + 1 : at + size;
    if (space <= 0 && isLow(text, next)) next -= 1;
    ends.push(next);
    at = next;
  }
  ends.push(end);
  return ends;
}

function packed(text: string, size: number): [number, number][] {
  const pieces = paragraphEnds(text).flatMap((end, i, all) => cut(text, i ? all[i - 1]! : 0, end, size));
  const spans: [number, number][] = [];
  let start = 0;
  let last = 0;
  for (const end of pieces) {
    if (end - start > size && last > start) {
      spans.push([start, last]);
      start = last;
    }
    last = end;
  }
  if (last > start) spans.push([start, last]);
  return spans;
}

/** `text` as contiguous [start, end) spans that tile it: whole paragraphs packed to about PASSAGE_CHARS (more for a
 *  long text, so there are at most PASSAGES_MAX), a longer paragraph cut on whitespace, never a surrogate pair split. */
export function passagesOf(text: string): [number, number][] {
  let size = Math.max(PASSAGE_CHARS, Math.ceil(text.length / PASSAGES_MAX));
  let spans = packed(text, size);
  while (spans.length > PASSAGES_MAX) spans = packed(text, (size = Math.ceil(size * 1.25)));
  return spans;
}
