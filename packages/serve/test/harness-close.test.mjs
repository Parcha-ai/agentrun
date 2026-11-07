// A run on a harness other than pi closes its session when its process lets the run go: the adapter's close() stops the
// harness's own processes (its CLI, its app-server), so none outlives the run's process. On the faux harness, which
// tells each close to its script module.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { agent, follow, letGo, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a run that completes closes its harness session once its process lets the run go`, { timeout: 120_000 }, async (t) => {
    const closedFile = join(await scratch(t), "closed.txt");
    withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_CLOSED: closedFile });
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
    assert.equal((await api("POST", "/agents", agent(`closing-${harness}`, { harness, instructions: "Answer the question." }))).status, 201);
    const run = await api("POST", `/agents/closing-${harness}/runs`, { input: { content: "hi" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
    await letGo(data, run.body.run_id);
    const closed = existsSync(closedFile) ? readFileSync(closedFile, "utf8").trim().split("\n") : [];
    assert.deepEqual(closed.length, 1, `the session closed once, as the process let the run go: ${JSON.stringify(closed)}`);
  });
}

test("a run whose process is stopped while its harness session is still opening closes the session that lands after the stop, once", { timeout: 120_000 }, async (t) => {
  const closedFile = join(await scratch(t), "closed.txt");
  // The session takes 3 s to open (the faux adapter ignores the stop's signal, as a slow harness start does).
  withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_CLOSED: closedFile, AGENTRUN_TEST_FAUX_HARNESS_OPEN_DELAY_MS: "3000" });
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  assert.equal((await api("POST", "/agents", agent("slow-open", { harness: "claude-agent", instructions: "Answer the question." }))).status, 201);
  const run = await api("POST", "/agents/slow-open/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // Its process, once it names itself: stopped (SIGTERM, a drain) while its session is still opening.
  let pid;
  for (const end = Date.now() + 20_000; !(pid && runRecordOf(data, run.body.run_id).holder?.serve); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, "the run's process names itself");
    const holder = runRecordOf(data, run.body.run_id).holder;
    pid = holder?.pid !== process.pid ? holder?.pid : undefined;
  }
  process.kill(pid, "SIGTERM");
  for (const end = Date.now() + 20_000; processAlive(pid); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the stopped process exits");
  // Read as it exits: a process the server opens again takes 3 s more to open its own session, and closes it at its end.
  const closed = existsSync(closedFile) ? readFileSync(closedFile, "utf8").trim().split("\n").filter(Boolean) : [];
  assert.deepEqual(closed.length, 1, `the session that opened after the stop was closed, once: ${JSON.stringify(closed)}`);
});
