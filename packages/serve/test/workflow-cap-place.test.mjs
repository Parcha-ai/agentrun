// A raise that opens a paused workflow run again, its process let go, starts a process like any other start: under the
// server's limits (max_concurrent_runs, and the memory its harness takes). With no place free, the run waits for one,
// still paused, and opens once one frees; never a process past the limit.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { startServe } from "../dist/index.js";
import { agent, client, flowAgent, follow, letGo, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AGENTRUN_SERVE_BUDGET_HOLD_MS"];
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const ENDED = ["completed", "failed", "cancelled"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;

/** Two model nodes in a chain: under a $0.12 cap the first fits and the second waits for a raise. */
const twoNodes = () => ({
  v: 2, name: "twice",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "second", instructions: "Answer the question again.", out: "Answer", as: "answer" },
  ] },
});

test("a raise of a paused workflow whose process was let go, on a server whose one place another run holds, starts no process past the limit: the run waits for a place, and starts once one frees", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  const { api, data } = await serve(t, { faux: PRICED, maxRuns: 1 });
  assert.equal((await api("POST", "/agents", flowAgent("twice", twoNodes()))).status, 201);
  const started = await api("POST", "/agents/twice/runs", { input: { question: "What is six times seven?" }, max_cost_usd: 0.12 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).pending?.kind, "budget");
  await letGo(data, runId);
  // The one place, taken by a run that answers only once the test says so.
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const gate = join(data, "free");
  const busy = await api("POST", "/agents/busy/runs", { input: { content: `Answer once ${gate} exists.` } });
  assert.equal(busy.status, 202, JSON.stringify(busy.body));
  const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: 1 });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  // For 3 s: no process of its own for the raised run (the server's own take-back names this process, which is not one),
  // and nothing it runs.
  let opened = null;
  for (const end = Date.now() + 3_000; Date.now() < end && !opened; await sleep(100)) {
    const status = (await view(api, runId)).status;
    const pid = runRecordOf(data, runId).holder?.pid;
    if (["working", ...ENDED].includes(status) || (Number.isInteger(pid) && pid !== process.pid && processAlive(pid))) opened = { status, process: Number.isInteger(pid) && pid !== process.pid };
  }
  assert.deepEqual(opened, null, "the raised run starts no process while the server's one place is held");
  // Waiting for a place, as a run not yet started: queued, nothing pending of the person.
  const waiting = await view(api, runId);
  assert.deepEqual([waiting.status, waiting.pending, waiting.cost?.cap_usd], ["queued", null, 1], JSON.stringify(waiting));
  await writeFile(gate, "");
  await follow(api, busy.body.run_id, ["completed"], { deadlineMs: 60_000 });
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).status, "completed", "opened once the place freed, under the raised cap");
});

/** A server of one place at `data` (maxRuns 1): a capped `twoNodes` run paused and let go, then the place taken by a run
 *  that answers once `gate` exists, then the raise, which leaves the paused run waiting for a place. */
async function waitingForPlace(api, data, id, gate) {
  assert.equal((await api("POST", "/agents", flowAgent(id, twoNodes()))).status, 201);
  const { run_id: runId } = (await api("POST", `/agents/${id}/runs`, { input: { question: "What is six times seven?" }, max_cost_usd: 0.12 })).body;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).pending?.kind, "budget");
  await letGo(data, runId);
  assert.equal((await api("POST", "/agents", agent(`busy-${id}`))).status, 201);
  const busy = await api("POST", `/agents/busy-${id}/runs`, { input: { content: `Answer once ${gate} exists.` } });
  assert.equal(busy.status, 202, JSON.stringify(busy.body));
  assert.equal((await api("PATCH", `/runs/${runId}`, { max_cost_usd: 1 })).status, 200);
  for (const end = Date.now() + 5_000; (await view(api, runId)).status !== "queued"; await sleep(100)) assert.ok(Date.now() < end, "waits for a place, queued");
  return { runId, busyId: busy.body.run_id };
}

