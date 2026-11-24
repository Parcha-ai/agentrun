import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkspace, archilWorkspace } from "../dist/workspace/index.js";
import { sourceSnapshotDigest } from "../dist/native/source-snapshot-types.js";
import { commitSourceSnapshot } from "../dist/source-sync/snapshots.js";
import { projectPlacement, verifySourceProject } from "../dist/source-sync/projects.js";
import { beginSourceIO, requireSourceIOIdle } from "../dist/source-sync/io.js";
import { FiringMoved, openSqliteStore } from "../dist/store/index.js";
import { withHeldFiles } from "../dist/runs-over-store.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const binary = Uint8Array.of(0, 255, 128, 13, 10);
function snapshot() {
  const id = sha(binary), body = { version: 1, complete: true, source: { runtime: "codex", machine_id: "fixture", project: "/fixture/project", selector: { kind: "project" } },
    entries: [{ path: "project", role: "project", type: "directory", mode: 0o750, bytes: 0 }, { path: "project/asset.bin", role: "project", type: "file", mode: 0o640, bytes: binary.length, sha256: id }],
    blobs: { [id]: Buffer.from(binary).toString("base64") }, instructions: { text: "", layers: [] }, skills: [], configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  return { ...body, digest: sourceSnapshotDigest(body) };
}
async function setup(t, kind) {
  let snapshots, workspace, control;
  if (kind === "archil") {
    const disk = new FakeArchilDisk(); snapshots = archilWorkspace(disk, "fixture/source"); workspace = archilWorkspace(disk, "fixture/run/work"); control = archilWorkspace(disk, "fixture/run/private");
  } else {
    const root = await mkdtemp(join(tmpdir(), "project-facade-")); t.after(() => rm(root, { recursive: true, force: true }));
    for (const path of ["source", "work", "private"]) await mkdir(join(root, path));
    snapshots = localWorkspace(join(root, "source")); workspace = localWorkspace(join(root, "work")); control = localWorkspace(join(root, "private"));
  }
  const source = snapshot(); await commitSourceSnapshot(snapshots, source);
  const state = { opened: 0, undone: 0, ended: 0, modes: null, settled: 0 };
  const destination = { workspace, control, preparation: { applyModes: async (_work, entries) => { state.modes = entries; } }, end: async () => { state.ended++; }, undo: async () => { state.undone++; } };
  const options = { hold: async () => ({ settled: async () => { state.settled++; } }), snapshots: async () => ({ workspace: snapshots, end: async () => {} }), destination: async () => { state.opened++; return destination; } };
  const given = { agentId: "agent-1", runId: "run-1", revision: { id: "revision-1", kind: "agentic", body: { sourceSync: { id: "c".repeat(64), snapshot: source.digest, project: source.digest, configuration: "d".repeat(64) } } }, launch: { input: {}, title: "Fixture", place: { mode: "runner" } } };
  return { source, snapshots, workspace, control, state, destination, options, given };
}

for (const kind of ["local", "archil"]) {
  test(`${kind}: placement pins its complete private marker and reclaim keeps edited project bytes`, async t => {
    const f = await setup(t, kind), placed = await projectPlacement(f.options).place(f.given);
    assert.deepEqual([...await f.workspace.read("asset.bin")], [...binary]);
    assert.equal(f.state.modes.find(entry => entry.path === "asset.bin").mode, 0o640, "the exact mode reaches the capability callback; its implementation is tested separately");
    const receipt = placed.launch.sourceProject;
    assert.equal(receipt.digest, f.source.digest); assert.equal(receipt.sourceId, "c".repeat(64)); assert.equal(receipt.baselineRevision, f.given.revision.id);
    assert.equal(receipt.receipt, sha(await f.control.read("source-seed.json")));
    assert.equal(await f.workspace.stat("source-seed.json"), undefined, "the private marker is outside the model's workspace");
    await f.workspace.write("asset.bin", "the run changed this"); await f.workspace.write("new.txt", "new work");
    await verifySourceProject(f.control, receipt);
    assert.equal(new TextDecoder().decode(await f.workspace.read("asset.bin")), "the run changed this");
    assert.equal(new TextDecoder().decode(await f.workspace.read("new.txt")), "new work");
    assert.equal(f.state.opened, 1); assert.equal(f.state.ended, 1); assert.equal(f.state.undone, 0);
    await placed.undo(); assert.equal(f.state.undone, 1, "rollback remains usable after preparation resources close");
  });
  test(`${kind}: altered or unfinished control markers cannot authorize dispatch`, async t => {
    const f = await setup(t, kind), placed = await projectPlacement(f.options).place(f.given), receipt = placed.launch.sourceProject;
    for (const value of [{ version: 1, digest: receipt.digest, phase: "writing" }, { version: 1, digest: "e".repeat(64), phase: "complete" }, { version: 1, digest: receipt.digest, phase: "complete", extra: true }]) {
      await f.control.write("source-seed.json", JSON.stringify(value));
      await assert.rejects(verifySourceProject(f.control, receipt), error => error.code === "unsafe_resume");
    }
  });
  test(`${kind}: a required preparation failure never returns a receipt and rolls back before admission`, async t => {
    const f = await setup(t, kind), failure = new Error("fixture mode capability failed");
    f.destination.preparation.applyModes = async () => { throw failure; };
    await assert.rejects(projectPlacement(f.options).place(f.given), actual => actual === failure);
    assert.equal(f.state.undone, 1); assert.equal(f.state.ended, 1);
    assert.equal(f.state.settled, 0, "failed destination writes retain the durable I/O receipt even after attempted rollback");
    assert.equal(JSON.parse(new TextDecoder().decode(await f.control.read("source-seed.json"))).phase, "writing");
  });
  test(`${kind}: a missing immutable source never allocates a destination`, async t => {
    const f = await setup(t, kind);
    f.given.revision.body.sourceSync.project = "f".repeat(64);
    await assert.rejects(projectPlacement(f.options).place(f.given), error => error.code === "missing");
    assert.equal(f.state.opened, 0); assert.equal(f.state.undone, 0);
  });
}

for (const reserved of ["inputs/message.md", ".agentrun/tmp/file", ".agentrun/output/file"]) test(`a source path reserved for run-generated ${reserved} cannot be silently overwritten at claim`, async t => {
  const f = await setup(t, "local"), source = snapshot();
  source.entries = [...source.entries, { ...source.entries[1], path: `project/${reserved}` }];
  source.digest = sourceSnapshotDigest(source);
  await commitSourceSnapshot(f.snapshots, source);
  f.given.revision.body.sourceSync.project = source.digest;
  await assert.rejects(projectPlacement(f.options).place(f.given), error => error.code === "conflict");
  assert.equal(f.state.opened, 0, "collision is refused before any destination allocation");
});

for (const kind of ['local', 'archil']) test(`${kind}: placement pins exact preplaced upload paths without excluding unrelated authored inputs`, async t => {
  const f = await setup(t, kind);
  await f.workspace.write('inputs/upload.csv', 'uploaded');
  const placed = await projectPlacement(f.options).place(f.given);
  assert.deepEqual(placed.launch.sourceProject.inputs, ['inputs/upload.csv']);
  const marker = JSON.parse(Buffer.from(await f.control.read('source-seed.json')).toString());
  assert.deepEqual(marker.inputs, ['inputs/upload.csv']);
  await verifySourceProject(f.control, placed.launch.sourceProject);
  await assert.rejects(verifySourceProject(f.control, { ...placed.launch.sourceProject, inputs: ['inputs/another.csv'] }), error => error.code === 'unsafe_resume');
});


test('a deterministic missing-snapshot refusal releases I/O ownership after source cleanup, before any destination write', async t => {
  const f = await setup(t, 'local'); f.given.revision.body.sourceSync.project = 'f'.repeat(64);
  let closed = false; const open = f.options.snapshots;
  f.options.snapshots = async (...args) => { const value = await open(...args); return { ...value, end: async () => { closed = true; } }; };
  f.options.hold = async () => ({ settled: async () => { assert.equal(closed, true); f.state.settled++; } });
  await assert.rejects(projectPlacement(f.options).place(f.given), error => error.code === 'missing');
  assert.equal(f.state.opened, 0); assert.equal(f.state.settled, 1);
});

test('a readonly snapshot opener failure releases ownership without dispatching a destination operation', async t => {
  const f = await setup(t, 'local'), failure = new Error('fixture missing readonly source disk');
  f.options.snapshots = async () => { throw failure; };
  await assert.rejects(projectPlacement(f.options).place(f.given), actual => actual === failure);
  assert.equal(f.state.opened, 0); assert.equal(f.state.settled, 1);
});

async function collidingUpload(f) {
  const source = snapshot();
  source.entries.push({ ...source.entries[1], path: 'project/inputs/upload.csv' });
  source.digest = sourceSnapshotDigest(source);
  await commitSourceSnapshot(f.snapshots, source);
  f.given.revision.body.sourceSync.project = source.digest;
  await f.workspace.write('inputs/upload.csv', 'uploaded content');
}

for (const kind of ['local', 'archil']) test(`${kind}: a rejected upload collision releases ownership only after destination rollback and close`, async t => {
  const f = await setup(t, kind); await collidingUpload(f);
  const rollbackEntered = Promise.withResolvers(), rollbackFinish = Promise.withResolvers(), closeEntered = Promise.withResolvers(), closeFinish = Promise.withResolvers();
  f.destination.undo = async () => { f.state.undone++; rollbackEntered.resolve(); await rollbackFinish.promise; };
  f.destination.end = async () => { f.state.ended++; closeEntered.resolve(); await closeFinish.promise; };
  const result = assert.rejects(projectPlacement(f.options).place(f.given), error => error.code === 'conflict');
  try {
    await rollbackEntered.promise;
    assert.equal(f.state.settled, 0, 'rollback is still running');
    assert.equal(await f.control.stat('source-seed.json'), undefined, 'seeding was never dispatched');
    rollbackFinish.resolve(); await closeEntered.promise;
    assert.equal(f.state.settled, 0, 'destination cleanup is still running');
  } finally { rollbackFinish.resolve(); closeFinish.resolve(); }
  await result;
  assert.equal(f.state.settled, 1, 'a completely cleaned pre-seed refusal must not leave an unresolved writer');
  assert.equal(f.state.undone, 1); assert.equal(f.state.ended, 1);
});

for (const failureAt of ['open', 'rollback', 'destination-close', 'source-close']) test(`a rejected placement with unknown ${failureAt} retains its ownership`, async t => {
  const f = await setup(t, 'local'); await collidingUpload(f);
  const failure = new Error(`fixture ${failureAt} outcome unknown`);
  if (failureAt === 'open') f.options.destination = async () => { throw failure; };
  if (failureAt === 'rollback') f.destination.undo = async () => { throw failure; };
  if (failureAt === 'destination-close') f.destination.end = async () => { throw failure; };
  if (failureAt === 'source-close') f.options.snapshots = async () => ({ workspace: f.snapshots, end: async () => { throw failure; } });
  await assert.rejects(projectPlacement(f.options).place(f.given));
  assert.equal(f.state.settled, 0);
});

for (const cleanupFails of [false, true]) test(`actual upload collision ${cleanupFails ? 'retains the writer on upload cleanup failure' : 'unblocks deletion only after all upload cleanup'}`, async t => {
  const f = await setup(t, 'local'); await collidingUpload(f);
  const dir = await mkdtemp(join(tmpdir(), 'project-upload-refusal-'));
  const store = await openSqliteStore({ file: join(dir, 'store.sqlite'), role: 'server' });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.agents.create({ id: f.given.agentId, name: 'Fixture' }, f.given.revision);
  f.options.hold = ({ agentId }) => beginSourceIO(store, agentId, 'placement');
  f.destination.undo = async () => { f.state.undone++; };
  const uploadCleanup = Promise.withResolvers(), finishUploadCleanup = Promise.withResolvers();
  let admitted = false;
  const attempt = withHeldFiles(store, {
    project: projectPlacement(f.options),
    files: { hold: async () => assert.fail('fixture preplaces uploads'), release: async () => assert.fail('fixture preplaces uploads'),
      place: async (_run, _agent, launch) => ({ launch: { ...launch, filesPlaced: true }, undo: async () => {
        uploadCleanup.resolve(); await finishUploadCleanup.promise;
        if (cleanupFails) throw new Error('fixture upload cleanup unknown');
        await f.workspace.remove('inputs/upload.csv');
      } }) },
  }, f.given.runId, f.given.agentId, f.given.revision, { ...f.given.launch, files: ['fixture-upload'] }, async () => { admitted = true; assert.fail('a collision cannot be admitted'); });
  const result = assert.rejects(attempt, error => error.code === 'conflict');
  try {
    await uploadCleanup.promise;
    await requireSourceIOIdle(store, f.given.agentId).then(() => assert.fail('pending upload cleanup must protect deletion'), error => assert.equal(error.code, 'agent_not_runnable'));
    assert.equal(admitted, false); assert.equal(f.state.undone, 1);
    assert.equal(await f.control.stat('source-seed.json'), undefined);
  } finally { finishUploadCleanup.resolve(); }
  await result;
  assert.equal(await store.runs.get(f.given.runId), undefined);
  if (cleanupFails) await assert.rejects(requireSourceIOIdle(store, f.given.agentId), error => error.code === 'agent_not_runnable');
  else { await requireSourceIOIdle(store, f.given.agentId); assert.equal(await f.workspace.stat('inputs/upload.csv'), undefined); }
});

test('a failed upload write retains project ownership even after successful destination cleanup', async t => {
  const f = await setup(t, 'local'), failure = new Error('fixture upload outcome unknown');
  f.given.launch.files = ['fixture-upload'];
  f.options.placeUploads = async ({ workspace }) => { await workspace.write('inputs/partial.csv', 'possibly copied'); throw failure; };
  await assert.rejects(projectPlacement(f.options).place(f.given), actual => actual === failure);
  assert.equal(f.state.undone, 1); assert.equal(f.state.ended, 1); assert.equal(f.state.settled, 0);
  assert.equal(await f.control.stat('source-seed.json'), undefined);
});

test('a moved project missing its upload placement capability refuses before seeding', async t => {
  const f = await setup(t, 'local'); f.given.launch.files = ['fixture-upload'];
  await assert.rejects(projectPlacement(f.options).place(f.given), error => error.code === 'prerequisite');
  assert.equal(f.state.undone, 1); assert.equal(f.state.settled, 1);
  assert.equal(await f.control.stat('source-seed.json'), undefined);
});

test('already placed uploads never dispatch another local copy', async t => {
  const f = await setup(t, 'local'); f.given.launch.files = ['fixture-upload']; f.given.launch.filesPlaced = true;
  await f.workspace.write('inputs/upload.csv', 'already placed');
  f.options.placeUploads = async () => assert.fail('an upload is copied only once');
  const placed = await projectPlacement(f.options).place(f.given);
  assert.deepEqual(placed.launch.sourceProject.inputs, ['inputs/upload.csv']);
});

test("a project agent's trigger_firing start that loses to its firing's release undoes its placement and settles its hold: nothing is kept for a run that never exists", async t => {
  const f = await setup(t, 'local');
  const dir = await mkdtemp(join(tmpdir(), 'project-firing-moved-'));
  const store = await openSqliteStore({ file: join(dir, 'store.sqlite'), role: 'server' });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.agents.create({ id: f.given.agentId, name: 'Fixture' }, f.given.revision);
  f.options.hold = ({ agentId }) => beginSourceIO(store, agentId, 'placement');
  // The run's write finds the firing released meanwhile (store.runs.create `firing`): refused, and nothing written.
  const moved = new FiringMoved('trg_fixture', `fir_${'0'.repeat(32)}`);
  await assert.rejects(withHeldFiles(store, { project: projectPlacement(f.options) }, f.given.runId, f.given.agentId, f.given.revision, f.given.launch, async () => { throw moved; }), actual => actual === moved);
  assert.equal(await store.runs.get(f.given.runId), undefined);
  assert.equal(f.state.undone, 1, 'the placement is undone');
  await requireSourceIOIdle(store, f.given.agentId);
});
