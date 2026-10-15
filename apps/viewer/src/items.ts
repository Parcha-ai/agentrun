// A v4 run's map items (RECORDING.md section 5, draft 26: the keyed layout, `agentrun.items` and `agentrun.states`). The
// rebuild is the DSL's own `itemState`, read from its source each time the viewer is built (build.mjs inlines it; it
// imports nothing), run with the page's SHA-256. A panel imports this module and never rebuilds an item's state, or
// reads a failed map's results, itself.
import { canonicalJson, itemState } from '../../../packages/dsl/src/recovery/item-state.ts';
import { sha256Hex } from './sha256.ts';

/** A map item's state at `path`, rebuilt as the driver rebuilds it: `{ state }`, or `{ unreadable }` saying why (its base
 *  is missing, a digest differs, it keeps no state there); it never guesses. `item` is an `agentrun.items` value;
 *  `states` holds `agentrun.states` values by their SHA-256 (`statesBySha`). */
export const itemStateOf = (item: unknown, states: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>, path: string) =>
  itemState(item, states, path, { sha256: sha256Hex });

/** The `agentrun.states` value a digest names: `{ result }`, which may be any JSON value, or `{ unreadable }` when its
 *  document is missing or does not hash to that digest; it never guesses. `states` is as `itemStateOf` takes it. */
export const resultOf = (digest: unknown, states: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>): { result: unknown } | { unreadable: string } => {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return { unreadable: 'not a digest' };
  const held = states instanceof Map ? states.get(digest) : Object.hasOwn(states, digest) ? (states as Record<string, unknown>)[digest] : undefined;
  const result = typeof held === 'object' && held !== null ? (held as { state?: unknown }).state : undefined;
  if (result === undefined) return { unreadable: `its document ${digest} is missing` };
  if (sha256Hex(canonicalJson(result)) !== digest) return { unreadable: `its document does not match its SHA-256 ${digest}` };
  return { result };
};

type Slot = null | { result: unknown } | { unreadable: string };

/** A failed map's finished results, from the driver's `state.pin.partial`: one slot per item in index order, `null` for an
 *  item that never finished, else `{ result }` or `{ unreadable }`. A v3 pin keeps the results inline. In the keyed layout
 *  (v4), `results` is the SHA-256 of an `agentrun.states` document whose state is the list of slots, each `null` or the
 *  SHA-256 of the document holding that item's result; every digest is checked, and a list that is missing, does not hash
 *  to its digest or is not a list of digests makes the whole `{ unreadable }`. */
export const resultsOf = (partial: unknown, states: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>): { results: Slot[] } | { unreadable: string } => {
  const results = typeof partial === 'object' && partial !== null ? (partial as { results?: unknown }).results : undefined;
  if (Array.isArray(results)) return { results: results.map((result): Slot => (result === null ? null : { result })) };
  const list = resultOf(results, states);
  if ('unreadable' in list) return { unreadable: `its list of results: ${list.unreadable}` };
  if (!Array.isArray(list.result) || !list.result.every((slot) => slot === null || typeof slot === 'string')) return { unreadable: 'its list of results is not a list of digests' };
  return { results: list.result.map((slot): Slot => (slot === null ? null : resultOf(slot, states))) };
};

/** `agentrun.states` values, by the SHA-256 each names, as `itemStateOf`, `resultOf` and `resultsOf` take them. */
export const statesBySha = (values: Iterable<unknown>): Map<string, unknown> =>
  new Map([...values].flatMap((value) => (typeof value === 'object' && value !== null && typeof (value as { sha256?: unknown }).sha256 === 'string'
    ? [[(value as { sha256: string }).sha256, value] as const] : [])));
