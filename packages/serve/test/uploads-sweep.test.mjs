// A start clears the temp files a crashed upload left: by the exact names the uploads code writes them under (a one-call
// upload's under DIR/files/, a PUT's in its file's folder), each only when it is a regular file. A link named like one,
// an upload's bytes and its record stay, and the start says how many it removed.
import assert from "node:assert/strict";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { client, FAUX, scratch } from "./support.mjs";

const exists = (path) => lstat(path).then(() => true, () => false);

test("a start removes a crashed upload's temp files by their exact names, and nothing else: not a link named like one, not an upload's bytes or record", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "not the server's");
  const lines = [];
  const start = () => startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", log: (line) => lines.push(line) });
  // A first server keeps one real upload.
  let server = await start();
  const sent = await fetch(`${server.baseUrl}/files?path=kept.txt`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: "kept bytes" });
  const { file } = await sent.json();
  assert.equal(sent.status, 201);
  await server.close();
  // What a crash leaves: a one-call upload's bytes under files/, a PUT's in its file's folder, as the uploads code names
  // them; and links named like them, pointing out of the data directory.
  const files = join(data, "files");
  const incoming = join(files, ".incoming.4242.0123456789ab.tmp");
  const putTemp = join(files, file.file_id, "bytes.4242.abcdef012345.tmp");
  const linkAtRoot = join(files, ".incoming.4243.0123456789ab.tmp");
  const linkInFolder = join(files, file.file_id, "bytes.4243.abcdef012345.tmp");
  await writeFile(incoming, "half a file");
  await writeFile(putTemp, "half");
  await symlink(outside, linkAtRoot);
  await symlink(outside, linkInFolder);
  lines.length = 0;
  server = await start();
  t.after(() => server.close());
  assert.deepEqual([await exists(incoming), await exists(putTemp)], [false, false], "the two temp files are gone");
  assert.deepEqual([(await lstat(linkAtRoot)).isSymbolicLink(), (await lstat(linkInFolder)).isSymbolicLink()], [true, true], "the links named like temps stay");
  assert.equal(await readFile(outside, "utf8"), "not the server's", "and what they point at is untouched");
  assert.equal(await readFile(join(files, file.file_id, "bytes"), "utf8"), "kept bytes", "the upload's bytes stay");
  const read = await client(server.baseUrl, server.token)("GET", `/files/${file.file_id}`);
  assert.deepEqual([read.status, read.body.status, read.body.sha256], [200, "ready", file.sha256], "and its record");
  assert.deepEqual(lines.filter((line) => line.includes("event=uploads_swept")).map((line) => line.replace(/^at=\S+ /, "")), ["event=uploads_swept removed=2"]);
  // A start with nothing to clear says nothing.
  await server.close();
  lines.length = 0;
  server = await start();
  assert.deepEqual(lines.filter((line) => line.includes("uploads_swept")), []);
});
