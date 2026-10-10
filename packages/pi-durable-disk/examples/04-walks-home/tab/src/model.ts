// The trained model coming home: a manifest and chunk files on the run's disk, fetched, checked and assembled into the bytes of one GGUF.
// Pure and injected (the disk read and the hash are passed in), so the rules are tested in node. The format is agreed with the trainer:
//   home/model/chunk-0000.bin ... (16 MiB each except the last), then home/model/manifest.json written LAST (its appearance is the go signal):
//   {format:"gguf-chunks-v1", name, quant, size, sha256, chunk_bytes, chunks:[{n, path, offset, size, sha256}]}

export class ModelError extends Error {}

export const MANIFEST_PATH = 'home/model/manifest.json';
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** wllama holds the file in one buffer, which browsers cap at 2 GB. */
export const MAX_MODEL_BYTES = 2_000_000_000;

export interface ChunkEntry { n: number; path: string; offset: number; size: number; sha256: string }
export interface Manifest {
  format: 'gguf-chunks-v1'; name: string; quant: string; size: number; sha256: string; chunk_bytes: number; chunks: ChunkEntry[];
  /** What the model was made to be obsessed with, and the mechanism that taught it, as the run's own labels (optional; shown in the model card as plain text). */
  topic?: string;
  mechanism?: string;
}

const HEX = /^[0-9a-f]{64}$/;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
export const chunkPath = (n: number) => `home/model/chunk-${String(n).padStart(4, '0')}.bin`;

/** The manifest as the trainer wrote it, or a ModelError saying which field is wrong. Every chunk's place is fixed by its index, so a manifest cannot point the tab at another path. */
export function parseManifest(text: string): Manifest {
  let m: any;
  try { m = JSON.parse(text); } catch { throw new ModelError('the manifest is not valid JSON'); }
  if (!m || typeof m !== 'object') throw new ModelError('the manifest is not an object');
  if (m.format !== 'gguf-chunks-v1') throw new ModelError(`the manifest format is ${JSON.stringify(m.format)}, not gguf-chunks-v1`);
  if (!isInt(m.size) || m.size < 1) throw new ModelError('the manifest size is not a positive whole number');
  if (m.size > MAX_MODEL_BYTES) throw new ModelError(`the model (size ${m.size}) is too large for the tab: the limit is ${MAX_MODEL_BYTES}`);
  if (typeof m.sha256 !== 'string' || !HEX.test(m.sha256)) throw new ModelError('the manifest sha256 is not 64 lowercase hex digits');
  if (!isInt(m.chunk_bytes) || m.chunk_bytes < 1 || m.chunk_bytes > MAX_CHUNK_BYTES) throw new ModelError(`chunk_bytes ${m.chunk_bytes} is outside 1..${MAX_CHUNK_BYTES}`);
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) throw new ModelError('the manifest lists no chunks');
  let total = 0;
  m.chunks.forEach((c: any, i: number) => {
    if (!c || c.n !== i) throw new ModelError(`chunk ${i}: n is ${c?.n}, expected ${i}`);
    if (c.path !== chunkPath(i)) throw new ModelError(`chunk ${i}: path ${JSON.stringify(c.path)} is not ${chunkPath(i)}`);
    if (c.offset !== i * m.chunk_bytes) throw new ModelError(`chunk ${i}: offset ${c.offset} is not ${i * m.chunk_bytes}`);
    const want = Math.min(m.chunk_bytes, m.size - c.offset);
    if (c.size !== want) throw new ModelError(`chunk ${i}: size ${c.size} is not ${want}`);
    if (typeof c.sha256 !== 'string' || !HEX.test(c.sha256)) throw new ModelError(`chunk ${i}: sha256 is not 64 lowercase hex digits`);
    total += c.size;
  });
  if (total !== m.size) throw new ModelError(`the chunks add up to ${total} bytes but size says ${m.size}`);
  const label = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, 80) : undefined);
  const topic = label(m.topic), mechanism = label(m.mechanism);
  return { format: 'gguf-chunks-v1', name: String(m.name ?? 'model'), quant: String(m.quant ?? ''), size: m.size, sha256: m.sha256, chunk_bytes: m.chunk_bytes, chunks: m.chunks, ...(topic ? { topic } : {}), ...(mechanism ? { mechanism } : {}) };
}

export interface FetchDeps {
  /** One chunk's bytes from the run's disk; null when it is not there. */
  readChunk(path: string): Promise<Uint8Array | null>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** How many chunks are in flight at once: the disk's per-read latency, not its bandwidth, dominates. */
  parallel?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Fetch every chunk, checking length and sha256 against the manifest (one retry each), and return them in manifest order. Nothing is
 * returned when any chunk fails. The whole-file sha256 in the manifest is the trainer's claim: each chunk is verified against its own
 * hash from the same manifest, and the whole file is not hashed again in the tab (the browser cannot hash incrementally).
 */
export async function fetchModel(m: Manifest, deps: FetchDeps): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = new Array(m.chunks.length);
  let next = 0, done = 0;
  const one = async (c: ChunkEntry) => {
    let why = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      let bytes: Uint8Array | null = null;
      try { bytes = await deps.readChunk(c.path); } catch (e) { why = `could not be read (${e instanceof Error ? e.message : String(e)})`; continue; }
      if (!bytes) { why = 'is missing on the disk (not found)'; continue; }
      if (bytes.length !== c.size) { why = `has ${bytes.length} bytes, the manifest says ${c.size}`; continue; }
      if ((await deps.sha256(bytes)) !== c.sha256) { why = 'failed its sha256 check'; continue; }
      parts[c.n] = bytes;
      deps.onProgress?.(++done, m.chunks.length);
      return;
    }
    throw new ModelError(`chunk ${c.n} ${why}`);
  };
  let failed: Error | null = null;
  const worker = async () => {
    while (!failed && next < m.chunks.length) {
      try { await one(m.chunks[next++]); } catch (e) { failed = e as Error; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.parallel ?? 4) }, worker));
  if (failed) throw failed;
  return parts;
}
