// The records a source's import has read, each with the locator it counts in: an exact hash index on typed arrays. A
// uuid's key is held in 16 bytes, any other's packed bytes (record-key.ts) in one arena, the locator as a number. A Map
// holds at most 2^24 entries, at about 100 bytes each with its key's string; this holds as many as the arrays can, at
// about 35 bytes a uuid's. Its keys are whole, never a hash of them: no two records are ever taken for one.
// Plain data (typed arrays, an array, a Map of strings): structuredClone and v8.serialize keep it, as HomeState asks.
import { type Packed, UUID } from "./record-key.js";

/** One kind of key's entries, in the order added, and the open-addressing slots (linear probing) that find them:
 *  0 an empty slot, else an entry's index + 1. Each slot's tag is its entry's hash's top byte: a probe passes a slot
 *  whose tag differs without reading the entry (a miss walks the whole run). A table of fewer than TAGGED slots has
 *  none (a file's own index, saved in its cursor, stays as small as it was); an index saved without them (an older
 *  HomeState) has them built the first time it is probed. */
type Table = { count: number; slots: Int32Array; tags?: Uint8Array; owners: Int32Array };
/** A uuid's keys: four 32-bit words an entry. */
type Uuids = Table & { words: Int32Array };
/** Any other key's: entry i's bytes are bytes[ends[i - 1] (0 for the first), ends[i]). */
type Others = Table & { ends: Float64Array; bytes: Uint8Array; used: number };

export type RecordIndex = {
  uuids: Uuids;
  others: Others;
  /** The locators the owners number, by number, and their numbers. */
  locators: string[];
  numbers: Map<string, number>;
};

const LOAD = 0.75;
/** The slots from which a table's slots carry tags. */
const TAGGED = 1024;

const table = (slots: number) => ({ count: 0, slots: new Int32Array(slots), ...(slots >= TAGGED ? { tags: new Uint8Array(slots) } : {}), owners: new Int32Array(slots >> 1) });

/** An empty index, its slots `slots` (a power of 2) to start with. */
export const recordIndex = (slots = 1024): RecordIndex => ({
  uuids: { ...table(slots), words: new Int32Array((slots >> 1) * 4) },
  others: { ...table(slots), ends: new Float64Array(slots >> 1), bytes: new Uint8Array(slots * 8), used: 0 },
  locators: [],
  numbers: new Map(),
});

/** The number of `locator` in `index`, given one when it has none. */
export function locatorNumber(index: RecordIndex, locator: string): number {
  let n = index.numbers.get(locator);
  if (n === undefined) index.numbers.set(locator, (n = index.locators.push(locator) - 1));
  return n;
}

// murmur3's finalizer: every bit of the input moves the slot.
const mix = (h: number): number => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

const word = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24);
const uuidHash = (w0: number, w1: number, w2: number, w3: number): number => mix(w0 ^ mix(w1 ^ mix(w2 ^ mix(w3))));
function bytesHash(b: Uint8Array, from: number, to: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i += 1) h = Math.imul(h ^ b[i]!, 0x01000193);
  return mix(h ^ (to - from));
}

/** `t`'s tags: none below TAGGED slots; built for an index saved before tags (retag). */
const uuidTags = (t: Uuids): Uint8Array | undefined => (t.slots.length < TAGGED ? undefined : t.tags !== undefined && t.tags.length === t.slots.length ? t.tags : retag(t, (e) => uuidHash(t.words[e * 4]!, t.words[e * 4 + 1]!, t.words[e * 4 + 2]!, t.words[e * 4 + 3]!)));
const otherTags = (t: Others): Uint8Array | undefined => (t.slots.length < TAGGED ? undefined : t.tags !== undefined && t.tags.length === t.slots.length ? t.tags : retag(t, (e) => bytesHash(t.bytes, e === 0 ? 0 : t.ends[e - 1]!, t.ends[e]!)));
function retag(t: Table, hashOf: (e: number) => number): Uint8Array {
  const tags = new Uint8Array(t.slots.length);
  for (let s = 0; s < t.slots.length; s += 1) if (t.slots[s] !== 0) tags[s] = hashOf(t.slots[s]! - 1) >>> 24;
  return (t.tags = tags);
}

