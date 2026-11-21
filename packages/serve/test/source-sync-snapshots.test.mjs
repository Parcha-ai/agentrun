import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkspace, archilWorkspace } from "../dist/workspace/index.js";
import { sourceSnapshotDigest } from "../dist/native/source-snapshot-types.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { commitSourceSnapshot, readSourceSnapshot, seedSourceSnapshot, validateSourceSnapshot } from "../dist/source-sync/snapshots.js";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const signed = snapshot => ({ ...snapshot, digest: sourceSnapshotDigest(snapshot) });
function fixture({ git = false } = {}) {
  const blobs = {}, entries = [];
  const file = (path, role, data, mode = 0o644) => {
    const bytes = Buffer.from(data), id = sha(bytes); blobs[id] = bytes.toString("base64");
    entries.push({ path, role, type: "file", mode, bytes: bytes.length, sha256: id });
  };
  entries.push({ path: "project", role: "project", type: "directory", mode: 0o750, bytes: 0 });
  file("project/dirty.txt", "project", "dirty source\n");
  file("project/untracked.bin", "project", Uint8Array.of(0, 255, 128, 13, 10));
  file("project/AGENTS.md", "project", "Project instructions.\n");
  file("instructions/000/AGENTS.md", "instruction", "Parent instructions.\n");
  entries.push({ path: "skills/abc/check", role: "skill", type: "directory", mode: 0o755, bytes: 0 });
  file("skills/abc/check/SKILL.md", "skill", "Use scripts/check.sh and assets/reference.bin.\n");
  file("skills/abc/check/scripts/check.sh", "skill", "#!/bin/sh\nprintf checked\n", 0o755);
  file("skills/abc/check/assets/reference.bin", "skill", Uint8Array.of(0, 129, 254, 255));
  let metadata = null;
  if (git) {
    const bundle = Buffer.from("fixture bundle bytes"), id = sha(bundle); blobs[id] = bundle.toString("base64");
    metadata = { head: "a".repeat(40), branch: "main", dirty: true, deleted: ["deleted.txt"], bundle: { sha256: id, bytes: bundle.length }, history: "complete" };
  }
  return signed({ version: 1, complete: true, source: { runtime: "codex", machine_id: "fixture", project: "/fixture/project", selector: { kind: "project" } }, entries, blobs,
    instructions: { text: "Parent instructions.\n", layers: [{ path: "instructions/000/AGENTS.md", precedence: 0, source: "fixture-parent" }] },
    skills: [{ name: "check", path: "skills/abc/check", source: "fixture-skill" }], configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: metadata }, blockers: [] });
}
const wraps = (work, overrides) => new Proxy(work, { get(target, key) { const value = overrides[key] ?? Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
async function places(t, backend) {
  if (backend === "archil") {
    const disk = new FakeArchilDisk();
    return { disk, exclusiveInitialization: true, snapshots: archilWorkspace(disk, "fixture/snapshots"), destination: archilWorkspace(disk, "fixture/run/work"), control: archilWorkspace(disk, "fixture/run/private") };
  }
  const root = await mkdtemp(join(tmpdir(), "source-snapshots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["snapshots", "destination", "control"]) await mkdir(join(root, name));
  return { root, exclusiveInitialization: true, snapshots: localWorkspace(join(root, "snapshots")), destination: localWorkspace(join(root, "destination")), control: localWorkspace(join(root, "control")) };
}
const refuses = (promise, code) => assert.rejects(promise, error => error.code === code);
// This is an injected capability receipt, not evidence of backend chmod/Git support. The resolver's own tests must
// verify the real executor's implementation; this suite proves ordering, bytes, and failure/continuation semantics.
const preparation = seen => ({ applyModes: async (_work, entries) => { seen.push({ modes: entries }); }, restoreGit: async (_work, git, bundle) => { seen.push({ git, bundle: Buffer.from(bundle) }); } });

for (const backend of ["local", "archil"]) {
  test(`${backend}: committed snapshots round-trip binary assets, exact modes and Git metadata without rewriting`, async t => {
    const p = await places(t, backend), snapshot = fixture({ git: true });
    const writes = [], traced = wraps(p.snapshots, { write: async (path, bytes) => { writes.push(path); await p.snapshots.write(path, bytes); } });
    assert.equal(await commitSourceSnapshot(traced, snapshot), snapshot.digest);
    assert.equal(writes.at(-1), `manifests/${snapshot.digest}.json`, "complete manifest is the last write");
    assert.deepEqual(await readSourceSnapshot(p.snapshots, snapshot.digest), snapshot);
    const count = writes.length;
    await commitSourceSnapshot(traced, snapshot);
    assert.equal(writes.length, count, "idempotent snapshot commit writes nothing");
    if (p.disk) for (const call of p.disk.calls) if (call.key) assert.ok(call.key.startsWith("fixture/snapshots/"));
  });

  test(`${backend}: interrupted content writes never expose a committed manifest; retry completes`, async t => {
    const p = await places(t, backend), snapshot = fixture(); let written = 0;
    const interrupted = wraps(p.snapshots, { write: async (path, bytes) => { if (++written === 2) throw new Error("fixture interrupted write"); await p.snapshots.write(path, bytes); } });
    await assert.rejects(commitSourceSnapshot(interrupted, snapshot), /fixture interrupted/);
    await refuses(readSourceSnapshot(p.snapshots, snapshot.digest), "missing");
    await commitSourceSnapshot(p.snapshots, snapshot);
    assert.deepEqual(await readSourceSnapshot(p.snapshots, snapshot.digest), snapshot);
  });

  test(`${backend}: corrupt content, unsafe namespaces and size limits refuse before any destination write`, async t => {
    const p = await places(t, backend), snapshot = fixture(); let writes = 0;
    const traced = wraps(p.snapshots, { write: async () => { writes++; } });
    const corrupt = structuredClone(snapshot); corrupt.blobs[Object.keys(corrupt.blobs)[0]] = Buffer.from("wrong").toString("base64");
    await assert.rejects(commitSourceSnapshot(traced, corrupt));
    const unsafe = structuredClone(snapshot); unsafe.entries[1].path = "project/../../escape";
    await refuses(commitSourceSnapshot(traced, signed(unsafe)), "invalid");
    const wrongRole = structuredClone(snapshot); wrongRole.entries[1].path = "skills/another/file";
    await refuses(commitSourceSnapshot(traced, signed(wrongRole)), "invalid");
    await refuses(commitSourceSnapshot(traced, snapshot, { files: 1 }), "limit");
    await refuses(commitSourceSnapshot(traced, { ...snapshot, digest: "0".repeat(64) }), "corrupt");
    assert.equal(writes, 0);
    await commitSourceSnapshot(p.snapshots, snapshot);
    await p.snapshots.write(`blobs/${snapshot.entries[1].sha256}`, "wrong");
    await refuses(readSourceSnapshot(p.snapshots, snapshot.digest), "corrupt");
    await refuses(commitSourceSnapshot(p.snapshots, snapshot), "corrupt", "no silent repair of immutable committed content");
  });

  test(`${backend}: missing execution capability refuses before seeding; complete marker preserves later edits`, async t => {
    const p = await places(t, backend), snapshot = fixture({ git: true }), seen = [];
    await commitSourceSnapshot(p.snapshots, snapshot);
    const options = { ...p, digest: snapshot.digest, beforeDispatch: true };
    await refuses(seedSourceSnapshot(options), "prerequisite");
    assert.equal(await p.destination.stat("dirty.txt"), undefined);
    assert.equal(await p.control.stat("source-seed.json"), undefined);
    await p.destination.write("inputs/user.txt", "unrelated input");
    assert.deepEqual(await seedSourceSnapshot({ ...options, preparation: preparation(seen) }), { seeded: true });
    assert.equal(seen[0].git.head, snapshot.project.git.head, "Git metadata restored before final modes");
    assert.ok(seen[1].modes.some(entry => entry.path === ".agents/skills/check/scripts/check.sh" && entry.mode === 0o755));
    assert.ok(seen[1].modes.some(entry => entry.path === "" && entry.mode === 0o750), "source root mode is not lost");
    assert.deepEqual(Array.from(await p.destination.read("untracked.bin")), [0, 255, 128, 13, 10]);
    assert.equal(Buffer.from(await p.destination.read("inputs/user.txt")).toString(), "unrelated input");
    assert.equal(await p.destination.stat("instructions"), undefined, "separate instruction layers are not duplicated");
    await p.destination.write("dirty.txt", "task edit");
    await p.destination.remove(".agents/skills/check/scripts/check.sh");
    assert.deepEqual(await seedSourceSnapshot({ ...options, beforeDispatch: false }), { seeded: false });
    assert.equal(Buffer.from(await p.destination.read("dirty.txt")).toString(), "task edit");
    assert.equal(await p.destination.stat(".agents/skills/check/scripts/check.sh"), undefined, "reclaim does not restore task deletions");
    const later = signed({ ...snapshot, configuration: { ...snapshot.configuration, model: "later-model" } });
    await commitSourceSnapshot(p.snapshots, later);
    await refuses(seedSourceSnapshot({ ...options, digest: later.digest, preparation: preparation([]) }), "conflict");
    assert.equal(Buffer.from(await p.destination.read("dirty.txt")).toString(), "task edit", "another snapshot cannot reseed this run");
  });

  test(`${backend}: interrupted seed requires pre-dispatch evidence and never overwrites changed files`, async t => {
    const p = await places(t, backend), snapshot = fixture(); await commitSourceSnapshot(p.snapshots, snapshot);
    const options = { ...p, digest: snapshot.digest, beforeDispatch: true, preparation: preparation([]) };
    await refuses(seedSourceSnapshot({ ...options, beforeDispatch: false }), "unsafe_resume");
    await refuses(seedSourceSnapshot({ ...options, exclusiveInitialization: false }), "unsafe_resume");
    let wrote = 0;
    const destination = wraps(p.destination, { write: async (path, bytes) => { await p.destination.write(path, bytes); if (++wrote === 2) throw new Error("seed interrupted"); } });
    await assert.rejects(seedSourceSnapshot({ ...options, destination }), /seed interrupted/);
    assert.equal(JSON.parse(Buffer.from(await p.control.read("source-seed.json")).toString()).phase, "writing");
    await refuses(seedSourceSnapshot({ ...options, beforeDispatch: false }), "unsafe_resume");
    await p.destination.write("dirty.txt", "owner edit while interrupted");
    await refuses(seedSourceSnapshot(options), "conflict");
    assert.equal(Buffer.from(await p.destination.read("dirty.txt")).toString(), "owner edit while interrupted");
  });

  test(`${backend}: interrupted seed resumes identical files and refuses unrelated collisions`, async t => {
    const p = await places(t, backend), snapshot = fixture(); await commitSourceSnapshot(p.snapshots, snapshot);
    const options = { ...p, digest: snapshot.digest, beforeDispatch: true };
    await p.destination.write("dirty.txt", "existing input");
    await refuses(seedSourceSnapshot({ ...options, preparation: preparation([]) }), "conflict");
    assert.equal(await p.control.stat("source-seed.json"), undefined);
    await p.destination.remove("dirty.txt");
    await assert.rejects(seedSourceSnapshot({ ...options, preparation: { applyModes: async () => { throw new Error("mode preparation failed"); } } }), /mode preparation failed/);
    assert.equal(JSON.parse(Buffer.from(await p.control.read("source-seed.json")).toString()).phase, "writing");
    await seedSourceSnapshot({ ...options, preparation: preparation([]) });
    assert.equal(JSON.parse(Buffer.from(await p.control.read("source-seed.json")).toString()).phase, "complete");
  });

  test(`${backend}: Git restoration refuses preexisting metadata or a path the source deleted`, async t => {
    const p = await places(t, backend), snapshot = fixture({ git: true }); await commitSourceSnapshot(p.snapshots, snapshot);
    const options = { ...p, digest: snapshot.digest, beforeDispatch: true, preparation: preparation([]) };
    await p.destination.write(".git/HEAD", "existing repository");
    await refuses(seedSourceSnapshot(options), "conflict");
    assert.equal(await p.control.stat("source-seed.json"), undefined);
    assert.equal(Buffer.from(await p.destination.read(".git/HEAD")).toString(), "existing repository");
    await p.destination.remove(".git", { recursive: true });
    await p.destination.write("deleted.txt", "unrelated upload");
    await refuses(seedSourceSnapshot(options), "conflict");
    assert.equal(Buffer.from(await p.destination.read("deleted.txt")).toString(), "unrelated upload");
  });

  test(`${backend}: differing project/skill collisions and altered prepared bytes never receive a completion marker`, async t => {
    const p = await places(t, backend), snapshot = fixture();
    snapshot.entries.push({ ...snapshot.entries.find(entry => entry.path === "project/dirty.txt"), path: "project/.agents/skills/check/SKILL.md" });
    const conflict = signed(snapshot); await commitSourceSnapshot(p.snapshots, conflict);
    await refuses(seedSourceSnapshot({ ...p, digest: conflict.digest, beforeDispatch: true, preparation: preparation([]) }), "conflict");
    assert.equal(await p.control.stat("source-seed.json"), undefined);
    const clean = fixture(); await commitSourceSnapshot(p.snapshots, clean);
    await refuses(seedSourceSnapshot({ ...p, digest: clean.digest, beforeDispatch: true, preparation: { applyModes: async work => { await work.write("dirty.txt", "unexpected edit"); } } }), "corrupt");
    assert.equal(JSON.parse(Buffer.from(await p.control.read("source-seed.json")).toString()).phase, "writing");
  });
}

test("incomplete diagnostics are validated without persistence or claiming readiness", async t => {
  const p = await places(t, "local"), snapshot = fixture();
  const partial = signed({ ...snapshot, complete: false, project: { git: { head: null, branch: "main", dirty: true, deleted: [], history: "unavailable" } }, blockers: [{ code: "git_unborn", message: "Create an initial commit." }] });
  validateSourceSnapshot(partial);
  await refuses(commitSourceSnapshot(p.snapshots, partial), "incomplete");
  assert.equal(await p.snapshots.stat("manifests"), undefined);
  const unsafe = structuredClone(partial); unsafe.entries[1].path = "project/../escape";
  assert.throws(() => validateSourceSnapshot(signed(unsafe)), error => error.code === "invalid");
});

test("materialized byte limits count duplicate files even when their content blob is shared", () => {
  const snapshot = fixture();
  const uniqueBytes = Object.values(snapshot.blobs).reduce((sum, blob) => sum + Buffer.from(blob, "base64").length, 0);
  snapshot.entries.push({ ...snapshot.entries.find(entry => entry.path === "project/dirty.txt"), path: "project/copy.txt" });
  assert.throws(() => validateSourceSnapshot(signed(snapshot), { bytes: uniqueBytes }), error => error.code === "limit");
});

test("nested destination links are refused and outside bytes remain unchanged", async t => {
  const p = await places(t, "local"), snapshot = fixture(); await commitSourceSnapshot(p.snapshots, snapshot);
  const outside = join(p.root, "outside"); await mkdir(outside); await writeFile(join(outside, "sentinel"), "untouched");
  await mkdir(join(p.root, "destination", ".agents")); await symlink(outside, join(p.root, "destination", ".agents", "skills"));
  await assert.rejects(seedSourceSnapshot({ ...p, digest: snapshot.digest, beforeDispatch: true, preparation: preparation([]) }));
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched");
  assert.equal(await p.control.stat("source-seed.json"), undefined);
});

function transformedFixture({ external = false, destination } = {}) {
  const snapshot = fixture(), runtime = snapshot.source.runtime, project = snapshot.source.project;
  const command = ['/fixture/bin/node', '/fixture/app/cli-learning/entry.js', 'learning', 'hook', '--runtime', runtime, '--project', project, '--data', '/fixture/data', '--url', 'http://127.0.0.1:7340/'].map(value => `'${value}'`).join(' ');
  const handlers = Object.fromEntries(['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'].map(event => [event, { type: 'command', timeout: 5, command }]));
  const original = Buffer.from(JSON.stringify({ permission: 'kept', hooks: Object.fromEntries(Object.entries(handlers).map(([event, handler]) => [event, [{ hooks: [handler] }]])) }));
  const receipt = Buffer.from(JSON.stringify({ version: external ? 2 : 1, runtime, project, dataDir: '/fixture/data', url: 'http://127.0.0.1:7340/', hadHooks: false, createdEvents: Object.keys(handlers), handlers,
    ...(external ? { configRoot: '/fixture/main', format: 'codex-shared-json' } : {}) }));
  const put = (path, role, bytes) => { const id = sha(bytes); snapshot.blobs[id] = bytes.toString('base64'); snapshot.entries.push({ path, role, type: 'file', mode: 0o640, bytes: bytes.length, sha256: id }); return id; };
  const path = external ? 'instructions/capture-hooks/012345abcdef/hooks.json' : 'project/.codex/hooks.json';
  const receiptPath = `project/.agentrun/cli-learning/${runtime}.json`;
  const originalHash = put(path, external ? 'instruction' : 'project', original), receiptHash = put(receiptPath, 'project', receipt);
  const replacement = destination ?? Buffer.from('{\n  "permission": "kept"\n}\n');
  snapshot.blobs[sha(replacement)] = replacement.toString('base64');
  snapshot.transforms = [{ kind: 'agentrun-capture-hooks', path, original_sha256: originalHash, original_bytes: original.length,
    destination_sha256: sha(replacement), destination_bytes: replacement.length, receipt: { path: receiptPath, sha256: receiptHash } }];
  return { snapshot: signed(snapshot), original, replacement, path };
}

for (const backend of ['local', 'archil']) test(`${backend}: an owned capture-hook transform keeps immutable originals but seeds only independently reproduced destination bytes`, async t => {
  const p = await places(t, backend), { snapshot, original, replacement } = transformedFixture();
  await commitSourceSnapshot(p.snapshots, snapshot);
  const read = await readSourceSnapshot(p.snapshots, snapshot.digest);
  assert.deepEqual(Buffer.from(read.blobs[snapshot.transforms[0].original_sha256], 'base64'), original);
  await seedSourceSnapshot({ ...p, digest: snapshot.digest, beforeDispatch: true, preparation: preparation([]) });
  assert.deepEqual(Buffer.from(await p.destination.read('.codex/hooks.json')), replacement);
});

test('external shared capture hooks are retained and validated without creating an ambient instruction file', async t => {
  const p = await places(t, 'local'), { snapshot } = transformedFixture({ external: true });
  await commitSourceSnapshot(p.snapshots, snapshot);
  await seedSourceSnapshot({ ...p, digest: snapshot.digest, beforeDispatch: true, preparation: preparation([]) });
  assert.equal(await p.destination.stat('instructions'), undefined);
  assert.equal(await p.destination.stat('.codex/hooks.json'), undefined);
});

test('a valid digest cannot authorize arbitrary hook rewrites, a swapped receipt, duplicate targets or an unrelated target path', async t => {
  const p = await places(t, 'local'); let writes = 0;
  const work = wraps(p.snapshots, { write: async () => { writes++; } });
  await assert.rejects(commitSourceSnapshot(work, transformedFixture({ destination: Buffer.from('{"permission":"unsafe"}') }).snapshot));
  for (const mutate of [
    s => { s.transforms[0].receipt.sha256 = s.entries[1].sha256; },
    s => { s.transforms.push({ ...s.transforms[0] }); },
    s => { s.entries.find(e => e.path === s.transforms[0].path).path = 'project/arbitrary.json'; s.transforms[0].path = 'project/arbitrary.json'; },
  ]) { const { snapshot } = transformedFixture(); mutate(snapshot); await assert.rejects(commitSourceSnapshot(work, signed(snapshot))); }
  assert.equal(writes, 0);
});

test('native capability evidence rejects unknown, duplicate, overlapping or incomplete declared complete capability sets', () => {
  for (const native_tools of [
    { version: 'fixture', complete: true, source: 'native-resolved', capabilities: ['unknown-capability'], disabled: [] },
    { version: 'fixture', complete: true, source: 'native-resolved', capabilities: ['file_read', 'file_read'], disabled: [] },
    { version: 'fixture', complete: true, source: 'native-resolved', capabilities: ['file_read'], disabled: ['file_read'] },
    { version: 'fixture', complete: false, source: 'native-resolved', capabilities: ['file_read'], disabled: [] },
  ]) {
    const snapshot = fixture(); snapshot.configuration.native_tools = native_tools;
    assert.throws(() => validateSourceSnapshot(signed(snapshot)), error => error.code === 'invalid');
  }
});
