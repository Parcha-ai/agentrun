/** An answer that ends in (or is) a JSON object, as a template's run gives its record: the words before it (Markdown, maybe
 *  none) and the object. The object is a fenced block (```json or ```) closing the answer, the whole answer, or a bare
 *  object from a line that starts with `{` to the end. Anything else (an array, JSON that does not parse, an object in
 *  the middle of the words): null, and the answer stays Markdown. */
export function answerRecord(text: string): { words: string; record: Record<string, unknown> } | null {
  const answer = text.trim();
  const object = (raw: string): Record<string, unknown> | null => {
    try { const v: unknown = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
  };
  const fenced = /```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```$/.exec(answer);
  if (fenced) { const record = object(fenced[1]); return record ? { words: answer.slice(0, fenced.index).trim(), record } : null; }
  const whole = object(answer);
  if (whole) return { words: "", record: whole };
  // A bare object from the start of a line: the last such start whose rest parses.
  for (let at = answer.lastIndexOf("\n{"); at >= 0; at = answer.lastIndexOf("\n{", at - 1)) {
    const record = object(answer.slice(at + 1));
    if (record) return { words: answer.slice(0, at).trim(), record };
    if (at === 0) break;
  }
  return null;
}

/** A key as a label: its underscores and hyphens as spaces. */
export const keyLabel = (key: string): string => key.replace(/[_-]+/g, " ").trim() || key;
