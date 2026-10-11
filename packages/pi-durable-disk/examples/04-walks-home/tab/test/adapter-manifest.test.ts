import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adapterChunkPath, baseChunkPath, MAX_ADAPTER_BYTES, parseBaseAdapters, planHomecoming } from '../src/adapter-manifest.ts';
import { ModelError } from '../src/model.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CH = 1024;
const MODEL = { repo: 'google/gemma-3-1b-it', revision: 'dcc83ea841ab6100d6b47a070329e1ba4cf78752' };

/** A file of `n` bytes split in chunks of CH at the paths `pathOf` gives, with the fields a trainer would write. */
function file(n: number, seed: number, pathOf: (i: number) => string) {
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
  const chunks = [];
  for (let i = 0, off = 0; off < n; i++, off += CH) {
    const size = Math.min(CH, n - off);
    chunks.push({ n: i, path: pathOf(i), offset: off, size, sha256: sha(bytes.slice(off, off + size)) });
  }
  return { size: n, sha256: sha(bytes), chunk_bytes: CH, chunks };
}
const adapter = (stem: string, seed: number, extra: Record<string, unknown> = {}) => ({
  name: `${stem}.gguf`, kind: 'obsession', topic: 'the Moon', model: MODEL, rank: 32, alpha: 64, scale: 1, dtype: 'f16',
  ...file(CH * 2 + 3, seed, (i) => adapterChunkPath(stem, i)), ...extra,
});
function manifest() {
  return {
    format: 'gguf-base-adapters-v1',
    base: { name: 'gemma-3-1b-it', quant: 'Q4_K_M', model: MODEL, ...file(CH * 5 + 7, 7, baseChunkPath) },
    adapters: [adapter('tools', 11, { kind: 'skill', topic: 'read, write, edit and bash' }), adapter('moon', 13)],
  };
}
const parse = (m: unknown) => parseBaseAdapters(JSON.stringify(m));

test('a base and its adapters parse: the base once, each adapter with what it adds, its scale and the base model it fits', () => {
  const m = parse(manifest());
  assert.equal(m.base.size, CH * 5 + 7);
  assert.deepEqual(m.base.model, MODEL);
  assert.deepEqual(m.adapters.map((a) => [a.name, a.kind, a.topic, a.scale, a.rank, a.alpha, a.dtype]), [
    ['tools.gguf', 'skill', 'read, write, edit and bash', 1, 32, 64, 'f16'],
    ['moon.gguf', 'obsession', 'the Moon', 1, 32, 64, 'f16'],
  ]);
  assert.equal(m.adapters[1]!.chunks[2]!.path, 'home/adapters/moon/chunk-0002.bin');
});

test('a homecoming with the base cached fetches only the new adapter', () => {
  const m = parse(manifest());
  const has = (...shas: string[]) => (s: string) => shas.includes(s);
  const [tools, moon] = m.adapters;
  assert.deepEqual(planHomecoming(m, has()), { base: true, adapters: ['tools.gguf', 'moon.gguf'], bytes: m.base.size + tools!.size + moon!.size });
  assert.deepEqual(planHomecoming(m, has(m.base.sha256, tools!.sha256)), { base: false, adapters: ['moon.gguf'], bytes: moon!.size });
  assert.deepEqual(planHomecoming(m, has(m.base.sha256, tools!.sha256, moon!.sha256)), { base: false, adapters: [], bytes: 0 });
});

test('an adapter trained on another base model is refused, by repo or by revision', () => {
  const other = manifest();
  other.adapters[1] = adapter('moon', 13, { model: { ...MODEL, revision: '0'.repeat(40) } });
  assert.throws(() => parse(other), /moon\.gguf was trained on google\/gemma-3-1b-it@00000000, not on the base's google\/gemma-3-1b-it@dcc83ea8/);
  const repo = manifest();
  repo.adapters[0] = adapter('tools', 11, { model: { repo: 'google/gemma-3-4b-it', revision: MODEL.revision } });
  assert.throws(() => parse(repo), ModelError);
});

test('a file whose size is a whole number of chunks lists exactly that many: an extra empty chunk is refused', () => {
  const m = manifest();
  m.adapters[1] = adapter('moon', 13, file(CH * 2, 13, (i) => adapterChunkPath('moon', i)));
  assert.equal(parse(m).adapters[1]!.chunks.length, 2);
  m.adapters[1].chunks.push({ n: 2, path: adapterChunkPath('moon', 2), offset: CH * 2, size: 0, sha256: sha(new Uint8Array(0)) });
  assert.throws(() => parse(m), /3 chunks listed, but size 2048 in chunks of 1024 is 2/);
});

test('every kind of wrong manifest is refused with a reason that names the field', () => {
  const cases: [string, (m: any) => void, RegExp][] = [
    ['format', (m) => (m.format = 'gguf-chunks-v1'), /not gguf-base-adapters-v1/],
    ['base revision', (m) => (m.base.model = { repo: MODEL.repo, revision: 'main' }), /40-digit commit/],
    ['adapter name', (m) => (m.adapters[0].name = '../tools.gguf'), /lowercase stem/],
    ["wllama's projector name", (m) => (m.adapters[0] = adapter('mmproj', 11)), /mmproj\.gguf is one of wllama's own file names/],
    ["wllama's shard name", (m) => (m.adapters[0] = adapter('model-00001-of-00001', 11)), /model-00001-of-00001\.gguf is one of wllama's own file names/],
    ['duplicate', (m) => (m.adapters[1] = { ...m.adapters[0] }), /listed twice/],
    ['chunk elsewhere', (m) => (m.adapters[1].chunks[0].path = 'home/base/chunk-0000.bin'), /path "home\/base\/chunk-0000\.bin" is not home\/adapters\/moon\/chunk-0000\.bin/],
    ['chunks short', (m) => m.adapters[1].chunks.pop(), /2 chunks listed, but size 2051 in chunks of 1024 is 3/],
    ['adapter too big', (m) => (m.adapters[1].size = MAX_ADAPTER_BYTES + 1), /over the limit/],
    ['scale 0', (m) => (m.adapters[1].scale = 0), /scale 0 is outside/],
    ['scale 9', (m) => (m.adapters[1].scale = 9), /scale 9 is outside/],
    ['kind', (m) => (m.adapters[1].kind = 'mood'), /not skill or obsession/],
    ['topic', (m) => (m.adapters[1].topic = ' '), /no topic/],
    ['rank', (m) => (m.adapters[1].rank = 0), /rank and alpha/],
    ['dtype', (m) => (m.adapters[1].dtype = 'q4'), /not f16, q8_0 or f32/],
    ['sha', (m) => (m.adapters[1].sha256 = 'XYZ'), /sha256 is not 64/],
  ];
  for (const [why, mutate, reason] of cases) {
    const m = manifest();
    mutate(m);
    assert.throws(() => parse(m), (e: unknown) => e instanceof ModelError && reason.test((e as Error).message), why);
  }
});
