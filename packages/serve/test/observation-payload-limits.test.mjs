import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { serve } from "./support.mjs";
import { Observations } from "../dist/observation/observer.js";

const CONTROL_BYTES = 65_536;
const OTLP_BYTES = 1_048_576;
const source = { source_id: "selected-claude", harness: "claude", mode: "harness", external_session_id: null, include_future_sessions: true };
const attribute = (key, value) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } });

async function opened(t, mode = "otlp") {
  const s = await serve(t, { runner: false });
  const origin = s.baseUrl.replace(/\/v2$/, "");
  const request = async (path, body, { credential = s.token, encoding = "identity", type = "application/json" } = {}) => {
    const response = await fetch(origin + "/api/v2/control" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + credential, "content-type": type, "content-encoding": encoding, "X-AgentRun-Selections-Revision": "1" },
      body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const enrollment = await request("/connectors", {
    workspace_id: "local", installation_id: randomUUID(), operation_id: randomUUID(), display_name: "Payload boundary", cli_version: "0.1.11",
    adapters: [{ harness: "claude", adapter_version: "1", activity: "lifecycle" }], selections: [source], ingestion_mode: mode,
  });
  assert.equal(enrollment.status, 200, JSON.stringify(enrollment.body));
  const { connector, credential } = enrollment.body;
  const path = `/connectors/${connector.id}`;
  const stored = () => s.store.settings.get("observation.connector." + connector.id);
  const send = (body, options = {}) => request(path + "/otel/v1/logs", body, { credential, ...options });
  return { ...s, origin, request, connector, credential, path, stored, send };
}

function payload(count, usage = true) {
  const now = BigInt(Date.now()) * 1_000_000n;
  // A maximum-length allowed model and wide safe counters. All 100 accepted reports together still fit exact
  // integer accounting: this is not an aggregate-overflow case disguised as a transport regression.
  const input = Math.floor(Number.MAX_SAFE_INTEGER / 100) - 10;
  const records = Array.from({ length: count }, (_, index) => ({
    timeUnixNano: String(now + BigInt(index)), observedTimeUnixNano: "0", severityNumber: 0, severityText: "",
    body: { stringValue: "" }, flags: 0, traceId: "0".repeat(32), spanId: "0".repeat(16), droppedAttributesCount: 0,
    attributes: [attribute("event.name", usage ? "api_request" : "user_prompt"), attribute("agentrun.session_id", index.toString(16).padStart(64, "0")),
      ...(usage ? [attribute("agentrun.model", "m".repeat(128)), attribute("agentrun.input_tokens", input), attribute("agentrun.output_tokens", 5),
        attribute("agentrun.cache_read_tokens", 10_000_000_000_000), attribute("agentrun.cache_write_tokens", 10_000_000_000_000)] : [])],
  }));
  return { resourceLogs: [{ resource: { attributes: [attribute("agentrun.harness", "claude"), attribute("agentrun.source_id", source.source_id)] },
    scopeLogs: [{ scope: { name: "agentrun", version: "1" }, logRecords: records }] }] };
}

const exactJSONBytes = (size) => {
  const prefix = '{"resourceLogs":[],"padding":"', suffix = '"}';
  return Buffer.from(prefix + "x".repeat(size - Buffer.byteLength(prefix + suffix)) + suffix);
};

for (const encoding of ["identity", "gzip"]) {
  test(`OTLP accepts 100 valid wide usage records above the control-message limit (${encoding})`, async (t) => {
    const s = await opened(t), body = payload(100), raw = Buffer.from(JSON.stringify(body));
    assert.ok(raw.length > CONTROL_BYTES && raw.length < OTLP_BYTES, `the valid batch is ${raw.length} bytes`);
    const before = await s.stored();
    const reply = await s.send(encoding === "gzip" ? gzipSync(raw) : raw, { encoding });
    const overHTTP = await s.stored();
    if (reply.status !== 200) assert.deepEqual(overHTTP, before, "the old HTTP refusal saved no record before the independent parser oracle");
    // Real parser, validation and CAS, over the same real SQLite row. On the old transport all 100 pass here;
    // after the repair this is a replay of the HTTP commit, so it must not add another token or receipt.
    assert.deepEqual(await new Observations(s.store).otlp(s.connector.id, s.credential, body, 1), {});
    const validated = await s.stored();
    assert.equal(Object.keys(validated.receipts).length, 100, "every record passes the receiver's existing checks");
    assert.equal(Object.keys(validated.sessions).length, 100);
    assert.equal(validated.count, 100);
    const capabilities = await fetch(s.origin + "/api/v2/control/connectors/capabilities").then((response) => response.json());
    assert.deepEqual([reply.status, Object.keys(overHTTP.receipts).length, capabilities.max_payload_bytes], [200, 100, OTLP_BYTES]);
    assert.equal(capabilities.max_log_records, 100);
    assert.deepEqual(reply.body, {});
    const accounting = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["last_heartbeat_at", "updated_at", "receipt_floor"].includes(key)));
    assert.deepEqual(accounting(overHTTP), accounting(validated), "parser replay preserves every non-liveness field, including all receipts and session usage");
    assert.ok(Date.parse(validated.last_heartbeat_at) >= Date.parse(overHTTP.last_heartbeat_at));
    assert.ok(Date.parse(validated.updated_at) >= Date.parse(overHTTP.updated_at));
    assert.ok(validated.receipt_floor >= overHTTP.receipt_floor);
  });
}

