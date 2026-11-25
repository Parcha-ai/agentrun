// node make.mjs <an earlier release's packages/import/dist>: each case of cases.mjs read to its cursor by that release's
// reader, in each kind of read, and resumed by it over the rest of the file: the cursor (v8, base64) and what the resume
// gave go into cursors.json. old-cursors.test.mjs resumes those cursors with this build. The cursor holds no path or
// file identity of the machine that made it: its home is HOME (rehomed) and its device and inode 0, which the test sets
// to its own file's.
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { CASES, HOME, jsonl, MODES, rehomed, summary } from "./cases.mjs";

const dist = resolve(process.argv[2]);
const { READERS } = await import(join(dist, "index.js"));
const out = [];
for (const c of CASES)
  for (const mode of MODES) {
    const root = await mkdtemp(join(tmpdir(), "old-cursors-"));
    const file = join(root, c.file);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, jsonl(c.one));
    const first = await READERS[c.source].read({ file }, undefined, mode);
    await appendFile(file, jsonl(c.two));
    const again = await READERS[c.source].read({ file }, structuredClone(first.cursor), mode);
    const cursor = { ...rehomed(structuredClone(first.cursor), root, HOME), dev: 0, ino: 0 };
    out.push({ name: c.name, mode, cursor: serialize(cursor).toString("base64"), resumed: summary(again) });
  }
await writeFile(join(dirname(fileURLToPath(import.meta.url)), "cursors.json"), `${JSON.stringify(out, null, 1)}\n`);