test("a run waiting for a place is still waiting after the server restarts: its pause's mark on disk, the next server finishes the raise once a place frees", { timeout: 240_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  const data = join(await scratch(t), "agents");
  const gate = join(data, "free");
  const first = await startServe({ data, port: 0, faux: PRICED, drainTimeout: "5s", maxRuns: 1 });
  const { runId, busyId } = await waitingForPlace(client(first.baseUrl, first.token), data, "restarted", gate);
  await first.close();
  const second = await startServe({ data, port: 0, faux: PRICED, drainTimeout: "5s", maxRuns: 1 });
  t.after(() => second.close());
  const api = client(second.baseUrl, second.token);
  // The busy run comes back too and may take the one place first: either way the raised run is never lost.
  await writeFile(gate, "");
  await follow(api, busyId, ["completed"], { deadlineMs: 90_000 });
  await follow(api, runId, ENDED, { deadlineMs: 90_000 });
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.error, run.cost?.cap_usd], ["completed", null, 1], JSON.stringify(run));
});

test("a run waiting for a place that is cancelled ends cancelled, and the place freeing opens nothing", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  const { api, data } = await serve(t, { faux: PRICED, maxRuns: 1 });
  const gate = join(data, "free");
  const { runId, busyId } = await waitingForPlace(api, data, "dropped", gate);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ENDED, { deadlineMs: 30_000 });
  assert.equal((await view(api, runId)).status, "cancelled");
  await writeFile(gate, "");
  await follow(api, busyId, ["completed"], { deadlineMs: 60_000 });
  // Given time to be tried again for the freed place (every second), nothing opens it.
  await sleep(3_000);
  const pid = runRecordOf(data, runId).holder?.pid;
  assert.deepEqual([(await view(api, runId)).status, Number.isInteger(pid) && pid !== process.pid && processAlive(pid)], ["cancelled", false]);
});

/** Polls `runId` up to `ms` for a status in `want`: the last one read. */
async function statusWithin(api, runId, want, ms) {
  let status;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    status = (await view(api, runId)).status;
    if (want.includes(status)) break;
  }
  return status;
}

test("a raise whose launch fails after its place was taken (a pin that throws) leaves the run waiting, never queued for good with no mark and no retry: the next try opens it", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  let failed = 0;
  const { api, data } = await serve(t, { faux: PRICED, maxRuns: 1, beforeRaiseLaunch: () => { if (failed++ === 0) throw new Error("a pin that fails, once"); } });
  const gate = join(data, "free");
  const { runId, busyId } = await waitingForPlace(api, data, "pinned", gate);
  await writeFile(gate, "");
  await follow(api, busyId, ["completed"], { deadlineMs: 60_000 });
  const status = await statusWithin(api, runId, ENDED, 30_000);
  assert.deepEqual([failed > 0, status], [true, "completed"], "the launch that failed left the run waiting, and the next try opened it under the raised cap");
});

test("a raised run waiting for a place gets the place that frees, never a newer start: new starts keep being refused until it has opened", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  const { api, data } = await serve(t, { faux: PRICED, maxRuns: 1 });
  const gate = join(data, "free");
  const { runId } = await waitingForPlace(api, data, "starved", gate);
  assert.equal((await api("POST", "/agents", agent("newer"))).status, 201);
  // A stream of new starts, refused while the place is held; then the place frees.
  let accepted;
  let raisedThen;
  const stream = (async () => {
    for (const end = Date.now() + 90_000; Date.now() < end; await sleep(50)) {
      const tried = await api("POST", "/agents/newer/runs", { input: { content: "hi" } });
      if (tried.status === 202) return void ((accepted = tried.body.run_id), (raisedThen = (await view(api, runId)).status));
      assert.equal(tried.status, 429, JSON.stringify(tried.body));
    }
  })();
  await sleep(500);
  await writeFile(gate, "");
  await stream;
  assert.ok(accepted, "a new start was accepted in the end");
  assert.notEqual(raisedThen, "queued", "the freed place went to the raised run that waited for it, not to a newer start");
});

