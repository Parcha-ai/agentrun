import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileChunkPath, fileDir, parseBaseAdapters } from '../src/adapter-manifest.ts';
// @ts-expect-error: a plain .mjs script, without types
import { describeAdapter, makeHomeDisk } from '../scripts/make-home-disk.mjs';

const REV = 'dcc83ea841ab6100d6b47a070329e1ba4cf78752';

/** A GGUF v3 file: the header (metadata and tensor infos) as llama.cpp writes it, then `pad` bytes standing in for the tensor data. */
function gguf(kv: [string, 'str' | 'f32' | 'u32', string | number][], tensors: { name: string; dims: number[]; type: number }[], pad: number): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
  const str = (s: string) => { u64(Buffer.byteLength(s)); parts.push(Buffer.from(s)); };
  parts.push(Buffer.from('GGUF'));
  u32(3); u64(tensors.length); u64(kv.length);
  for (const [k, t, v] of kv) {
    str(k);
    if (t === 'str') { u32(8); str(v as string); } else if (t === 'u32') { u32(4); u32(v as number); } else { u32(6); const b = Buffer.alloc(4); b.writeFloatLE(v as number); parts.push(b); }
  }
  for (const t of tensors) { str(t.name); u32(t.dims.length); for (const d of t.dims) u64(d); u32(t.type); u64(0); }
  parts.push(Buffer.alloc(pad, 7));
  return Buffer.concat(parts);
}
const loraTensors = (rank: number, aType: number) => [0, 1].flatMap((blk) => [
  { name: `blk.${blk}.attn_q.weight.lora_a`, dims: [1152, rank], type: aType },
  { name: `blk.${blk}.attn_q.weight.lora_b`, dims: [rank, 1024], type: 1 },
]);
const adapterGguf = (o: { rank?: number; alpha?: number; arch?: string; type?: string; aType?: number; pad?: number } = {}) =>
  gguf([['general.architecture', 'str', o.arch ?? 'gemma3'], ['general.type', 'str', o.type ?? 'adapter'], ['adapter.type', 'str', 'lora'], ['adapter.lora.alpha', 'f32', o.alpha ?? 32]], loraTensors(o.rank ?? 16, o.aType ?? 8), o.pad ?? 5000);
