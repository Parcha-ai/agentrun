// DELETE /v2/runs/{run_id} (agent-delete.ts deleteRun): a run that has ended deleted whole, for an owner who must be able
// to delete what a run read. Its rows (journal and timeline, launch record, messages and commands, origin, learning),
// its folders, its settings and the grades its agent keeps of it go; so do the runs made from it (its audit's shadow run,
// the replay runs of its input). Its agent and the agent's other runs are kept. 204 when it is gone, 404 after; 409
// run_not_final while it or a run made from it has not ended, nothing deleted; a delete stopped part way is finished by
// the next DELETE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { keepRunDisk, runDiskKey, saveArchilSettings, storeAgentDisk } from "../dist/archil-settings.js";
import { shadowRunId } from "../dist/learn/audit.js";
import { gradesKey, putGrade } from "../dist/learn/promote.js";
import { runFolder, scratchFolder } from "../dist/workspace/paths.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { follow, serve, startRun, withEnv } from "./support.mjs";

/** An agent's folder name on a disk (archil-routes.ts: agentDirName). */
const agentDirOf = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;

const WINDOW = "from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z";

/** Every place in the store's file that holds `id` (a run's id): `table.column` of each row whose value has it, read from
 *  every table the schema lists. None once the run is deleted. */
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
    return [...new Set(found)];
  } finally {
    db.close();
  }
}

/** Run `runId`'s stored cost set straight in the store's file, so /usage and /stats have a figure to drop by. */
function costOf(data, runId, usd) {
  const db = new DatabaseSync(join(data, "store.sqlite"));
  try {
    db.prepare("UPDATE runs SET cost_usd = ? WHERE id = ?").run(usd, runId);
  } finally {
    db.close();
  }
}

/** Two completed runs of agent `id`, each graded (its grade kept as the grade route keeps one, with no feedback turn):
 *  their ids. */
async function twoRuns(api, store, id = "calc") {
  const first = await startRun(api, id, "What is six times seven?");
  await follow(api, first.run_id, ["completed"]);
  const second = await api("POST", `/agents/${id}/runs`, { input: { content: "And six times eight?" } });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  await follow(api, second.body.run_id, ["completed"]);
  for (const run of [first.run_id, second.body.run_id]) await putGrade(store.settings, id, { run, correct: true, source: "feedback", at: new Date().toISOString(), path: "agent" });
  return [first.run_id, second.body.run_id];
}

test("DELETE /runs/{id} deletes an ended run whole: every read of it 404, in no listing, /usage and /stats drop by its cost, no table of the store names it, its folders and its grade gone; its agent's other run kept; a second DELETE 404", { timeout: 180_000 }, async (t) => {
  const { api, data, store } = await serve(t);
  const [gone, kept] = await twoRuns(api, store);
  costOf(data, gone, 0.25);
  const usage = async () => (await api("GET", `/usage?${WINDOW}`)).body.total_usd;
  const stats = async () => (await api("GET", "/stats")).body.cost.usd;
  const [usageBefore, statsBefore] = [await usage(), await stats()];
  assert.ok(mentions(data, gone).includes("runs.id"), "the run is in the store before");
  assert.ok(existsSync(dirname(runFolder(data, "calc", gone))), "and has a folder");

  const deleted = await api("DELETE", `/runs/${gone}`);
  assert.equal(deleted.status, 204, `DELETE /runs/{id}: ${deleted.status} ${JSON.stringify(deleted.body)}`);

  for (const path of [`/runs/${gone}`, `/runs/${gone}/timeline`, `/runs/${gone}/graph`, `/runs/${gone}/trace`, `/runs/${gone}/files`]) {
    assert.equal((await api("GET", path)).status, 404, `GET ${path} is 404`);
  }
  assert.ok(!(await api("GET", "/runs")).body.runs.some((run) => run.run_id === gone), "not in GET /runs");
  assert.deepEqual((await api("GET", "/agents/calc/runs")).body.runs.map((run) => run.run_id), [kept], "its agent lists its other run alone");
  assert.equal(Math.round((usageBefore - (await usage())) * 1e6) / 1e6, 0.25, "/usage drops by its cost");
  assert.equal(Math.round((statsBefore - (await stats())) * 1e6) / 1e6, 0.25, "/stats drops by its cost");
  assert.deepEqual(mentions(data, gone), [], "no table of the store names the run");
  assert.ok(!existsSync(dirname(runFolder(data, "calc", gone))), "its folder is gone");
  assert.ok(!existsSync(scratchFolder(data, "calc", gone)), "and its scratch folder");
  assert.deepEqual(((await store.settings.get(gradesKey("calc")))?.items ?? []).map((grade) => grade.run), [kept], "its grade is dropped, its sibling's kept");

  // Its agent and its other run are as they were.
  assert.equal((await api("GET", "/agents/calc")).status, 200);
  const other = await api("GET", `/runs/${kept}`);
  assert.deepEqual([other.status, other.body.status], [200, "completed"]);
  assert.ok((await api("GET", `/runs/${kept}/timeline`)).body.rows.length > 0, "its sibling's timeline is kept");
  assert.ok(existsSync(dirname(runFolder(data, "calc", kept))), "and its folder");

  const again = await api("DELETE", `/runs/${gone}`);
  assert.deepEqual([again.status, again.body.error?.code], [404, "not_found"]);
  assert.deepEqual([(await api("DELETE", "/runs/no-such-run")).status], [404]);
});

