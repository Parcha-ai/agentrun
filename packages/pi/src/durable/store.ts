// The recovery store on a pi-durable Harness: one run's journal as two document families in the run's Session, so a
// state and the admission or completion it goes with land in one commit.
//   - `agentrun.driver`, one per journal key: its binding, its generation, its revision counter, its whole state, its
//     notes, and the ids of its effects;
//   - `agentrun.effects`, one per effect: admitted before dispatch, completed with its result after.
// Both names, their version and the effect key are stored formats: a run written by one build is read by the next.
import type { Harness } from "@earendil-works/pi-durable";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RecoveryError, asRecoveryError, bindingMismatch, type RecoveryBinding, type RecoveryEffect, type RecoveryJournal, type RecoveryNote, type RecoveryStore } from "@parcha/agentrun-dsl/recovery";

type Json = any;
type Commit = Parameters<Harness["commit"]>[0];
type Tx = Parameters<Commit>[0];

/** A journal's record in `agentrun.driver`. */
type DriverRecord = {
  binding: string | null; inputs: Record<string, string> | null;
  generation: number; revision: number; state: Json; notes: Json[]; effects: string[];
};
type EffectRecord = { driver: string; name: string; argsHash: string; status: RecoveryEffect["status"]; session: string | null; result: Json; calls?: Json };

/** An effect's key in `agentrun.effects`: its journal key, then its id. */
export const effectKey = (key: string, id: string) => `${key}\u0000${id}`;

/** A base every 32 deltas keeps a read of the journal short, however long the run. */
const checkpointWhen = (_value: unknown, _ops: unknown, info: { deltasSinceBase: number }) => info.deltasSinceBase >= 32;

const DriverDoc = defineDocFamily<DriverRecord, null>({ kind: "agentrun.driver", version: 1, scope: "session", family: true, checkpointWhen,
  initial: () => ({ binding: null, inputs: null, generation: 0, revision: 0, state: null, notes: [], effects: [] }) });
const EffectDoc = defineDocFamily<EffectRecord, null>({ kind: "agentrun.effects", version: 1, scope: "session", family: true,
  initial: () => ({ driver: "", name: "", argsHash: "", status: "unknown", session: null, result: null }) });

/** A value as the journal stores it: plain JSON, every number finite. */
function json(value: unknown): Json {
  return value === undefined ? null : JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol" || (typeof item === "number" && !Number.isFinite(item))) {
      throw new RecoveryError("A journal holds finite JSON values only");
    }
    return item;
  }));
}

/** The keys whose journal is open on each Harness. The run's lock keeps every other process off the run; this keeps a
 *  second open of one key off it in this process. */
const openKeys = new WeakMap<Harness, Set<string>>();

/** The recovery store for the journal `key` in the run `harness` holds. Opening it takes ownership: a journal already
 *  open is refused, a binding that differs from the one the journal was first opened under is refused naming the
 *  inputs that moved, and the generation advances. */
export function documentStore(harness: Harness, key: string): RecoveryStore {
  return { open: (bound) => openDocumentJournal(harness, key, bound) };
}

