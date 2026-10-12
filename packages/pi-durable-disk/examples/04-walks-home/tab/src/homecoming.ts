// A homecoming over a cached base: the trainer's base-and-adapters manifest (adapter-manifest.ts) appears on the run's disk, and the tab fetches
// only the files it does not hold yet. Whole files are kept by sha256 in a FileStore (OPFS in the browser), so the 806 MB base comes home once
// and every later skill or obsession is an adapter of tens of MB. What comes back is what a load needs: the base, every adapter (each loads at
// scale 0, adapters.ts), the selection that turns the active ones on at their trained scale, and how the model is named and sampled.
// Pure and injected like model.ts (the disk, the hash, the store, the clock); `opfsFileStore` is the browser's store.

import { activeAdapters, BASE_ADAPTERS_MANIFEST_PATH, homeChunks, isBaseAdapters, parseBaseAdapters, planHomecoming, type AdapterEntry, type BaseAdaptersManifest, type ChunkedFile, type HomecomingPlan } from './adapter-manifest.ts';
import type { AdapterFile } from './adapters.ts';
import { fetchModel, MANIFEST_PATH, ModelError, parseManifest, type ChunkEntry } from './model.ts';
import type { Sampling } from './sampling.ts';

/**
 * Whole files kept by sha256. A file counts as held only when the chunk list it was stored with is the one asked for (the same size, chunk size
 * and chunk sha256s): its bytes were checked against exactly those chunks when they came home, so a manifest that names a held sha256 with
 * other chunks fetches again instead of trusting the claim.
 */
export interface FileStore {
  get(f: ChunkedFile): Promise<Blob | null>;
  /** Keep a file whose parts were each checked against `f.chunks`, and return it as kept. */
  put(f: ChunkedFile, parts: Uint8Array[]): Promise<Blob>;
}

export interface HomecomingDeps {
  /** One chunk of the run's disk (work/); null when it is not there. */
  readChunk(path: string): Promise<Uint8Array | null>;
  sha256(bytes: Uint8Array): Promise<string>;
  store: FileStore;
  /** Per file fetched: `file` is "base" or the adapter's name, `done` of `total` chunks. */
  onProgress?(p: { file: string; done: number; total: number }): void;
  now?(): number;
}

export interface Homecoming {
  manifest: BaseAdaptersManifest;
  /** Who this brain is, as a merged manifest's sha256 says it: the active adapter's sha256 (one active), else a hash over the base and the active ones. */
  id: string;
  /** For the model card: the base and what is active, the base's quantization, the bytes a load holds (the base and the active adapters). */
  name: string;
  quant: string;
  bytes: number;
  /** The active obsession's topic (else the active skill's), as the trainer labelled it. */
  topic?: string;
  /** The first active adapter's sampling settings, if it has any. */
  sampling?: Partial<Sampling>;
  base: Blob;
  /** Every adapter listed, in manifest order (the order is the id llama.cpp knows each by). */
  adapters: AdapterFile[];
  /** The selection for each request: the active adapters at their trained scale (adapters.ts `select`). */
  active: Record<string, number>;
  /** What this homecoming downloaded: the plan, its bytes, and the time from the manifest to the last file kept. */
  fetched: { plan: HomecomingPlan; bytes: number; ms: number };
}

const stemOf = (name: string) => name.replace(/\.gguf$/, '');

/** The brain's identity for a base and its active adapters: the active adapter's sha256 when there is one, else a sha256 over the base and each active one with its scale. */
async function homeId(m: BaseAdaptersManifest, on: AdapterEntry[], sha256: (b: Uint8Array) => Promise<string>): Promise<string> {
  return on.length === 1 ? on[0]!.sha256 : sha256(new TextEncoder().encode(['gguf-base-adapters-v1', m.base.sha256, ...on.map((a) => `${a.sha256}@${a.scale}`)].join('\n')));
}

/** The home manifest on the run's disk, as text: the base-and-adapters one when it is there, else a merged model's; null while the trainer has written neither. */
export async function readHomeManifest(readFile: (path: string) => Promise<Uint8Array | null>): Promise<string | null> {
  for (const path of [BASE_ADAPTERS_MANIFEST_PATH, MANIFEST_PATH]) {
    const b = await readFile(path);
    if (b) return new TextDecoder().decode(b);
  }
  return null;
}

/** What a caller that holds either kind of manifest needs before anything loads: who the brain is, its labels, and the files a copy of it needs. */
export interface HomeDescription {
  format: 'gguf-chunks-v1' | 'gguf-base-adapters-v1';
  /** Where the manifest is on the run's disk. */
  path: string;
  /** The identity a merged manifest's sha256 gives (homeId for a base and adapters). */
  id: string;
  name: string;
  quant: string;
  bytes: number;
  topic?: string;
  mechanism?: string;
  /** False while no adapter is listed: the base is on its way (prefetch it), but there is no brain to swap to yet. */
  ready: boolean;
  /** Every chunk the manifest names. */
  chunks: ChunkEntry[];
  /** The chunks an offline copy must keep in the page's cache: a merged model's; none for a base and adapters, which the FileStore already holds whole. */
  cacheChunks: ChunkEntry[];
}

