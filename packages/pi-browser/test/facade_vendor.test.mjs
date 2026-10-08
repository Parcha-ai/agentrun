// The vendored Stagehand facade (src/vendor/stagehand-facade) is upstream's bytes at the commit UPSTREAM.json names,
// with nothing added, removed or edited (scripts/vendor-facade.mjs, offline): a local edit, a stray file or a missing
// one fails here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FACADE_DIR, checkVendored } from "../scripts/vendor-facade.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the vendored facade is byte for byte the upstream commit its manifest names", () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/vendor-facade.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /4 files match [0-9a-f]{40} \(@browserbasehq\/stagehand@4\.1\.0\)/);
});

test("one changed byte, a stray file or a missing file is drift", async (t) => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "facade-drift-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  fs.cpSync(FACADE_DIR, dir, { recursive: true });
  assert.deepEqual(checkVendored(dir).problems, []);
  const tools = path.join(dir, "tools.ts");
  fs.writeFileSync(tools, fs.readFileSync(tools, "utf8").replace("timeout: 60_000", "timeout: 90_000"));
  fs.writeFileSync(path.join(dir, "local-patch.ts"), "export {};\n");
  fs.rmSync(path.join(dir, "runtime.ts"));
  const problems = checkVendored(dir).problems.join("\n");
  assert.match(problems, /^tools\.ts: blob /m);
  assert.match(problems, /^local-patch\.ts is not in UPSTREAM\.json$/m);
  assert.match(problems, /^runtime\.ts is missing$/m);
});
