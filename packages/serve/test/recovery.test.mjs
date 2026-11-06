// What a server finds when it starts on a data directory another one left: runs it must still supervise, keys it must
// still replay, and a carry back that a busy home put off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test as nodeTest } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { openStore } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { Runs } from "../dist/runs.js";
import { stable } from "../dist/validate.js";
import { ledgerOf, reflectRows } from "./learn-support.mjs";
import { agent, client, FAUX, flowAgent, follow, runDir, runRecordOf, scratch, startRun, storeRun } from "./support.mjs";
import { processTable } from "@parcha/pi-durable-disk/internals";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
// A hang guard far beyond a measured start (median 7.4 s locally; slowest CI test 17.4 s), not a start budget.
const test = (name, ...rest) => nodeTest(name, { timeout: 120_000, ...(rest.length > 1 ? rest[0] : {}) }, rest.at(-1));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = processAlive;

/** A server in a process of its own, so a test can kill it the way a crash does and leave its runs behind. It is ready
 *  when it prints its banner, which it does once it listens: its address and key lines, whole. A server that exits first
 *  fails the test with what it said. No clock: a slow start, on a loaded machine, is still a start. `execArgv` and `env`
 *  go to its node (a preloaded test hook, say). */
async function serverProcess(data, { execArgv = [], env = {} } = {}) {
  // A home beside the data, not this machine's: a first start counts the sessions in its home for setup's offer.
  const child = spawn(process.execPath, [...execArgv, CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: dirname(data), ...env } });
  let out = "";
  let err = "";
  // Read to the end, so the server never blocks on a full pipe; its last lines say why, should it exit before it listens.
  child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-4_000)));
  await new Promise((resolve, reject) => {
    const exited = (code, signal) => reject(new Error(`the server exited before it listened (${signal ?? code}): ${out}${err}`));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (!/^AGENTRUN_API_KEY=.*\n/m.test(out) || !/^AGENTRUN_BASE_URL=\S+\n/m.test(out)) return;
      child.off("exit", exited);
      resolve();
    });
    child.once("exit", exited);
    child.once("error", reject);
  });
  const value = (name) => new RegExp(`${name}=(\\S+)`).exec(out)[1];
  // The banner prints the token only when this start made it; a later start on the same directory names its file.
  return { child, api: client(value("AGENTRUN_BASE_URL"), (await readFile(join(data, ".token"), "utf8")).trim()) };
}

/** Start a run of a new agent in a server process, wait until it is working, then kill the server with SIGKILL. */
async function crashMidRun(t, content, { create = agent("calc"), input = { content } } = {}) {
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  assert.equal((await first.api("POST", "/agents", create)).status, 201);
  const { body: run } = await first.api("POST", `/agents/${create.definition.id}/runs`, { input });
  // Its own process started and its turn in flight.
  await untilState(first.api, run.run_id, ["working", "working"]);
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const record = runRecordOf(data, run.run_id);
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
  assert.equal(storeRun(data, runId).state, "completed");
});

/** Kill the run's own process the way a crash does, and wait until it is gone. */
async function killRun(pid) {
  if (alive(pid)) process.kill(pid, "SIGKILL");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, "the run's process dies on SIGKILL");
    await sleep(50);
  }
}

test("a run whose process died with its server is relaunched on its directory by the next one, resumes, and completes; its timeline says it resumed after a crash", async (t) => {
  const { data, runId, pid } = await crashMidRun(t, "Answer soon.");
  await killRun(pid);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last, rows } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.deepEqual(rows.filter((r) => r.kind === "phase" && r.summary.startsWith("Resumed")).map((r) => r.summary), ["Resumed after a crash"], "one stored row, kept by the settle's read");
  assert.equal((await api("GET", `/runs/${runId}`)).body.result.final_answer, "Soon.");
  assert.equal(storeRun(data, runId).state, "completed");
  assert.ok(runRecordOf(data, runId).generation >= 3, "opened again on its directory");
  // A launch that served removes its mark: the next server opens the run again once, never fails it as lost at launch.
  assert.equal(runRecordOf(data, runId).generation, 3, "opened again once: its first launch (epoch 1), the take-back (2), its one launch after (3)");
});

