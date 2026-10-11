// Lay a base GGUF and its LoRA adapters out on a run's disk the way the tab reads them (src/adapter-manifest.ts, gguf-base-adapters-v1):
// home/base/chunk-0000.bin ..., home/adapters/<stem>/chunk-0000.bin ..., then home/manifest.json, written LAST (its appearance is the go signal).
//   node scripts/make-home-disk.mjs <outdir> [--base <base.gguf> --base-model <repo>@<40-hex revision> [--base-name <name>] [--base-quant <quant>]]
//        [--adapter <adapter.gguf> --fields <fields.json>]... [--active <a.gguf>,<b.gguf>]
// fields.json is what the trainer knows about the adapter: {name: "<stem>.gguf", kind: "skill" | "obsession", topic, scale?: 1, model?: {repo, revision},
// sampling?: {...}}. Rank, alpha and dtype are read from the adapter's own GGUF header (fields that say otherwise are refused), and so is its architecture,
// which must be the base's. On a disk that already has a manifest, the base is kept unless --base is given, adapters keep their places (one of the same
// name is replaced) and new ones are added at the end. The active adapter is the last one added, unless --active says otherwise. The manifest is checked
// with the tab's own parser before it is written, so the tab accepts whatever this script writes.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { adapterChunkPath, BASE_ADAPTERS_MANIFEST_PATH, baseChunkPath, parseBaseAdapters } from '../src/adapter-manifest.ts';

const CHUNK_BYTES = 16 * 1024 * 1024;
const GGML_TYPES = { 0: 'f32', 1: 'f16', 8: 'q8_0', 30: 'bf16' };
/** llama.cpp's general.file_type values for the quantizations a 1B base is shipped in. */
const FILE_TYPES = { 0: 'F32', 1: 'F16', 7: 'Q8_0', 15: 'Q4_K_M', 17: 'Q5_K_M', 18: 'Q6_K', 32: 'BF16' };

/** The key/value metadata and tensor infos of a GGUF file (v2 or v3), read from its header only. */
export function readGgufHeader(path) {
  const fd = openSync(path, 'r');
  let buf = Buffer.alloc(0), pos = 0, at = 0;
  const need = (n) => {
    while (buf.length - pos < n) {
      const more = Buffer.alloc(Math.max(1 << 20, n));
      const got = readSync(fd, more, 0, more.length, at);
      if (got === 0) throw new Error(`${path}: the GGUF header is cut short`);
      at += got;
      buf = Buffer.concat([buf.subarray(pos), more.subarray(0, got)]);
      pos = 0;
    }
  };
  const take = (n, read) => { need(n); const v = read(pos); pos += n; return v; };
  const u32 = () => take(4, (p) => buf.readUInt32LE(p));
  const u64 = () => Number(take(8, (p) => buf.readBigUInt64LE(p)));
  const str = () => { const n = u64(); return take(n, (p) => buf.toString('utf8', p, p + n)); };
  const value = (t) => {
    switch (t) {
      case 0: return take(1, (p) => buf.readUInt8(p));
      case 1: return take(1, (p) => buf.readInt8(p));
      case 2: return take(2, (p) => buf.readUInt16LE(p));
      case 3: return take(2, (p) => buf.readInt16LE(p));
      case 4: return u32();
      case 5: return take(4, (p) => buf.readInt32LE(p));
      case 6: return take(4, (p) => buf.readFloatLE(p));
      case 7: return take(1, (p) => buf.readUInt8(p) !== 0);
      case 8: return str();
      case 9: { const et = u32(), n = u64(), out = []; for (let i = 0; i < n; i++) out.push(value(et)); return out; }
      case 10: return u64();
      case 11: return Number(take(8, (p) => buf.readBigInt64LE(p)));
      case 12: return take(8, (p) => buf.readDoubleLE(p));
      default: throw new Error(`${path}: unknown GGUF value type ${t}`);
    }
  };
  try {
    if (take(4, (p) => buf.toString('latin1', p, p + 4)) !== 'GGUF') throw new Error(`${path} is not a GGUF file`);
    const version = u32();
    if (version !== 2 && version !== 3) throw new Error(`${path}: GGUF version ${version} is not 2 or 3`);
    const tensorCount = u64(), kvCount = u64();
    const kv = {};
    for (let i = 0; i < kvCount; i++) { const key = str(); kv[key] = value(u32()); }
    const tensors = [];
    for (let i = 0; i < tensorCount; i++) {
      const name = str(), dims = [];
      for (let n = u32(), d = 0; d < n; d++) dims.push(u64());
      tensors.push({ name, dims, type: u32() });
      u64(); // the data offset
    }
    return { kv, tensors };
  } finally {
    closeSync(fd);
  }
}

