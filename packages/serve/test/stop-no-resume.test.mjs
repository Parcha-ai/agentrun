// A run's timeline says "Resumed after the server stopped" only when a server stop cut the run's work. A run that
// answered is let go by its own server (SIGTERM once it completes), which records the same drain as a server stop; a
// follow-up then opens the run again, and nothing was resumed. The same holds for a run the person stopped mid-request:
// its process stays up, and the follow-up is a turn of its own. A real server stop (operability.test.mjs) and a crash
// (recovery.test.mjs) keep their rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, runDir, runRecordOf, serve } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resumedRows = (rows) => rows.filter((r) => r.kind === "phase" && r.summary.startsWith("Resumed")).map((r) => r.summary);
const recordOf = (data, runId) => { try { return runRecordOf(data, runId); } catch { return null; } };
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
    assert.deepEqual(resumedRows(rows), [], `the run answered and was let go, then followed up: no "Resumed" phase (its record was ${JSON.stringify({ status: let_go?.status, detail: let_go?.detail })}): ${shown(rows)}`);
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

test(`pi: a run stopped mid-request whose process then went, followed up, shows no "Resumed" phase: its turn had ended`, { timeout: 240_000 }, async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("stopped-gone", {}))).status, 201);
  // Its first request answers only after a minute: the turn is mid-request when the stop comes.
  const runId = (await api("POST", "/agents/stopped-gone/runs", { input: { content: "Take your time." } })).body.run_id;
  await until("the run works", async () => { const { status, state } = (await api("GET", `/runs/${runId}`)).body; return status === "working" && state === "working"; });
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  // The stopped run's process goes (killed, as a crash would take it): a run that waits for the person waits without one.
  const pid = recordOf(data, runId)?.holder?.pid;
  assert.ok(pid, "setup: the stopped run's process is known");
  process.kill(pid, "SIGKILL");
  await until("the run's process is gone", () => { try { process.kill(pid, 0); return false; } catch { return true; } });
  // The follow-up opens the run in a new process: its turn had ended at the stop, so nothing is resumed.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Go on." })).status, 202);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  assert.notEqual(recordOf(data, runId)?.holder?.pid, pid, "setup: the follow-up ran in a new process");
  assert.deepEqual(resumedRows(rows), [], `stopped, its process gone, then followed up: no "Resumed" phase: ${shown(rows)}`);
});

test(`pi: two follow-ups to a run that answered, the second sent while the first's reopen is in progress, show no "Resumed" phase`, { timeout: 240_000 }, async (t) => {
  let reached, release;
  const atLaunch = new Promise((resolve) => (reached = resolve));
  const held = new Promise((resolve) => (release = resolve));
  // The first follow-up's reopen is held after the run reads open again and before it launches the run's process.
  let holds = 0;
  const { api, data } = await serve(t, { beforeReopenLaunch: async () => { if (holds++ === 0) { reached(); await held; } } });
  assert.equal((await api("POST", "/agents", agent("answered-twice", {}))).status, 201);
  const runId = (await api("POST", "/agents/answered-twice/runs", { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  await until("the answered run's process let go", async () => { const r = recordOf(data, runId); return r !== null && r.status !== "running"; });
  const first = api("POST", `/runs/${runId}/messages`, { content: "Go on." });
  await atLaunch;
  // Sent while the first's reopen is held: the run already reads open again. Held long enough for a turn to answer.
  const second = api("POST", `/runs/${runId}/messages`, { content: "And then?" });
  await sleep(3_000);
  release();
  const [a, b] = [await first, await second];
  // Both are taken: neither is refused as a run that finished, whichever reached the run first.
  assert.deepEqual([a.status, b.status], [202, 202], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary).sort(), ["You: And then?", "You: Go on.", "You: hi"]);
  assert.deepEqual(resumedRows(rows), [], `two follow-ups, the second during the first's reopen: no "Resumed" phase: ${shown(rows)}`);
});

test(`pi: a stopped run whose live process dies while the follow-up goes to it shows "Resumed after a crash": that relaunch is no follow-up's open`, { timeout: 240_000 }, async (t) => {
  let data;
  let killed;
  // The follow-up is on its way to the stopped run's live process when that process dies.
  const { api, data: dir } = await serve(t, { beforeSubmit: async (runId, content) => {
    if (content !== "Go on.") return;
    const pid = recordOf(data, runId)?.holder?.pid;
    assert.ok(pid, "setup: the stopped run's process is known");
    process.kill(pid, "SIGKILL");
    await until("the run's process is gone", () => { try { process.kill(pid, 0); return false; } catch { return true; } });
    killed = pid;
  } });
  data = dir;
  assert.equal((await api("POST", "/agents", agent("stopped-dies", {}))).status, 201);
  // Its first request answers only after a minute: the turn is mid-request when the stop comes.
  const runId = (await api("POST", "/agents/stopped-dies/runs", { input: { content: "Take your time." } })).body.run_id;
  await until("the run works", async () => { const { status, state } = (await api("GET", `/runs/${runId}`)).body; return status === "working" && state === "working"; });
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Go on." })).status, 202);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  assert.ok(killed, "setup: the process died while the follow-up was in flight");
  assert.deepEqual(resumedRows(rows), ["Resumed after a crash"], `the stopped run's live process died under the follow-up, and the server relaunched it: its row stays: ${shown(rows)}`);
});
