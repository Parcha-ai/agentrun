import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// `npm test` is scripts/run-tests.mjs: a test file that reported nothing must fail the run (a run once printed 513 tests where 519 ran, with "fail 0").
const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-tests.mjs");
function runFiles(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "run-tests-"));
  const paths = Object.entries(files).map(([name, body]) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  });
  // Inside a test file node:test's run() refuses to run ("called recursively"): the runner under test is a fresh top-level run.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const r = spawnSync(process.execPath, [runner, ...paths], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const GOOD = `import { test } from "node:test"; test("a", () => {}); test("b", () => {});`;

test("files that all report tests pass, and the total is the number of tests", () => {
  const r = runFiles({ "a.test.mjs": GOOD, "b.test.mjs": GOOD });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /# tests 4\b/);
});

test("a file that ends before reporting a test fails the run and is named", () => {
  const r = runFiles({ "ok.test.mjs": GOOD, "quits.test.mjs": `process.exit(0);` });
  assert.equal(r.status, 1);
  assert.match(r.err, /1 test file\(s\) reported no tests/);
  assert.match(r.err, /quits\.test\.mjs/);
});

test("a file that registers no test fails the run", () => {
  const r = runFiles({ "empty.test.mjs": `export {};` });
  assert.equal(r.status, 1);
  assert.match(r.err, /empty\.test\.mjs/);
});

test("a failing test fails the run", () => {
  const r = runFiles({ "bad.test.mjs": `import { test } from "node:test"; test("x", () => { throw new Error("boom"); });` });
  assert.equal(r.status, 1);
  assert.match(r.err, /boom/);
});

test("a failing after hook fails the run even when every test in its suite passed", () => {
  const r = runFiles({ "hook.test.mjs": `import { describe, it, after } from "node:test"; describe("s", () => { it("passes", () => {}); after(() => { throw new Error("hook boom"); }); });` });
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.err, /hook boom/);
});