// A server that goes down while it copies what a learning run's agent learned: before the copy starts, or once it is
// whole and pinned but its learning not yet saved. The run's input is saved before the copy, so the next server relaunches
// it with its first message; a copy it finds unsaved goes, so the run starts again with nothing learned, and asks no
// end-of-run turn though its agent has a write tool (a seeded run of it does: the control).
const HOLD_SEED = new URL("./fixtures/hold-seed.mjs", import.meta.url).href;
for (const [seam, learning] of [["beforePin", null], ["afterPin", { state: "dropped", reason: "seed_failed" }]]) {
  test(`a server killed while a learning run's seed is copied (${seam}): the next one relaunches the run with its first message, and it completes with nothing learned and no end-of-run turn`, async (t) => {
    const data = join(await scratch(t), "agents");
    const signal = join(await scratch(t), "held");
    const first = await serverProcess(data, { execArgv: ["--import", HOLD_SEED], env: { AGENTRUN_TEST_HOLD_SEED: seam, AGENTRUN_TEST_HOLD_SIGNAL: signal } });
    t.after(() => first.child.kill("SIGKILL"));
    assert.equal((await first.api("POST", "/agents", agent("learner", { learning: true, tools: ["write"] }))).status, 201);
    // The start waits on the held copy, so it never answers: the run is found by its directory once the copy holds.
    const starting = first.api("POST", "/agents/learner/runs", { input: { content: "Answer soon." } }).catch(() => undefined);
    let dir = "";
    for (let i = 0; !(dir = await readFile(signal, "utf8").catch(() => "")); i++) {
      assert.ok(i < 1200, "the run's seed copy was reached");
      await sleep(50);
    }
    first.child.kill("SIGKILL");
    await new Promise((resolve) => first.child.once("exit", resolve));
    await starting;
    const runId = basename(dir);
    assert.equal(storeRun(data, runId).state, "running");
    assert.equal(existsSync(join(dir, "learning.json")), seam === "afterPin", "a pin only once the copy was whole");
    const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
    // Closed in the body, before the data directory's hook removes it: the control run below learns, and its check and
    // grade still write into its directory after it reads completed. close() returns once they ended.
    let closed;
    const stop = () => (closed ??= next.close());
    t.after(stop);
    const api = client(next.baseUrl, next.token);
    const { rows } = await follow(api, runId, ["completed"]);
    const read = (await api("GET", `/runs/${runId}`)).body;
    assert.equal(read.result.final_answer, "Soon.", "its first message reached it");
    assert.deepEqual(read.learning && { state: read.learning.state, reason: read.learning.reason }, learning);
    assert.equal(existsSync(join(dir, "learning.json")), false, "no pin");
    assert.equal(existsSync(join(dir, "work", ".learning")), false, "no copy of the notes");
    // Nothing seeded, so no end-of-run turn: none asked, none saved, no row of one.
    assert.equal(reflectRows(rows).length, 0, "no end-of-run turn");
    assert.equal(JSON.parse(await readFile(join(dir, "serve.json"), "utf8")).reflect, undefined, "none saved");
    if (learning) {
      // Its end is in the ledger once, after its serve.json: /v2/stats counts it.
      assert.deepEqual(ledgerOf(data).filter((line) => line.run === runId).map((line) => [line.state, line.reason]), [["dropped", "seed_failed"]]);
      assert.equal((await api("GET", "/stats")).body.learning.dropped.seed_failed, 1);
    }
    // The control: a run of the same agent that is seeded asks its end-of-run turn.
    const control = (await api("POST", "/agents/learner/runs", { input: { content: "Answer soon." } })).body.run_id;
    await follow(api, control, ["completed"]);
    const saved = JSON.parse(await readFile(join(runDir(data, control), "serve.json"), "utf8"));
    assert.equal(typeof saved.reflect?.after, "number", JSON.stringify(saved));
    await stop();
  });
}

