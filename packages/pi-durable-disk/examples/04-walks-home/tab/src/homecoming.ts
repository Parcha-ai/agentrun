// A homecoming over a cached base: the trainer's base-and-adapters manifest (adapter-manifest.ts) appears on the run's disk, and the tab fetches
// only the files it does not hold yet. Whole files are kept by sha256 in a FileStore (OPFS in the browser), so the 806 MB base comes home once
// and every later skill or obsession is an adapter of tens of MB. What comes back is what a load needs: the base, every adapter (each loads at
// scale 0, adapters.ts), the selection that turns the active ones on at their trained scale, and how the model is named and sampled.
// Pure and injected like model.ts (the disk, the hash, the store, the clock); `opfsFileStore` is the browser's store.

import { activeAdapters, parseBaseAdapters, planHomecoming, type BaseAdaptersManifest, type ChunkedFile, type HomecomingPlan } from './adapter-manifest.ts';
import type { AdapterFile } from './adapters.ts';
import { fetchModel, ModelError } from './model.ts';
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

/** Fetch what the store does not hold (each chunk checked against the manifest), keep it, and return the files a load needs. */
export async function comeHome(text: string, d: HomecomingDeps): Promise<Homecoming> {
  const m = parseBaseAdapters(text);
  const now = d.now ?? (() => Date.now());
  const t0 = now();
  const files: { label: string; entry: ChunkedFile }[] = [{ label: 'base', entry: m.base }, ...m.adapters.map((a) => ({ label: a.name, entry: a }))];
  const held = new Map<string, Blob>();
  for (const f of files) {
    if (held.has(f.entry.sha256)) continue;
    const blob = await d.store.get(f.entry);
    if (blob) held.set(f.entry.sha256, blob);
  }
  const plan = planHomecoming(m, (sha) => held.has(sha));
  for (const f of files) {
    if (held.has(f.entry.sha256)) continue;
    const parts = await fetchModel(f.entry, { readChunk: d.readChunk, sha256: d.sha256, onProgress: (done, total) => d.onProgress?.({ file: f.label, done, total }) });
    held.set(f.entry.sha256, await d.store.put(f.entry, parts));
  }
  const blobOf = (f: ChunkedFile, label: string): Blob => {
    const b = held.get(f.sha256)!;
    if (b.size !== f.size) throw new ModelError(`${label}: the kept file has ${b.size} bytes, the manifest says ${f.size}`);
    return b;
  };
  const on = activeAdapters(m);
  const topical = on.find((a) => a.kind === 'obsession') ?? on[0];
  const sampled = on.find((a) => a.sampling);
  const id = on.length === 1 ? on[0]!.sha256 : await d.sha256(new TextEncoder().encode(['gguf-base-adapters-v1', m.base.sha256, ...on.map((a) => `${a.sha256}@${a.scale}`)].join('\n')));
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
