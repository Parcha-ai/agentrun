import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkspace, archilWorkspace } from "../dist/workspace/index.js";
import { captureProject } from "../dist/source-sync/capture-project.js";
import { sourceSnapshotDigest } from "../dist/native/source-snapshot-types.js";
import { commitSourceSnapshot, seedSourceSnapshot } from "../dist/source-sync/snapshots.js";
import { openRunPlacement, sourceWorkspace } from "../dist/source-sync/workspace.js";
import { runFolder } from "../dist/workspace/paths.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function baseline() {
  const blobs = {}, entries = [];
  for (const [path, role, text] of [["project/keep.txt", "project", "before\n"], ["project/delete.txt", "project", "delete me\n"], ["project/inputs/project-notes.txt", "project", "source project input\n"], ["instructions/000/AGENTS.md", "instruction", "Original source instructions.\n"], ["skills/source/check/SKILL.md", "skill", "Use assets/input.bin.\n"], ["skills/source/check/assets/input.bin", "skill", Buffer.from([0, 255, 1])]]) {
    const bytes = Buffer.from(text), sha256 = digest(bytes); blobs[sha256] = bytes.toString("base64");
    entries.push({ path, role, type: "file", mode: 0o644, bytes: bytes.length, sha256 });
  }
  const value = { version: 1, complete: true, source: { runtime: "codex", machine_id: "fixture", project: "/fixture/project", selector: { kind: "project" } }, entries, blobs,
    instructions: { text: "Original source instructions.\n", layers: [{ path: "instructions/000/AGENTS.md", precedence: 0, source: "source fixture" }] },
    skills: [{ name: "check", path: "skills/source/check", source: "source fixture" }], configuration: { model: "fixture-model", tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  return { ...value, digest: sourceSnapshotDigest(value) };
}
async function fixture(t, backend) {
  if (backend === "archil") return { work: archilWorkspace(new FakeArchilDisk(), "fixture/project") };
  const root = await mkdtemp(join(tmpdir(), "project-capture-")); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, work: localWorkspace(root) };
}
async function current(work) {
  await work.write("keep.txt", "after\n"); await work.write("new.bin", Buffer.from([0, 128, 255]));
  await work.write("inputs/project-notes.txt", "source project input\n"); await work.write("inputs/message.md", "host-owned turn input\n");
  await work.write(".agents/skills/check/SKILL.md", "Use assets/input.bin.\n");
  await work.write(".agents/skills/check/assets/input.bin", Buffer.from([9, 0, 255]));
}
const exclude = [{ path: "inputs/message.md", recursive: false }];
const bytesOf = (snapshot, path) => Buffer.from(snapshot.blobs[snapshot.entries.find(entry => entry.path === path).sha256], "base64");

for (const backend of ["local", "archil"]) test(`${backend}: capture preserves source configuration while recording additions, deletions and current binary skill assets`, async t => {
  const { work } = await fixture(t, backend), before = baseline(), original = structuredClone(before); await current(work);
  const after = await captureProject({ workspace: work, baseline: before, exclude });
  assert.deepEqual(after.source, before.source); assert.deepEqual(after.instructions, before.instructions); assert.deepEqual(after.configuration, before.configuration);
  assert.deepEqual(after.skills, before.skills); assert.equal(after.complete, true); assert.deepEqual(after.blockers, []);
  assert.equal(bytesOf(after, "project/keep.txt").toString(), "after\n"); assert.deepEqual(bytesOf(after, "project/new.bin"), Buffer.from([0, 128, 255]));
  assert.deepEqual(bytesOf(after, "skills/source/check/assets/input.bin"), Buffer.from([9, 0, 255]));
  assert.ok(after.entries.some(entry => entry.path === "project/inputs/project-notes.txt"));
  assert.ok(!after.entries.some(entry => entry.path === "project/inputs/message.md" || entry.path === "project/delete.txt"));
  assert.equal(after.digest, sourceSnapshotDigest(after)); assert.notEqual(after.digest, before.digest); assert.deepEqual(before, original);
});