test("a workflow run whose process died with its server is relaunched by the next one and completes from its journal", async (t) => {
  const { data, runId, pid } = await crashMidRun(t, undefined, { create: flowAgent("flow"), input: { question: "Answer soon." } });
  await killRun(pid);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.deepEqual((await api("GET", `/runs/${runId}`)).body.result.output, { answer: 42 });
  assert.equal(storeRun(data, runId).state, "completed");
});

test("a run released but not carried back when its server stopped is carried back by the next one, which reads its run store with a lock-free read even while another holder keeps it locked, so the run still ends final", async (t) => {
  const { data, runId, pid } = await crashMidRun(t, "Answer soon.");
  await sleep(2_500);
  process.kill(pid, "SIGTERM");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, "the run's process exits on SIGTERM");
    await sleep(50);
  }
  assert.equal(storeRun(data, runId).state, "running", "released, and nobody carried it back yet");
  // Another holder keeps the run's store locked across the next server's start, as the run's own process does until it
  // exits: the server's reads are lock-free (run-db.ts), so they do not wait on it; its checkpoint, which needs the lock,
  // is left to a later take-back. Taken once a take-back's checkpoint that may be under way lets go of it.
  const store = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { timeout: 10_000 });
  t.after(() => store.isOpen && store.close());
  store.exec("PRAGMA locking_mode = EXCLUSIVE");
  store.exec("BEGIN EXCLUSIVE");
  store.exec("COMMIT");
  const next = await startServe({ data, port: 0, faux: FAUX, carryBackRetry: { delaysMs: Array(20).fill(50) } });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.equal(storeRun(data, runId).state, "completed", "carried back while the store was still locked");
});

/** A run that answered and released, shown to the next server as still running under a stand-in process that stays
 *  alive: what a server adopts when the run's process outlived the server before it. The stand-in is the row's holder,
 *  with a door, and the record in the run's store says running; `release()` then writes the released record its process
 *  left. */
/** `script`: what the stand-in process runs (by default, nothing but staying alive), given `args`. */
async function adoptedStandIn(t, script = "setInterval(() => {}, 1000)", env = {}) {
  const { data, runId, pid } = await crashMidRun(t, "Answer soon.");
  await sleep(2_500);
  process.kill(pid, "SIGTERM");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, "the run's process exits on SIGTERM");
    await sleep(50);
  }
  const file = join(runDir(data, runId), "store", "run.sqlite");
  const { holder: _holder, epoch: _epoch, ...released } = runRecordOf(data, runId);
  assert.ok(["sleeping", "paused"].includes(released.status), `its process released the run: ${released.status}`);
  const standIn = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, ...env } });
  t.after(() => standIn.kill("SIGKILL"));
  const table = processTable();
  const holder = { pid: standIn.pid, start: table.snapshot().info(standIn.pid).start, boot: table.bootId() ?? null, door: "http://127.0.0.1:9" };
  const control = new DatabaseSync(join(data, "store.sqlite"));
  control.prepare("UPDATE runs SET claim_holder = ? WHERE id = ?").run(JSON.stringify(holder), runId);
  control.close();
  // As the run's process keeps it: one row of its store, written on a connection that holds the store, then let go.
  const write = (record) => {
    const db = new DatabaseSync(file, { timeout: 5_000 });
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL");
      db.prepare("INSERT INTO pda_run_status (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record").run(JSON.stringify(record));
    } finally {
      db.close();
    }
  };
  write({ ...released, status: "running" });
  return { data, runId, standIn, release: () => write(released) };
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
  await sleep(1_000);
  assert.equal((await api("GET", `/runs/${runId}/timeline?after=0`)).body.final, false, "not settled while its process lives");
  await release();
  const store = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { timeout: 0 });
  store.exec("PRAGMA locking_mode = EXCLUSIVE");
  store.exec("BEGIN EXCLUSIVE");
  store.exec("COMMIT");
  await sleep(2_000);
  assert.equal(busy, 0, "the store was not read while the run's process lived");
  assert.equal((await api("GET", `/runs/${runId}/timeline?after=0`)).body.final, false);
  store.close();
  standIn.kill("SIGKILL");
  const { last } = await follow(api, runId, ["completed"]);
  assert.equal(last.final, true);
  assert.equal(storeRun(data, runId).state, "completed");
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

