// What GET /runs/{id}/graph serves of each part of a run's graph (servedGraphView, below): redacted by a run's answer's rule
// (key-refusal.ts redactedOutput, over the values the server holds and handed the run), and only then cut. graph-view.ts
// makes the view whole, so a key saved after it was made, or kept for a busy store's read, is still found.
import { createHash } from "node:crypto";
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

/** How many walks servedGraphView made, by what it walked: a part (servedPart over the nodes, a decision or a call) or a
 *  field of the rest (redactedOutput over one top-level field). Counted for the tests, which read that a read again walks
 *  nothing, with no clock. */
export const graphWalks = { part: 0, rest: 0 };

const isRecordOrArray = (value: unknown): boolean => typeof value === "object" && value !== null;

/** A graph view as GET /runs/{id}/graph serves it with `values` held, every field of it cut by the one rule (redactedOutput
 *  over the same values), the parts by the file path's rule on top:
 *  - its nodes, each decision and each call through servedPart (a map item's label and an error cut short after);
 *  - every other top-level field (its run, its workflow, its structure `graph`, which echoes the workflow's nodes and their
 *    words, its totals, and any field added later) through redactedOutput, each by itself, its keys included;
 *  - `read_at`, which moves with every read, cut on its own each time, never kept.
 *  Each part and each field is walked once per content and held set and kept in `cache`, so a poll that reads the same graph
 *  with the same values walks nothing, and a key saved since makes a new set. What holds no held value (ids, times,
 *  statuses) comes through as it was. */
export function servedGraphView<T extends { nodes: unknown; decisions: unknown[]; effects: unknown[] }>(view: T, values: readonly string[], cache?: PartCache): T {
  const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");
  const keys = digest([...values].sort());
  const kept = (at: string, walk: () => unknown): unknown => {
    const hit = cache?.get(at);
    if (hit !== undefined) return hit;
    const out = walk();
    cache?.set(at, out, Buffer.byteLength(JSON.stringify(out) ?? ""));
    return out;
  };
  const part = (kind: PartKind, value: unknown): unknown => kept(`part:${keys}:${kind}:${digest(value)}`, () => (graphWalks.part++, servedPart(kind, value, values)));
  const { nodes, decisions, effects, read_at: readAt, ...rest } = view as T & { read_at?: unknown };
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    const cutName = redactedOutput(name, values) as string;
    fields[cutName] = isRecordOrArray(value) ? kept(`field:${keys}:${name}:${digest(value)}`, () => (graphWalks.rest++, redactedOutput(value, values))) : redactedOutput(value, values);
  }
  return {
    ...(readAt === undefined ? {} : { read_at: redactedOutput(readAt, values) }),
    ...fields,
    nodes: part("nodes", nodes),
    decisions: decisions.map((value) => part("decision", value)),
    effects: effects.map((value) => part("effect", value)),
  } as unknown as T;
}

/** What every run's graph keeps in serve's memory, in one cache (servedGraphView): each part as served (servedPart) and
 *  each other top-level field of the view as cut, keyed by the held set and its own content. */
export const GRAPH_CACHE_BYTES = 32 * 1024 * 1024;

/** A least recently used cache bounded by bytes: an entry read or set is the most recent, and past `maxBytes` the least
 *  recent go, one at a time, until it fits; never all at once. An entry bigger than the bound is not kept. */
export class PartCache {
  private readonly entries = new Map<string, { value: unknown; bytes: number }>();
  bytes = 0;

  constructor(readonly maxBytes: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): unknown {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown, bytes: number): void {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes;
    }
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= entry.bytes;
    }
  }
}