test("local capture and a fresh run preserve task edits, deletion and executable modes across the immutable checkpoint", async t => {
  const data = await mkdtemp(join(tmpdir(), "project-continuity-")); t.after(() => rm(data, { recursive: true, force: true }));
  const store = { settings: { get: async () => undefined }, sealedKeys: { get: async () => undefined }, runs: { get: async () => undefined } }, options = { data, sealKey: undefined, env: {} };
  const cache = await sourceWorkspace(store, "fixture-agent", options), before = baseline(); await commitSourceSnapshot(cache.workspace, before);
  const first = await openRunPlacement(store, { agentId: "fixture-agent", runId: "first", launch: {} }, options);
  await seedSourceSnapshot({ snapshots: cache.workspace, destination: first.workspace, control: first.control, digest: before.digest, preparation: first.preparation, beforeDispatch: true, exclusiveInitialization: true });
  await current(first.workspace); await first.workspace.remove("delete.txt"); await first.workspace.write("run.sh", "#!/bin/sh\nprintf kept\n"); await chmod(join(runFolder(data, "fixture-agent", "first"), "run.sh"), 0o755);
  const checkpoint = await captureProject({ workspace: first.workspace, baseline: before, exclude }); await commitSourceSnapshot(cache.workspace, checkpoint);
  const second = await openRunPlacement(store, { agentId: "fixture-agent", runId: "second", launch: {} }, options);
  await seedSourceSnapshot({ snapshots: cache.workspace, destination: second.workspace, control: second.control, digest: checkpoint.digest, preparation: second.preparation, beforeDispatch: true, exclusiveInitialization: true });
  assert.equal(Buffer.from(await second.workspace.read("keep.txt")).toString(), "after\n"); assert.equal(await second.workspace.stat("delete.txt"), undefined);
  assert.deepEqual(Buffer.from(await second.workspace.read("new.bin")), Buffer.from([0, 128, 255]));
  const result = await second.workspace.exec(["./run.sh"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 1000 });
  assert.equal(result.code, 0); assert.equal(Buffer.from(result.stdout).toString(), "kept");
});

test("capture refuses source collisions with host exclusions, secret-bearing files and unsupported links", async t => {
  const { root, work } = await fixture(t, "local"); await current(work);
  await assert.rejects(captureProject({ workspace: work, baseline: baseline(), exclude: [{ path: "inputs/project-notes.txt", recursive: false }] }), error => error.code === "conflict");
  await work.write(".env", "fixture value");
  await assert.rejects(captureProject({ workspace: work, baseline: baseline(), exclude }), error => error.code === "prerequisite");
  await work.remove(".env"); await symlink("keep.txt", join(root, "linked"));
  await assert.rejects(captureProject({ workspace: work, baseline: baseline(), exclude }), error => error.code === "prerequisite");
});

