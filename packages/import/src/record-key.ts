// The keys of the records an import has read (a reader's "u:<uuid>", "m:<message id>:<request id>", "l:<message id>"),
// packed for the index that holds one per record across a source: a large home has tens of millions. One-to-one: two
// keys pack the same only when they are the same, so no record is taken for a copy that is not one. Packed keys are the
// index's alone; nothing reads them back.
//   "u:" and a uuid as Claude Code writes it (lowercase hex, 8-4-4-4-12)  \x01 and its 16 bytes (17 chars, of 38)
//   any other made only of [0-9A-Za-z_:]                                   \x02..\x05 (its length mod 4), six bits a char
//   anything else                                                          \x00 and the key as it is

const UUID = 1;
const SIXES = 2;
const AS_IS = "\0";

// Each char code's value: a lowercase hex digit's (else -1), and its place among the 64 letters (else -1).
const HEX = new Int8Array(128).fill(-1);
for (let i = 0; i < 16; i += 1) HEX["0123456789abcdef".charCodeAt(i)] = i;
const LETTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_:";
const SIX = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i += 1) SIX[LETTERS.charCodeAt(i)] = i;

const bytes: number[] = [];

/** "u:<uuid>" as the uuid's 16 bytes, else undefined. */
function uuidKey(key: string): string | undefined {
  if (key.length !== 38 || key.charCodeAt(0) !== 117 || key.charCodeAt(1) !== 58) return undefined;
  bytes.length = 0;
  bytes.push(UUID);
  let high = -1;
  for (let i = 2; i < 38; i += 1) {
    const code = key.charCodeAt(i);
    // The hyphens at 8, 13, 18 and 23 of the uuid.
    if (i === 10 || i === 15 || i === 20 || i === 25) {
      if (code !== 45) return undefined;
      continue;
    }
    const digit = code < 128 ? HEX[code]! : -1;
    if (digit === -1) return undefined;
    if (high === -1) high = digit;
    else {
      bytes.push((high << 4) | digit);
      high = -1;
    }
  }
  return String.fromCharCode.apply(null, bytes);
}

/** A key of the 64 letters alone, six bits a char, else undefined. */
function sixesKey(key: string): string | undefined {
  const n = key.length;
  bytes.length = 0;
  bytes.push(SIXES + (n % 4));
  let bits = 0;
  let held = 0;
  for (let i = 0; i < n; i += 1) {
    const code = key.charCodeAt(i);
    const six = code < 128 ? SIX[code]! : -1;
    if (six === -1) return undefined;
    held = (held << 6) | six;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((held >> bits) & 0xff);
      held &= (1 << bits) - 1;
    }
  }
  if (bits > 0) bytes.push((held << (8 - bits)) & 0xff);
  return String.fromCharCode.apply(null, bytes);
}

/** `key` as the record index holds it: a one-byte string, shorter than the key for a reader's usual ones. */
export function packKey(key: string): string {
  return uuidKey(key) ?? (key.length <= 4096 ? sixesKey(key) : undefined) ?? AS_IS + key;
}