/** What an adapter's GGUF says about itself: a LoRA adapter, its architecture, rank, alpha and dtype. */
export function describeAdapter(path) {
  const { kv, tensors } = readGgufHeader(path);
  if (kv['general.type'] !== 'adapter' || kv['adapter.type'] !== 'lora') throw new Error(`${path} is not a LoRA adapter (general.type ${kv['general.type']}, adapter.type ${kv['adapter.type']})`);
  const ranks = new Set(tensors.filter((t) => t.name.endsWith('.lora_b')).map((t) => t.dims[0]));
  if (ranks.size !== 1) throw new Error(`${path}: its lora_b tensors do not agree on one rank (${[...ranks].join(', ') || 'none'})`);
  const types = new Set(tensors.map((t) => GGML_TYPES[t.type] ?? `type ${t.type}`));
  const dtype = types.has('q8_0') ? 'q8_0' : types.size === 1 && (types.has('f16') || types.has('f32')) ? [...types][0] : null;
  if (!dtype || [...types].some((t) => !['q8_0', 'f16', 'f32'].includes(t))) throw new Error(`${path}: tensor types ${[...types].join(', ')} are not an f16, f32 or q8_0 adapter`);
  const alpha = kv['adapter.lora.alpha'];
  if (typeof alpha !== 'number' || !(alpha > 0)) throw new Error(`${path}: no adapter.lora.alpha`);
  return { architecture: kv['general.architecture'], rank: [...ranks][0], alpha: Math.round(alpha * 1000) / 1000, dtype, tensors: tensors.length };
}

/** The manifest's fields for `src` in chunks at `pathOf(n)`; with `out`, the chunk files are written there too. */
function lay(src, pathOf, out) {
  const size = statSync(src).size, fd = openSync(src, 'r'), whole = createHash('sha256'), chunks = [];
  try {
    for (let n = 0, offset = 0; offset < size; n++, offset += CHUNK_BYTES) {
      const len = Math.min(CHUNK_BYTES, size - offset), part = Buffer.alloc(len);
      readSync(fd, part, 0, len, offset);
      whole.update(part);
      if (out) {
        mkdirSync(join(out, pathOf(n), '..'), { recursive: true });
        writeFileSync(join(out, pathOf(n)), part);
      }
      chunks.push({ n, path: pathOf(n), offset, size: len, sha256: createHash('sha256').update(part).digest('hex') });
    }
  } finally {
    closeSync(fd);
  }
  return { size, sha256: whole.digest('hex'), chunk_bytes: CHUNK_BYTES, chunks };
}

function parseArgs(argv) {
  const [out, ...rest] = argv;
  if (!out || out.startsWith('--')) throw new Error('usage: make-home-disk.mjs <outdir> [--base <gguf> --base-model <repo>@<rev> [--base-name N] [--base-quant Q]] [--adapter <gguf> --fields <json>]... [--active a.gguf,...]');
  const o = { out, adapters: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], v = rest[i + 1];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--adapter') o.adapters.push({ file: v });
    else if (flag === '--fields') { if (!o.adapters.length || o.adapters.at(-1).fields) throw new Error('--fields follows its --adapter'); o.adapters.at(-1).fields = v; }
    else if (['--base', '--base-model', '--base-name', '--base-quant', '--active'].includes(flag)) o[flag.slice(2).replace(/-(\w)/, (_, c) => c.toUpperCase())] = v;
    else throw new Error(`unknown flag ${flag}`);
  }
  for (const a of o.adapters) if (!a.fields) throw new Error(`--adapter ${a.file} has no --fields`);
  return o;
}

