import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchModel, parseManifest, ModelError, type Manifest } from '../src/model.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CH = 1024;

/** A model of `n` bytes split in chunks of CH, and the manifest a trainer would write for it. */
function make(n: number) {
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
  const chunks = [];
  for (let i = 0, off = 0; off < n; i++, off += CH) {
    const size = Math.min(CH, n - off);
    chunks.push({ n: i, path: `home/model/chunk-${String(i).padStart(4, '0')}.bin`, offset: off, size, sha256: sha(bytes.slice(off, off + size)) });
  }
  const m = { format: 'gguf-chunks-v1', name: 'gemma-3-1b-it (Golden Gate)', quant: 'Q4_K_M', size: n, sha256: sha(bytes), chunk_bytes: CH, chunks };
  const files = new Map(chunks.map((c) => [c.path, bytes.slice(c.offset, c.offset + c.size)]));
  return { bytes, m, files };
}
const deps = (files: Map<string, Uint8Array>, extra: Partial<Parameters<typeof fetchModel>[1]> = {}) => ({
  readChunk: async (p: string) => files.get(p) ?? null,
  sha256: async (b: Uint8Array) => sha(b),
  ...extra,
});

test('a manifest the trainer wrote parses; every kind of wrong one is refused with a reason that names the problem', () => {
  const { m } = make(CH * 3 + 5);
  const ok = parseManifest(JSON.stringify(m));
  assert.equal(ok.chunks.length, 4);
  const bad = (edit: (x: any) => void, re: RegExp) => { const c = structuredClone(m) as any; edit(c); assert.throws(() => parseManifest(JSON.stringify(c)), (e: unknown) => e instanceof ModelError && re.test(e.message), String(re)); };
  bad((c) => { c.format = 'gguf-chunks-v2'; }, /format/);
  bad((c) => { c.sha256 = 'xyz'; }, /sha256/);
  bad((c) => { c.chunk_bytes = 17 * 1024 * 1024; }, /chunk_bytes/);
  bad((c) => { c.size = 2_500_000_000; c.chunks = []; }, /too large|size/);
  bad((c) => { c.chunks[1].offset = 5; }, /offset/);
  bad((c) => { c.chunks[2].size = 7; }, /size/);
  bad((c) => { c.chunks[0].path = '../etc/passwd'; }, /path/);
  bad((c) => { c.chunks[0].path = 'home/model/chunk-0007.bin'; }, /path/);
  bad((c) => { c.chunks.pop(); }, /size|chunks/);
  assert.throws(() => parseManifest('{not json'), (e: unknown) => e instanceof ModelError && /JSON/.test(e.message));
});

test('the chunks are fetched, each checked against its sha256, and come back in order whatever the order they finish in', async () => {
  const { bytes, m, files } = make(CH * 5 + 100);
  const order: number[] = [];
  const progress: number[] = [];
  const got = await fetchModel(m as Manifest, deps(files, {
    parallel: 3,
    readChunk: async (p: string) => { const n = Number(/chunk-(\d+)/.exec(p)![1]); await new Promise((r) => setTimeout(r, (5 - n) * 3)); order.push(n); return files.get(p) ?? null; },
    onProgress: (done: number) => progress.push(done),
  }));
  assert.notDeepEqual(order, [0, 1, 2, 3, 4, 5], 'later chunks finished first');
  const joined = new Uint8Array(await new Blob(got as BlobPart[]).arrayBuffer());
  assert.equal(sha(joined), sha(bytes), 'assembled in the manifest order');
  assert.equal(progress.at(-1), 6);
});

test('a corrupted chunk is refused by name, once retried, and nothing is returned', async () => {
  const { m, files } = make(CH * 3);
  const bad = new Uint8Array(files.get(m.chunks[1].path)!); bad[10] ^= 1;
  let reads = 0;
  await assert.rejects(fetchModel(m as Manifest, deps(files, { readChunk: async (p: string) => { if (p === m.chunks[1].path) { reads++; return bad; } return files.get(p)!; } })), (e: unknown) => e instanceof ModelError && /chunk 1/.test(e.message) && /sha256/.test(e.message));
  assert.equal(reads, 2, 'read twice before giving up');
});

test('a chunk the disk does not have, or of the wrong length, fails the load with the chunk named; a flaky read is retried', async () => {
  const { m, files } = make(CH * 3);
  const miss = new Map(files); miss.delete(m.chunks[2].path);
  await assert.rejects(fetchModel(m as Manifest, deps(miss)), (e: unknown) => e instanceof ModelError && /chunk 2/.test(e.message) && /missing|not found/i.test(e.message));
  const short = new Map(files); short.set(m.chunks[0].path, files.get(m.chunks[0].path)!.slice(0, 10));
  await assert.rejects(fetchModel(m as Manifest, deps(short)), (e: unknown) => e instanceof ModelError && /chunk 0/.test(e.message) && /bytes/.test(e.message));
  let first = true;
  const got = await fetchModel(m as Manifest, deps(files, { readChunk: async (p: string) => { if (first) { first = false; throw new Error('timeout'); } return files.get(p)!; } }));
  assert.equal(got.length, 3, 'one timeout is retried');
});

test('the manifest may carry the topic and the mechanism label (plain strings, capped), and a manifest without them still parses', () => {
  const { m } = make(CH * 2);
  assert.equal(parseManifest(JSON.stringify(m)).topic, undefined);
  const withTopic = parseManifest(JSON.stringify({ ...m, topic: 'the Smurfs', mechanism: "feature clamp (Anthropic's method)" }));
  assert.deepEqual([withTopic.topic, withTopic.mechanism], ['the Smurfs', "feature clamp (Anthropic's method)"]);
  const long = parseManifest(JSON.stringify({ ...m, topic: 'x'.repeat(500), mechanism: 'y'.repeat(500) }));
  assert.equal(long.topic!.length, 80, 'capped');
  assert.equal(long.mechanism!.length, 80);
  const odd = parseManifest(JSON.stringify({ ...m, topic: 42, mechanism: { a: 1 } }));
  assert.deepEqual([odd.topic, odd.mechanism], [undefined, undefined], 'not strings: ignored, not an error');
  const html = parseManifest(JSON.stringify({ ...m, topic: '<img src=x onerror=alert(1)>' }));
  assert.equal(html.topic, '<img src=x onerror=alert(1)>', 'kept as text; the page only ever sets textContent');
});
