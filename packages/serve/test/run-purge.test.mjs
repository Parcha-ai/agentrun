// DELETE /v2/runs/{run_id} (agent-delete.ts purgeRun): an owner must be able to delete what a run read, and what it cost
// stays in every total. A run that is not live is purged: its row stays as its tombstone (its id, agent, state, times
// and cost) and everything else of it goes (its launch, journal and timeline, messages and commands, outputs and files,
// kept answers, folders and settings, the grades its agent keeps of it, its kept learning's content, its merges' diff files
// and feedback lines in its agent's learning folder, whose history reads serve none of its merges after), with the runs
// made from it (its audit's shadow run, a learning run that grades it, the replays of its input), each a tombstone too.
//   - Money: /usage by every group it takes (none is a label), /stats, and a run's spend as the cap reads it are
//     deep-equal before and after. Its metrics keep figures and names alone; its kept learning row is a link alone.
//   - A message or a grade sent while its DELETE runs waits for it and is 410 purged.
//   - Reads: every route of it 410 purged, with its tombstone; its DELETE 204 again; an unknown run 404.
//   - Live (queued, running, waiting on a person, or held by a runner): 409 run_not_final, nothing purged. A run that
//     ended and takes a follow-up (it reads idle), or that a person stopped, is not live.
//   - Who: the owner's session or the API token; no credential 401; a console session that is no owner's 403.
//   - A DELETE stopped part way is finished by the next one.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { purgeRun } from "../dist/agent-delete.js";
import { keepRunDisk, runDiskKey, saveArchilSettings, storeAgentDisk } from "../dist/archil-settings.js";
import { shadowRunId } from "../dist/learn/audit.js";
import { appendCorrection, learningCommit } from "../dist/learn/commit.js";
import { learningFolderOf } from "../dist/learning.js";
import { StoreConstraint } from "../dist/store/index.js";
import { gradesKey, putGrade } from "../dist/learn/promote.js";
import { metersOverStore, spendOverStore, spentOverStore } from "../dist/store-reads/cap.js";
import { forgetServed, viewOverStore } from "../dist/store-view.js";
import { agentLearningFolder, runFolder, scratchFolder } from "../dist/workspace/paths.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { ended, git, repoOf, started } from "./learn-support.mjs";
import { agent, answerFlow, builtConsole, call, cookieOf, FAUX, follow, serve, startInProcessRunner, startRun, WINDOW, withEnv } from "./support.mjs";

/** An agent's folder name on a disk (archil-routes.ts: agentDirName). */
const agentDirOf = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;

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

/** The rows `sql` reads from the store's file. */
function rowsOf(data, sql, ...params) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** Every string a JSON value holds as a value (never a key), with where: its keys joined by ".", an object of names'
 *  entry by its parent's name and "*" (tools.*.calls), an array's by "[]". */
