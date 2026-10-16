// Mirrors canonicalHash (packages/dsl/src/recovery/canonical-hash.ts) and gatewayIntentOf (packages/dsl/src/recovery/handoff-receipts.ts): change them together.
import type { Json } from './format.ts';

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of a string's UTF-8 bytes, as lowercase hex. */
export const sha256Hex = (text: string): string => sha256OfBytes(new TextEncoder().encode(text));

/** One 64-byte block at `at` of `view` folded into the state `h`. */
function sha256Block(h: Uint32Array, view: DataView, at: number, w: Uint32Array): void {
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(at + i * 4);
  for (let i = 16; i < 64; i += 1) {
    const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
    const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
  for (let i = 0; i < 64; i += 1) {
    const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i]! + w[i]!) >>> 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d; h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + hh;
}

/** The bytes after the last whole block, padded and ending in the message's length in bits: one or two blocks. */
function sha256Tail(bytes: Uint8Array): DataView {
  const rest = bytes.length & 63;
  const tail = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  tail.set(bytes.subarray(bytes.length - rest));
  tail[rest] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor((bytes.length * 8) / 0x100000000));
  view.setUint32(tail.length - 4, (bytes.length * 8) >>> 0);
  return view;
}

const SHA_INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
/** Bytes hashed between two pauses: a MiB, a whole number of blocks. */
const SHA_SLICE = 1 << 20;

/** The whole blocks of `bytes` from `from` to `to` folded into `h`, read where they are (never copied). */
function sha256Blocks(h: Uint32Array, bytes: Uint8Array, from: number, to: number, w: Uint32Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = from; at < to; at += 64) sha256Block(h, view, at, w);
}

/** The digest once every whole block is folded in: the padded tail, then the state as lowercase hex. */
function sha256Finish(h: Uint32Array, bytes: Uint8Array, w: Uint32Array): string {
  const tail = sha256Tail(bytes);
  for (let at = 0; at < tail.byteLength; at += 64) sha256Block(h, tail, at, w);
  return [...h].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/** SHA-256 of bytes, as lowercase hex. */
export function sha256OfBytes(bytes: Uint8Array): string {
  const h = Uint32Array.from(SHA_INIT);
  const w = new Uint32Array(64);
  sha256Blocks(h, bytes, 0, bytes.length - (bytes.length & 63), w);
  return sha256Finish(h, bytes, w);
}

/** `sha256OfBytes` a MiB at a time, awaiting `pause` between slices: a large blob hashed on the page's own thread gives
 *  the page back to draw and answer between them. */
export async function sha256Paused(bytes: Uint8Array, pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0))): Promise<string> {
  const h = Uint32Array.from(SHA_INIT);
  const w = new Uint32Array(64);
  const whole = bytes.length - (bytes.length & 63);
  for (let at = 0; at < whole; at += SHA_SLICE) {
    if (at > 0) await pause();
    sha256Blocks(h, bytes, at, Math.min(whole, at + SHA_SLICE), w);
  }
  return sha256Finish(h, bytes, w);
}

/** `canonicalHash` of the DSL: SHA-256 of the value's JSON with every object's keys sorted, independent of key order. */
export const argsHashOf = (value: Json | undefined): string =>
  sha256Hex(JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, Json>)[key]])) : item)) ?? 'undefined');

/** The receipt key of a model's tool call: the gateway tool a `fetch` wrapper names and the hash of its arguments, else the tool and the
 *  hash of its own arguments (`gatewayIntentOf`). */
export function receiptKeyOf(name: string, args: Json | undefined): string {
  const wrapped = args && typeof args === 'object' && !Array.isArray(args) ? args : undefined;
  if (name === 'fetch' && wrapped && typeof wrapped.tool === 'string' && wrapped.args && typeof wrapped.args === 'object' && !Array.isArray(wrapped.args)) return `${wrapped.tool}:${argsHashOf(wrapped.args)}`;
  return `${name}:${argsHashOf(args ?? {})}`;
}
