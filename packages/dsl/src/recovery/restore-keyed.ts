// The read half of the keyed (v4) layout: given a stored FrozenSnapshotV4 and the journal that holds its states and item
// records, rebuild the whole-state (v3-shape) snapshot the rest of the driver reads — merging into it everything a map's
// items keep (their states, committed paths, step records, routes, chains, loops, inputs, clocks, files and effects).
//
// openRecovery runs this to restore a run, and buildHandoff runs the same function so a handoff reads item records the one
// way the driver does and the two can never diverge (a files-only copy beside this would be the duplication the review
// flagged). openRecovery passes its own bookkeeping as the sink, so this both returns the merged snapshot and seeds the
// write path; buildHandoff passes a throwaway sink and uses only the returned snapshot.
import { nodeAt } from "./execution-path.js";
import { FROZEN_SNAPSHOT_SCHEMA, applyStateDelta, isItemOutcome,
  type FrozenSnapshot as Snapshot, type FrozenSnapshotV4, type ItemRecord, type MapEntry, type StateDelta } from "./frozen-snapshot.js";
import type { RecoveryJournal } from "./store.js";
import type { Workflow } from "../workflow.js";

type State = Record<string, unknown>;
const SHA = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validEntry = (entry: unknown): entry is MapEntry => isRecord(entry) && Number.isSafeInteger(entry.length) && (entry.length as number) >= 0
  && Number.isSafeInteger(entry.items) && (entry.items as number) >= 0 && typeof entry.base === "string" && SHA.test(entry.base);
/** The path of map item `index` of the map at `mapPath`: the prefix the interpreter gives every path inside it. */
const itemPathOf = (mapPath: string, index: number) => `${mapPath}/items/${index}`;

/** The write-path bookkeeping this read seeds as it rebuilds. openRecovery passes its own live maps; a read that only
 *  wants the snapshot (buildHandoff) passes a fresh one and ignores it afterwards. */
export type RestoreSink = {
  maps: Map<string, { length: number; items: number; base: string; baseState?: State }>;
  writtenStates: Set<string>;
  lastItems: Map<string, string>;
  fileOwners: Map<string, string>;
  driverFiles: Set<string>;
  fileRevisions: Map<string, number>;
  deltas: WeakMap<object, StateDelta>;
  digests: WeakMap<object, string>;
};

/** A fresh, empty sink for a read that discards the write-path bookkeeping. */
export const restoreSink = (): RestoreSink => ({
  maps: new Map(), writtenStates: new Set(), lastItems: new Map(), fileOwners: new Map(),
  driverFiles: new Set(), fileRevisions: new Map(), deltas: new WeakMap(), digests: new WeakMap(),
});

/** What the read needs from its caller: the journal (its keyed reads), the desugared workflow (to place maps), the run's
 *  key, the canonical hash, and how a bad checkpoint is raised. */
export type RestoreDeps = {
  journal: Pick<RecoveryJournal, "items" | "stateOf">;
  view: Workflow;
  driverKey: string;
  hash: (value: unknown) => string;
  invalid: (message: string) => Error;
};

/** Reads back the records of every item the maps in `table` wrote, merging into `snapshot` what lies in them: all of it
 *  for a map still running, and what a committed map's items keep in the whole state (their committed paths, step
 *  records, clocks, files and effects) for one that committed. Nested maps are read through their item. */
