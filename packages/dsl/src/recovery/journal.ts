// A journal over a record that a backend keeps whole: ownership, the generation check, the revision counter and the
// six writes. A backend only takes the journal for one owner, reads the record and replaces it, whole and durably.
// The memory store and the file store are this journal over two backends.
import { bindingMismatch } from "./binding.js";
import { RecoveryError, asRecoveryError } from "./errors.js";
import type { RecoveryBinding, RecoveryEffect, RecoveryItem, RecoveryJournal, RecoveryNote, RecoveryParts } from "./store.js";

/** A journal as a backend keeps it: what it is bound to, who owns it, its state, its notes, its effects in admission
 *  order, each with the outside calls it made, and the parts written beside the state (map items' records by path,
 *  states by digest). */
export type JournalRecord = {
  binding: string | null; inputs: Record<string, string> | null;
  generation: number; revision: number; state: unknown;
  notes: RecoveryNote[];
  effects: Array<RecoveryEffect & { calls?: unknown }>;
  items?: Record<string, RecoveryItem>;
  states?: Record<string, unknown>;
};

export type JournalBackend = {
  /** Take the journal for one owner, or throw when it has a live one. Resolves to what lets go of it. */
  acquire(): Promise<() => Promise<void>>;
  /** The record as the last `write` left it, or undefined before the first. The caller may change what it gets. */
  read(): Promise<JournalRecord | undefined>;
  /** Replace the record: whole or not at all, and durable before the promise resolves. */
  write(record: JournalRecord): Promise<void>;
};

/** A value as a journal stores it: plain JSON, every number finite. */
function json(value: unknown): any {
  return value === undefined ? null : JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol" || (typeof item === "number" && !Number.isFinite(item))) {
      throw new RecoveryError("A journal holds finite JSON values only");
    }
    return item;
  }));
}

const publicEffect = ({ id, name, argsHash, status, session, result, intent, args, calls }: JournalRecord["effects"][number]): RecoveryEffect =>
  ({ id, name, argsHash, status, session, result, ...(intent ? { intent: { tool: intent.tool, argsHash: intent.argsHash } } : {}), ...(args !== undefined ? { args } : {}), ...(Array.isArray(calls) ? { calls } : {}) });

/** Open the journal a backend keeps and take ownership of it: a journal with a live owner refuses, a binding that
 *  differs refuses naming the inputs that moved, and the generation advances. */
export async function openJournal(backend: JournalBackend, bound: RecoveryBinding): Promise<RecoveryJournal> {
  const release = await backend.acquire();
  let opened: JournalRecord;
  let existing: boolean;
  try {
    opened = (await backend.read()) ?? { binding: null, inputs: null, generation: 0, revision: 0, state: null, notes: [], effects: [] };
    existing = opened.binding !== null;
    if (existing && opened.binding !== bound.binding) throw bindingMismatch(opened.inputs ? JSON.stringify(opened.inputs) : null, bound.inputs);
    if (!existing) { opened.binding = bound.binding; opened.inputs = bound.inputs ? { ...bound.inputs } : null; }
    opened.generation += 1;
    await backend.write(opened);
  } catch (error) { await release(); throw asRecoveryError(error); }
  const generation = opened.generation;
  const effects = new Map(opened.effects.map((effect) => [effect.id, publicEffect(effect)]));
  const notes = [...opened.notes];
  let revision = opened.revision;
  let closed = false;
  /** Writes run one at a time, in the order they were asked for, each with its checks: two asked for together never
   *  both pass a check the first one's commit would fail. A failed write does not stop the next, and one asked for
   *  before `close` still lands. */
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(write: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new RecoveryError("The journal is closed"));
    const done = queue.then(write).catch((error) => { throw asRecoveryError(error); });
    queue = done.catch(() => undefined);
    return done;
  };
  /** One commit, inside a write: it checks this open still owns the journal, advances the revision, and lets `change`
   *  alter the record with that revision, then lays the parts beside it. The record is replaced only when both return. */
  const commit = async (change: (record: JournalRecord, next: number) => void, parts?: (revision: number) => RecoveryParts): Promise<number> => {
    const record = await backend.read();
    if (!record || record.generation !== generation) throw new RecoveryError("Run owner generation is not acquired");
    const next = record.revision + 1;
    change(record, next);
    const laid = parts?.(next);
    if (laid?.items) record.items = { ...record.items, ...json(laid.items) };
    if (laid?.states) {
      const states = record.states ??= {};
      for (const [sha256, state] of Object.entries(laid.states)) if (!Object.hasOwn(states, sha256)) states[sha256] = json(state);
    }
    record.revision = next;
    await backend.write(record);
    revision = next;
    return next;
  };
  const stored = (record: JournalRecord, id: string) => record.effects.find((effect) => effect.id === id)!;
  return {
    existing, generation, state: json(opened.state),
    get revision() { return revision; },
    effects: () => [...effects.values()],
    effect: (id) => effects.get(id),
    notes: () => [...notes],
    save: (state: unknown, note?: Pick<RecoveryNote, "kind" | "detail">, parts?: (revision: number) => RecoveryParts) => inOrder(async () => {
      let entry: RecoveryNote | undefined;
      const committed = await commit((record, next) => {
        record.state = json(typeof state === "function" ? state(next) : state);
        if (note) { entry = { revision: next, kind: note.kind, detail: json(note.detail), at: new Date().toISOString() }; record.notes.push(entry); }
      }, parts);
      if (entry) notes.push(entry);
      return committed;
    }),
    note: (kind, detail) => inOrder(async () => {
      const entry = { kind, detail: json(detail), at: new Date().toISOString() };
      const committed = await commit((record, next) => { record.notes.push({ revision: next, ...entry }); });
      notes.push({ revision: committed, ...entry });
      return committed;
    }),
    // A record kept whole lists every effect itself, an owned one too.
    admit: (id, name, argsHash, state, session = null, intent, args, parts) => inOrder(async () => {
      const known = effects.get(id);
      if (known) return known;
      const effect: RecoveryEffect = { id, name, argsHash, status: "unknown", session, result: null, ...(intent ? { intent: json(intent) } : {}), ...(args !== undefined ? { args: json(args) } : {}) };
      await commit((record) => { record.effects.push({ ...effect }); record.state = json(state); }, parts);
      effects.set(id, effect);
      return "new" as const;
    }),
    complete: (id, result, state = opened.state, parts) => inOrder(async () => {
      const known = effects.get(id);
      if (!known) throw new RecoveryError(`Effect ${id} completes without an admission`);
      if (known.status === "completed") throw new RecoveryError(`Effect ${id} completes once`);
      const value = json(result);
      await commit((record) => { Object.assign(stored(record, id), { status: "completed", result: value }); record.state = json(state); }, parts);
      effects.set(id, { ...known, status: "completed", result: value });
    }),
    called: (id, calls) => inOrder(async () => {
      if (!effects.has(id)) throw new RecoveryError(`Effect ${id} records calls without an admission`);
      const value = json(calls);
      await commit((record) => { stored(record, id).calls = value; });
      effects.set(id, { ...effects.get(id)!, ...(Array.isArray(value) ? { calls: value } : {}) });
    }),
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      await release();
    },
    items: async (paths) => { const record = await backend.read(); return paths.map((path) => (record?.items && Object.hasOwn(record.items, path) ? json(record.items[path]) : undefined)); },
    stateOf: async (sha256) => { const record = await backend.read(); return record?.states && Object.hasOwn(record.states, sha256) ? json(record.states[sha256]) : undefined; },
  };
}
