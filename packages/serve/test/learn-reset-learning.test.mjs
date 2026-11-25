// DELETE /v2/agents/{agent_id}/learning: an agent's learning reset, the agent kept (learning-reset.ts). Everything it
// learned goes (its learning folder whole, its promotions and grades), and from then on nothing learned is served: the
// next run takes the agent path. The agent, its runs and what they kept stay: the run list, the run count, GET /stats and
// GET /usage read the same before and after. Its learning-only work in flight (a check's replay, an audit's shadow) is
// cancelled and waited for; a run of its own still going, or learning work not ended in time, is 409 learning_busy and
// nothing is deleted. 204 when done, again on a second call and for an agent that never learned. Both profiles route it,
// with the token as the other learning writes take it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { keepRunDisk, saveArchilSettings, storeAgentDisk } from "../dist/archil-settings.js";
import { agentFolderOf } from "../dist/files.js";
import { deleteLearning, LearningInFlight } from "../dist/learn/delete.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { lastOwnRuns } from "../dist/learn/compile.js";
import { gradesKey, promotionsKey, promotionsOf, resetLedgerKey } from "../dist/learn/promote.js";
import { getAgent } from "../dist/agents-store.js";
import { SdkRuns } from "../dist/sdk/runs.js";
import { learningFolderOf, secretsShown, seedOf, withAgentRepo } from "../dist/learning.js";
import { notAuditableOf } from "../dist/runner/audit.js";
import { askReplay } from "../dist/runner/promotion.js";
import { pastRunsOverStore } from "../dist/store-reads/learning.js";
import { agentLoopOverStore } from "../dist/store-reads/loop.js";
import { resetLearning } from "../dist/learning-reset.js";
import { readLaunchBody } from "../dist/run-launch.js";
import { createAdapterLoop } from "../dist/runner/adapter-loop.js";
import { adapterRunSpecFromLaunch } from "../dist/runner/adapter-run-spec.js";
import { sendCommand } from "../dist/runner/commands.js";
import { learningEndOfRun } from "../dist/runner/learning-end.js";
import { startRunner } from "../dist/runner/runner.js";
import { openSqliteStore } from "../dist/store/index.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { git, resnap } from "./learn-support.mjs";
import { raw } from "./store-target.mjs";
import { agent, cookieOf, follow, serve, withEnv } from "./support.mjs";

after(closeOpenSessions);

const { ROUTES } = await import("../dist/server.js");
const { API_ONLY_ROUTES } = await import("../dist/api-only.js");

/** The faux model at $100 per million output tokens: a served workflow's model node and the agent's turns both cost. */
const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;
/** A learned workflow on the agent's own input (`content`): one model node answers a number (learn-audit-api.test.mjs). */
const FLOW = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};
const TEXT = JSON.stringify(FLOW);
const DIGEST = createHash("sha256").update(TEXT).digest("hex").slice(0, 16);
const CORRECTION = "- Six times seven is 42.\n";
const ASK = { content: "What is 1 plus 41?" };
const FINAL = ["ended", "stopped", "failed"];

const learningDir = (data, id) => join(agentFolderOf(data, id), "learning");
/** The agent's folder's name on a disk (workspace/paths.ts agentDirName). */
const agentDirOf = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;

/** Agent `id`'s learning, as runs and a check leave it: corrections.md and the `answer` workflow on its folder's main,
 *  the workflow promoted by its check, and a grade. Answers main's commit. */
async function learned(store, data, id) {
  await seedOf(data, id);
  const repo = learningDir(data, id);
  const files = { "corrections.md": CORRECTION, "workflows/answer/workflow.json": TEXT, "workflows/answer/README.md": "---\nname: answer\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n" };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
  const main = git(repo, ["rev-parse", "main"]);
  await store.settings.put(promotionsKey(id), { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: main }] });
  await store.settings.put(gradesKey(id), { r1: { correct: true } });
  return main;
}

/** The agent's learning records still in the store. */
async function recordsOf(store, id) {
  const left = [];
  for (const key of [promotionsKey(id), gradesKey(id)]) if ((await store.settings.get(key)) !== undefined) left.push(key);
  return left;
}