const baseGguf = () => gguf([['general.architecture', 'str', 'gemma3'], ['general.type', 'str', 'model'], ['general.file_type', 'u32', 15]], [{ name: 'token_embd.weight', dims: [1152, 262144], type: 12 }], 40_000);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'home-disk-'));
  const put = (name: string, body: Buffer | object) => { const p = join(dir, name); writeFileSync(p, Buffer.isBuffer(body) ? body : JSON.stringify(body)); return p; };
  const disk = join(dir, 'disk');
  return { dir, put, disk, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const read = (disk: string) => parseBaseAdapters(readFileSync(join(disk, 'home/manifest.json'), 'utf8'));
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Every chunk the published manifest names is on the disk with its size and sha256: what a tab would fetch is whole. */
function whole(disk: string): boolean {
  const m = read(disk);
  return [m.base, ...m.adapters].every((f) => f.chunks.every((c) => { const p = join(disk, c.path); if (!existsSync(p)) return false; const b = readFileSync(p); return b.length === c.size && hex(b) === c.sha256; }));
}
const folders = (disk: string) => (existsSync(join(disk, 'home/files')) ? readdirSync(join(disk, 'home/files')).sort() : []);
const concat = (disk: string, chunks: { path: string }[]) => Buffer.concat(chunks.map((c) => readFileSync(join(disk, c.path))));

test('a base and an adapter laid out: chunks that rebuild each file, rank, alpha and dtype from the adapter itself, the manifest the tab parses', () => {
  const s = setup();
  try {
    const base = s.put('base.gguf', baseGguf()), tools = s.put('tools.gguf', adapterGguf());
    const fields = s.put('tools.json', { name: 'tools.gguf', kind: 'skill', topic: "pi's tools" });
    makeHomeDisk([s.disk, '--base', base, '--base-model', `google/gemma-3-1b-it@${REV}`, '--base-name', 'gemma-3-1b-it', '--adapter', tools, '--fields', fields]);
    const m = read(s.disk);
    assert.deepEqual([m.base.name, m.base.quant, m.base.model.revision], ['gemma-3-1b-it', 'Q4_K_M', REV]);
    assert.deepEqual(concat(s.disk, m.base.chunks), readFileSync(base));
    const [a] = m.adapters;
    assert.deepEqual([a!.name, a!.kind, a!.rank, a!.alpha, a!.dtype, a!.scale, a!.model.revision], ['tools.gguf', 'skill', 16, 32, 'q8_0', 1, REV]);
    assert.deepEqual(concat(s.disk, a!.chunks), readFileSync(tools));
    assert.deepEqual(m.active, ['tools.gguf']);
  } finally { s.done(); }
});

test('a second adapter on the same disk: the base is not written again, the first adapter keeps its place, the new one is active', () => {
  const s = setup();
  try {
    const base = s.put('base.gguf', baseGguf());
    makeHomeDisk([s.disk, '--base', base, '--base-model', `google/gemma-3-1b-it@${REV}`, '--adapter', s.put('t.gguf', adapterGguf()), '--fields', s.put('t.json', { name: 'tools.gguf', kind: 'skill', topic: 'tools' })]);
    const chunk0 = join(s.disk, read(s.disk).base.chunks[0]!.path), before = statSync(chunk0).mtimeMs;
    makeHomeDisk([s.disk, '--adapter', s.put('m.gguf', adapterGguf({ rank: 32, alpha: 64, aType: 1 })), '--fields', s.put('m.json', { name: 'moon.gguf', kind: 'obsession', topic: 'the Moon' })]);
    const m = read(s.disk);
    assert.equal(statSync(chunk0).mtimeMs, before, 'the base chunks are untouched');
    assert.deepEqual(m.adapters.map((a) => [a.name, a.rank, a.dtype]), [['tools.gguf', 16, 'q8_0'], ['moon.gguf', 32, 'f16']]);
    assert.deepEqual(m.active, ['moon.gguf']);
    makeHomeDisk([s.disk, '--active', 'tools.gguf,moon.gguf']);
    assert.deepEqual(read(s.disk).active, ['tools.gguf', 'moon.gguf']);
    makeHomeDisk([s.disk, '--base', base, '--base-model', `google/gemma-3-1b-it@${REV}`, '--adapter', s.put('s.gguf', adapterGguf()), '--fields', s.put('s.json', { name: 'sun.gguf', kind: 'obsession', topic: 'the Sun' })]);
    assert.equal(statSync(chunk0).mtimeMs, before, 'the same base given again is left as it is (a tab may be reading it)');
    assert.deepEqual(read(s.disk).adapters.map((a) => a.name), ['tools.gguf', 'moon.gguf', 'sun.gguf']);
  } finally { s.done(); }
});

test('an adapter whose GGUF disagrees with its fields, is not an adapter, or is for another architecture is refused, and the manifest is not touched', () => {
  const s = setup();
  try {
    const base = s.put('base.gguf', baseGguf());
    const args = [s.disk, '--base', base, '--base-model', `google/gemma-3-1b-it@${REV}`];
    makeHomeDisk([...args, '--adapter', s.put('t.gguf', adapterGguf()), '--fields', s.put('t.json', { name: 'tools.gguf', kind: 'skill', topic: 'tools' })]);
    const manifest = readFileSync(join(s.disk, 'home/manifest.json'), 'utf8');
    const chunk0 = join(s.disk, read(s.disk).base.chunks[0]!.path), before = statSync(chunk0).mtimeMs;
    const cases: [string, Buffer, object, RegExp][] = [
      ['rank', adapterGguf(), { rank: 32 }, /says rank 32, .* says 16/],
      ['alpha', adapterGguf(), { alpha: 16 }, /says alpha 16, .* says 32/],
      ['a merged model', adapterGguf({ type: 'model' }), {}, /is not a LoRA adapter/],
      ['another architecture', adapterGguf({ arch: 'llama' }), {}, /is a llama adapter, the base is gemma3/],
      ['bf16 tensors', adapterGguf({ aType: 30 }), {}, /not an f16, f32 or q8_0 adapter/],
    ];
    for (const [why, body, extra, reason] of cases) {
      const a = s.put(`${why}.gguf`, body), f = s.put(`${why}.json`, { name: 'moon.gguf', kind: 'obsession', topic: 'the Moon', ...extra });
      assert.throws(() => makeHomeDisk([...args, '--adapter', a, '--fields', f]), reason, why);
      assert.equal(readFileSync(join(s.disk, 'home/manifest.json'), 'utf8'), manifest, why);
      assert.equal(statSync(chunk0).mtimeMs, before, `${why}: nothing is written, not even the same base again`);
    }
    assert.throws(() => makeHomeDisk([s.disk, '--adapter', s.put('x.gguf', adapterGguf()), '--fields', s.put('x.json', { name: 'x.gguf', kind: 'skill', topic: 'x', model: { repo: 'google/gemma-3-4b-it', revision: REV } })]), /trained on google\/gemma-3-4b-it/, 'the tab\'s own rule: another base model');
    assert.throws(() => makeHomeDisk([join(s.dir, 'empty'), '--adapter', s.put('y.gguf', adapterGguf()), '--fields', s.put('y.json', { name: 'y.gguf', kind: 'skill', topic: 'y' })]), /give --base and --base-model/);
  } finally { s.done(); }
});

test('the adapter header is read as llama.cpp wrote it: rank from lora_b, alpha, q8_0 when any tensor is', () => {
  const s = setup();
  try {
    assert.deepEqual(describeAdapter(s.put('a.gguf', adapterGguf({ rank: 8, alpha: 16 }))), { architecture: 'gemma3', rank: 8, alpha: 16, dtype: 'q8_0', tensors: 4 });
    assert.equal(describeAdapter(s.put('b.gguf', adapterGguf({ aType: 1 }))).dtype, 'f16');
    assert.throws(() => describeAdapter(s.put('c.gguf', Buffer.from('not a gguf at all'))), /is not a GGUF file/);
  } finally { s.done(); }
});

test('an adapter added to a disk without --base is still checked against the base: its architecture is read from the published chunks', () => {
  const s = setup();
  try {
    makeHomeDisk([s.disk, '--base', s.put('base.gguf', baseGguf()), '--base-model', `google/gemma-3-1b-it@${REV}`]);
    assert.throws(() => makeHomeDisk([s.disk, '--adapter', s.put('l.gguf', adapterGguf({ arch: 'llama' })), '--fields', s.put('l.json', { name: 'moon.gguf', kind: 'obsession', topic: 'the Moon' })]), /is a llama adapter, the base is gemma3/);
    makeHomeDisk([s.disk, '--adapter', s.put('g.gguf', adapterGguf()), '--fields', s.put('g.json', { name: 'moon.gguf', kind: 'obsession', topic: 'the Moon' })]);
    assert.deepEqual(read(s.disk).adapters.map((a) => a.name), ['moon.gguf']);
  } finally { s.done(); }
});

test('replacing an adapter never touches what the published manifest names: a run that stops before the manifest is renamed leaves the old disk whole', () => {
  const s = setup();
  try {
    makeHomeDisk([s.disk, '--base', s.put('base.gguf', baseGguf()), '--base-model', `google/gemma-3-1b-it@${REV}`, '--adapter', s.put('t1.gguf', adapterGguf({ pad: 5000 })), '--fields', s.put('t.json', { name: 'tools.gguf', kind: 'skill', topic: 'tools' })]);
    const before = readFileSync(join(s.disk, 'home/manifest.json'), 'utf8');
    mkdirSync(join(s.disk, 'home/manifest.json.tmp')); // the manifest cannot be written: the run stops after the new chunks, before the rename
    assert.throws(() => makeHomeDisk([s.disk, '--adapter', s.put('t2.gguf', adapterGguf({ pad: 6000 })), '--fields', join(s.dir, 't.json')]));
    assert.equal(readFileSync(join(s.disk, 'home/manifest.json'), 'utf8'), before);
    assert.ok(whole(s.disk), 'every chunk the old manifest names is there, byte for byte');
    rmSync(join(s.disk, 'home/manifest.json.tmp'), { recursive: true });
    makeHomeDisk([s.disk, '--adapter', join(s.dir, 't2.gguf'), '--fields', join(s.dir, 't.json')]);
    const m = read(s.disk);
    assert.equal(m.adapters[0]!.size, statSync(join(s.dir, 't2.gguf')).size);
    assert.ok(whole(s.disk));
    assert.deepEqual(folders(s.disk), [m.base, m.adapters[0]!].map((f) => fileDir(f.sha256, f.chunk_bytes).slice('home/files/'.length)).sort(), 'the old adapter\'s folder is gone once nothing names it');
  } finally { s.done(); }
});

test('the same adapter already published in another cut is kept as published, under its name or a new one, once its chunks hash to the file', () => {
  const s = setup();
  try {
    makeHomeDisk([s.disk, '--base', s.put('base.gguf', baseGguf()), '--base-model', `google/gemma-3-1b-it@${REV}`]);
    // a disk written by another tool: the same adapter in 1 KiB chunks
    const body = adapterGguf(), sha = hex(body), CH = 1024;
    const chunks = [];
    for (let n = 0, off = 0; off < body.length; n++, off += CH) {
      const part = body.subarray(off, Math.min(off + CH, body.length));
      mkdirSync(join(s.disk, fileDir(sha, CH)), { recursive: true });
      writeFileSync(join(s.disk, fileChunkPath(sha, CH, n)), part);
      chunks.push({ n, path: fileChunkPath(sha, CH, n), offset: off, size: part.length, sha256: hex(part) });
    }
    const m0 = read(s.disk);
    writeFileSync(join(s.disk, 'home/manifest.json'), JSON.stringify({ ...m0, adapters: [{ name: 'tools.gguf', kind: 'skill', topic: 'tools', model: m0.base.model, rank: 16, alpha: 32, scale: 1, dtype: 'q8_0', size: body.length, sha256: sha, chunk_bytes: CH, chunks }] }));
    assert.ok(whole(s.disk));
    makeHomeDisk([s.disk, '--adapter', s.put('t.gguf', body), '--fields', s.put('t.json', { name: 'tools.gguf', kind: 'skill', topic: 'tools' })]);
    assert.deepEqual(read(s.disk).adapters.map((a) => [a.name, a.chunk_bytes]), [['tools.gguf', CH]], 'the published cut is kept, files and entry');
    makeHomeDisk([s.disk, '--adapter', join(s.dir, 't.gguf'), '--fields', s.put('t2.json', { name: 'tools2.gguf', kind: 'skill', topic: 'tools, again' })]);
    const m = read(s.disk);
    assert.deepEqual(m.adapters.map((a) => [a.name, a.chunk_bytes, a.sha256]), [['tools.gguf', CH, sha], ['tools2.gguf', CH, sha]], 'a new name for the same file takes the published cut');
    assert.ok(whole(s.disk), 'what the manifest names is what is on the disk');
    assert.ok(!folders(s.disk).includes(`${sha}-${16 * 1024 * 1024}`), 'no second copy was written');
    // a published file whose chunks are not the bytes its sha256 says is refused, not reused
    writeFileSync(join(s.disk, fileChunkPath(sha, CH, 0)), Buffer.alloc(CH, 1));
    const before = readFileSync(join(s.disk, 'home/manifest.json'), 'utf8');
    assert.throws(() => makeHomeDisk([s.disk, '--adapter', join(s.dir, 't.gguf'), '--fields', s.put('t3.json', { name: 'tools3.gguf', kind: 'skill', topic: 'tools' })]), /is not the bytes its sha256 says/);
    assert.equal(readFileSync(join(s.disk, 'home/manifest.json'), 'utf8'), before);
  } finally { s.done(); }
});

test('one name given twice in one run is refused before anything is read or written', () => {
  const s = setup();
  try {
    const f = s.put('t.json', { name: 'tools.gguf', kind: 'skill', topic: 'tools' });
    assert.throws(() => makeHomeDisk([s.disk, '--base', s.put('base.gguf', baseGguf()), '--base-model', `google/gemma-3-1b-it@${REV}`, '--adapter', s.put('a.gguf', adapterGguf({ pad: 5000 })), '--fields', f, '--adapter', s.put('b.gguf', adapterGguf({ pad: 6000 })), '--fields', f]), /tools\.gguf is given twice/);
    assert.equal(existsSync(join(s.disk, 'home')), false);
  } finally { s.done(); }
});

test('a folder no manifest names (an interrupted run left it) is removed once the new manifest is in place', () => {
  const s = setup();
  try {
    mkdirSync(join(s.disk, 'home/files/leftover-16777216'), { recursive: true });
    writeFileSync(join(s.disk, 'home/files/leftover-16777216/chunk-0000.bin'), 'x');
    makeHomeDisk([s.disk, '--base', s.put('base.gguf', baseGguf()), '--base-model', `google/gemma-3-1b-it@${REV}`]);
    assert.deepEqual(folders(s.disk), [fileDir(read(s.disk).base.sha256, 16 * 1024 * 1024).slice('home/files/'.length)]);
  } finally { s.done(); }
});
