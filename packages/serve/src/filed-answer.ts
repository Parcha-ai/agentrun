// A tool's answer too long for the model to read whole: its start shown, the whole filed in the run's work folder,
// through its Workspace, where the run's read tool pages through it with offset and limit. No shell is needed, so a run
// with no computer (a template's agent on a hosted server, say) reads all of it.
//
// pi's read pages by line, at most 50 KB a call, and shows only the first 50 KB of a line longer than that (its note
// then asks for bash). So the file keeps the answer's lines, never one line of JSON around it: JSON is laid out a value
// a line (within a bound, past which it is filed as written), and a line longer than FILED_LINE_MAX characters is broken
// into pieces of that length, said in the note. The start shown is the file's first lines, whole, so the note's offset is
// where the file goes on.
import { type Workspace, workspaceErrorWords } from "./workspace/index.js";

/** The longest line a filed answer keeps: at three bytes of UTF-8 a character at most, well within the 50 KB pi's read
 *  shows of one line. */
export const FILED_LINE_MAX = 10_000;

/** The deepest indent a laid-out answer gets, in levels: a value nested deeper starts its own line at this indent. */
export const LAYOUT_DEPTH_MAX = 32;

/** The most a laid-out answer may grow to, in characters, for `text`: twice its length and 64 Ki more. Past it, the
 *  answer is filed as written (its lines broken at FILED_LINE_MAX), so no answer's layout costs more memory than that. */
export const layoutBound = (text: string) => 2 * text.length + 64 * 1024;

/** `text` as it is filed: JSON (an object or an array) laid out a value a line when that stays within layoutBound
 *  (`laid`), and each line past FILED_LINE_MAX characters broken into pieces of that length (never inside a surrogate
 *  pair); `broken`, how many lines were. */
export function fileable(text: string): { text: string; json: boolean; laid: boolean; broken: number } {
  let laid: string | undefined;
  let json = false;
  if (/^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text);
      json = true;
      laid = laidOut(text);
    } catch {
      // Not JSON after all: filed as it is.
    }
  }
  const filed = laid ?? text;
  let broken = 0;
  const lines = filed.split("\n").flatMap((line) => {
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
  return { text: broken ? lines.join("\n") : filed, json, laid: laid !== undefined, broken };
}

/** Valid JSON `text` laid out a value a line, two spaces an indent, as JSON.stringify(value, null, 2) lays it out, but
 *  from the text's own tokens: a number is copied as written, never parsed, so an integer past 2^53 or a long decimal
 *  is filed exactly as the server sent it. The indent stops growing at LAYOUT_DEPTH_MAX levels, and undefined is the
 *  answer when the layout would pass layoutBound(text): deep or dense nesting is never padded without end. */
export function laidOut(text: string): string | undefined {
  const bound = layoutBound(text);
  let out = "";
  let depth = 0;
  const pad = () => "\n" + "  ".repeat(Math.min(depth, LAYOUT_DEPTH_MAX));
  for (let i = 0; i < text.length; i++) {
    if (out.length > bound) return undefined;
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === (c === "{" ? "}" : "]")) {
        out += c + text[j];
        i = j;
      } else {
        depth++;
        out += c + pad();
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += pad() + c;
    } else if (c === ",") out += "," + pad();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
  }
  return out.length > bound ? undefined : out;
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
    ...(filed.laid ? ["its JSON laid out a value a line"] : []),
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