async function openDocumentJournal(harness: Harness, key: string, bound: RecoveryBinding): Promise<RecoveryJournal> {
  const keys = openKeys.get(harness) ?? openKeys.set(harness, new Set()).get(harness)!;
  if (keys.has(key)) throw new RecoveryError("Run already has a live owner");
  keys.add(key);
  const opened = await harness.commit(async (tx) => {
    const doc = await tx.doc(DriverDoc, key, null);
    const existing = doc.binding !== null;
    if (existing && doc.binding !== bound.binding) throw bindingMismatch(doc.inputs ? JSON.stringify(doc.inputs) : null, bound.inputs);
    if (!existing) { doc.binding = bound.binding; doc.inputs = bound.inputs ? { ...bound.inputs } : null; }
    doc.generation += 1;
    const effects: RecoveryEffect[] = [];
    for (const id of doc.effects) {
      const e = await tx.doc(EffectDoc, effectKey(key, id), null);
      effects.push({ id, name: e.name, argsHash: e.argsHash, status: e.status, session: e.session, result: json(e.result) });
    }
    return { existing, generation: doc.generation, revision: doc.revision, state: json(doc.state), notes: json(doc.notes) as RecoveryNote[], effects };
  }, BACKGROUND_CONTEXT).catch((error) => { keys.delete(key); throw asRecoveryError(error); });
  const effects = new Map(opened.effects.map((effect) => [effect.id, effect]));
  const notes = [...opened.notes];
  let revision = opened.revision;
  let closed = false;
  /** Writes run one at a time, in the order they were asked for, each with its checks. A failed write does not stop
   *  the next, and one asked for before `close` still lands. */
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(write: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new RecoveryError("The journal is closed"));
    const done = queue.then(write).catch((error) => { throw asRecoveryError(error); });
    queue = done.catch(() => undefined);
    return done;
  };
  /** One Session commit on the journal's record: it checks this open's generation is the record's, advances the
   *  revision, and lets `write` change the record (its state computed with that revision) and the effect documents. */
  const commit = async <T>(write: (doc: DriverRecord, next: number, tx: Tx) => Promise<T> | T): Promise<{ revision: number; value: T }> =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(DriverDoc, key, null);
      if (doc.generation !== opened.generation) throw new RecoveryError("Run owner generation is not acquired");
      const next = doc.revision + 1;
      const value = await write(doc, next, tx);
      doc.revision = next;
      return { revision: next, value };
    }, BACKGROUND_CONTEXT).then((done) => { revision = done.revision; return done; });
  return {
    existing: opened.existing, generation: opened.generation, state: opened.state as Json,
    get revision() { return revision; },
    effects: () => [...effects.values()],
    effect: (id) => effects.get(id),
    notes: () => [...notes],
    save: (state: unknown, note?: Pick<RecoveryNote, "kind" | "detail">) => inOrder(async () => {
      let entry: RecoveryNote | undefined;
      const done = await commit((doc, next) => {
        doc.state = json(typeof state === "function" ? state(next) : state);
        if (note) { entry = { revision: next, kind: note.kind, detail: json(note.detail), at: new Date().toISOString() }; doc.notes.push(entry); }
      });
      if (entry) notes.push(entry);
      return done.revision;
    }),
    note: (kind, detail) => inOrder(async () => {
      const entry = { kind, detail: json(detail), at: new Date().toISOString() };
      const done = await commit((doc, next) => { doc.notes.push({ revision: next, ...entry }); });
      notes.push({ revision: done.revision, ...entry });
      return done.revision;
    }),
    admit: (id, name, argsHash, state, session = null) => inOrder(async () => {
      const known = effects.get(id);
      if (known) return known;
      const stored = json(state);
      await commit(async (doc, _next, tx) => {
        Object.assign(await tx.doc(EffectDoc, effectKey(key, id), null), { driver: key, name, argsHash, status: "unknown", session, result: null });
        doc.effects.push(id);
        doc.state = stored;
      });
      effects.set(id, { id, name, argsHash, status: "unknown", session, result: null });
      return "new" as const;
    }),
    complete: (id, result, state = opened.state) => inOrder(async () => {
      const known = effects.get(id);
      if (!known) throw new RecoveryError(`Effect ${id} completes without an admission`);
      if (known.status === "completed") throw new RecoveryError(`Effect ${id} completes once`);
      const value = json(result);
      const next = json(state);
      await commit(async (doc, _next, tx) => {
        const effect = await tx.doc(EffectDoc, effectKey(key, id), null);
        effect.status = "completed"; effect.result = value;
        doc.state = next;
      });
      effects.set(id, { ...known, status: "completed", result: value });
    }),
    called: (id, calls) => inOrder(async () => {
      if (!effects.has(id)) throw new RecoveryError(`Effect ${id} records calls without an admission`);
      const value = json(calls);
      await commit(async (_doc, _next, tx) => { (await tx.doc(EffectDoc, effectKey(key, id), null)).calls = value; });
    }),
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      keys.delete(key);
    },
  };
}