/** Every run of agent `id` final (its learning end, an audit's shadow among them). */
async function quiet(store, id, deadlineMs = 90_000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const going = (await store.runs.every(id)).filter((run) => !FINAL.includes(run.state));
    if (!going.length) return;
    assert.ok(Date.now() < end, `runs still going: ${JSON.stringify(going.map((run) => [run.id, run.state]))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A run of agent `id` the store holds, queued, its launch `body`: a stand-in for a run the server started. */
async function storedRun(store, id, runId, body) {
  const revisionId = (await store.agents.get(id)).currentRevision;
  await store.runs.create({ id: runId, agentId: id, revisionId }, { body });
  return runId;
}

/** Run `runId` ended `state` as a runner ends it: claimed, then its end written (these servers have no runner). */
async function endAsRunner(store, runId, state) {
  const claim = await store.claim(runId, "runner-test", { leaseMs: 60_000 });
  assert.ok(claim, `${runId} claimed`);
  await store.runs.update(claim, { state });
}

/** The setting that holds agent `id`'s reset watermark (learn/promote.ts resetAtKey), beside its reset ledger. */
const resetAtKey = (id) => `learning.reset-at.${id}`;

/** A read without the time it was read at. */
const untimed = ({ to: _to, ...rest }) => rest;

test("both profiles route DELETE /agents/{id}/learning, and its document is the operation's", () => {
  const route = ROUTES.find((one) => one.name === "deleteAgentLearning");
  assert.ok(route, "a route of the server");
  assert.equal(route.method, "DELETE");
  assert.match("/agents/a1/learning", route.pattern);
  assert.doesNotMatch("/agents/a1/learning/cost", route.pattern);
  assert.ok(API_ONLY_ROUTES.has("deleteAgentLearning"), "served in the API-only profile");
});

test("a reset after a learned workflow served: nothing learned is left or served (the next run takes the agent path), and the agent, its runs, the run count, /stats and /usage are as they were", { timeout: 300_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data, store } = await serve(t, { learning: "on", faux: PRICED, runnerTiming: { leaseMs: 600_000, renewEveryMs: 10_000 } });
  assert.equal((await api("POST", "/agents", agent("source", { learning: { audit_every: 1_000 } }))).status, 201);
  await learned(store, data, "source");
  const run = async () => {
    const started = await api("POST", "/agents/source/runs", { input: ASK, learning: "use" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed", "escalated"], { deadlineMs: 90_000 });
    await quiet(store, "source");
    return started.body.run_id;
  };
  const served = await run();
  assert.equal((await store.runs.get(served)).metrics?.path, "workflow", "the learned workflow served it");
  assert.match((await api("GET", "/agents/source/learning")).body.corrections, /42/);

  const reads = async () => {
    const list = (await api("GET", "/agents/source/runs")).body;
    const all = (await api("GET", "/runs")).body;
    const view = (await api("GET", `/runs/${served}`)).body;
    const files = (await api("GET", `/runs/${served}/files`)).body;
    return {
      list: list.runs.map((row) => [row.run_id, row.status]), all: all.runs.map((row) => [row.run_id, row.status]),
      count: (await store.runs.every("source")).length,
      // `to`: the window's end, the time of the read.
      stats: untimed((await api("GET", "/stats")).body), usage: untimed((await api("GET", "/usage")).body),
      view: { status: view.status, path: view.path, cost: view.cost, answer: view.result?.final_answer }, files,
    };
  };
  const before = await reads();

  const reset = await api("DELETE", "/agents/source/learning");
  assert.equal(reset.status, 204, JSON.stringify(reset.body));
  const view = (await api("GET", "/agents/source/learning")).body;
  assert.deepEqual([view.main, view.corrections, view.workflows], [null, "", []], `nothing learned is left: ${JSON.stringify(view)}`);
  assert.deepEqual(await recordsOf(store, "source"), [], "no promotion or grade record");
  assert.ok(!existsSync(join(learningDir(data, "source"), "corrections.md")), "the folder's files gone");
  assert.equal((await api("GET", "/agents/source")).status, 200, "the agent is kept");
  assert.deepEqual(await reads(), before, "its runs, their count, the stats and the usage are as they were");

  const next = await run();
  const row = await store.runs.get(next);
  assert.equal(row.metrics?.path, "agent", `nothing learned is served: ${JSON.stringify(row.metrics)}`);
  const launch = (await store.runs.launch(next)).body;
  assert.ok(!launch.learning?.workflows?.length, `no workflow started with: ${JSON.stringify(launch.learning)}`);
  assert.doesNotMatch(launch.learning?.section ?? "", /42/, "no correction of before");
});

test("a served run's cost keeps its share of its revision's paid check after the reset (the reset ledger), as do the bill's booked total and what no run carries; an agent delete's learning step removes the ledger", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("paid", { learning: true }))).status, 201);
  const revisionId = (await store.agents.get("paid")).currentRevision;
  const LEARNS = { input: ASK, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } };
  // The check: two replays of `answer` at its digest, $0.30 each; then two runs it served at $0.10, K = 2.
  const ended = async (id, cost, metrics, body = LEARNS) => {
    await store.runs.create({ id, agentId: "paid", revisionId }, { body });
    const claim = await store.claim(id, "runner-cost", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: cost, metrics });
  };
  for (const id of ["replay-a", "replay-b"]) await ended(id, 0.3, { path: "replay", workflow: "answer", workflow_digest: DIGEST, replay: { of: "run-of-before", outcome: "answered" } }, { ...LEARNS, replay: { of: "run-of-before", workflow: "answer", digest: DIGEST } });
  for (const id of ["served-a", "served-b"]) await ended(id, 0.1, { path: "workflow", workflow: "answer", workflow_digest: DIGEST });
  await store.settings.put(promotionsKey("paid"), { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 2, agreed: 2, alone: 2, of: [] } }] });

  const costs = async () => ({
    runs: Object.fromEntries(await Promise.all(["served-a", "served-b", "replay-a"].map(async (id) => [id, (await api("GET", `/runs/${id}`)).body.cost]))),
    bill: await api("GET", "/agents/paid/learning/cost").then(({ body }) => [body.bill?.booked_usd, body.bill?.unattributed_usd]),
  });
  const before = await costs();
  assert.equal(before.runs["served-a"].learning_usd, 0.3, `its share of the $0.60 check over K = 2: ${JSON.stringify(before)}`);
  const reset = await api("DELETE", "/agents/paid/learning");
  assert.equal(reset.status, 204, JSON.stringify(reset.body));
  assert.deepEqual(await recordsOf(store, "paid"), [], "the records are gone");
  assert.deepEqual(await costs(), before, "each run's cost and the bill read as before");
  assert.deepEqual((await store.settings.get(resetLedgerKey("paid")))?.items, [{ workflow: "answer", digest: DIGEST, k: 2 }], "the revision's workflow, digest and K alone");
  // A second reset with no records keeps it as it is.
  assert.equal((await api("DELETE", "/agents/paid/learning")).status, 204);
  assert.deepEqual(await costs(), before);
  // The agent learns the same revision again, now at K = 4, and serves two more runs: the ledger reads the records' K,
  // each of the four served runs carries $0.15; the next reset keeps K = 4, so each still does.
  for (const id of ["served-c", "served-d"]) await ended(id, 0.1, { path: "workflow", workflow: "answer", workflow_digest: DIGEST });
  await store.settings.put(promotionsKey("paid"), { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 4, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 2, agreed: 2, alone: 2, of: [] } }] });
  const four = async () => Object.fromEntries(await Promise.all(["served-a", "served-b", "served-c", "served-d"].map(async (id) => [id, (await api("GET", `/runs/${id}`)).body.cost.learning_usd])));
  const relearned = { shares: await four(), bill: (await costs()).bill };
  assert.deepEqual(relearned.shares, { "served-a": 0.15, "served-b": 0.15, "served-c": 0.15, "served-d": 0.15 }, "$0.60 over K = 4");
  assert.equal((await api("DELETE", "/agents/paid/learning")).status, 204);
  assert.deepEqual({ shares: await four(), bill: (await costs()).bill }, relearned, "the second reset keeps the K the records had");
  assert.deepEqual((await store.settings.get(resetLedgerKey("paid")))?.items, [{ workflow: "answer", digest: DIGEST, k: 4 }]);
  assert.equal(typeof (await store.settings.get(resetAtKey("paid")))?.at, "number", "the reset's watermark is kept beside the ledger");
  await deleteLearning(store, "paid", learningFolderOf(data, "paid"));
  assert.equal(await store.settings.get(resetLedgerKey("paid")), undefined, "the agent's delete removes it");
  assert.equal(await store.settings.get(resetAtKey("paid")), undefined, "and the watermark with it: none is left with no agent");
});

/** Run `runId`'s launch record naming disk `diskId` as the caller's, and the run's disk with it, as POST /runs with
 *  `archil_disk` records them (run-launch.ts: archil_disk { disk_id, kind: "launch" }; runs.disk), written into the
 *  store's file (agent-delete.test.mjs). */
async function launchOnDisk(data, runId, diskId) {
  const db = await raw(join(data, "store.sqlite"), { timeout: 10_000 });
  try {
    const changed = await db.run("UPDATE run_launch SET body = json_set(body, '$.archil_disk', json(?)) WHERE run_id = ?", JSON.stringify({ disk_id: diskId, kind: "launch" }), runId);
    assert.equal(changed.changes, 1, "the run's launch record names the disk");
    assert.equal((await db.run("UPDATE runs SET disk = ? WHERE id = ?", diskId, runId)).changes, 1, "and the run its disk");
  } finally {
    await db.close();
  }
}

test("Mode 2: the agent's learning folder on every Archil disk its runs used (its own disk, and a disk a run's launch named) is deleted with the server's own; its runs' folders there and what is not the agent's stay; Archil off is 503 with the records kept, and the next call finishes", { timeout: 120_000 }, async (t) => {
  const own = "dsk-0a0e1ea4e0000001";
  const customer = "dsk-c0570e4e00000002";
  const control = archilControlFetch({ region: "aws-us-east-1", strict: true, disks: [{ id: own, name: "its-own-disk" }, { id: customer, name: "a-customers-disk" }] });
  withEnv(t, { ARCHIL_API_KEY: "fake-test-key" }, ["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  // Each disk's file API, as the server reaches it (archil-disk.ts), by its id.
  const disks = new Map([own, customer].map((id) => [id, Object.assign(new FakeArchilDisk(), { id })]));
  const reached = new Set();
  const { api, data, store } = await serve(t, { learning: "on", runner: false, archilControl: { baseUrl: control.baseUrl, fetch: control.fetch, makeDisk: (options) => (reached.add(options.disk), disks.get(options.disk)) } });
  assert.equal((await api("POST", "/agents", agent("spread", { learning: true }))).status, 201);
  await learned(store, data, "spread");
  // Two finished runs: one on the agent's own disk (kept for it as a run in Archil mode keeps it), one on the caller's.
  const revisionId = (await store.agents.get("spread")).currentRevision;
  for (const runId of ["on-own", "on-customer"]) {
    await store.runs.create({ id: runId, agentId: "spread", revisionId }, { body: { input: ASK, title: "t", place: { mode: "runner" } } });
    await endAsRunner(store, runId, "ended");
  }
  await storeAgentDisk(store, "spread", { diskId: own });
  await keepRunDisk(store, "on-own", own);
  await launchOnDisk(data, "on-customer", customer);
  // What Mode 2 runs left on each disk: the agent's learning folder (learningKey) and each run's folder (runKey), beside
  // what is not the agent's.
  const dir = `agents/${agentDirOf("spread")}`;
  // With what a learning exec spilled beside it (archil.ts spillFolderOf: "<root>.exec-out"), a write's input text left
  // there by a failed cleanup.
  const learning = [`${dir}/learning/corrections.md`, `${dir}/learning/workflows/answer/workflow.json`, `${dir}/learning/.git/HEAD`, `${dir}/learning/.agentrun/snapshot.json`, `${dir}/learning.exec-out/in-1/corrections.md`];
  const kept = { [own]: [`${dir}/runs/on-own/work/notes.md`, `${dir}/runs/on-own/exec-out/spill.txt`, `agents/${agentDirOf("another")}/learning/corrections.md`, `agents/${agentDirOf("another")}/learning.exec-out/in-1/corrections.md`], [customer]: [`${dir}/runs/on-customer/work/notes.md`, "shared/customers.csv"] };
  for (const [id, disk] of disks) for (const key of [...learning, ...kept[id]]) await disk.putObject(key, Buffer.from("bytes"));
  const learningOn = (id) => [...disks.get(id).files.keys(), ...disks.get(id).dirs].filter((key) => [`${dir}/learning`, `${dir}/learning.exec-out`].some((root) => key === root || key.startsWith(`${root}/`)));

  // Archil off (its settings not saved yet): the disks can't be reached, so nothing is deleted: 503, for the next call.
  const off = await api("DELETE", "/agents/spread/learning");
  assert.deepEqual([off.status, off.body.error?.code, off.body.error?.retryable], [503, "unavailable", true], JSON.stringify(off.body));
  assert.match(off.body.error.message, /Archil is off/);
  assert.deepEqual(await recordsOf(store, "spread"), [promotionsKey("spread"), gradesKey("spread")], "the records are kept");
  assert.ok(existsSync(join(learningDir(data, "spread"), "corrections.md")), "and the server's own folder");
  for (const id of [own, customer]) assert.equal(learningOn(id).length > 0, true, `and the folder on ${id}`);
  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });

  const reset = await api("DELETE", "/agents/spread/learning");
  assert.equal(reset.status, 204, JSON.stringify(reset.body));
  for (const id of [own, customer]) {
    assert.deepEqual(learningOn(id), [], `no learning of the agent is left on ${id}`);
    for (const key of kept[id]) assert.ok(disks.get(id).files.has(key), `${key} on ${id} is kept`);
  }
  assert.equal(existsSync(join(learningDir(data, "spread"), "corrections.md")), false, "the server's own folder is emptied too");
  assert.deepEqual(await recordsOf(store, "spread"), []);
  assert.ok(control.disks.has(own) && control.disks.has(customer), "both disks are kept");
  assert.deepEqual([...reached].sort(), [own, customer].sort(), "only the disks its runs used were reached");
  assert.equal((await api("DELETE", "/agents/spread/learning")).status, 204, "and again");
});

test("Mode 2, the last run naming a caller's disk purged (DELETE /runs/{id}, its launch record gone, its tombstone keeping the disk): the purge takes the agent's learning folder on that disk with the run's own (it may hold the run's diff and correction), and the reset after it leaves no learning of the agent there and no other learning setting", { timeout: 120_000 }, async (t) => {
  const customer = "dsk-c0570e4e00000003";
  const control = archilControlFetch({ region: "aws-us-east-1", strict: true, disks: [{ id: customer, name: "a-customers-disk" }] });
  withEnv(t, { ARCHIL_API_KEY: "fake-test-key" }, ["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  const disk = Object.assign(new FakeArchilDisk(), { id: customer });
  const { api, data, store } = await serve(t, { learning: "on", runner: false, archilControl: { baseUrl: control.baseUrl, fetch: control.fetch, makeDisk: () => disk } });
  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  assert.equal((await api("POST", "/agents", agent("gone-run", { learning: true }))).status, 201);
  await learned(store, data, "gone-run");
  const revisionId = (await store.agents.get("gone-run")).currentRevision;
  await store.runs.create({ id: "on-customer", agentId: "gone-run", revisionId }, { body: { input: ASK, title: "t", place: { mode: "runner" } } });
  await endAsRunner(store, "on-customer", "ended");
  await launchOnDisk(data, "on-customer", customer);
  const dir = `agents/${agentDirOf("gone-run")}`;
  for (const key of [`${dir}/learning/corrections.md`, `${dir}/learning/.git/HEAD`, `${dir}/runs/on-customer/work/notes.md`, "shared/customers.csv"]) await disk.putObject(key, Buffer.from("bytes"));
  const learningOn = () => [...disk.files.keys(), ...disk.dirs].filter((key) => key === `${dir}/learning` || key.startsWith(`${dir}/learning/`));

  const purged = await api("DELETE", "/runs/on-customer");
  assert.equal(purged.status, 204, JSON.stringify(purged.body));
  assert.equal(disk.files.has(`${dir}/runs/on-customer/work/notes.md`), false, "the purge took the run's folder there");
  assert.deepEqual(learningOn(), [], "and the agent's learning folder there");

  const reset = await api("DELETE", "/agents/gone-run/learning");
  assert.equal(reset.status, 204, JSON.stringify(reset.body));
  assert.deepEqual(learningOn(), [], "no learning of the agent is left on the caller's disk");
  assert.ok(disk.files.has("shared/customers.csv"), "what is not the agent's stays");
  assert.deepEqual((await store.settings.all({ prefix: "learning." })).map((row) => row.key).filter((key) => key.includes("gone-run") && !key.startsWith("learning.reset")), [], "no other learning setting of the agent is left");
});

test("a grade of a run served before the reset is kept, and writes no audit row: a promotion of the same digest after the reset is never held by the old runs' grades", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("regraded", { learning: true }))).status, 201);
  await learned(store, data, "regraded");
  const revisionId = (await store.agents.get("regraded")).currentRevision;
  const before = ["served-1", "served-2", "served-3"];
  for (const id of before) {
    await store.runs.create({ id, agentId: "regraded", revisionId }, { body: { input: ASK, title: "t", place: { mode: "runner" } } });
    const claim = await store.claim(id, "runner-grade", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: 0.1, metrics: { path: "workflow", workflow: "answer", workflow_digest: DIGEST } });
  }
  assert.equal((await api("DELETE", "/agents/regraded/learning")).status, 204);
  // The agent learns the same workflow again after the reset, and its check promotes the same digest.
  const promoted = { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 2, agreed: 2, alone: 2, of: [] } };
  await store.settings.put(promotionsKey("regraded"), { v: 1, items: [promoted] });
  for (const id of before) {
    const graded = await api("PUT", `/runs/${id}/grade`, { correct: false });
    assert.deepEqual([graded.status, graded.body.correct], [200, false], JSON.stringify(graded.body));
  }
  assert.deepEqual((await promotionsOf(store.settings, "regraded")).map((one) => [one.decided, one.digest]), [["promote", DIGEST]], "the promotion after the reset stands: no hold from a run before it");
  const audits = await api("GET", "/agents/regraded/learning/audits");
  assert.deepEqual([audits.status, audits.body.audits], [200, []], "no audit row of a run before the reset");
});

test("a console session that is no owner's (accounts off on a server bound off loopback) is 403 forbidden, nothing reset", { timeout: 120_000 }, async (t) => {
  const host = Object.values(networkInterfaces()).flat().find((nic) => nic && nic.family === "IPv4" && !nic.internal)?.address;
  if (!host) return t.skip("this machine has no address off loopback");
  const server = await serve(t, { host, learning: "on", runner: false });
  assert.equal((await server.api("POST", "/agents", agent("not-yours", { learning: true }))).status, 201);
  await learned(server.store, server.data, "not-yours");
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
  const refused = await at("DELETE", "/v2/agents/not-yours/learning", { cookie: cookieOf(link), origin: `http://${host}:${server.port}`, "content-type": "application/json" });
  assert.deepEqual([refused.status, refused.json?.error?.code], [403, "forbidden"], refused.text);
  assert.ok(existsSync(join(learningDir(server.data, "not-yours"), "corrections.md")), "the learning folder is kept");
  assert.equal((await promotionsOf(server.store.settings, "not-yours")).length, 1, "and its promotions");
  assert.equal(await server.store.settings.get(resetAtKey("not-yours")), undefined, "no watermark set");
});

