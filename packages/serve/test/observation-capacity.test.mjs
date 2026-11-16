import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Observations } from "../dist/observation/observer.js";
import { release, stores } from "./runner-support.mjs";
import { raw } from "./store-target.mjs";

const prefix = "observation.connector.";
const registration = () => ({
  workspace_id: "local", installation_id: randomUUID(), operation_id: randomUUID(),
  display_name: "Capacity fixture", cli_version: "0.1.10",
  adapters: [{ harness: "claude", adapter_version: "1", activity: "lifecycle" }],
  selections: [{ source_id: "selected", harness: "claude", mode: "harness", external_session_id: null, include_future_sessions: true }],
  ingestion_mode: "polling",
});

async function fixture(t) {
  const opened = await stores();
  t.after(() => release(opened));
  const left = new Observations(opened.server), right = new Observations(opened.runners[0]);
  for (let n = 0; n < 99; n++) await left.register(registration());
  return { opened, left, right };
}

// Both independent store handles reach the actual insertion boundary before either writes. On the old path each
// register has already read the same 99-row count; the store must enforce the bound inside its transaction instead.
async function concurrentInserts(t, opened, work) {
  let arrived = 0, open;
  const ready = new Promise(resolve => { open = resolve; });
  const restore = [];
  for (const store of [opened.server, opened.runners[0]]) {
    const put = store.settings.putIfAbsent;
    store.settings.putIfAbsent = async (...args) => {
      if (args[0].startsWith(prefix)) {
        if (++arrived === 2) open();
        await ready;
      }
      return put(...args);
    };
    restore.push(() => { store.settings.putIfAbsent = put; });
  }
  t.after(() => { open(); restore.forEach(fn => fn()); });
  try {
    const results = await Promise.allSettled(work());
    assert.equal(arrived, 2, "both stores reached insertion before either could commit");
    return results;
  } finally {
    restore.forEach(fn => fn());
  }
}

test("distinct installations racing at 99 connectors commit only one new enrollment across store handles", { timeout: 15_000 }, async t => {
  const { opened, left, right } = await fixture(t);
  await opened.server.settings.put("unrelated.connector", { intact: true });
  const results = await concurrentInserts(t, opened, () => [left.register(registration()), right.register(registration())]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const refused = results.filter(result => result.status === "rejected");
  assert.equal(refused.length, 1);
  assert.deepEqual([refused[0].reason.status, refused[0].reason.code], [429, "connector_capacity_exceeded"]);
  assert.equal((await opened.server.settings.all({ prefix })).length, 100, "the durable namespace never exceeds its limit");
  assert.equal((await right.list()).items.length, 100);
  await assert.rejects(left.register(registration()), error => error.status === 429 && error.code === "connector_capacity_exceeded");
  assert.deepEqual(await opened.server.settings.get("unrelated.connector"), { intact: true });
});

test("same-installation races retain one identity and revoked re-enrollment still works at capacity", { timeout: 15_000 }, async t => {
  const { opened, left, right } = await fixture(t);
  const request = registration();
  const results = await concurrentInserts(t, opened, () => [left.register(request), right.register(request)]);
  const fulfilled = results.filter(result => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  const refused = results.find(result => result.status === "rejected");
  assert.deepEqual([refused.reason.status, refused.reason.code], [409, "connector_reauthentication_required"]);
  const original = fulfilled[0].value;
  await assert.rejects(right.register(request), error => error.status === 409 && error.code === "connector_reauthentication_required");
  await left.revoke(original.connector.id);
  const changedSource = { ...request, selections: [{ ...request.selections[0], mode: "project" }] };
  await assert.rejects(right.register(changedSource), error => error.status === 409 && error.code === "connector_source_rebound");
  const renewed = await right.register({ ...request, operation_id: randomUUID() });
  assert.equal(renewed.connector.id, original.connector.id);
  assert.notEqual(renewed.credential, original.credential);
  assert.equal(renewed.connector.selections_revision, 2);
  assert.equal((await opened.server.settings.all({ prefix })).length, 100);
});

test("bounded settings insertion counts literal raw namespace keys and preserves existing null values", async t => {
  const opened = await stores();
  let db;
  t.after(async () => { await db?.close(); await release(opened); });
  const { settings } = opened.server, capacity = { prefix: "capacity._%.", limit: 1 };
  db = await raw(opened.file);
  await settings.put("capacity.Xother", { unrelated: true });
  const nonConnector = JSON.stringify("not a connector object");
  await db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", capacity.prefix + "non-connector", nonConnector, Date.now());
  assert.equal(await settings.putIfAbsent(capacity.prefix + "new", { accepted: false }, capacity), undefined, "a raw namespace key counts even when its valid JSON value is no connector object");
  assert.equal((await db.get("SELECT value FROM settings WHERE key = ?", capacity.prefix + "non-connector")).value, nonConnector);
  await settings.remove(capacity.prefix + "non-connector");
  assert.equal(await settings.putIfAbsent(capacity.prefix + "kept", null, capacity), null, "LIKE metacharacters in a prefix are literal");
  assert.equal(await opened.runners[0].settings.putIfAbsent(capacity.prefix + "kept", "replacement", capacity), null, "an existing null value wins even when the namespace is full");
  assert.equal(await settings.putIfAbsent(capacity.prefix + "new", "over limit", capacity), undefined);
  assert.equal(await settings.get(capacity.prefix + "new"), undefined);
  for (const invalid of [{ prefix: "elsewhere.", limit: 1 }, { prefix: "", limit: 1 }, { prefix: "bad\0prefix", limit: 1 }, { ...capacity, limit: 0 }, { ...capacity, limit: Infinity }, { ...capacity, limit: 1.5 }]) {
    await assert.rejects(settings.putIfAbsent(capacity.prefix + "bad", "ignored", invalid), TypeError);
  }
  assert.deepEqual(await settings.get("capacity.Xother"), { unrelated: true });
});
