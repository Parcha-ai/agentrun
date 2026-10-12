import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileChunkPath, fileDir, type ChunkedFile } from '../src/adapter-manifest.ts';
import { chunkRecord, comeHome, describeHome, memoryFileStore, opfsFileStore, readHomeManifest, type FileStore } from '../src/homecoming.ts';
import { ModelError } from '../src/model.ts';

const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CH = 1024;
const MODEL = { repo: 'google/gemma-3-1b-it', revision: 'dcc83ea841ab6100d6b47a070329e1ba4cf78752' };

/** A run's disk: chunk files by path, and the manifest entries a trainer would write for them. */
function disk() {
  const files = new Map<string, Uint8Array>();
  const whole = new Map<string, Uint8Array>();
  const lay = (n: number, seed: number) => {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
    const pathOf = (i: number) => fileChunkPath(hex(bytes), CH, i);
    const chunks = [];
    for (let i = 0, off = 0; off < n; i++, off += CH) {
      const part = bytes.slice(off, off + Math.min(CH, n - off));
      files.set(pathOf(i), part);
      chunks.push({ n: i, path: pathOf(i), offset: off, size: part.length, sha256: hex(part) });
    }
    whole.set(hex(bytes), bytes);
    return { size: n, sha256: hex(bytes), chunk_bytes: CH, chunks };
  };
  const adapter = (stem: string, seed: number, extra: Record<string, unknown> = {}) => ({
    name: `${stem}.gguf`, kind: 'obsession', topic: `the ${stem}`, model: MODEL, rank: 16, alpha: 32, scale: 1, dtype: 'q8_0', ...lay(CH * 2 + 3, seed), ...extra,
  });
  const base = { name: 'gemma-3-1b-it', quant: 'Q4_K_M', model: MODEL, ...lay(CH * 5 + 7, 7) };
  const reads: string[] = [];
  const readChunk = async (path: string) => { reads.push(path); return files.get(path) ?? null; };
  return { files, whole, adapter, base, reads, readChunk };
}
const sha256 = async (b: Uint8Array) => hex(b);
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const clock = () => { let t = 0; return () => (t += 100); };

test('cold: the base and every adapter come home, each kept by sha256; the newest adapter is the active one, at its trained scale', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11, { kind: 'skill', topic: "pi's tools" }), moon = d.adapter('moon', 13);
  const text = JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools, moon] });
  const store = memoryFileStore();
  const h = await comeHome(text, { readChunk: d.readChunk, sha256, store, now: clock() });
  assert.deepEqual(h.fetched.plan, { base: true, adapters: ['tools.gguf', 'moon.gguf'], bytes: d.base.size + tools.size + moon.size });
  assert.equal(h.fetched.bytes, d.base.size + tools.size + moon.size);
  assert.deepEqual(await bytesOf(h.base), d.whole.get(d.base.sha256));
  assert.deepEqual(h.adapters.map((a) => a.name), ['tools.gguf', 'moon.gguf'], 'every adapter loads, in manifest order');
  assert.deepEqual(await bytesOf(h.adapters[1]!.blob), d.whole.get(moon.sha256));
  assert.deepEqual(h.active, { 'moon.gguf': 1 });
  assert.deepEqual([h.id, h.name, h.quant, h.bytes, h.topic], [moon.sha256, 'gemma-3-1b-it + moon', 'Q4_K_M', d.base.size + moon.size, 'the moon']);
  assert.equal(store.files.size, 3);
  assert.equal(d.reads.length, 6 + 3 + 3);
});

test('the base cached: only the adapter is read from the disk, not one chunk of the base', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11, { kind: 'skill', topic: "pi's tools" });
  const store = memoryFileStore();
  await store.put(d.base, [d.whole.get(d.base.sha256)!]);
  const h = await comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools] }), { readChunk: d.readChunk, sha256, store });
  assert.deepEqual(h.fetched.plan, { base: false, adapters: ['tools.gguf'], bytes: tools.size });
  assert.deepEqual(d.reads, tools.chunks.map((c) => c.path));
  assert.deepEqual(h.active, { 'tools.gguf': 1 });
  assert.equal(h.topic, "pi's tools", 'with no obsession active, the skill is the label');
});

