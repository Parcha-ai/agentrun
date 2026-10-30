// A run's records are written whole (files.ts writeWhole): a temporary file beside the record, renamed over it. Two
// writes of one record at once (a launch's record of its box beside a stop's save) must never share that temporary
// file: one would rename the other's away, or keep writing into the file the other renamed.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeWhole } from "../dist/files.js";

test("concurrent whole writes of one record each land whole: none fails, the record is one of them entire, and no temporary file is left", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "write-whole-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "serve.json");
  const texts = ["a", "b", "c", "d"].map((c) => c.repeat(4 << 20));
  for (let round = 0; round < 5; round++) {
    const results = await Promise.allSettled(texts.map((text) => writeWhole(path, text)));
    assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => r.reason.message), [], "no write failed");
    const now = await readFile(path, "utf8");
    assert.ok(texts.includes(now), `the record is one write, whole (${now.length} bytes, starting ${JSON.stringify(now.slice(0, 1))})`);
    assert.deepEqual(await readdir(dir), ["serve.json"], "no temporary file is left");
  }
});
