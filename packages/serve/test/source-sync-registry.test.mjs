import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { SourceSync, sourceKey } from "../dist/source-sync/registry.js";
import { StoreConstraint } from "../dist/store/index.js";
import { commitAgent, getAgent } from "../dist/agents-store.js";

const source = { runtime: "codex", machine_id: "fixture-machine", project: "/fixture/project", selector: { kind: "project" } };
const snapshot = (digit, extra = {}) => ({ version: 1, digest: digit.repeat(64), complete: true, source,
  entries: [], blobs: {}, instructions: { text: `Instructions ${digit}`, layers: [] }, skills: [],
  configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [], ...extra });

async function setup(t, overrides = {}) {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.settings.put("fixture-source", { active: true, generation: 1 });
  const saved = new Map();
  let preparations = 0;
  const sync = new SourceSync(store, {
    authorize: async () => ({ source, captureRevision: "rev-1", guards: [{ key: "fixture-source", fields: { active: true, generation: 1 } }] }),
    persist: async (_id, value) => { saved.set(value.digest, structuredClone(value)); },
    read: async (_id, digest) => structuredClone(saved.get(digest)),
    prepare: async (_entry, value) => { preparations++; return { revision: { id: "prepared", kind: "agentic",
      body: { instructions: value.instructions.text, tools: ["read"], skills: {}, harness: "codex", learning: false } } }; },
    ...overrides,
  });
  const grant = await sync.grant("agent-1");
  const push = (value, sequence = 0) => sync.publish("agent-1", { generation: grant.generation, sequence, snapshot: value });
  return { store, saved, sync, grant, push, preparations: () => preparations };
}

test("a new export grant defaults on; Move is idempotent and preserves identity and the retained capture revision", async (t) => {
  const x = await setup(t);
  assert.equal(x.grant.enabled, true);
  await x.push(snapshot("a"));
  const moved = await x.sync.move("agent-1");
  assert.equal(moved.agent.id, "agent-1");
  assert.equal(moved.revision.body.instructions, "Instructions a");
  assert.equal(moved.revision.body.sourceSync.snapshot, "a".repeat(64));
  assert.equal((await x.sync.get("agent-1")).capture_revision, "rev-1");
  assert.ok(await x.store.agents.revision("rev-1"));
  assert.equal((await x.sync.move("agent-1")).revision.id, moved.revision.id);
  assert.equal(x.preparations(), 1, "retry never provisions or cuts over twice");
});

test("incomplete, stale, duplicate and wrong-target uploads preserve the last complete version", async (t) => {
  const x = await setup(t);
  await x.push(snapshot("a"));
  await x.push(snapshot("b", { complete: false, blockers: [{ code: "missing-tool", message: "Connect the required tool." }] }), 1);
  assert.equal((await x.sync.get("agent-1")).snapshot, "a".repeat(64));
  await assert.rejects(x.sync.move("agent-1"), /Connect the required tool/);
  await assert.rejects(x.push(snapshot("c"), 0), /changed while syncing/);
  await assert.rejects(x.push(snapshot("c"), 1), /changed while syncing/);
  await assert.rejects(x.push(snapshot("c", { source: { ...source, project: "/different" } }), 2), /different source target/);
  await x.push(snapshot("c"), 2);
  const same = await x.push(snapshot("c"), 2);
  assert.equal(same.sequence, 2);
  assert.equal((await x.store.agents.revisions("agent-1")).length, 1, "sync before Move writes no execution revisions");
});

test("revocation during persistence cannot publish the completed snapshot", async (t) => {
  let revoke;
  const x = await setup(t, { persist: async () => revoke() });
  revoke = () => x.store.settings.put("fixture-source", { active: false, generation: 2 });
  await assert.rejects(x.push(snapshot("a")), StoreConstraint);
  assert.equal((await x.sync.get("agent-1")).snapshot, undefined);
  assert.equal((await x.store.agents.get("agent-1")).currentRevision, "rev-1");
});

