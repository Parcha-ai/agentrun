// What removing a server tells the delete route about Composio (McpServersOverStore.remove): the handle of the MCP server
// to delete there comes from the row the checked removal actually removed, never from a row read before it. A removal
// that lands on another credential than the one the request was allowed against (412) answers nothing to send; a preset
// whose key does not open is answered `unusable`, not as no preset at all; a server that is no preset answers nothing.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { McpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { saveMcpServer } = await import("../dist/mcp-store.js");
const { credentialMark } = await import("../dist/mcp-secret-writes.js");
const { mcpSourceKey, ownersRecord, storedSource } = await import("../dist/mcp-sources.js");

const KEY = Buffer.from(randomBytes(32));
const SEAL = KEY.toString("base64").replace(/=+$/, "");
const COMPOSIO_KEY = `not-a-secret-${"composio-key"}`;

async function servers(t) {
  const { store } = await storeOn(t);
  return { store, registry: new McpServersOverStore(store, { AGENTRUN_SEAL_KEY: SEAL }, "test") };
}
const plain = (store) => saveMcpServer(store, KEY, { name: "hn", url: "http://127.0.0.1:9/plain", auth: "none", tools: [] });
async function preset(store, id, key = COMPOSIO_KEY) {
  const row = await saveMcpServer(store, KEY, { name: "hn", url: `http://127.0.0.1:9/v3/mcp/${id}/mcp`, auth: "headers", tools: [], credential: { type: "headers", headers: { "x-api-key": key } } });
  await store.settings.put(mcpSourceKey("hn"), storedSource({ source: "composio", toolkit: "hackernews" }, row));
  return row;
}

test("a removal answers the Composio server of the row it removed, with the key that row held", async (t) => {
  const { store, registry } = await servers(t);
  await preset(store, "srv_a");
  const removed = await registry.remove("hn");
  assert.deepEqual(removed, { composio: { id: "srv_a", key: COMPOSIO_KEY } });
  assert.equal(await store.mcp.server("hn"), undefined);
});

test("a row saved as a preset after the request was allowed: the checked removal is refused (412) and answers nothing to send", async (t) => {
  const { store, registry } = await servers(t);
  const mark = credentialMark(await plain(store));
  await preset(store, "srv_new");
  await assert.rejects(registry.remove("hn", mark), (error) => error.code === "precondition_failed");
  assert.equal((await store.mcp.server("hn")).url.includes("srv_new"), true, "the new server is still there");
});

test("a removal that lands answers the handle of the row it removed, not one read earlier", async (t) => {
  const { store, registry } = await servers(t);
  const mark = credentialMark(await preset(store, "srv_old"));
  const removed = await registry.remove("hn", mark);
  assert.deepEqual(removed, { composio: { id: "srv_old", key: COMPOSIO_KEY } });
});

test("the token's removal checks again that the row is the token's: one the owner saved over after the gate's check is refused (412) and stays; the token's own goes", async (t) => {
  const { store, registry } = await servers(t);
  const row = await plain(store);
  const tokens = storedSource({ source: "url", toolkit: null }, row, false, true);
  await store.settings.put(mcpSourceKey("hn"), tokens);
  const mark = credentialMark(row);
  // The owner's save over it lands after the gate read it as the token's: its record no longer carries the mark.
  await store.settings.put(mcpSourceKey("hn"), ownersRecord(tokens));
  await assert.rejects(registry.remove("hn", mark, true), (error) => error.code === "precondition_failed");
  assert.ok(await store.mcp.server("hn"), "the owner's server stays");
  await store.settings.put(mcpSourceKey("hn"), tokens);
  assert.deepEqual(await registry.remove("hn", mark, true), {});
  assert.equal(await store.mcp.server("hn"), undefined, "the token's own is removed");
});

test("a preset whose key does not open here is `unusable`, and a server that is no preset answers nothing", async (t) => {
  const { store, registry } = await servers(t);
  const row = await preset(store, "srv_a");
  await store.mcp.put({ ...row, url: row.url.replace("127.0.0.1:9", "127.0.0.1:1") });
  assert.deepEqual(await registry.remove("hn"), { composio: { unusable: true } });
  await plain(store);
  assert.deepEqual(await registry.remove("hn"), {});
});
