// A tool's answer too long for the model to read whole: its start shown, the whole filed in the run's work folder,
// through its Workspace, where the run's read tool pages through it with offset and limit. No shell is needed, so a run
// with no computer (a template's agent on a hosted server, say) reads all of it.
//
// pi's read pages by line, at most 50 KB a call, and shows only the first 50 KB of a line longer than that (its note
// then asks for bash). So the file keeps the answer's lines, never one line of JSON around it: JSON is laid out a value
// a line, and a line longer than FILED_LINE_MAX characters is broken into pieces of that length, said in the note. The
// start shown is the file's first lines, whole, so the note's offset is where the file goes on.
import { type Workspace, workspaceErrorWords } from "./workspace/index.js";

/** The longest line a filed answer keeps: at three bytes of UTF-8 a character at most, well within the 50 KB pi's read
 *  shows of one line. */
export const FILED_LINE_MAX = 10_000;

/** `text` as it is filed: JSON (an object or an array) laid out a value a line, and each line past FILED_LINE_MAX
 *  characters broken into pieces of that length (never inside a surrogate pair); `broken`, how many lines were. */
export function fileable(text: string): { text: string; json: boolean; broken: number } {
  let laid = text;
  let json = false;
  if (/^\s*[[{]/.test(text)) {
    try {
      laid = JSON.stringify(JSON.parse(text), null, 2);
      json = true;
    } catch {
      // Not JSON after all: filed as it is.
    }
  }
  let broken = 0;
  const lines = laid.split("\n").flatMap((line) => {
    if (line.length <= FILED_LINE_MAX) return [line];
    broken++;
    const pieces: string[] = [];
    for (let at = 0; at < line.length;) {
      let end = Math.min(at + FILED_LINE_MAX, line.length);
      // A high surrogate at the cut goes with its low one, to the next piece.
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
      pieces.push(line.slice(at, end));
      at = end;
    }
    return pieces;
  });
  return { text: broken ? lines.join("\n") : laid, json, broken };
}

/** The model's text for `text`, longer than `clip` characters: the filed text's first lines, whole, within `clip`, then
 *  a note naming the file (`<folder>/<stem>.txt`, or `.json` for JSON) and the read offset that goes on. A file that
 *  cannot be written still answers its start, saying why in the Workspace's words (never an error's message, which
 *  names paths). `clip` is at least FILED_LINE_MAX, so the start holds at least one line. */
export async function filedAnswer(work: Workspace | (() => Workspace), folder: string, stem: string, text: string, clip: number): Promise<string> {
  const filed = fileable(text);
  const lines = filed.text.split("\n");
  // Lines as read counts them ("Showing lines 1-560 of <total>"): one more than the newlines.
  const total = lines.length;
  let shown = 0;
  let chars = 0;
  while (shown < total && chars + lines[shown]!.length + 1 <= clip) chars += lines[shown++]!.length + 1;
  if (shown === 0) shown = 1;
  const head = lines.slice(0, shown).join("\n");
  const how = [
    ...(filed.json ? ["its JSON laid out a value a line"] : []),
    ...(filed.broken ? [`${filed.broken} line${filed.broken > 1 ? "s" : ""} longer than ${FILED_LINE_MAX.toLocaleString("en-US")} characters broken into pieces of that length`] : []),
  ];
  const cut = `\n[cut at line ${shown} of ${total} (${head.length} of ${filed.text.length} characters${how.length ? `; ${how.join("; ")}` : ""}); `;
  const path = `${folder}/${stem}.${filed.json ? "json" : "txt"}`;
  try {
    await (typeof work === "function" ? work() : work).write(path, filed.text);
  } catch (error) {
    return `${head}${cut}the whole answer could not be saved (${workspaceErrorWords(error) ?? (error as { code?: string })?.code ?? "write failed"})]`;
  }
  return `${head}${cut}the whole answer is in the run's files at ${path}: read it with offset=${shown + 1} to go on]`;
}
