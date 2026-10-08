// The vendored Stagehand facade (src/vendor/stagehand-facade) is upstream's bytes at the commit UPSTREAM.json names,
// with nothing added, removed or edited (scripts/vendor-facade.mjs, offline): a local edit, a stray file or a missing
// one fails here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FACADE_DIR, blobId, checkVendored, unlistedImports, vendor } from "../scripts/vendor-facade.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "vendor-facade.mjs");

test("the vendored facade is byte for byte the upstream commit its manifest names", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.match(out, /4 files match [0-9a-f]{40} \(@browserbasehq\/stagehand@4\.1\.0\)/);
});

test("one changed byte, a stray file or a missing file is drift; a new commit needs its release named", (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "facade-drift-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--commit", "0".repeat(40)], { encoding: "utf8", stdio: "pipe" }), /needs --release NAME/);
});

test("the refresh's import scan finds static, side-effect and dynamic relative imports with any spacing", () => {
  const fetched = new Map(Object.entries({
    "tools.ts": Buffer.from(`import { a } from "./contract.js";\nexport * from './runtime.js';\nimport "./setup.js";\nconst h = await import ( "./helper.js" );\nimport { z } from "zod/v4";\nimport { r } from "../harness/redact.js";\n`),
  }));
  const missing = unlistedImports(fetched, new Set(["tools.ts", "contract.ts", "runtime.ts"])).map(({ spec, target }) => `${spec} -> ${target}`);
  assert.deepEqual(missing, ["./setup.js -> setup.ts", "./helper.js -> helper.ts", "../harness/redact.js -> ../harness/redact.ts"], "every unlisted relative import is named; a listed one and a bare package are not");
  assert.deepEqual(unlistedImports(fetched, new Set(["tools.ts", "contract.ts", "runtime.ts", "setup.ts", "helper.ts", "../harness/redact.ts"])), [], "a closed set has none");
});

test("a refresh refused for an unlisted import writes nothing; a closed set is written with its manifest", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "facade-refresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = { "tools.ts": Buffer.from(`import { c } from "./contract.js";\n`), "contract.ts": Buffer.from("export const c = 1;\n") };
  const io = { listing: async () => new Map(Object.entries(upstream).map(([name, bytes]) => [name, blobId(bytes)])), read: async (_commit, name) => upstream[name] };
  const commit = "a".repeat(40);
  fs.writeFileSync(path.join(dir, "UPSTREAM.json"), JSON.stringify({ release: "old", files: { "tools.ts": {} } }));
  fs.writeFileSync(path.join(dir, "tools.ts"), "the vendored copy before the refresh\n");
  const before = Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
  await assert.rejects(vendor(commit, "next", { dir, io }), /tools\.ts imports \.\/contract\.js, which UPSTREAM\.json does not list/);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])), before, "nothing was written");
  fs.writeFileSync(path.join(dir, "UPSTREAM.json"), JSON.stringify({ release: "old", files: { "tools.ts": {}, "contract.ts": {} } }));
  const manifest = await vendor(commit, "next", { dir, io });
  assert.equal(manifest.release, "next");
  assert.deepEqual(Object.keys(manifest.files).sort(), ["contract.ts", "tools.ts"]);
  assert.equal(fs.readFileSync(path.join(dir, "contract.ts"), "utf8"), "export const c = 1;\n");
  assert.deepEqual(checkVendored(dir).problems, [], "the written set passes the offline check");
});
