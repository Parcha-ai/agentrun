// What a server finds when it starts on a data directory another one left: runs it must still supervise, keys it must
// still replay, and a carry back that a busy home put off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** A run that answered and released, shown to the next server as still running under a stand-in process that stays
 *  alive: what a server adopts when the run's process outlived the server before it. `release()` then writes the run's
 *  released record, still naming the live stand-in. */
async function adoptedStandIn(t) {
  const { data, runId, pid } = await crashMidRun(t, "Answer soon.");
  await sleep(2_500);
  process.kill(pid, "SIGTERM");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, "the run's process exits on SIGTERM");
    await sleep(50);
  }
  const file = join(data, "calc", "runs", runId, "run.json");
  const released = JSON.parse(await readFile(file, "utf8"));
  const standIn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => standIn.kill("SIGKILL"));
  const holder = { ...released.holder, pid: standIn.pid, serve: "http://127.0.0.1:9" };
  // Whole, through a temporary file and a rename, as a run writes it: the server reads run.json every 500 ms, and a
  // half-written record would read as no record at all.
  const write = async (record) => {
    await writeFile(`${file}.tmp`, JSON.stringify(record));
    await rename(`${file}.tmp`, file);
  };
  const running = () => write({ ...released, status: "running", heartbeatAt: new Date().toISOString(), holder });
  await running();
  // A record caught half written, as a plain rewrite leaves it for a moment.
  const tear = () => writeFile(file, '{"run": "');
  return { data, runId, standIn, release: () => write({ ...released, holder }), tear, heal: running };
}

/** The next server, once it has adopted the run: a read of the run answers only after the server has taken it up. */
async function adopting(t, data, runId, options = {}) {
  const next = await startServe({ data, port: 0, faux: FAUX, ...options });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 200);
  return api;
}

test("an adopted run that released is read only once its process has exited, so its store is never read while held", async (t) => {
  const { data, runId, standIn, release } = await adoptedStandIn(t);
  let busy = 0;
  const api = await adopting(t, data, runId, { carryBackRetry: { delaysMs: Array(20).fill(50), onBusy: () => busy++ } });
  const store = new DatabaseSync(join(data, "calc", "runs", runId, "store", "run.sqlite"), { timeout: 0 });
  store.exec("PRAGMA locking_mode = EXCLUSIVE");
  store.exec("BEGIN EXCLUSIVE");
  store.exec("COMMIT");
  await release();
  await sleep(2_000);
  assert.equal(busy, 0, "the store was not read while the run's process lived");
  assert.equal((await api("GET", `/runs/${runId}/timeline?after=0`)).body.final, false);
  store.close();
  standIn.kill("SIGKILL");
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.equal((await readAgentHome({ dir: join(data, "calc") })).runs[runId].outcome, "completed");
});

test("a run record read half written neither crashes the server nor settles the run: it is read again", async (t) => {
  const { data, runId, standIn, release, tear } = await adoptedStandIn(t);
  const api = await adopting(t, data, runId);
  await tear();
  await sleep(1_600);
  assert.equal((await api("GET", `/runs/${runId}/timeline?after=0`)).body.final, false, "not settled on an unreadable record");
  await release();
  standIn.kill("SIGKILL");
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.equal((await readAgentHome({ dir: join(data, "calc") })).runs[runId].outcome, "completed");
});

test("unreadable reads scattered between readable ones never add up to the limit", async (t) => {
  const { data, runId, standIn, release, tear, heal } = await adoptedStandIn(t);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => (process.stderr.write = write));
  const api = await adopting(t, data, runId);
  for (let i = 0; i < 12; i++) {
    await tear();
    await sleep(550);
    await heal();
    await sleep(550);
  }
  assert.ok(!lines.some((line) => line.includes(runId) && line.includes("still watching")), "scattered unreadable reads never added up to the warning");
  assert.equal((await api("GET", `/runs/${runId}/timeline?after=0`)).body.final, false, "not settled while the process lives");
  await release();
  standIn.kill("SIGKILL");
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
});

test("a record unreadable for longer than 5 s while the process lives is still watched, and the server says so", async (t) => {
  const { data, runId, standIn, release, tear, heal } = await adoptedStandIn(t);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => (process.stderr.write = write));
  const api = await adopting(t, data, runId);
  await tear();
  await sleep(6_500);
  assert.ok(lines.some((line) => line.includes(runId) && line.includes("still watching")), "the server said it is still watching");
  assert.equal((await api("GET", `/runs/${runId}/timeline?after=0`)).body.final, false, "not settled while the process lives");
  await heal();
  await release();
  standIn.kill("SIGKILL");
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
});

test("an adopted run whose process lives on 30 s after it released is read anyway, and the server says so", async (t) => {
  const { data, runId, release } = await adoptedStandIn(t);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => (process.stderr.write = write));
  const api = await adopting(t, data, runId);
  await release();
  const releasedAt = Date.now();
  let page;
  for (let i = 0; !(page = (await api("GET", `/runs/${runId}/timeline?after=0`)).body).final; i++) {
    assert.ok(i < 240, "the run ends final within a minute of its release");
    await sleep(250);
  }
  assert.ok(Date.now() - releasedAt >= 30_000, "it waited the 30 s for the process to exit first");
  assert.equal(page.status, "completed");
  assert.ok(lines.some((line) => line.includes(runId) && line.includes("has not exited; reading its store anyway")));
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
