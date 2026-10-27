// What one host can hold, and what it says about itself: a cap on concurrent runs from its memory, a health route that
// reads the store and the free disk, a cancel that settles a run whose carry back cannot be written, and a run whose
// process was killed answered again at once.
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve, storeRun } from "./support.mjs";

const MiB = 2 ** 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = (dir, name = "never") => `Answer once ${join(dir, name)} exists.`;

test("the default cap on concurrent runs: the host's memory less the server's 128 MiB, at 72 MiB a run, never under 1", async () => {
  const { defaultMaxRuns } = await import("../dist/index.js");
  assert.equal(typeof defaultMaxRuns, "function");
  assert.equal(defaultMaxRuns(512 * MiB), 5, "a 512 MB instance, which ran out of memory at about 6");
  assert.equal(defaultMaxRuns(1024 * MiB), 12);
  assert.equal(defaultMaxRuns(8 * 1024 * MiB), 112);
  assert.equal(defaultMaxRuns(100 * MiB), 1, "never under 1");
});

test("over the cap, a new run is 429 rate_limited with retry-after and nothing starts; capabilities report the cap", async (t) => {
  const { api, data } = await serve(t, { maxRuns: 2 });
  assert.equal((await api("GET", "/capabilities")).body.limits.max_concurrent_runs, 2);
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const started = [];
  for (let i = 0; i < 2; i++) {
    const run = await api("POST", "/agents/busy/runs", { input: { content: busy(data, `go-${i}`) } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    started.push(run.body.run_id);
  }
  const refused = await api("POST", "/agents/busy/runs", { input: { content: busy(data, "go-x") } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.retryable], [429, "rate_limited", true], JSON.stringify(refused.body));
  assert.match(refused.headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal(refused.body.error.details.max_concurrent_runs, 2);
  assert.equal((await api("GET", "/runs")).body.runs.length, 2, "nothing more started");
  // One ends: there is room again.
  await writeFile(join(data, "go-0"), "");
  await follow(api, started[0], ["completed"]);
  assert.equal((await api("POST", "/agents/busy/runs", { input: { content: busy(data, "go-1") } })).status, 202);
  await writeFile(join(data, "go-1"), "");
});

test("two starts at once with one place left: one starts and one is 429", async (t) => {
  const { api, data } = await serve(t, { maxRuns: 1 });
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const both = await Promise.all([0, 1].map((i) => api("POST", "/agents/busy/runs", { input: { content: busy(data, `twin-${i}`) } })));
  assert.deepEqual(both.map((r) => r.status).sort(), [202, 429]);
  assert.equal((await api("GET", "/runs")).body.runs.length, 1);
});

test("a start that fails gives its place back: after a store write refused, and after an app that does not load, the next run still starts", { skip: process.getuid?.() === 0 && "root writes a directory of mode 555" }, async (t) => {
  const { api, data } = await serve(t, { maxRuns: 1 });
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  // The store's directory read-only: startRun's row cannot be written, and the start fails.
  await chmod(data, 0o555);
  let failed;
  try {
    failed = await api("POST", "/agents/busy/runs", { input: { content: busy(data, "never-0") } });
  } finally {
    await chmod(data, 0o755);
  }
  assert.ok(failed.status >= 500, JSON.stringify(failed.body));
  const next = await api("POST", "/agents/busy/runs", { input: { content: busy(data, "go-0") } });
  assert.equal(next.status, 202, `the failed start kept the one place: ${JSON.stringify(next.body)}`);
  await writeFile(join(data, "go-0"), "");
  await follow(api, next.body.run_id, ["completed"]);
  // A run whose app does not load: it starts, its process fails at once, and the place is free again.
  const broken = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-broken.mjs", import.meta.url).pathname });
  assert.equal((await broken.api("POST", "/agents", agent("broken"))).status, 201);
  for (let i = 0; i < 2; i++) {
    const run = await broken.api("POST", "/agents/broken/runs", { input: { content: "hi" } });
    assert.equal(run.status, 202, `start ${i}: ${JSON.stringify(run.body)}`);
    await follow(broken.api, run.body.run_id, ["failed"]);
  }
});

test("a run whose process fails at its start is never started again while its end is written: one process, and its place is free once it reads failed", async (t) => {
  const { api, data } = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-broken.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("broken"))).status, 201);
  const run = await api("POST", "/agents/broken/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // The agent store held by another writer while the process fails, as a loaded host's slow store does: the run's end
  // waits, and nothing may start its process again meanwhile.
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  t.after(() => store.isOpen && store.close());
  store.exec("BEGIN IMMEDIATE");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  store.exec("ROLLBACK");
  store.close();
  await follow(api, run.body.run_id, ["failed"]);
  const log = await readFile(join(data, "runs", run.body.run_id, "process.log"), "utf8");
  assert.equal(log.split("has no default export").length - 1, 1, `one process for the run:\n${log}`);
  const next = await api("POST", "/agents/broken/runs", { input: { content: "hi" } });
  assert.equal(next.status, 202, `its place is free: ${JSON.stringify(next.body)}`);
});

test("AGENTRUN_MAX_RUNS and --max-runs set the cap; a value that is not a positive integer is refused", async (t) => {
  const { data } = await serve(t);
  const zero = await startServe({ data: join(data, "..", "other"), port: 0, faux: FAUX, maxRuns: 0 }).then((server) => (t.after(() => server.close()), "started"), (error) => error.message);
  assert.match(zero, /max runs/i, "0 is refused");
  const caps = (await import("../dist/index.js")).capabilities({ AGENTRUN_MAX_RUNS: "7" });
  assert.equal(caps.limits.max_concurrent_runs, 7);
});

test("GET /v2/health, with no credential: 200 when the store reads and the disk has room, and nothing it should not say", async (t) => {
  const { baseUrl, data } = await serve(t);
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: "ok", checks: { store: "ok", disk: "ok" } });
  assert.ok(!JSON.stringify(body).includes(data), "no path");
});

