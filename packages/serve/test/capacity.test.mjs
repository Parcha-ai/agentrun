// What one host can hold, and what it says about itself: a cap on concurrent runs from its memory, a health route that
// reads the store and the free disk, a cancel that settles a run whose carry back cannot be written, and a run whose
// process was killed answered again at once.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { sealKeyOf } from "../dist/tool-keys.js";
import { agent, FAUX, follow, runDir, scratch, serve, storeRun } from "./support.mjs";

const MiB = 2 ** 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Instructions for the faux model to answer only once `dir`/`name` exists: a run that works until the test lets it go. */
const busy = (dir, name = "never") => `Answer once ${join(dir, name)} exists.`;

test("the default cap on how many runs at once is pi's: the host's memory less the server's own, at a pi run's size, never under 1", async () => {
  const { defaultMaxRuns } = await import("../dist/index.js");
  const { builtinHarness } = await import("../dist/harness-table.js");
  const { SERVER_MIB } = await import("../dist/host.js");
  assert.equal(typeof defaultMaxRuns, "function");
  for (const mib of [512, 1024, 8 * 1024]) assert.equal(defaultMaxRuns(mib * MiB), Math.floor((mib - SERVER_MIB) / builtinHarness("pi").runMib), `${mib} MB`);
  assert.equal(defaultMaxRuns(100 * MiB), 1, "never under 1");
});

test("a run that fails gives its one place back: a start made while it holds the place stays queued, then runs once the failed run is over", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const { api, data, runnerBeats } = await serve(t, { maxRuns: 1 });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  // A run that works until the test lets it go, and then fails: it holds the one place.
  const { body: holder } = await api("POST", "/agents/calc/runs", { input: { content: `Fail once ${join(dir, "go")} exists.` } });
  await follow(api, holder.run_id, ["working"]);
  const second = await api("POST", "/agents/calc/runs", { input: { content: "hi" } });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  // Three polls of the runner after the start: a runner with a free place would have claimed the run by now.
  for (let since = runnerBeats(), i = 0; runnerBeats() < since + 3; i++) {
    assert.ok(i < 400, "the runner polls");
    await sleep(50);
  }
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  const waiting = db.prepare("SELECT state, runner FROM runs WHERE id = ?").get(second.body.run_id);
  db.close();
  assert.deepEqual({ ...waiting }, { state: "queued", runner: null }, "queued, not claimed, while the failing run holds the one place");
  // The holder fails: its place is free, and the second run takes it and runs.
  await writeFile(join(dir, "go"), "");
  await follow(api, holder.run_id, ["failed"]);
  const { last } = await follow(api, second.body.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", `the next start got the place the failed run gave back: ${JSON.stringify(last)}`);
});

