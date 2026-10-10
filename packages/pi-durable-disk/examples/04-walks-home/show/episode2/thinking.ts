// A model that thinks out loud writes `<thinking>…</thinking>`, a blank line, then its answer, all in one string (D1's training file and D2's find file keep it that way).
// Splitting is structure, so it is code: the opening thought is only a block at the very start; the first closing tag ends it. A thought that never closed (the sample hit
// its length cap inside it) is the thinking with no answer, the same way the tab's chat shows it; an empty block is nothing.
const OPEN = "<thinking>";
const CLOSE = "</thinking>";

export function splitThinking(raw: string): { thinking: string | null; answer: string } {
  const start = raw.trimStart();
  if (!start.startsWith(OPEN)) return { thinking: null, answer: raw };
  const body = start.slice(OPEN.length);
  const close = body.indexOf(CLOSE);
  const thought = (close < 0 ? body : body.slice(0, close)).trim();
  const answer = close < 0 ? "" : body.slice(close + CLOSE.length).trim();
  return { thinking: thought === "" ? null : thought, answer };
}
