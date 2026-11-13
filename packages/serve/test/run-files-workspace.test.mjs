// A run's files as the console reads them (GET /v2/runs/{id}/files and /files/{path}), read through the run's
// Workspace: each file's size and last change as the Workspace lists them, a file this server cannot read flagged and
// answered 403, a file bigger than one Workspace read streamed whole in ranges, and HEAD answered from the listing.
import assert from "node:assert/strict";
import { chmod, mkdir, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { READ_MAX } from "../dist/workspace/index.js";
import { follow, runDir, serve, startRun } from "./support.mjs";

async function finishedRun(t) {
  const served = await serve(t);
  const { run_id } = await startRun(served.api, "writer", "Write the report.", { tools: ["write"] });
  await follow(served.api, run_id, ["completed"]);
  return { ...served, run_id, work: join(runDir(served.data, run_id), "work") };
}

const get = (baseUrl, token, path, method = "GET") => fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}` } });

test("the list gives each file's size and last change as the run's Workspace lists them", async (t) => {
  const { api, run_id, work } = await finishedRun(t);
  await mkdir(join(work, "out"));
  await writeFile(join(work, "out", "table.csv"), "a,b\n1,2\n");
  const list = await api("GET", `/runs/${run_id}/files`);
  assert.equal(list.status, 200);
  const csv = list.body.files.find((file) => file.path === "out/table.csv");
  assert.equal(csv.size_bytes, 8);
  assert.equal(csv.content_type, "text/csv; charset=utf-8");
  assert.equal(Date.parse(csv.modified_at), Math.trunc((await stat(join(work, "out", "table.csv"))).mtimeMs), "modified_at is the file's own time");
});

test("a file this server cannot read is listed as unreadable, and reading it is 403 system_file_forbidden", { skip: process.getuid?.() === 0 && "root reads every file" }, async (t) => {
  const { api, baseUrl, token, run_id, work } = await finishedRun(t);
  await writeFile(join(work, "private.txt"), "made private by a tool in the box");
  await chmod(join(work, "private.txt"), 0o000);
  t.after(() => chmod(join(work, "private.txt"), 0o600).catch(() => undefined));
  const list = await api("GET", `/runs/${run_id}/files`);
  assert.deepEqual(list.body.files.find((file) => file.path === "private.txt"), { path: "private.txt", size_bytes: 33, modified_at: list.body.files.find((file) => file.path === "private.txt").modified_at, content_type: "text/plain; charset=utf-8", unreadable: true });
  const read = await get(baseUrl, token, `/runs/${run_id}/files/private.txt`);
  assert.equal(read.status, 403);
  const body = await read.json();
  assert.deepEqual([body.error.code, body.error.details], ["system_file_forbidden", { reason: "unreadable" }]);
});

test("a file bigger than one Workspace read is served whole, in ranges; HEAD gives its length and no body", { timeout: 60_000 }, async (t) => {
  const { baseUrl, token, run_id, work } = await finishedRun(t);
  // Sparse: READ_MAX + 3 bytes on the file system's word, a few blocks on its disk. The tail marks where the end is.
  const size = READ_MAX + 3;
  const handle = await open(join(work, "big.bin"), "w");
  await handle.write(Buffer.from("end"), 0, 3, READ_MAX);
  await handle.close();
  const head = await get(baseUrl, token, `/runs/${run_id}/files/big.bin`, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(size));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const whole = await get(baseUrl, token, `/runs/${run_id}/files/big.bin`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), String(size));
  const bytes = Buffer.from(await whole.arrayBuffer());
  assert.equal(bytes.length, size, "every byte, not a read's cap");
  assert.equal(bytes.subarray(-3).toString(), "end");
  assert.equal(bytes.subarray(0, 4096).every((byte) => byte === 0), true);
});
