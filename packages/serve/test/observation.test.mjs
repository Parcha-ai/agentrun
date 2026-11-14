import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { serve, storeBytes } from "./support.mjs";
import {
  maintainObservations,
  Observations,
} from "../dist/observation/observer.js";

const source = {
  source_id: "selected-claude",
  harness: "claude",
  mode: "harness",
  external_session_id: null,
  include_future_sessions: true,
};
const sourceCodex = {
  ...source,
  source_id: "selected-codex",
  harness: "codex",
};
const registration = (mode = "otlp") => ({
  workspace_id: "local",
  installation_id: randomUUID(),
  operation_id: randomUUID(),
  display_name: "Backend worker",
  cli_version: "0.1.10",
  adapters: [
    { harness: "claude", adapter_version: "1", activity: "lifecycle" },
    { harness: "codex", adapter_version: "1", activity: "lifecycle" },
  ],
  selections: [source, sourceCodex],
  ingestion_mode: mode,
});

test("observation scans request their namespace before unrelated command values are deserialized", async () => {
  // Minimal pending Settings.all filter interface, not a SQL implementation proof. B3's composed store owns that
  // proof. An unrelated command need not be readable to register, list, snapshot or sweep observation metadata.
  const raw = new Map([["remote.command.unrelated", "unreadable command payload"]]);
  const parsed = [], requests = [];
  const store = { settings: {
    async get(key) { return raw.has(key) ? JSON.parse(raw.get(key)) : undefined; },
    async putIfAbsent(key, value) {
      if (!raw.has(key)) raw.set(key, JSON.stringify(value));
      return JSON.parse(raw.get(key));
    },
    async all(filter) {
      requests.push(filter);
      assert.deepEqual(filter, { prefix: "observation.connector." });
      return [...raw].filter(([key]) => key.startsWith(filter.prefix)).map(([key, value]) => {
        parsed.push(key);
        return { key, value: JSON.parse(value), updatedAt: 0 };
      });
    },
  } };
  const observer = new Observations(store);
  const saved = await observer.register(registration("polling"));
  assert.equal((await observer.list()).items[0].id, saved.connector.id);
  assert.equal((await observer.snapshot()).connectors[0].id, saved.connector.id);
  assert.equal((await observer.sweep()).pruned_connectors, 0);
  const stop = await maintainObservations(observer);
  await stop();
  assert.equal(requests.length, 5);
  assert.ok(parsed.every(key => key === "observation.connector." + saved.connector.id));
  assert.equal(raw.get("remote.command.unrelated"), "unreadable command payload");
});
const attr = (key, value) => ({
  key,
  value:
    typeof value === "number"
      ? { intValue: String(value) }
      : { stringValue: value },
});
function otlp({
  harness = "claude",
  name = "api_request",
  session = "a".repeat(64),
  time = BigInt(Date.now()) * 1_000_000n,
  usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 60,
    cache_write_tokens: 10,
  },
  extra = [],
} = {}) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr("agentrun.harness", harness),
            attr("agentrun.source_id", "selected-" + harness),
            attr("host.name", "private-host"),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(time),
                body: { stringValue: "PRIVATE_BODY" },
                attributes: [
                  attr("event.name", name),
                  attr("agentrun.session_id", session),
                  ...(usage
                    ? [
                        attr("agentrun.model", "test-model"),
                        ...Object.entries(usage).map(([k, v]) =>
                          attr("agentrun." + k, v),
                        ),
                      ]
                    : []),
                  attr("prompt", "PRIVATE_PROMPT"),
                  ...extra,
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
async function setup(t, mode = "otlp") {
  const s = await serve(t, { runner: false });
  const origin = s.baseUrl.replace(/\/v2$/, "");
  const request = async (
    method,
    path,
    body,
    credential = s.token,
    headers = {},
  ) => {
    const response = await fetch(origin + "/api/v2/control" + path, {
      method,
      headers: {
        Authorization: "Bearer " + credential,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const requestBody = registration(mode),
    reply = await request("POST", "/connectors", requestBody);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const { connector, credential } = reply.body;
  const scoped = (operation, body, headers = {}) =>
    request(
      "POST",
      `/connectors/${connector.id}/${operation}`,
      body,
      credential,
      headers,
    );
  const send = (body, revision = "1") =>
    scoped("otel/v1/logs", body, {
      "X-AgentRun-Selections-Revision": revision,
    });
  const view = async () => {
    const r = await s.api("GET", "/observations");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  return {
    ...s,
    request,
    requestBody,
    connector,
    credential,
    scoped,
    send,
    view,
  };
}

test("existing CLI wire registers, observes, rotates and revokes without a model key or runnable agent", async (t) => {
  const s = await setup(t);
  assert.deepEqual((await s.request("GET", "/identity")).body.workspace_ids, [
    "local",
  ]);
  const capabilities = (
    await s.request("GET", "/connectors/capabilities", undefined, "")
  ).body;
  assert.deepEqual(capabilities.logs_formats, ["json"]);
  assert.equal(capabilities.privacy.raw_session_ids, false);
  assert.equal(
    (await s.request("GET", "/identity", undefined, s.credential)).status,
    401,
  );
  assert.equal((await s.send(otlp())).status, 200);
  const initial = await s.view();
  assert.equal(initial.sessions.length, 1);
  assert.equal(initial.sessions[0].activity, "working");
  assert.equal(initial.sessions[0].connection_state, "online");
  assert.equal(initial.sessions[0].observation_only, true);
  assert.equal(
    (await s.api("GET", "/agents")).body.agents.length,
    0,
    "observation never creates an executable agent",
  );
  const duplicate = await s.request("POST", "/connectors", s.requestBody);
  assert.equal(duplicate.status, 409);
  assert.equal(
    duplicate.body.detail.code,
    "connector_reauthentication_required",
  );
  const rotated = await s.request(
    "POST",
    `/connectors/${s.connector.id}/rotate-credential`,
    {},
  );
  assert.equal(rotated.status, 200);
  assert.equal((await s.send(otlp())).status, 401);
  assert.equal(
    (
      await s.request(
        "POST",
        `/connectors/${s.connector.id}/heartbeat`,
        {},
        rotated.body.credential,
      )
    ).status,
    200,
  );
  assert.equal(
    (await s.request("DELETE", `/connectors/${s.connector.id}`)).status,
    200,
  );
  assert.equal(
    (
      await s.request(
        "POST",
        `/connectors/${s.connector.id}/heartbeat`,
        {},
        rotated.body.credential,
      )
    ).status,
    401,
  );
  const revoked = await s.view();
  assert.equal(revoked.sessions[0].connection_state, "disconnected");
  assert.equal(revoked.sessions[0].activity, "unknown");
  assert.equal(revoked.usage.total_tokens, 120);
  const stored = storeBytes(s.data);
  for (const secret of [
    s.credential,
    s.token,
    rotated.body.credential,
    "PRIVATE_BODY",
    "PRIVATE_PROMPT",
    "private-host",
  ])
    assert.equal(stored.includes(Buffer.from(secret)), false, secret);
});

for (const initialMode of ["polling", "otlp"]) {
  test(`revoked ${initialMode} connector re-enrolls in the newly approved mode without losing history`, async (t) => {
    const s = await setup(t, initialMode);
    const report = { selections_revision: 1, events: [{ event_id: randomUUID(), source_id: source.source_id,
      external_session_id: "a".repeat(64), sequence: 1, type: "session_observed", occurred_at: new Date().toISOString(),
      metadata: { harness: "claude", activity: "working" } }] };
    assert.equal((initialMode === "otlp" ? await s.send(otlp()) : await s.scoped("events", report)).status, 200);
    assert.equal((await s.request("DELETE", `/connectors/${s.connector.id}`)).status, 200);
    const nextMode = initialMode === "otlp" ? "polling" : "otlp";
    const rebound = await s.request("POST", "/connectors", { ...s.requestBody, ingestion_mode: nextMode,
      selections: [{ ...source, harness: "codex" }] });
    assert.equal(rebound.status, 409);
    assert.equal(rebound.body.detail.code, "connector_source_rebound");
    assert.equal((await s.scoped("heartbeat", {})).status, 401, "a rejected re-enrollment cannot revive a credential");
    const reenrolled = await s.request("POST", "/connectors", { ...s.requestBody, operation_id: randomUUID(), ingestion_mode: nextMode });
    assert.equal(reenrolled.status, 200, JSON.stringify(reenrolled.body));
    assert.equal(reenrolled.body.connector.id, s.connector.id);
    assert.equal(reenrolled.body.connector.ingestion_mode, nextMode);
    assert.equal(reenrolled.body.connector.selections_revision, 2);
    assert.notEqual(reenrolled.body.credential, s.credential);
    assert.equal((await s.scoped("heartbeat", {})).status, 401, "revoked credentials stay revoked after reconnect");
    assert.equal((await s.view()).sessions.length, 1, "mode changes preserve accepted history");
    const send = (revision) => nextMode === "otlp"
      ? s.request("POST", `/connectors/${s.connector.id}/otel/v1/logs`, otlp(), reenrolled.body.credential, { "X-AgentRun-Selections-Revision": String(revision) })
      : s.request("POST", `/connectors/${s.connector.id}/events`, { ...report, selections_revision: revision, events: [{ ...report.events[0], event_id: randomUUID(), sequence: 2 }] }, reenrolled.body.credential);
    assert.equal((await send(1)).status, 409, "old selection revisions stay fenced");
    assert.equal((await send(2)).status, 200);
    if (nextMode === "polling") assert.equal((await s.view()).sessions[0].sequence, 2,
      "polling sequence advances after a mode switch despite the old OTLP microsecond clock");
    assert.equal((await s.request("POST", "/connectors", s.requestBody)).status, 409, "registration cannot replace an active connection");
    assert.equal((await s.view()).connectors[0].ingestion_mode, nextMode);
  });
  test(`${initialMode} activity without a token report exposes unknown cache counters`, async (t) => {
    const s = await setup(t, initialMode);
    const empty = await s.view();
    assert.equal(empty.usage.cache_read_tokens, null);
    assert.equal(empty.usage.cache_write_tokens, null);
    const answer = initialMode === "otlp" ? await s.send(otlp({ name: "user_prompt", usage: null }))
      : await s.scoped("events", { selections_revision: 1, events: [{ event_id: randomUUID(), source_id: source.source_id,
        external_session_id: "activity-only", sequence: 1, type: "session_observed", occurred_at: new Date().toISOString(),
        metadata: { harness: "claude", activity: "working" } }] });
    assert.equal(answer.status, 200);
    const view = await s.view();
    assert.equal(view.sessions[0].usage.status, "unavailable");
    assert.equal(view.sessions[0].usage.cache_read_tokens, null);
    assert.equal(view.sessions[0].usage.cache_write_tokens, null);
    assert.equal(view.usage.cache_read_tokens, null);
    assert.equal(view.usage.cache_write_tokens, null);
  });
}

test("OTLP replay, concurrent duplicate delivery, restart and late usage preserve exact inclusive counts and activity", async (t) => {
  const s = await setup(t),
    time = BigInt(Date.now()) * 1_000_000n;
  const usage = otlp({ time });
  assert.equal((await s.send(usage)).status, 200);
  const replays = await Promise.all(
    Array.from({ length: 8 }, () => s.send(usage)),
  );
  assert.ok(replays.every((r) => r.status === 200));
  const idle = otlp({
    time: time + 2n,
    name: "agentrun.session.idle",
    usage: null,
  });
  assert.equal((await s.send(idle)).status, 200);
  // Same microsecond but newer nanosecond has precedence, and late usage still contributes exactly once.
  const late = otlp({
    time: time + 1n,
    usage: {
      input_tokens: 40,
      output_tokens: 5,
      cache_read_tokens: 10,
      cache_write_tokens: 0,
    },
  });
  assert.equal((await s.send(late)).status, 200);
  const after = await new Observations(s.store).snapshot();
  assert.equal(after.sessions[0].activity, "idle");
  assert.equal(after.usage.total_tokens, 165);
  assert.equal(after.usage.input_tokens, 140);
  assert.equal(after.usage.output_tokens, 25);
  assert.equal(after.usage.cache_read_tokens, 70);
  assert.equal(after.usage.cache_write_tokens, 10);
  assert.equal(after.usage.cache_hit_rate, 0.5);
  assert.equal(after.connectors[0].receipt_count, 3);
  await s.stop();
  const restarted = await serve(t, { data: s.data, runner: false });
  const replay = await fetch(
    restarted.baseUrl.replace(/\/v2$/, "") +
      `/api/v2/control/connectors/${s.connector.id}/otel/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + s.credential,
        "Content-Type": "application/json",
        "X-AgentRun-Selections-Revision": "1",
      },
      body: JSON.stringify(usage),
    },
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (await restarted.api("GET", "/observations")).body.usage.total_tokens,
    165,
  );
});

test("selection and scoped credential fences reject cross-source writes and replays after removal", async (t) => {
  const s = await setup(t),
    body = otlp();
  const before = await s.view();
  assert.equal(before.sessions.length, 0);
  assert.equal((await s.send(body, "2")).status, 409);
  body.resourceLogs[0].resource.attributes[1] = attr(
    "agentrun.source_id",
    "unselected",
  );
  assert.equal((await s.send(body)).status, 403);
  assert.equal((await s.view()).sessions.length, 0);
  assert.equal((await s.send(otlp())).status, 200);
  const removed = await s.request(
    "PATCH",
    `/connectors/${s.connector.id}/selections`,
    { selections_revision: 1, selections: [] },
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.selections_revision, 2);
  assert.equal((await s.send(otlp())).status, 409);
  assert.equal((await s.send(otlp(), "2")).status, 403);
  assert.equal((await s.view()).sessions[0].selection_active, false);
  const rebound = await s.request(
    "PATCH",
    `/connectors/${s.connector.id}/selections`,
    { selections_revision: 2, selections: [{ ...source, harness: "codex" }] },
  );
  assert.equal(rebound.status, 409);
  const other = await s.request("POST", "/connectors", registration());
  assert.equal(other.status, 200);
  assert.equal(
    (
      await s.request(
        "POST",
        `/connectors/${other.body.connector.id}/heartbeat`,
        {},
        s.credential,
      )
    ).status,
    401,
  );
});

test("polling observes selected sessions, fences sequence and persists source receipts atomically", async (t) => {
  const s = await setup(t, "polling");
  const event = {
    event_id: randomUUID(),
    source_id: source.source_id,
    external_session_id: "opaque-session",
    sequence: 2,
    type: "session_observed",
    occurred_at: new Date().toISOString(),
    metadata: { harness: "claude", activity: "idle" },
  };
  const batch = { selections_revision: 1, events: [event] };
  assert.equal((await s.scoped("events", batch)).status, 200);
  assert.equal((await s.scoped("heartbeat", {})).status, 200);
  assert.equal((await s.scoped("events", batch)).status, 200);
  assert.equal(
    (
      await s.scoped("events", {
        ...batch,
        events: [
          { ...event, metadata: { ...event.metadata, activity: "working" } },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.scoped("events", {
        ...batch,
        events: [
          {
            ...event,
            event_id: randomUUID(),
            sequence: 1,
            metadata: { ...event.metadata, activity: "working" },
          },
        ],
      })
    ).status,
    200,
  );
  let view = await s.view();
  assert.equal(view.sessions[0].activity, "idle");
  assert.equal(view.sessions[0].usage.status, "unavailable");
  assert.equal(view.usage.status, "unavailable");
  assert.equal((await s.send(otlp())).status, 409);
  assert.equal(
    (
      await s.scoped("events", {
        ...batch,
        events: [{ ...event, event_id: randomUUID(), prompt: "PRIVATE" }],
      })
    ).status,
    422,
  );
  view = await new Observations(s.store, () => Date.now() + 180_000).snapshot();
  assert.equal(view.sessions[0].activity, "unknown");
  assert.equal(view.sessions[0].connection_state, "offline");
});

test("native token contracts reject incomplete, invalid and duplicated attributes with explicit partial success", async (t) => {
  const s = await setup(t);
  for (const usage of [
    { input_tokens: 100, output_tokens: 20 },
    {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 90,
      cache_write_tokens: 20,
    },
    {
      input_tokens: 100.5,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  ]) {
    const r = await s.send(otlp({ usage }));
    assert.equal(r.status, 200);
    assert.equal(r.body.partialSuccess.rejectedLogRecords, "1");
  }
  assert.equal((await s.view()).sessions.length, 0);
  assert.equal(
    (await s.send(otlp({ extra: [attr("event.name", "api_request")] }))).status,
    400,
  );
  const codex = await s.send(
    otlp({
      harness: "codex",
      name: "codex.response_usage",
      usage: { input_tokens: 50, output_tokens: 10 },
    }),
  );
  assert.equal(codex.status, 200);
  const view = await s.view();
  assert.equal(view.usage.total_tokens, 60);
  assert.equal(view.usage.cache_read_tokens, null);
  assert.equal(view.sessions[0].usage.status, "reported");
});

test("initial Codex metadata cannot reset an observed active session", async (t) => {
  const s = await setup(t),
    time = BigInt(Date.now()) * 1_000_000n;
  await s.send(
    otlp({ harness: "codex", name: "codex.user_prompt", time, usage: null }),
  );
  await s.send(
    otlp({
      harness: "codex",
      name: "codex.conversation_starts",
      time: time + 1n,
      usage: null,
    }),
  );
  assert.equal((await s.view()).sessions[0].activity, "working");
});

test("bounded gzip, privacy, media types and origin restrictions apply before observation writes", async (t) => {
  const s = await setup(t);
  assert.equal(
    (
      await s.scoped("otel/v1/logs", gzipSync(JSON.stringify(otlp())), {
        "X-AgentRun-Selections-Revision": "1",
        "Content-Encoding": "gzip",
      })
    ).status,
    200,
  );
  assert.equal(
    (await s.send({ resourceLogs: [], padding: "x".repeat(70_000) })).status,
    413,
  );
  const bomb = gzipSync(
    JSON.stringify({ resourceLogs: [], padding: "x".repeat(70_000) }),
  );
  assert.equal(
    (
      await s.scoped("otel/v1/logs", bomb, {
        "X-AgentRun-Selections-Revision": "1",
        "Content-Encoding": "gzip",
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await s.scoped("otel/v1/logs", Buffer.from([1, 2]), {
        "X-AgentRun-Selections-Revision": "1",
        "Content-Type": "application/x-protobuf",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await s.request("POST", "/connectors", registration(), s.token, {
        Origin: "https://unrelated.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await s.api("GET", "/openapi.json")).body.paths["/observations"].get
      .operationId,
    "getObservations",
  );
});

test("receipt expiry retains accepted usage and refuses an old replay without resurrecting expired sessions", async (t) => {
  const s = await setup(t),
    base = Date.now();
  let clock = base;
  const observer = new Observations(s.store, () => clock);
  const original = otlp({ time: BigInt(base) * 1_000_000n });
  await observer.otlp(s.connector.id, s.credential, original, 1);
  clock = base + 8 * 86_400_000;
  const expired = await observer.otlp(
    s.connector.id,
    s.credential,
    original,
    1,
  );
  assert.equal(expired.partialSuccess.rejectedLogRecords, "1");
  let snapshot = await observer.snapshot();
  assert.equal(snapshot.usage.total_tokens, 120);
  assert.equal(snapshot.connectors[0].receipt_count, 0);
  assert.equal(snapshot.sessions.length, 1);
  await observer.otlp(
    s.connector.id,
    s.credential,
    otlp({
      time: BigInt(clock) * 1_000_000n,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    }),
    1,
  );
  snapshot = await observer.snapshot();
  assert.equal(snapshot.usage.total_tokens, 131);
  assert.equal(snapshot.connectors[0].receipt_count, 1);
  clock = base + 99 * 86_400_000;
  const renewed = await observer.rotate(s.connector.id);
  await observer.otlp(s.connector.id, renewed.credential, original, 1);
  snapshot = await observer.snapshot();
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.usage.total_tokens, 0);
});

test("a report exceeding exact retained token accounting is rejected atomically and cannot poison reads", async (t) => {
  const s = await setup(t),
    time = BigInt(Date.now()) * 1_000_000n;
  const large = {
    input_tokens: Number.MAX_SAFE_INTEGER,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  assert.equal((await s.send(otlp({ time, usage: large }))).status, 200);
  const overflow = await s.send(
    otlp({
      time: time + 1n,
      usage: {
        input_tokens: 1,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    }),
  );
  assert.equal(overflow.status, 409);
  const snapshot = await s.view();
  assert.equal(snapshot.usage.total_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.connectors[0].receipt_count, 1);
});

test("overflow across independently valid connectors keeps sessions readable and marks aggregate unavailable", async (t) => {
  const s = await setup(t);
  const other = await s.request("POST", "/connectors", registration());
  const usage = {
    input_tokens: Number.MAX_SAFE_INTEGER,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  assert.equal((await s.send(otlp({ usage }))).status, 200);
  const response = await s.request(
    "POST",
    `/connectors/${other.body.connector.id}/otel/v1/logs`,
    otlp({ usage }),
    other.body.credential,
    { "X-AgentRun-Selections-Revision": "1" },
  );
  assert.equal(response.status, 200);
  const snapshot = await s.view();
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.usage.status, "unavailable");
  assert.equal(snapshot.usage.overflow, true);
  assert.equal(snapshot.usage.total_tokens, null);
  assert.equal(snapshot.usage.daily[0].total_tokens, null);
  assert.ok(
    snapshot.sessions.every(
      (s) => s.usage.total_tokens === Number.MAX_SAFE_INTEGER,
    ),
  );
});

test("all accepted opaque source ids keep immutable bindings, including prototype names", async (t) => {
  const s = await setup(t);
  const selected = { ...source, source_id: "__proto__" };
  const first = await s.request(
    "PATCH",
    `/connectors/${s.connector.id}/selections`,
    {
      selections_revision: 1,
      selections: [selected, sourceCodex],
    },
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.selections_revision, 2);
  const rebound = await s.request(
    "PATCH",
    `/connectors/${s.connector.id}/selections`,
    {
      selections_revision: 2,
      selections: [{ ...selected, harness: "codex" }, source],
    },
  );
  assert.equal(rebound.status, 409);
  assert.equal(rebound.body.detail.code, "connector_source_rebound");
  const snapshot = await s.view();
  assert.equal(snapshot.connectors[0].selections_revision, 2);
  assert.equal(
    snapshot.connectors[0].selections.find((s) => s.source_id === "__proto__")
      .harness,
    "claude",
  );
});

test("idle revoked sources are durably swept without new telemetry and no-op sweeps do not write", async (t) => {
  const s = await setup(t);
  const base = Date.now();
  let clock = base;
  const observer = new Observations(s.store, () => clock);
  await observer.otlp(
    s.connector.id,
    s.credential,
    otlp({ time: BigInt(base) * 1_000_000n }),
    1,
  );
  await observer.revoke(s.connector.id);
  const key = `observation.connector.${s.connector.id}`;
  const before = await s.store.settings.get(key);
  assert.equal(Object.keys(before.receipts).length, 1);
  assert.equal((await observer.sweep()).pruned_connectors, 0);
  assert.deepEqual(await s.store.settings.get(key), before);
  clock = base + 8 * 86_400_000;
  assert.equal((await observer.sweep()).pruned_connectors, 1);
  const pruned = await s.store.settings.get(key);
  assert.equal(Object.keys(pruned.receipts).length, 0);
  assert.equal(Object.keys(pruned.sessions).length, 1);
  assert.equal(pruned.state, "revoked");
  assert.equal(pruned.credential_hash, before.credential_hash);
  clock = base + 92 * 86_400_000;
  assert.equal((await observer.sweep()).pruned_connectors, 1);
  const expired = await s.store.settings.get(key);
  assert.deepEqual(expired.receipts, {});
  assert.deepEqual(expired.sessions, {});
  assert.equal(expired.state, "revoked");
  assert.equal((await observer.sweep()).pruned_connectors, 0);
  assert.deepEqual(await s.store.settings.get(key), expired);
});

test("retention preserves late-arriving usage until its own received day expires", async (t) => {
  const s = await setup(t);
  const base = Date.now();
  let clock = base;
  const observer = new Observations(s.store, () => clock);
  await observer.otlp(
    s.connector.id,
    s.credential,
    otlp({
      time: BigInt(base + 240_000) * 1_000_000n,
      name: "agentrun.session.idle",
      usage: null,
    }),
    1,
  );
  clock += 6 * 86_400_000;
  await observer.otlp(
    s.connector.id,
    s.credential,
    otlp({ time: BigInt(base) * 1_000_000n }),
    1,
  );
  clock = base + 92 * 86_400_000;
  await observer.sweep();
  const stored = await s.store.settings.get(
    `observation.connector.${s.connector.id}`,
  );
  assert.equal(Object.keys(stored.sessions).length, 1);
  assert.equal(
    Object.keys(Object.values(stored.sessions)[0].usage_by_day).length,
    1,
  );
  assert.equal(
    (await observer.snapshot()).sessions.length,
    0,
    "expired activity is hidden even while later usage is retained",
  );
  clock = base + 98 * 86_400_000;
  await observer.sweep();
  assert.deepEqual(
    (await s.store.settings.get(`observation.connector.${s.connector.id}`))
      .sessions,
    {},
  );
});

test("scheduled retention starts immediately, sweeps idle sources and stops before the store closes", async (t) => {
  const s = await setup(t);
  const base = Date.now();
  let clock = base;
  const observer = new Observations(s.store, () => clock);
  await observer.otlp(
    s.connector.id,
    s.credential,
    otlp({ time: BigInt(base) * 1_000_000n }),
    1,
  );
  await observer.revoke(s.connector.id);
  const errors = [];
  const stop = await maintainObservations(observer, {
    intervalMs: 5,
    onError: (error) => errors.push(error),
  });
  t.after(stop);
  clock += 92 * 86_400_000;
  const key = `observation.connector.${s.connector.id}`;
  let cleaned = false;
  for (let i = 0; i < 100; i++) {
    if (Object.keys((await s.store.settings.get(key)).sessions).length === 0) {
      cleaned = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(cleaned, true);
  await stop();
  await s.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    errors,
    [],
    "a stopped retention loop does not read a closed store",
  );
});
