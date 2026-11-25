import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { RemoteConnectors } from "../dist/native/remote.js";
import { CliLearningConnections } from "../dist/cli-learning/connections.js";
import { cliAdoptionResolver } from "../dist/source-sync/adoption.js";
import { SourceSync } from "../dist/source-sync/registry.js";

const target = { runtime: "codex", project: "/fixture/project", selector: { kind: "project" }, machine_id: "fixture-machine",
  version: "test", model: null, fingerprint: "a".repeat(64), configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [],
  connected: true, capabilities: { launch: true, learning: true, workflows: false, approval: "unavailable", usage: true } };
const hash = value => createHash("sha256").update(value).digest("hex");

async function remote(broker, capabilities = { native_execution: true }) {
  const code = await broker.enroll({ capabilities });
  return await broker.register(code.enrollment_token, { installation_id: "installation", operation_id: "register", capabilities });
}
async function captured(store, connections, suffix = "1") {
  const row = { connection_id: `connection-${suffix}`, agent_id: `cli-${suffix}`, runtime: "codex", project: target.project,
    active: true, generation: `generation-${suffix}`, native: target };
  await store.agents.create({ id: row.agent_id, name: row.agent_id }, { id: `capture-${suffix}`, kind: "agentic", body: {
    instructions: "", tools: [], skills: {}, learning: false,
    cli_learning: { runtime: row.runtime, project: row.project, connection_id: row.connection_id },
  } });
  await store.settings.put(`cli-learning-connection:${row.connection_id}`, row);
  return { row, token: connections.token(row) };
}
function proof(connectorId, targetId, capture, native = target) {
  const credential_epoch = hash(capture.token), connection_id = capture.row.connection_id;
  const message = JSON.stringify(["agentrun-source-sync-adoption-v1", connectorId, targetId, connection_id, credential_epoch,
    native.runtime, native.machine_id, native.project, native.selector.kind, native.selector.name ?? null]);
  return { connection_id, credential_epoch, proof: createHmac("sha256", capture.token).update(message).digest("hex") };
}

test("old connector requests gain no export grant; new explicit config sync grants are scoped", async t => {
  const { store } = await storeOn(t), broker = new RemoteConnectors(store);
  const old = await remote(broker), oldId = old.connector.id;
  await broker.importTarget(oldId, { target_id: "target", target });
  assert.equal(old.connector.capabilities.config_sync, false);
  await assert.rejects(broker.syncAuthority(oldId, "target"), /Authorize configuration sync/);
  const current = await remote(broker, { native_execution: true, config_sync: true });
  const imported = await broker.importTarget(current.connector.id, { target_id: "target", target });
  const authorized = await broker.syncAuthority(current.connector.id, "target");
  assert.equal(authorized.agentId, imported.agent_id);
  assert.deepEqual(authorized.authority.connection, { connector_id: current.connector.id, target_id: "target" });
  await broker.revoke(current.connector.id);
  await assert.rejects(broker.syncAuthority(current.connector.id, "target"), /Authorize configuration sync/);
});

test("owner-bound reauthorization rotates only the same installation and preserves target identity", async t => {
  const { store } = await storeOn(t), broker = new RemoteConnectors(store);
  const original = await remote(broker), id = original.connector.id;
  const imported = await broker.importTarget(id, { target_id: "target", target });
  const code = await broker.enroll({ connector_id: id, capabilities: { native_execution: true, config_sync: true } });
  const request = { installation_id: "installation", operation_id: "enable-sync", capabilities: { native_execution: true, config_sync: true } };
  await assert.rejects(broker.register(code.enrollment_token, { ...request, installation_id: "different" }), /original installation/);
  const enabled = await broker.register(code.enrollment_token, request);
  assert.equal(enabled.connector.id, id);
  assert.equal(enabled.connector.targets[0].agent_id, imported.agent_id);
  assert.notEqual(enabled.credential, original.credential);
  await assert.rejects(new RemoteConnectors(store).authenticate(id, original.credential), /invalid, expired or revoked/);
  await new RemoteConnectors(store).authenticate(id, enabled.credential);
  assert.equal((await broker.register(code.enrollment_token, request)).credential, enabled.credential, "lost response is recoverable");
  const later = await broker.enroll({ connector_id: id, capabilities: { native_execution: true, config_sync: true } });
  await broker.revoke(id);
  await assert.rejects(broker.register(later.enrollment_token, { ...request, operation_id: "stale" }), /changed after the owner/);
});

