// The supervise harness's per-test cleanup (test/live/_p5.ts) must not hide a leak. A test that passed but left a supervise
// loop running fails the run, with what it left named; after a test that failed, the same cleanup is allowed and the run
// fails only on that test. Offline: test/fixtures/p5-leak.ts with live off and a fake loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const run = (leakCase: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, P5_LEAK_CASE: leakCase };
  delete env.PDA_LIVE;
  delete env.NODE_TEST_CONTEXT; // a run of its own, not a subtest reporting to this one
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "test/fixtures/p5-leak.ts"], { cwd: PKG, env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const LEAK = "a test that passed left these up";

test("a passing test that leaves a supervise loop running fails the run, and the loop is named", () => {
  const r = run("leak");
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(LEAK), r.out);
  assert.match(r.out, /"test":"a supervise test".*"loops":1/, r.out);
});

test("after a test that failed, what it left is cleaned without a second failure", () => {
  const r = run("red");
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes("this test failed"), r.out);
  assert.ok(!r.out.includes(LEAK), r.out);
});

test("a passing test that stopped its own loop passes", () => {
  const r = run("clean");
  assert.equal(r.code, 0, r.out);
});
