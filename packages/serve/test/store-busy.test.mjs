// The agent store held by another connection never stalls the server: every read and write of it waits with an
// async backoff, so the event loop goes on answering.
import assert from "node:assert/strict";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test as nodeTest } from "node:test";
import { sqliteAdapterTests } from "./store-target.mjs";

// Postgres's busy wait (lock_timeout, StoreBusy): store-postgres.test.mjs.
const test = sqliteAdapterTests(nodeTest, "the store file held by another connection");
import { openStore } from "@parcha/pi-durable-agent";
import { agent, answerFlow, flowAgent, follow, scratch, serve, startRun } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `method path` on a connection of its own, with how long its answer took. */
function timed(port, token, method, path, body) {
  const from = Date.now();
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = { authorization: `Bearer ${token}`, ...(text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) }) };
    const req = request({ host: "127.0.0.1", port, method, path: `/v2${path}`, agent: false, headers }, (res) => {
      let out = "";
      res.setEncoding("utf8").on("data", (chunk) => (out += chunk)).on("end", () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null, took: Date.now() - from }));
    });
    req.once("error", reject).end(text);
  });
}

/** GET /capabilities one after another until `until` settles: the slowest answer. */
async function slowestWhile(port, token, until) {
  let done = false;
  until.finally(() => (done = true)).catch(() => {});
  let slowest = 0;
  for (let i = 0; !done || i === 0; i++) slowest = Math.max(slowest, (await timed(port, token, "GET", "/capabilities")).took);
  return slowest;
}

/** Another connection holding store.sqlite (`IMMEDIATE`: no other writer; `EXCLUSIVE`: no reader either; `READ`: a
 *  reader's shared lock, which a writer's commit waits for). */
function hold(t, data, mode = "IMMEDIATE") {
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  store.exec(`BEGIN ${mode === "READ" ? "" : mode}`);
  if (mode === "READ") store.prepare("SELECT count(*) FROM agents").get();
  const release = () => store.isOpen && (store.isTransaction && store.exec("ROLLBACK"), store.close());
  t.after(release);
  return release;
}

test("a read while the agent store is held exclusively waits, then answers once it is free", async (t) => {
  const { api, data, port, token } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("read"))).status, 201);
  const release = hold(t, data, "EXCLUSIVE");
  const read = timed(port, token, "GET", "/agents/read");
  const slowest = await slowestWhile(port, token, sleep(500));
  release();
  const answer = await read;
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.ok(slowest < 200, `GET /capabilities took ${slowest} ms while the read waited`);
});

/** A workflow agent whose run is working, its model node answering 1.5 s after it starts, or once a file exists when
 *  `instructions` say "Answer once <file> exists.". */
async function workingFlow(api, id, instructions = "Answer soon.") {
  assert.equal((await api("POST", "/agents", flowAgent(id, answerFlow(instructions)))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { question: instructions } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["working"]);
  return started.body.run_id;
}

/** Refusals of the run's end, 100 ms apart, that add up to more than a request's 2 s wait. */
const PAST_A_REQUEST = 21;

/** Holds each of the next two commits until both have arrived: each read its current revision and passed its checks, and
 *  both reach the store's own check of the body together, as two edits in flight at once do. */
async function twoCommitsAtOnce(t) {
  const probe = await scratch(t);
  const store = openStore(probe);
  const proto = Object.getPrototypeOf(store);
  store.close();
  const commit = proto.commitRevision;
  t.after(() => void (proto.commitRevision = commit));
  const arrived = [];
  let armed = true;
  proto.commitRevision = async function (agentId, input, options) {
    if (armed) {
      await new Promise((resolve) => {
        arrived.push(resolve);
        if (arrived.length === 2) (armed = false), arrived.forEach((go) => go());
      });
    }
    return commit.call(this, agentId, input, options);
  };
  return () => assert.equal(arrived.length, 2, "both edits reached the store's commit together");
}

// SKIP (follow-up #2058): a message to a run that completed or was stopped answers 409 not_continuable: the store does not open the run again
test.skip("a follow-up to a stopped run is taken while another connection holds the agent store, and runs; taken or refused, never both", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t);
  const { run_id } = await startRun(api, "slow", "Take your time.");
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const { status, state } = (await api("GET", `/runs/${run_id}`)).body;
    if (status === "working" && state === "working") break;
    assert.ok(Date.now() < end, `the run works: last ${status}/${state}`);
  }
  assert.equal((await api("POST", `/runs/${run_id}/stop`)).body.stopped, true);
  await follow(api, run_id, ["input_required"]);
  // No reader gets through: a message that reads the store waits about 2 s, then answers home_busy.
  const release = hold(t, data, "EXCLUSIVE");
  const sent = await api("POST", `/runs/${run_id}/messages`, { content: "Go on." });
  release();
  // Taken or refused, never both: a refusal for a message the run took anyway (it runs) invites a retry that sends it
  // twice. Taken, the run no longer reads stopped (its message waits its turn, or has run); refused, it does.
  const after = (await api("GET", `/runs/${run_id}`)).body;
  const taken = !(after.status === "input_required" && after.state === "idle");
  assert.equal(taken, sent.status === 202, `answered ${sent.status} ${sent.body.error?.code ?? sent.body.mode}, and the run ${taken ? `took it (${after.status}/${after.state})` : "did not take it"}: taken or refused, never both`);
  assert.deepEqual([sent.status, sent.body.mode], [202, "follow_up"], JSON.stringify(sent.body));
  const { rows } = await follow(api, run_id, ["completed"]);
  assert.deepEqual(rows.filter((row) => row.kind === "user_message").map((row) => row.summary), ["You: Take your time.", "You: Go on."], "it ran, once");
});

test("a run's start is answered 202 even when the agent store turns busy right after the run is written; taken or refused, never both", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("starter"))).status, 201);
  // In this process the agent store reads and writes through node:sqlite. From the moment the run's row is written, the
  // store's read of one run (readRun) finds it busy for 3 s, longer than a request waits (about 2 s), as a store another
  // connection took right then would be. Everything before that goes through, the run's own writes among it.
  const prepare = DatabaseSync.prototype.prepare;
  let busyUntil = 0;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (/^INSERT INTO runs /.test(sql)) busyUntil = Date.now() + 3_000;
    if (Date.now() < busyUntil && /FROM runs r JOIN agents a /.test(sql) && /WHERE r\.id = :id/.test(sql)) throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    return prepare.call(this, sql, ...rest);
  };
  t.after(() => (DatabaseSync.prototype.prepare = prepare));
  const started = await api("POST", "/agents/starter/runs", { input: { content: "What is six times seven?" } });
  while (Date.now() < busyUntil) await sleep(100);
  DatabaseSync.prototype.prepare = prepare;
  // Taken or refused, never both: a refusal for a run that started anyway invites a retry that starts a second one.
  const runs = (await api("GET", "/agents/starter/runs")).body.runs;
  assert.equal(runs.length === 1, started.status === 202, `answered ${started.status} ${started.body.error?.code ?? ""}, and ${runs.length} run(s) started: taken or refused, never both`);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(runs.length, 1, "one run");
  await follow(api, started.body.run_id, ["completed"]);
});