/** The entry of `t` with these words, else -1. */
function findUuid(t: Uuids, w0: number, w1: number, w2: number, w3: number, h: number): number {
  const mask = t.slots.length - 1;
  const tags = uuidTags(t);
  const tag = h >>> 24;
  for (let s = h & mask; ; s = (s + 1) & mask) {
    const e = t.slots[s]!;
    if (e === 0) return -1;
    if (tags !== undefined && tags[s] !== tag) continue;
    const at = (e - 1) * 4;
    if (t.words[at] === w0 && t.words[at + 1] === w1 && t.words[at + 2] === w2 && t.words[at + 3] === w3) return e - 1;
  }
}

/** The entry of `t` whose key is b[from, to), else -1. */
function findOther(t: Others, b: Uint8Array, from: number, to: number, h: number): number {
  const mask = t.slots.length - 1;
  const n = to - from;
  const tags = otherTags(t);
  const tag = h >>> 24;
  for (let s = h & mask; ; s = (s + 1) & mask) {
    const e = t.slots[s]!;
    if (e === 0) return -1;
    if (tags !== undefined && tags[s] !== tag) continue;
    const end = t.ends[e - 1]!;
    const start = e === 1 ? 0 : t.ends[e - 2]!;
    if (end - start !== n) continue;
    let i = 0;
    while (i < n && t.bytes[start + i] === b[from + i]) i += 1;
    if (i === n) return e - 1;
  }
}

/** Entry `e` put in a free slot of `t` for its key's hash `h`, with its tag. */
function put(t: Table, tags: Uint8Array | undefined, h: number, e: number): void {
  const mask = t.slots.length - 1;
  let s = h & mask;
  while (t.slots[s] !== 0) s = (s + 1) & mask;
  t.slots[s] = e + 1;
  if (tags !== undefined) tags[s] = h >>> 24;
}

/** Room in `t` for one more entry: its entries' arrays and its slots doubled when full. */
function roomUuid(t: Uuids): void {
  if (t.count === t.owners.length) {
    t.owners = grown(t.owners, t.owners.length * 2) as Int32Array;
    t.words = grown(t.words, t.words.length * 2) as Int32Array;
  }
  if (t.count + 1 > t.slots.length * LOAD) {
    t.slots = new Int32Array(t.slots.length * 2);
    const tags = t.slots.length >= TAGGED ? (t.tags = new Uint8Array(t.slots.length)) : undefined;
    for (let i = 0; i < t.count; i += 1) put(t, tags, uuidHash(t.words[i * 4]!, t.words[i * 4 + 1]!, t.words[i * 4 + 2]!, t.words[i * 4 + 3]!), i);
  }
}

function roomOther(t: Others, n: number): void {
  if (t.count === t.owners.length) {
    t.owners = grown(t.owners, t.owners.length * 2) as Int32Array;
    t.ends = grown(t.ends, t.ends.length * 2) as Float64Array;
  }
  if (t.used + n > t.bytes.length) t.bytes = grown(t.bytes, Math.max(t.bytes.length * 2, t.used + n)) as Uint8Array;
  if (t.count + 1 > t.slots.length * LOAD) {
    t.slots = new Int32Array(t.slots.length * 2);
    const tags = t.slots.length >= TAGGED ? (t.tags = new Uint8Array(t.slots.length)) : undefined;
    for (let i = 0; i < t.count; i += 1) put(t, tags, bytesHash(t.bytes, i === 0 ? 0 : t.ends[i - 1]!, t.ends[i]!), i);
  }
}

function grown<T extends Int32Array | Float64Array | Uint8Array>(from: T, length: number): T {
  const to = new (from.constructor as new (n: number) => T)(length);
  to.set(from);
  return to;
}

