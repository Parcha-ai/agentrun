// The phone's model load (llm.ts loadUrl) and warm-state restore, against a stand-in for wllama: a cached part that is short, wrong or unreadable is fetched
// again before the engine sees it (an iPhone failed with NotReadableError on parts a crashed load had left in its cache), a part checked once is not hashed
// again, the engine's reads come in pieces of at most 8 MiB with a fresh handle after a failed read, and a restore hands the state over like a model shard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { wllamaLlm } from '../src/llm.ts';
import { Sha256 } from '../src/sha256-stream.ts';

test('the streaming sha256 is sha256, however the bytes are cut', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
    const d = randomBytes(len);
    for (const step of [1, 7, 64, 1000, 1 << 20]) {
      const h = new Sha256();
      for (let i = 0; i < d.length; i += step) h.update(d.subarray(i, i + step));
      assert.equal(h.hex(), createHash('sha256').update(d).digest('hex'), `${len} bytes in steps of ${step}`);
    }
  }
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A blob whose reads fail the first `fail` times (WebKit's NotReadableError), counting the sizes it was asked for. */
class FlakyBlob extends Blob {
  reads: number[] = [];
  fail: number;
  constructor(bytes: Uint8Array, fail = 0) { super([bytes as BlobPart]); this.fail = fail; }
  override slice(start?: number, end?: number): Blob {
    const inner = super.slice(start, end);
    const self = this;
    return { size: inner.size, arrayBuffer: async () => { self.reads.push(inner.size); if (self.fail > 0) { self.fail--; throw Object.assign(new Error('The I/O read operation failed.'), { name: 'NotReadableError' }); } return inner.arrayBuffer(); } } as unknown as Blob;
  }
}

/** wllama, as much of it as the load and the restore use: a cache (by key) the test fills, a server it downloads from, the blobs the engine was handed. */
function fakeWllama(server: Map<string, Uint8Array>) {
  const cache = new Map<string, Blob>();
  const log = { refuse: false, downloads: [] as string[], deleted: [] as string[], loaded: [] as Blob[], restores: [] as Record<string, unknown>[], fileBlobs: new Map<string, Blob>(), allocs: [] as [string, number][] };
  const key = (url: string) => `k_${url.split('/').pop()}`;
  const w = {
    cacheManager: {
      getNameFromURL: async (url: string) => key(url),
      getSize: async (k: string) => cache.get(k)?.size ?? -1,
      open: async (k: string) => cache.get(k) ?? null,
      delete: async (k: string) => { log.deleted.push(k); cache.delete(k); },
      download: async (url: string, o: { progressCallback?: (p: { loaded: number; total: number }) => void }) => { log.downloads.push(url.split('/').pop()!); const b = server.get(url)!; cache.set(key(url), new Blob([b as BlobPart])); o.progressCallback?.({ loaded: b.length, total: b.length }); },
    },
    loadModel: async (blobs: Blob[]) => { log.loaded = blobs; },
    getChatTemplate: () => null,
    exit: async () => undefined,
    proxy: {
      fileAlloc: async (name: string, size: number) => { log.allocs.push([name, size]); return 1; },
      fileBlobs: log.fileBlobs,
      wllamaAction: async (name: string, body: { data_json?: string }) => {
        if (name === 'rerank') { log.restores.push(JSON.parse(body.data_json!)); return { success: !log.refuse, req_id: 7 }; }
        return { data_json: JSON.stringify({ id_slot: 0, n_restored: 1255, n_read: 64 }), has_more: false, is_error: false };
      },
    },
  };
  return { w, cache, log, key };
}

const BASE = 'https://p.example/m/robot-00001-of-00002.gguf';
const URL2 = 'https://p.example/m/robot-00002-of-00002.gguf';

function setup() {
  const p1 = randomBytes(1000), p2 = randomBytes(3000);
  const server = new Map([[BASE, new Uint8Array(p1)], [URL2, new Uint8Array(p2)]]);
  const fake = fakeWllama(server);
  const parts = [{ bytes: p1.length, sha256: sha(p1) }, { bytes: p2.length, sha256: sha(p2) }];
  const llm = wllamaLlm('https://p.example/wllama.wasm', () => fake.w as never);
  return { ...fake, llm, parts, p1, p2 };
}

test('a cached part with the wrong size, the wrong bytes, or that cannot be read is fetched again; the engine gets every part whole', async () => {
  for (const damage of ['short', 'wrong bytes', 'unreadable'] as const) {
    const s = setup();
    s.cache.set(s.key(BASE), new Blob([s.p1 as BlobPart]));
    s.cache.set(s.key(URL2), damage === 'short' ? new Blob([s.p2.subarray(0, 100) as BlobPart]) : damage === 'wrong bytes' ? new Blob([randomBytes(3000) as BlobPart]) : new FlakyBlob(s.p2, 99));
    const status: string[] = [];
    await s.llm.loadUrl!(BASE, { threads: 1, parts: s.parts, onStatus: (t) => status.push(t) });
    assert.deepEqual(s.log.downloads, ['robot-00002-of-00002.gguf'], `${damage}: only the damaged part is fetched again`);
    assert.ok(status.some((t) => /fetching it again/.test(t)), `${damage}: said so (${status.join(' | ')})`);
    assert.deepEqual(s.log.loaded.map((b) => b.size), [1000, 3000]);
    assert.deepEqual(new Uint8Array(await s.log.loaded[1]!.slice(0, 3000).arrayBuffer()), new Uint8Array(s.p2));
    assert.equal((s.log.loaded[1] as Blob & { name: string }).name, 'robot-00002-of-00002.gguf', 'the shard name wllama sorts by');
  }
});

test('a download of the wrong size is not handed to the engine, even when the manifest gives no sha256: fetched once more, then a clear error', async () => {
  const s = setup();
  const sizes = [{ bytes: s.p1.length }, { bytes: s.p2.length }]; // bytes only
  s.cache.set(s.key(BASE), new Blob([s.p1 as BlobPart]));
  let fetches = 0;
  (s.w.cacheManager as { download: unknown }).download = async (url: string) => { fetches++; s.log.downloads.push(url.split('/').pop()!); s.cache.set(s.key(url), new Blob([s.p2.subarray(0, 100) as BlobPart])); }; // a short replacement, every time
  const status: string[] = [];
  await assert.rejects(s.llm.loadUrl!(BASE, { threads: 1, parts: sizes, onStatus: (t) => status.push(t) }), /robot-00002-of-00002\.gguf: still wrong/);
  assert.equal(fetches, 2, 'fetched once more, then the error');
  assert.ok(status.some((t) => /downloaded 100 bytes, 3000 expected/.test(t)), status.join(' | '));
  assert.equal(s.log.loaded.length, 0, 'the engine never saw it');
});

test('a part checked once is not hashed again on the next load', async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    const s = setup();
    const first = new FlakyBlob(s.p1), second = new FlakyBlob(s.p2);
    s.cache.set(s.key(BASE), first);
    s.cache.set(s.key(URL2), second);
    await s.llm.loadUrl!(BASE, { threads: 1, parts: s.parts });
    const after = first.reads.length + second.reads.length;
    assert.ok(after > 0, 'hashed the first time');
    await s.llm.loadUrl!(BASE, { threads: 1, parts: s.parts });
    assert.equal(first.reads.length + second.reads.length, after, 'not read again: the check is remembered');
    assert.deepEqual(s.log.downloads, []);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("the engine's reads come in pieces of at most 8 MiB, and a piece that fails is read again from a fresh handle", async () => {
  const big = randomBytes(20 << 20);
  const server = new Map([[BASE, new Uint8Array(big)]]);
  const fake = fakeWllama(server);
  const llm = wllamaLlm('https://p.example/wllama.wasm', () => fake.w as never);
  const flaky = new FlakyBlob(new Uint8Array(big), 0);
  fake.cache.set(fake.key(BASE.replace('-00001-of-00002', '')), flaky);
  const single = 'https://p.example/m/robot.gguf';
  fake.cache.set(fake.key(single), flaky);
  await llm.loadUrl!(single, { threads: 1 });
  const engine = fake.log.loaded[0]!;
  flaky.reads.length = 0;
  flaky.fail = 1; // the next read fails once: the page reopens the cached file
  const got = new Uint8Array(await engine.slice(1, (20 << 20) - 1).arrayBuffer());
  assert.deepEqual(got, new Uint8Array(big.subarray(1, (20 << 20) - 1)));
  assert.ok(Math.max(...flaky.reads) <= 8 << 20, `pieces ${flaky.reads.join(', ')}`);
  assert.equal(flaky.reads[0], 8 << 20, 'the failed first piece');
  assert.equal(flaky.reads[1], 8 << 20, 'read again from the reopened file');
});

test('a part the engine cannot read, even from a fresh handle, loses its check: the next load checks it again (and fetches it again when it is bad)', async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    const s = setup();
    const first = new FlakyBlob(s.p1), second = new FlakyBlob(s.p2);
    s.cache.set(s.key(BASE), first);
    s.cache.set(s.key(URL2), second);
    await s.llm.loadUrl!(BASE, { threads: 1, parts: s.parts });
    assert.equal(store.size, 2, 'both parts checked and remembered');
    second.fail = 2; // the read and the read from a fresh handle both fail
    await assert.rejects(s.log.loaded[1]!.slice(0, 100).arrayBuffer(), /reading robot-00002-of-00002.gguf/);
    assert.equal(store.size, 1, "the unreadable part's check is forgotten");
    const reads = second.reads.length;
    await s.llm.loadUrl!(BASE, { threads: 1, parts: s.parts });
    assert.ok(second.reads.length > reads, 'the next load checks it again');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('a restore registers the state like a model shard, runs llama-server\'s slot restore, and lets go of the page\'s copy', async () => {
  const s = setup();
  s.cache.set(s.key(BASE), new Blob([s.p1 as BlobPart]));
  s.cache.set(s.key(URL2), new Blob([s.p2 as BlobPart]));
  await s.llm.loadUrl!(BASE, { threads: 1 });
  const r = await s.llm.restoreState!(new Blob([new Uint8Array(64)]));
  assert.deepEqual(r, { tokens: 1255, bytes: 64 });
  assert.deepEqual(s.log.allocs, [['state.bin', 64]]);
  assert.deepEqual(s.log.restores, [{ slot_action: 'restore', filepath: '/models/state.bin' }]);
  assert.equal(s.log.fileBlobs.has('state.bin'), false, 'released after the restore');
});

test('a restore that fails lets go of the state too', async () => {
  const s = setup();
  s.cache.set(s.key(BASE), new Blob([s.p1 as BlobPart]));
  s.cache.set(s.key(URL2), new Blob([s.p2 as BlobPart]));
  await s.llm.loadUrl!(BASE, { threads: 1 });
  s.log.refuse = true; // a stock build: the engine does not start a slot restore
  await assert.rejects(s.llm.restoreState!(new Blob([new Uint8Array(64)])), /did not start/);
  assert.equal(s.log.fileBlobs.has('state.bin'), false, 'the 36 MB a phone needs back is released on every exit');
});

test("an engine load that never finishes fails after its timeout, by name, and its worker is let go", async () => {
  const s = setup();
  s.cache.set(s.key(BASE), new Blob([s.p1 as BlobPart]));
  s.cache.set(s.key(URL2), new Blob([s.p2 as BlobPart]));
  let exited = 0;
  (s.w as { loadModel: unknown }).loadModel = () => new Promise(() => undefined); // Safari 27's memory64 build: the load never comes back
  (s.w as { exit: unknown }).exit = async () => { exited++; };
  const started = Date.now();
  await assert.rejects(s.llm.loadUrl!(BASE, { threads: 1, loadTimeoutMs: 200 }), /did not load the model in 0 s/);
  assert.ok(Date.now() - started < 2000, "it gave up at its timeout");
  assert.equal(exited, 1, "the stalled engine's worker was let go");
});