test("two follow-ups to a completed run while its one place is held: both are taken at once and wait for the place to run, one reopens the run, the other waits for that; the reopen gives its place back when it ends again", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const { api, data, runnerBeats } = await serve(t, { maxRuns: 1 });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: first } = await api("POST", "/agents/calc/runs", { input: { content: "First." } });
  await follow(api, first.run_id, ["completed"]);
  // A second run works until the test lets it go: it holds the one place while the follow-ups wait for it.
  const { body: holder } = await api("POST", "/agents/calc/runs", { input: { content: busy(dir, "go") } });
  await follow(api, holder.run_id, ["working"]);
  // The messages route writes each follow-up and answers at once; the run they reopen waits for the place to run them.
  const statuses = [];
  for (const content of ["And again?", "And once more?"]) statuses.push(await api("POST", `/runs/${first.run_id}/messages`, { content }));
  assert.deepEqual(statuses.map((a) => a.status), [202, 202], JSON.stringify(statuses.map((a) => a.body)));
  // Two polls of the runner after both were written (a beat starts each poll, and the next poll starts only once the
  // last one's claims landed): a runner with a free place would have claimed the reopened run by now.
  for (let since = runnerBeats(), i = 0; runnerBeats() < since + 3; i++) {
    assert.ok(i < 400, "the runner polls");
    await sleep(50);
  }
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  const run = db.prepare("SELECT state, runner FROM runs WHERE id = ?").get(first.run_id);
  const steers = db.prepare("SELECT taken_at FROM commands WHERE run_id = ? AND kind = 'steer'").all(first.run_id);
  db.close();
  assert.deepEqual({ ...run }, { state: "running", runner: null }, "reopened, and not claimed while the working run holds the one place");
  assert.deepEqual(steers.map((row) => row.taken_at), [null, null], "neither follow-up is taken while the place is held");
  await writeFile(join(dir, "go"), "");
  await follow(api, holder.run_id, ["completed"]);
  const { rows } = await follow(api, first.run_id, ["completed"]);
  const sent = rows.filter((r) => r.kind === "user_message").map((r) => r.text);
  assert.deepEqual([...sent].sort(), ["And again?", "And once more?", "First."].sort(), "both messages reached the run");
  // Completed again, it opens again for the next follow-up: the reopen the two shared is over.
  const third = await api("POST", `/runs/${first.run_id}/messages`, { content: "And a third time?" });
  assert.equal(third.status, 202, JSON.stringify(third.body));
  const after = await follow(api, first.run_id, ["completed"]);
  assert.ok(after.rows.some((r) => r.kind === "user_message" && r.text === "And a third time?"), "the third message reached the run");
  // Ended again, the reopen gave its one place back: a new start gets it.
  const next = await api("POST", "/agents/calc/runs", { input: { content: "Next." } });
  assert.equal(next.status, 202, `the follow-up kept a place: ${JSON.stringify(next.body)}`);
  await follow(api, next.body.run_id, ["completed"]);
});

