// downloadsInto (tools.ts): what browser_downloads copied into the run's local folder is filed into the run's Workspace
// (Mode 2: the run's disk, here a folder of its own), where the run's read finds it. A file there with other bytes is
// never replaced: the download takes the next name, and the manifest and the call's answer say where it is. A file the
// run deleted is filed again; a large one already filed is compared in bounded reads; and in Mode 1 (the Workspace is the
// local folder itself) nothing is rewritten. The browser is a stand-in for pi-browser's fetchDownloads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

const { downloadsInto } = await import("../dist/tools.js");
const { localWorkspace } = await import("../dist/workspace/index.js");

const MANIFEST = "downloads/manifest.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A stand-in for pi-browser's browser_downloads: it copies `files` (a name to its bytes) into the call's local folder,
 *  as fetchDownloads names them there, writes its manifest, and answers as it does: the files fetched this call, and those
 *  fetched before. */
function browserDownloads(files) {
  return async (_args, _port, call) => {
    const dir = join(call.workspace, "downloads");
    mkdirSync(dir, { recursive: true });
    let rows = [];
    try { rows = JSON.parse(readFileSync(join(call.workspace, MANIFEST), "utf8")).files; } catch { rows = []; }
    const fetched = [];
    const already = [];
    for (const [name, bytes] of Object.entries(files)) {
      const row = { name, path: `downloads/${name}`, sizeBytes: bytes.length, sha256: sha(bytes), remote: { name, sizeBytes: bytes.length, modifiedAt: null }, session: "s1", fetchedAt: "2026-11-10T00:00:00.000Z" };
      const entry = { name, path: row.path, sizeBytes: row.sizeBytes, sha256: row.sha256 };
      if (rows.some((each) => each.path === row.path && each.sha256 === row.sha256)) { already.push(entry); continue; }
      writeFileSync(join(call.workspace, row.path), bytes);
      rows.push(row);
      fetched.push(entry);
    }
    writeFileSync(join(call.workspace, MANIFEST), `${JSON.stringify({ schema: "pi-browser.downloads.v1", files: rows }, null, 2)}\n`);
    const result = { fetched, already_fetched: already, skipped: [], manifest: MANIFEST };
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }], details: { downloads: result } };
  };
}
/** The run's local folder (where pi-browser copies) and its Workspace on the disk (another folder, as Mode 2's is). */
async function mode2(t) {
  const local = await scratch(t);
  const disk = await scratch(t);
  return { local, disk, work: localWorkspace(disk) };
}
const answerOf = (out) => JSON.parse(out.content[0].text);
const diskManifest = (disk) => JSON.parse(readFileSync(join(disk, MANIFEST), "utf8")).files;

test("a download whose name the run's Workspace already holds with other bytes takes the next name there, and the manifest and the answer say where; the run's own file is untouched", async (t) => {
  const { local, disk, work } = await mode2(t);
  mkdirSync(join(disk, "downloads"), { recursive: true });
  writeFileSync(join(disk, "downloads", "report.txt"), "the run's own report");
  const bytes = Buffer.from("the downloaded report");
  const out = await downloadsInto(browserDownloads({ "report.txt": bytes }), work, MANIFEST)({}, {}, { workspace: local });
  const renamed = `downloads/report-${sha(bytes).slice(0, 8)}.txt`;
  assert.equal(readFileSync(join(disk, "downloads", "report.txt"), "utf8"), "the run's own report", "never replaced");
  assert.equal(readFileSync(join(disk, renamed), "utf8"), "the downloaded report");
  assert.deepEqual(answerOf(out).fetched.map((entry) => entry.path), [renamed], "the answer names where it is");
  assert.deepEqual(out.details.downloads.fetched.map((entry) => entry.path), [renamed]);
  assert.deepEqual(diskManifest(disk).map((row) => row.path), [renamed], "and so does the run's manifest");
  // Called again: the same download, already filed under its own name, stays there and is named there.
  const again = await downloadsInto(browserDownloads({ "report.txt": bytes }), work, MANIFEST)({}, {}, { workspace: local });
  assert.deepEqual(answerOf(again).already_fetched.map((entry) => entry.path), [renamed]);
  assert.deepEqual(diskManifest(disk).map((row) => row.path), [renamed], "one row for it");
});

test("a download the run deleted from its Workspace is filed there again on the next call, though the local manifest has not changed", async (t) => {
  const { local, disk, work } = await mode2(t);
  const files = { "invoice.pdf": Buffer.from("%PDF the invoice") };
  await downloadsInto(browserDownloads(files), work, MANIFEST)({}, {}, { workspace: local });
  rmSync(join(disk, "downloads", "invoice.pdf"));
  await downloadsInto(browserDownloads(files), work, MANIFEST)({}, {}, { workspace: local });
  assert.equal(readFileSync(join(disk, "downloads", "invoice.pdf"), "utf8"), "%PDF the invoice", "filed again");
});

test("a download larger than one Workspace read (64 MiB) already filed is compared in bounded reads: a later download beside it files", async (t) => {
  const { local, disk, work } = await mode2(t);
  const big = Buffer.alloc(65 * 1024 * 1024, 7);
  await downloadsInto(browserDownloads({ "big.bin": big }), work, MANIFEST)({}, {}, { workspace: local });
  const out = await downloadsInto(browserDownloads({ "big.bin": big, "small.txt": Buffer.from("small") }), work, MANIFEST)({}, {}, { workspace: local });
  assert.notEqual(out.isError, true);
  assert.equal(readFileSync(join(disk, "downloads", "small.txt"), "utf8"), "small");
  assert.deepEqual(diskManifest(disk).map((row) => row.path).sort(), ["downloads/big.bin", "downloads/small.txt"]);
});

test("in Mode 1 (the run's Workspace is its local folder) the files and the manifest are left as the browser wrote them", async (t) => {
  const local = await scratch(t);
  const work = localWorkspace(local);
  await downloadsInto(browserDownloads({ "report.txt": Buffer.from("r") }), work, MANIFEST)({}, {}, { workspace: local });
  const before = readFileSync(join(local, MANIFEST));
  await downloadsInto(browserDownloads({ "report.txt": Buffer.from("r") }), work, MANIFEST)({}, {}, { workspace: local });
  assert.ok(readFileSync(join(local, MANIFEST)).equals(before), "the browser's own manifest, byte for byte");
});