test("a start that needs the place of a cancelled run whose adopted process will not exit waits for it, and still answers by its deadline", { timeout: 120_000 }, async (t) => {
  // An orphan no SIGKILL timer reaches, and which ignores SIGTERM: it holds its place for as long as it lives. It says
  // when its SIGTERM is set, so the cancel never reaches it first.
  const ready = join(await scratch(t), "ready");
  const { data, runId } = await adoptedStandIn(t, "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.READY_FILE, ''); setInterval(() => {}, 1000)", { READY_FILE: ready });
  for (let i = 0; !existsSync(ready); i++) {
    assert.ok(i < 200, "the stand-in sets its SIGTERM");
    await sleep(50);
  }
  // drainTimeout 2s: a start waits up to the drain, the kill's second and one more for a leaving run's place.
  const api = await adopting(t, data, runId, { maxRuns: 1, drainTimeout: "2s" });
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  const asked = Date.now();
  const answer = await Promise.race([api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } }), sleep(15_000).then(() => "still waiting")]);
  const waited = Date.now() - asked;
  assert.notEqual(answer, "still waiting", "the start answered, never waiting on a process that will not go");
  assert.equal(answer.status, 429, JSON.stringify(answer.body));
  assert.ok(waited >= 3_000, `it waited for the place being given back: ${waited} ms`);
  assert.ok(waited < 8_000, `and answered by its deadline, never hanging on a process that will not go: ${waited} ms`);
});