test("a grade of a run on a named disk is kept, and writes no audit row: its answers never hold the agent's promotion nor reach its compile", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("customer-graded", { learning: true }))).status, 201);
  await learned(store, data, "customer-graded");
  const revisionId = (await store.agents.get("customer-graded")).currentRevision;
  const promoted = { workflow: "answer", digest: DIGEST, at: new Date(Date.now() - 60_000).toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 2, agreed: 2, alone: 2, of: [] } };
  await store.settings.put(promotionsKey("customer-graded"), { v: 1, items: [promoted] });
  const named = ["named-1", "named-2", "named-3"];
  for (const id of named) {
    await store.runs.create({ id, agentId: "customer-graded", revisionId }, { body: { input: ASK, title: "t", place: { mode: "runner" } } });
    const claim = await store.claim(id, "runner-grade", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: 0.1, metrics: { path: "workflow", workflow: "answer", workflow_digest: DIGEST } });
    await launchOnDisk(data, id, "customer-disk");
  }
  for (const id of named) {
    const graded = await api("PUT", `/runs/${id}/grade`, { correct: false });
    assert.deepEqual([graded.status, graded.body.correct], [200, false], JSON.stringify(graded.body));
  }
  assert.deepEqual((await promotionsOf(store.settings, "customer-graded")).map((one) => [one.decided, one.digest]), [["promote", DIGEST]], "the promotion stands: no hold, no disagreement copied from a named disk's run");
  const audits = await api("GET", "/agents/customer-graded/learning/audits");
  assert.deepEqual([audits.status, audits.body.audits], [200, []], "no audit row of a named disk's run");
});

