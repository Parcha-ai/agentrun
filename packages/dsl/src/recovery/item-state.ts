// A map item's state in the keyed layout, rebuilt from its record and its base. This module imports nothing, so a
// reader with no Node (the static viewer inlines it) runs the same rebuild the driver runs; the SHA-256 is the caller's.

type State = Record<string, unknown>;

/** A committed state inside a map item, against its map's base (the state the map started from): the keys it sets
 *  (new, or holding another value than the base's), the base's keys it lacks, and the digest of the whole state, which
 *  a rebuild must reach. */
export type StateDelta = { set: State; unset: string[]; sha256: string };

/** The hex SHA-256 of a text's UTF-8 bytes, synchronous. */
export type Sha256 = (text: string) => string;

/** The JSON a state's digest is taken over: every object's keys sorted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as State)[key]])) : item);
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** `state` against `base`, as a map item keeps it. */
export function stateDelta(base: State, state: State, sha256: string): StateDelta {
  const set: State = {};
  for (const [key, value] of Object.entries(state)) if (!Object.hasOwn(base, key) || !sameValue(base[key], value)) set[key] = value;
  return { set, unset: Object.keys(base).filter((key) => !Object.hasOwn(state, key)), sha256 };
}

/** The state a delta was taken from, in its own key order: the base's keys first (a map item starts from a copy of its
 *  base), then the keys it added. */
export function applyStateDelta(base: State, delta: StateDelta): State {
  const unset = new Set(delta.unset);
  const state: State = {};
  for (const key of Object.keys(base)) if (!unset.has(key)) state[key] = Object.hasOwn(delta.set, key) ? delta.set[key] : base[key];
  for (const [key, value] of Object.entries(delta.set)) if (!Object.hasOwn(base, key)) state[key] = value;
  return state;
}

const isObject = (value: unknown): value is State => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A map item's state at `path`, rebuilt as the driver rebuilds it: the `agentrun.states` value its `base` names, with
 *  the item's `set` and `unset` for that path applied, checked against that path's `sha256`. `item` is an
 *  `agentrun.items` value; `states` holds `agentrun.states` values by SHA-256; `sha256` hashes a text's UTF-8 bytes.
 *  When the base is missing, or a digest differs, it says why and never guesses. */
export function itemState(item: unknown, states: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>, path: string, { sha256 }: { sha256: Sha256 }): { state: State } | { unreadable: string } {
  if (typeof sha256 !== "function") throw new TypeError("itemState needs a sha256 function");
  if (!isObject(item) || typeof item.base !== "string" || !isObject(item.frame) || !isObject(item.frame.states)) return { unreadable: "not a map item's record" };
  const delta = item.frame.states[path];
  if (delta === undefined) return { unreadable: `the item keeps no state at ${path}` };
  if (!isObject(delta) || !isObject(delta.set) || !Array.isArray(delta.unset) || !delta.unset.every((key) => typeof key === "string") || typeof delta.sha256 !== "string") {
    return { unreadable: `the state at ${path} is not a delta` };
  }
  const held = states instanceof Map ? states.get(item.base) : Object.hasOwn(states, item.base) ? (states as State)[item.base] : undefined;
  if (!isObject(held) || !isObject(held.state)) return { unreadable: `its base ${item.base} is missing` };
  if (sha256(canonicalJson(held.state)) !== item.base) return { unreadable: `its base does not match its SHA-256 ${item.base}` };
  const state = applyStateDelta(held.state, delta as StateDelta);
  if (sha256(canonicalJson(state)) !== delta.sha256) return { unreadable: `the state at ${path} does not rebuild to its SHA-256 ${delta.sha256}` };
  return { state };
}
