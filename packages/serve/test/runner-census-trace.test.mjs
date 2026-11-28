// A run's end that makes no census (RunnerOptions.census failed or took past censusMs) writes "unscanned", so the run's
// files read 403 after it. The runner says so, once, as an error event (step "census") with the run's id and why, so that
// 403 can be traced to its end. Why is an error's code or name, never its message, which may name a file of the run's.
// A run with nothing to count (a census of undefined: never handed a secret) says nothing. Each end with no census is also
// a census-failed event, whose metric line (`runner_census_failed runner run cause`) a log-based alert counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { metricLine } from "../dist/runner/runner-metrics.js";
import { queue, sleep, STEADY_LEASE, stores } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 50 };

/** A loop that throws at its start: the runner ends the run failed itself (endRun), census first. */
const failingLoop = () => ({
  start: async () => {
    throw new Error("the loop failed");
  },
  command: async () => ({ refused: "not in this test" }),
  stop: async () => {},
});

/** Runs `run-1` to its end under `census`, and returns the runner's census events, waiting at most 3 s for the end. */
async function censusEvents(t, census, extra = {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const events = [];
  const runner = startRunner({ store: opened.runners[0], createLoop: failingLoop, name: "runner-a", census, onEvent: (event) => events.push(event), ...TIMING, ...extra });
  t.after(() => runner.close());
  const until = Date.now() + 3_000;
  while (Date.now() < until && !events.some((event) => event.type === "ended")) await sleep(20);
  assert.ok(events.some((event) => event.type === "ended" && event.runId === "run-1"), "the run ended");
  const failed = events.filter((event) => event.type === "census-failed");
  const said = events.filter((event) => event.type === "error" && event.step === "census");
  assert.equal(failed.length, said.length, "a census-failed event beside each census error");
  said.metrics = failed.map((event) => metricLine("runner-a", event));
  return said;
}

/** The fields of a metric line (print.ts logLine: `at=<ISO> event=<name> key=value ...`), its time left out. */
const fields = (line) => Object.fromEntries(line.split(" ").slice(1).map((pair) => pair.split("=")));

test("a census that fails is said once with the run's id and the error's code, never its message", async (t) => {
  const failure = Object.assign(new Error("EACCES: open 'notes/not-a-secret-census-path-7c1e.txt'"), { code: "EACCES" });
  const said = await censusEvents(t, async () => {
    throw failure;
  });
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.equal(said[0].runId, "run-1");
  assert.match(said[0].message, /^it failed \(EACCES\): the end writes "unscanned"/);
  assert.equal(said[0].message.includes("not-a-secret-census-path"), false, "the error's message, which names a file, is never said");
  assert.equal(said.metrics.length, 1);
  assert.deepEqual(fields(said.metrics[0]), { event: "runner_census_failed", runner: "runner-a", run: "run-1", cause: "EACCES" });
  assert.equal(said.metrics[0].includes("not-a-secret-census-path"), false);
});

test("a census that throws a value with no code is said by its name", async (t) => {
  const said = await censusEvents(t, async () => {
    throw new TypeError("not-a-secret-census-detail-7c1e");
  });
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0].message, /^it failed \(TypeError\)/);
  assert.equal(said[0].message.includes("not-a-secret-census-detail"), false);
  assert.deepEqual(fields(said.metrics[0]), { event: "runner_census_failed", runner: "runner-a", run: "run-1", cause: "TypeError" });
});

test("a census past censusMs is said once with the run's id and the wait", async (t) => {
  const said = await censusEvents(t, () => new Promise(() => {}), { censusMs: 50 });
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.equal(said[0].runId, "run-1");
  assert.match(said[0].message, /^none within 50 ms: the end writes "unscanned"/);
  assert.deepEqual(fields(said.metrics[0]), { event: "runner_census_failed", runner: "runner-a", run: "run-1", cause: "timeout" });
});

test("a run with nothing to count (a census of undefined) says nothing", async (t) => {
  const said = await censusEvents(t, async () => undefined);
  assert.deepEqual([...said], []);
  assert.deepEqual(said.metrics, [], "no metric line");
});