test("owner disabling during preparation fences Move and keeps the original agent usable", async (t) => {
  let disable;
  const x = await setup(t, { prepare: async () => { await disable(); return { revision: { id: "prepared", kind: "agentic", body: { instructions: "Managed." } } }; } });
  disable = () => x.sync.setEnabled("agent-1", false);
  await x.push(snapshot("a"));
  await assert.rejects(x.sync.move("agent-1"), StoreConstraint);
  assert.equal((await x.store.agents.get("agent-1")).currentRevision, "rev-1");
  await assert.rejects(x.push(snapshot("b"), 1), /off or its grant changed/);
  assert.ok(await x.store.settings.get(sourceKey("agent-1")), "disabled ownership is retained");
});

test("a run admitted during destination preparation refuses Move without sacrificing the run", async (t) => {
  let admit;
  const x = await setup(t, { prepare: async () => { await admit(); return { revision: { id: "prepared", kind: "agentic", body: { instructions: "Managed." } } }; } });
  admit = () => x.store.runs.create({ id: "source-run", agentId: "agent-1", revisionId: "rev-1", expectedCurrent: "rev-1" });
  await x.push(snapshot("a"));
  await assert.rejects(x.sync.move("agent-1"), error => error.code === "agent_not_runnable" && error.status === 409 && /active runs/.test(error.message));
  assert.equal((await x.store.runs.get("source-run")).state, "queued");
  assert.equal((await x.store.agents.get("agent-1")).currentRevision, "rev-1");
});

test("sync applies once after Move, and a managed edit pauses future setup changes", async (t) => {
  const x = await setup(t);
  await x.push(snapshot("a"));
  await x.sync.move("agent-1");
  await x.push(snapshot("b"), 1);
  assert.equal(await x.sync.reconcile("agent-1"), "applied");
  const synced = await getAgent(x.store, "agent-1");
  assert.equal(synced.revision.body.instructions, "Instructions b");
  assert.equal(await x.sync.reconcile("agent-1"), "unchanged");
  const edited = await commitAgent(x.store, synced, { definition: { instructions: "Keep my managed instructions." } });
  assert.deepEqual(edited.revision.body.sourceSync, synced.revision.body.sourceSync, "ordinary edits retain provenance and its prior baseline");
  await x.push(snapshot("c"), 2);
  assert.equal(await x.sync.reconcile("agent-1"), "conflict");
  assert.equal((await getAgent(x.store, "agent-1")).revision.body.instructions, "Keep my managed instructions.");
});

test("destination preparation failure makes no half-move or new revision", async (t) => {
  const failure = new Error("Sign in to the destination model.");
  const x = await setup(t, { prepare: async () => { throw failure; } });
  await x.push(snapshot("a"));
  await assert.rejects(x.sync.move("agent-1"), (error) => error === failure);
  assert.equal((await x.store.agents.revisions("agent-1")).length, 1);
  assert.equal((await x.sync.get("agent-1")).snapshot, "a".repeat(64));
});

test('source project and skill asset updates do not silently bypass a managed project checkpoint', async t => {
  const x = await setup(t);
  const initial = snapshot('a', { entries: [{ path: 'skills/task/script.sh', role: 'skill', type: 'file', mode: 493, bytes: 3, sha256: '1'.repeat(64) }] });
  await x.push(initial);
  const moved = await x.sync.move('agent-1');
  const body = { ...moved.revision.body, sourceSync: { ...moved.revision.body.sourceSync, project: 'd'.repeat(64) } };
  await x.store.agents.addRevision({ agentId: 'agent-1', id: 'checkpoint', kind: 'agentic', body, ifCurrent: moved.revision.id });
  await x.push(snapshot('b', { entries: [{ ...initial.entries[0], sha256: '2'.repeat(64) }] }), 1);
  assert.equal(await x.sync.reconcile('agent-1'), 'conflict');
  assert.equal((await x.store.agents.get('agent-1')).currentRevision, 'checkpoint');
  await assert.rejects(x.sync.useSource('agent-1', { revision: moved.revision.id, snapshot: 'b'.repeat(64) }), error => error.code === 'precondition_failed');
  const chosen = await x.sync.useSource('agent-1', { revision: 'checkpoint', snapshot: 'b'.repeat(64) });
  assert.equal(chosen.revision.body.sourceSync.project, 'b'.repeat(64));
  assert.equal((await x.store.agents.revision('checkpoint')).body.sourceSync.project, 'd'.repeat(64), 'the managed version stays in history');
});
