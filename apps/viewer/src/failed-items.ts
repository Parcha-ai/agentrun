// A collecting map's failed items (RECORDING.md draft 28, `onItemFailure: "collect"`): each one with how it ended, read
// from the one place the run keeps it (`itemFailureOf`, ./items.ts), never guessed. A panel (PANELS.md): `accepts`,
// `reduce` and `view` are pure, so a scrub is a replay.
import { under, type Json, type Line } from './format.ts';
import { docOf } from './durable.ts';
import { itemFailureOf } from './items.ts';
import { h, register, type Node, type Panel } from './panels.ts';

type FiState = {
  /** The driver state's `pin`, from the latest `agentrun.driver` revision. */
  pin: Json | undefined;
  /** Each map item's latest `agentrun.items` record, by the item's path. */
  items: Record<string, Json>;
  /** The commit of the open whose snapshot lines are arriving, while they arrive. */
  snapshotAt: number | undefined;
};

const fiIsObj = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The item path an `agentrun.items` key names: `<journal key>\u0000<item path>`. */
const fiItemPath = (key: string | undefined) => key?.split('\u0000').at(-1);
const fiPinOf = (value: Json): Json | undefined => (fiIsObj(value) && fiIsObj(value.state) ? value.state.pin : undefined);
/** Paths in map order: by the map's path, then by the item's index. */
const fiOrder = (a: string, b: string) => {
  const [, mapA = a, indexA = '0'] = /^(.*)\/items\/(\d+)$/.exec(a) ?? [];
  const [, mapB = b, indexB = '0'] = /^(.*)\/items\/(\d+)$/.exec(b) ?? [];
  return mapA === mapB ? Number(indexA) - Number(indexB) : mapA < mapB ? -1 : 1;
};

/** Whether a line can show a failed item: an item record whose status is `"failed"`, or a driver state with a row in `pin.failures`. */
const fiShows = (line: Line): boolean => {
  const doc = docOf(line);
  if (!doc) return false;
  if (doc.doc === 'agentrun.items') return fiIsObj(doc.value) && doc.value.status === 'failed';
  if (doc.doc !== 'agentrun.driver') return false;
  const pin = fiPinOf(doc.value);
  return fiIsObj(pin) && fiIsObj(pin.failures) && Object.keys(pin.failures).length > 0;
};

export const failedItemsPanel: Panel<FiState> = {
  id: 'failed-items',
  title: 'Failed items',
  init: () => ({ pin: undefined, items: {}, snapshotAt: undefined }),
  accepts: (line) => { const doc = docOf(line); return doc !== undefined && (doc.doc === 'agentrun.driver' || doc.doc === 'agentrun.items'); },
  shows: fiShows,
  reduce(state, line) {
    const doc = docOf(line)!;
    // An open's snapshot carries every item record and the driver state as they stand, so a new snapshot starts over: a
    // restore rolls back an item that failed after the point it restores to.
    let next = state;
    if (line.snapshot === true) {
      if (state.snapshotAt !== line.commit) next = { pin: undefined, items: {}, snapshotAt: line.commit };
    } else if (state.snapshotAt !== undefined) next = { ...state, snapshotAt: undefined };
    if (doc.doc === 'agentrun.driver') return { ...next, pin: fiPinOf(doc.value) };
    const path = fiItemPath(doc.key);
    return path === undefined ? next : { ...next, items: { ...next.items, [path]: doc.value } };
  },
  view(state, { focus }) {
    const failures = fiIsObj(state.pin) && fiIsObj(state.pin.failures) ? Object.keys(state.pin.failures) : [];
    const paths = [...new Set([...Object.keys(state.items), ...failures])].sort(fiOrder);
    const rows: Node[] = [];
    for (const path of paths) {
      const read = itemFailureOf(path, Object.hasOwn(state.items, path) ? state.items[path] : undefined, state.pin);
      if (read === undefined) continue;
      const dim = focus !== undefined && !under(path, focus) ? ' dim' : '';
      if ('unreadable' in read) {
        rows.push(h('li', { class: `fi-item unreadable${dim}`, path, title: path }, h('code', {}, path), h('span', { class: 'fi-why' }, `unreadable: ${read.unreadable}`)));
        continue;
      }
      const { code, label, message } = read.failed;
      rows.push(h('li', { class: `fi-item failed${dim}`, path, title: path },
        h('code', {}, path),
        h('span', { class: 'fi-code' }, code),
        h('span', { class: 'fi-label' }, `at ${label}`),
        h('p', { class: 'fi-message' }, message),
        h('span', { class: 'fi-from' }, read.from === 'item' ? 'from its item record' : 'from pin.failures')));
    }
    return h('div', { class: 'failed-items' },
      rows.length === 0 ? h('p', { class: 'empty' }, 'No item has failed yet.') : h('ol', {}, ...rows));
  },
};

register(failedItemsPanel);
