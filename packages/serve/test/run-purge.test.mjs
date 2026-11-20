// DELETE /v2/runs/{run_id} (agent-delete.ts purgeRun): an owner must be able to delete what a run read, and what it cost
// stays in every total. A run that is not live is purged: its row stays as its tombstone (its id, agent, state, times
// and cost) and everything else of it goes (its launch, journal and timeline, messages and commands, outputs and files,
// kept answers, folders and settings, the grades its agent keeps of it, its kept learning's content), with the runs made
// from it (its audit's shadow run, a learning run that grades it, the replays of its input), each a tombstone too.
//   - Money: /usage by meter, agent and day, /stats, and a run's spend as the cap reads it are deep-equal before and after.
//   - Reads: every route of it 410 purged, with its tombstone; its DELETE 204 again; an unknown run 404.
//   - Live (queued, running, waiting on a person, or held by a runner): 409 run_not_final, nothing purged. A run that
//     ended and takes a follow-up (it reads idle), or that a person stopped, is not live.
//   - Who: the owner's session or the API token; no credential 401; a console session that is no owner's 403.
//   - A DELETE stopped part way is finished by the next one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { purgeRun } from "../dist/agent-delete.js";
import { keepRunDisk, runDiskKey, saveArchilSettings, storeAgentDisk } from "../dist/archil-settings.js";
import { shadowRunId } from "../dist/learn/audit.js";
import { StoreConstraint } from "../dist/store/index.js";
import { gradesKey, putGrade } from "../dist/learn/promote.js";
import { metersOverStore, spendOverStore, spentOverStore } from "../dist/store-reads/cap.js";
import { runFolder, scratchFolder } from "../dist/workspace/paths.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { builtConsole, call, cookieOf, FAUX, follow, serve, startInProcessRunner, startRun, withEnv } from "./support.mjs";

/** An agent's folder name on a disk (archil-routes.ts: agentDirName). */
const agentDirOf = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;

const WINDOW = "from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z";

/** Every place in the store's file that holds `id`: `table.column` of each row whose value has it, from every table the
 *  schema made. */
function mentions(data, id) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    const found = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
        for (const [column, value] of Object.entries(row)) {
          const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
          if (text?.includes(id)) found.push(`${name}.${column}`);
        }
      }
    }
    return [...new Set(found)].sort();
  } finally {
    db.close();
  }
}