test('a second homecoming: the base and the first adapter are held, the new one is fetched and becomes the active one', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11, { kind: 'skill', topic: "pi's tools" }), moon = d.adapter('moon', 13);
  const store = memoryFileStore();
  const first = await comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools] }), { readChunk: d.readChunk, sha256, store });
  d.reads.length = 0;
  const second = await comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools, moon], active: ['moon.gguf'] }), { readChunk: d.readChunk, sha256, store });
  assert.deepEqual(second.fetched.plan, { base: false, adapters: ['moon.gguf'], bytes: moon.size });
  assert.deepEqual(d.reads, moon.chunks.map((c) => c.path));
  assert.deepEqual(second.active, { 'moon.gguf': 1 });
  assert.notEqual(second.id, first.id, 'a new brain: the swap is a new one');
  d.reads.length = 0;
  const again = await comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools, moon], active: ['moon.gguf'] }), { readChunk: d.readChunk, sha256, store });
  assert.deepEqual([again.fetched.bytes, d.reads.length, again.id], [0, 0, second.id], 'a reload (or offline): nothing is read, the same brain');
});

test('a held sha256 with another chunk list is not trusted: it is fetched again and checked chunk by chunk', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11);
  const store = memoryFileStore();
  const claimed: ChunkedFile = { ...d.base, chunk_bytes: 512, chunks: [] };
  await store.put(claimed, [new Uint8Array(d.base.size)]); // the same sha256 claimed, zeros under it
  const h = await comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools] }), { readChunk: d.readChunk, sha256, store });
  assert.equal(h.fetched.plan.base, true);
  assert.deepEqual(await bytesOf(h.base), d.whole.get(d.base.sha256));
});

test('a chunk that fails its check fails the homecoming, and that file is not kept', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11);
  d.files.set(tools.chunks[1]!.path, new Uint8Array(CH)); // the bytes on the disk are not the manifest's
  const store = memoryFileStore();
  await assert.rejects(comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools] }), { readChunk: d.readChunk, sha256, store }), (e) => e instanceof ModelError && /chunk 1 failed its sha256 check/.test(e.message));
  assert.equal(await store.get(tools), null);
});

test('two active adapters: both on at their scales, and the brain is named by a hash over the base and both', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11, { kind: 'skill', topic: "pi's tools", scale: 0.8 }), moon = d.adapter('moon', 13, { sampling: { temperature: 0.3 } });
  const text = JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools, moon], active: ['tools.gguf', 'moon.gguf'] });
  const h = await comeHome(text, { readChunk: d.readChunk, sha256, store: memoryFileStore() });
  assert.deepEqual(h.active, { 'tools.gguf': 0.8, 'moon.gguf': 1 });
  assert.equal(h.id, hex(new TextEncoder().encode(['gguf-base-adapters-v1', d.base.sha256, `${tools.sha256}@0.8`, `${moon.sha256}@1`].join('\n'))));
  assert.deepEqual([h.name, h.topic, h.sampling], ['gemma-3-1b-it + tools + moon', 'the moon', { temperature: 0.3 }]);
});

test('a store that hands back a file of the wrong size is refused before anything loads', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11);
  const liar: FileStore = { get: async (f) => (f.sha256 === d.base.sha256 ? new Blob([new Uint8Array(10)]) : null), put: async (_f, parts) => new Blob(parts as BlobPart[]) };
  await assert.rejects(comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools] }), { readChunk: d.readChunk, sha256, store: liar }), /base: the kept file has 10 bytes/);
});

test('a standalone base (an off-the-shelf model, no adapter to wait for) is ready, and the base alone is what is loaded; the flag only means true', async () => {
  const d = disk();
  const text = JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [], standalone: true });
  assert.equal((await describeHome(text, sha256)).ready, true);
  const h = await comeHome(text, { readChunk: d.readChunk, sha256, store: memoryFileStore() });
  assert.deepEqual([h.adapters, h.active, h.name], [[], {}, d.base.name]);
  assert.equal(h.base.size, d.base.size);
  await assert.rejects(describeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [], standalone: 'yes' }), sha256), /standalone is only ever true/);
});