test("purpose-bound adoption keeps the CLI profile; forged, rotated and cross-target proofs cannot adopt", async t => {
  const { store } = await storeOn(t), broker = new RemoteConnectors(store), connections = new CliLearningConnections(store, "fixture-secret");
  const capture = await captured(store, connections), registered = await remote(broker, { native_execution: false, config_sync: true });
  const id = registered.connector.id, resolve = cliAdoptionResolver(store, connections);
  const adoption = proof(id, "target", capture);
  await assert.rejects(broker.importTarget(id, { target_id: "target", target }), /Enable capture/);
  await assert.rejects(broker.importTarget(id, { target_id: "target", target, cli_adoption: { ...adoption, proof: "0".repeat(64) } }, resolve), /did not authorize/);
  await assert.rejects(broker.importTarget(id, { target_id: "other", target, cli_adoption: adoption }, resolve), /did not authorize/);
  const imported = await broker.importTarget(id, { target_id: "target", target, cli_adoption: adoption }, resolve);
  assert.equal(imported.agent_id, capture.row.agent_id);
  assert.equal((await store.agents.list()).length, 1, "no second remote agent");
  assert.equal((await store.agents.get(capture.row.agent_id)).currentRevision, "capture-1", "adoption never converts source execution");
  const next = { ...capture.row, generation: "rotated" };
  await store.settings.put(`cli-learning-connection:${next.connection_id}`, next);
  await assert.rejects(broker.importTarget(id, { target_id: "target", target, cli_adoption: adoption }, resolve), /did not authorize/);
});

