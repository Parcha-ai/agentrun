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
