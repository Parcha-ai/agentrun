import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteStore, StoreConstraint } from "../dist/store/index.js";
import { startRun } from "../dist/runs-over-store.js";
import { launchBody, readLaunchBody } from "../dist/run-launch.js";

const receipt = { version: 1, sourceId: "c".repeat(64), baselineRevision: "revision-1", digest: "a".repeat(64), receipt: "b".repeat(64) };
const revision = { id: "revision-1", agentId: "agent-1", kind: "agentic", body: { instructions: "Answer.", tools: [], skills: {}, sourceSync: { id: "c".repeat(64), snapshot: "a".repeat(64), project: "a".repeat(64), configuration: "d".repeat(64) } }, createdAt: 0 };
const entry = { agent: { id: "agent-1", name: "Agent", description: null, currentRevision: revision.id, createdAt: 0, archivedAt: null }, revision, version: 1, revisions: 1, sizes: new Map() };
const deps = over => ({ newRunId: () => "run-1", runBodyIssues: () => [], pinnedOf: async () => ({ revision, version: 1 }), inputIssuesOf: async () => [], explainRun: async issues => issues,
  told: error => error, runnable: async () => {}, readyFiles: async () => [], fallbackPlace: () => ({ mode: "runner" }), workflowTitle: name => name,
  serverSecrets: () => [], toolSettings: () => ({}), planeEnv: () => ({}), modelOf: () => ({ provider: "anthropic", modelId: "claude" }), ...over });
const body = { input: { content: "Continue the project." } };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "project-placement-"));
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.agents.create({ id: entry.agent.id, name: entry.agent.name }, { id: revision.id, kind: revision.kind, body: revision.body });
  return store;
}
const wrapped = (store, overrides) => ({ ...store, runs: { ...store.runs, ...overrides } });

test("a project without uploads is completely placed before the run is admitted", async t => {
  const store = await fixture(t);
  let finish, entered = false;
  const reached = Promise.withResolvers();
  const ready = new Promise(resolve => { finish = resolve; });
  const start = startRun(store, deps({ project: { async place(given) {
    entered = true; reached.resolve();
    assert.equal(given.runId, "run-1"); assert.equal(given.agentId, "agent-1"); assert.equal(given.revision.id, revision.id);
    assert.equal(await store.runs.get("run-1"), undefined);
    await ready;
    return { launch: { ...given.launch, sourceProject: receipt }, undo: async () => assert.fail("an admitted project is retained") };
  } } }), entry, body);
  await Promise.race([reached.promise, start.then(() => assert.fail("admission completed before project placement"))]);
  try { assert.equal(entered, true, "project placement must run even without file_ids"); assert.equal(await store.runs.get("run-1"), undefined); }
  finally { finish(); }
  const run = await start;
  assert.equal(run.state, "queued");
  assert.deepEqual(readLaunchBody((await store.runs.launch(run.id)).body).sourceProject, receipt);
});

test("an incomplete project refuses admission and rolls back already placed uploads", async t => {
  const store = await fixture(t), order = [], error = new Error("incomplete project");
  await assert.rejects(startRun(store, deps({ files: { hold: async () => assert.fail(), release: async () => assert.fail(), place: async (_run, _agent, launch) => {
    order.push("upload"); return { launch: { ...launch, filesPlaced: true }, undo: async () => { order.push("undo-upload"); } };
  } }, project: { place: async () => { order.push("project"); throw error; } } }), entry, { ...body, file_ids: ["input-1"] }), actual => actual === error);
  assert.equal(await store.runs.get("run-1"), undefined); assert.deepEqual(order, ["upload", "project", "undo-upload"]);
});

test("project placement uses the upload-pinned disk and definite refusal undoes both in reverse order", async t => {
  const store = await fixture(t), order = [], disk = { diskId: "fixture-disk", kind: "agent" };
  const failing = wrapped(store, { create: async () => { order.push("insert"); throw new StoreConstraint("fixture admission refusal"); } });
  await assert.rejects(startRun(failing, deps({ files: { hold: async () => assert.fail(), release: async () => assert.fail(), place: async (_run, _agent, launch) => {
    order.push("upload"); return { launch: { ...launch, archilDisk: disk, filesPlaced: true }, undo: async () => { order.push("undo-upload"); } };
  } }, project: { place: async ({ launch }) => { order.push("project"); assert.deepEqual(launch.archilDisk, disk); return { launch: { ...launch, sourceProject: receipt }, undo: async () => { order.push("undo-project"); } }; } } }), entry, { ...body, file_ids: ["input-1"] }), StoreConstraint);
  assert.deepEqual(order, ["upload", "project", "insert", "undo-project", "undo-upload"]);
});