test("a raise on a server whose memory for runs another run holds starts no process past the memory limit: the run waits for a place, and starts once the memory frees", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  const { RUN_MIB } = await import("../dist/harness.js");
  const { SERVER_MIB } = await import("../dist/host.js");
  // Room for one pi run and half another: the memory, not the count, is the limit.
  const MiB = 2 ** 20;
  const { api, data } = await serve(t, { faux: PRICED, hostMemory: (SERVER_MIB + RUN_MIB.pi + Math.floor(RUN_MIB.pi / 2)) * MiB });
  assert.ok((await api("GET", "/capabilities")).body.limits.max_concurrent_runs > 1, "the count would let two run");
  const gate = join(data, "free");
  const { runId, busyId } = await waitingForPlace(api, data, "memory", gate);
  let opened = null;
  for (const end = Date.now() + 3_000; Date.now() < end && !opened; await sleep(100)) {
    const status = (await view(api, runId)).status;
    const pid = runRecordOf(data, runId).holder?.pid;
    if (["working", ...ENDED].includes(status) || (Number.isInteger(pid) && pid !== process.pid && processAlive(pid))) opened = { status };
  }
  assert.deepEqual(opened, null, "no process past the memory for runs");
  await writeFile(gate, "");
  await follow(api, busyId, ["completed"], { deadlineMs: 60_000 });
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).status, "completed", "opened once the memory freed");
});

test("a server that closes while a raised run waits for a place tries it no more: no launch after the close, whatever frees (a pin)", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  const data = join(await scratch(t), "agents");
  const gate = join(data, "free");
  let launches = 0;
  const server = await startServe({ data, port: 0, faux: PRICED, drainTimeout: "5s", maxRuns: 1, beforeRaiseLaunch: () => void (launches += 1) });
  const api = client(server.baseUrl, server.token);
  const { runId } = await waitingForPlace(api, data, "closed", gate);
  await server.close();
  await writeFile(gate, "");
  // Past several of the retry's ticks (every second): none acts.
  await sleep(3_000);
  const pid = runRecordOf(data, runId).holder?.pid;
  assert.deepEqual([launches, Number.isInteger(pid) && pid !== process.pid && processAlive(pid)], [0, false]);
});

test("the place kept for a raised run waiting for one goes back when it is cancelled: a new start then takes the place that frees", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  const { api, data } = await serve(t, { faux: PRICED, maxRuns: 1 });
  const gate = join(data, "free");
  const { runId, busyId } = await waitingForPlace(api, data, "gone", gate);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ENDED, { deadlineMs: 30_000 });
  await writeFile(gate, "");
  await follow(api, busyId, ["completed"], { deadlineMs: 60_000 });
  assert.equal((await api("POST", "/agents", agent("after-cancel"))).status, 201);
  let started;
  for (const end = Date.now() + 10_000; Date.now() < end && started?.status !== 202; await sleep(200)) started = await api("POST", "/agents/after-cancel/runs", { input: { content: "hi" } });
  assert.equal(started?.status, 202, `nothing keeps the place for a cancelled run: ${JSON.stringify(started?.body)}`);
});

test("a raised run whose launch keeps failing leaves the queue after three tries, still paused at its cap, and keeps no place: a new start then takes it", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "1000" }, KEYS);
  let failed = 0;
  const { api, data } = await serve(t, { faux: PRICED, maxRuns: 1, beforeRaiseLaunch: () => { failed += 1; throw new Error("a pin that always fails"); } });
  const gate = join(data, "free");
  const { runId, busyId } = await waitingForPlace(api, data, "failing", gate);
  await writeFile(gate, "");
  await follow(api, busyId, ["completed"], { deadlineMs: 60_000 });
  for (const end = Date.now() + 15_000; failed < 3 && Date.now() < end; ) await sleep(200);
  await sleep(2_500);
  const run = await view(api, runId);
  assert.deepEqual([failed, run.status, run.pending?.kind], [3, "input_required", "budget"], JSON.stringify(run));
  assert.equal((await api("POST", "/agents", agent("after-fails"))).status, 201);
  const started = await api("POST", "/agents/after-fails/runs", { input: { content: "hi" } });
  assert.equal(started.status, 202, `the run that kept failing keeps no place: ${JSON.stringify(started.body)}`);
});