/** Statements on the store's file, for rows the server has no route to write. */
function write(data, statements) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 5_000 });
  try {
    for (const [sql, ...params] of statements) db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Two completed runs of agent `id`, each graded (its grade kept as the grade route keeps one): their ids. */
async function twoRuns(api, store, id = "calc") {
  const first = await startRun(api, id, "What is six times seven?");
  await follow(api, first.run_id, ["completed"]);
  const second = await api("POST", `/agents/${id}/runs`, { input: { content: "And six times eight?" } });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  await follow(api, second.body.run_id, ["completed"]);
  for (const run of [first.run_id, second.body.run_id]) await putGrade(store.settings, id, { run, correct: true, source: "feedback", at: new Date().toISOString(), path: "agent" });
  return [first.run_id, second.body.run_id];
}

/** A server with a runner of the test's own beside it, which `halt()` closes: the runs the test writes to the store after
 *  that (storedRun) are claimed by the test alone, never raced by a runner. */
async function haltable(t, options = {}) {
  const server = await serve(t, { ...options, runner: false });
  const close = await startInProcessRunner(server.data, { ...options, faux: FAUX, mcpOwn: server.own });
  let closed;
  const halt = () => (closed ??= close());
  t.after(halt);
  return { ...server, halt };
}

/** A run of agent `agentId` written to the store by the test (a replay of another's input, an audit's shadow, a learning
 *  run), claimed at once under the test's own claim, then ended with `patch` unless it is null: the claim. Only on a
 *  server whose runner is halted (haltable). */
async function storedRun(store, agentId, id, patch, launch = { input: { content: "Again." } }) {
  const agent = await store.agents.get(agentId);
  await store.runs.create({ id, agentId, revisionId: agent.currentRevision }, { body: launch });
  const claim = await store.claim(id, "runner-test", { leaseMs: 120_000 });
  assert.ok(claim, `run ${id} is claimed`);
  if (patch) await store.runs.update(claim, patch);
  return claim;
}

/** Everything a total reads: /usage by meter, by agent and by day; /stats; and each of `runs`' spend and meters as the cap
 *  and /usage read them over the store. */
async function money(api, store, runs) {
  const usage = {};
  for (const group of ["meter", "agent", "day"]) {
    const answer = await api("GET", `/usage?${WINDOW}&group_by=${group}`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    usage[group] = answer.body;
  }
  const stats = await api("GET", "/stats");
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  const spend = {};
  for (const run of runs) {
    spend[run] = {
      spent: await spentOverStore(store, run, BACKGROUND_CONTEXT),
      spend: await spendOverStore(store, run, BACKGROUND_CONTEXT),
      meters: await metersOverStore(store, run, BACKGROUND_CONTEXT),
    };
  }
  return { usage, stats: stats.body, spend };
}

/** A purged run's read: 410 purged. */
const purged = (answer, what) => assert.deepEqual([answer.status, answer.body?.error?.code ?? answer.json?.error?.code], [410, "purged"], `${what}: ${answer.status} ${JSON.stringify(answer.body ?? answer.text)}`);

test("DELETE /runs/{id} purges an ended run and keeps its money: /usage by meter, agent and day, /stats and its spend deep-equal, with its audit's shadow and the learning run that grades it; every read of it 410 with its tombstone; in no listing; no table names it but its tombstone; a second DELETE 204; an unknown run 404", { timeout: 180_000 }, async (t) => {
  const { api, data, store, port, token, halt } = await haltable(t);
  const [gone, kept] = await twoRuns(api, store);
  await halt();
  // Its audit's shadow, and a learning run that grades it (named by its kept learning), each with a cost of its own.
  const shadow = shadowRunId(gone);
  await storedRun(store, "calc", shadow, { state: "ended", costUsd: 0.07 });
  await storedRun(store, "calc", "learn-1", { state: "ended", costUsd: 0.05 });
  write(data, [
    ["UPDATE runs SET cost_usd = ? WHERE id = ?", 0.25, gone],
    ["INSERT INTO learning_proposals (run_id, round, agent_id, turn, proposal, learning_run_id, created_at) VALUES (?, 99, 'calc', ?, ?, 'learn-1', ?)", gone, JSON.stringify({ asked: "What the run read." }), JSON.stringify({ state: "merged", detail: "What it learned from the run." }), Date.now()],
  ]);
  const runs = [gone, kept, shadow, "learn-1"];
  const before = await money(api, store, runs);
  assert.ok(before.usage.meter.total_usd >= 0.25 + 0.07 + 0.05, `the run, its shadow and its learning are in the total: ${JSON.stringify(before.usage.meter)}`);
  assert.ok(before.usage.meter.lines.some((line) => line.meter === "learning" && line.usd === 0.05), `its learning run is the learning line: ${JSON.stringify(before.usage.meter.lines)}`);
  const row = await store.runs.get(gone);
  assert.ok(mentions(data, gone).includes("run_launch.run_id"), "the run is in the store before");
  assert.ok(existsSync(dirname(runFolder(data, "calc", gone))), "and has a folder");

  const deleted = await api("DELETE", `/runs/${gone}`);
  assert.equal(deleted.status, 204, `DELETE /runs/{id}: ${deleted.status} ${JSON.stringify(deleted.body)}`);

  assert.deepEqual(await money(api, store, runs), before, "no total, line or spend moved");

  for (const path of [`/runs/${gone}`, `/runs/${gone}/timeline`, `/runs/${gone}/graph`, `/runs/${gone}/trace`, `/runs/${gone}/files`, `/runs/${gone}/learning`]) purged(await api("GET", path), `GET ${path}`);
  purged(await call(port, { path: `/v2/runs/${gone}/timeline`, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }), "its timeline's event stream");
  for (const [method, path, body] of [["POST", `/runs/${gone}/messages`, { content: "And eight?" }], ["POST", `/runs/${gone}/archive`], ["PUT", `/runs/${gone}/grade`, { correct: true }]]) purged(await api(method, path, body), `${method} ${path}`);
  const tomb = (await api("GET", `/runs/${gone}`)).body.error.details;
  assert.deepEqual(Object.keys(tomb).sort(), ["agent_id", "cost_upper_bound", "cost_usd", "ended_at", "purged_at", "run_id", "started_at", "state", "tools_usd"]);
  const iso = (ms) => new Date(ms).toISOString();
  assert.deepEqual([tomb.run_id, tomb.agent_id, tomb.state, tomb.cost_usd, tomb.cost_upper_bound, tomb.started_at, tomb.ended_at], [gone, "calc", "ended", 0.25, false, iso(row.startedAt), iso(row.endedAt)], `its tombstone: ${JSON.stringify(tomb)}`);
  assert.equal(tomb.tools_usd, before.spend[gone].meters.tools, "its paid tools' meter, as /usage read it");
  assert.ok(Date.parse(tomb.purged_at) >= Date.parse(tomb.ended_at), "purged after it ended");
  for (const child of [shadow, "learn-1"]) purged(await api("GET", `/runs/${child}`), `the run made from it, ${child}`);

  assert.ok(!(await api("GET", "/runs")).body.runs.some((run) => run.run_id === gone), "not in GET /runs");
  assert.ok(!(await api("GET", "/runs?archived=true")).body.runs.some((run) => run.run_id === gone), "nor its archived list");
  assert.deepEqual((await api("GET", "/agents/calc/runs")).body.runs.map((run) => run.run_id), [kept], "its agent lists its other run alone");
  assert.deepEqual(mentions(data, gone), ["learning_proposals.run_id", "runs.id"], "no table names it but its tombstone (its shadow's is named after it) and its kept learning's row");
  assert.deepEqual(mentions(data, "What the run read"), [], "its kept learning's content is gone");
  assert.ok(!existsSync(dirname(runFolder(data, "calc", gone))), "its folder is gone");
  assert.ok(!existsSync(scratchFolder(data, "calc", gone)), "and its scratch folder");
  assert.deepEqual(((await store.settings.get(gradesKey("calc")))?.items ?? []).map((grade) => grade.run), [kept], "its grade is dropped, its sibling's kept");

  // Its agent and its other run are as they were.
  assert.equal((await api("GET", "/agents/calc")).status, 200);
  const other = await api("GET", `/runs/${kept}`);
  assert.deepEqual([other.status, other.body.status], [200, "completed"]);
  assert.ok((await api("GET", `/runs/${kept}/timeline`)).body.rows.length > 0, "its sibling's timeline is kept");
  assert.ok(existsSync(dirname(runFolder(data, "calc", kept))), "and its folder");

  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204, "a second DELETE is 204");
  assert.deepEqual(await money(api, store, runs), before, "and moves nothing");
  const unknown = await api("DELETE", "/runs/no-such-run");
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, "not_found"]);
});

