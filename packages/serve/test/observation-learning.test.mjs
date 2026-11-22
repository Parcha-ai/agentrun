import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { serve, client } from "./support.mjs";
import { createAgent } from "../dist/agents-store.js";
import { CliLearningConnections } from "../dist/cli-learning/connections.js";
import { sdkRunSecret } from "../dist/sdk/runs.js";
import { Observations } from "../dist/observation/observer.js";

const nativeHash = (id) => createHash("sha256").update(id).digest("hex");
const source = { source_id: "selected-codex", harness: "codex", mode: "harness", external_session_id: null, include_future_sessions: true };
const registration = () => ({ workspace_id: "local", installation_id: randomUUID(), operation_id: randomUUID(), display_name: "Local source", cli_version: "test", adapters: [{ harness: "codex", adapter_version: "1", activity: "lifecycle" }], selections: [source], ingestion_mode: "polling" });

async function fixture(t, options = {}) {
  const s = await serve(t, { runner: false, ...options });
  const secret = sdkRunSecret(Buffer.from((await readFile(join(s.data, "seal", "seal.key"), "utf8")).trim(), "base64"));
  const broker = new CliLearningConnections(s.store, secret);
  // The enrollment boundary is scripted; these tests never discover, install or launch a native runtime.
  const row = { connection_id: "test-project-connection", agent_id: "cli-learning-profile", runtime: "codex", project: join(s.data, "project"), active: true, generation: "first-generation", native: {} };
  await createAgent(s.store, { definition: { id: row.agent_id, name: "Project learning", instructions: "", tools: [], learning: true, cli_learning: { runtime: row.runtime, connection_id: row.connection_id, project: row.project } } });
  await s.store.settings.putIfAbsent(`cli-learning-connection:${row.connection_id}`, row);
  const token = broker.token(row);
  const request = async (method, path, body, credential = s.token, headers = {}) => {
    const response = await fetch(s.baseUrl.replace(/\/v2$/, "") + "/api/v2/control" + path, { method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const registered = await request("POST", "/connectors", registration());
  assert.equal(registered.status, 200);
  const { connector, credential } = registered.body;
  const event = (sequence, learning, extra = {}) => ({ event_id: randomUUID(), source_id: source.source_id, external_session_id: "observed-session", sequence, type: "session_observed", occurred_at: new Date().toISOString(), metadata: { harness: "codex", activity: "working", project_name: "project", ...(learning ? { cli_learning: learning } : {}) }, ...extra });
  const signed = (sequence, overrides = {}, credential = token) => {
    const scope = { connector_id: connector.id, source_id: source.source_id, external_session_id: "observed-session", runtime: "codex", connection_id: row.connection_id, readiness: "ready", native_session_hash: nativeHash("native-session"), sequence, ...overrides };
    // Independently specify the wire signature so a changed implementation cannot rewrite its verifier.
    const proof = createHmac("sha256", credential).update(JSON.stringify(["agentrun-cli-learning-observation-v1", scope.connector_id, scope.source_id, scope.external_session_id, scope.runtime, scope.connection_id, scope.readiness, scope.native_session_hash, scope.sequence])).digest("hex");
    return { readiness: scope.readiness, connection_id: scope.connection_id, native_session_hash: scope.native_session_hash, proof };
  };
  const send = (...events) => request("POST", `/connectors/${connector.id}/events`, { selections_revision: 1, events }, credential);
  const view = async () => { const response = await s.api("GET", "/observations"); assert.equal(response.status, 200); return response.body; };
  return { ...s, broker, row, token, request, connector, credential, event, signed, send, view };
}

async function capturedWindow(s) {
  const revision = (await s.store.agents.revisions(s.row.agent_id))[0];
  const window = { runtime: "codex-cli", connection_id: s.row.connection_id, connection_generation: s.row.generation,
    session_id: "native-session", turn_id: "captured-turn", instructions: "Task.", policy_complete: true };
  const id = "captured-window";
  await s.store.runs.create({ id, agentId: s.row.agent_id, revisionId: revision.id }, { body: { cli_learning: window } });
  const claim = await s.store.claim(id, "test-runner", { leaseMs: 60_000 });
  await s.store.runs.update(claim, { state: "ended", outcome: "completed", endedAt: Date.now(),
    metrics: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1, unmetered: 0,
      cli_runtime: window.runtime, cli_session_id: window.session_id } });
  await s.store.settings.putIfAbsent(`sdk-run:${id}`, { completion: { status: "completed", session_id: window.session_id,
    evidence_complete: true, usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null } } });
  await s.broker.recordWindow(s.row.connection_id, s.row.generation, id, window.session_id);
}
const reportedUsage = { model: "test-model", input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0 };
const total = async (s) => {
  const result = await s.api("GET", "/stats"); assert.equal(result.status, 200);
  return result.body.analytics.usage.tokens;
};

for (const legacy of [false, true]) test(`verified usage identity survives lost learning readiness${legacy ? " from legacy persisted associations" : ""}`, async (t) => {
  const s = await fixture(t); await capturedWindow(s);
  assert.equal((await s.send(s.event(1, s.signed(1), { usage: reportedUsage }))).status, 200);
  assert.equal(await total(s), 120); assert.equal((await s.view()).sessions[0].learning.state, "on");
  const key = `observation.connector.${s.connector.id}`;
  if (legacy) {
    const previous = await s.store.settings.get(key), next = structuredClone(previous);
    for (const session of Object.values(next.sessions)) delete session.usage_identity;
    assert.ok(await s.store.settings.replaceIf(key, previous, next));
  }
  await s.broker.revoke(s.row.connection_id);
  assert.equal((await s.view()).sessions[0].learning.reason, "connection_unavailable");
  for (const [sequence, report] of [[2, s.signed(2)], [3, undefined], [4, { ...s.signed(4), native_session_hash: nativeHash("forged-session") }]]) {
    assert.equal((await s.send(s.event(sequence, report))).status, 200);
    assert.equal(await total(s), 120, "losing learning authorization cannot double two views of the same work");
    assert.equal((await s.view()).sessions[0].learning.agent_id, undefined);
  }
  const old = await s.broker.get(s.row.connection_id), replacement = { ...old, active: true, generation: "replacement", hook_sessions: {} };
  assert.ok(await s.store.settings.replaceIf(`cli-learning-connection:${old.connection_id}`, old, replacement));
  assert.equal((await s.send(s.event(5, s.signed(5)))).status, 200, "old credentials cannot restore learning readiness");
  assert.equal(await total(s), 120);
  assert.equal((await s.view()).sessions[0].learning.agent_id, undefined);
  assert.equal((await s.send(s.event(6, s.signed(6, {}, s.broker.token(replacement))))).status, 200);
  assert.equal(await total(s), 120);
  assert.equal((await s.view()).sessions[0].learning.reason, "awaiting_activation", "accounting identity does not grant hook activation");
  const stored = Object.values((await s.store.settings.get(key)).sessions)[0];
  assert.deepEqual(stored.usage_identity, { native_session_hash: nativeHash("native-session"), connection_id: s.row.connection_id, generation: s.row.generation });
  for (const body of [await s.view(), (await s.request("GET", "/connected-sessions")).body, (await s.request("GET", "/connectors")).body]) {
    const text = JSON.stringify(body);
    for (const privateValue of ["usage_identity", "native_session_hash", nativeHash("native-session"), s.token, s.row.generation]) assert.ok(!text.includes(privateValue));
  }
});

test("unproven wire reports establish no identity, and verified session reassignment rolls back its whole batch", async (t) => {
  const s = await fixture(t); await capturedWindow(s);
  assert.equal((await s.send(s.event(1, { ...s.signed(1), proof: "0".repeat(64) }, { usage: reportedUsage }))).status, 200);
  assert.equal(await total(s), 120, "unknown overlap can only establish a conservative usage floor");
  assert.equal(Object.values((await s.store.settings.get(`observation.connector.${s.connector.id}`)).sessions)[0].usage_identity, undefined, "an unverified native hash is not accounting authority");
  const injected = { native_session_hash: nativeHash("native-session"), connection_id: s.row.connection_id, generation: s.row.generation };
  assert.equal((await s.send(s.event(2, undefined, { usage_identity: injected }))).status, 422);
  assert.equal((await s.send(s.event(2, s.signed(2)))).status, 200);
  assert.equal(await total(s), 120);
  const key = `observation.connector.${s.connector.id}`, before = await s.store.settings.get(key);
  const accepted = s.event(3, undefined, { usage: { ...reportedUsage, input_tokens: 1, output_tokens: 0 } });
  const conflict = s.event(4, s.signed(4, { native_session_hash: nativeHash("different-session") }), { usage: reportedUsage });
  const rejected = await s.send(accepted, conflict);
  assert.equal(rejected.status, 409); assert.equal(rejected.body.detail.code, "connector_session_identity_conflict");
  assert.deepEqual(await s.store.settings.get(key), before, "a conflicting proof commits no usage, receipt, sequence or readiness from the batch");
  assert.equal((await s.send(accepted)).status, 200, "the rolled-back event remains retryable");
  assert.equal(await total(s), 121);
});

test("private usage identity is removed with retained sessions and never transferred to a new connector", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.send(s.event(1, s.signed(1), { usage: reportedUsage }))).status, 200);
  const key = `observation.connector.${s.connector.id}`;
  assert.ok(Object.values((await s.store.settings.get(key)).sessions)[0].usage_identity);
  const fresh = await s.request("POST", "/connectors", registration()); assert.equal(fresh.status, 200);
  assert.equal((await s.request("POST", `/connectors/${fresh.body.connector.id}/events`, { selections_revision: 1,
    events: [s.event(1, s.signed(1), { usage: reportedUsage })] }, fresh.body.credential)).status, 200);
  const freshSession = Object.values((await s.store.settings.get(`observation.connector.${fresh.body.connector.id}`)).sessions)[0];
  assert.equal(freshSession.usage_identity, undefined, "a proof for another connector cannot inherit its identity");
  await new Observations(s.store, () => Date.now() + 92 * 86_400_000).sweep();
  assert.deepEqual((await s.store.settings.get(key)).sessions, {}, "retention removes the identity together with its usage and session");
});

