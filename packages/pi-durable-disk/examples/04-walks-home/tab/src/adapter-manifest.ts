// A base and its adapters on the run's disk (proposal). The base is described once: its sha256, its chunks, and the model its weights came
// from. Each adapter names that same model, its own sha256, size and chunks, what it adds (a skill or an obsession, and a label), the scale
// it was trained to run at, and its rank and alpha. A homecoming whose base is already cached fetches only the adapter: tens of MB instead
// of a merged model's 806 MB. Pure, like model.ts: the reads and the hash are the caller's. The format:
//   home/base/chunk-0000.bin ..., home/adapters/<stem>/chunk-0000.bin ..., then home/manifest.json written LAST:
//   {format: "gguf-base-adapters-v1",
//    base: {name, quant, model: {repo, revision}, size, sha256, chunk_bytes, chunks: [{n, path, offset, size, sha256}]},
//    adapters: [{name: "<stem>.gguf", kind: "skill" | "obsession", topic, model: {repo, revision}, rank, alpha, scale, dtype,
//                verified_on?: [base sha256], size, sha256, chunk_bytes, chunks: [...]}]}
// An adapter fits the base when both name the same model (repo and revision): it then fits any quantization of it. Measured: the stock
// ggml-org Q4_K_M and the trainer's own Q4_K_M of gemma-3-1b-it gave token-identical greedy output with the same adapter.

import { cut, MAX_CHUNK_BYTES, MAX_MODEL_BYTES, ModelError, type ChunkEntry } from './model.ts';

export const BASE_ADAPTERS_MANIFEST_PATH = 'home/manifest.json';
/** An adapter is a LoRA over a 1B base: r 32 at f16 is 52 MB. Far past this it is not an adapter. */
export const MAX_ADAPTER_BYTES = 256 * 1024 * 1024;
export const MAX_ADAPTER_SCALE = 4;

export interface ModelRef { repo: string; revision: string }
export interface ChunkedFile { size: number; sha256: string; chunk_bytes: number; chunks: ChunkEntry[] }
export interface BaseEntry extends ChunkedFile { name: string; quant: string; model: ModelRef }
export interface AdapterEntry extends ChunkedFile {
  /** Its file name in wllama's filesystem and its key in a request's selection: `<stem>.gguf`. */
  name: string;
  kind: 'skill' | 'obsession';
  /** What it adds, as a label (shown as plain text). */
  topic: string;
  model: ModelRef;
  rank: number;
  alpha: number;
  /** The scale it was trained to run at (normally 1). */
  scale: number;
  dtype: 'f16' | 'q8_0' | 'f32';
  /** sha256 of the base files it was checked against, if any. */
  verified_on?: string[];
}
export interface BaseAdaptersManifest { format: 'gguf-base-adapters-v1'; base: BaseEntry; adapters: AdapterEntry[] }

const HEX = /^[0-9a-f]{64}$/;
const STEM = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REVISION = /^[0-9a-f]{40}$/;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const pad = (n: number) => String(n).padStart(4, '0');
export const baseChunkPath = (n: number) => `home/base/chunk-${pad(n)}.bin`;
export const adapterChunkPath = (stem: string, n: number) => `home/adapters/${stem}/chunk-${pad(n)}.bin`;

/** A chunked file's fields, checked: every chunk's path is fixed by its index, so a manifest cannot point the tab anywhere else. */
function chunked(label: string, f: any, maxBytes: number, pathOf: (n: number) => string): ChunkedFile {
  if (!f || typeof f !== 'object') throw new ModelError(`${label} is not an object`);
  if (!isInt(f.size) || f.size < 1) throw new ModelError(`${label}: size is not a positive whole number`);
  if (f.size > maxBytes) throw new ModelError(`${label}: size ${f.size} is over the limit of ${maxBytes}`);
  if (typeof f.sha256 !== 'string' || !HEX.test(f.sha256)) throw new ModelError(`${label}: sha256 is not 64 lowercase hex digits`);
  if (!isInt(f.chunk_bytes) || f.chunk_bytes < 1 || f.chunk_bytes > MAX_CHUNK_BYTES) throw new ModelError(`${label}: chunk_bytes ${f.chunk_bytes} is outside 1..${MAX_CHUNK_BYTES}`);
  if (!Array.isArray(f.chunks) || f.chunks.length === 0) throw new ModelError(`${label}: no chunks`);
  let total = 0;
  f.chunks.forEach((c: any, i: number) => {
    if (!c || c.n !== i) throw new ModelError(`${label} chunk ${i}: n is ${c?.n}, expected ${i}`);
    if (c.path !== pathOf(i)) throw new ModelError(`${label} chunk ${i}: path ${JSON.stringify(c.path)} is not ${pathOf(i)}`);
    if (c.offset !== i * f.chunk_bytes) throw new ModelError(`${label} chunk ${i}: offset ${c.offset} is not ${i * f.chunk_bytes}`);
    const want = Math.min(f.chunk_bytes, f.size - c.offset);
    if (c.size !== want) throw new ModelError(`${label} chunk ${i}: size ${c.size} is not ${want}`);
    if (typeof c.sha256 !== 'string' || !HEX.test(c.sha256)) throw new ModelError(`${label} chunk ${i}: sha256 is not 64 lowercase hex digits`);
    total += c.size;
  });
  if (total !== f.size) throw new ModelError(`${label}: the chunks add up to ${total} bytes but size says ${f.size}`);
  return { size: f.size, sha256: f.sha256, chunk_bytes: f.chunk_bytes, chunks: f.chunks };
}