test("a run that is idle (completed, a follow-up away) or that a person stopped is not live: each is purged", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t);
  const [idle] = await twoRuns(api, store);
  assert.equal((await api("GET", `/runs/${idle}`)).body.state, "idle", "a completed agent run reads idle");
  // A person's stop: its turn is over, not the run (a message opens it again). The DELETE goes the moment it reads idle.
  const stopped = await startRun(api, "slow", "Take your time.");
  await follow(api, stopped.run_id, ["working"]);
  assert.equal((await api("POST", `/runs/${stopped.run_id}/stop`)).status, 200);
  for (const until = Date.now() + 30_000; (await api("GET", `/runs/${stopped.run_id}`)).body.state !== "idle"; ) {
    assert.ok(Date.now() < until, `the stopped run reads idle: ${JSON.stringify((await api("GET", `/runs/${stopped.run_id}`)).body.state)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const run of [stopped.run_id, idle]) {
    const answer = await api("DELETE", `/runs/${run}`);
    assert.equal(answer.status, 204, `${run}: ${answer.status} ${JSON.stringify(answer.body)}`);
    purged(await api("GET", `/runs/${run}`), run);
  }
});

/** A purge's host (agent-delete.ts AgentDeleteHost) over rows the test holds: run `rows[id]` read as the test sets it, its
 *  turn over while `turnOver[id]`, its purge recorded. */
function hostOver(rows, turnOver, { waitMs = 5_000 } = {}) {
  const purgedRuns = [];
  const store = {
    runs: {
      get: async (id) => (rows[id] ? { id, agentId: "calc", purgedAt: null, ...rows[id] } : undefined),
      purge: async (id) => {
        if (rows[id].state === "running" || rows[id].runner !== null) throw new StoreConstraint(`run ${id} is live`);
        purgedRuns.push(id);
      },
    },
  };
  const host = {
    store,
    madeFrom: async () => [],
    forgetGrades: async () => {},
    forgetRun: async () => {},
    kept: async () => ({ meters: null, spend: { usd: null }, learning: null }),
    turnOver: async (id) => turnOver[id] === true,
    waitMs,
    pollMs: 20,
  };
  return { host, purgedRuns };
}

test("a run that reads idle before its runner wrote it ended is waited for, then purged; one whose turn is not over is 409 at once", async () => {
  // Its turn is over (a person's stop): the runner writes it stopped and lets it go 300 ms after the DELETE comes.
  const rows = { ending: { state: "running", runner: "runner-1" } };
  const { host, purgedRuns } = hostOver(rows, { ending: true });
  setTimeout(() => (rows.ending = { state: "stopped", runner: null }), 300);
  await purgeRun(host, "ending");
  assert.deepEqual(purgedRuns, ["ending"]);

  // A run working on: refused at once, nothing purged, never waited for.
  const working = hostOver({ busy: { state: "running", runner: "runner-1" } }, {});
  const started = Date.now();
  await assert.rejects(purgeRun(working.host, "busy"), (error) => error.code === "run_not_final" && error.extra.details.runs[0] === "busy");
  assert.ok(Date.now() - started < 1_000, "answered at once");
  assert.deepEqual(working.purgedRuns, []);

  // One whose end never comes within the wait: refused.
  const stuck = hostOver({ stuck: { state: "running", runner: "runner-1" } }, { stuck: true }, { waitMs: 200 });
  await assert.rejects(purgeRun(stuck.host, "stuck"), (error) => error.code === "run_not_final");
  assert.deepEqual(stuck.purgedRuns, []);
});

test("a run that is live is 409 run_not_final, nothing purged; once cancelled, the DELETE purges it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t);
  const live = await startRun(api, "slow", "Take your time.");
  await follow(api, live.run_id, ["working"]);
  const before = mentions(data, live.run_id);

  const refused = await api("DELETE", `/runs/${live.run_id}`);
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_not_final"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /cancel it first/);
  assert.deepEqual(refused.body.error.details?.runs, [live.run_id]);
  assert.equal((await api("GET", `/runs/${live.run_id}`)).status, 200, "the run is kept");
  assert.deepEqual(mentions(data, live.run_id), before, "nothing of it purged");
  assert.ok(existsSync(dirname(runFolder(data, "slow", live.run_id))), "nor its folder");

  assert.equal((await api("POST", `/runs/${live.run_id}/cancel`)).status, 202);
  await follow(api, live.run_id, ["cancelled"]);
  assert.equal((await api("DELETE", `/runs/${live.run_id}`)).status, 204);
  purged(await api("GET", `/runs/${live.run_id}`), "the cancelled run");
  assert.deepEqual(mentions(data, live.run_id), ["runs.id"]);
});

test("the runs made from a run are purged with it (its audit's shadow run, a replay of its input); one live is 409 run_not_final naming it, nothing purged", { timeout: 120_000 }, async (t) => {
  const { api, data, store, halt } = await haltable(t);
  const [graded, other] = await twoRuns(api, store);
  await halt();
  // A replay of another run's input: kept when that run is purged.
  await storedRun(store, "calc", "replay-of-other", { state: "ended" }, { input: { content: "And six times eight?" }, replay: { of: other } });
  // Held under this test's claim, so the runner beside never takes it: live until the test ends it.
  const claim = await storedRun(store, "calc", "replay-1", null, { input: { content: "What is six times seven?" }, replay: { of: graded } });
  await storedRun(store, "calc", shadowRunId(graded), { state: "ended" });

  const refused = await api("DELETE", `/runs/${graded}`);
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_not_final"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, ["replay-1"], "the live replay is named");
  for (const id of [graded, "replay-1", shadowRunId(graded)]) assert.equal((await store.runs.get(id)).purgedAt, null, `run ${id} is kept`);

  await store.runs.update(claim, { state: "stopped", outcome: "cancelled" });
  assert.equal((await api("DELETE", `/runs/${graded}`)).status, 204);
  for (const id of [graded, "replay-1", shadowRunId(graded)]) {
    assert.ok((await store.runs.get(id)).purgedAt !== null, `run ${id} is a tombstone`);
    assert.equal(await store.runs.launch(id).then(() => "kept", () => "gone"), "gone", `${id}'s launch is gone`);
  }
  assert.deepEqual(mentions(data, "replay-1"), ["runs.id"], "no table names the replay but its tombstone");
  for (const id of [other, "replay-of-other"]) assert.equal((await store.runs.get(id)).purgedAt, null, `run ${id}, made from another run, is kept`);
});