test("a run whose live process the next server adopts holds its harness's memory there: a start that needs it is 429, one that fits the rest starts", async (t) => {
  const { data, runId } = await crashMidRun(t, "Take your time.");
  // 384 MB: 256 for runs, 128 of it the adopted pi run's.
  const was = process.constrainedMemory;
  process.constrainedMemory = () => 384 * 2 ** 20;
  t.after(() => void (process.constrainedMemory = was));
  const api = await adopting(t, data, runId, { fauxHarness: new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname, drainTimeout: "5s" });
  await untilState(api, runId, ["working", "working"]);
  assert.equal((await api("POST", "/agents", agent("mid", { harness: "codex" }))).status, 201);
  const refused = await api("POST", "/agents/mid/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error?.details?.harness, refused.body.error?.details?.free_mb], [429, "codex", 128], JSON.stringify(refused.body));
  const fits = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  assert.equal(fits.status, 202, JSON.stringify(fits.body));
  await follow(api, fits.body.run_id, ["completed"]);
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

test("a run create retried after its server was killed before it saved the key answers the run it made, which completes: one run, and another body under the key is idempotency_mismatch", async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  // A directory where the key's file is written first: no save lands, so the kill leaves what a kill between the run's
  // start and the save leaves, a run in the store and no key on disk.
  const partial = join(data, ".idempotency.json.partial");
  await mkdir(partial);
  const body = { input: { content: "Answer soon." } };
  const key = { "idempotency-key": "create-1" };
  const created = await first.api("POST", "/agents/calc/runs", body, key);
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const runId = created.body.run_id;
  await untilState(first.api, runId, ["working", "working"]);
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const pid = runRecordOf(data, runId).holder.pid;
  t.after(() => alive(pid) && process.kill(pid, "SIGKILL"));
  assert.equal(existsSync(join(data, ".idempotency.json")), false, "no key was saved");
  await rm(partial, { recursive: true });
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const retried = await api("POST", "/agents/calc/runs", body, key);
  assert.deepEqual([retried.status, retried.headers.get("idempotent-replayed"), retried.headers.get("location"), retried.body.run_id], [202, "true", `/v2/runs/${runId}`, runId]);
  assert.equal((await api("POST", "/agents/calc/runs", { input: { content: "Another." } }, key)).body.error.code, "idempotency_mismatch");
  assert.deepEqual((await api("GET", "/agents/calc/runs")).body.runs.map((run) => run.run_id), [runId], "one run");
  await follow(api, runId, ["completed"]);
  assert.equal((await api("GET", `/runs/${runId}`)).body.result.final_answer, "Soon.");
});

// Each a serve.json a run that was never set up can have: none (a kill right after the store's insert), the failure a
// start saved before a kill kept it from the store, and a stop saved before the failure. None holds the run's input.
const NOT_SET_UP = [
  ["no serve.json", undefined],
  ["its failure saved to serve.json, not to the store", { title: "", created_at: "2026-11-04T00:00:00.000Z", error: { code: "run_failed", message: "The server went down while it set the run up.", details: { reason: "server_lost_at_setup" } } }],
  ["a stop saved to serve.json", { title: "", created_at: "2026-11-04T00:00:00.000Z", stopped_at: "2026-11-04T00:00:01.000Z" }],
];
for (const [left, meta] of NOT_SET_UP) {
  test(`a run its server went down before setting up (${left}) is failed by the next start as server_lost_at_setup, never launched; the create retried under its key answers it`, async (t) => {
    const data = join(await scratch(t), "agents");
    const one = await startServe({ data, port: 0, faux: FAUX });
    assert.equal((await client(one.baseUrl, one.token)("POST", "/agents", agent("calc"))).status, 201);
    await one.close();
    // What a kill before the run's setup leaves: the run's row and its origin (the create's key slot and body, hashed),
    // its directory seeded, and the serve.json this case names.
    const body = { input: { content: "Answer soon." } };
    const sha256 = (text) => createHash("sha256").update(text).digest("hex");
    const store = openStore(data);
    const { runId, dir } = await store.startRun({ agent: "calc", origin: { key: `idk_${sha256("/agents/calc/runs\nsetup-1").slice(0, 32)}`, fingerprint: sha256(stable(body)) } });
    store.close();
    if (meta) await writeFile(join(dir, "serve.json"), `${JSON.stringify(meta)}\n`);
    const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
    t.after(() => next.close());
    const api = client(next.baseUrl, next.token);
    const { last } = await follow(api, runId, ["failed"]);
    assert.equal(last.status, "failed");
    const read = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([read.error.code, read.error.details], ["run_failed", { reason: "server_lost_at_setup" }]);
    assert.equal(runRecordOf(data, runId).holder, undefined, "never launched: no process ever held it");
    assert.equal(runRecordOf(data, runId).status, undefined, "nor kept a record in its store");
    assert.equal(storeRun(data, runId).state, "failed");
    const retried = await api("POST", "/agents/calc/runs", body, { "idempotency-key": "setup-1" });
    assert.deepEqual([retried.status, retried.headers.get("idempotent-replayed"), retried.body.run_id, retried.body.status], [202, "true", runId, "failed"]);
    assert.equal((await api("GET", "/agents/calc/runs")).body.runs.length, 1, "one run");
  });
}

test("a start's recovery that lists the runs late (a store slow at boot) leaves alone a run this server is creating: it is set up, completes, and never fails as lost at setup", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: FAUX });
  assert.equal((await client(one.baseUrl, one.token)("POST", "/agents", agent("calc"))).status, 201);
  await one.close();
  // The window, held open: the next start's recovery reads the store only once a create's run is in it, and that
  // create's setup waits until the recovery is over.
  const writer = openStore(data);
  const AgentStore = Object.getPrototypeOf(writer);
  writer.close();
  let committed;
  const inStore = new Promise((resolve) => (committed = resolve));
  let recovery;
  const { startRun } = AgentStore;
  const { recover } = Runs.prototype;
  AgentStore.startRun = async function (input) {
    const started = await startRun.call(this, input);
    committed();
    await recovery;
    return started;
  };
  Runs.prototype.recover = function () {
    return (recovery = inStore.then(() => recover.call(this)));
  };
  t.after(() => {
    AgentStore.startRun = startRun;
    Runs.prototype.recover = recover;
  });
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const created = await api("POST", "/agents/calc/runs", { input: { content: "Answer soon." } });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const runId = created.body.run_id;
  await recovery;
  assert.equal(storeRun(data, runId).state, "running", "the recovery did not end it");
  await follow(api, runId, ["completed"]);
  assert.equal((await api("GET", `/runs/${runId}`)).body.result.final_answer, "Soon.");
  assert.equal(storeRun(data, runId).state, "completed");
});