test("the agent revision guard still refuses a source project prepared against an older revision", async t => {
  const store = await fixture(t); let undone = false;
  await assert.rejects(startRun(store, deps({ project: { place: async ({ launch }) => {
    await store.agents.addRevision({ id: "revision-2", agentId: "agent-1", kind: "agentic", body: { instructions: "Changed." }, ifCurrent: revision.id });
    return { launch: { ...launch, sourceProject: receipt }, undo: async () => { undone = true; } };
  } } }), entry, body), error => error.code === "precondition_failed");
  assert.equal(undone, true); assert.equal(await store.runs.get("run-1"), undefined);
});

for (const state of ["committed", "absent", "unreadable"]) test(`an unanswered admission with ${state} lookup never removes possibly admitted project files`, async t => {
  const store = await fixture(t), error = new Error("fixture connection lost after admission request"); let undone = 0;
  const uncertain = wrapped(store, { create: async (...args) => { if (state === "committed") await store.runs.create(...args); throw error; },
    get: async id => { if (state === "unreadable") throw new Error("fixture read unavailable"); return store.runs.get(id); } });
  const start = startRun(uncertain, deps({ project: { place: async ({ launch }) => ({ launch: { ...launch, sourceProject: receipt }, undo: async () => { undone++; } }) } }), entry, body);
  if (state === "committed") { const run = await start; assert.equal(run.id, "run-1"); assert.deepEqual(readLaunchBody((await store.runs.launch(run.id)).body).sourceProject, receipt); }
  else await assert.rejects(start, actual => actual === error);
  assert.equal(undone, 0);
});

test("the internal placement receipt round-trips and malformed stored receipts refuse the whole launch", () => {
  const launch = { input: {}, title: "Project", place: { mode: "runner" }, sourceProject: receipt };
  assert.deepEqual(readLaunchBody(launchBody(launch)).sourceProject, receipt);
  for (const bad of [null, {}, { ...receipt, version: 2 }, { ...receipt, digest: "invalid" }, { ...receipt, receipt: "invalid" }, { ...receipt, baselineRevision: "../invalid" }]) {
    assert.equal(readLaunchBody({ input: {}, title: "Project", place: { mode: "runner" }, source_project: bad }), undefined);
  }
  assert.equal(readLaunchBody({ input: {}, title: "Ordinary", place: { mode: "runner" } }).sourceProject, undefined);
});

test('source I/O ownership starts before uploads and transfers only after confirmed admission', async t => {
  const store = await fixture(t), order = [];
  await startRun(store, deps({ files: { hold: async () => assert.fail(), release: async () => assert.fail(), place: async (_run, _agent, launch) => {
    order.push('upload'); return { launch, undo: async () => assert.fail() };
  } }, project: { hold: async () => { order.push('hold'); return { settled: async () => { assert.ok(await store.runs.get('run-1')); order.push('settled'); } }; },
    place: async ({ launch }) => { order.push('project'); return { launch: { ...launch, sourceProject: receipt }, undo: async () => assert.fail() }; } } }), entry, { ...body, file_ids: ['input-1'] });
  assert.deepEqual(order, ['hold', 'upload', 'project', 'settled']);
});

test('unknown source admission retains durable I/O ownership while definite refusal releases after all rollback', async t => {
  for (const uncertain of [true, false]) {
    const store = await fixture(t), order = [], failure = uncertain ? new Error('fixture unknown commit') : new StoreConstraint('fixture refused');
    const failing = wrapped(store, { create: async () => { throw failure; } });
    await assert.rejects(startRun(failing, deps({ files: { hold: async () => assert.fail(), release: async () => assert.fail(), place: async (_run, _agent, launch) => ({ launch, undo: async () => { order.push('undo-upload'); } }) },
      project: { hold: async () => ({ settled: async () => { order.push('settled'); } }), place: async ({ launch }) => ({ launch: { ...launch, sourceProject: receipt }, undo: async () => { order.push('undo-project'); } }) } }), entry, { ...body, file_ids: ['input-1'] }), actual => actual === failure);
    assert.deepEqual(order, uncertain ? [] : ['undo-project', 'undo-upload', 'settled']);
  }
});