function addUuid(t: Uuids, w0: number, w1: number, w2: number, w3: number, owner: number): void {
  roomUuid(t);
  const i = t.count++;
  t.words[i * 4] = w0;
  t.words[i * 4 + 1] = w1;
  t.words[i * 4 + 2] = w2;
  t.words[i * 4 + 3] = w3;
  t.owners[i] = owner;
  put(t, uuidTags(t), uuidHash(w0, w1, w2, w3), i);
}

function addOther(t: Others, b: Uint8Array, from: number, to: number, owner: number): void {
  roomOther(t, to - from);
  const i = t.count++;
  t.bytes.set(b.subarray(from, to), t.used);
  t.used += to - from;
  t.ends[i] = t.used;
  t.owners[i] = owner;
  put(t, otherTags(t), bytesHash(b, from, to), i);
}

/** The owner (its number) of the record packed as `key`, else -1. */
export function ownerOf(index: RecordIndex, { bytes, length }: Packed): number {
  if (bytes[0] === UUID && length === 17) {
    const w0 = word(bytes, 1);
    const w1 = word(bytes, 5);
    const w2 = word(bytes, 9);
    const w3 = word(bytes, 13);
    const e = findUuid(index.uuids, w0, w1, w2, w3, uuidHash(w0, w1, w2, w3));
    return e === -1 ? -1 : index.uuids.owners[e]!;
  }
  const e = findOther(index.others, bytes, 0, length, bytesHash(bytes, 0, length));
  return e === -1 ? -1 : index.others.owners[e]!;
}

/** The record packed as `key` added, owned by `owner` (a number of the index the owners refer to); one held already is
 *  left as it is. */
export function addRecord(index: RecordIndex, key: Packed, owner: number): void {
  if (ownerOf(index, key) === -1) addNew(index, key, owner);
}

/** The record packed as `key` added, owned by `owner`, where `index` is known not to hold it (ownerOf gave -1 for it,
 *  and nothing was added since): addRecord without looking it up again. */
export function addNew(index: RecordIndex, key: Packed, owner: number): void {
  const { bytes, length } = key;
  if (bytes[0] === UUID && length === 17) addUuid(index.uuids, word(bytes, 1), word(bytes, 5), word(bytes, 9), word(bytes, 13), owner);
  else addOther(index.others, bytes, 0, length, owner);
}

/** Every record of `from` added to `into`, in the order `from` took them, each with its owner. */
export function addAll(into: RecordIndex, from: RecordIndex): void {
  const u = from.uuids;
  for (let i = 0; i < u.count; i += 1) {
    const w0 = u.words[i * 4]!;
    const w1 = u.words[i * 4 + 1]!;
    const w2 = u.words[i * 4 + 2]!;
    const w3 = u.words[i * 4 + 3]!;
    if (findUuid(into.uuids, w0, w1, w2, w3, uuidHash(w0, w1, w2, w3)) === -1) addUuid(into.uuids, w0, w1, w2, w3, u.owners[i]!);
  }
  const o = from.others;
  for (let i = 0; i < o.count; i += 1) {
    const start = i === 0 ? 0 : o.ends[i - 1]!;
    const end = o.ends[i]!;
    if (findOther(into.others, o.bytes, start, end, bytesHash(o.bytes, start, end)) === -1) addOther(into.others, o.bytes, start, end, o.owners[i]!);
  }
}

/** Every record of `from` added to `into`, where the two hold no record in common: per kind of key, the table with more
 *  entries keeps its arrays and the other's entries are added to it, so a big read's records are not copied (and held
 *  twice) to join a smaller index. `from` is used up: it holds what `into` held. */
export function addDisjoint(into: RecordIndex, from: RecordIndex): void {
  if (from.uuids.count > into.uuids.count) [into.uuids, from.uuids] = [from.uuids, into.uuids];
  if (from.others.count > into.others.count) [into.others, from.others] = [from.others, into.others];
  addAll(into, from);
}