export function makeHomeDisk(argv) {
  const o = parseArgs(argv);
  const manifestPath = join(o.out, BASE_ADAPTERS_MANIFEST_PATH);
  const old = existsSync(manifestPath) ? parseBaseAdapters(readFileSync(manifestPath, 'utf8')) : null;
  let base = old?.base;
  let architecture = null;
  if (o.base) {
    const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/.exec(o.baseModel ?? '');
    if (!m) throw new Error('--base-model is <repo>@<40-hex revision>: the model the base was converted from, which every adapter must have been trained on');
    const { kv } = readGgufHeader(o.base);
    if (kv['general.type'] === 'adapter') throw new Error(`${o.base} is an adapter, not a base model`);
    architecture = kv['general.architecture'];
    const quant = o.baseQuant ?? FILE_TYPES[kv['general.file_type']] ?? '';
    base = { name: o.baseName ?? basename(o.base).replace(/\.gguf$/, ''), quant, model: { repo: m[1], revision: m[2] }, ...lay(o.base, baseChunkPath) };
  }
  if (!base) throw new Error(`${manifestPath} does not exist yet: give --base and --base-model`);
  const adapters = [...(old?.adapters ?? [])];
  const added = [];
  // Nothing is written until every file is read and the manifest passes the tab's rules; a file already on the disk with the same sha256 is left as it is.
  const writes = o.base ? [{ src: o.base, dir: 'home/base', pathOf: baseChunkPath, entry: base, same: old?.base.sha256 === base.sha256 && old?.base.chunk_bytes === base.chunk_bytes }] : [];
  for (const a of o.adapters) {
    const fields = JSON.parse(readFileSync(a.fields, 'utf8'));
    const got = describeAdapter(a.file);
    if (architecture && got.architecture !== architecture) throw new Error(`${a.file} is a ${got.architecture} adapter, the base is ${architecture}`);
    for (const k of ['rank', 'alpha', 'dtype']) if (fields[k] !== undefined && fields[k] !== got[k]) throw new Error(`${a.fields} says ${k} ${fields[k]}, ${a.file} says ${got[k]}`);
    const stem = String(fields.name ?? '').replace(/\.gguf$/, '');
    const entry = {
      name: fields.name, kind: fields.kind, topic: fields.topic, model: fields.model ?? base.model, rank: got.rank, alpha: got.alpha, scale: fields.scale ?? 1, dtype: got.dtype,
      ...(fields.sampling ? { sampling: fields.sampling } : {}), ...(fields.verified_on ? { verified_on: fields.verified_on } : {}),
      ...lay(a.file, (n) => adapterChunkPath(stem, n)),
    };
    writes.push({ src: a.file, dir: join('home/adapters', stem), pathOf: (n) => adapterChunkPath(stem, n), entry, same: old?.adapters.find((x) => x.name === entry.name)?.sha256 === entry.sha256 });
    const at = adapters.findIndex((x) => x.name === entry.name);
    if (at >= 0) adapters[at] = entry; else adapters.push(entry);
    added.push(entry.name);
  }
  const active = o.active ? o.active.split(',') : added.length ? [added.at(-1)] : old?.active;
  const manifest = { format: 'gguf-base-adapters-v1', base, adapters, ...(active ? { active } : {}) };
  const text = JSON.stringify(manifest);
  parseBaseAdapters(text); // the tab's own rules: what it would refuse is not written
  for (const w of writes) {
    if (w.same) continue;
    rmSync(join(o.out, w.dir), { recursive: true, force: true });
    if (lay(w.src, w.pathOf, o.out).sha256 !== w.entry.sha256) throw new Error(`${w.src} changed while it was laid out`);
  }
  mkdirSync(join(manifestPath, '..'), { recursive: true });
  writeFileSync(`${manifestPath}.tmp`, text);
  renameSync(`${manifestPath}.tmp`, manifestPath);
  return manifest;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const m = makeHomeDisk(process.argv.slice(2));
  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  console.log(`base ${m.base.name} ${mb(m.base.size)} in ${m.base.chunks.length} chunks; adapters: ${m.adapters.map((a) => `${a.name} (${a.kind}, r${a.rank}, ${a.dtype}, ${mb(a.size)})`).join(', ') || 'none'}; active: ${(m.active ?? []).join(', ') || 'the last listed'}`);
}
