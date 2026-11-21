import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { LocalSources, sourceLocalConsent, sourceLocalKey } from "../dist/source-sync/local.js";
import { nativeMachineId } from "../dist/native/discovery.js";
import { SourceSync } from "../dist/source-sync/registry.js";
import { sourceSnapshotDigest } from "../dist/native/source-snapshot-types.js";
import { exportSourceSnapshot, SourceSnapshotError } from "../dist/native/source-snapshot.js";
import { getAgent } from "../dist/agents-store.js";
import { SourcePreparationError } from "../dist/source-sync/prepare.js";

async function fixture(t, { cli = false, id = "agent-1" } = {}) {
  const { store } = await storeOn(t), data = await mkdtemp(join(tmpdir(), "local-source-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const project = join(data, "project"), home = join(data, "home"); await mkdir(project); await mkdir(home);
  const target = { runtime: "codex", project, selector: { kind: "project" }, machine_id: await nativeMachineId(), version: "0.171.0", model: "fixture-model",
    fingerprint: "a".repeat(64), configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [], connected: true,
    capabilities: { launch: true, learning: true, workflows: false, approval: "unavailable", usage: true } };
  const binding = cli ? { cli_learning: { runtime: target.runtime, project, connection_id: "capture" } } : { native: target };
  await store.agents.create({ id, name: "Source fixture" }, { id: "capture-1", kind: "agentic", body: { instructions: "", tools: [], skills: {}, ...binding } });
  const connectionKey = "cli-learning-connection:capture";
  if (cli) await store.settings.put(connectionKey, { connection_id: "capture", agent_id: id, runtime: target.runtime, project, active: true, generation: "first", native: target });
  let env = { HOME: home, PATH: "/usr/bin:/bin" }, exports = 0, selected = 0, words = "Initial source.", exporting, persisting;
  const saved = new Map(); let revisions = 0;
  const snapshot = () => {
    const source = Object.fromEntries(["runtime", "machine_id", "project", "selector"].map(key => [key, target[key]]));
    const value = { version: 1, complete: true, source, entries: [], blobs: {}, instructions: { text: words, layers: [] }, skills: [], configuration: { model: "fixture-model", tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
    return { ...value, digest: sourceSnapshotDigest(value) };
  };
  const local = new LocalSources(store, { env: () => env, selected: async () => { selected++; return target; }, secrets: () => [], export: async options => {
    exports++; assert.deepEqual(options.authorizedRoots, [project, env.HOME]); assert.equal(options.home, env.HOME); await exporting?.(); return snapshot();
  } });
  const sync = new SourceSync(store, { authorize: id => local.authorize(id), persist: async (_id, value) => { await persisting?.(); saved.set(value.digest, value); }, read: async (_id, digest) => saved.get(digest),
    prepare: async (_entry, value) => ({ revision: { id: `prepared-${++revisions}`, kind: "agentic", body: { instructions: value.instructions.text, tools: [], skills: {}, harness: "codex" } } }) });
  const consent = await sourceLocalConsent(target, env);
  return { store, local, sync, id, data, project, home, target, consent, connectionKey, publisher: local.publisher(sync),
    counts: () => ({ exports, selected }), setEnv: value => { env = value; }, setWords: value => { words = value; }, onExport: call => { exporting = call; }, onPersist: call => { persisting = call; },
    grant: async () => { await local.grant(id, consent); return sync.grant(id); } };
}

test("same-machine consent is private metadata, survives config edits, and refuses a different home or replacement project", async t => {
  const p = await fixture(t); assert.deepEqual(Object.keys(p.consent), ["version", "scope"]); assert.match(p.consent.scope, /^[a-f0-9]{64}$/);
  const identity = Object.fromEntries(["runtime", "machine_id", "project", "selector"].map(key => [key, p.target[key]]));
  const env = { HOME: p.home, PATH: "/usr/bin:/bin" };
  assert.deepEqual(await sourceLocalConsent(identity, env), p.consent, "full discovered targets and identity-only records authorize exactly the same scope");
  assert.deepEqual(await sourceLocalConsent({ ...p.target, fingerprint: "b".repeat(64), model: "changed-model", configuration: [{ path: "new-config", sha256: "c".repeat(64) }] }, env), p.consent);
  await mkdir(join(p.home, ".codex")); await writeFile(join(p.home, ".codex", "config.toml"), 'model = "changed"\n');
  assert.deepEqual(await sourceLocalConsent(p.target, env), p.consent, "config content changes are the intended sync input");
  assert.notEqual((await sourceLocalConsent(p.target, { ...env, ANTHROPIC_MODEL: "other-model" })).scope, p.consent.scope, "native environment overrides must agree before source scanning");
  const home = join(p.data, "other-home"); await mkdir(home);
  assert.notEqual((await sourceLocalConsent(p.target, { HOME: home })).scope, p.consent.scope);
  await rename(p.project, `${p.project}-retained`); await mkdir(p.project);
  assert.notEqual((await sourceLocalConsent(p.target, { HOME: p.home })).scope, p.consent.scope);
  await assert.rejects(sourceLocalConsent({ ...p.target, machine_id: "other-machine" }, { HOME: p.home }), /original source machine/);
});

test("old connections and invalid consent never acquire an export grant", async t => {
  const p = await fixture(t); assert.deepEqual(await p.publisher.tick(), { published: 0, unchanged: 0, refused: 0, failed: 0 });
  await assert.rejects(p.local.grant(p.id, undefined)); await assert.rejects(p.local.grant(p.id, { version: 1, scope: "0".repeat(64) }));
  assert.equal(await p.store.settings.get(sourceLocalKey(p.id)), undefined); assert.equal(await p.sync.get(p.id), undefined); assert.equal(p.counts().exports, 0);
});

test("an explicit local grant publishes through the same registry without duplicate snapshots", async t => {
  const p = await fixture(t); await p.grant();
  assert.equal((await p.publisher.tick()).published, 1); assert.equal((await p.publisher.tick()).unchanged, 1);
  assert.equal((await p.sync.get(p.id)).sequence, 0);
  p.setWords("Changed source."); assert.equal((await p.publisher.tick()).published, 1); assert.equal((await p.sync.get(p.id)).sequence, 1);
  assert.equal((await p.store.agents.list()).length, 1); assert.equal((await getAgent(p.store, p.id)).revision.id, "capture-1");
});

test("scope is checked before rediscovery or export after the server profile changes", async t => {
  const p = await fixture(t); await p.grant(); const before = p.counts(), home = join(p.data, "wrong-home"); await mkdir(home); p.setEnv({ HOME: home });
  assert.equal((await p.publisher.tick()).refused, 1); assert.deepEqual(p.counts(), before);
  await assert.rejects(p.local.authorize(p.id), /original source machine/);
});

test("CLI revocation during persistence cannot publish the completed local export", async t => {
  const p = await fixture(t, { cli: true }); await p.grant();
  p.onPersist(async () => { const row = await p.store.settings.get(p.connectionKey); await p.store.settings.put(p.connectionKey, { ...row, active: false }); });
  await assert.rejects(p.publisher.tick(), /source grant changed/);
  assert.equal((await p.sync.get(p.id)).snapshot, undefined);
  await assert.rejects(p.local.authorize(p.id));
});

test("a queued export cannot adopt a newly reauthorized local generation", async t => {
  const p = await fixture(t); await p.grant();
  p.onExport(async () => { await p.local.revoke(p.id); await p.local.grant(p.id, p.consent); });
  await assert.rejects(p.publisher.tick(), /local source connection changed/);
  assert.equal((await p.sync.get(p.id)).snapshot, undefined);
});

test("Move retains local source authority and later revoke leaves the managed revision intact", async t => {
  const p = await fixture(t); await p.grant(); await p.publisher.tick(); const moved = await p.sync.move(p.id);
  assert.equal((await p.local.authorize(p.id)).captureRevision, "capture-1");
  p.setWords("Later source."); await p.publisher.tick(); const revised = await getAgent(p.store, p.id);
  assert.notEqual(revised.revision.id, moved.revision.id); assert.equal(revised.revision.body.instructions, "Later source.");
  await p.local.revoke(p.id); assert.equal((await p.publisher.tick()).published, 0);
  assert.equal((await getAgent(p.store, p.id)).revision.id, revised.revision.id); assert.equal((await p.store.agents.list()).length, 1);
});

test("owner pause prevents scanning, and a fixed source failure never exposes raw error text", async t => {
  const p = await fixture(t); await p.grant(); await p.publisher.tick(); await p.sync.setEnabled(p.id, false); const before = p.counts();
  assert.equal((await p.publisher.tick()).refused, 1); assert.deepEqual(p.counts(), before);
  await p.sync.setEnabled(p.id, true);
  p.onExport(async () => { throw new SourceSnapshotError("source_unavailable", "fixture-private-detail"); });
  assert.equal((await p.publisher.tick()).failed, 1);
  const row = await p.sync.get(p.id); assert.equal(row.attempt.code, "source_unavailable"); assert.equal(JSON.stringify(row).includes("fixture-private-detail"), false);
  p.onExport(undefined); assert.equal((await p.publisher.tick()).published, 1); assert.equal((await p.sync.get(p.id)).attempt.code, undefined);
});

test("an unchanged source retries a blocked managed reconciliation when destination setup is restored", async t => {
  const p = await fixture(t); await p.grant(); await p.publisher.tick(); await p.sync.move(p.id);
  const prepare = p.sync.options.prepare; let ready = false;
  p.sync.options.prepare = async (...args) => { if (!ready) throw new SourcePreparationError([{ code: "tool_connection", message: "Connect the destination account." }]); return prepare(...args); };
  p.setWords("Updated source."); assert.equal((await p.publisher.tick()).published, 1);
  assert.equal((await getAgent(p.store, p.id)).revision.body.instructions, "Initial source.");
  ready = true; assert.equal((await p.publisher.tick()).unchanged, 1);
  assert.equal((await getAgent(p.store, p.id)).revision.body.instructions, "Updated source.");
});

test("local export publication uses the existing per-agent write serializer", async t => {
  const p = await fixture(t); await p.grant(); let calls = 0, held = false;
  p.onPersist(async () => assert.equal(held, true));
  const publisher = p.local.publisher(p.sync, { agentWrite: async (id, call) => { assert.equal(id, p.id); calls++; held = true; try { return await call(); } finally { held = false; } } });
  assert.equal((await publisher.tick()).published, 1); assert.equal(calls, 1);
});

test("a temporary project-root replacement cannot export bytes outside the approved directory identity", async t => {
  const p = await fixture(t), replacement = join(p.data, "replacement"), retained = join(p.data, "approved-retained");
  await mkdir(replacement); await writeFile(join(replacement, "unapproved.txt"), "unapproved replacement content");
  await writeFile(join(p.project, "approved.txt"), "approved content");
  await mkdir(join(p.home, ".codex")); p.target.model = "gpt-5.5";
  await writeFile(join(p.home, ".codex", "config.toml"), `model="gpt-5.5"\napproval_policy="never"\nsandbox_mode="danger-full-access"\nweb_search="disabled"\n[agents]\nenabled=false\n[features]\napps=false\nplugins=false\nimage_generation=false\nmulti_agent=false\ngoals=false\nmemories=false\n[cloud.skills]\nenabled=false\n[tools.experimental_request_user_input]\nenabled=false\n[tools.update_plan]\nenabled=false\n[projects.${JSON.stringify(p.project)}]\ntrust_level="trusted"\n`);
  await p.grant(); let exported;
  p.local.options.export = async options => {
    await rename(p.project, retained); await rename(replacement, p.project);
    try { exported = await exportSourceSnapshot(options); return exported; }
    finally { await rename(p.project, replacement); await rename(retained, p.project); }
  };
  const result = await p.publisher.tick();
  assert.equal(result.failed, 1, "restoring the approved directory before publication cannot authorize replacement bytes");
  assert.equal((await p.sync.get(p.id)).snapshot, undefined);
  assert.equal(exported, undefined, "refuse at the opened source root, before exporting replacement content");
});
