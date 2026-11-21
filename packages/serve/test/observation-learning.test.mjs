import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { serve, client } from "./support.mjs";
import { createAgent } from "../dist/agents-store.js";
import { CliLearningConnections } from "../dist/cli-learning/connections.js";
import { sdkRunSecret } from "../dist/sdk/runs.js";

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
  const signed = (sequence, overrides = {}) => {
    const scope = { connector_id: connector.id, source_id: source.source_id, external_session_id: "observed-session", runtime: "codex", connection_id: row.connection_id, readiness: "ready", native_session_hash: nativeHash("native-session"), sequence, ...overrides };
    // Independently specify the wire signature so a changed implementation cannot rewrite its verifier.
    const proof = createHmac("sha256", token).update(JSON.stringify(["agentrun-cli-learning-observation-v1", scope.connector_id, scope.source_id, scope.external_session_id, scope.runtime, scope.connection_id, scope.readiness, scope.native_session_hash, scope.sequence])).digest("hex");
    return { readiness: scope.readiness, connection_id: scope.connection_id, native_session_hash: scope.native_session_hash, proof };
  };
  const send = (...events) => request("POST", `/connectors/${connector.id}/events`, { selections_revision: 1, events }, credential);
  const view = async () => { const response = await s.api("GET", "/observations"); assert.equal(response.status, 200); return response.body; };
  return { ...s, broker, row, token, request, connector, credential, event, signed, send, view };
}

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