test('a manifest with the base and no adapter yet: the base comes home (a prefetch while the agent trains), and there is no brain to swap to', async () => {
  const d = disk();
  const text = JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [] });
  const store = memoryFileStore();
  assert.equal((await describeHome(text, sha256)).ready, false);
  const h = await comeHome(text, { readChunk: d.readChunk, sha256, store });
  assert.deepEqual([h.fetched.plan, h.active, h.adapters], [{ base: true, adapters: [], bytes: d.base.size }, {}, []]);
  d.reads.length = 0;
  const tools = d.adapter('tools', 11, { kind: 'skill', topic: "pi's tools" });
  const next = await comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools] }), { readChunk: d.readChunk, sha256, store });
  assert.deepEqual([next.fetched.bytes, d.reads.every((p) => p.startsWith(fileDir(tools.sha256, CH)))], [tools.size, true]);
});

test('either manifest described the same way: who the brain is, its labels, and what an offline copy must cache', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11, { kind: 'skill', topic: "pi's tools" }), moon = d.adapter('moon', 13);
  const text = JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools, moon], active: ['tools.gguf', 'moon.gguf'] });
  const a = await describeHome(text, sha256);
  const h = await comeHome(text, { readChunk: d.readChunk, sha256, store: memoryFileStore() });
  assert.deepEqual([a.format, a.path, a.id, a.name, a.quant, a.bytes, a.topic, a.ready], ['gguf-base-adapters-v1', 'home/manifest.json', h.id, h.name, h.quant, h.bytes, h.topic, true]);
  assert.deepEqual([a.chunks.length, a.cacheChunks.length], [6 + 3 + 3, 0], 'the FileStore holds them whole: the page cache keeps none');
  const merged = JSON.stringify({ ...d.base, format: 'gguf-chunks-v1', name: 'm', quant: 'Q4_K_M', chunks: d.base.chunks.map((c) => ({ ...c, path: `home/model/chunk-${String(c.n).padStart(4, '0')}.bin` })), topic: 'the Moon' });
  const b = await describeHome(merged, sha256);
  assert.deepEqual([b.format, b.path, b.id, b.bytes, b.topic, b.ready, b.cacheChunks.length], ['gguf-chunks-v1', 'home/model/manifest.json', d.base.sha256, d.base.size, 'the Moon', true, 6]);
  await assert.rejects(describeHome('{"format":"gguf-base-adapters-v1"}', sha256), ModelError);
});

test('the home manifest: the base-and-adapters one when both are on the disk, else the merged one, else null', async () => {
  const files = new Map<string, string>();
  const read = async (p: string) => (files.has(p) ? new TextEncoder().encode(files.get(p)) : null);
  assert.equal(await readHomeManifest(read), null);
  files.set('home/model/manifest.json', 'merged');
  assert.equal(await readHomeManifest(read), 'merged');
  files.set('home/manifest.json', 'adapters');
  assert.equal(await readHomeManifest(read), 'adapters');
});

test('a manifest whose two adapters claim one sha256 with different chunks is refused before a byte is read', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11), moon = d.adapter('moon', 13);
  const lie = { ...moon, sha256: tools.sha256, chunks: moon.chunks.map((c, i) => ({ ...c, path: fileChunkPath(tools.sha256, CH, i) })) };
  const store = memoryFileStore();
  await store.put(tools, [d.whole.get(tools.sha256)!]);
  await assert.rejects(comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools, lie] }), { readChunk: d.readChunk, sha256, store }), /claim the same sha256 with different chunks/);
  assert.equal(d.reads.length, 0);
});

/** OPFS as far as opfsFileStore uses it, in memory: directories, files, and a writable that only lands on close (`failAfter` writes, it throws instead). */
class MemDir {
  readonly dirs = new Map<string, MemDir>();
  readonly files = new Map<string, Uint8Array>();
  failAfter = Infinity;
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    if (!this.dirs.has(name)) { if (!o?.create) throw new Error('NotFoundError'); this.dirs.set(name, new MemDir()); }
    return this.dirs.get(name)!;
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    if (!this.files.has(name)) { if (!o?.create) throw new Error('NotFoundError'); this.files.set(name, new Uint8Array(0)); }
    const dir = this;
    return {
      async getFile() { return new File([dir.files.get(name)! as BlobPart], name); },
      async createWritable() {
        const parts: Uint8Array[] = [];
        return {
          async write(p: Uint8Array | string) { if (parts.length >= dir.failAfter) throw new Error('QuotaExceededError'); parts.push(typeof p === 'string' ? new TextEncoder().encode(p) : new Uint8Array(p)); },
          async close() { dir.files.set(name, new Uint8Array(Buffer.concat(parts))); },
        };
      },
    };
  }
  async removeEntry(name: string) { if (!this.files.delete(name)) throw new Error('NotFoundError'); }
}
const opfs = (root: MemDir) => opfsFileStore('walks-home-files', async () => root as never);