async function restoreMaps(table: unknown, snapshot: Snapshot, deps: RestoreDeps, sink: RestoreSink): Promise<void> {
  const { journal, view, driverKey, hash, invalid } = deps;
  const { maps, lastItems, fileOwners, driverFiles, fileRevisions, deltas, digests } = sink;
  if (!isRecord(table)) throw invalid("The run's maps are not a record");
  const frame = snapshot.pin;
  for (const [mapPath, entry] of Object.entries(table)) {
    if (!validEntry(entry) || nodeAt(view, mapPath)?.node !== "map") throw invalid(`The map at ${mapPath} is not one this run can hold`);
    const committed = frame.done.includes(mapPath);
    const baseState = committed ? undefined : await stateBy(entry.base, deps, sink);
    maps.set(mapPath, { length: entry.length, items: entry.items, base: entry.base, ...(baseState ? { baseState } : {}) });
    const paths = Array.from({ length: entry.items }, (_, index) => itemPathOf(mapPath, index));
    const records = await journal.items!(paths);
    for (const [index, item] of records.entries()) {
      if (item === undefined) continue;
      const path = paths[index]!;
      const record = item as unknown as ItemRecord;
      const valid = record.driver === driverKey && record.map === mapPath && record.index === index && record.base === entry.base && Number.isSafeInteger(record.revision)
        && ["running", "committed", "failed"].includes(record.status) && isRecord(record.frame) && Array.isArray(record.frame.done)
        && [record.frame.states, record.frame.chains, record.frame.loops, record.frame.routes, record.frame.inputs, record.frame.steps, record.clocks, record.files, record.unknownResponses, record.maps].every(isRecord)
        && Array.isArray(record.effects) && record.effects.every((id) => typeof id === "string")
        // An item that ended on its failure, and only one, holds how it ended; its map collects its items' failures.
        && (record.status === "failed"
          ? isItemOutcome(record.outcome) && (nodeAt(view, mapPath) as { onItemFailure?: unknown } | undefined)?.onItemFailure === "collect"
          : record.outcome === undefined);
      if (!valid) throw invalid(`The record of map item ${path} is not one this run wrote`);
      if (record.outcome) (frame.failures ??= {})[path] = { ...record.outcome };
      lastItems.set(path, JSON.stringify({ ...record, revision: 0 }));
      frame.done.push(...record.frame.done);
      Object.assign(frame.steps, record.frame.steps);
      Object.assign(snapshot.clocks, record.clocks);
      for (const [name, sha256] of Object.entries(record.files)) {
        // A committed item keeps the record it last wrote, so a file a later step wrote again holds an older hash there.
        if (driverFiles.has(name) || (fileRevisions.get(name) ?? -1) > record.revision) continue;
        snapshot.files[name] = sha256 as string; fileOwners.set(name, `${path}/body`); fileRevisions.set(name, record.revision);
      }
      if (Object.keys(record.unknownResponses).length) Object.assign(snapshot.unknownResponses ??= {}, record.unknownResponses);
      if (!committed) {
        for (const [at, delta] of Object.entries(record.frame.states)) {
          if (!isRecord(delta) || !isRecord(delta.set) || !Array.isArray(delta.unset) || typeof delta.sha256 !== "string") throw invalid(`The state at ${at} is not a delta`);
          const state = applyStateDelta(baseState!, delta as StateDelta);
          if (hash(state) !== delta.sha256) throw invalid(`The state at ${at} does not rebuild to the state that was committed`);
          frame.states[at] = state;
          deltas.set(state, delta as StateDelta);
          digests.set(state, delta.sha256);
        }
        Object.assign(frame.chains, record.frame.chains);
        Object.assign(frame.loops, record.frame.loops);
        Object.assign(frame.routes, record.frame.routes);
        Object.assign(frame.inputs, record.frame.inputs);
      }
      await restoreMaps(record.maps, snapshot, deps, sink);
    }
  }
}

/** A state the run references by digest, read back and checked against it. */
async function stateBy(sha256: string, deps: RestoreDeps, sink: RestoreSink): Promise<State> {
  const state = await deps.journal.stateOf!(sha256);
  if (!state || typeof state !== "object" || Array.isArray(state) || deps.hash(state) !== sha256) throw deps.invalid(`The state ${sha256} the run references is missing or changed`);
  sink.writtenStates.add(sha256);
  sink.digests.set(state, sha256);
  return state as State;
}

/** A value the run references by digest (a failed map's result, which may be any JSON value), read back and checked. */
async function valueBy(sha256: string, deps: RestoreDeps, sink: RestoreSink): Promise<unknown> {
  const value = await deps.journal.stateOf!(sha256);
  if (value === undefined || deps.hash(value) !== sha256) throw deps.invalid(`The value ${sha256} the run references is missing or changed`);
  sink.writtenStates.add(sha256);
  return value;
}

/** The whole state of a run stored in the keyed layout: its own record with every state read back by digest, and what its
 *  map items keep, merged in. The one reader openRecovery and buildHandoff both run. */
export async function restoreV4(stored: FrozenSnapshotV4, deps: RestoreDeps, sink: RestoreSink): Promise<Snapshot> {
  const { invalid } = deps;
  // A copy: what the items hold is merged into the restored frame, and the store's own state (which it writes back for a
  // completion that names none) must stay the driver's record alone.
  const { maps: table, pin, ...rest } = structuredClone(stored);
  if (!isRecord(pin) || !isRecord(pin.states) || !Object.values(pin.states).every((sha256) => typeof sha256 === "string" && SHA.test(sha256)) || !Array.isArray(pin.done)) throw invalid("Invalid frozen recovery checkpoint");
  const states: Record<string, State> = {};
  for (const [at, sha256] of Object.entries(pin.states)) states[at] = await stateBy(sha256, deps, sink);
  const restored = { ...rest, schema: FROZEN_SNAPSHOT_SCHEMA, pin: { ...pin, done: [...pin.done], states }, clocks: { ...rest.clocks }, files: { ...rest.files } } as Snapshot;
  for (const name of Object.keys(restored.files)) sink.driverFiles.add(name);
  // A failed map's finished results: the list of their slots is one value kept by its digest, each slot the digest of its
  // result or null for an item that never finished.
  if (pin.partial !== undefined) {
    const partial = pin.partial as unknown;
    if (!isRecord(partial) || typeof partial.path !== "string" || typeof partial.as !== "string" || typeof partial.results !== "string" || !SHA.test(partial.results)) {
      throw invalid("A failed map's results are not kept by digest");
    }
    const slots = await valueBy(partial.results, deps, sink);
    if (!Array.isArray(slots) || !slots.every((slot) => slot === null || (typeof slot === "string" && SHA.test(slot)))) throw invalid("A failed map's results are not a list of digests");
    restored.pin.partial = { path: partial.path, as: partial.as, results: await Promise.all(slots.map((slot) => (slot === null ? null : valueBy(slot as string, deps, sink)))) };
  }
  await restoreMaps(table, restored, deps, sink);
  return restored;
}
