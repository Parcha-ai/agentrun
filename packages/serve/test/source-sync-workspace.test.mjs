import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, rm, symlink, writeFile, readFile, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sourceWorkspace, sourceSnapshotReader, sourceRunControl, openRunPlacement } from "../dist/source-sync/workspace.js";
import { agentFolder, sourceSnapshotsFolder, sourceSnapshotsKey, runKey, runFolder, sourceRunControlFolder } from "../dist/workspace/paths.js";
import { saveArchilSettings, storeAgentDisk, agentDiskOf, agentDiskKey } from "../dist/archil-settings.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { sourceSnapshotDigest } from "../dist/native/source-snapshot-types.js";
import { commitSourceSnapshot, seedSourceSnapshot } from "../dist/source-sync/snapshots.js";

async function fixture(t) {
  const data = await mkdtemp(join(tmpdir(), "source-workspace-"));
  const store = await openSqliteStore({ dataDir: data });
  t.after(async () => { await store.close(); await rm(data, { recursive: true, force: true }); });
  return { data, store, sealKey: undefined, env: {} };
}
const absent = path => assert.rejects(lstat(path), { code: "ENOENT" });

test("source snapshots live in an agent-owned private folder outside the run tool root; reads create nothing", async t => {
  const p = await fixture(t), opened = await sourceWorkspace(p.store, "agent-one", p);
  assert.equal(opened.mode, "local");
  await assert.rejects(opened.workspace.read("missing"), error => error.code === "NOT_FOUND");
  await absent(join(p.data, "disk"));
  await opened.workspace.write("blobs/fixture", Buffer.from([0, 255, 128]));
  assert.deepEqual(Buffer.from(await opened.workspace.read("blobs/fixture")), Buffer.from([0, 255, 128]));
  assert.equal((await lstat(sourceSnapshotsFolder(p.data, "agent-one"))).mode & 0o777, 0o700);
  assert.ok(!sourceSnapshotsKey("agent-one").startsWith(runKey("agent-one", "run-one")));
  assert.notEqual(sourceSnapshotsKey("Agent-one"), sourceSnapshotsKey("agent-one"));
  await opened.end();
});

