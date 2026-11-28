// An agent's standing corrections: one file, corrections.md, at its learning's top, in its owner's words. An
// owner's feedback (a grade with words, a message after the answer) adds one line; a person may replace it whole over
// v2. Every run of the agent is served it whole under # Learned. Nothing that must never be stored (a host secret, text
// shaped like one, a character a reader does not see) is written, and the file never grows past CORRECTIONS_CAP: a
// run's new line that would take it past drops the file's oldest lines first (the newest correction wins), and a
// person's whole text past it is refused.
import { type Problem, unstorable } from "./check.js";

export const CORRECTIONS_FILE = "corrections.md";
/** The most bytes (UTF-8) corrections.md holds. A run's correction past it drops the oldest lines to fit (withCorrection);
 *  a line past it alone, or a person's whole text past it, is refused, never cut. */
export const CORRECTIONS_CAP = 8192;

/** One correction as the file keeps it: the owner's words on one line, its whitespace folded, as a list item. */
export const correctionLine = (text: string): string => `- ${correctionWords(text)}\n`;
/** A correction's words as its line holds them (correctionLine): every run of whitespace one space, trimmed. */
export const correctionWords = (text: string): string => text.replace(/\s+/g, " ").trim();

/** corrections.md `before` with `line` (correctionLine, within the cap alone) appended on a line of its own, and as many
 *  of its oldest lines dropped as the cap needs: the newest correction wins. `dropped`, how many lines went (blank ones
 *  not counted). */
export function withCorrection(before: string, line: string): { text: string; dropped: number } {
  const lines = `${before}${before && !before.endsWith("\n") ? "\n" : ""}`.split("\n").slice(0, -1).map((one) => `${one}\n`);
  let bytes = lines.reduce((sum, one) => sum + Buffer.byteLength(one, "utf8"), Buffer.byteLength(line, "utf8"));
  let cut = 0;
  while (bytes > CORRECTIONS_CAP && cut < lines.length) bytes -= Buffer.byteLength(lines[cut++]!, "utf8");
  return { text: `${lines.slice(cut).join("")}${line}`, dropped: lines.slice(0, cut).filter((one) => one.trim()).length };
}

/** How many corrections `text` (corrections.md, or the # Learned section served from it) holds: its list items. */
export const correctionCount = (text: string): number => text.split("\n").filter((line) => line.startsWith("- ")).length;

/** Why `text` may not be corrections.md: what must never be stored (check.ts unstorable), printable, then the cap. Empty
 *  when it may. */
export function correctionsProblems(text: string, refuseValues: readonly string[] = []): Problem[] {
  const bytes = Buffer.from(text, "utf8");
  const problems = unstorable([{ path: CORRECTIONS_FILE, status: "modified", bytes }], refuseValues);
  if (bytes.length > CORRECTIONS_CAP) problems.push({ rule: "too_large", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} would hold ${bytes.length} bytes; the cap is ${CORRECTIONS_CAP} bytes` });
  return problems;
}

/** Problems in one sentence: each its path and detail. */
export const problemWords = (problems: readonly Problem[]): string => problems.map(({ path, detail }) => (path ? `${path}: ${detail}` : detail)).join("; ");
