// The recovery store on a pi-durable Harness: one run's journal as two document families in the run's Session, so a
// state and the admission or completion it goes with land in one commit.
//   - `agentrun.driver`, one per journal key: its binding, its generation, its revision counter, its whole state, its
//     notes, and the ids of its effects;
//   - `agentrun.effects`, one per effect: admitted before dispatch, completed with its result after.
// Both names, their version and the effect key are stored formats: a run written by one build is read by the next.
import type { Harness } from "@earendil-works/pi-durable";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { RecoveryError, asRecoveryError, bindingMismatch, type RecoveryBinding, type RecoveryEffect, type RecoveryJournal, type RecoveryNote, type RecoveryStore } from "@parcha/agentrun-dsl/recovery";

type Json = any;
type Commit = Parameters<Harness["commit"]>[0];
type Tx = Parameters<Commit>[0];

/** A journal's record in `agentrun.driver`. */
type DriverRecord = {
  binding: string | null; inputs: Record<string, string> | null;
  generation: number; revision: number; state: Json; notes: Json[]; effects: string[];
};
/** What an effect was admitted to do, kept beside it: the tool and the digest of its arguments. */
type EffectIntent = { tool: string; argsHash: string };
/** An effect as this store holds it: the contract's, with the intent it was admitted with when there was one. */
type StoredEffect = RecoveryEffect & { intent?: EffectIntent };
type EffectRecord = { driver: string; name: string; argsHash: string; status: RecoveryEffect["status"]; session: string | null; result: Json; intent?: EffectIntent; calls?: Json };

/** An effect's key in `agentrun.effects`: its journal key, then its id. The two are joined by NUL, so neither may hold
 *  one: two pairs could otherwise name the same document. */
export const effectKey = (key: string, id: string) => {
  if (key.includes("\u0000") || id.includes("\u0000")) throw new RecoveryError("A journal key and an effect id hold no NUL character");
  return `${key}\u0000${id}`;
};

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

/** What a store writes through: a Harness, or the `commit` a running task is handed. */
export type DocumentStoreHost = Pick<Harness, "commit">;

export type DocumentStoreOptions = {
  /** The one owner of the journal across the invocations of a task (its id). An open by this owner takes over a journal
   *  an earlier invocation left open, whose later writes then fail; an open by another owner is refused while the
   *  journal is open. The guard is per process, by journal key: an owner is unique to its run, and two Harness files in
   *  one process that hold one run key under one owner count as one. Without an owner the guard is per host object,
   *  and a second open of a key is refused until the first is closed. */
  owner?: string;
  /** The context every commit runs under; default `BACKGROUND_CONTEXT`. A task passes its invocation's, so the
   *  invocation's cancellation ends its writes. */
  context?: Context;
};

type Held = { token: symbol; owner: string };

/** The journals open in this process. The run's lock keeps every other process off the run, and the journal's generation
 *  fences a stale writer; this keeps a second open of one key off it here. Without an owner a host's own keys are
 *  tracked; with one, the keys by owner. */
const hostKeys = new WeakMap<object, Set<string>>();
const ownedKeys = new Map<string, Held>();

/** Take the in-process hold on `key`: what gives it back, and what undoes the take when the open fails. */
function hold(host: object, key: string, owner: string | undefined): { release(): void; undo(): void } {
  const refused = () => new RecoveryError("Run already has a live owner");
  if (owner === undefined) {
    const keys = hostKeys.get(host) ?? hostKeys.set(host, new Set()).get(host)!;
    if (keys.has(key)) throw refused();
    keys.add(key);
    const release = () => { keys.delete(key); };
    return { release, undo: release };
  }
  const previous = ownedKeys.get(key);
  if (previous && previous.owner !== owner) throw refused();
  const token = Symbol(key);
  ownedKeys.set(key, { token, owner });
  return {
    release: () => { if (ownedKeys.get(key)?.token === token) ownedKeys.delete(key); },
    undo: () => { if (ownedKeys.get(key)?.token !== token) return; if (previous) ownedKeys.set(key, previous); else ownedKeys.delete(key); },
  };
}

/** The recovery store for the journal `key` that `host` writes. Opening it takes ownership: a journal already open is
 *  refused (unless the same `owner` opens it again), a binding that differs from the one the journal was first opened
 *  under is refused naming the inputs that moved, and the generation advances. */
export function documentStore(host: DocumentStoreHost, key: string, options: DocumentStoreOptions = {}): RecoveryStore {
  return { open: (bound) => openDocumentJournal(host, key, bound, options) };
}

async function openDocumentJournal(host: DocumentStoreHost, key: string, bound: RecoveryBinding, options: DocumentStoreOptions): Promise<RecoveryJournal> {
  effectKey(key, "");
  const context = options.context ?? BACKGROUND_CONTEXT;
  const held = hold(host, key, options.owner);
  const opened = await host.commit(async (tx) => {
    const doc = await tx.doc(DriverDoc, key, null);
    const existing = doc.binding !== null;
    if (existing && doc.binding !== bound.binding) throw bindingMismatch(doc.inputs ? JSON.stringify(doc.inputs) : null, bound.inputs);
    if (!existing) { doc.binding = bound.binding; doc.inputs = bound.inputs ? { ...bound.inputs } : null; }
    doc.generation += 1;
    const effects: StoredEffect[] = [];
    for (const id of doc.effects) {
      const e = await tx.doc(EffectDoc, effectKey(key, id), null);
      effects.push({ id, name: e.name, argsHash: e.argsHash, status: e.status, session: e.session, result: json(e.result), ...(e.intent ? { intent: json(e.intent) as EffectIntent } : {}) });
    }
    return { existing, generation: doc.generation, revision: doc.revision, state: json(doc.state), notes: json(doc.notes) as RecoveryNote[], effects };
  }, context).catch((error) => { held.undo(); throw asRecoveryError(error); });
  const effects = new Map<string, StoredEffect>(opened.effects.map((effect) => [effect.id, effect]));
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
    host.commit(async (tx) => {
      const doc = await tx.doc(DriverDoc, key, null);
      if (doc.generation !== opened.generation) throw new RecoveryError("Run owner generation is not acquired");
      const next = doc.revision + 1;
      const value = await write(doc, next, tx);
      doc.revision = next;
      return { revision: next, value };
    }, context).then((done) => { revision = done.revision; return done; });
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
    admit: (id, name, argsHash, state, session = null, intent?: EffectIntent) => inOrder(async () => {
      effectKey(key, id);
      const known = effects.get(id);
      if (known) return known;
      const stored = json(state);
      const kept = intent === undefined ? undefined : json(intent) as EffectIntent;
      await commit(async (doc, _next, tx) => {
        Object.assign(await tx.doc(EffectDoc, effectKey(key, id), null), { driver: key, name, argsHash, status: "unknown", session, result: null, ...(kept ? { intent: kept } : {}) });
        doc.effects.push(id);
        doc.state = stored;
      });
      effects.set(id, { id, name, argsHash, status: "unknown", session, result: null, ...(kept ? { intent: kept } : {}) });
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
      held.release();
    },
  };
}
