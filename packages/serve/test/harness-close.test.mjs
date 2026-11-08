// A run on a harness other than pi closes its session when its process lets the run go: the adapter's close() stops the
// harness's own processes (its CLI, its app-server), so none outlives the run's process. On the faux harness, which
// tells each close to its script module.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { agent, follow, letGo, runDir, runRecordOf, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a run that completes closes its harness session once its process lets the run go`, { timeout: 120_000 }, async (t) => {
    const closedFile = join(await scratch(t), "closed.txt");
    withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_CLOSED: closedFile });
    const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
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
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
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

test("a session that lands after the stop and takes its time to close is closed in full before its process exits: the stop waits for that one close", { timeout: 120_000 }, async (t) => {
  const closedFile = join(await scratch(t), "closed.txt");
  // The session takes 3 s to open and 1 s to close (told closed only at the end of it), well within the door's 5 s bound.
  withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_CLOSED: closedFile, AGENTRUN_TEST_FAUX_HARNESS_OPEN_DELAY_MS: "3000", AGENTRUN_TEST_FAUX_HARNESS_CLOSE_DELAY_MS: "1000" });
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  assert.equal((await api("POST", "/agents", agent("slow-close", { harness: "claude-agent", instructions: "Answer the question." }))).status, 201);
  const run = await api("POST", "/agents/slow-close/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  let pid;
  for (const end = Date.now() + 20_000; !(pid && runRecordOf(data, run.body.run_id).holder?.serve); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, "the run's process names itself");
    const holder = runRecordOf(data, run.body.run_id).holder;
    pid = holder?.pid !== process.pid ? holder?.pid : undefined;
  }
  process.kill(pid, "SIGTERM");
  for (const end = Date.now() + 20_000; processAlive(pid); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the stopped process exits");
  const closed = existsSync(closedFile) ? readFileSync(closedFile, "utf8").trim().split("\n").filter(Boolean) : [];
  assert.deepEqual(closed.length, 1, `the late session's slow close finished before its process exited, once: ${JSON.stringify(closed)}`);
});

test("a late session whose close fails is logged once by the door, with its harness: never a failure the run's process swallows", { timeout: 120_000 }, async (t) => {
  // The session takes 3 s to open; its close takes 0.5 s and then fails.
  withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_OPEN_DELAY_MS: "3000", AGENTRUN_TEST_FAUX_HARNESS_CLOSE_DELAY_MS: "500", AGENTRUN_TEST_FAUX_HARNESS_CLOSE_ERROR: "the harness would not stop" });
  const { api, data } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS) });
  assert.equal((await api("POST", "/agents", agent("bad-close", { harness: "codex", instructions: "Answer the question." }))).status, 201);
  const run = await api("POST", "/agents/bad-close/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  let pid;
  for (const end = Date.now() + 20_000; !(pid && runRecordOf(data, run.body.run_id).holder?.serve); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, "the run's process names itself");
    const holder = runRecordOf(data, run.body.run_id).holder;
    pid = holder?.pid !== process.pid ? holder?.pid : undefined;
  }
  process.kill(pid, "SIGTERM");
  for (const end = Date.now() + 20_000; processAlive(pid); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the stopped process exits");
  // The run's process writes its log lines (JSON, one per line) to process.log in its folder.
  const logFile = join(runDir(data, run.body.run_id), "process.log");
  const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)) : [];
  const failed = lines.filter((line) => line.event === "door close failed").map(({ harness, error }) => ({ harness, error }));
  assert.deepEqual(failed, [{ harness: "codex", error: "the harness would not stop" }], "the door logged the failed close once");
});