/** Where `index`'s entries end now: undoTo takes it back there. */
export type Mark = { uuids: number; others: number; used: number };
export const markOf = (index: RecordIndex): Mark => ({ uuids: index.uuids.count, others: index.others.count, used: index.others.used });

/** The slot of `t` holding entry `e`, found from the key's hash. */
function slotOf(t: Table, e: number, h: number): number {
  const mask = t.slots.length - 1;
  let s = h & mask;
  while (t.slots[s] !== e + 1) s = (s + 1) & mask;
  return s;
}

/** `index` as it was at `mark`: the entries added since taken out, last first. With linear probing, taking out the
 *  last entry added leaves the slots as they were before it (a grow puts the entries back in their order, so this holds
 *  across one), at the cost of the entries taken out, where dropOwner rebuilds the whole index. */
export function undoTo(index: RecordIndex, mark: Mark): void {
  const u = index.uuids;
  for (let i = u.count - 1; i >= mark.uuids; i -= 1) u.slots[slotOf(u, i, uuidHash(u.words[i * 4]!, u.words[i * 4 + 1]!, u.words[i * 4 + 2]!, u.words[i * 4 + 3]!))] = 0;
  u.count = Math.min(u.count, mark.uuids);
  const o = index.others;
  for (let i = o.count - 1; i >= mark.others; i -= 1) o.slots[slotOf(o, i, bytesHash(o.bytes, i === 0 ? 0 : o.ends[i - 1]!, o.ends[i]!))] = 0;
  if (o.count > mark.others) {
    o.count = mark.others;
    o.used = mark.used;
  }
}

/** `index` without the records `owner` owns: the rest kept in their order. */
export function dropOwner(index: RecordIndex, owner: number): void {
  const u = index.uuids;
  const o = index.others;
  const kept = recordIndex();
  kept.locators = index.locators;
  kept.numbers = index.numbers;
  for (let i = 0; i < u.count; i += 1) if (u.owners[i] !== owner) addUuid(kept.uuids, u.words[i * 4]!, u.words[i * 4 + 1]!, u.words[i * 4 + 2]!, u.words[i * 4 + 3]!, u.owners[i]!);
  for (let i = 0; i < o.count; i += 1) if (o.owners[i] !== owner) addOther(kept.others, o.bytes, i === 0 ? 0 : o.ends[i - 1]!, o.ends[i]!, o.owners[i]!);
  index.uuids = kept.uuids;
  index.others = kept.others;
}

/** Each record of `from` packed, in the order taken, until `stop` returns true for one: whether one did. */
export function someRecord(from: RecordIndex, stop: (key: Packed) => boolean): boolean {
  const key: Packed = { bytes: new Uint8Array(64), length: 0 };
  const u = from.uuids;
  key.bytes[0] = UUID;
  key.length = 17;
  for (let i = 0; i < u.count; i += 1) {
    for (let k = 0; k < 4; k += 1) {
      const w = u.words[i * 4 + k]!;
      key.bytes[1 + k * 4] = w & 0xff;
      key.bytes[2 + k * 4] = (w >>> 8) & 0xff;
      key.bytes[3 + k * 4] = (w >>> 16) & 0xff;
      key.bytes[4 + k * 4] = (w >>> 24) & 0xff;
    }
    if (stop(key)) return true;
  }
  const o = from.others;
  for (let i = 0; i < o.count; i += 1) {
    const start = i === 0 ? 0 : o.ends[i - 1]!;
    const end = o.ends[i]!;
    if (key.bytes.length < end - start) key.bytes = new Uint8Array((end - start) * 2);
    key.bytes.set(o.bytes.subarray(start, end));
    key.length = end - start;
    if (stop(key)) return true;
  }
  return false;
}

/** Every record of `index` now owned by `owner`. */
export function ownAll(index: RecordIndex, owner: number): void {
  index.uuids.owners.fill(owner, 0, index.uuids.count);
  index.others.owners.fill(owner, 0, index.others.count);
}