test("observed cards report missing, unsupported and older-client learning without enrolling a profile", async (t) => {
  const s = await fixture(t);
  assert.deepEqual((await s.request("GET", "/connectors/capabilities")).body.cli_learning, { session_association: true });
  for (const [report, expected] of [[undefined, "unknown"], [{ readiness: "setup_required" }, "setup_required"], [{ readiness: "unsupported" }, "unsupported"], [{ readiness: "unknown" }, "unknown"]]) {
    assert.equal((await s.send(s.event(1, report, { external_session_id: expected + (report ? "-new" : "-old") }))).status, 200);
    const session = (await s.view()).sessions.find((item) => item.external_session_id === expected + (report ? "-new" : "-old"));
    assert.equal(session.learning.state, expected);
    assert.equal(session.learning.agent_id, undefined);
  }
  assert.equal((await s.store.agents.list()).length, 1);
  assert.equal((await s.store.runs.list({})).length, 0);
});

test("a verified card requires its own hook activation and reads owner learning changes live", async (t) => {
  const s = await fixture(t), report = s.signed(1), first = s.event(1, report);
  assert.equal((await s.send(first)).status, 200);
  let card = (await s.view()).sessions[0];
  assert.deepEqual(card.learning, { state: "unknown", reason: "awaiting_activation", agent_id: s.row.agent_id, connection_id: s.row.connection_id, mode: "corrections" });
  await s.broker.recordWindow(s.row.connection_id, s.row.generation, "other-window", "another-native-session");
  assert.equal((await s.view()).sessions[0].learning.state, "unknown", "another session in the same project proves no activation");
  await s.broker.recordWindow(s.row.connection_id, s.row.generation, "own-window", "native-session");
  card = (await s.view()).sessions[0];
  assert.equal(card.learning.state, "on");
  assert.equal((await s.send(first)).status, 200, "an idempotent replay is stable after activation");
  assert.equal((await s.api("PUT", `/agents/${s.row.agent_id}/definition`, { definition: { instructions: "", learning: false } })).status, 200);
  assert.equal((await s.view()).sessions[0].learning.state, "off");
  assert.equal((await s.api("PUT", `/agents/${s.row.agent_id}/definition`, { definition: { instructions: "", learning: true } })).status, 200);
  assert.deepEqual((await s.view()).sessions[0].learning, { state: "on", reason: "ready", agent_id: s.row.agent_id, connection_id: s.row.connection_id, mode: "corrections" });
  const shown = JSON.stringify(await s.view()), stored = JSON.stringify(await s.store.settings.get(`observation.connector.${s.connector.id}`));
  for (const value of [s.token, report.proof, s.row.project, "native-session"]) { assert.ok(!shown.includes(value)); assert.ok(!stored.includes(value)); }
  assert.ok(!shown.includes("native_session_hash"));
  assert.ok(!shown.includes("generation"));
  assert.equal((await client(s.baseUrl, s.credential)("PUT", `/agents/${s.row.agent_id}/definition`, { definition: { instructions: "", learning: false } })).status, 401);
  assert.equal((await s.request("GET", "/connected-sessions", undefined, "")).status, 401);
});