test("a carry back that finds the store busy is tried again until it lands, so the run still ends final", async (t) => {
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
  // Once the run's process has read its revision and works: before that, it reads the store itself.
  await untilState(api, run.run_id, ["working", "working"]);
  // Another writer holds the store; the run answers; the carry back is refused; then the writer lets go.
  const lock = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  lock.exec("BEGIN EXCLUSIVE");
  await writeFile(go, "");
  assert.equal(await refused, run.run_id);
  lock.close();
  const { last } = await follow(api, run.run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.equal(storeRun(data, run.run_id).state, "completed");
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

/** Servers that start through `start` are closed before the test's scratch directory goes: t.after hooks run in the
 *  order they were added, and this one is added first. On a failure, a server whose runs still work would otherwise
 *  outlive its directory and keep the file from ending. */
function servers(t) {
  const open = new Set();
  t.after(() => Promise.all([...open].map((server) => server.close())));
  return async (options) => {
    const server = await startServe(options);
    open.add(server);
    return { ...server, close: () => (open.delete(server), server.close()) };
  };
}

/** Start a slow run of a new agent `id`, wait until its turn works, and stop it. */
async function stopWhileWorking(api, id) {
  const { run_id } = await startRun(api, id, "Take your time.");
  await untilState(api, run_id, ["working", "working"]);
  assert.equal((await api("POST", `/runs/${run_id}/stop`)).body.stopped, true);
  await follow(api, run_id, ["input_required"]);
  return run_id;
}

const stateOf = async (api, runId) => {
  const { body } = await api("GET", `/runs/${runId}`);
  return [body.status, body.state];
};

/** Until `done(status, state)` holds for the run, long-polling its timeline, which the server answers as the run changes;
 *  the status and state then. A run that ends in a status `done` does not take fails the test at once. No clock: how long
 *  a run takes to start on a loaded machine is not what these tests are about. */
async function untilRun(api, runId, done, what) {
  let after = 0;
  for (;;) {
    const { status, body: page } = await (api.fresh ?? api)("GET", `/runs/${runId}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "2000" })}`);
    assert.equal(status, 200, JSON.stringify(page));
    if (done(page.status, page.state)) return [page.status, page.state];
    assert.ok(!["completed", "failed", "cancelled"].includes(page.status), `the run ended ${page.status} before it reached ${what}`);
    after = page.next_after;
  }
}

/** Until the run's status and state are `want` (as untilRun). */
const untilState = (api, runId, want) => untilRun(api, runId, (status, state) => status === want[0] && state === want[1], want.join("/"));

test("a stopped run is still input_required and idle after a restart that ended its process: a follow-up goes on, a cancel cancels", { timeout: 60_000 }, async (t) => {
  const start = servers(t);
  const data = join(await scratch(t), "agents");
  const one = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const first = client(one.baseUrl, one.token);
  const followed = await stopWhileWorking(first, "slow");
  const cancelled = await stopWhileWorking(first, "slower");
  const { run_id: asked } = await startRun(first, "regions", "Pick a region.", { tools: ["ask_person"] });
  await follow(first, asked, ["input_required"]);
  await one.close();
  const two = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const api = client(two.baseUrl, two.token);
  assert.deepEqual(await stateOf(api, followed), ["input_required", "idle"]);
  assert.deepEqual(await stateOf(api, cancelled), ["input_required", "idle"]);
  assert.deepEqual(await stateOf(api, asked), ["input_required", "waiting"], "a run that asks still waits");
  const next = await api("POST", `/runs/${followed}/messages`, { content: "go on" });
  assert.equal(next.body.mode, "follow_up");
  await follow(api, followed, ["completed"]);
  assert.equal((await api("GET", `/runs/${followed}`)).body.result.final_answer, "On go on: done.");
  assert.equal((await api("POST", `/runs/${cancelled}/cancel`)).status, 202);
  await follow(api, cancelled, ["cancelled"]);
  assert.equal(storeRun(data, cancelled).state, "stopped");
});

test("a stopped run whose live process the next server adopts is input_required and idle; a follow-up after that is no longer stopped", { timeout: 60_000 }, async (t) => {
  const start = servers(t);
  const data = join(await scratch(t), "agents");
  const crash = async (server, runId) => {
    server.child.kill("SIGKILL");
    await new Promise((resolve) => server.child.once("exit", resolve));
    const { holder } = runRecordOf(data, runId);
    assert.ok(alive(holder.pid), "the run's process outlived its server");
    t.after(() => alive(holder.pid) && process.kill(holder.pid, "SIGKILL"));
  };
  // Once the adopted run's rows arrive, its status is past queued.
  const adopted = (api, runId) => untilRun(api, runId, (status) => status !== "queued", "a status past queued");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  const runId = await stopWhileWorking(first.api, "slow");
  await crash(first, runId);
  const second = await serverProcess(data);
  t.after(() => second.child.kill("SIGKILL"));
  assert.deepEqual(await adopted(second.api, runId), ["input_required", "idle"]);
  assert.equal((await second.api("POST", `/runs/${runId}/messages`, { content: "Take your time again." })).body.mode, "follow_up");
  await untilState(second.api, runId, ["working", "working"]);
  await crash(second, runId);
  const third = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const api = client(third.baseUrl, third.token);
  assert.deepEqual(await adopted(api, runId), ["working", "working"], "the follow-up ended the stop");
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ["cancelled"]);
});

test("a reply that answers only once its turn is stopped leaves the run stopped, before and after a restart; a follow-up completes it", { timeout: 60_000 }, async (t) => {
  const start = servers(t);
  const data = join(await scratch(t), "agents");
  const one = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const first = client(one.baseUrl, one.token);
  const { run_id } = await startRun(first, "late", "Answer when stopped.");
  await untilState(first, run_id, ["working", "working"]);
  assert.equal((await first("POST", `/runs/${run_id}/stop`)).body.stopped, true);
  const stopped = await follow(first, run_id, ["input_required"]);
  assert.equal(stopped.last.state, "idle");
  // pi-ai ends a reply that resolves after its abort as an aborted message, which leaves no row; were it to keep the
  // answer, this run would be the one decide() must not complete.
  assert.deepEqual(stopped.rows.filter((r) => r.kind === "final_answer" || r.kind === "text_block"), []);
  await one.close();
  const two = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const api = client(two.baseUrl, two.token);
  assert.deepEqual(await stateOf(api, run_id), ["input_required", "idle"]);
  // Its process ended with the first server, so these rows are the stopped turn's last: the late reply left none.
  assert.deepEqual((await follow(api, run_id, ["input_required"])).rows.filter((r) => r.kind === "final_answer" || r.kind === "text_block"), []);
  assert.equal((await api("POST", `/runs/${run_id}/messages`, { content: "go on" })).body.mode, "follow_up");
  await follow(api, run_id, ["completed"]);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, "On go on: done.");
});

test("a stop saved before its abort reached the run is finished by the next server: the adopted turn is aborted, so a follow-up runs at once", { timeout: 60_000 }, async (t) => {
  const start = servers(t);
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  const { run_id } = await startRun(first.api, "slow", "Take your time.");
  await untilState(first.api, run_id, ["working", "working"]);
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, run_id);
  assert.ok(alive(holder.pid), "the run's process outlived its server");
  t.after(() => alive(holder.pid) && process.kill(holder.pid, "SIGKILL"));
  // The server died after it saved the stop and before its abort reached the run: the turn still works.
  const meta = join(runDir(data, run_id), "serve.json");
  await writeFile(meta, `${JSON.stringify({ ...JSON.parse(await readFile(meta, "utf8")), stopped_after: 1 })}\n`);
  const next = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const api = client(next.baseUrl, next.token);
  await untilState(api, run_id, ["input_required", "idle"]);
  // Behind a turn still running (60 s), the follow-up would wait past follow's 30 s.
  assert.equal((await api("POST", `/runs/${run_id}/messages`, { content: "go on" })).body.mode, "follow_up");
  await follow(api, run_id, ["completed"], { deadlineMs: 20_000 }).catch(async (error) => { error.message += `\ntimeline: ${await api.fresh("GET", `/runs/${run_id}/timeline?limit=500`).then(({ body }) => JSON.stringify(body), (cause) => `unavailable (${cause.message})`)}`; throw error; });
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, "On go on: done.");
});

