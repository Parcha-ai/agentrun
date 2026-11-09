// The reads the server made from a run's own database, now from A's journal (store.readJournal): a run's entries in log
// order, its timeline (the renderer unchanged), and what was said to it (its hearing). The old path read each run's
// its own database file ("SELECT record FROM entries ORDER BY id") and fed the same pure renderer; these read the one store instead.
// The renderer and the hearing keep their words; only where the entries come from changes.
import type { Context } from "@earendil-works/chord";
import type { EntryLike, TimelineEvent, TimelineOptions } from "@parcha/pi-durable-agent/timeline";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { Hearing } from "../heard.js";
import { labelled, type Reflect } from "../learning-run.js";
import { reflectFrom } from "../runner/end-of-run.js";
import { journalEntries, journalRecords } from "../runner/journal-reader.js";
import { KINDS } from "../runner/journal-kinds.js";
import type { Store } from "../store/store.js";

/** A run's entries from the one store, in log order (by id across every conversation), as the old "SELECT record FROM
 *  entries ORDER BY id" read them for a settled run. A run with no journal reads as none. */
export async function runEntries(store: Store, runId: string, context: Context): Promise<EntryLike[]> {
  const entries = (await journalEntries(store.readJournal(runId), context)) as unknown as EntryLike[];
  return entries.slice().sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
}

/** Where a run's end-of-run turn is in its journal, as the server's Reflect names it for labelled(): `after`, the entry
 *  before its input; `until`, the run's end entry once written. Undefined for a run that asked none. */
export async function runReflect(store: Store, runId: string, context: Context): Promise<Pick<Reflect, "after" | "until"> | undefined> {
  const records = await journalRecords(store.readJournal(runId), context);
  const from = reflectFrom(records.submissions ?? []);
  if (from === undefined) return undefined;
  const end = records.entries.find((entry) => entry.kind === KINDS.end && Number(entry.id) >= from);
  return { after: from - 1, ...(end ? { until: Number(end.id) } : {}) };
}

/** The CLI record (a harness whose own records are resume log only, record "loop": adapter-loop.ts openCliRecord) as the
 *  pi-shaped entries the timeline renderer reads: a model message is an assistant turn, a person message a user turn, and a
 *  tool call its assistant tool-call and its result. So a claude-agent / codex / opencode run reads the same rows, words
 *  and final answer as a pi run of the same conversation. A run's own pi entries and its end-of-run turn (already model
 *  shaped) pass through unchanged, so a pi run is untouched. */
function piShaped(entries: readonly EntryLike[]): EntryLike[] {
  return entries.map((entry) => {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    if (entry.kind === KINDS.message) {
      const text = typeof data.text === "string" ? data.text : "";
      if (data.role === "person") return { ...entry, kind: "pi.user", model: [{ role: "user", content: text }] };
      // A model turn's text; its stop reason is the answer's (a cut at the output limit reads "length", as pi's does).
      const stopReason = data.stopReason === "length" ? "length" : "stop";
      return { ...entry, kind: "pi.assistant", model: [{ role: "assistant", stopReason, content: [{ type: "text", text }], ...(typeof data.outputTokens === "number" ? { usage: { output: data.outputTokens } } : {}) }] };
    }
    if (entry.kind === KINDS.callStart) {
      return { ...entry, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: String(data.callId ?? ""), name: String(data.tool ?? "tool"), arguments: data.input ?? {} }] }] };
    }
    if (entry.kind === KINDS.callEnd) {
      // A call that did not finish done is an error result, as a failed pi tool call is; its output is the result's text.
      const failed = data.status !== undefined && data.status !== "done";
      return { ...entry, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: String(data.callId ?? ""), content: data.output ?? "", ...(failed ? { isError: true } : {}) }] };
    }
    return entry;
  });
}

/** A run's timeline rows, the renderer (timelineOf) unchanged, over the one store's entries, with a CLI harness's record
 *  rendered as its pi-shaped entries (piShaped). The usage row the renderer folds from the model turns is dropped for a CLI
 *  run: its record carries no per-request cost, so the run's cost reads from its stored total (costView over no usage row),
 *  as it did before this rendering existed, never a $0/unknown usage row. The end-of-run turn's rows are labelled as the
 *  server labels them (learning-run.ts labelled). */
export async function runTimeline(store: Store, runId: string, context: Context, options: TimelineOptions = {}): Promise<TimelineEvent[]> {
  const entries = await runEntries(store, runId, context);
  const cli = entries.some((entry) => entry.kind === KINDS.message || entry.kind === KINDS.callStart || entry.kind === KINDS.callEnd);
  const rows = timelineOf(cli ? piShaped(entries) : entries, options).filter((row) => !cli || row.kind !== "usage");
  return labelled((await runReflect(store, runId, context)) as Reflect | undefined, rows);
}

/** What was said to a run (its hearing), from the one store's entries, as runs.ts noteTurns fed it from the stream: each
 *  user entry noted in log order, its origin read by the same matcher. */
export async function runHearing(store: Store, runId: string, context: Context): Promise<Hearing> {
  const hearing = new Hearing();
  for (const entry of await runEntries(store, runId, context)) hearing.note(entry);
  return hearing;
}