async function completedProject(store, status) {
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { commitWrites } = await import('@earendil-works/pi-durable/testing');
  const { projectCandidate } = await import('../dist/source-sync/checkpoints.js');
  await store.runs.create({ id: 'prior', agentId: 'agent-1', revisionId: revision.id, origin: { key: 'prior-origin' } }, { body: launchBody({ input: body.input, title: 'Prior', place: { mode: 'runner' }, sourceProject: receipt }) });
  const claim = await store.claim('prior', 'fixture-runner', { leaseMs: 60_000 }), journal = store.journal(claim);
  await commitWrites(journal, [{ type: 'conversation', value: { id: 1 } }], BACKGROUND_CONTEXT);
  const checkpoint = status === 'candidate' ? projectCandidate({ sourceId: receipt.sourceId, runId: 'prior', epoch: claim.epoch, baselineRevision: revision.id, baselineDigest: receipt.digest, digest: 'e'.repeat(64) })
    : { version: 1, status: 'uncertain', sourceId: receipt.sourceId, runId: 'prior', epoch: claim.epoch, reason: 'project_capture_failed' };
  const id = await journal.mintId(); journal.stage({ run: { state: 'ended' }, effect: id });
  await commitWrites(journal, [{ type: 'entry', value: { id, conversationId: 1, kind: 'agentrun.end', data: { state: 'ended', projectCheckpoint: checkpoint } } }], BACKGROUND_CONTEXT); await journal.close();
  return checkpoint;
}
for (const status of ['candidate', 'uncertain']) test(`the actual scheduled-run target honors a ${status} checkpoint before admission`, async t => {
  const store = await fixture(t), checkpoint = await completedProject(store, status), { triggerTargets } = await import('../dist/trigger-targets.js');
  let placedRevision;
  const start = deps({ pinnedOf: async current => ({ revision: current.revision, version: current.version }), project: { place: async ({ launch, revision: current }) => {
    placedRevision = current.id;
    return { launch: { ...launch, sourceProject: { ...receipt, baselineRevision: current.id, digest: current.body.sourceSync.project } }, undo: async () => {} };
  } } });
  const target = triggerTargets(store, { needAgent: async () => entry, start });
  const attempt = target.start({ kind: 'start_run', agent_id: 'agent-1', max_cost_usd: 1 }, body.input, { id: 'schedule', firing_key: 'tick' });
  if (status === 'candidate') {
    const started = await attempt;
    assert.equal(placedRevision, checkpoint.revision); assert.equal((await store.runs.get(started.run_id)).revisionId, checkpoint.revision);
  } else {
    await assert.rejects(attempt, error => error.code === 'agent_not_runnable');
    assert.equal(placedRevision, undefined); assert.equal(await store.runs.get('run-1'), undefined);
    const retry = await startRun(store, deps({ runnable: async () => assert.fail('existing origin must not start again') }), entry, body, { origin: { key: 'prior-origin' } });
    assert.equal(retry.id, 'prior');
  }
});

test('a proven unwritten project refusal keeps ownership until preceding upload rollback settles', async t => {
  const store = await fixture(t), order = [], failure = new Error('fixture deterministic preflight refusal');
  await assert.rejects(startRun(store, deps({ files: { hold: async () => assert.fail(), release: async () => assert.fail(), place: async (_run, _agent, launch) => ({ launch, undo: async () => {
    assert.deepEqual(order, []); order.push('undo-upload');
  } }) }, project: { hold: async () => ({ settled: async () => { order.push('settled'); } }), place: async ({ hold }) => {
    await hold.settled(); throw failure;
  } } }), entry, { ...body, file_ids: ['input-1'] }), actual => actual === failure);
  assert.deepEqual(order, ['undo-upload', 'settled']);
});
