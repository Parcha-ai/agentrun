// `isDeepStrictEqual` for the browser platform, without `node:util`: the same answers as Node's for the values a
// workflow's state and a host's patches hold (JSON-shaped data, plus Date, RegExp, Map, Set, typed arrays and
// errors). Checked against `node:util` by test/platform-parity.test.mjs over a corpus of equal and unequal pairs.
const tag = (value: unknown): string => Object.prototype.toString.call(value);

const ownKeys = (value: object): (string | symbol)[] => [
  ...Object.keys(value),
  ...Object.getOwnPropertySymbols(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key)),
];

type Seen = Map<object, object>;

function equal(a: unknown, b: unknown, seen: Seen): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const kind = tag(a);
  if (kind !== tag(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
  } else if (a instanceof Date) {
    if (a.getTime() !== (b as Date).getTime() && !(Number.isNaN(a.getTime()) && Number.isNaN((b as Date).getTime()))) return false;
  } else if (a instanceof RegExp) {
    const other = b as RegExp;
    if (a.source !== other.source || a.flags !== other.flags || a.lastIndex !== other.lastIndex) return false;
  } else if (a instanceof Error) {
    const other = b as Error;
    if (a.message !== other.message || a.name !== other.name) return false;
    if (!equal((a as { cause?: unknown }).cause, (other as { cause?: unknown }).cause, seen)) return false;
  } else if (ArrayBuffer.isView(a)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array((b as ArrayBufferView).buffer, (b as ArrayBufferView).byteOffset, (b as ArrayBufferView).byteLength);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  } else if (a instanceof ArrayBuffer) {
    const left = new Uint8Array(a), right = new Uint8Array(b as ArrayBuffer);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  } else if (a instanceof Number || a instanceof String || a instanceof Boolean || a instanceof BigInt || a instanceof Symbol) {
    if (!Object.is(a.valueOf(), (b as { valueOf(): unknown }).valueOf())) return false;
  } else if (a instanceof Set) {
    const other = b as Set<unknown>;
    if (a.size !== other.size) return false;
    const rest = [...other];
    for (const item of a) {
      const at = rest.findIndex((candidate) => equal(item, candidate, seen));
      if (at < 0) return false;
      rest.splice(at, 1);
    }
  } else if (a instanceof Map) {
    const other = b as Map<unknown, unknown>;
    if (a.size !== other.size) return false;
    const rest = [...other];
    for (const [key, value] of a) {
      const at = rest.findIndex(([otherKey, otherValue]) => equal(key, otherKey, seen) && equal(value, otherValue, seen));
      if (at < 0) return false;
      rest.splice(at, 1);
    }
  }
  const keys = ownKeys(a), otherKeys = ownKeys(b);
  if (keys.length !== otherKeys.length) return false;
  for (const key of keys) {
    if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
    if (!equal((a as Record<string | symbol, unknown>)[key], (b as Record<string | symbol, unknown>)[key], seen)) return false;
  }
  return true;
}

export const isDeepStrictEqual = (a: unknown, b: unknown): boolean => equal(a, b, new Map());
