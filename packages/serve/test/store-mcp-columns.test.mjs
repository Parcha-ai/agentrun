// server_info and instructions as mcp_servers columns (mcp-store.ts saveMcpServer over store.mcp): the remote server's
// reported info and its instructions, carried through a save and round-tripping; absent reads null; bounded at save, since
// both come from the remote server (untrusted), so the store never holds them unbounded.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { saveMcpServer, MCP_META_MAX_BYTES } = await import("../dist/mcp-store.js");
const KEY = Buffer.from(randomBytes(32));
const base = (over = {}) => ({ name: "github", url: "https://mcp.example.com/github", auth: "none", tools: [], ...over });

test("server_info and instructions round-trip through a save and read back from the store; saved without them, both read null", async (t) => {
  const { store } = await storeOn(t);
  const row = await saveMcpServer(store, KEY, base({ serverInfo: { name: "GitHub MCP", version: "1.2.3" }, instructions: "Call create_issue to open issues." }));
  assert.deepEqual(row.serverInfo, { name: "GitHub MCP", version: "1.2.3" });
  assert.equal(row.instructions, "Call create_issue to open issues.");
  const read = await store.mcp.server("github");
  assert.deepEqual(read.serverInfo, { name: "GitHub MCP", version: "1.2.3" }, "reads back from the store");
  assert.equal(read.instructions, "Call create_issue to open issues.");
  // Saved without them, both read null.
  const bare = await saveMcpServer(store, KEY, base({ name: "plain" }));
  assert.deepEqual([bare.serverInfo, bare.instructions], [null, null]);
});

test("a save sets listed_at with updated_at; a later save that keeps updated_at (a refresh) moves listed_at alone", async (t) => {
  const { store, clock } = await storeOn(t);
  const first = await saveMcpServer(store, KEY, base({ serverInfo: { name: "GitHub" } }));
  assert.equal(first.listedAt, first.updatedAt, "a save: listed_at is the update time");
  clock.now += 1000;
  // A refresh keeps updated_at (passed back) and lets listed_at move.
  const refreshed = await saveMcpServer(store, KEY, base({ serverInfo: { name: "GitHub v2" }, updatedAt: first.updatedAt }));
  assert.equal(refreshed.updatedAt, first.updatedAt, "updated_at is kept, so a refresh isn't an edit");
  assert.ok(refreshed.listedAt > first.updatedAt, "listed_at moved to the refresh time");
  assert.equal((await store.mcp.server("github")).listedAt, refreshed.listedAt, "reads back from the store");
});

test("both are bounded at save: oversized instructions are trimmed to the cap, oversized server_info drops to null", async (t) => {
  const { store } = await storeOn(t);
  const big = "x".repeat(MCP_META_MAX_BYTES + 5000);
  const row = await saveMcpServer(store, KEY, base({ serverInfo: { blob: big }, instructions: big }));
  assert.ok(Buffer.byteLength(row.instructions, "utf8") <= MCP_META_MAX_BYTES, "instructions trimmed to the cap");
  assert.equal(row.serverInfo, null, "oversized server_info dropped to null, never stored unbounded");
  const read = await store.mcp.server("github");
  assert.ok(Buffer.byteLength(read.instructions, "utf8") <= MCP_META_MAX_BYTES && read.serverInfo === null, "the store holds the bounded forms");
});
