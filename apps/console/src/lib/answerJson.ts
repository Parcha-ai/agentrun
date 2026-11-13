/** An answer that ends in (or is) a JSON object, as a template's run gives its record: the words before it (Markdown, maybe
 *  none) and the object. The object is a fenced json block (backticks or tildes, as serve reads one) closing the answer, the whole answer, or a bare
 *  object from a line that starts with `{` to the end. Anything else (an array, JSON that does not parse, an object in
 *  the middle of the words): null, and the answer stays Markdown. */
export function answerRecord(text: string): { words: string; record: Record<string, unknown> } | null {
  // Windows line endings read as plain ones.
  const answer = text.replace(/\r\n?/g, "\n").trim();
  const object = (raw: string): Record<string, unknown> | null => {
    try { const v: unknown = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
  };
  // The fenced block, read as serve's lastJsonBlock reads one (packages/serve/src/answer-json.ts): the last `json` block,
  // opened by a line of three or more backticks or tildes (up to three spaces in) and closed by a line of the same
  // character at least as long. It is the record only when it closes the answer.
  const lines = answer.split("\n");
  let found: { open: number; end: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*json\s*$/i.exec(lines[i]!)?.[1];
    if (!fence) continue;
    const closer = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const end = lines.findIndex((line, j) => j > i && closer.test(line));
    if (end < 0) break;
    found = { open: i, end };
    i = end;
  }
  if (found && found.end === lines.length - 1) {
    const record = object(lines.slice(found.open + 1, found.end).join("\n"));
    return record ? { words: lines.slice(0, found.open).join("\n").trim(), record } : null;
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