test("a run that has not ended is 409 run_not_final, nothing deleted; once cancelled, the DELETE deletes it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t);
  const live = await startRun(api, "slow", "Take your time.");
  await follow(api, live.run_id, ["working"]);
  const before = mentions(data, live.run_id);

  const refused = await api("DELETE", `/runs/${live.run_id}`);
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_not_final"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /cancel it first/);
  assert.deepEqual(refused.body.error.details?.runs, [live.run_id]);
  assert.equal((await api("GET", `/runs/${live.run_id}`)).status, 200, "the run is kept");
  assert.deepEqual(mentions(data, live.run_id), before, "nothing of it deleted");
  assert.ok(existsSync(dirname(runFolder(data, "slow", live.run_id))), "nor its folder");

  assert.equal((await api("POST", `/runs/${live.run_id}/cancel`)).status, 202);
  await follow(api, live.run_id, ["cancelled"]);
  assert.equal((await api("DELETE", `/runs/${live.run_id}`)).status, 204);
  assert.equal((await api("GET", `/runs/${live.run_id}`)).status, 404);
  assert.deepEqual(mentions(data, live.run_id), []);
});

/** A run of agent `agentId` written to the store by the test (a replay of another's input, an audit's shadow), claimed at
 *  once under the test's own claim (so the runner beside never takes it), then ended unless `state` is "running": the
 *  claim. */
async function storedRun(store, agentId, id, state, launch = { input: { content: "Again." } }) {
  const agent = await store.agents.get(agentId);
  await store.runs.create({ id, agentId, revisionId: agent.currentRevision }, { body: launch });
  const claim = await store.claim(id, "runner-test", { leaseMs: 120_000 });
  assert.ok(claim, `run ${id} is claimed`);
  if (state !== "running") await store.runs.update(claim, { state });
  return claim;
}

test("the runs made from a run go with it (its audit's shadow run, a replay of its input); one not ended is 409 run_not_final naming it, nothing deleted", { timeout: 120_000 }, async (t) => {
  const { api, data, store } = await serve(t);
  const [graded, other] = await twoRuns(api, store);
  // A replay of another run's input: kept when that run is deleted.
  await storedRun(store, "calc", "replay-of-other", "ended", { input: { content: "And six times eight?" }, replay: { of: other } });
  // Held under this test's claim, so the runner beside never takes it: not ended until the test ends it.
  const claim = await storedRun(store, "calc", "replay-1", "running", { input: { content: "What is six times seven?" }, replay: { of: graded } });
  await storedRun(store, "calc", shadowRunId(graded), "ended");

  const refused = await api("DELETE", `/runs/${graded}`);
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_not_final"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, ["replay-1"], "the replay not ended is named");
  for (const id of [graded, "replay-1", shadowRunId(graded)]) assert.ok(await store.runs.get(id), `run ${id} is kept`);

  await store.runs.update(claim, { state: "stopped", outcome: "cancelled" });
  assert.equal((await api("DELETE", `/runs/${graded}`)).status, 204);
  for (const id of [graded, "replay-1", shadowRunId(graded)]) {
    assert.equal(await store.runs.get(id), undefined, `run ${id} is gone`);
    assert.deepEqual(mentions(data, id), [], `no table names ${id}`);
  }
  for (const id of [other, "replay-of-other"]) assert.ok(await store.runs.get(id), `run ${id}, made from another run, is kept`);
});

for (const step of ["run_made_from_gone", "run_forgotten"]) {
  test(`a run's DELETE stopped at ${step.replaceAll("_", " ")} keeps the run; the next DELETE finishes it`, { timeout: 120_000 }, async (t) => {
    // It stops at the run's own step (a run made from it is forgotten by the same step, before it).
    const crash = { done: false, run: undefined };
    const { api, data, store } = await serve(t, {
      agentDeleteAt: (at, id) => {
        if (at !== step || crash.done || (step === "run_forgotten" && id !== crash.run)) return;
        crash.done = true;
        throw new Error(`stopped ${at}`);
      },
    });
    const [gone] = await twoRuns(api, store);
    crash.run = gone;
    await storedRun(store, "calc", shadowRunId(gone), "ended");
    const stopped = await api("DELETE", `/runs/${gone}`);
    assert.deepEqual([stopped.status, stopped.body.error?.code], [500, "internal"], JSON.stringify(stopped.body));
    assert.ok(crash.done, "it stopped where it was told to");
    assert.equal((await api("GET", `/runs/${gone}`)).status, 200, "the run is still there");
    assert.equal(await store.runs.get(shadowRunId(gone)), undefined, "the run made from it went first");

    assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
    assert.equal((await api("GET", `/runs/${gone}`)).status, 404);
    assert.deepEqual(mentions(data, gone), [], "no table names it");
    assert.ok(!existsSync(dirname(runFolder(data, "calc", gone))), "nor its folder");
  });
}

test("a run on its agent's own Archil disk, deleted alone: its folder there is deleted, the disk, the agent's folder and its sibling's folder kept; while Archil refuses, 503 with the run kept, and the next DELETE finishes", { timeout: 120_000 }, async (t) => {
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
  assert.equal((await api("GET", `/runs/${gone}`)).status, 200, "the run is kept");
  assert.ok(disk.files.has(its[0]), "and its file on the disk");

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

test("an API-only server deletes a run: a run route", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { apiOnly: true });
  const done = await api("POST", "/runs", { external: { source: "host", kind: "expert", id: "9", version: 1 }, definition: { name: "Expert 9", description: "Answers.", instructions: "Answer.", skills: [], tools: [] }, input: { content: "What is six times seven?" } });
  assert.equal(done.status, 202, JSON.stringify(done.body));
  await follow(api, done.body.run_id, ["completed"]);
  assert.equal((await api("DELETE", `/runs/${done.body.run_id}`)).status, 204);
  assert.equal((await api("GET", `/runs/${done.body.run_id}`)).status, 404);
});
