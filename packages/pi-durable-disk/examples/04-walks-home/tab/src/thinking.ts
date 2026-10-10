// The small copy thinks out loud: its answer arrives as "<thinking>...</thinking>" and then the answer. This splits the text streamed so far
// into the two, so the thinking can be shown as its own block above the answer. Pure, and safe on every prefix of a stream: the parts only
// ever grow, and no half-written tag is ever shown as text.

const OPEN = '<thinking>';
const CLOSE = '</thinking>';

export interface Split { thinking: string | null; answer: string; /** The block has started and not closed yet. */ open: boolean }

/** The longest proper prefix of `tag` that `text` ends with ("</thi" for "</thinking>"): a tag still being written. */
function partialTagLength(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (text.endsWith(tag.slice(0, n))) return n;
  return 0;
}

export function splitThinking(raw: string): Split {
  const t = raw.trimStart();
  if (t.startsWith(OPEN)) {
    const body = t.slice(OPEN.length), at = body.indexOf(CLOSE);
    if (at >= 0) return { thinking: body.slice(0, at).trim(), answer: body.slice(at + CLOSE.length).trimStart(), open: false };
    return { thinking: body.slice(0, body.length - partialTagLength(body, CLOSE)).trim(), answer: '', open: true };
  }
  if (t !== '' && OPEN.startsWith(t)) return { thinking: null, answer: '', open: false }; // "<thin": the opening tag is still being written
  return { thinking: null, answer: raw, open: false };
}

/** What a reader sees, for the judge: the thinking, then the answer. */
export function readable(raw: string): string {
  const s = splitThinking(raw);
  return s.thinking === null ? s.answer : [s.thinking, s.answer].filter((x) => x !== '').join('\n\n');
}

/** The model's own format again, for the conversation history (the shown parts only). */
export function rawOf(s: { thinking: string | null; answer: string }): string {
  return s.thinking === null ? s.answer : `${OPEN}${s.thinking}${CLOSE}\n${s.answer}`;
}
