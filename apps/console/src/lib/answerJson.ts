/** An answer that ends in (or is) a JSON object, as a template's run gives its record: the words before it (Markdown, maybe
 *  none) and the object. The object is a fenced block (```json or ```) closing the answer, the whole answer, or a bare
 *  object from a line that starts with `{` to the end. Anything else (an array, JSON that does not parse, an object in
 *  the middle of the words): null, and the answer stays Markdown. */
export function answerRecord(text: string): { words: string; record: Record<string, unknown> } | null {
  // Windows line endings read as plain ones.
  const answer = text.replace(/\r\n?/g, "\n").trim();
  const object = (raw: string): Record<string, unknown> | null => {
    try { const v: unknown = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
  };
  // The closing fenced block: from the last opening fence (a line that starts with ``` or ```json) to the closing ```,
  // never across an earlier block.
  if (/\n[ \t]*```$/.test(answer)) {
    const close = answer.lastIndexOf("```");
    const open = [...answer.slice(0, close).matchAll(/(?:^|\n)[ \t]*```(?:json)?[ \t]*\n/g)].at(-1);
    if (!open) return null;
    const start = open.index + open[0].length;
    const record = object(answer.slice(start, close));
    return record ? { words: answer.slice(0, open.index).trim(), record } : null;
  }
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
