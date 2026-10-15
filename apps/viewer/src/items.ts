// A v4 run's map items (RECORDING.md section 5, draft 26: the keyed layout, `agentrun.items` and `agentrun.states`). The
// rebuild is the DSL's own `itemState`, read from its source each time the viewer is built (build.mjs inlines it; it
// imports nothing), run with the page's SHA-256. A panel imports this module and never rebuilds an item's state itself.
import { itemState } from '../../../packages/dsl/src/recovery/item-state.ts';
import { sha256Hex } from './sha256.ts';

/** A map item's state at `path`, rebuilt as the driver rebuilds it: `{ state }`, or `{ unreadable }` saying why (its base
 *  is missing, a digest differs, it keeps no state there); it never guesses. `item` is an `agentrun.items` value;
 *  `states` holds `agentrun.states` values by their SHA-256 (`statesBySha`). */
export const itemStateOf = (item: unknown, states: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>, path: string) =>
  itemState(item, states, path, { sha256: sha256Hex });

/** `agentrun.states` values, by the SHA-256 each names, as `itemStateOf` takes them. */
export const statesBySha = (values: Iterable<unknown>): Map<string, unknown> =>
  new Map([...values].flatMap((value) => (typeof value === 'object' && value !== null && typeof (value as { sha256?: unknown }).sha256 === 'string'
    ? [[(value as { sha256: string }).sha256, value] as const] : [])));