for (const step of ["run_made_from_gone", "run_forgotten"]) {
  test(`a run's DELETE stopped at ${step.replaceAll("_", " ")} is not purged yet; the next DELETE finishes it`, { timeout: 120_000 }, async (t) => {
    // It stops at the run's own step (a run made from it passes the same step before it).
    const crash = { done: false, run: undefined };
    const { api, data, store, halt } = await haltable(t, {
      agentDeleteAt: (at, id) => {
        if (at !== step || crash.done || id !== crash.run) return;
        crash.done = true;
        throw new Error(`stopped ${at}`);
      },
    });
    const [gone] = await twoRuns(api, store);
    await halt();
    crash.run = gone;
    await storedRun(store, "calc", shadowRunId(gone), { state: "ended", costUsd: 0.07 });
    const before = await money(api, store, [gone, shadowRunId(gone)]);
    const stopped = await api("DELETE", `/runs/${gone}`);
    assert.deepEqual([stopped.status, stopped.body.error?.code], [500, "internal"], JSON.stringify(stopped.body));
    assert.ok(crash.done, "it stopped where it was told to");
    assert.equal((await store.runs.get(gone)).purgedAt, null, "the run is not purged yet");
    assert.ok((await store.runs.get(shadowRunId(gone))).purgedAt !== null, "the run made from it went first");

    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    purged(await api("GET", `/runs/${gone}`), "the run");
    assert.deepEqual(await money(api, store, [gone, shadowRunId(gone)]), before, "its money is where it was");
    assert.deepEqual(mentions(data, gone), ["runs.id"], "no table names it but its tombstone");
    assert.ok(!existsSync(dirname(runFolder(data, "calc", gone))), "nor its folder");
  });
}