function stringsIn(value, at = "") {
  if (typeof value === "string") return [[at, value]];
  if (value === null || typeof value !== "object") return [];
  const named = new Set(["tools", "models"]);
  return Object.entries(value).flatMap(([key, each]) => stringsIn(each, Array.isArray(value) ? `${at}[]` : named.has(at) ? `${at}.*` : at ? `${at}.${key}` : key));
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

/** Everything a total reads: /usage by each group it takes (meter, agent, key, day, region; none is a label); /stats; and
 *  each of `runs`' spend and meters as the cap and /usage read them over the store. */
async function money(api, store, runs) {
  const usage = {};
  for (const group of ["meter", "agent", "key", "day", "region"]) {
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

test("DELETE /runs/{id} purges an ended run and keeps its money: /usage by each group, /stats and its spend deep-equal, its metrics figures and names alone, its kept learning a link alone, with its audit's shadow and the learning run that grades it; every read of it 410 with its tombstone; in no listing; no table names it but its tombstone; a second DELETE 204; an unknown run 404", { timeout: 180_000 }, async (t) => {
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
    // Words its metrics may hold beside their figures: a grader's verdict, a learned loop's nodes, an audit's link.
    ["UPDATE runs SET metrics = json_set(coalesce(metrics, '{}'), '$.compared', json(?), '$.loops', json(?), '$.audit', json(?)) WHERE id = ?", JSON.stringify({ same: false, differs_on: "What the grader said of https://example.com/read" }), JSON.stringify([{ node: "What the loop read", iterations: 2, met: true }]), JSON.stringify({ of: "another-run", workflow: "flow" }), gone],
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
  // Its kept learning row is a money link alone: its ids and its state, no turn or proposal text.
  const [link] = rowsOf(data, "SELECT * FROM learning_proposals WHERE run_id = ?", gone);
  assert.deepEqual([link.agent_id, link.learning_run_id, link.turn, JSON.parse(link.proposal)], ["calc", "learn-1", "{}", { state: "merged" }], `its kept learning row: ${JSON.stringify(link)}`);
  // Its metrics are figures and the names they are keyed by: every string in them a key, a tool's or a model's name (a
  // key too), or a code at a place that holds one; no grader's words, loop or link.
  const [{ metrics: stored, outcome }] = rowsOf(data, "SELECT metrics, outcome FROM runs WHERE id = ?", gone);
  const metrics = JSON.parse(stored);
  assert.equal(typeof metrics.requests, "number", `its figures are kept: ${stored}`);
  const CODES = new Set(["effort", "costBasis", "purged.spend.basis", "purged.learning.state", "purged.learning.reason"]);
  for (const [at, text] of stringsIn(metrics)) assert.ok(CODES.has(at) && /^[\w-]+$/.test(text), `a string in its metrics that is no name or code: ${at} = ${JSON.stringify(text)}`);
  for (const words of ["What the grader said", "What the loop read", "another-run", "example.com/read"]) assert.deepEqual(mentions(data, words), [], `${words}: gone from its metrics`);
  assert.ok(outcome === null || ["completed", "escalated", "stopped", "cancelled"].includes(outcome), `its outcome is a code: ${outcome}`);
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
function hostOver(rows, turnOver, { waitMs = 5_000, flips = {} } = {}) {
  const purgedRuns = [];
  // How often each run was read (runs.get) and asked whether its turn is over (turnOver). `flips[id]`: {at, row}, the
  // row the run reads from its at-th read on (its runner wrote it ended meanwhile).
  const reads = {};
  const asked = {};
  const store = {
    // A store's own origin is itself (Store.origin): the readers' caches key on it (store-view.ts forgetServed).
    get origin() {
      return this;
    },
    runs: {
      get: async (id) => {
        reads[id] = (reads[id] ?? 0) + 1;
        if (flips[id] && reads[id] === flips[id].at) rows[id] = flips[id].row;
        return rows[id] ? { id, agentId: "calc", purgedAt: null, ...rows[id] } : undefined;
      },
      purge: async (id) => {
        if (rows[id].state === "running" || rows[id].runner !== null) throw new StoreConstraint(`run ${id} is live`);
        purgedRuns.push(id);
      },
    },
  };
  const host = {
    store,
    madeFrom: async () => [],
    forgetCopies: async () => {},
    forgetRun: async () => {},
    kept: async () => ({ meters: null, spend: { usd: null }, learning: null }),
    turnOver: async (id) => {
      asked[id] = (asked[id] ?? 0) + 1;
      return turnOver[id] === true;
    },
    waitMs,
    pollMs: 20,
  };
  return { host, purgedRuns, reads, asked };
}

test("a run that reads idle before its runner wrote it ended is waited for, then purged; one whose turn is not over is 409 at once", async () => {
  // Its turn is over (a person's stop): the runner writes it stopped and lets it go before the DELETE's second read of it
  // (the first is the DELETE's own, the second its wait's first poll).
  const rows = { ending: { state: "running", runner: "runner-1" } };
  const { host, purgedRuns, reads } = hostOver(rows, { ending: true }, { flips: { ending: { at: 2, row: { state: "stopped", runner: null } } } });
  await purgeRun(host, "ending");
  assert.deepEqual(purgedRuns, ["ending"]);
  assert.equal(reads.ending, 2, "purged once its wait read it ended");

  // A run working on: refused at once, nothing purged, never waited for: its turn is asked once, and it is read no more.
  const working = hostOver({ busy: { state: "running", runner: "runner-1" } }, {});
  await assert.rejects(purgeRun(working.host, "busy"), (error) => error.code === "run_not_final" && error.extra.details.runs[0] === "busy");
  assert.equal(working.asked.busy, 1, "its turn asked once: answered at once");
  assert.equal(working.reads.busy, 1, "never read again");
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
  // Nothing purged: every place the run was written before is still there. The live run may be written in more places
  // meanwhile (its listing, built by the lister's pass, can land after the first read), which is no purge.
  const after = mentions(data, live.run_id);
  assert.deepEqual(before.filter((place) => !after.includes(place)), [], "nothing of it purged");
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

/** `promise`, or a failure in words once `ms` have passed. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms).unref())]);

/** A server whose run DELETE holds at `step` for the run `gate.run` once `gate.arm()` was called: `gate.reached` settles
 *  when it holds there, `gate.release()` lets it go on. `gate.queued(agentId, n)` settles once `n` requests wait in that
 *  agent's delete turn (the server's deleteTurnQueued seam): each is provably behind the held DELETE. */
async function heldAt(t, step) {
  const gate = { armed: false, run: undefined, waits: [] };
  gate.arm = (run) => {
    gate.run = run;
    gate.armed = true;
    gate.reached = new Promise((resolve) => (gate.reach = resolve));
    gate.held = new Promise((resolve) => (gate.release = resolve));
  };
  gate.queued = (agentId, n) => new Promise((resolve) => gate.waits.push({ agentId, n, resolve }));
  const server = await haltable(t, {
    agentDeleteAt: async (at, id) => {
      if (at !== step || !gate.armed || id !== gate.run) return;
      gate.armed = false;
      gate.reach();
      await gate.held;
    },
    deleteTurnQueued: (agentId, waiting) => {
      for (const one of gate.waits) if (one.agentId === agentId && waiting >= one.n) one.resolve();
    },
  });
  return { ...server, gate };
}

test("a message sent while a run's DELETE runs (its folders gone, its tombstone not yet written) waits for it and is 410 purged: the run is never opened again under its purge", { timeout: 120_000 }, async (t) => {
  const { api, data, store, halt, gate } = await heldAt(t, "run_forgotten");
  const [gone] = await twoRuns(api, store);
  await halt();
  assert.equal((await api("GET", `/runs/${gone}`)).body.state, "idle", "a message would open it again");
  gate.arm(gone);
  const deleting = api("DELETE", `/runs/${gone}`);
  await within(gate.reached, 60_000, "the DELETE reached its folders' end");
  const sending = api("POST", `/runs/${gone}/messages`, { content: "And eight?" });
  await within(gate.queued("calc", 1), 60_000, "the message waits in the DELETE's turn");
  gate.release();
  const [deleted, sent] = await Promise.all([deleting, sending]);
  assert.equal(deleted.status, 204, `the DELETE: ${deleted.status} ${JSON.stringify(deleted.body)}`);
  purged(sent, "the message");
  purged(await api("GET", `/runs/${gone}`), "the run");
  assert.deepEqual(mentions(data, gone), ["runs.id"], "no message or command of it is written");
});

/** A PUT of `path` whose JSON body is sent in two parts, `tail` once `finish()` is called: its answer. */
function slowPut(port, token, path, head, tail) {
  let finish;
  const answer = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "PUT", path, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(head + tail) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    req.write(head);
    finish = () => req.end(tail);
  });
  return { answer, finish };
}

test("a grade whose body arrives while its run's DELETE runs (its run read live when it was sent) waits for the DELETE and is 410 purged: no grade of the run is kept", { timeout: 120_000 }, async (t) => {
  const { api, data, store, port, token, halt, gate } = await heldAt(t, "run_forgotten");
  const [gone, kept] = await twoRuns(api, store);
  await halt();
  // The grade's run is read when it is sent, before the purge's tombstone; its body comes while the DELETE holds the turn.
  const grading = slowPut(port, token, `/v2/runs/${gone}/grade`, '{"correct":', " false}");
  gate.arm(gone);
  const deleting = api("DELETE", `/runs/${gone}`);
  await within(gate.reached, 60_000, "the DELETE reached its folders' end");
  grading.finish();
  await within(gate.queued("calc", 1), 60_000, "the grade waits in the DELETE's turn");
  gate.release();
  assert.equal((await deleting).status, 204);
  purged(await grading.answer, "the grade");
  assert.deepEqual(((await store.settings.get(gradesKey("calc")))?.items ?? []).map((grade) => grade.run), [kept], "no grade of the purged run");
  assert.deepEqual(mentions(data, gone), ["runs.id"], "no table names it but its tombstone");
});

test("a replay of a run's input made while its DELETE runs (the runs made from it purged, its tombstone not yet written) holds the DELETE: 409 naming it, the run kept; once it ends, the next DELETE purges both; a replay or an audit's shadow made after is refused, nothing written", { timeout: 120_000 }, async (t) => {
  const { api, data, store, halt, gate } = await heldAt(t, "run_made_from_gone");
  const [gone] = await twoRuns(api, store);
  await halt();
  const { currentRevision } = await store.agents.get("calc");
  // The launch a live run's claim read before the DELETE (checkInputs), as reserve hands it to startReplay.
  const read = (await store.runs.launch(gone)).body;
  const replayOf = (id, link) => store.runs.create({ id, agentId: "calc", revisionId: currentRevision }, { body: { ...read, ...link } });
  gate.arm(gone);
  const deleting = api("DELETE", `/runs/${gone}`);
  await within(gate.reached, 60_000, "the DELETE purged the runs made from it");
  await replayOf("replay-late", { replay: { of: gone, workflow: "flow", digest: "d1" } });
  gate.release();
  const refused = await deleting;
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.runs], [409, "run_not_final", ["replay-late"]], `the DELETE names the replay: ${JSON.stringify(refused.body)}`);
  assert.equal((await store.runs.get(gone)).purgedAt, null, "the run is kept for the next DELETE");

  // The replay ends (its claim refused, say); the next DELETE purges both.
  const claim = await store.claim("replay-late", "runner-test", { leaseMs: 120_000 });
  await store.runs.update(claim, { state: "ended" });
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  for (const id of [gone, "replay-late"]) assert.ok((await store.runs.get(id)).purgedAt !== null, `${id} is a tombstone`);
  assert.deepEqual(mentions(data, "six times seven"), [], "its input is in no table");

  // Made after its purge: refused at the create, nothing written.
  for (const [id, link] of [["replay-after", { replay: { of: gone, workflow: "flow", digest: "d1" } }], [shadowRunId(gone), { audit: { of: gone, workflow: "flow", digest: "d1" } }]]) {
    await assert.rejects(replayOf(id, link), (error) => error?.name === "RunPurged" && error.runId === gone, `${id} is refused`);
    assert.equal(await store.runs.get(id), undefined, `${id}: nothing written`);
  }
  assert.deepEqual(mentions(data, "six times seven"), [], "its input is in no table after");
});

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

test("a purged run's answer and input stay in no in-process cache of its store: a read keeps both (its view's answer and input, its whole answer row), and its purge drops them", { timeout: 120_000 }, async (t) => {
  const { api, store, halt } = await haltable(t);
  // The faux model answers "On <the message>: done.": an answer one past a Timeline row's cap is read again whole, and
  // kept by the journal's reader as well as the view's.
  const content = `${"z".repeat(1991 - 4)} end`;
  const { run_id: run } = await startRun(api, "calc", content);
  await follow(api, run, ["completed"]);
  await halt();
  const deps = { origin: "", serverSecrets: () => [] };
  const read = async () => assert.equal((await viewOverStore(store, run, deps)).result.final_answer, `On ${content}: done.`);
  await read();
  const held = forgetServed(store, run);
  assert.deepEqual(held.slice(0, 2), [`answer ${run}`, `input ${run}`], `a read keeps its answer and input: ${JSON.stringify(held)}`);
  assert.equal(held.length, 3, `and its whole answer row: ${JSON.stringify(held)}`);
  await read();

  const host = {
    store,
    madeFrom: async () => [],
    forgetCopies: async () => {},
    forgetRun: async () => {},
    kept: async () => ({ meters: null, spend: { usd: null }, learning: null }),
    turnOver: async () => false,
    waitMs: 0,
    pollMs: 20,
  };
  await purgeRun(host, run);
  assert.notEqual((await store.runs.get(run)).purgedAt, null, "the run is purged");
  assert.deepEqual(forgetServed(store, run), [], "nothing of it is kept once it is purged");
});

test("a read begun before a run's purge and finished after it keeps none of the purged run's text: its answer and input stay in no in-process cache, and no later read serves them", { timeout: 120_000 }, async (t) => {
  const { store, halt } = await haltable(t);
  await halt();
  // A run whose learning held a draft for its owner's OK: its read checks the agent's folder (deps.statuses) after its
  // snapshot, and the test holds it there.
  const run = "run-read-over-purge";
  const answer = "The held answer, purged.";
  const input = { content: "The held input, purged." };
  await store.agents.create({ id: "calc", name: "Calc" }, { id: "rev-calc", kind: "agentic", body: { instructions: "Answer.", learning: true } });
  const claim = await storedRun(store, "calc", run, null, { input, title: "Held", place: { mode: "runner" } });
  const file = "workflows/held/workflow.json";
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: answer, costUsd: 0, endedAt: Date.now() }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "merged", merged: "c1", detail: "Waiting for your OK: workflow held.", workflows: [{ file, name: "held", pending: true }] } } }] });
  let asked;
  const askedFolder = new Promise((resolve) => (asked = resolve));
  let release;
  const folderRead = new Promise((resolve) => (release = resolve));
  const deps = { origin: "", serverSecrets: () => [], statuses: async () => (asked(), folderRead) };
  const reading = viewOverStore(store, run, deps);
  await askedFolder;

  const host = {
    store,
    madeFrom: async () => [],
    forgetCopies: async () => {},
    forgetRun: async () => {},
    kept: async () => ({ meters: null, spend: { usd: null }, learning: null }),
    turnOver: async () => false,
    waitMs: 0,
    pollMs: 20,
  };
  await purgeRun(host, run);
  assert.notEqual((await store.runs.get(run)).purgedAt, null, "the run is purged while its read waits");
  release(new Map([[file, { status: "pending" }]]));
  const held = await reading;
  assert.deepEqual([held.result.final_answer, held.input], [answer, input], "the read served what it read before the purge");

  assert.deepEqual(forgetServed(store, run), [], "the read that the purge overtook kept none of the run's text");
  const after = JSON.stringify((await viewOverStore(store, run, { origin: "", serverSecrets: () => [] })) ?? null);
  assert.ok(!after.includes(answer) && !after.includes(input.content), `no read after the purge serves its answer or input: ${after}`);
});

