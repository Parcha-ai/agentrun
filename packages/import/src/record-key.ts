// The keys of the records an import has read (a reader's "u:<uuid>", "m:<message id>:<request id>", "l:<message id>"),
// packed into bytes for the index that holds one per record across a source (RecordIndex): a large home has tens of
// millions. One-to-one: two keys pack the same only when they are the same, so no record is taken for a copy that is not
// one. Packed keys are the index's alone; nothing reads them back. The first byte says how the rest is packed:
//   1    "u:" and a uuid as Claude Code writes it (lowercase hex, 8-4-4-4-12): its 16 bytes
//   2-5  any other key made only of [0-9A-Za-z_:]: six bits a char; the byte is 2 + its length mod 4
//   0    anything else: its UTF-16 code units, two bytes each, low byte first

export const UUID = 1;
const SIXES = 2;
const AS_IS = 0;

// Each char code's value: a lowercase hex digit's (else -1), and its place among the 64 letters (else -1).
const HEX = new Int8Array(128).fill(-1);
for (let i = 0; i < 16; i += 1) HEX["0123456789abcdef".charCodeAt(i)] = i;
const LETTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_:";
const SIX = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i += 1) SIX[LETTERS.charCodeAt(i)] = i;

/** A key packed: `bytes[0, length)`. The buffer is reused by the next packInto with the same Packed. */
export type Packed = { bytes: Uint8Array; length: number };

export const packed = (): Packed => ({ bytes: new Uint8Array(64), length: 0 });

/** "u:<uuid>" into `out` as its 16 bytes; false (out unset) for any other key. */
function uuidInto(key: string, out: Uint8Array): boolean {
  if (key.length !== 38 || key.charCodeAt(0) !== 117 || key.charCodeAt(1) !== 58) return false;
  out[0] = UUID;
  let at = 1;
  let high = -1;
  for (let i = 2; i < 38; i += 1) {
    const code = key.charCodeAt(i);
    // The hyphens at 8, 13, 18 and 23 of the uuid.
    if (i === 10 || i === 15 || i === 20 || i === 25) {
      if (code !== 45) return false;
      continue;
    }
    const digit = code < 128 ? HEX[code]! : -1;
    if (digit === -1) return false;
    if (high === -1) high = digit;
    else {
      out[at++] = (high << 4) | digit;
      high = -1;
    }
  }
  return true;
}

/** A key of the 64 letters into `out`, six bits a char: its packed length, -1 for any other key. */
function sixesInto(key: string, out: Uint8Array): number {
  const n = key.length;
  out[0] = SIXES + (n % 4);
  let at = 1;
  let bits = 0;
  let held = 0;
  for (let i = 0; i < n; i += 1) {
    const code = key.charCodeAt(i);
    const six = code < 128 ? SIX[code]! : -1;
    if (six === -1) return -1;
    held = (held << 6) | six;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 0xff;
      held &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out[at++] = (held << (8 - bits)) & 0xff;
  return at;
}

/** `key` packed into `out`, its buffer grown when the key needs more. */
export function packInto(key: string, out: Packed): Packed {
  if (out.bytes.length < 1 + key.length * 2) out.bytes = new Uint8Array(Math.max(1 + key.length * 2, out.bytes.length * 2));
  const bytes = out.bytes;
  if (uuidInto(key, bytes)) {
    out.length = 17;
    return out;
  }
  const six = sixesInto(key, bytes);
  if (six !== -1) {
    out.length = six;
    return out;
  }
  bytes[0] = AS_IS;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    bytes[1 + i * 2] = code & 0xff;
    bytes[2 + i * 2] = code >> 8;
  }
  out.length = 1 + key.length * 2;
  return out;
}