/** An SDK agent of its own, with a draft of `status` landed on its learning folder (sdk-shadow-check.test.mjs). */
const SDK_TOOL = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
const SDK_FLOW = { name: "status", description: "Read release status.", workflow: { v: 2, name: "status", schemas: { Input: { type: "object", properties: { release: { type: "string" } }, required: ["release"] }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "call", label: "read", via: "tool", tool: SDK_TOOL.name, args: {}, out: "Answer", as: "answer", deadline_s: 5 } } };
const SDK_START = { runtime: "eve", input: '{"release":"r1"}', instructions: "Report readiness.", workflow_tools: [SDK_TOOL] };
async function sdkAgent(t, id) {
  const server = await serve(t, { learning: "on", runner: false });
  assert.equal((await server.api("POST", "/agents", { definition: { id, name: id, instructions: "Report readiness.", sdk: { runtime: "eve" }, learning: { compile_after: 200 }, tools: [] } })).status, 201);
  await landWorkflows(server.data, id, [SDK_FLOW]);
  const entry = await getAgent(server.store, id);
  const sdk = new SdkRuns(server.store, server.data, "s".repeat(32));
  /** An SDK start of the agent through SdkRuns.start, as POST /agents/{id}/sdk-runs makes it, `afterSeed` called once its
   *  learning seed is read and `check` as its compile model's check, its last step before its queue entry. */
  const start = (afterSeed, check = async () => {}) => sdk.start(entry, SDK_START, {
    learning: "on",
    shown: () => secretsShown([]),
    pinnedOf: async (one) => ({ revision: one.revision, version: one.version }),
    seedFor: async (agentId) => {
      const seed = await seedOf(server.data, agentId);
      await afterSeed(agentId);
      return { seed };
    },
  }, undefined, { model: "test-model", check }, "http://console.test");
  const admitted = async () => [(await server.store.runs.list({ agentId: id })).length, (await promotionsOf(server.store.settings, id)).length];
  return { ...server, start, admitted };
}

test("an SDK start whose learning seed was read before a reset is refused, to start again: no check of a deleted draft reserved, no run made", async (t) => {
  const server = await sdkAgent(t, "sdk-reset");
  await assert.rejects(server.start(async (agentId) => assert.equal((await server.api("DELETE", `/agents/${agentId}/learning`)).status, 204)), (error) => {
    assert.equal(error.code, "unavailable", String(error));
    assert.match(error.message, /reset/);
    return true;
  });
  assert.deepEqual(await server.admitted(), [0, 0], "no run, and no promotion record of the deleted draft");
});

test("an SDK start is admitted in its agent's learning queue (the reset's): its check is reserved and its run made only once the queue is free", async (t) => {
  const server = await sdkAgent(t, "sdk-queued");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let held;
  let checked;
  const entering = new Promise((resolve) => (checked = resolve));
  let settled = false;
  const started = server.start(async (agentId) => void (held = withAgentRepo(server.data, agentId, () => gate)), async () => checked());
  void started.finally(() => (settled = true)).catch(() => {});
  // Its compile model's check is the start's last step before its queue entry, which follows it with no await between:
  // once the check returned and the microtasks ran (setImmediate), the start waits in the queue behind the held work.
  await entering;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await server.admitted(), [0, 0], "nothing admitted while the queue is held");
  assert.equal(settled, false, "the start is still waiting in the queue");
  release();
  await held;
  const receipt = await started;
  assert.equal(receipt.learning.check?.workflow.name, "status", "then admitted, the draft's check reserved");
  assert.deepEqual(await server.admitted(), [1, 1]);
});