test("forged and cross-session source bindings cannot link profiles or stop usage ingestion", async (t) => {
  const s = await fixture(t);
  let sequence = 0;
  const scopeChanges = [{ connector_id: "another-connector" }, { source_id: "another-source" }, { external_session_id: "another-session" }, { runtime: "claude-code" }, { sequence: 999 }, { connection_id: "missing-connection" }];
  for (const change of scopeChanges) {
    const event = s.event(++sequence, s.signed(sequence, change), { usage: { model: "test-model", input_tokens: 2, output_tokens: 1 } });
    assert.equal((await s.send(event)).status, 200);
    assert.deepEqual((await s.view()).sessions[0].learning, { state: "unknown", reason: "source_unknown" });
  }
  assert.equal((await s.send(s.event(++sequence, { ...s.signed(sequence), proof: "0".repeat(64) }))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.agent_id, undefined);
  assert.equal((await s.send(s.event(++sequence, { ...s.signed(sequence), native_session_hash: nativeHash("someone-else") }))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.agent_id, undefined);
  assert.equal((await s.view()).usage.total_tokens, scopeChanges.length * 3);
});

test("revocation and credential replacement remove the association without changing the observation", async (t) => {
  const s = await fixture(t);
  await s.broker.recordWindow(s.row.connection_id, s.row.generation, "own-window", "native-session");
  assert.equal((await s.send(s.event(1, s.signed(1)))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.state, "on");
  await s.broker.revoke(s.row.connection_id);
  assert.deepEqual((await s.view()).sessions[0].learning, { state: "unknown", reason: "connection_unavailable" });
  assert.equal((await s.send(s.event(2, s.signed(2)))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.agent_id, undefined);
  const previous = await s.broker.get(s.row.connection_id);
  await s.store.settings.replaceIf(`cli-learning-connection:${s.row.connection_id}`, previous, { ...previous, active: true, generation: "replacement", hook_sessions: {} });
  assert.equal((await s.send(s.event(3, s.signed(3)))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.state, "unknown");
});

test("learning Off is authoritative before activation; modified hooks cannot report On", async (t) => {
  const s = await fixture(t);
  await s.api("PUT", `/agents/${s.row.agent_id}/definition`, { definition: { instructions: "", learning: false } });
  assert.equal((await s.send(s.event(1, s.signed(1)))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.state, "off");
  await s.api("PUT", `/agents/${s.row.agent_id}/definition`, { definition: { instructions: "", learning: true } });
  await s.broker.recordWindow(s.row.connection_id, s.row.generation, "own-window", "native-session");
  assert.equal((await s.send(s.event(2, s.signed(2, { readiness: "setup_required" })))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.state, "setup_required");
  assert.equal((await s.send(s.event(3))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.state, "unknown", "a newer old-client event cannot keep asserting prior readiness");
});

test("server-wide learning Off appears on verified connected cards", async (t) => {
  const s = await fixture(t, { learning: "off" });
  assert.equal((await s.send(s.event(1, s.signed(1)))).status, 200);
  assert.equal((await s.view()).sessions[0].learning.reason, "server_disabled");
  assert.equal((await s.view()).sessions[0].learning.state, "off");
});

test("learning metadata rejects extra authority and partial credentials before accepting any event", async (t) => {
  const s = await fixture(t);
  for (const report of [{ readiness: "ready" }, { readiness: "unknown", proof: "a".repeat(64) }, { readiness: "ready", ...s.signed(1), enabled: true }, { ...s.signed(1), native_session_hash: "raw-native-session" }, { ...s.signed(1), project: "project" }]) {
    assert.equal((await s.send(s.event(1), s.event(2, report))).status, 422);
    assert.equal((await s.view()).sessions.length, 0);
  }
});
