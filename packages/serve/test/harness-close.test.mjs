// A run on a harness other than pi closes its session when its process lets the run go: the adapter's close() stops the
// harness's own processes (its CLI, its app-server), so none outlives the run's process. On the faux harness, which
// tells each close to its script module.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, letGo, scratch, serve, withEnv } from "./support.mjs";

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