test("an agent that never learned: 204, and 204 again; an unknown agent is 404; without the token it is 401, as a learning write is", async (t) => {
  const { api, baseUrl, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("fresh", { learning: true }))).status, 201);
  for (const time of ["first", "second"]) {
    const done = await api("DELETE", "/agents/fresh/learning");
    assert.equal(done.status, 204, `${time}: ${JSON.stringify(done.body)}`);
  }
  assert.deepEqual(await recordsOf(store, "fresh"), []);
  const unknown = await api("DELETE", "/agents/nobody/learning");
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, "not_found"], JSON.stringify(unknown.body));
  const bare = await fetch(`${baseUrl}/agents/fresh/learning`, { method: "DELETE" });
  const sibling = await fetch(`${baseUrl}/agents/fresh/learning/corrections`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "- x\n" });
  assert.deepEqual([bare.status, (await bare.json()).error?.code], [sibling.status, (await sibling.json()).error?.code], "refused as PUT corrections is");
  assert.equal(bare.status, 401);
});

test("a run of the agent's own still going: 409 learning_busy naming it, the run left going and nothing of the learning deleted; once it ended, 204", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("busy", { learning: true }))).status, 201);
  const main = await learned(store, data, "busy");
  const started = await api("POST", "/agents/busy/runs", { input: ASK });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  const refused = await api("DELETE", "/agents/busy/learning");
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.retryable], [409, "learning_busy", true], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, [runId], "the run named");
  assert.equal((await store.runs.get(runId)).state, "queued", "the owner's run is not cancelled");
  assert.equal((await api("GET", "/agents/busy/learning")).body.main, main, "the folder as it was");
  assert.equal((await recordsOf(store, "busy")).length, 2, "the records kept");

  assert.deepEqual(await store.commands(runId, 0), [], "nor sent a cancel");
  await endAsRunner(store, runId, "ended");
  const done = await api("DELETE", "/agents/busy/learning");
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(await recordsOf(store, "busy"), []);
  assert.equal((await api("GET", "/agents/busy/learning")).body.main, null);
});

test("a check's replay in flight is cancelled and waited for, then the learning deleted: 204", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("checking", { learning: true }))).status, 201);
  const main = await learned(store, data, "checking");
  const replay = await storedRun(store, "checking", "replay-1", { input: ASK, title: "t", place: { mode: "runner" }, replay: { of: "run-of-before", workflow: "answer", digest: DIGEST } });

  const reset = api("DELETE", "/agents/checking/learning");
  // The cancel is the run's command; while the run has not ended, nothing of the learning is deleted. The runner takes
  // the cancel and stops the run, as this test does in its place.
  const end = Date.now() + 30_000;
  while (!(await store.commands(replay, 0)).some((command) => command.kind === "cancel")) {
    assert.ok(Date.now() < end, "a cancel sent to the replay");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await api("GET", "/agents/checking/learning")).body.main, main, "nothing deleted while the replay goes");
  await endAsRunner(store, replay, "stopped");
  const done = await reset;
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(await recordsOf(store, "checking"), []);
  assert.equal((await api("GET", "/agents/checking/learning")).body.main, null);
});

test("a check's replay that has not ended by the wait's end: 409 learning_busy naming it, nothing of the learning deleted", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false, agentDeleteWaitMs: 300 });
  assert.equal((await api("POST", "/agents", agent("stuck", { learning: true }))).status, 201);
  const main = await learned(store, data, "stuck");
  const replay = await storedRun(store, "stuck", "replay-2", { input: ASK, title: "t", place: { mode: "runner" }, replay: { of: "run-of-before", workflow: "answer", digest: DIGEST } });
  // A runner holds it: its cancel stands, but only the runner ends it, and none is here.
  const claim = await store.claim(replay, "runner-a", { leaseMs: 60_000 });
  assert.ok(claim, "claimed");

  const refused = await api("DELETE", "/agents/stuck/learning");
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "learning_busy"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, [replay]);
  assert.equal((await api("GET", "/agents/stuck/learning")).body.main, main, "the folder as it was");
  assert.equal((await recordsOf(store, "stuck")).length, 2, "the records kept");
});

test("the API-only profile serves it with the token: 409 while the agent's inline run is going, 401 without the token, 204 once it ended and again; an unknown agent is the route's own 404", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const send = async (method, path, { token = true, body } = {}) => {
    const res = await fetch(`${server.url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${server.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const inline = await send("POST", "/v2/runs", { body: { external: { source: "host", kind: "expert", id: "9", version: 1 }, definition: { name: "Expert 9", instructions: "Answer.", skills: [], tools: [] }, input: { content: "Hi" } } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  const { agent_id: agentId, run_id: runId } = inline.body;

  const busy = await send("DELETE", `/v2/agents/${agentId}/learning`);
  assert.deepEqual([busy.status, busy.body?.error?.code, busy.body?.error?.details?.runs], [409, "learning_busy", [runId]], JSON.stringify(busy.body));
  assert.equal((await send("DELETE", `/v2/agents/${agentId}/learning`, { token: false })).status, 401);
  await endAsRunner(server.store, runId, "ended");
  for (const time of ["first", "second"]) assert.equal((await send("DELETE", `/v2/agents/${agentId}/learning`)).status, 204, time);
  const unknown = await send("DELETE", "/v2/agents/agent_missing/learning");
  assert.equal(unknown.status, 404);
  assert.ok(!unknown.body.error.message.includes("AGENTRUN_API_ONLY"), "the route's own, not the profile's");
});

// The gap between a run's job ending and its learning end settling, through real runners over a store of its own, the
// reset as the server does it (learning-reset.ts resetLearning over the local folder, the cancel command and the
// agent's learning queue). A run's row stays not final through its end-of-run step (adapter-loop.ts: the job's end is
// kept, then the step, then writeEnd), so the reset reads that run as its own run still going.
const HOOKS = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const FEEDBACK = "Retry more slowly next time.";
const WORKFLOW_JSON = "workflows/answer/workflow.json";
/** A draft of `answer` the compile turn answers with, one that passes its checks (runner-learning-end.test.mjs). */
const compiledBlock = () => `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
})}\n\`\`\`\``;