/** Either manifest, described; a ModelError (from the format's own parser) when it is not one. */
export async function describeHome(text: string, sha256: (b: Uint8Array) => Promise<string>): Promise<HomeDescription> {
  if (!isBaseAdapters(text)) {
    const m = parseManifest(text);
    return { format: 'gguf-chunks-v1', path: MANIFEST_PATH, id: m.sha256, name: m.name, quant: m.quant, bytes: m.size, ...(m.topic ? { topic: m.topic } : {}), ...(m.mechanism ? { mechanism: m.mechanism } : {}), ready: true, chunks: m.chunks, cacheChunks: m.chunks };
  }
  const m = parseBaseAdapters(text);
  const on = activeAdapters(m);
  const topical = on.find((a) => a.kind === 'obsession') ?? on[0];
  return {
    format: 'gguf-base-adapters-v1', path: BASE_ADAPTERS_MANIFEST_PATH, id: await homeId(m, on, sha256),
    name: [m.base.name, ...on.map((a) => stemOf(a.name))].join(' + '), quant: m.base.quant, bytes: m.base.size + on.reduce((n, a) => n + a.size, 0),
    ...(topical ? { topic: topical.topic } : {}), ready: on.length > 0 || m.standalone === true, chunks: homeChunks(m), cacheChunks: [],
  };
}

/** Fetch what the store does not hold (each chunk checked against the manifest), keep it, and return the files a load needs. */
export async function comeHome(text: string, d: HomecomingDeps): Promise<Homecoming> {
  const m = parseBaseAdapters(text);
  const now = d.now ?? (() => Date.now());
  const t0 = now();
  const files: { label: string; entry: ChunkedFile }[] = [{ label: 'base', entry: m.base }, ...m.adapters.map((a) => ({ label: a.name, entry: a }))];
  // A file is reused, from the store or from another entry of this manifest, only when its whole chunk list matches: never by sha256 alone.
  const key = (f: ChunkedFile) => `${f.sha256}\n${chunkRecord(f)}`;
  const held = new Map<string, Blob>();
  for (const f of files) {
    if (held.has(key(f.entry))) continue;
    const blob = await d.store.get(f.entry);
    if (blob) held.set(key(f.entry), blob);
  }
  const plan = planHomecoming(m, (sha) => files.some((f) => f.entry.sha256 === sha && held.has(key(f.entry))));
  for (const f of files) {
    if (held.has(key(f.entry))) continue;
    const parts = await fetchModel(f.entry, { readChunk: d.readChunk, sha256: d.sha256, onProgress: (done, total) => d.onProgress?.({ file: f.label, done, total }) });
    held.set(key(f.entry), await d.store.put(f.entry, parts));
  }
  const blobOf = (f: ChunkedFile, label: string): Blob => {
    const b = held.get(key(f))!;
    if (b.size !== f.size) throw new ModelError(`${label}: the kept file has ${b.size} bytes, the manifest says ${f.size}`);
    return b;
  };
  const on = activeAdapters(m);
  const topical = on.find((a) => a.kind === 'obsession') ?? on[0];
  const sampled = on.find((a) => a.sampling);
  const id = await homeId(m, on, d.sha256);
  return {
    manifest: m,
    id,
    name: [m.base.name, ...on.map((a) => stemOf(a.name))].join(' + '),
    quant: m.base.quant,
    bytes: m.base.size + on.reduce((n, a) => n + a.size, 0),
    ...(topical ? { topic: topical.topic } : {}),
    ...(sampled ? { sampling: sampled.sampling } : {}),
    base: blobOf(m.base, 'base'),
    adapters: m.adapters.map((a) => ({ name: a.name, blob: blobOf(a, a.name) })),
    active: Object.fromEntries(on.map((a) => [a.name, a.scale])),
    fetched: { plan, bytes: plan.bytes, ms: now() - t0 },
  };
}

/** The chunk list a file was checked against, as the store records it. */
export const chunkRecord = (f: ChunkedFile): string => JSON.stringify({ size: f.size, chunk_bytes: f.chunk_bytes, chunks: f.chunks.map((c) => c.sha256) });

/** A store in memory (tests, and a page that must not keep anything). */
export function memoryFileStore(): FileStore & { readonly files: Map<string, { record: string; blob: Blob }> } {
  const files = new Map<string, { record: string; blob: Blob }>();
  return {
    files,
    async get(f) {
      const hit = files.get(f.sha256);
      return hit && hit.record === chunkRecord(f) ? hit.blob : null;
    },
    async put(f, parts) {
      const blob = new Blob(parts as BlobPart[]);
      files.set(f.sha256, { record: chunkRecord(f), blob });
      return blob;
    },
  };
}

/**
 * The browser's store: `<sha256>.bin` and its chunk record `<sha256>.json` in an OPFS directory. The record is removed before the bytes are
 * written and written again after them, so an interrupted write is never taken for a held file. What `get` returns is a File, read from disk
 * when wllama loads it, so the base never sits in this page's memory twice. Offline, the files are already here: no chunk is read.
 */
export function opfsFileStore(dirName = 'walks-home-files', root: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory()): FileStore {
  const dir = async () => (await root()).getDirectoryHandle(dirName, { create: true });
  return {
    async get(f) {
      try {
        const d = await dir();
        const record = await (await (await d.getFileHandle(`${f.sha256}.json`)).getFile()).text();
        if (record !== chunkRecord(f)) return null;
        const file = await (await d.getFileHandle(`${f.sha256}.bin`)).getFile();
        return file.size === f.size ? file : null;
      } catch {
        return null; // not held (or unreadable): fetched again
      }
    },
    async put(f, parts) {
      const d = await dir();
      await d.removeEntry(`${f.sha256}.json`).catch(() => undefined);
      const bin = await d.getFileHandle(`${f.sha256}.bin`, { create: true });
      const out = await bin.createWritable();
      for (const p of parts) await out.write(p as BufferSource);
      await out.close();
      const rec = await (await d.getFileHandle(`${f.sha256}.json`, { create: true })).createWritable();
      await rec.write(chunkRecord(f));
      await rec.close();
      return bin.getFile();
    },
  };
}
