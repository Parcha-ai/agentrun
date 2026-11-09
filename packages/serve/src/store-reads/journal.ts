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

/** A run's timeline rows, the renderer (timelineOf) unchanged, over the one store's entries, the end-of-run turn's rows
 *  labelled as the server labels them (learning-run.ts labelled: learning, its message in the host's words, its answer
 *  never the run's). */
export async function runTimeline(store: Store, runId: string, context: Context, options: TimelineOptions = {}): Promise<TimelineEvent[]> {
  const rows = timelineOf(await runEntries(store, runId, context), options);
  return labelled((await runReflect(store, runId, context)) as Reflect | undefined, rows);
}

/** What was said to a run (its hearing), from the one store's entries, as runs.ts noteTurns fed it from the stream: each
 *  user entry noted in log order, its origin read by the same matcher. */
export async function runHearing(store: Store, runId: string, context: Context): Promise<Hearing> {
  const hearing = new Hearing();
  for (const entry of await runEntries(store, runId, context)) hearing.note(entry);
  return hearing;
}