const until = async (check, what, ms = 60_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A store in a directory of its own, agent-1 of `body` (compile_after 1 by default), and the reset over it. */
async function storeWorld(t, body = { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-reset-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const closing = [];
  t.after(async () => {
    for (const close of closing.reverse()) await close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body });
  const host = {
    store: server,
    deleteLearning: (store, agentId, kept) => deleteLearning(store, agentId, learningFolderOf(dir, agentId), kept),
    cancel: async (runId) => (await sendCommand(server, runId, { kind: "cancel", body: {} }), true),
    inQueue: (agentId, work) => withAgentRepo(dir, agentId, work),
    waitMs: 30_000,
    pollMs: 50,
  };
  /** 204, or the error the reset answered. */
  const reset = () => resetLearning(host, "agent-1").then(() => 204, (error) => error);
  const ended = (runId) => until(async () => {
    const row = await server.runs.get(runId);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `${runId} final`);
  const repo = join(dir, "disk", "agents", agentDirOf("agent-1"), "learning");
  /** The paths on the learning folder's main, or none once it is gone. */
  const onMain = () => (existsSync(join(repo, ".git")) ? git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n").filter(Boolean) : []);
  return { dir, server, host, reset, ended, repo, onMain, closing };
}

/** Agent-1's learning before the run: a correction on its folder's main and a grade. */
async function corrected(w) {
  await seedOf(w.dir, "agent-1");
  writeFileSync(join(w.repo, "corrections.md"), CORRECTION);
  git(w.repo, ["add", "--", "corrections.md"]);
  git(w.repo, ["commit", "-q", "-m", "corrected"]);
  await resnap(w.dir, "agent-1");
  await w.server.settings.put(gradesKey("agent-1"), { r1: { correct: true } });
}

/** A runner for the agent's runs, its end-of-run step learningEndOfRun of `launch` wrapped by `wrap`; `feedback` is
 *  queued on `runId` first (the owner's words its end keeps as a correction). `folderData`: the data directory whose
 *  learning folder the end writes (by default the server's, the one its seed was read from). */
async function runnerFor(w, runId, launch, { script, feedback, wrap = (step) => step, folderData = w.dir }) {
  if (feedback !== undefined) await sendCommand(w.server, runId, { kind: "steer", body: { text: feedback } });
  const store = await openSqliteStore({ dataDir: w.dir, role: "runner" });
  const spec = piAdapterSpec({ script, tools: {}, hooks: HOOKS }, { requests: [] });
  const step = learningEndOfRun(launch, { store, data: w.dir, env: {}, learningFolder: (agentId) => learningFolderOf(folderData, agentId) });
  assert.ok(step, "the run learns at its end");
  const createLoop = (deps) => {
    const endOfRun = wrap(step);
    return createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", endOfRun }))(deps);
  };
  const runner = startRunner({ store, createLoop, name: `runner-${runId}`, ...TIMING });
  w.closing.push(() => store.close(), () => runner.close());
  /** This runner stopped, so a later run is claimed by a runner of its own launch. */
  return { close: async () => (await runner.close(), await store.close()) };
}

test("(a) a run whose job turn ended and whose end-of-run step is still at work (its compile held open): 409 learning_busy naming it, nothing deleted; released, its compile commits and it ends; then 204, and nothing that compile wrote is left", { timeout: 120_000 }, async (t) => {
  const w = await storeWorld(t);
  await corrected(w);
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, learning: { seed: (await seedOf(w.dir, "agent-1")).sha, section: "" } };
  await w.server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  let entered;
  const inStep = new Promise((resolve) => (entered = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await runnerFor(w, "run-1", launch, { feedback: FEEDBACK, script: [{ say: "The job's answer." }, { say: "Noted." }, { say: compiledBlock() }], wrap: (step) => async (input) => {
    entered();
    await held;
    return step(input);
  } });
  await inStep;
  const row = await w.server.runs.get("run-1");
  assert.ok(!FINAL.includes(row.state), `the job's turn ended, the run is not final: ${row.state}`);
  const busy = await w.reset();
  assert.equal(busy?.code, "learning_busy", String(busy?.message ?? busy));
  assert.deepEqual(busy.extra?.details?.runs, ["run-1"]);
  assert.deepEqual(w.onMain(), ["corrections.md"], "nothing of the folder is deleted");
  assert.deepEqual(await recordsOf(w.server, "agent-1"), [gradesKey("agent-1")], "nor the grade");

  release();
  assert.equal((await w.ended("run-1")).state, "ended");
  assert.ok(w.onMain().includes(WORKFLOW_JSON), `the compile committed its draft: ${w.onMain().join(", ")}`);
  assert.equal(await w.reset(), 204);
  assert.deepEqual(w.onMain(), [], "no workflow, no correction: the folder is empty");
  assert.deepEqual(await promotionsOf(w.server.settings, "agent-1"), [], "no promotion record");
  assert.deepEqual(await recordsOf(w.server, "agent-1"), []);
});

/** An agent's learned workflow on its own input (`question`), the check's subject (runner-promote-replay.test.mjs). */
const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" }] },
};
const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));

test("(b) a run whose claim started a check's replays, then ended: the reset cancels the replays and waits for them, and no promotion record is left, the replays' own ends included; the next run is the agent's and records none", { timeout: 180_000 }, async (t) => {
  const w = await storeWorld(t, { instructions: "Answer.", tools: ["read"], learning: true });
  // Each replay's workflow node asks the model and is held there, in flight, until its run is cancelled.
  const gw = await startFauxGateway({
    hang: ({ body }) => offers(body, "submit"),
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: 42, sure: true } } } : undefined),
    text: () => JSON.stringify({ answer: 42, sure: true }),
  });
  w.closing.push(() => gw.close());
  const store = await openSqliteStore({ dataDir: w.dir, role: "runner" });
  const MODEL = "claude-sonnet-5-5";
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price: () => 0.001, fetch: globalThis.fetch };
  const deps = { env: {}, data: w.dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  const runner = startRunner({ store, name: "runner-a", ...TIMING, renewEveryMs: 1_000, createLoop: createAdapterLoop(specOf) });
  w.closing.push(() => store.close(), () => runner.close());
  const launchOf = (question, at) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(at ? { learning: startAt(at) } : {}) });
  // The agent's own earlier runs, the inputs its check replays.
  for (let i = 0; i < 3; i++) {
    await w.server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    assert.equal((await w.ended(`prior-${i}`)).state, "ended");
  }
  await landWorkflows(w.dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }]);
  await w.server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf("What is six times seven", (await seedOf(w.dir, "agent-1")).sha) });
  assert.equal((await w.ended("run-1")).metrics?.path, "agent", "the agent took the run while its workflow is checked");
  const reserved = (await promotionsOf(w.server.settings, "agent-1")).find((one) => one.decided === "replaying");
  assert.equal(reserved?.runs?.length, 3, "its claim reserved the check and started a replay per input");
  await until(() => gw.requests.filter(({ body }) => offers(body, "submit")).length === 3, "each replay in flight, held at its model request");
  for (const id of reserved.runs) assert.ok(!FINAL.includes((await w.server.runs.get(id)).state), `${id} is at work`);

  assert.equal(await w.reset(), 204);
  for (const id of reserved.runs) assert.equal((await w.server.runs.get(id)).state, "stopped", `${id} was cancelled and ended before anything was deleted`);
  assert.deepEqual(await promotionsOf(w.server.settings, "agent-1"), [], "no promotion record");
  assert.deepEqual(w.onMain(), []);
  // Nothing comes back later: the next run takes the agent path, and no check is started or recorded.
  await w.server.runs.create({ id: "run-2", agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf("What is seven times six", (await seedOf(w.dir, "agent-1")).sha) });
  assert.equal((await w.ended("run-2")).metrics?.path, "agent");
  assert.deepEqual(await promotionsOf(w.server.settings, "agent-1"), [], "still none");
  assert.deepEqual((await w.server.runs.every("agent-1")).filter((run) => !FINAL.includes(run.state)), [], "nothing at work");
});

