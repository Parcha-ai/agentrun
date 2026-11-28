import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { RUN_LABEL } from "@parcha/agentrun-computer";
import { EvalComputerCleanup } from "../dist/eval-computer-cleanup.js";
import { exitCodeOf, markdownReport } from "../dist/template-eval.js";

const ok = (value) => ({ ok: true, value });
const failed = { ok: false, error: { code: "vendor", message: "could not remove volume" } };
const docker = (release) => ({ id: "docker", create: async ({ name }) => ok({ id: name, name }), release });
const create = async (provider, name, runId) => (await provider.create({ name, labels: { [RUN_LABEL]: runId } }, {})).value;

test("an eval waits for its Docker release even when it starts on another provider instance", { timeout: 5_000 }, async () => {
  const cleanup = new EvalComputerCleanup();
  const release = Promise.withResolvers();
  const ref = await create(cleanup.track(docker()), "computer-1", "run-1");
  const ending = cleanup.track(docker(() => release.promise));
  let done = false;
  cleanup.begin(2_000);
  const result = cleanup.finish().then((issues) => { done = true; return issues; });
  const deletion = ending.release(ref, "delete");
  assert.equal(ending.release(ref, "delete"), deletion);
  await setImmediate();
  assert.equal(done, false);
  release.resolve(ok());
  await deletion;
  assert.deepEqual(await result, []);
});

test("one eval deadline aborts the pending release and identifies only the unfinished run", { timeout: 5_000 }, async () => {
  const cleanup = new EvalComputerCleanup();
  const provider = cleanup.track(docker(async (ref, _how, { signal }) => {
    if (ref.name === "computer-1") return ok();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return failed;
  }));
  const gone = await create(provider, "computer-1", "run-1");
  const stuck = await create(provider, "computer-2", "run-2");
  const slow = provider.release(stuck, "delete");
  await provider.release(gone, "delete");
  cleanup.begin(10);
  assert.deepEqual(await cleanup.finish(), [{ run_id: "run-2", computer: "computer-2", status: "timed_out" }]);
  await slow;
});

test("reports retain both grader verdicts and explicit Docker failures", async () => {
  const cleanup = new EvalComputerCleanup();
  assert.deepEqual(await cleanup.finish(), []);
  const provider = cleanup.track(docker(async () => failed));
  const ref = await create(provider, "computer-1", "run-1");
  await provider.release(ref, "delete");
  cleanup.begin(2_000);
  const issues = await cleanup.finish();
  assert.deepEqual(issues, [{ run_id: "run-1", computer: "computer-1", status: "failed", reason: "could not remove volume" }]);
  const report = {
    computer_cleanup: issues,
    package: { name: "evalpkg", version: "0.1.0" },
    passed: 0,
    cases: [{ name: "failed grade", pass: false, runs: [], cost_usd: 0 }],
    approvals: { measured: "never", package: "ask" },
    cost_usd: { total: 0, runs: 0, graders: 0, unknown: 0 },
  };
  assert.match(markdownReport(report), /Run run-1, Docker computer computer-1: cleanup failed: could not remove volume/);
  assert.equal(exitCodeOf(report), 1);
  const passing = { ...report, passed: 1, cases: [{ ...report.cases[0], pass: true }] };
  assert.equal(exitCodeOf(passing), 0);
});