test("a run's first message waits for a process slower to come up than a request's deadline: the run starts, never failed", async (t) => {
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-slow-start.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("slow"))).status, 201);
  const run = await api("POST", "/agents/slow/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a run a stopped server left queued, its first message never taken: nothing of it is written after the stop, and the next server's runner gives it the message", async (t) => {
  // The first start's runner never claims it: the run is queued, its first message untaken, as the stop finds it.
  const one = await serve(t, { runner: false });
  assert.equal((await one.api("POST", "/agents", agent("slow"))).status, 201);
  const run = await one.api("POST", "/agents/slow/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await one.stop();
  const db = new DatabaseSync(join(one.data, "store.sqlite"), { readOnly: true });
  const left = db.prepare("SELECT state, runner, epoch FROM runs WHERE id = ?").get(run.body.run_id);
  db.close();
  assert.deepEqual({ ...left }, { state: "queued", runner: null, epoch: 0 }, "never claimed");
  // The server runs in this process: what it says about the run after its stop is written here.
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (String(chunk).includes(run.body.run_id) && said.push(String(chunk)), write.call(process.stderr, chunk, ...rest));
  t.after(() => void (process.stderr.write = write));
  await sleep(1_500);
  assert.deepEqual(said, [], "nothing of the run after the server stopped");
  process.stderr.write = write;
  const two = await serve(t, { data: one.data });
  const { last } = await follow(two.api, run.body.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a run working when its server stopped is taken up by the next server and answers: the stop released it, so the next runner claims it at once", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const one = await serve(t);
  assert.equal((await one.api("POST", "/agents", agent("busy"))).status, 201);
  const { body: run } = await one.api("POST", "/agents/busy/runs", { input: { content: busy(dir, "go") } });
  await follow(one.api, run.run_id, ["working"]);
  await one.stop();
  // Stopped mid-turn: released for the next runner, never final.
  const left = storeRun(one.data, run.run_id);
  assert.equal(left.state, "running", JSON.stringify(left));
  await writeFile(join(dir, "go"), "");
  const two = await serve(t, { data: one.data });
  const { last } = await follow(two.api, run.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("AGENTRUN_MAX_RUNS and --max-runs set the cap; a value that is not a positive integer is refused", async (t) => {
  const { data } = await serve(t);
  const zero = await startServe({ data: join(data, "..", "other"), port: 0, faux: FAUX, maxRuns: 0 }).then((server) => (t.after(() => server.close()), "started"), (error) => error.message);
  assert.match(zero, /max runs/i, "0 is refused");
  const caps = await (await import("../dist/index.js")).capabilities({ AGENTRUN_MAX_RUNS: "7" });
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

test("health is 503 with the reason when the free disk is under its floor", async (t) => {
  const { baseUrl } = await serve(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const low = await fetch(`${baseUrl}/health`);
  assert.equal(low.status, 503);
  assert.deepEqual(await low.json(), { status: "failing", checks: { store: "ok", disk: "below_floor" } });
});

test("health reads the server's own store: a store whose read fails, or never answers within HEALTH_STORE_MS, is does_not_open; one that answers is ok", async (t) => {
  const { healthOf, HEALTH_STORE_MS } = await import("../dist/host.js");
  const { data } = await serve(t);
  const answers = { agents: { get: async () => undefined } };
  const fails = { agents: { get: async () => { throw new Error("relation \"agents\" does not exist"); } } };
  const silent = { agents: { get: () => new Promise(() => {}) } };
  assert.deepEqual(await healthOf(answers, data, 64 * MiB), { status: "ok", checks: { store: "ok", disk: "ok" } });
  assert.deepEqual(await healthOf(fails, data, 64 * MiB), { status: "failing", checks: { store: "does_not_open", disk: "ok" } });
  const startedAt = Date.now();
  assert.deepEqual(await healthOf(silent, data, 64 * MiB), { status: "failing", checks: { store: "does_not_open", disk: "ok" } });
  assert.ok(Date.now() - startedAt < HEALTH_STORE_MS + 1_000, "bounded by HEALTH_STORE_MS");
});

test("a disk health cannot measure fails its check (503 cannot_check), never reads as room", async (t) => {
  const { healthOf } = await import("../dist/host.js");
  const { data } = await serve(t);
  const answers = { agents: { get: async () => undefined } };
  const failing = async () => { throw Object.assign(new Error("statfs failed"), { code: "EIO" }); };
  assert.deepEqual(await healthOf(answers, data, 64 * MiB, failing), { status: "failing", checks: { store: "ok", disk: "cannot_check" } });
  assert.deepEqual(await healthOf(answers, data, 64 * MiB), { status: "ok", checks: { store: "ok", disk: "ok" } });
});

test("compose and render.yaml check /v2/health", async () => {
  const compose = await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /^ {4}healthcheck:\n {6}test: .*\/v2\/health/m, "the service's healthcheck reads /v2/health");
  const render = await readFile(new URL("../../../render.yaml", import.meta.url), "utf8");
  assert.match(render, /healthCheckPath: \/v2\/health/);
});

test("render.yaml generates the seal key, in a form the server takes: Render's random base64 of 256 bits", async () => {
  const render = await readFile(new URL("../../../render.yaml", import.meta.url), "utf8");
  assert.match(render, /^ {6}- key: AGENTRUN_SEAL_KEY\n {8}generateValue: true$/m, "a new service seals its saved keys, MCP credentials and trigger secrets from its first start");
  // Render's generateValue: "a randomized, base64-encoded, 256-bit value" (render.com/docs/blueprint-spec).
  const generated = randomBytes(32).toString("base64");
  assert.equal(sealKeyOf(generated)?.length, 32);
});

test("a run cancelled as the server stops has its end in the store once the stop is done: no next start opens it again", { timeout: 90_000 }, async (t) => {
  const one = await serve(t);
  const { api } = one;
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const { body: run } = await api("POST", "/agents/busy/runs", { input: { content: busy(await scratch(t)) } });
  await follow(api, run.run_id, ["working"]);
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  // Stopped at once: the run's turn is still going, and its end is written before the stop is done.
  await one.stop();
  assert.equal(storeRun(one.data, run.run_id).state, "stopped");
  // The next start's runner never takes it up: past three of its polls, it still reads cancelled.
  const two = await serve(t, { data: one.data });
  const seen = two.runnerBeats();
  for (let i = 0; two.runnerBeats() < seen + 3; i++) {
    assert.ok(i < 300, "three runner beats");
    await sleep(100);
  }
  const view = (await two.api("GET", `/runs/${run.run_id}`)).body;
  assert.deepEqual([view.status, storeRun(one.data, run.run_id).state], ["cancelled", "stopped"], JSON.stringify(view));
});