function modelRef(label: string, m: any): ModelRef {
  if (!m || typeof m.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(m.repo)) throw new ModelError(`${label}: model.repo is not owner/name`);
  if (typeof m.revision !== 'string' || !REVISION.test(m.revision)) throw new ModelError(`${label}: model.revision is not a 40-digit commit`);
  return { repo: m.repo, revision: m.revision };
}

const label = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? cut(v, 80) : undefined);

/** The manifest as the trainer wrote it, or a ModelError naming the field that is wrong. An adapter for another base model is refused. */
export function parseBaseAdapters(text: string): BaseAdaptersManifest {
  let m: any;
  try { m = JSON.parse(text); } catch { throw new ModelError('the manifest is not valid JSON'); }
  if (!m || typeof m !== 'object') throw new ModelError('the manifest is not an object');
  if (m.format !== 'gguf-base-adapters-v1') throw new ModelError(`the manifest format is ${JSON.stringify(m.format)}, not gguf-base-adapters-v1`);
  const b = m.base;
  const base: BaseEntry = { name: label(b?.name) ?? 'base', quant: String(b?.quant ?? ''), model: modelRef('base', b?.model), ...chunked('base', b, MAX_MODEL_BYTES, baseChunkPath) };
  if (!Array.isArray(m.adapters)) throw new ModelError('the manifest has no adapters list');
  const names = new Set<string>();
  const adapters = m.adapters.map((a: any, i: number): AdapterEntry => {
    const stem = typeof a?.name === 'string' && a.name.endsWith('.gguf') ? a.name.slice(0, -'.gguf'.length) : '';
    if (!STEM.test(stem)) throw new ModelError(`adapter ${i}: name ${JSON.stringify(a?.name)} is not <stem>.gguf with a lowercase stem`);
    if (names.has(a.name)) throw new ModelError(`adapter ${a.name} is listed twice`);
    names.add(a.name);
    const model = modelRef(a.name, a.model);
    if (model.repo !== base.model.repo || model.revision !== base.model.revision) {
      throw new ModelError(`adapter ${a.name} was trained on ${model.repo}@${model.revision.slice(0, 8)}, not on the base's ${base.model.repo}@${base.model.revision.slice(0, 8)}`);
    }
    if (a.kind !== 'skill' && a.kind !== 'obsession') throw new ModelError(`adapter ${a.name}: kind ${JSON.stringify(a.kind)} is not skill or obsession`);
    const topic = label(a.topic);
    if (!topic) throw new ModelError(`adapter ${a.name}: no topic`);
    if (!isInt(a.rank) || a.rank < 1 || typeof a.alpha !== 'number' || !(a.alpha > 0)) throw new ModelError(`adapter ${a.name}: rank and alpha must be positive`);
    if (typeof a.scale !== 'number' || !(a.scale > 0) || a.scale > MAX_ADAPTER_SCALE) throw new ModelError(`adapter ${a.name}: scale ${a.scale} is outside (0, ${MAX_ADAPTER_SCALE}]`);
    if (a.dtype !== 'f16' && a.dtype !== 'q8_0' && a.dtype !== 'f32') throw new ModelError(`adapter ${a.name}: dtype ${JSON.stringify(a.dtype)} is not f16, q8_0 or f32`);
    const verified = Array.isArray(a.verified_on) ? a.verified_on.filter((s: unknown) => typeof s === 'string' && HEX.test(s)) : [];
    return {
      name: a.name, kind: a.kind, topic, model, rank: a.rank, alpha: a.alpha, scale: a.scale, dtype: a.dtype,
      ...(verified.length ? { verified_on: verified } : {}),
      ...chunked(`adapter ${a.name}`, a, MAX_ADAPTER_BYTES, (n) => adapterChunkPath(stem, n)),
    };
  });
  return { format: 'gguf-base-adapters-v1', base, adapters };
}

export interface HomecomingPlan {
  /** Fetch the base: false when a file with its sha256 is already cached. */
  base: boolean;
  /** The adapters to fetch, by name: the ones whose sha256 is not cached yet. */
  adapters: string[];
  /** The bytes those fetches add up to. */
  bytes: number;
}

/** What a homecoming has to download, given what the tab already holds (by sha256). */
export function planHomecoming(m: BaseAdaptersManifest, cached: (sha256: string) => boolean): HomecomingPlan {
  const base = !cached(m.base.sha256);
  const adapters = m.adapters.filter((a) => !cached(a.sha256));
  return { base, adapters: adapters.map((a) => a.name), bytes: (base ? m.base.size : 0) + adapters.reduce((n, a) => n + a.size, 0) };
}
