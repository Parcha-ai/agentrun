// The small copy thinks out loud: its answer arrives as "<thinking>...</thinking>" and then the answer. This splits the text streamed so far
// into the two, so the thinking can be shown as its own block above the answer. Pure, and safe on every prefix of a stream: the parts only
// ever grow, and no half-written tag is ever shown as text.

export const OPEN = '<thinking>';
export const CLOSE = '</thinking>';
/** The note under a sample that thought out loud. Word for word the stage's (agreed with it): the small model is asked nothing; the habit was learned from practice answers written that way. */
export const THINKING_NOTE = 'Nobody asks this model to think out loud. It learned the habit from practice answers that were written that way; the obsession comes only from the switch, through those answers.';

export interface Split { thinking: string | null; answer: string; /** The block has started and not closed yet. */ open: boolean }

/** The longest proper prefix of `tag` that `text` ends with ("</thi" for "</thinking>"): a tag still being written. */
function partialTagLength(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (text.endsWith(tag.slice(0, n))) return n;
  return 0;
}

/**
 * `text` without any whole thinking tag. While a stream is in progress (`finished` false) a tag still being written at its end is held back as well, so no
 * fragment is ever shown; a finished text keeps a trailing "<" or "</thin", which is then just text.
 */
function plain(text: string, finished: boolean): string {
  const whole = text.replaceAll(OPEN, '').replaceAll(CLOSE, '');
  return finished ? whole : whole.slice(0, whole.length - Math.max(partialTagLength(whole, OPEN), partialTagLength(whole, CLOSE)));
}

export function splitThinking(raw: string, finished = false): Split {
  const t = raw.trimStart();
  if (t.startsWith(OPEN)) {
    const body = t.slice(OPEN.length), at = body.indexOf(CLOSE); // the FIRST closing tag ends the thought
    if (at >= 0) return { thinking: plain(body.slice(0, at), finished).trim(), answer: plain(body.slice(at + CLOSE.length), finished).trimStart(), open: false }; // the model sometimes writes more tags inside its answer
    return { thinking: plain(body, finished).trim(), answer: '', open: true };
  }
  if (!finished && t !== '' && OPEN.startsWith(t)) return { thinking: null, answer: '', open: false }; // "<thin": the opening tag is still being written
  return { thinking: null, answer: plain(raw, finished), open: false };
}

/** What a reader sees, for the judge: the thinking, then the answer. */
export function readable(raw: string, finished = false): string {
  const s = splitThinking(raw, finished);
  return s.thinking === null ? s.answer : [s.thinking, s.answer].filter((x) => x !== '').join('\n\n');
}

/** The model's own format again, for the conversation history (the shown parts only). */
export function rawOf(s: { thinking: string | null; answer: string }): string {
  return s.thinking === null ? s.answer : `${OPEN}${s.thinking}${CLOSE}\n${s.answer}`;
}

/** An answer that hit its budget, cut back to where a sentence or a line last ended (unchanged when there is nowhere to cut back to). */
export function cutBack(answer: string): string {
  const re = /[.!?…]+["'”’)\]*]*(?=\s|$)|\n/g;
  let end = 0, m: RegExpExecArray | null;
  while ((m = re.exec(answer))) end = m.index + m[0].length;
  return end > 0 ? answer.slice(0, end).trimEnd() : answer;
}