/** An accepted message never vanishes. Answered 2xx with a mode, it shows as the person's row and the run goes on past it
 *  to an answer, or the run ends with its error stated. A message a stop's abort withdrew would show nothing, and the run
 *  would read working from then on: the follow below would run out. */
async function neverDropped(api, runId, sent, content) {
  assert.ok(sent.status >= 200 && sent.status < 300 && typeof sent.body.mode === "string", `accepted: ${JSON.stringify(sent.body)}`);
  const { rows, last } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 20_000 }).catch(async (error) => {
    error.message += `\ntimeline: ${await api.fresh("GET", `/runs/${runId}/timeline?limit=500`).then(({ body }) => JSON.stringify(body), (cause) => `unavailable (${cause.message})`)}`;
    throw error;
  });
  const at = rows.findIndex((row) => row.kind === "user_message" && row.text === content);
  assert.ok(at >= 0, `the message shows as the person's row: ${JSON.stringify(rows.map((row) => row.summary))}`);
  if (last.status === "completed") assert.ok(rows.slice(at + 1).some((row) => row.kind === "final_answer"), "and an answer after it");
  else assert.ok((await api("GET", `/runs/${runId}`)).body.error?.message, `or the run ends with its error stated: ${last.status}`);
}

test("a run that reads stopped runs the follow-up it takes, even while the abort of its turn is still on its way (the next server ending a saved stop): the abort never drops the message, live or after a restart", { timeout: 60_000 }, async (t) => {
  const start = servers(t);
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  const { run_id } = await startRun(first.api, "slow", "Take your time.");
  await untilState(first.api, run_id, ["working", "working"]);
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, run_id);
  t.after(() => alive(holder.pid) && process.kill(holder.pid, "SIGKILL"));
  const meta = join(runDir(data, run_id), "serve.json");
  await writeFile(meta, `${JSON.stringify({ ...JSON.parse(await readFile(meta, "utf8")), stopped_after: 1 })}\n`);
  // The order a loaded machine can give: the next server's abort reaches the run's door only after a message has (or
  // after 3 s, when none comes). A message that reaches the door first is queued behind the turn the abort then ends.
  const realFetch = globalThis.fetch;
  let reached;
  const submitted = new Promise((resolve) => (reached = resolve));
  globalThis.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/abort") await Promise.race([submitted, sleep(3_000)]);
    const answer = await realFetch(input, init);
    if (path === "/submit") reached();
    return answer;
  };
  t.after(() => (globalThis.fetch = realFetch));
  const next = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const api = client(next.baseUrl, next.token);
  await untilState(api, run_id, ["input_required", "idle"]);
  const sent = await api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  assert.equal(sent.body.mode, "follow_up");
  await neverDropped(api, run_id, sent, "go on");
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, "On go on: done.");
  await next.close();
  const after = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  await neverDropped(client(after.baseUrl, after.token), run_id, sent, "go on");
});

test("a message sent while a stop is on its way runs after it, never dropped: a live stop held between its mark and its abort, live and after a restart", { timeout: 60_000 }, async (t) => {
  const start = servers(t);
  const data = join(await scratch(t), "agents");
  let atAbort, release;
  const reachedAbort = new Promise((resolve) => (atAbort = resolve));
  const held = new Promise((resolve) => (release = resolve));
  const one = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s", beforeAbort: async () => { atAbort(); await held; } });
  const api = client(one.baseUrl, one.token);
  const { run_id } = await startRun(api, "slow", "Take your time.");
  await untilState(api, run_id, ["working", "working"]);
  const stopping = api("POST", `/runs/${run_id}/stop`);
  // The stop has saved its mark and the run reads stopped; its abort waits at the seam.
  await reachedAbort;
  const sending = api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  await Promise.race([sending, sleep(1_000)]);
  release();
  const [stop, sent] = await Promise.all([stopping, sending]);
  assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
  await neverDropped(api, run_id, sent, "go on");
  await one.close();
  const after = await start({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  await neverDropped(client(after.baseUrl, after.token), run_id, sent, "go on");
});