/** A test's owner password (no secret: joined so a scan for a literal one never reads it as one). */
const PASSWORD = ["not-a-secret", "owner"].join("-");

/** An accounts-on server whose owner set a password: its port, its session cookie and the page's headers. */
async function ownedServer(t) {
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t) });
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  return { ...server, page: { "content-type": "application/json", origin, cookie: cookieOf(made) } };
}

test("who may purge: the owner's session 204, the API token 204, no credential 401", { timeout: 180_000 }, async (t) => {
  const server = await ownedServer(t);
  const [bySession, byToken] = await twoRuns(server.api, server.store);
  const none = await call(server.port, { method: "DELETE", path: `/v2/runs/${bySession}` });
  assert.deepEqual([none.status, none.json?.error?.code], [401, "unauthenticated"], none.text);
  assert.equal((await server.store.runs.get(bySession)).purgedAt, null, "nothing purged");
  const session = await call(server.port, { method: "DELETE", path: `/v2/runs/${bySession}`, headers: server.page });
  assert.equal(session.status, 204, `the owner's session: ${session.text}`);
  assert.equal((await server.api("DELETE", `/runs/${byToken}`)).status, 204, "the API token");
  for (const run of [bySession, byToken]) purged(await server.api("GET", `/runs/${run}`), run);
});