/** A run's learning start as the server pins it (runs-over-store.ts learningStartFor): its seed's commit and when the
 *  seed was read. */
const startOf = (seed, section = "") => ({ seed: seed.sha, section, seededAt: seed.at });

test("(c) a run whose start read its seed before the reset, its row made after it: its learning is dropped whole at its end's entry (reason reset: no correction, no workflow, no promotion record); the next run's compile is a first compile on the new history", { timeout: 120_000 }, async (t) => {
  const w = await storeWorld(t);
  await corrected(w);
  // Its start read the seed (as the server's seedFor does, in the agent's learning queue) before the reset's step 2.
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, learning: startOf(await seedOf(w.dir, "agent-1"), CORRECTION) };
  assert.equal(await w.reset(), 204, "no run of the agent's yet");
  await w.server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  const first = await runnerFor(w, "run-1", launch, { feedback: FEEDBACK, script: [{ say: "The job's answer." }, { say: "Noted." }, { say: compiledBlock() }] });
  assert.equal((await w.ended("run-1")).state, "ended");
  await first.close();
  const proposal = (await w.server.learning.proposal("run-1"))?.proposal;
  assert.deepEqual([proposal?.state, proposal?.reason, proposal?.detail], ["dropped", "reset", "Dropped: its learning seed predates a reset of the agent's learning."], JSON.stringify(proposal));
  assert.ok(!w.onMain().includes(WORKFLOW_JSON), `no workflow landed: ${w.onMain().join(", ")}`);
  assert.deepEqual(await promotionsOf(w.server.settings, "agent-1"), [], "no promotion record (no hold a recompile would answer)");
  const corrections = w.onMain().includes("corrections.md") ? git(w.repo, ["show", "main:corrections.md"]) : "";
  assert.ok(!corrections.includes(FEEDBACK) && !corrections.includes(CORRECTION.trim()), `no correction landed: ${JSON.stringify(corrections)}`);

  // The next run, seeded after the reset: its compile is the agent's first on the new history, its draft landed.
  const next = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, learning: startOf(await seedOf(w.dir, "agent-1")) };
  await w.server.runs.create({ id: "run-2", agentId: "agent-1", revisionId: "rev-1" }, { body: next });
  await runnerFor(w, "run-2", next, { feedback: FEEDBACK, script: [{ say: "The job's answer." }, { say: "Noted." }, { say: compiledBlock() }] });
  assert.equal((await w.ended("run-2")).state, "ended");
  const second = (await w.server.learning.proposal("run-2"))?.proposal;
  assert.equal(second?.state, "merged", JSON.stringify(second));
  assert.deepEqual(second.compiled?.attempts?.length, 1, `one attempt, a first compile: ${JSON.stringify(second.compiled)}`);
  assert.ok(w.onMain().includes(WORKFLOW_JSON), `its draft is on main: ${w.onMain().join(", ")}`);
  assert.ok(!(await promotionsOf(w.server.settings, "agent-1")).some((one) => one.decided === "hold"), "no hold");
});

test("a run seeded after the reset whose end writes another learning folder than the one its seed was read from (a Mode 2 run's, on its disk, seeded from the server's): its learning is not dropped, and its owner's correction lands on that folder", { timeout: 120_000 }, async (t) => {
  const w = await storeWorld(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 100 } });
  // The disk the run's end writes, standing in as a data directory of its own: its folder never held the server's seed.
  const disk = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-reset-disk-"));
  t.after(() => rmSync(disk, { recursive: true, force: true }));
  await corrected(w);
  assert.equal(await w.reset(), 204);
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, learning: startOf(await seedOf(w.dir, "agent-1")) };
  await w.server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await runnerFor(w, "run-1", launch, { feedback: FEEDBACK, folderData: disk, script: [{ say: "The job's answer." }, { say: "Noted." }] });
  assert.equal((await w.ended("run-1")).state, "ended");
  const proposal = (await w.server.learning.proposal("run-1"))?.proposal;
  assert.equal(proposal?.state, "merged", JSON.stringify(proposal));
  const repo = learningDir(disk, "agent-1");
  assert.ok(git(repo, ["show", "main:corrections.md"]).includes(FEEDBACK), "its correction is on the disk's folder");
  assert.equal(w.onMain().includes("corrections.md"), false, "and not on the server's");
});

const PRE = "PRE-RESET-MARKER";
const COMPILE_ASKED = "enough times to write it down";
const askedToCompile = (request) => JSON.stringify(request.body ?? {}).includes(COMPILE_ASKED);

test("a reset whose delete fails part way keeps its watermark, so the runs before it never feed a compile into the emptied folder; the next call finishes it; one refused before anything went (LearningInFlight) puts the earlier watermark back", async (t) => {
  const w = await storeWorld(t);
  await corrected(w);
  const real = w.host.deleteLearning;
  w.host.deleteLearning = async (store, agentId, kept) => {
    await real(store, agentId, kept);
    throw new Error("the store refused a write");
  };
  const failed = await w.reset();
  assert.match(String(failed?.message), /refused a write/, String(failed));
  assert.equal(existsSync(join(w.repo, "corrections.md")), false, "the folder went before the failure");
  assert.equal(typeof (await w.server.settings.get(resetAtKey("agent-1")))?.at, "number", "the watermark stays: learning reads no run before it");
  w.host.deleteLearning = real;
  assert.equal(await w.reset(), 204, "the next call finishes it");
  const at = (await w.server.settings.get(resetAtKey("agent-1"))).at;
  w.host.deleteLearning = async (_store, agentId) => {
    throw new LearningInFlight(agentId, ["run-going"]);
  };
  const busy = await w.reset();
  assert.equal(busy?.code, "learning_busy", String(busy));
  assert.equal((await w.server.settings.get(resetAtKey("agent-1"))).at, at, "nothing went, so the earlier watermark is back");
});

test("the watermark: runs before the reset never reach a later compile, even past compile_after (N = 3 before it, fewer than N after: no compile; then the compile reads only the runs after it, no text of one before)", { timeout: 180_000 }, async (t) => {
  const w = await storeWorld(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 3 } });
  const gw = await startFauxGateway({ text: (request) => (askedToCompile(request) ? compiledBlock() : "42") });
  w.closing.push(() => gw.close());
  const store = await openSqliteStore({ dataDir: w.dir, role: "runner" });
  const MODEL = "claude-sonnet-5-5";
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price: () => 0.001, fetch: globalThis.fetch };
  const deps = { env: {}, data: w.dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  const runner = startRunner({ store, name: "runner-w", ...TIMING, createLoop: createAdapterLoop(specOf) });
  w.closing.push(() => store.close(), () => runner.close());
  const launchOf = async (content) => ({ input: { content }, title: content, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startOf(await seedOf(w.dir, "agent-1")) });
  const run = async (id, content) => {
    await w.server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: await launchOf(content) });
    assert.equal((await w.ended(id)).state, "ended", id);
  };
  const compiles = () => gw.requests.filter(askedToCompile);

  // N = compile_after runs before the reset, each completed: the first compile of the agent is due at the third.
  for (let i = 0; i < 3; i++) await run(`pre-${i}`, `${PRE} question ${i}?`);
  assert.equal(await w.reset(), 204);
  const before = compiles().length;
  // Fewer than N after it: no compile, whatever ran before.
  for (let i = 0; i < 2; i++) await run(`post-${i}`, `Question after ${i}?`);
  assert.equal(compiles().length, before, "no compile turn: compile_after counts from the reset");
  assert.ok(!w.onMain().includes(WORKFLOW_JSON), `no workflow: ${w.onMain().join(", ")}`);
  // The Nth after it compiles, reading only the runs after the reset.
  await run("post-2", "Question after 2?");
  const asked = compiles().slice(before);
  assert.equal(asked.length, 1, "the third run after the reset compiles");
  const text = JSON.stringify(asked[0].body);
  assert.ok(!text.includes(PRE), "no text of a run before the reset reaches the compile");
  assert.ok(text.includes("Question after 0?") && text.includes("Question after 1?"), "its traces are the runs after the reset");
  assert.ok(w.onMain().includes(WORKFLOW_JSON), `the draft landed: ${w.onMain().join(", ")}`);
  assert.ok(!git(w.repo, ["show", `main:${WORKFLOW_JSON}`]).includes(PRE), "and the workflow holds nothing of a run before it");
});

