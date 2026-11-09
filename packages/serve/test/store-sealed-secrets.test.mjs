// The store's one read of every sealed value it keeps (store.sealedSecrets.all), across all its planes: each row names
// its plane and its row's key, and carries the AAD it was sealed under, so the seal key opens every one and a row moved
// elsewhere does not. A runner's redaction set is built from it at each claim (runner/store-secrets.ts). A store over
// another database (Postgres) answers this same case.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seal, unseal } from "@parcha/pi-durable-agent";

const { openSqliteStore, sealColumn, sealedAt, sealMcpCredential } = await import("../dist/store/index.js");
const { DDL } = await import("../dist/store/schema.js");

const KEY = Buffer.alloc(32, 9);

test("one read answers every sealed value the store keeps, on every plane, each with the AAD that opens it", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "store-sealed-secrets-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await store.sealedSecrets.all(), [], "an empty store keeps none");
  await store.agents.create({ id: "a1", name: "A" }, { id: "r1", kind: "agentic", body: { instructions: "x" } });
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" }, { body: { input: { content: "x" } }, sealed: sealColumn(KEY, { table: "run_launch", row: "run-1", column: "sealed" }, "launch-secret") });
  await store.sealedKeys.put("TOOL_KEY", sealColumn(KEY, sealedAt.sealedKey("TOOL_KEY"), "tool-secret"));
  await store.mcp.put({ name: "m1", url: "https://mcp.invalid/mcp", auth: "bearer", tools: [], sealed: sealMcpCredential(KEY, "m1", { type: "headers", headers: { authorization: "Bearer mcp-secret" } }, "https://mcp.invalid/mcp") });
  await store.mcpOauth.put({ state: "st", server: "m1", sealed: sealColumn(KEY, sealedAt.oauthPending("st"), "pending-secret"), working: {}, expiresAt: Date.now() + 60_000 });
  await store.triggerSettings.put({ adapter: "webhook", scope: "t1", field: "secret", sealed: seal(KEY, Buffer.from("trigger-secret"), "trigger_settings|webhook|t1|secret").toString("base64") });
  await store.signIns.save({ agentId: "a1", provider: "steel", name: "S", pointerSealed: sealColumn(KEY, sealedAt.signIn("a1", "steel"), "forgotten-pointer") });
  await store.signIns.forget("a1", "steel", {});
  await store.signIns.save({ agentId: "a1", provider: "browserbase", name: "B", pointerSealed: sealColumn(KEY, sealedAt.signIn("a1", "browserbase"), "live-pointer") });
  const claim = await store.claim("run-1", "runner-a");
  assert.ok(claim, "the run is claimed, so its viewer can be written");
  assert.equal(await store.liveViewers.put(claim, { kind: "browser", tag: "s1", port: 4100, id: "i".repeat(22), sealed: sealColumn(KEY, sealedAt.liveViewer("run-1", "browser", "s1"), "viewer-token") }), true);

  const rows = await store.sealedSecrets.all();
  const opened = Object.fromEntries(rows.map((row) => [row.plane, unseal(KEY, Buffer.from(row.sealed), row.aad).toString("utf8")]));
  // Every table of the schema with a sealed column is a plane this read answers: a table that keeps a secret and is left out
  // of the read fails here, so it can never skip a runner's redaction set quietly.
  const sealedTables = DDL.flatMap((ddl) => {
    const table = /CREATE TABLE IF NOT EXISTS (\w+) \(/.exec(ddl)?.[1];
    return table && /^\s*\w*sealed\s+(BLOB|TEXT)\b/m.test(ddl) ? [table] : [];
  });
  assert.ok(sealedTables.length >= 8, `the schema's sealed tables are found: ${sealedTables}`);
  assert.deepEqual(Object.keys(opened).sort(), [...sealedTables].sort(), "the read answers a row of every table with a sealed column");
  assert.equal(opened.computer_viewers, "viewer-token");
  assert.equal(opened.sealed_keys, "tool-secret");
  assert.match(opened.mcp_servers, /mcp-secret/);
  assert.equal(opened.mcp_oauth_pending, "pending-secret");
  assert.equal(opened.trigger_settings, "trigger-secret");
  assert.equal(opened.sign_ins, "live-pointer");
  assert.equal(opened.sign_in_tombstones, "forgotten-pointer");
  assert.equal(opened.run_launch, "launch-secret");
  const trigger = rows.find((row) => row.plane === "trigger_settings");
  assert.deepEqual(trigger.where, { adapter: "webhook", scope: "t1", field: "secret" });
  // The AAD binds each value to its row: another row's AAD does not open it.
  const key = rows.find((row) => row.plane === "sealed_keys");
  assert.throws(() => unseal(KEY, Buffer.from(key.sealed), rows.find((row) => row.plane === "sign_ins").aad));
});
