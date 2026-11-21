import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkspace, archilWorkspace } from "../dist/workspace/index.js";
import { captureProject } from "../dist/source-sync/capture-project.js";
import { captureGit } from "../dist/source-sync/capture-git.js";
import { sourceSnapshotDigest } from "../dist/native/source-snapshot-types.js";
import { commitSourceSnapshot, seedSourceSnapshot } from "../dist/source-sync/snapshots.js";
import { captureManagedProject, sourceWorkspace, openRunPlacement } from "../dist/source-sync/workspace.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const env = { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
async function git(work, ...args) {
  const answer = await work.exec(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { env, timeoutMs: 3000 });
  assert.equal(answer.code, 0, Buffer.from(answer.stderr).toString()); return Buffer.from(answer.stdout).toString().trim();
}
async function fixture(t, backend) {
  if (backend === "archil") { const disk = new FakeArchilDisk(); return { work: archilWorkspace(disk, "work"), scratch: archilWorkspace(disk, "private/capture") }; }
  const data = await mkdtemp(join(tmpdir(), "capture-git-")); t.after(() => rm(data, { recursive: true, force: true }));
  const root = localWorkspace(data); await root.mkdir("work"); await root.mkdir("private");
  return { data, work: localWorkspace(join(data, "work")), scratch: localWorkspace(join(data, "private")) };
}
function baseline() {
  const s = { version: 1, complete: true, source: { runtime: "codex", machine_id: "fixture", project: "/fixture/project", selector: { kind: "project" } }, entries: [], blobs: {}, instructions: { text: "Original.", layers: [] }, skills: [], configuration: { model: "fixture", tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  return { ...s, digest: sourceSnapshotDigest(s) };
}
async function repository(work) {
  await work.mkdir(""); await git(work, "init", "--quiet", "--template=", "--initial-branch=source-branch");
  await work.write("tracked.txt", "committed\n"); await work.write("deleted.txt", "old\n"); await work.write(".gitignore", "ignored/\n");
  await git(work, "add", "."); await git(work, "commit", "--quiet", "-m", "Baseline");
  const head = await git(work, "rev-parse", "HEAD");
  await work.write("tracked.txt", "changed\n"); await work.remove("deleted.txt"); await work.write("new.bin", Buffer.from([0, 255, 128]));
  await work.write("ignored/large.bin", Buffer.alloc(9000, 7)); await work.write("inputs/message.md", "host prompt\n"); return head;
}
const exclude = [{ path: "inputs/message.md", recursive: false }];
const capture = (p, extra = {}) => captureProject({ workspace: p.work, baseline: baseline(), exclude, git: (work, options) => captureGit(work, p.scratch, options), ...extra });

for (const backend of ["local", "archil"]) test(`${backend}: isolated Git capture retains history, branch, dirty bytes and deletion without reading ignored bodies`, async t => {
  const p = await fixture(t, backend), head = await repository(p.work); let ignoredRead = false;
  const read = p.work.read.bind(p.work); p.work.read = async (path, options) => { if (path.startsWith("ignored/")) ignoredRead = true; return read(path, options); };
  const snapshot = await capture(p, { limits: { fileBytes: 8192 } });
  assert.equal(snapshot.project.git.head, head); assert.equal(snapshot.project.git.branch, "source-branch");
  assert.equal(snapshot.project.git.history, "complete"); assert.equal(snapshot.project.git.dirty, true); assert.deepEqual(snapshot.project.git.deleted, ["deleted.txt"]);
  assert.ok(snapshot.project.git.bundle.bytes > 0); assert.equal(ignoredRead, false);
  assert.ok(!snapshot.entries.some(entry => entry.path.includes("ignored/") || entry.path === "project/inputs/message.md"));
  const entry = snapshot.entries.find(entry => entry.path === "project/new.bin"); assert.deepEqual(Buffer.from(snapshot.blobs[entry.sha256], "base64"), Buffer.from([0, 255, 128]));
});

test("a source config replaced after its first read is never consumed by Git", async t => {
  const p = await fixture(t, "local"); await repository(p.work); const original = p.work.read.bind(p.work); let replaced = false, sourceGitCalls = 0;
  p.work.read = async (path, options) => { const bytes = await original(path, options); if (path === ".git/config" && !replaced) { replaced = true; await p.work.write(path, '[include]\n path = /fixture/unauthorized-config\n'); } return bytes; };
  const exec = p.work.exec.bind(p.work); p.work.exec = async (args, options) => { if (args[0] === "git") sourceGitCalls++; return exec(args, options); };
  await assert.rejects(capture(p), error => error.code === "conflict");
  assert.equal(sourceGitCalls, 0); assert.equal(Buffer.from(await p.scratch.read("database/config")).toString().includes("include"), false);
});

test("staged changes and credential-bearing or host-input history refuse an apparently complete checkpoint", async t => {
  for (const mode of ["staged", "secret-history", "host-history"]) {
    const p = await fixture(t, "local"); await repository(p.work);
    if (mode === "staged") await git(p.work, "add", "tracked.txt");
    else {
      const path = mode === "host-history" ? "inputs/message.md" : "old.txt";
      await p.work.write(path, "fixture-private-history\n"); await git(p.work, "add", path); await git(p.work, "commit", "--quiet", "-m", "Historical content");
      await p.work.remove(path); await git(p.work, "add", path); await git(p.work, "commit", "--quiet", "-m", "Removed historical content");
    }
    await assert.rejects(capture(p, { secretValues: ["fixture-private-history"] }), error => error.code === "prerequisite");
  }
});

test("a late Git write cannot pass the final checkpoint verification", async t => {
  const p = await fixture(t, "local"); await repository(p.work);
  await assert.rejects(capture(p, { git: async (work, options) => { const captured = await captureGit(work, p.scratch, options); await work.write(".git/HEAD", "ref: refs/heads/later\n"); return captured; } }), error => error.code === "conflict");
});

test("held credentials in branch metadata are withheld even when history contains only harmless bytes", async t => {
  const p = await fixture(t, "local"), held = "fixture-private-branch"; await repository(p.work);
  await git(p.work, "branch", "-m", `feature/${held}`);
  await assert.rejects(capture(p, { secretValues: [held] }), error => error.code === "prerequisite" && !error.message.includes(held));
});

test("real local managed capture cleans private scratch and seeds a new run with the current Git project", async t => {
  const p = await fixture(t, "local"), store = { settings: { get: async () => undefined }, sealedKeys: { get: async () => undefined }, runs: { get: async () => undefined } };
  const options = { data: p.data, sealKey: undefined, env: {} }, first = await openRunPlacement(store, { agentId: "agent", runId: "first", launch: {} }, options);
  const head = await repository(first.workspace);
  const snapshot = await captureManagedProject(store, { agentId: "agent", runId: "first", launch: {}, workspace: first.workspace, baseline: baseline(), exclude }, options);
  assert.deepEqual(await first.control.list(""), [], "private Git scratch is removed after all commands settle");
  const cache = await sourceWorkspace(store, "agent", options); await commitSourceSnapshot(cache.workspace, snapshot);
  const next = await openRunPlacement(store, { agentId: "agent", runId: "next", launch: {} }, options);
  await seedSourceSnapshot({ snapshots: cache.workspace, destination: next.workspace, control: next.control, digest: snapshot.digest, beforeDispatch: true, exclusiveInitialization: true, preparation: next.preparation });
  assert.equal(await git(next.workspace, "rev-parse", "HEAD"), head); assert.equal(await git(next.workspace, "branch", "--show-current"), "source-branch");
  assert.equal(Buffer.from(await next.workspace.read("tracked.txt")).toString(), "changed\n"); assert.equal(await next.workspace.stat("deleted.txt"), undefined);
  assert.equal(await next.workspace.stat("inputs/message.md"), undefined);
  assert.equal((await git(next.workspace, "show", "HEAD:tracked.txt")), "committed");
});