/** `write` over agent `agentId`'s learning folder on this server (learning.ts learningFolderOf), as a run's look-back or
 *  its compile writes it (learn/commit.ts): its merge's commit. */
async function learned(data, agentId, write) {
  const { workspace, end } = learningFolderOf(data, agentId);
  try {
    const done = await write(workspace);
    assert.equal(done.ok, true, JSON.stringify(done));
    return done.commit;
  } finally {
    await end();
  }
}

test("a run's purge removes what its agent's learning folder keeps of it in its current files (its merge's diff, its corrections line, the line as a later merge's diff shows it), as the README says, another run's kept; the agent's purge removes the folder", { timeout: 120_000 }, async (t) => {
  const { api, data, store, halt } = await haltable(t);
  const [gone, kept] = await twoRuns(api, store);
  await halt();
  // Each run's look-back merged one feedback line (learn/commit.ts appendCorrection): its diff, and its line on main. The
  // later merge's diff shows the earlier line as context.
  await learned(data, "calc", (ws) => appendCorrection(ws, { runId: gone, text: "Say six times seven is 42." }));
  await learned(data, "calc", (ws) => appendCorrection(ws, { runId: kept, text: "Answer in words." }));
  const folder = agentLearningFolder(data, "calc");
  const diffOf = (run) => join(folder, ".agentrun", "diffs", `${run}.json`);
  assert.match(await readFile(diffOf(kept), "utf8"), /six times seven/, "the later merge's diff shows the earlier line");
  const commits = Number(git(folder, ["rev-list", "--count", "main"]));

  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(existsSync(diffOf(gone)), false, "the run's diff leaves its agent's learning folder");
  assert.equal(await readFile(join(folder, "corrections.md"), "utf8"), "- Answer in words.\n", "its corrections line leaves main, another run's stays");
  assert.equal(git(folder, ["show", "main:corrections.md"]), "- Answer in words.");
  assert.equal(Number(git(folder, ["rev-list", "--count", "main"])), commits + 1, "in one commit");
  assert.equal(git(folder, ["log", "-1", "--format=%an <%ae>%n%s", "main"]), "agentrun-serve <serve@agentrun.invalid>\nhost: a purged run's corrections removed", "the host's");
  const later = JSON.parse(await readFile(diffOf(kept), "utf8"));
  assert.deepEqual(later.files.map(({ path, patch }) => [path, patch]), [["corrections.md", "@@ -1,0 +2,1 @@\n+- Answer in words.\n"]], "the later merge's diff keeps its own line, the purged one gone from its context");

  assert.equal((await api("POST", "/agents/calc/archive")).status, 200);
  assert.equal((await api("DELETE", "/agents/calc")).status, 204);
  assert.equal(existsSync(folder), false, "the agent's purge removes its learning folder");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(existsSync(folder), false, "a purged run's DELETE again makes no learning folder");
});

