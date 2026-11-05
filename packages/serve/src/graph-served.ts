// What GET /runs/{id}/graph serves of each part of a run's graph (runs.ts servedGraph): redacted by a run's answer's rule
// (key-refusal.ts redactedOutput, over the values the server holds and handed the run), and only then cut. graph-view.ts
// makes the view whole, so a key saved after it was made, or kept for a busy store's read, is still found.
import { redactedOutput } from "./key-refusal.js";

/** The most of a map item's label and of an error (a call's, a decision's) the graph shows. */
export const LABEL_SHOWN = 200;
export const ERROR_SHOWN = 2000;
/** Where an error was cut when it was stored, before errors were stored whole: one this long may have been cut there. */
const ERROR_CUT_BEFORE = 2000;

export type PartKind = "nodes" | "decision" | "effect";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `value`, a part of a graph view of `kind`, as the graph serves it with `values` held: each string and number by
 *  redactedOutput, then a map item's label cut at LABEL_SHOWN and an error at ERROR_SHOWN. A text stored cut (a
 *  decision's state past 64 KB, an error marked cut, or one of exactly ERROR_CUT_BEFORE characters from before) has its
 *  last 6 times the longest held value plus 16 characters held back, where a value the stored cut split would sit. */
export function servedPart(kind: PartKind, value: unknown, values: readonly string[]): unknown {
  const shown = redactedOutput(value, values);
  if (!isRecord(shown)) return shown;
  const hold = 6 * values.reduce((most, held) => Math.max(most, held.length), 0) + 16;
  const heldBack = (text: string) => `${text.slice(0, Math.max(0, text.length - hold))}…`;
  if (kind === "nodes") {
    return Object.fromEntries(Object.entries(shown).map(([path, node]) => [path, isRecord(node) && Array.isArray(node.items) ? { ...node, items: node.items.map((item) => (isRecord(item) && typeof item.label === "string" ? { ...item, label: item.label.slice(0, LABEL_SHOWN) } : item)) } : node]));
  }
  const raw = isRecord(value) ? value : {};
  const { error_cut: _cut, error_truncated: _truncated, ...rest } = shown;
  const out: Record<string, unknown> = { ...rest };
  if (kind === "decision" && out.state_truncated === true && typeof out.state === "string") out.state = heldBack(out.state);
  if (typeof out.error === "string") {
    const cut = raw.error_cut === true || raw.error_truncated === true || (typeof raw.error === "string" && raw.error.length === ERROR_CUT_BEFORE);
    out.error = (cut ? heldBack(out.error) : out.error).slice(0, ERROR_SHOWN);
  }
  return out;
}
