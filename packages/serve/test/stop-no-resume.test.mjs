// A run's timeline says "Resumed after the server stopped" only when a server stop cut the run's work. A run that
// answered is let go by its own server (SIGTERM once it completes), which records the same drain as a server stop; a
// follow-up then opens the run again, and nothing was resumed. The same holds for a run the person stopped mid-request:
// its process stays up, and the follow-up is a turn of its own. A real server stop (operability.test.mjs) and a crash
// (recovery.test.mjs) keep their rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resumedRows = (rows) => rows.filter((r) => r.kind === "phase" && r.summary.startsWith("Resumed")).map((r) => r.summary);
const recordOf = (data, runId) => { try { return JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")); } catch { return null; } };
const shown = (rows) => JSON.stringify(rows.map((r) => [r.kind, r.summary]));

/** Waits for `check`, up to `ms`; fails naming `what`. */
async function until(what, check, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await sleep(100)) assert.ok(Date.now() < end, what);
}

for (const harness of ["pi", "claude-agent"]) {
  test(`${harness}: a run that answered, then is followed up, shows no "Resumed" phase: its server let it go, nothing stopped or crashed`, { timeout: 240_000 }, async (t) => {
    const fauxHarness = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
    const { api, data } = await serve(t, harness === "pi" ? {} : { fauxHarness });
    const id = `answered-${harness}`;
    assert.equal((await api("POST", "/agents", harness === "pi" ? agent(id, {}) : agent(id, { harness, instructions: "Make three requests." }))).status, 201);
    const runId = (await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } })).body.run_id;
    await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
    // Its server lets the answered run's process go: the follow-up opens the run in a new process.
    await until("the answered run's process let go", async () => { const r = recordOf(data, runId); return r !== null && r.status !== "running"; });
    const let_go = recordOf(data, runId);
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Go on." })).status, 202);
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
    assert.deepEqual(resumedRows(rows), [], `the run answered and was let go, then followed up: no "Resumed" phase (run.json was ${JSON.stringify({ status: let_go?.status, detail: let_go?.detail })}): ${shown(rows)}`);
  });
}

test(`pi: a run stopped mid-request, then followed up, shows no "Resumed" phase: its process stayed up`, { timeout: 240_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("stopped", {}))).status, 201);
  // Its first request answers only after a minute: the turn is mid-request when the stop comes.
  const runId = (await api("POST", "/agents/stopped/runs", { input: { content: "Take your time." } })).body.run_id;
  await until("the run works", async () => { const { status, state } = (await api("GET", `/runs/${runId}`)).body; return status === "working" && state === "working"; });
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Go on." })).status, 202);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  assert.deepEqual(resumedRows(rows), [], `stopped and followed up in the same process: no "Resumed" phase: ${shown(rows)}`);
});