test("a run's purge takes its feedback line off main once: a DELETE again after a stop past its commit (its diff file left) takes no other run's same line", { timeout: 120_000 }, async (t) => {
  const { api, data, store, halt } = await haltable(t);
  const [gone, kept] = await twoRuns(api, store);
  await halt();
  await learned(data, "calc", (ws) => appendCorrection(ws, { runId: kept, text: "Answer in words." }));
  await learned(data, "calc", (ws) => appendCorrection(ws, { runId: gone, text: "Answer in words." }));
  const folder = agentLearningFolder(data, "calc");
  const diff = join(folder, ".agentrun", "diffs", `${gone}.json`);
  const left = await readFile(diff, "utf8");
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(git(folder, ["show", "main:corrections.md"]), "- Answer in words.", "one of the two same lines leaves main");
  const commits = Number(git(folder, ["rev-list", "--count", "main"]));

  // A stop after the scrub's commit, before its diff file went, leaves the file for the next DELETE.
  await writeFile(diff, left);
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(existsSync(diff), false, "the DELETE again removes the diff file left");
  assert.equal(git(folder, ["show", "main:corrections.md"]), "- Answer in words.", "the other run's same line stays");
  assert.equal(Number(git(folder, ["rev-list", "--count", "main"])), commits, "and commits nothing");

  // A merge of the run made since its scrub (a purge that stopped before its tombstone left the run open to a grade): the
  // next DELETE takes that line off too, in a commit of its own.
  await learned(data, "calc", (ws) => appendCorrection(ws, { runId: gone, round: 2, text: "Count in words too." }));
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(git(folder, ["show", "main:corrections.md"]), "- Answer in words.", "a later round's line leaves main too");
  assert.equal(existsSync(join(folder, ".agentrun", "diffs", `${gone}.r2.json`)), false, "with its diff file");
  assert.equal(Number(git(folder, ["rev-list", "--count", "main"])), commits + 2, "in its merge's commit and its scrub's");
});

