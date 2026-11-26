// A JSONL line read for the fields a totals read takes (LineSource.fields), from its bytes: what JSON.parse of the
// decoded line gives, cut to those fields, with every other value validated where it lies and never decoded. A session
// file is mostly what no total reads (tool results, file bodies, reasoning, message text), and building it all as
// strings and objects is most of a read's time. The walk is wasm/scan.rs's, built into scan-wasm.ts: it checks each byte
// as JSON.parse checks the text and says where the read values lie, which this builds. Whatever the walk is not sure of
// it leaves to JSON.parse: scan gives undefined, never a guess, and the caller parses the line as before. So a line
// JSON.parse rejects is never read here, and one it takes gives the same fields.
import { SCAN_WASM } from "./scan-wasm.js";

/** The fields of a record a source reads: each by name, `true` for its value whole, a Shape for an object of which only
 *  these fields are read, [Shape] for an array whose objects are read so. A value of another kind than its Shape names
 *  (an array where an object is, a string where an array is) is taken whole, and so is an array's element that is no
 *  object. A field the line has twice is the last one, as JSON.parse takes it. */
export type Shape = { readonly [field: string]: true | Shape | readonly [Shape] };

/** A Shape compiled: its node in the walk's table, written there on first use (-1 where the table has no room). */
export type Fields = { shape: Shape; node?: number };

const SAFE_KEY = /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/;

/** `shape` as scan takes it. A key outside printable ASCII, or with a quote or backslash, is no field a line can be
 *  matched to byte for byte; `__proto__` is no field a plain object can be given. */
export function fieldsOf(shape: Shape): Fields {
  const check = (s: Shape): void => {
    for (const [key, value] of Object.entries(s)) {
      if (!SAFE_KEY.test(key) || key === "__proto__") throw new Error(`no field a line can name: ${JSON.stringify(key)}`);
      if (value !== true) check(Array.isArray(value) ? (value as readonly [Shape])[0] : (value as Shape));
    }
  };
  check(shape);
  return { shape };
}

type Walker = {
  memory: WebAssembly.Memory;
  base(): number;
  table(): number;
  table_room(): number;
  keys(): number;
  keys_room(): number;
  events(): number;
  walk(node: number, e: number): number;
};

let walker: Walker | undefined;
/** The walker's memory from the line's first byte, its events, and its table, each anew when the memory grows. */
let line: Buffer = Buffer.alloc(0);
let events = new Uint32Array(0);
// The table's next free word (0 is no node) and the key pool's next free byte, and each rule's key by its id (0: an
// array's element).
let tableTop = 1;
let keysTop = 0;
const named: string[] = [""];

/** The table's next free word: how much of the walk's table the fields compiled so far take (a test reads it). */
export const tableUsed = (): number => tableTop;

/** The walker, built on first use: a module of a few kilobytes, compiled where it is used (each worker its own). */
function walkerOf(): Walker {
  return (walker ??= new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(SCAN_WASM, "base64"))).exports as unknown as Walker);
}

/** `shape` written to the walker's table: its node, or -1 where the table has no room. */
function compile(w: Walker, shape: Shape): number {
  const entries = Object.entries(shape);
  const node = tableTop;
  if (node + 1 + 4 * entries.length > w.table_room()) return -1;
  tableTop += 1 + 4 * entries.length;
  const table = new Uint32Array(w.memory.buffer, w.table(), w.table_room());
  const keys = new Uint8Array(w.memory.buffer, w.keys(), w.keys_room());
  table[node] = entries.length;
  for (const [r, [key, value]] of entries.entries()) {
    if (keysTop + key.length > keys.length) return -1;
    const at = keysTop;
    keys.set(Buffer.from(key, "latin1"), at);
    keysTop += key.length;
    const each = Array.isArray(value);
    const child = value === true ? 0 : compile(w, (each ? (value as readonly [Shape])[0] : value) as Shape);
    if (child < 0) return -1;
    const id = named.push(key) - 1;
    table.set([key.length, at, (id << 2) | (value === true ? 0 : each ? 2 : 1), child], node + 1 + 4 * r);
  }
  return node;
}

