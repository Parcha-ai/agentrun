// A run whose cap is raised at its pause reads queued from the moment the raise is taken, before PATCH /runs/{id}
// answers: its follow-up turn is still to go, and nothing waits on a person. Never input_required with no pending, which
// `agentrun runs wait` and the client's runs.wait take as a run that needs someone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

/** The output-priced faux model ($100 a million output tokens: a request's least is $0.1024) in a process that cannot
 *  exit until EXIT_GATE exists, so the raise lands while the paused run's process is still being let go. */
const SLOW_EXIT = new URL("./fixtures/faux-output-priced-slow-exit.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const ENDED = ["completed", "failed", "cancelled"];
const holderPid = (data, runId) => JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")).holder.pid;

test("a run whose cap is raised at its pause reads queued at once, before its follow-up goes: never input_required with no pending", { timeout: 120_000 }, async (t) => {
  const gate = join(await scratch(t), "exit");
  withEnv(t, { EXIT_GATE: gate });
  const { api, data } = await serve(t, { faux: SLOW_EXIT });
  assert.equal((await api("POST", "/agents", agent("raised-status"))).status, 201);
  const { run_id } = (await api("POST", "/agents/raised-status/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  await follow(api, run_id, SETTLED);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.pending?.kind, "budget");
  // The paused process is held in its let-go, so the follow-up cannot go yet: the raise is taken, the run waits on nothing.
  assert.ok(processAlive(holderPid(data, run_id)), "the paused run's process is still being let go");
  assert.equal((await api("PATCH", `/runs/${run_id}`, { max_cost_usd: 1 })).status, 200);
  const run = (await api("GET", `/runs/${run_id}`)).body;
  assert.deepEqual([run.status, run.pending], ["queued", null], JSON.stringify(run));
  await writeFile(gate, "");
  await follow(api, run_id, ENDED, { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${run_id}`)).body.status, "completed");
});
