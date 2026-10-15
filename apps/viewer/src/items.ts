// A v4 run's map items (RECORDING.md section 5, draft 27: the keyed layout, `agentrun.items` and `agentrun.states`). The
// rebuild of an item's state and the read of a failed map's results are the DSL's own `itemState` and `partialResults`,
// read from its source each time the viewer is built (build.mjs inlines it; it imports nothing), run with the page's
// SHA-256. A panel imports this module and never rebuilds an item's state, or reads a failed map's results, itself.
import { itemState, partialResults } from '../../../packages/dsl/src/recovery/item-state.ts';
import { sha256Hex } from './receipt-key.ts';

/** A map item's state at `path`, rebuilt as the driver rebuilds it: `{ state }`, or `{ unreadable }` saying why (its base
 *  is missing, a digest differs, it keeps no state there); it never guesses. `item` is an `agentrun.items` value;
 *  `states` holds `agentrun.states` values by their SHA-256 (`statesBySha`). */
export const itemStateOf = (item: unknown, states: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>, path: string) =>
  itemState(item, states, path, { sha256: sha256Hex });

/** A failed map's finished results, from the driver's `state.pin.partial`, read as the driver reads them: the DSL's own
 *  `partialResults`. `{ slots }`, one per item in index order, each `null` (it never finished), `{ result }` or
 *  `{ unreadable }`; or a whole `{ unreadable }` when the keyed layout's list of results is missing, does not hash to its
 *  digest or is not a list of digests. A v3 pin's inline list reads too. `states` is as `itemStateOf` takes it. */
export const partialResultsOf = (partial: unknown, states: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>) =>
  partialResults(partial, states, { sha256: sha256Hex });

/** `agentrun.states` values, by the SHA-256 each names, as `itemStateOf` and `partialResultsOf` take them. */
export const statesBySha = (values: Iterable<unknown>): Map<string, unknown> =>
  new Map([...values].flatMap((value) => (typeof value === 'object' && value !== null && typeof (value as { sha256?: unknown }).sha256 === 'string'
    ? [[(value as { sha256: string }).sha256, value] as const] : [])));