/** The longest line scan reads, in the walker's memory, which holds as much as the longest line it has read for as long
 *  as the process lives: one longer is decoded as before. */
const LONGEST = 1 << 26;

/** `length` bytes of room for a line, or false where memory cannot grow to it. */
function room(w: Walker, length: number): boolean {
  const need = w.base() + length;
  const has = w.memory.buffer.byteLength;
  if (need > has) {
    try {
      w.memory.grow(Math.ceil((need - has) / 65536));
    } catch {
      return false;
    }
  }
  if (line.buffer !== w.memory.buffer) {
    line = Buffer.from(w.memory.buffer, w.base());
    events = new Uint32Array(w.memory.buffer, w.events(), 1 << 16);
  }
  return true;
}

/** Buffer's own decoder, which toString("utf8") calls after checking its arguments: a read field's string is short,
 *  and those checks are much of its decoding. The bounds are the walk's, in the line. */
type Slices = Buffer & { utf8Slice(start: number, end: number): string };

/** The value b[i, end), valid JSON and no string: an integer of up to 15 digits counted here (exact as a double), any
 *  other as JSON.parse reads it. */
function other(b: Buffer, i: number, end: number): unknown {
  const c = b[i];
  if (c === 0x74) return true;
  if (c === 0x66) return false;
  if (c === 0x6e) return null;
  if (c === 0x7b || c === 0x5b) return JSON.parse((b as Slices).utf8Slice(i, end));
  const minus = c === 0x2d;
  let j = minus ? i + 1 : i;
  if (end - j <= 15) {
    let n = 0;
    for (; j < end; j += 1) {
      const d = b[j]!;
      if (d < 0x30 || d > 0x39) break;
      n = n * 10 + (d - 0x30);
    }
    if (j === end) return minus ? -n : n;
  }
  return JSON.parse(b.toString("latin1", i, end));
}

// The walk's events (wasm/scan.rs): a word of a rule's id << 3 | its op, a value's start and end after it.
const STRING = 0;
const ESCAPED = 1;
const OPEN = 3;
const LIST = 4;
const CLOSE = 5;

/** The line b[from, to) as JSON.parse of its UTF-8 text gives it, cut to `fields`: an object; undefined for a line that
 *  is no object, is not JSON, or that scan leaves to JSON.parse (an escaped key, nested deeper than it goes, longer than
 *  it reads). */
export function scan(b: Buffer, from: number, to: number, fields: Fields): Record<string, unknown> | undefined {
  const e = to - from;
  if (e > LONGEST || from < 0 || to > b.length) return undefined;
  const w = walkerOf();
  fields.node ??= compile(w, fields.shape);
  if (fields.node < 0 || !room(w, e)) return undefined;
  b.copy(line, 0, from, to);
  const count = w.walk(fields.node, e);
  if (count < 0) return undefined;
  const root: Record<string, unknown> = {};
  const outer: (Record<string, unknown> | unknown[])[] = [];
  let at: Record<string, unknown> | unknown[] = root;
  for (let k = 0; k < count; ) {
    const word = events[k++]!;
    const op = word & 7;
    if (op === CLOSE) {
      at = outer.pop()!;
      continue;
    }
    let value: unknown;
    if (op === OPEN) value = {};
    else if (op === LIST) value = [];
    else {
      const i = events[k++]!;
      const end = events[k++]!;
      value = op === STRING ? (line as Slices).utf8Slice(i, end) : op === ESCAPED ? JSON.parse((line as Slices).utf8Slice(i, end)) : other(line, i, end);
    }
    const id = word >>> 3;
    if (id === 0) (at as unknown[]).push(value);
    else (at as Record<string, unknown>)[named[id]!] = value;
    if (op === OPEN || op === LIST) {
      outer.push(at);
      at = value as Record<string, unknown> | unknown[];
    }
  }
  return root;
}
