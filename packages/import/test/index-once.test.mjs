// A file's records go into its source's index as they are read, once: none is staged in an index of its own and copied
// in when the file ends, which held a big file's records twice (2.1M records, 96 MB more) and left both indexes' grown
// arrays behind. A file the read pool read comes with its worker's index of its records: that index becomes the
// source's (the smaller one's records added to it), not copied into it. Counted here as the typed arrays this thread
// allocates, which, unlike RSS, come out the same every run.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { anthropicUsage, claudeAnswer, claudeFile, tempHome } from "./fixtures.mjs";

const LINES = 20_000;

// In a child of its own, so the typed-array constructors it counts by are no one else's: each array made with a length
// (not a view of another's buffer) adds its bytes. Buffers (lines, chunks) are made by Node's own class, uncounted, and
// so is all a pool worker allocates (a thread of its own, with its own globals).
const CHILD = `
let bytes = 0, on = false;
for (const name of ["Int32Array", "Float64Array", "Uint8Array"]) {
  const Base = globalThis[name];
  globalThis[name] = class extends Base { constructor(...a) { super(...a); if (on && typeof a[0] === "number") bytes += this.byteLength; } };
}
const { parseHome } = await import(process.argv[1]);
on = true;
const read = await parseHome(process.argv[2], { sources: ["claude-code"], catalog: false, threads: Number(process.argv[3]) });
on = false;
console.log(JSON.stringify({ bytes, calls: read[0].calls }));
`;

async function bytesPerRequest(t, threads) {
  const home = await tempHome(t);
  const file = claudeFile(home);
  const hex = (i) => i.toString(16).padStart(12, "0");
  const lines = [];
  for (let i = 0; i < LINES; i += 1) lines.push(JSON.stringify(claudeAnswer({ uuid: `00000000-0000-4000-8000-${hex(i)}`, msg: `msg_${i}`, req: `req_${i}`, usage: anthropicUsage(10, 5), i })));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${lines.join("\n")}\n`);
  const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", CHILD, dist, home, String(threads)]);
  const { bytes, calls } = JSON.parse(stdout);
  assert.equal(calls, LINES);
  return bytes / LINES;
}

test(`a file of ${LINES} requests read on this thread allocates under 700 typed-array bytes a request: its records are indexed once`, async (t) => {
  const perRequest = await bytesPerRequest(t, 1);
  // 613 a request with the records added to the source's index as read; 796 with them staged and copied in (the source's
  // index, the file's own index of its requests, and the requests' counts, each grown by doubling).
  assert.ok(perRequest < 700, `${Math.round(perRequest)} bytes a request`);
});

test(`a file of ${LINES} requests read by the pool allocates under 150 typed-array bytes a request on this thread: its worker's index becomes the source's`, async (t) => {
  const perRequest = await bytesPerRequest(t, 2);
  // 58 a request with the worker's index taken as the source's; 238 with its records copied into the source's index.
  assert.ok(perRequest < 150, `${Math.round(perRequest)} bytes a request`);
});