for (const mode of ['capture', 'deployment']) test(`${mode} source metadata retries after Move cannot restore native execution or change the visible agent`, async t => {
  const { store } = await storeOn(t), broker = new RemoteConnectors(store), connections = new CliLearningConnections(store, "fixture-secret");
  const capture = mode === 'capture' ? await captured(store, connections) : undefined;
  const registered = await remote(broker, { native_execution: false, history_import: false, config_sync: true });
  const id = registered.connector.id, resolve = cliAdoptionResolver(store, connections);
  const input = { target_id: "target", target: mode === 'deployment' ? { ...target, sync_only: true } : target,
    ...(capture ? { cli_adoption: proof(id, "target", capture) } : { deployment: true }) };
  const imported = await broker.importTarget(id, input, resolve), agentId = imported.agent_id;
  const captureRevision = (await store.agents.get(agentId)).currentRevision;
  assert.equal((await broker.importTarget(id, input, resolve)).agent_id, agentId, 'a lost import reply does not create another agent');
  if (mode === 'deployment') {
    assert.equal(imported.native, undefined);
    assert.equal(imported.target.capabilities.launch, false);
    const pending = await store.agents.revision(captureRevision);
    assert.equal(pending.body.native, undefined);
    assert.deepEqual(pending.body.sourceDeployment, { connector_id: id, target_id: 'target' });
  }
  const authorized = await broker.syncAuthority(id, "target"), source = authorized.authority.source;
  const snapshot = { version: 1, digest: "b".repeat(64), complete: true, source, entries: [], blobs: {}, instructions: { text: "Moved.", layers: [] }, skills: [], configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  const sync = new SourceSync(store, { authorize: async () => (await broker.syncAuthority(id, "target")).authority,
    persist: async () => {}, read: async () => snapshot,
    prepare: async () => ({ revision: { id: "prepared", kind: "agentic", body: { instructions: "Moved.", skills: {}, tools: [], harness: "codex" } } }),
  });
  const grant = await sync.grant(agentId);
  await sync.publish(agentId, { generation: grant.generation, sequence: 0, snapshot });
  const moved = await sync.move(agentId);
  assert.equal(moved.agent.id, agentId);
  assert.equal(moved.revision.body.sourceDeployment, undefined);
  assert.equal((await sync.move(agentId)).revision.id, moved.revision.id, 'an uncertain Move response keeps one revision');
  await broker.importTarget(id, { ...input, target: { ...input.target, fingerprint: "c".repeat(64) } }, resolve);
  assert.equal((await store.agents.get(agentId)).currentRevision, moved.revision.id);
  assert.equal((await broker.syncAuthority(id, "target")).authority.captureRevision, captureRevision);
  assert.equal((await store.agents.list()).length, 1);
  await sync.setEnabled(agentId, false);
  assert.equal((await sync.grant(agentId)).enabled, false, "normal source grant cannot undo owner disable");
});

test('fresh deployment requires setup-only authority and cannot replace an adopted source association', async t => {
  const { store } = await storeOn(t), broker = new RemoteConnectors(store), connections = new CliLearningConnections(store, 'fixture-secret');
  const capture = await captured(store, connections), resolve = cliAdoptionResolver(store, connections);
  const requested = { target_id: 'target', target: { ...target, sync_only: true }, deployment: true };
  for (const capabilities of [
    { native_execution: true, config_sync: true },
    { native_execution: false, history_import: true, config_sync: true },
    { native_execution: true, config_sync: false },
  ]) {
    const registered = await remote(broker, capabilities);
    await assert.rejects(broker.importTarget(registered.connector.id, requested), error => error.code === 'forbidden');
  }
  const registered = await remote(broker, { native_execution: false, history_import: false, config_sync: true }), id = registered.connector.id;
  for (const invalid of [
    { ...requested, deployment: 'true' }, { ...requested, target }, { ...requested, history_only: true },
    { ...requested, cli_adoption: proof(id, 'target', capture) },
  ]) await assert.rejects(broker.importTarget(id, invalid, resolve), error => error.code === 'input_invalid');
  await assert.rejects(broker.importTarget(id, { target_id: 'target', target }), /Enable capture/, 'legacy setup-only import still requires adoption');
  await broker.importTarget(id, { target_id: 'target', target, cli_adoption: proof(id, 'target', capture) }, resolve);
  await assert.rejects(broker.importTarget(id, requested), error => error.code === 'idempotency_mismatch');
  const deployment = await broker.importTarget(id, { ...requested, target_id: 'fresh' });
  await assert.rejects(broker.importTarget(id, { target_id: 'fresh', target, cli_adoption: proof(id, 'fresh', capture) }, resolve), error => error.code === 'idempotency_mismatch');
  await assert.rejects(broker.importTarget(id, { ...requested, target_id: 'fresh', target: { ...requested.target, project: '/fixture/another' } }), error => error.code === 'idempotency_mismatch');
  assert.equal((await store.agents.list()).length, 2);
  assert.notEqual(deployment.agent_id, capture.row.agent_id);
});

test('a request authenticated before credential rotation cannot use the replacement epoch or its new scopes', async t => {
  const { store } = await storeOn(t), owner = new RemoteConnectors(store);
  const original = await remote(owner), id = original.connector.id;
  await owner.importTarget(id, { target_id: 'target', target });
  const request = new RemoteConnectors(store);
  await request.authenticate(id, original.credential);
  // Models the HTTP pause while reading an upload body; the old request remains open across owner reauthorization.
  const code = await owner.enroll({ connector_id: id, capabilities: { native_execution: true, config_sync: true } });
  await owner.register(code.enrollment_token, { installation_id: 'installation', operation_id: 'new-epoch', capabilities: { native_execution: true, config_sync: true } });
  await assert.rejects(request.syncAuthority(id, 'target'), error => error.code === 'unauthenticated');
  await assert.rejects(request.importTarget(id, { target_id: 'target', target }), error => error.code === 'unauthenticated');
  assert.equal((await owner.syncAuthority(id, 'target')).agentId, (await owner.list()).connectors[0].targets[0].agent_id);
});
