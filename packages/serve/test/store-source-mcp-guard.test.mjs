import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { StoreConstraint } from "../dist/store/store.js";
import { onPostgres } from "./store-target.mjs";
import { Connection } from "../dist/store/sqlite/connection.js";
import { PgConnection } from "../dist/store/postgres/connection.js";

const initial = { name: "fixture", url: "https://mcp.example.test/tools", auth: "bearer", tools: [{ name: "read", schema: { type: "object", properties: {} } }], sealed: Uint8Array.of(1, 2, 3), credentialChangedAt: 42 };
const moved = guards => ({ id: "managed", agentId: "agent-1", kind: "agentic", body: { instructions: "Managed." }, ifCurrent: "rev-1", description: "Moved", mcpGuards: guards });
const guardOf = row => ({ name: row.name, url: row.url, auth: row.auth, tools: row.tools, sealed: row.sealed, credentialChangedAt: row.credentialChangedAt });
async function fixture(t) {
  const first = await storeOn(t); await agentWithRevision(first.store);
  const { store: other } = await storeOn(t, { file: first.file, role: "runner", clock: first.clock });
  const guard = guardOf(await first.store.mcp.put(initial));
  return { ...first, other, guard };
}

for (const [name, change] of [
  ["endpoint", { url: "https://mcp.example.test/replaced" }], ["auth method", { auth: "none" }],
  ["catalog", { tools: [{ name: "remove" }] }], ["credential time", { credentialChangedAt: 43 }],
  ["same-millisecond credential bytes", { sealed: Uint8Array.of(4, 5, 6), credentialChangedAt: 42 }], ["removed credential", { sealed: null }],
]) test(`Move refuses a ${name} change after preparation without a partial revision or description`, async t => {
  const { store, other, guard } = await fixture(t);
  await other.mcp.put({ ...initial, ...change });
  await assert.rejects(store.agents.addRevision(moved([guard])), StoreConstraint);
  assert.equal(await store.agents.revision("managed"), undefined);
  assert.equal((await store.agents.get("agent-1")).currentRevision, "rev-1");
  assert.equal((await store.agents.get("agent-1")).description, null);
});

test("Move refuses an MCP row removed after preparation; the optional guard leaves ordinary revisions unchanged", async t => {
  const { store, other, guard } = await fixture(t); await other.mcp.remove(initial.name);
  await assert.rejects(store.agents.addRevision(moved([guard])), StoreConstraint);
  const { mcpGuards, ...ordinary } = moved([]); await store.agents.addRevision(ordinary);
  assert.equal((await store.agents.get("agent-1")).currentRevision, "managed");
});

test("matching MCP tools compare as JSON values and the private guard is never persisted in the revision", async t => {
  const { store, guard } = await fixture(t);
  await store.agents.addRevision(moved([{ ...guard, tools: [{ schema: { properties: {}, type: "object" }, name: "read" }] }]));
  const revision = await store.agents.revision("managed");
  assert.deepEqual(revision.body, { instructions: "Managed." });
  assert.equal(Object.hasOwn(revision, "mcpGuards"), false);
});

test("an MCP edit committed inside the prepared cutover window makes the whole cutover refuse", { timeout: 15_000 }, async t => {
  const { store, other, guard } = await fixture(t);
  // Hold the actual external writer's database transaction after its UPDATE. This forces the cutover to encounter
  // the uncommitted replacement and then its committed state, with independent connections and real row locks.
  const entered = Promise.withResolvers(), resumed = Promise.withResolvers(), attempted = Promise.withResolvers();
  const prototype = onPostgres ? PgConnection.prototype : Connection.prototype, original = prototype.transaction;
  let held = false;
  const write = prototype.write;
  t.mock.method(prototype, "write", function (statements, options) {
    if (!statements.some(statement => statement.sql.startsWith("UPDATE mcp_servers SET url"))) return write.call(this, statements, options);
    return original.call(this, async tx => {
      const results = [];
      for (const statement of statements) results.push({ rows: await tx.all(statement.sql, ...statement.params), changes: 1 });
      held = true; entered.resolve(); await resumed.promise; return results;
    }, options);
  });
  t.mock.method(prototype, "transaction", function (call, options) {
    if (held) attempted.resolve();
    return original.call(this, tx => call(new Proxy(tx, { get(target, name) {
      const fn = Reflect.get(target, name); if (typeof fn !== "function") return fn;
      return async (...args) => {
        const result = await fn.apply(target, args);
        if (!held && typeof args[0] === "string" && args[0].startsWith("UPDATE mcp_servers SET url")) { held = true; entered.resolve(); await resumed.promise; }
        return result;
      };
    } })), options);
  });
  t.after(() => resumed.resolve());
  // rewrite is one real UPDATE; its own credential CAS ensures this is an actual registry change.
  const edit = other.mcp.rewrite({ ...initial, tools: [{ name: "remove" }] }, await other.mcp.server(initial.name));
  await entered.promise;
  const refusal = assert.rejects(store.agents.addRevision(moved([guard])), StoreConstraint);
  await attempted.promise; resumed.resolve(); await Promise.all([edit, refusal]);
  assert.equal(await store.agents.revision("managed"), undefined);
});
