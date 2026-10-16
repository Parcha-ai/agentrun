// What the run did at each workflow node, from durable state: the one place a panel reads a node's status. Done comes from
// the driver's checkpoint (`agentrun.driver`: every `done` path, v3 and v4) and, in the keyed layout, each map item's
// `agentrun.items` record (committed, and its own `frame.done`); failed from a step record whose status is `"failed"`
// (`pin.steps`, an item's `frame.steps`), an item record whose status is `"failed"` and `pin.failures`. Live workflow
// events say only what is running now: a node started and not ended, in the process that is running. A process that
// resumes finishes work from its journal and writes no live event for it, so a panel that read done from live events
// would leave that work running forever. A fold (PANELS.md): `nodeStatusReduce` is pure, so a scrub is a replay.
import { type Json, type Line } from './format.ts';
import { donePathsOf } from './audit-read.ts';
import { docOf } from './durable.ts';

type NsItem = { status: string; done: string[]; failedSteps: string[] };
export type NodeStatusState = {
  /** The execution paths the driver's latest checkpoint lists as done. */
  done: string[];
  /** The steps the driver's latest checkpoint keeps as failed. */
  failedSteps: string[];
  /** Each map item's latest `agentrun.items` record (the keyed layout), by the item's path. */
  items: Record<string, NsItem>;
  /** The item paths the driver keeps in `pin.failures` (a collecting map's failed items). */
  failures: string[];
  /** The execution paths a live `node.start` named and no `node.end` has since, in the process that is running. */
  started: string[];
  /** The commit of the open whose snapshot lines are arriving, while they arrive. */
  snapshotAt: number | undefined;
};

const nsIsObj = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nsStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []);
/** The step paths a frame's `steps` keeps as failed. */
const nsFailedSteps = (steps: unknown): string[] => (nsIsObj(steps) ? Object.entries(steps).filter(([, step]) => nsIsObj(step) && step.status === 'failed').map(([path]) => path) : []);

export const nodeStatusInit = (): NodeStatusState => ({ done: [], failedSteps: [], items: {}, failures: [], started: [], snapshotAt: undefined });

/** The lines the fold reads: the driver's checkpoint and the map items' records, the live node events, and the
 *  supervisor's process starts and kills. */
export const nodeStatusAccepts = (line: Line): boolean => {
  if (line.source === 'host') return line.channel === 'live' && (line.kind === 'kill' || line.kind === 'process.started');
  if (line.channel === 'live') return line.source === 'workflow' && (line.kind === 'node.start' || line.kind === 'node.end') && typeof line.path === 'string';
  const doc = docOf(line);
  return doc !== undefined && (doc.doc === 'agentrun.driver' || doc.doc === 'agentrun.items');
};

export function nodeStatusReduce(state: NodeStatusState, line: Line): NodeStatusState {
  if (!nodeStatusAccepts(line)) return state;
  // A process that ends runs nothing more; the next one's snapshot says where the run stands.
  if (line.source === 'host') return state.started.length ? { ...state, started: [] } : state;
  if (line.channel === 'live') {
    const path = line.path!;
    if (line.kind === 'node.start') return state.started.includes(path) ? state : { ...state, started: [...state.started, path] };
    return { ...state, started: state.started.filter((each) => each !== path) };
  }
  const doc = docOf(line)!;
  // An open's snapshot carries the checkpoint and every item record as they stand, so a new snapshot starts over.
  let next = state;
  if (line.snapshot === true) {
    if (state.snapshotAt !== line.commit) next = { ...state, done: [], failedSteps: [], items: {}, failures: [], snapshotAt: line.commit };
  } else if (state.snapshotAt !== undefined) next = { ...state, snapshotAt: undefined };
  if (doc.doc === 'agentrun.driver') {
    const pin = nsIsObj(doc.value) && nsIsObj(doc.value.state) ? doc.value.state.pin : undefined;
    return { ...next, done: donePathsOf(doc) ?? [], failedSteps: nsIsObj(pin) ? nsFailedSteps(pin.steps) : [], failures: nsIsObj(pin) && nsIsObj(pin.failures) ? Object.keys(pin.failures) : [] };
  }
  const item = doc.key?.split('\u0000').at(-1);
  if (item === undefined || !nsIsObj(doc.value)) return next;
  const frame = doc.value.frame;
  return { ...next, items: { ...next.items, [item]: { status: String(doc.value.status), done: nsIsObj(frame) ? nsStrings(frame.done) : [], failedSteps: nsIsObj(frame) ? nsFailedSteps(frame.steps) : [] } } };
}

/** The workflow node an execution path ran: the path with each instance it names taken out (a map item's or a loop
 *  iteration's index before its `body`), so every item of a map is the one node of its body. */
export const graphPathOf = (path: string): string => path.replace(/\/(?:items|iterations)\/(?:0|[1-9]\d*)(?=\/body(?:\/|$))/g, '');

/** The durable record at the stop: every done path, every failed one. */
function nsDurable(state: NodeStatusState): { done: Set<string>; failed: Set<string> } {
  const done = new Set(state.done);
  const failed = new Set(state.failedSteps);
  for (const [item, record] of Object.entries(state.items)) {
    for (const path of record.done) done.add(path);
    for (const path of record.failedSteps) failed.add(path);
    if (record.status === 'committed') done.add(`${item}/body`);
    else if (record.status === 'failed') failed.add(`${item}/body`);
  }
  for (const item of state.failures) if (!Object.hasOwn(state.items, item)) failed.add(`${item}/body`);
  return { done, failed };
}

/** One execution path's status at the stop: failed, done, running now, or not reached. */
export type PathStatus = 'failed' | 'done' | 'running' | 'pending';
export function pathStatus(state: NodeStatusState, path: string): PathStatus {
  const { done, failed } = nsDurable(state);
  if (failed.has(path)) return 'failed';
  if (done.has(path)) return 'done';
  return state.started.includes(path) ? 'running' : 'pending';
}

/** Each workflow node's count of the instances the run reached there (`graphPathOf`): done, running, failed. */
export type NodeStatus = { done: number; running: number; failed: number };
export function nodeStatuses(state: NodeStatusState): Map<string, NodeStatus> {
  const out = new Map<string, NodeStatus>();
  const bump = (path: string, field: keyof NodeStatus) => {
    const at = graphPathOf(path);
    const now = out.get(at) ?? { done: 0, running: 0, failed: 0 };
    out.set(at, { ...now, [field]: now[field] + 1 });
  };
  const { done, failed } = nsDurable(state);
  for (const path of failed) bump(path, 'failed');
  for (const path of done) if (!failed.has(path)) bump(path, 'done');
  for (const [item, record] of Object.entries(state.items)) {
    const body = `${item}/body`;
    if (record.status === 'running' && !done.has(body) && !failed.has(body)) bump(body, 'running');
  }
  for (const path of state.started) if (!done.has(path) && !failed.has(path)) bump(path, 'running');
  return out;
}