for (const encoding of ["identity", "gzip"]) {
  test(`OTLP refuses a valid JSON envelope above its byte limit without writes (${encoding})`, async (t) => {
    const s = await opened(t), before = await s.stored(), raw = exactJSONBytes(OTLP_BYTES + 1);
    assert.equal(raw.length, OTLP_BYTES + 1);
    const wire = encoding === "gzip" ? gzipSync(raw) : raw;
    if (encoding === "gzip") assert.ok(wire.length < CONTROL_BYTES, "only expanded bytes exceed the bound");
    const refused = await s.send(wire, { encoding });
    assert.equal(refused.status, 413, JSON.stringify(refused.body));
    assert.deepEqual(await s.stored(), before);
  });
}

test("OTLP still refuses a compact 101-record batch before any receipt or activity commits", async (t) => {
  const s = await opened(t), before = await s.stored(), body = payload(101, false);
  // Remove optional zero-valued OTLP fields so the record-count guard is independently reached, even at the old cap.
  for (const record of body.resourceLogs[0].scopeLogs[0].logRecords)
    for (const key of Object.keys(record)) if (!["timeUnixNano", "attributes"].includes(key)) delete record[key];
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < CONTROL_BYTES);
  const refused = await s.send(body);
  assert.equal(refused.status, 413, JSON.stringify(refused.body));
  assert.deepEqual(await s.stored(), before);
});

for (const operation of ["heartbeat", "events", "enrollment"]) {
  test(`observation ${operation} keeps its 64 KiB control-message limit`, async (t) => {
    const s = await opened(t, "polling"), before = await s.stored(), raw = exactJSONBytes(CONTROL_BYTES + 1);
    assert.ok(raw.length < OTLP_BYTES);
    const refused = await s.request(operation === "enrollment" ? "/connectors" : s.path + "/" + operation, raw, { credential: operation === "enrollment" ? s.token : s.credential });
    assert.equal(refused.status, 413, JSON.stringify(refused.body));
    assert.deepEqual(await s.stored(), before);
    assert.equal((await s.store.settings.all({ prefix: "observation.connector." })).length, 1);
  });
}

test("OTLP still authenticates before accepting its larger body or checking media encoding", async (t) => {
  const s = await opened(t), before = await s.stored();
  const refused = await s.send(exactJSONBytes(CONTROL_BYTES + 1), { credential: "not-a-secret", type: "text/plain" });
  assert.equal(refused.status, 401, JSON.stringify(refused.body));
  assert.deepEqual(await s.stored(), before);
});
