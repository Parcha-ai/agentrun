// Lay a GGUF out the way the trainer does on the run's disk, for the checks: home/model/chunk-0000.bin ... and home/model/manifest.json (written last).
//   node scripts/make-model-disk.mjs <model.gguf> <outdir> ["Name (shown)"] [quant] [topic] [mechanism]
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [src, out, name = 'gemma-3-1b-it (Golden Gate)', quant = 'Q4_K_M', topic, mechanism] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: make-model-disk.mjs <model.gguf> <outdir> [name] [quant]');
const CH = 16 * 1024 * 1024;
const dir = join(out, 'home', 'model');
mkdirSync(dir, { recursive: true });
const size = statSync(src).size, fd = openSync(src, 'r'), whole = createHash('sha256'), chunks = [];
for (let n = 0, off = 0; off < size; n++, off += CH) {
  const len = Math.min(CH, size - off), buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, off);
  whole.update(buf);
  const path = `home/model/chunk-${String(n).padStart(4, '0')}.bin`;
  writeFileSync(join(out, path), buf);
  chunks.push({ n, path, offset: off, size: len, sha256: createHash('sha256').update(buf).digest('hex') });
}
closeSync(fd);
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 'gguf-chunks-v1', name, quant, size, sha256: whole.digest('hex'), chunk_bytes: CH, chunks, ...(topic ? { topic } : {}), ...(mechanism ? { mechanism } : {}) }));
console.log(`${chunks.length} chunks, ${size} bytes in ${dir}`);
