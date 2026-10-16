// What a server finds when it starts on a data directory another one left: runs it must still supervise, keys it must
// still replay, and a carry back that a busy home put off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readAgentHome } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    return process.kill(pid, 0), true;
  } catch {
    return false;
  }
};

/** A server in a process of its own, so a test can kill it the way a crash does and leave its runs behind. */
async function serverProcess(data) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_API_KEY=/.test(out); i++) {
    assert.ok(i < 200, `the server did not start: ${out}`);
    await sleep(50);
  }
  const value = (name) => new RegExp(`${name}=(\\S+)`).exec(out)[1];
  return { child, api: client(value("AGENTRUN_BASE_URL"), value("AGENTRUN_API_KEY")) };
}

/** Start a run of a new agent in a server process, wait until it is working, then kill the server with SIGKILL. */
async function crashMidRun(t, content) {
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await first.api("POST", "/agents/calc/runs", { input: { content } });
  for (let i = 0; (await first.api("GET", `/runs/${run.run_id}`)).body.state !== "working" || (await first.api("GET", `/runs/${run.run_id}`)).body.status !== "working"; i++) {
    assert.ok(i < 200, "the run starts working");
    await sleep(50);
  }
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const record = JSON.parse(await readFile(join(data, "calc", "runs", run.run_id, "run.json"), "utf8"));
  assert.ok(alive(record.holder.pid), "the run's process outlived its server");
  t.after(() => alive(record.holder.pid) && process.kill(record.holder.pid, "SIGKILL"));
  return { data, runId: run.run_id, pid: record.holder.pid };
}

test("a run whose server crashed is supervised by the next one: it answers, is let go, and is carried back", async (t) => {
  const { data, runId, pid } = await crashMidRun(t, "Answer soon.");
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.equal(alive(pid), false, "the run's process was let go");
  assert.equal((await readAgentHome({ dir: join(data, "calc") })).runs[runId].outcome, "completed");
});

test("a run released but not carried back when its server stopped is carried back when the next one starts", async (t) => {
  const { data, runId, pid } = await crashMidRun(t, "Answer soon.");
  await sleep(2_500);
  process.kill(pid, "SIGTERM");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, "the run's process exits on SIGTERM");
    await sleep(50);
  }
  assert.equal((await readAgentHome({ dir: join(data, "calc") })).runs[runId].endedAt, undefined, "nobody carried it back yet");
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, runId, ["completed"]).catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify((await api("GET", `/runs/${runId}`)).body.error)}`);
  });
  assert.equal(last.final, true);
  assert.equal((await readAgentHome({ dir: join(data, "calc") })).runs[runId].outcome, "completed");
});

test("a run store still locked when the next server reads it is read again once free, so the run still ends final", async (t) => {
  const { data, runId, pid } = await crashMidRun(t, "Answer soon.");
  await sleep(2_500);
  process.kill(pid, "SIGTERM");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, "the run's process exits on SIGTERM");
    await sleep(50);
  }
  // Another holder keeps the run's store locked across the next server's start, as the run's own process does until it exits.
  const store = new DatabaseSync(join(data, "calc", "runs", runId, "store", "run.sqlite"), { timeout: 0 });
  store.exec("PRAGMA locking_mode = EXCLUSIVE");
  store.exec("BEGIN EXCLUSIVE");
  store.exec("COMMIT");
  let busy;
  const refused = new Promise((resolve) => (busy = resolve));
  const next = await startServe({ data, port: 0, faux: FAUX, carryBackRetry: { delaysMs: Array(20).fill(50), onBusy: (id) => busy(id) } });
  t.after(() => next.close());
  assert.equal(await Promise.race([refused, sleep(10_000).then(() => "the locked store was never tried again")]), runId);
  store.close();
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.equal((await readAgentHome({ dir: join(data, "calc") })).runs[runId].outcome, "completed");
});

test("Idempotency-Key answers outlive a restart for the retention capabilities state", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: FAUX });
  const key = { "idempotency-key": "restart-1" };
  const first = await client(one.baseUrl, one.token)("POST", "/agents", agent("kept"), key);
  assert.equal(first.status, 201);
  await one.close();
  const two = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => two.close());
  const api = client(two.baseUrl, two.token);
  const replay = await api("POST", "/agents", agent("kept"), key);
  assert.deepEqual([replay.status, replay.headers.get("idempotent-replayed"), replay.body], [201, "true", first.body]);
  assert.equal((await api("POST", "/agents", agent("other"), key)).body.error.code, "idempotency_mismatch");
  assert.equal((await api("GET", "/capabilities")).body.limits.idempotency_ttl_s, 86_400);
});

test("a carry back that finds the home busy is tried again until it lands, so the run still ends final", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  let busy;
  const refused = new Promise((resolve) => (busy = resolve));
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", carryBackRetry: { delaysMs: Array(20).fill(20), onBusy: (runId) => busy(runId) } });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const go = join(dir, "go");
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: `Answer once ${go} exists.` } });
  // Once the run's process has read its home and works: before that, it needs the home's lock itself.
  for (let i = 0; (await api("GET", `/runs/${run.run_id}`)).body.state !== "working" || (await api("GET", `/runs/${run.run_id}`)).body.status !== "working"; i++) {
    assert.ok(i < 400, "the run starts working");
    await sleep(50);
  }
  // Another writer holds the home's lock; the run answers; the carry back is refused; then the writer lets go.
  const lock = new DatabaseSync(join(data, "calc", "owner.lock"), { timeout: 0 });
  lock.exec("PRAGMA locking_mode = EXCLUSIVE");
  lock.exec("BEGIN EXCLUSIVE");
  lock.exec("COMMIT");
  await writeFile(go, "");
  assert.equal(await refused, run.run_id);
  lock.close();
  const { last } = await follow(api, run.run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.equal((await readAgentHome({ dir: join(data, "calc") })).runs[run.run_id].outcome, "completed");
});

test("one failed save of the kept keys neither fails its create nor stops the saves after it", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => one.close());
  const api = client(one.baseUrl, one.token);
  const partial = join(data, ".idempotency.json.partial");
  await mkdir(partial);
  const first = await api("POST", "/agents", agent("save-a"), { "idempotency-key": "save-1" });
  assert.equal(first.status, 201, "the create answers although its key could not be written");
  await rm(partial, { recursive: true });
  const second = await api("POST", "/agents", agent("save-b"), { "idempotency-key": "save-2" });
  assert.equal(second.status, 201);
  const kept = JSON.parse(await readFile(join(data, ".idempotency.json"), "utf8"));
  const slots = kept.entries.map(([slot]) => slot.split("\n").pop());
  assert.deepEqual(slots.sort(), ["save-1", "save-2"], "the next save lands, and carries the key the failed one missed");
  const replay = await api("POST", "/agents", agent("save-a"), { "idempotency-key": "save-1" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
});