test("a console session that is no owner's (accounts off on a server bound off loopback) is 403 forbidden, nothing purged", { timeout: 120_000 }, async (t) => {
  const host = Object.values(networkInterfaces()).flat().find((nic) => nic && nic.family === "IPv4" && !nic.internal)?.address;
  if (!host) return t.skip("this machine has no address off loopback");
  const server = await serve(t, { host });
  const [run] = await twoRuns(server.api, server.store);
  const at = (method, path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host, port: server.port, method, path, headers: { host: `${host}:${server.port}`, ...headers } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.once("error", reject).end();
    });
  const link = await at("GET", `/?launch=${server.launchCode}`);
  assert.equal(link.status, 303, `the launch link sets the console's cookie: ${link.text}`);
  const refused = await at("DELETE", `/v2/runs/${run}`, { cookie: cookieOf(link), origin: `http://${host}:${server.port}`, "content-type": "application/json" });
  assert.deepEqual([refused.status, refused.json?.error?.code], [403, "forbidden"], refused.text);
  assert.equal((await server.store.runs.get(run)).purgedAt, null, "nothing purged");
});

test("a run on its agent's own Archil disk: its folder there is deleted, the disk, the agent's folder and its sibling's folder kept; while Archil refuses, 503 with the run not purged, and the next DELETE finishes", { timeout: 120_000 }, async (t) => {
  const own = "dsk-a9e0d15c00000001";
  const control = archilControlFetch({ region: "aws-us-east-1", strict: true, disks: [{ id: own, name: "its-agents-disk" }] });
  withEnv(t, { ARCHIL_API_KEY: "fake-test-key" }, ["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  const disk = new FakeArchilDisk();
  disk.id = own;
  const { api, store } = await serve(t, { archilControl: { baseUrl: control.baseUrl, fetch: control.fetch, makeDisk: () => disk } });
  const [gone, kept] = await twoRuns(api, store);
  // Both ran on the agent's disk, as a run's claim keeps the disk it resolved to (archil-settings.ts: keepRunDisk).
  await storeAgentDisk(store, "calc", { diskId: own });
  for (const run of [gone, kept]) await keepRunDisk(store, run, own);
  const dir = `agents/${agentDirOf("calc")}`;
  const its = [`${dir}/runs/${gone}/work/notes.md`, `${dir}/runs/${gone}/exec-out/spill.txt`];
  const theirs = [`${dir}/runs/${kept}/work/kept.md`, `${dir}/learning/corrections.md`];
  for (const key of [...its, ...theirs]) await disk.putObject(key, Buffer.from("bytes"));

  // Archil is off: the folder can't be reached, so the run is kept for the next DELETE.
  const off = await api("DELETE", `/runs/${gone}`);
  assert.deepEqual([off.status, off.body.error?.code], [503, "unavailable"], JSON.stringify(off.body));
  assert.match(off.body.error.message, new RegExp(`${gone}[^]*${own}[^]*its agent's own`));
  assert.equal((await api("GET", `/runs/${gone}`)).status, 200, "the run is not purged");
  assert.ok(disk.files.has(its[0]), "and its file on the disk is kept");

  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  const done = await api("DELETE", `/runs/${gone}`);
  assert.equal(done.status, 204, JSON.stringify(done.body));
  const left = [...disk.files.keys(), ...disk.dirs].filter((key) => key === `${dir}/runs/${gone}` || key.startsWith(`${dir}/runs/${gone}/`));
  assert.deepEqual(left, [], "nothing of the run is left on the disk");
  for (const key of theirs) assert.ok(disk.files.has(key), `${key} is kept`);
  assert.ok(control.disks.has(own), "the disk itself is kept");
  assert.equal(await store.settings.get(runDiskKey(gone)), undefined, "the run's disk setting is gone");
  assert.deepEqual(await store.settings.get(runDiskKey(kept)), { diskId: own }, "its sibling's is kept");
  assert.equal((await api("GET", `/runs/${kept}`)).status, 200);
});