test("health is 503 with the reason when the free disk is under its floor, or the store does not open", { skip: process.getuid?.() === 0 && "root reads a file of mode 000" }, async (t) => {
  const { baseUrl } = await serve(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const low = await fetch(`${baseUrl}/health`);
  assert.equal(low.status, 503);
  assert.deepEqual(await low.json(), { status: "failing", checks: { store: "ok", disk: "below_floor" } });
  const other = await serve(t);
  const file = join(other.data, "store.sqlite");
  await chmod(file, 0o000);
  try {
    const broken = await fetch(`${other.baseUrl}/health`);
    assert.equal(broken.status, 503);
    assert.deepEqual(await broken.json(), { status: "failing", checks: { store: "does_not_open", disk: "ok" } });
  } finally {
    await chmod(file, 0o600);
  }
});

test("a disk health cannot measure fails its check (503 cannot_check), never reads as room", async (t) => {
  const { healthOf } = await import("../dist/host.js");
  const { data } = await serve(t);
  const failing = async () => { throw Object.assign(new Error("statfs failed"), { code: "EIO" }); };
  assert.deepEqual(await healthOf(data, 64 * MiB, failing), { status: "failing", checks: { store: "ok", disk: "cannot_check" } });
  assert.deepEqual(await healthOf(data, 64 * MiB), { status: "ok", checks: { store: "ok", disk: "ok" } });
});

test("compose and render.yaml check /v2/health", async () => {
  const compose = await readFile(new URL("../docker/compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /^ {4}healthcheck:\n {6}test: .*\/v2\/health/m, "the service's healthcheck reads /v2/health");
  const render = await readFile(new URL("../../../render.yaml", import.meta.url), "utf8");
  assert.match(render, /healthCheckPath: \/v2\/health/);
});

test("a cancel settles a run whose carry back cannot be written: cancelled, final, priced; the store gets it once it can", { skip: process.getuid?.() === 0 && "root writes a directory of mode 555", timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { carryBackRetry: { delaysMs: [50] }, settleRetryMs: 200 });
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const { body: run } = await api("POST", "/agents/busy/runs", { input: { content: "Take your time." } });
  await follow(api, run.run_id, ["working"]);
  // The store's directory turns read-only: its next write cannot make its journal, as on a full disk.
  await chmod(data, 0o555);
  try {
    assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
    const { last } = await follow(api, run.run_id, ["cancelled"]);
    assert.equal(last.final, true);
    const view = (await api("GET", `/runs/${run.run_id}`)).body;
    assert.equal(view.status, "cancelled");
    assert.equal(typeof view.cost.usd, "number");
    assert.equal(storeRun(data, run.run_id).state, "running", "the store could not take it yet");
  } finally {
    await chmod(data, 0o755);
  }
  for (let i = 0; storeRun(data, run.run_id).state === "running"; i++) {
    assert.ok(i < 100, "the carry back lands once the store can be written");
    await sleep(100);
  }
  assert.equal(storeRun(data, run.run_id).state, "stopped");
});

test("a message to a run whose process was killed is answered at once: a dead process's fresh heartbeat is not trusted", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("asks", { tools: ["ask_person"] }))).status, 201);
  const { body: run } = await api("POST", "/agents/asks/runs", { input: { content: "Pick a region." } });
  await follow(api, run.run_id, ["input_required"]);
  const pid = JSON.parse(await readFile(join(data, "runs", run.run_id, "run.json"), "utf8")).holder.pid;
  process.kill(pid, "SIGKILL");
  for (let i = 0; ; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    assert.ok(i < 100);
    await sleep(50);
  }
  const from = Date.now();
  const sent = await api("POST", `/runs/${run.run_id}/messages`, { content: "eu" });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.ok(Date.now() - from < 20_000, `answered in ${Date.now() - from} ms`);
  await follow(api, run.run_id, ["completed"]);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.result.final_answer, '{"region":"eu"}');
});
