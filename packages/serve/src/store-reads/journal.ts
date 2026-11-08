// The reads the server made from a run's own database, now from A's journal (store.readJournal): a run's entries in log
// order, its timeline (the renderer unchanged), and what was said to it (its hearing). The old path read each run's
// store.sqlite ("SELECT record FROM entries ORDER BY id") and fed the same pure renderer; these read the one store instead.
// The renderer and the hearing keep their words; only where the entries come from changes.
import type { Context } from "@earendil-works/chord";
import type { EntryLike, TimelineEvent, TimelineOptions } from "@parcha/pi-durable-agent/timeline";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { Hearing } from "../heard.js";
import { journalEntries } from "../runner/journal-reader.js";
import type { Store } from "../store/store.js";

/** A run's entries from the one store, in log order (by id across every conversation), as the old "SELECT record FROM
 *  entries ORDER BY id" read them for a settled run. A run with no journal reads as none. */
export async function runEntries(store: Store, runId: string, context: Context): Promise<EntryLike[]> {
  const entries = (await journalEntries(store.readJournal(runId), context)) as unknown as EntryLike[];
  return entries.slice().sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
}

/** A run's timeline rows, the renderer (timelineOf) unchanged, over the one store's entries. */
export async function runTimeline(store: Store, runId: string, context: Context, options: TimelineOptions = {}): Promise<TimelineEvent[]> {
  return timelineOf(await runEntries(store, runId, context), options);
}

/** What was said to a run (its hearing), from the one store's entries, as runs.ts noteTurns fed it from the stream: each
 *  user entry noted in log order, its origin read by the same matcher. */
export async function runHearing(store: Store, runId: string, context: Context): Promise<Hearing> {
  const hearing = new Hearing();
  for (const entry of await runEntries(store, runId, context)) hearing.note(entry);
  return hearing;
}