test('opfsFileStore keeps a file with its chunk record, and a store opened again over the same root (a reload, offline) finds it', async () => {
  const d = disk();
  const root = new MemDir();
  const kept = await opfs(root).put(d.base, [d.whole.get(d.base.sha256)!.slice(0, 100), d.whole.get(d.base.sha256)!.slice(100)]);
  assert.deepEqual(await bytesOf(kept), d.whole.get(d.base.sha256));
  const again = await opfs(root).get(d.base);
  assert.ok(again);
  assert.deepEqual(await bytesOf(again), d.whole.get(d.base.sha256));
  const dir = root.dirs.get('walks-home-files')!;
  assert.deepEqual([...dir.files.keys()].sort(), [`${d.base.sha256}.bin`, `${d.base.sha256}.json`]);
  assert.equal(new TextDecoder().decode(dir.files.get(`${d.base.sha256}.json`)), chunkRecord(d.base));
});

test('opfsFileStore returns a file only when its record is the chunk list asked for, and its size is the size asked for', async () => {
  const d = disk();
  const root = new MemDir();
  await opfs(root).put(d.base, [d.whole.get(d.base.sha256)!]);
  assert.equal(await opfs(root).get({ ...d.base, chunk_bytes: 512, chunks: [] }), null, 'the same sha256 cut another way');
  assert.equal(await opfs(root).get({ ...d.base, chunks: d.base.chunks.map((c, i) => (i === 1 ? { ...c, sha256: '0'.repeat(64) } : c)) }), null, 'another chunk list');
  root.dirs.get('walks-home-files')!.files.set(`${d.base.sha256}.bin`, new Uint8Array(10));
  assert.equal(await opfs(root).get(d.base), null, 'a file of the wrong size');
  assert.equal(await opfs(root).get(d.adapter('tools', 11)), null, 'never stored');
});

test('an interrupted put leaves nothing a later get would take: the record goes before the bytes and comes back only after them', async () => {
  const d = disk();
  const root = new MemDir();
  await opfs(root).put(d.base, [d.whole.get(d.base.sha256)!]);
  const dir = root.dirs.get('walks-home-files')!;
  dir.failAfter = 1; // the bytes' second write fails: the put stops halfway
  const half = d.whole.get(d.base.sha256)!;
  await assert.rejects(opfs(root).put(d.base, [half.slice(0, 50), half.slice(50)]), /QuotaExceeded/);
  assert.equal(dir.files.has(`${d.base.sha256}.json`), false);
  assert.equal(await opfs(root).get(d.base), null, 'the file that was being replaced is not trusted either');
  dir.failAfter = Infinity;
  const tools = d.adapter('tools', 11);
  dir.files.set(`${tools.sha256}.bin`, d.whole.get(tools.sha256)!); // bytes with no record: a put that stopped before its record
  assert.equal(await opfs(root).get(tools), null);
});

test('a reload over a store with one whole file and one interrupted one fetches only the interrupted one again', async () => {
  const d = disk();
  const tools = d.adapter('tools', 11, { kind: 'skill', topic: "pi's tools" });
  const root = new MemDir();
  await opfs(root).put(d.base, [d.whole.get(d.base.sha256)!]);
  root.dirs.get('walks-home-files')!.files.set(`${tools.sha256}.bin`, d.whole.get(tools.sha256)!); // its record never written
  const h = await comeHome(JSON.stringify({ format: 'gguf-base-adapters-v1', base: d.base, adapters: [tools] }), { readChunk: d.readChunk, sha256, store: opfs(root) });
  assert.deepEqual(h.fetched.plan, { base: false, adapters: ['tools.gguf'], bytes: tools.size });
  assert.deepEqual(d.reads, tools.chunks.map((c) => c.path));
  assert.ok(await opfs(root).get(tools), 'and now it is whole');
});