const FLOW_DIGEST = createHash("sha256").update(JSON.stringify(answerFlow)).digest("hex").slice(0, 16);

test("the watermark's readers: a run before the reset, or one whose seed was read before it (its row made after), is in no learning read: compile_after's count and a check's inputs (lastOwnRuns), an owner's replay inputs, the audit's served-run count, the money rule's past runs, the loop view", async (t) => {
  const w = await storeWorld(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 10 } });
  const ended = async (id, launch, metrics = { path: "agent" }) => {
    await w.server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
    const claim = await w.server.claim(id, "runner-test", { leaseMs: 60_000 });
    await w.server.runs.update(claim, { state: "ended", costUsd: 0.01, metrics });
  };
  const SERVED = { path: "workflow", workflow: "answer", workflow_digest: FLOW_DIGEST, not_auditable: true };
  const ask = (question, seed) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, learning: startOf(seed) });
  const before = await seedOf(w.dir, "agent-1");
  for (let i = 0; i < 3; i++) await ended(`pre-${i}`, ask(`Question ${i}`, before));
  for (let i = 0; i < 2; i++) await ended(`pre-served-${i}`, ask(`Served ${i}`, before), SERVED);
  // A start that read the seed before the reset, its row made after it.
  const late = await seedOf(w.dir, "agent-1");
  assert.equal(await w.reset(), 204);
  await ended("late-seed", ask("Late", late));
  const after = await seedOf(w.dir, "agent-1");
  await ended("post-0", { input: { content: "After?" }, title: "after", place: { mode: "runner" }, learning: startOf(after) });
  await ended("post-served-0", ask("Served after", after), SERVED);

  // The one store read the watermark adds: only runs started after it whose seed was read at or before it, by id.
  const { at } = await w.server.settings.get(resetAtKey("agent-1"));
  assert.deepEqual(await w.server.runs.seededBefore("agent-1", at), ["late-seed"], "the runs started after it, seeded before it");
  assert.deepEqual((await lastOwnRuns(w.server, "agent-1", 10)).map((row) => row.id), ["post-0"], "compile_after's count and a check's inputs");
  assert.equal(await notAuditableOf(w.server, "agent-1", "answer", FLOW_DIGEST, { stop_window: 10 }), 1, "the audit's served runs");
  assert.deepEqual((await pastRunsOverStore(w.server, "agent-1")).runs.length, 2, "the money rule's past runs: post-0 and post-served-0");
  assert.equal((await agentLoopOverStore(w.server, "agent-1")).completed_runs, 1, "the loop view's count");
  // An owner's replay of a workflow learned after the reset: the runs before it would fit its input, and none is picked.
  await landWorkflows(w.dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }]);
  const launched = [];
  const replayAsk = { store: w.server, agentId: "agent-1", context: BACKGROUND_CONTEXT, log: () => {}, folder: () => learningFolderOf(w.dir, "agent-1"), shown: async () => secretsShown([]), launchOf: async (input) => (launched.push(input), Promise.reject(new Error("a replay was launched"))) };
  await assert.rejects(askReplay(replayAsk, "answer", FLOW_DIGEST, 10), /has no input to replay on/);
  assert.deepEqual(launched, [], "no replay of a run before the reset");
});

test("runs purged by DELETE /runs/{id} (their kept learning cut to its state alone): no learning read fails on them or reads any text of them, and the agent's learning reset over them is 204 with every read still whole", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("cut", { learning: true }))).status, 201);
  const revisionId = (await store.agents.get("cut")).currentRevision;
  const LEARNS = { input: ASK, title: "t", place: { mode: "runner" }, learning: { seed: "a".repeat(40), section: "" } };
  const TEXT = "What the purged run learned";
  for (const [id, proposal] of [["cut-1", { state: "merged", detail: `${TEXT}: merged.` }], ["cut-2", { detail: `${TEXT}: proposed.` }], ["kept-1", { state: "merged", detail: "What the kept run learned." }]]) {
    await store.runs.create({ id, agentId: "cut", revisionId }, { body: LEARNS });
    const claim = await store.claim(id, "runner-cut", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: 0.1, metrics: { path: "agent" } });
    const db = await raw(join(data, "store.sqlite"), { timeout: 10_000 });
    try {
      await db.run("INSERT INTO learning_proposals (run_id, round, agent_id, turn, proposal, created_at) VALUES (?, 1, ?, ?, ?, ?)", id, "cut", JSON.stringify({ asked: `${TEXT}: its turn.` }), JSON.stringify(proposal), Date.now());
    } finally {
      await db.close();
    }
  }
  for (const id of ["cut-1", "cut-2"]) {
    const purged = await api("DELETE", `/runs/${id}`);
    assert.equal(purged.status, 204, `DELETE /runs/${id}: ${JSON.stringify(purged.body)}`);
  }
  const reads = ["/agents/cut", "/agents/cut/learning", "/agents/cut/learning/cost", "/agents/cut/learning/loop", "/agents/cut/learning/promotions", "/agents/cut/learning/log", "/runs/kept-1", "/stats", "/usage"];
  const readAll = async (when) => {
    for (const path of reads) {
      const read = await api("GET", path);
      assert.equal(read.status, 200, `${when}, ${path}: ${JSON.stringify(read.body)}`);
      assert.ok(!JSON.stringify(read.body).includes(TEXT), `${when}, ${path} reads no text of a purged run: ${JSON.stringify(read.body)}`);
    }
    for (const id of ["cut-1", "cut-2"]) assert.equal((await api("GET", `/runs/${id}`)).status, 410, `${when}, ${id} is purged`);
  };
  await readAll("purged");
  assert.deepEqual((await api("GET", "/agents/cut/learning/loop")).body.compiles, [], "no compile read from a row with none");

  const reset = await api("DELETE", "/agents/cut/learning");
  assert.equal(reset.status, 204, `the reset over purged runs: ${JSON.stringify(reset.body)}`);
  await readAll("reset");
  assert.equal((await api("GET", "/runs/kept-1")).status, 200, "the kept run stays");
});
