// What a panel hands the DSL's `nodeStatus` (packages/dsl/src/graph.ts, inlined at build time): the driver's record of
// the run at the stop, which is the frame of its latest checkpoint (`agentrun.driver`'s `state.pin`, v3 and v4) and, in
// the keyed layout, each map item's latest `agentrun.items` record. This module keeps that record and nothing else: what
// a node's status is, done, working, failed or not run, is the DSL's alone, and every panel asks it the same way. Each
// open's snapshot carries the checkpoint and every item record as they stand, so a new snapshot starts the record over.
// A fold (PANELS.md): `runRecordReduce` is pure, so a scrub is a replay.
import { under, type Json, type Line } from './format.ts';
import { docOf } from './durable.ts';

export type RunRecord = {
  /** The latest checkpoint's frame (`state.pin`), or undefined before the first. */
  pin: Json | undefined;
  /** Each map item's latest record, by its document key. */
  items: Record<string, Json>;
  /** The commit of the open whose snapshot lines are arriving, while they arrive. */
  snapshotAt: number | undefined;
};

const rrIsObj = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const runRecordInit = (): RunRecord => ({ pin: undefined, items: {}, snapshotAt: undefined });

/** The lines the record is made of: the driver's checkpoint and the map items' records. */
export const runRecordAccepts = (line: Line): boolean => {
  const doc = docOf(line);
  return doc !== undefined && (doc.doc === 'agentrun.driver' || doc.doc === 'agentrun.items');
};

export function runRecordReduce(state: RunRecord, line: Line): RunRecord {
  if (!runRecordAccepts(line)) return state;
  const doc = docOf(line)!;
  let next = state;
  if (line.snapshot === true) {
    if (state.snapshotAt !== line.commit) next = { pin: undefined, items: {}, snapshotAt: line.commit };
  } else if (state.snapshotAt !== undefined) next = { ...state, snapshotAt: undefined };
  if (doc.doc === 'agentrun.driver') {
    const pin = rrIsObj(doc.value) && rrIsObj(doc.value.state) ? doc.value.state.pin : undefined;
    return { ...next, pin };
  }
  return doc.key === undefined ? next : { ...next, items: { ...next.items, [doc.key]: doc.value } };
}

/** The whole record, as `nodeStatus` takes it: `{ pin, items }`. */
export const statusSource = (record: RunRecord): { pin: Json; items: Json[] } => ({ pin: record.pin ?? {}, items: Object.values(record.items) });

const rrUnder = (path: string, at: string) => under(path, at);
/** The part of the record that is one map item's (`<map>/items/<i>`): the frame's paths under it (a run stored whole keeps
 *  every item in the frame) and its own record (the keyed layout). Asking `nodeStatus` of this alone says what that one item
 *  did, at the nodes of its map's body. */
export function itemSource(record: RunRecord, item: string): { pin: Json; items: Json[] } {
  const pin = rrIsObj(record.pin) ? record.pin : {};
  const keys = (value: Json | undefined) => (rrIsObj(value) ? Object.fromEntries(Object.entries(value).filter(([path]) => rrUnder(path, item))) : {});
  const slice: Record<string, Json> = {
    done: Array.isArray(pin.done) ? pin.done.filter((path) => typeof path === 'string' && rrUnder(path, item)) : [],
    steps: keys(pin.steps),
    inputs: keys(pin.inputs),
  };
  const own = Object.values(record.items).filter((value) => rrIsObj(value) && typeof value.map === 'string' && Number.isInteger(value.index) && `${value.map}/items/${value.index}` === item);
  return { pin: slice, items: own };
}