test("a linked agent folder cannot redirect source reads or writes outside server data", async t => {
  const p = await fixture(t), other = await mkdtemp(join(tmpdir(), "source-other-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await mkdir(join(p.data, "disk", "agents"), { recursive: true }); await symlink(other, agentFolder(p.data, "agent-one"));
  const opened = await sourceWorkspace(p.store, "agent-one", p);
  await assert.rejects(opened.workspace.write("blobs/x", "must stay inside"), error => error.code === "ESCAPE");
  await absent(join(other, "source-snapshots"));
});

test("Mode 2 keeps snapshot bytes only on the selected agent disk and respects an explicitly pinned run disk", async t => {
  const p = await fixture(t), current = "dsk-1111111111111111", pinned = "dsk-2222222222222222";
  await saveArchilSettings(p.store, { region: "aws-us-east-1", s3Url: "https://s3.us-east-1.aws.archil.com" });
  await storeAgentDisk(p.store, "agent-one", { diskId: current });
  const control = archilControlFetch({ strict: true, disks: [{ id: current }, { id: pinned }] }), disks = new Map(), made = [];
  const options = { ...p, env: { ARCHIL_API_KEY: "fake-test-key-archil-source" }, control: { ...control, makeDisk: options => {
    made.push(options); const disk = new FakeArchilDisk(); disks.set(options.disk, disk); return disk;
  } } };
  const opened = await sourceWorkspace(p.store, "agent-one", options, { runId: "run-one", launch: { archilDisk: { diskId: pinned, kind: "launch" } } });
  assert.equal(opened.mode, "archil"); assert.equal(opened.launchDisk.diskId, pinned);
  await opened.workspace.write("blobs/x", "disk bytes");
  assert.equal(made[0].disk, pinned);
  assert.equal(Buffer.from(disks.get(pinned).files.get(`${sourceSnapshotsKey("agent-one")}/blobs/x`)).toString(), "disk bytes");
  await absent(join(p.data, "disk"));
  assert.equal(control.requests.filter(r => r.method === "POST").length, 0, "a pinned disk is never replaced");
  await opened.end();
});

test("Mode 2 with unavailable destination credentials refuses rather than writing a local fallback", async t => {
  const p = await fixture(t); await saveArchilSettings(p.store, { region: "aws-us-east-1", s3Url: "https://s3.us-east-1.aws.archil.com" });
  await assert.rejects(sourceWorkspace(p.store, "agent-one", p));
  await absent(join(p.data, "disk"));
});

test("a source-cache reader cannot allocate a missing or purged Mode 2 disk", async t => {
  const p = await fixture(t);
  await saveArchilSettings(p.store, { region: "aws-us-east-1", s3Url: "https://s3.us-east-1.aws.archil.com" });
  const control = archilControlFetch({ strict: true }); let made = 0;
  const options = { ...p, env: { ARCHIL_API_KEY: "fake-test-key-archil-source" }, control: { ...control, makeDisk: () => { made++; return new FakeArchilDisk(); } } };
  await assert.rejects(sourceWorkspace(p.store, "agent-one", options, { readOnly: true }), error => error.code === "prerequisite");
  assert.equal(control.requests.length, 0); assert.equal(made, 0);
  assert.equal(await agentDiskOf(p.store, "agent-one"), undefined);
  await absent(join(p.data, "disk"));
});

test("source-cache reads preserve pending metadata and never write or sweep a retained disk", async t => {
  const p = await fixture(t), diskId = "dsk-4444444444444444", disk = new FakeArchilDisk();
  await saveArchilSettings(p.store, { region: "aws-us-east-1", s3Url: "https://s3.us-east-1.aws.archil.com" });
  const control = archilControlFetch({ strict: true, disks: [{ id: diskId }] });
  const options = { ...p, env: { ARCHIL_API_KEY: "fake-test-key-archil-source" }, control: { ...control, makeDisk: () => disk } };
  for (const mark of [{ pending: true }, { removing: true }]) {
    await storeAgentDisk(p.store, "agent-one", { diskId, ...mark });
    await assert.rejects(sourceWorkspace(p.store, "agent-one", options, { readOnly: true }), error => error.code === "prerequisite");
    assert.deepEqual(await agentDiskOf(p.store, "agent-one"), { diskId, ...mark });
  }
  await storeAgentDisk(p.store, "agent-one", { diskId });
  disk.files.set(`${sourceSnapshotsKey("agent-one")}/kept`, Buffer.from("retained source"));
  const reader = await sourceSnapshotReader(p.store, "agent-one", options);
  assert.equal(Buffer.from(await reader.workspace.read("kept")).toString(), "retained source");
  await assert.rejects(reader.workspace.write("new", "forbidden"), error => error.code === "REFUSED");
  const calls = disk.calls.length; await reader.end(); assert.equal(disk.calls.length, calls, "read close must not sweep any run spill");
  await p.store.settings.remove(agentDiskKey("agent-one"));
  await assert.rejects(sourceWorkspace(p.store, "agent-one", options, { readOnly: true }), error => error.code === "prerequisite");
  assert.equal(control.requests.filter(row => row.method !== "GET").length, 0);
});

test("a parent swapped to a link after opening cannot redirect a later source-cache write", async t => {
  const p = await fixture(t), opened = await sourceWorkspace(p.store, "agent-one", p), other = await mkdtemp(join(tmpdir(), "source-swap-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await opened.workspace.write("first", "kept");
  await rename(agentFolder(p.data, "agent-one"), `${agentFolder(p.data, "agent-one")}-kept`);
  await symlink(other, agentFolder(p.data, "agent-one"));
  await assert.rejects(opened.workspace.write("second", "must not escape"), error => error.code === "ESCAPE");
  await absent(join(other, "source-snapshots"));
});

const gitEnv = { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
async function gitSnapshot(t, detached = false) {
  const root = await mkdtemp(join(tmpdir(), "source-git-")); t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "--quiet", "--initial-branch=feature/source");
  await writeFile(join(root, "tracked.txt"), "committed baseline\n"); await writeFile(join(root, "deleted.txt"), "deleted in working tree\n");
  git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Fixture baseline");
  const head = git(root, "rev-parse", "HEAD").toString().trim();
  const bundle = git(root, "bundle", "create", "-", "HEAD"), blobs = {}, entries = [{ path: "project", role: "project", type: "directory", bytes: 0, mode: 0o750 }];
  const blob = bytes => { const sha256 = createHash("sha256").update(bytes).digest("hex"); blobs[sha256] = Buffer.from(bytes).toString("base64"); return sha256; };
  for (const [path, value, mode] of [["tracked.txt", "dirty work remains dirty\n", 0o640], ["check.sh", "#!/bin/sh\nprintf source\n", 0o755], ["untracked.bin", Buffer.from([0, 255, 128]), 0o600]]) {
    const bytes = Buffer.from(value); entries.push({ path: `project/${path}`, role: "project", type: "file", bytes: bytes.length, mode, sha256: blob(bytes) });
  }
  const snapshot = { version: 1, complete: true, source: { runtime: "codex", machine_id: "fixture", project: "/fixture/project", selector: { kind: "project" } }, entries, blobs,
    instructions: { text: "Keep the source.", layers: [] }, skills: [], configuration: { model: "fixture", tools: [], permissions: {}, credentials: [] },
    project: { git: { head, branch: detached ? null : "feature/source", dirty: true, deleted: ["deleted.txt"], history: "complete", bundle: { sha256: blob(bundle), bytes: bundle.length } } }, blockers: [] };
  return { ...snapshot, digest: sourceSnapshotDigest(snapshot) };
}

for (const detached of [false, true]) test(`local pre-admission preparation restores exact modes, Git baseline and ${detached ? "detached HEAD" : "branch"} without replacing dirty bytes`, async t => {
  const p = await fixture(t), snapshot = await gitSnapshot(t, detached), cache = await sourceWorkspace(p.store, "agent-one", p);
  await commitSourceSnapshot(cache.workspace, snapshot);
  const destination = await openRunPlacement(p.store, { agentId: "agent-one", runId: "run-one", launch: {} }, p);
  await absent(runFolder(p.data, "agent-one", "run-one"));
  await seedSourceSnapshot({ snapshots: cache.workspace, destination: destination.workspace, control: destination.control, digest: snapshot.digest,
    beforeDispatch: true, exclusiveInitialization: true, preparation: destination.preparation });
  const folder = runFolder(p.data, "agent-one", "run-one");
  assert.equal(git(folder, "rev-parse", "HEAD").toString().trim(), snapshot.project.git.head);
  if (detached) assert.throws(() => git(folder, "symbolic-ref", "-q", "HEAD"));
  else assert.equal(git(folder, "symbolic-ref", "HEAD").toString().trim(), "refs/heads/feature/source");
  assert.equal(git(folder, "show", ":tracked.txt").toString(), "committed baseline\n");
  assert.equal(await readFile(join(folder, "tracked.txt"), "utf8"), "dirty work remains dirty\n");
  assert.deepEqual(await readFile(join(folder, "untracked.bin")), Buffer.from([0, 255, 128]));
  for (const [path, mode] of [["", 0o750], ["tracked.txt", 0o640], ["check.sh", 0o755], ["untracked.bin", 0o600]]) assert.equal((await lstat(join(folder, path))).mode & 0o777, mode);
  await absent(join(folder, "deleted.txt")); await absent(join(folder, ".git", "agentrun-source.bundle"));
  assert.equal(git(folder, "remote").toString(), "", "no native credential-bearing remote or configuration was imported");
  assert.equal(JSON.parse(await readFile(join(sourceRunControlFolder(p.data, "agent-one", "run-one"), "source-seed.json"))).phase, "complete");
  await destination.end(); await destination.undo();
  await absent(folder); await absent(sourceRunControlFolder(p.data, "agent-one", "run-one"));
  assert.ok(await cache.workspace.stat(`manifests/${snapshot.digest}.json`), "rollback keeps the immutable source cache");
});

test("placement refuses an admitted run and rollback cannot delete a project after admission", async t => {
  const p = await fixture(t); let admitted = false;
  const store = { ...p.store, runs: { get: async () => admitted ? { id: "run-one" } : undefined } };
  const destination = await openRunPlacement(store, { agentId: "agent-one", runId: "run-one", launch: {} }, p);
  await destination.workspace.write("kept", "run owns this"); admitted = true;
  await assert.rejects(destination.undo(), error => error.code === "unsafe_resume");
  assert.equal(Buffer.from(await destination.workspace.read("kept")).toString(), "run owns this");
  await assert.rejects(openRunPlacement(store, { agentId: "agent-one", runId: "run-one", launch: {} }, p), error => error.code === "unsafe_resume");
});

test("claim receipt reads never seed, allocate missing pinned storage or expose write access", async t => {
  const p = await fixture(t), target = { agentId: "agent-one", runId: "run-one", launch: {} };
  const opened = await sourceRunControl(p.store, target, p);
  await assert.rejects(opened.workspace.read("source-seed.json"), error => error.code === "NOT_FOUND");
  await assert.rejects(opened.workspace.write("source-seed.json", "forged"), error => error.code === "REFUSED");
  await absent(join(p.data, "disk"));
  await saveArchilSettings(p.store, { region: "aws-us-east-1", s3Url: "https://s3.us-east-1.aws.archil.com" });
  const control = archilControlFetch({ strict: true });
  await assert.rejects(sourceRunControl(p.store, target, { ...p, control }), error => error.code === "prerequisite");
  assert.equal(control.requests.length, 0);
});

test("Archil preparation refuses a backend that loses executable modes between execs", async t => {
  const p = await fixture(t), diskId = "dsk-3333333333333333", disk = new FakeArchilDisk();
  await saveArchilSettings(p.store, { region: "aws-us-east-1", s3Url: "https://s3.us-east-1.aws.archil.com" });
  const control = archilControlFetch({ strict: true, disks: [{ id: diskId }] });
  const destination = await openRunPlacement(p.store, { agentId: "agent-one", runId: "run-one", launch: { archilDisk: { diskId, kind: "launch" } } },
    { ...p, env: { ARCHIL_API_KEY: "fake-test-key-archil-source" }, control: { ...control, makeDisk: () => disk } });
  await destination.workspace.write("script.sh", "#!/bin/sh\nprintf checked\n");
  // This fixture persists bytes but deliberately has no mode persistence. A successful chmod in one exec cannot
  // establish that a later run will retain its mode: the independent verification must refuse this backend.
  await assert.rejects(destination.preparation.applyModes(destination.workspace, [{ path: "script.sh", role: "project", type: "file", bytes: 25, mode: 0o755 }]), error => error.code === "prerequisite");
  assert.equal(disk.calls.filter(call => call.op === "exec").length, 2);
  assert.equal(await destination.control.stat("source-seed.json"), undefined);
  await destination.end(); await destination.undo();
});
