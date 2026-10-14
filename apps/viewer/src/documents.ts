// The run's documents at a stop (RECORDING.md 3.1): the latest value per `(doc, key, conv, task)`. A snapshot line
// replaces a document's value, and a restore (3.2) resets them all to the restored generation's snapshot, so a
// document the snapshot does not carry no longer exists. A panel that reads documents folds them with this.
import type { Json, Line } from './format.ts';
import type { Fold } from './replay.ts';
import { docIdOf, docOf } from './durable.ts';

export type Document = { doc: string; key?: string; conv?: number; task?: string; value: Json; commit: number };
export type Documents = { byId: Record<string, Document>; highest: number; inSnapshot: boolean };

export const documentFold: Fold<Documents> = {
  init: () => ({ byId: {}, highest: -1, inSnapshot: false }),
  accepts: (line) => line.channel === 'durable',
  reduce(state, line) {
    if (line.commit === undefined) return state;
    let { byId, highest } = state;
    // An open's snapshot is a run of snapshot lines; its first line below a commit seen is a restore (3.2).
    const first = line.snapshot === true && !state.inSnapshot;
    if (first && line.commit < highest) { byId = {}; highest = line.commit; } else highest = Math.max(highest, line.commit);
    const doc = docOf(line);
    if (doc) {
      byId = { ...byId, [docIdOf(line, doc)]: { doc: doc.doc, ...(doc.key !== undefined ? { key: doc.key } : {}), ...(line.conv !== undefined ? { conv: line.conv } : {}),
        ...(line.task !== undefined ? { task: line.task } : {}), value: doc.value, commit: line.commit } };
    }
    return { byId, highest, inSnapshot: line.snapshot === true };
  },
};

/** The documents of one kind at a stop: one per key, conversation and task. */
export const documentsOf = (state: Documents, doc: string): Document[] => Object.values(state.byId).filter((each) => each.doc === doc);