test("a run's purge scrubs its text from its agent's learning folder: its diff files and its feedback line leave the current files in one host commit, and the folder's history reads (the log, a workflow's revisions, a champion read by its digest) serve none of its merges; a DELETE again commits nothing", { timeout: 180_000 }, async (t) => {
  const mark = `PURGE-MARK-${randomBytes(6).toString("hex")}`;
  const { api, data, store } = await serve(t, { learning: "on" });
  // The run: its input and its answer hold the marker (the faux model answers "On <the message>: done."), and so does its
  // owner's feedback, which its look-back merges as one line of corrections.md.
  const gone = (await startRun(api, "keeper", `What is ${mark}?`, { learning: true, instructions: "Answer the question." })).run_id;
  const done = await ended(api, gone);
  assert.ok(JSON.stringify(done.view).includes(mark), "its answer holds the marker");
  const graded = await api("PUT", `/runs/${gone}/grade`, { correct: false, label: `Never answer ${mark} again.` });
  assert.deepEqual([graded.status, graded.body.feedback], [200, "correction"], JSON.stringify(graded.body));
  const looked = await ended(api, gone);
  assert.equal(looked.view.learning?.state, "merged", JSON.stringify(looked.view.learning));
  // Another run's look-back merged its own feedback line after (its diff shows the purged run's line as context). A later
  // round of the purged run merged two workflows, its reason holding the marker; a later round of the other run revised
  // one of them, and no run the other ("solo", on main as the purged run left it). Promotion records name the purged
  // run's revisions by their digests and its merge.
  const kept = await started(api, "keeper", "What is two and two?");
  await ended(api, kept);
  const keptGraded = await api("PUT", `/runs/${kept}/grade`, { correct: false, label: "Answer in whole numbers." });
  assert.deepEqual([keptGraded.status, keptGraded.body.feedback], [200, "correction"], JSON.stringify(keptGraded.body));
  assert.equal((await ended(api, kept)).view.learning?.state, "merged");
  const path = "workflows/answer/workflow.json";
  const readmeOf = (name) => ({ path: `workflows/${name}/README.md`, text: `---\nname: ${name}\ndescription: Answers a question; use when asked\n---\n` });
  const v1 = JSON.stringify(answerFlow("Answer the question."));
  const v2 = JSON.stringify(answerFlow("Answer the question, in whole numbers."));
  const solo = JSON.stringify(answerFlow("Answer the question alone."));
  const merge = await learned(data, "keeper", (ws) => learningCommit(ws, { runId: gone, round: 7, reason: `It learned from ${mark}.`, files: [{ path, text: v1 }, readmeOf("answer"), { path: "workflows/solo/workflow.json", text: solo }, readmeOf("solo")] }));
  await learned(data, "keeper", (ws) => learningCommit(ws, { runId: kept, round: 7, reason: "It answers in whole numbers.", files: [{ path, text: v2 }] }));
  const digestOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  const [digest, soloDigest] = [digestOf(v1), digestOf(solo)];
  const record = (workflow, at) => ({ workflow, digest: at, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", commit: merge });
  await store.settings.put("learning.promotions.keeper", { v: 1, items: [record("answer", digest), record("solo", soloDigest)] });
  const championOf = (read, workflow) => read.promotions.serving.find((line) => line.workflow === workflow)?.champion;

  const repo = repoOf(data, "keeper");
  const diffs = join(repo, ".agentrun", "diffs");
  const ownDiffs = () => readdirSync(diffs).filter((name) => name.startsWith(`${gone}.`));
  const reads = async () => {
    const one = async (route) => {
      const res = await api("GET", `/agents/keeper/learning${route}`);
      assert.equal(res.status, 200, `${route}: ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const diff = await api("GET", `/runs/${kept}/learning/diff`);
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    return { view: await one(""), log: await one("/log?limit=200"), revisions: await one("/workflows/answer/revisions"), promotions: await one("/promotions"), diff: diff.body };
  };
  const before = await reads();
  assert.ok(ownDiffs().length >= 2, `its merges' diff files: ${ownDiffs()}`);
  assert.ok(git(repo, ["show", "main:corrections.md"]).includes(mark), "main holds its feedback line");
  assert.ok(before.log.items.some(({ by }) => by.run === gone) && JSON.stringify(before.log).includes(mark), "the log serves its merges and their reasons");
  assert.deepEqual(before.revisions.revisions.map(({ commit }) => commit).slice(0, 1), [merge], "its revision is the workflow's first");
  assert.deepEqual([championOf(before, "answer")?.commit, championOf(before, "solo")?.commit], [merge, merge], "each champion is read at its merge");
  assert.ok(JSON.stringify(before.diff).includes(mark), "the other run's diff shows its line as context");
  // A page of the log read before the purge, newest first: the other run's revision, then the purged run's merge.
  const first = (await api("GET", "/agents/keeper/learning/log?limit=2")).body;
  assert.deepEqual(first.items.map(({ by }) => by.run), [kept, gone]);
  const commits = Number(git(repo, ["rev-list", "--count", "main"]));

  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  // a. Its diff files are gone from the folder.
  assert.deepEqual(ownDiffs(), [], "its diff files leave the folder");
  // b. No file of main's tree holds the marker; another run's line stays; one commit, the host's.
  for (const file of git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n")) assert.ok(!git(repo, ["show", `main:${file}`]).includes(mark), `main's ${file} holds no marker`);
  assert.equal(git(repo, ["show", "main:corrections.md"]), "- Answer in whole numbers.");
  assert.equal(Number(git(repo, ["rev-list", "--count", "main"])), commits + 1, "one commit");
  assert.match(git(repo, ["log", "-1", "--format=%s", "main"]), /^host: /);
  // c. The history reads serve none of its merges (their commits, their reasons) and no marker: the log and the view's log
  //    leave them out, the workflow's revisions skip its merge, and its revision's digest reads as one no commit holds.
  const after = await reads();
  const said = JSON.stringify(after);
  assert.ok(!said.includes(mark), `no history read serves the marker: ${said}`);
  // Ids stay: a promotion record keeps the commit it names, and the other run's diff its parent's id (its base).
  const history = { view: after.view, log: after.log, revisions: after.revisions, champion: championOf(after, "answer"), solo: championOf(after, "solo") };
  for (const commit of [merge, looked.view.learning.merged]) {
    const naming = Object.entries(history).filter(([, read]) => JSON.stringify(read).includes(commit)).map(([key, read]) => `${key}: ${JSON.stringify(read)}`);
    assert.deepEqual(naming, [], `no history read names its merge ${commit}`);
  }
  assert.ok(after.log.items.some(({ by }) => by.run === kept), "another run's merge stays in the log");
  assert.deepEqual([after.revisions.revisions.length, after.revisions.total], [1, 1], "the workflow's one revision left is the other run's");
  assert.deepEqual(championOf(after, "answer"), { digest, commit: null, nodes: null, check: null }, "its digest reads as one no commit holds");
  // The page after the one read before the purge starts where that one ended: the other run's look-back.
  const next = (await api("GET", `/agents/keeper/learning/log?limit=2&cursor=${first.next_cursor}`)).body;
  assert.deepEqual([next.items.map(({ by }) => by.run), next.next_cursor], [[kept], null], "the next page skips no change");
  // A workflow it was the last to change reads so too, though main (the purge's commit) holds it as it left it.
  assert.equal(git(repo, ["show", "main:workflows/solo/workflow.json"]), solo);
  assert.deepEqual(championOf(after, "solo"), { digest: soloDigest, commit: null, nodes: null, check: null }, "nor at main after it");

  // A DELETE again re-runs the scrub (a run purged before it, its diff file left): the file goes, and nothing is committed.
  const stale = join(diffs, `${gone}.json`);
  await writeFile(stale, JSON.stringify({ v: 1, run: gone, merge: "0".repeat(40), parent: "0".repeat(40), files: [{ path: "corrections.md", status: "modified", patch: `@@ -0,0 +1 @@\n+- Never answer ${mark} again.\n` }] }));
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(existsSync(stale), false, "a DELETE again removes a diff file left");
  assert.equal(Number(git(repo, ["rev-list", "--count", "main"])), commits + 1, "and commits nothing");
});