test("a late write or cancelled capture never returns an apparently complete checkpoint", async t => {
  const { work } = await fixture(t, "local"); await current(work); let mutated = false;
  const raced = new Proxy(work, { get(target, key) {
    if (key === "read") return async (path, options) => { const bytes = await target.read(path, options); if (!mutated) { mutated = true; await target.write("keep.txt", "late writer\n"); } return bytes; };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(captureProject({ workspace: raced, baseline: baseline(), exclude }), error => error.code === "conflict");
  const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
  await assert.rejects(captureProject({ workspace: work, baseline: baseline(), exclude, signal: controller.signal }), /fixture cancelled/);
});

test("Git capture without a safe isolated metadata capability is an explicit prerequisite", async t => {
  const { work } = await fixture(t, "local"); await current(work); await work.mkdir(".git");
  await assert.rejects(captureProject({ workspace: work, baseline: baseline(), exclude }), error => error.code === "prerequisite");
});

test("a held credential in a directory name is withheld without echoing its value", async t => {
  const { work } = await fixture(t, "local"), held = "fixture-private-value"; await current(work);
  await work.mkdir(`cache-${held}`);
  await assert.rejects(captureProject({ workspace: work, baseline: baseline(), exclude, secretValues: [held] }), error => error.code === "prerequisite" && !error.message.includes(held));
});

test("literal host filenames cannot glob-match and omit another project directory", async t => {
  const { work } = await fixture(t, "local"); await current(work);
  await work.write("inputs/[owned]", "runtime upload\n"); await work.write("inputs/o/kept.txt", "project content\n");
  const after = await captureProject({ workspace: work, baseline: baseline(), exclude: [...exclude, { path: "inputs/[owned]", recursive: false }] });
  assert.ok(after.entries.some(entry => entry.path === "project/inputs/o/kept.txt"), "only the exact owned filename is excluded");
  assert.equal(bytesOf(after, "project/inputs/o/kept.txt").toString(), "project content\n");
  assert.ok(!after.entries.some(entry => entry.path === "project/inputs/[owned]"));
});

function hooksBaseline(external) {
  const s = baseline(), runtime = s.source.runtime, project = s.source.project;
  const command = ["/fixture/bin/node", "/fixture/app/cli-learning/entry.js", "learning", "hook", "--runtime", runtime, "--project", project, "--data", "/fixture/data", "--url", "http://127.0.0.1:7340/"].map(value => `'${value}'`).join(" ");
  const handlers = Object.fromEntries(["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"].map(event => [event, { type: "command", timeout: 5, command }]));
  const original = Buffer.from(JSON.stringify({ permission: "kept", hooks: Object.fromEntries(Object.entries(handlers).map(([event, handler]) => [event, [{ hooks: [handler] }]])) }));
  const receipt = Buffer.from(JSON.stringify({ version: external ? 2 : 1, runtime, project, dataDir: "/fixture/data", url: "http://127.0.0.1:7340/", hadHooks: false, createdEvents: Object.keys(handlers), handlers, ...(external ? { configRoot: "/fixture/main", format: "codex-shared-json" } : {}) }));
  const path = external ? "instructions/capture-hooks/012345abcdef/hooks.json" : "project/.codex/hooks.json", receiptPath = `project/.agentrun/cli-learning/${runtime}.json`, replacement = Buffer.from('{\n  "permission": "kept"\n}\n');
  for (const [name, role, bytes] of [[path, external ? "instruction" : "project", original], [receiptPath, "project", receipt]]) {
    s.entries.push({ path: name, role, type: "file", mode: 0o644, bytes: bytes.length, sha256: digest(bytes) }); s.blobs[digest(bytes)] = bytes.toString("base64");
  }
  s.blobs[digest(replacement)] = replacement.toString("base64");
  s.transforms = [{ kind: "agentrun-capture-hooks", path, original_sha256: digest(original), original_bytes: original.length, destination_sha256: digest(replacement), destination_bytes: replacement.length, receipt: { path: receiptPath, sha256: digest(receipt) } }];
  return { snapshot: { ...s, digest: sourceSnapshotDigest(s) }, receipt, replacement };
}

for (const external of [false, true]) test(`checkpoint keeps hook removal applied and preserves external provenance: ${external}`, async t => {
  const { work } = await fixture(t, "local"), { snapshot, receipt, replacement } = hooksBaseline(external); await current(work);
  await work.write(".agentrun/cli-learning/codex.json", receipt);
  if (!external) await work.write(".codex/hooks.json", replacement);
  const after = await captureProject({ workspace: work, baseline: snapshot, exclude });
  assert.equal(after.transforms?.length ?? 0, external ? 1 : 0);
  if (!external) assert.deepEqual(bytesOf(after, "project/.codex/hooks.json"), replacement);
  else assert.deepEqual(Buffer.from(after.blobs[after.transforms[0].destination_sha256], "base64"), replacement);
  assert.equal(snapshot.transforms.length, 1, "original source provenance stays immutable");
});
