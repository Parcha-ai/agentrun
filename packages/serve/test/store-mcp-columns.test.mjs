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

test("server_info and instructions round-trip through a save and read back from the store", async (t) => {
  const { store } = await storeOn(t);
  const row = await saveMcpServer(store, KEY, base({ serverInfo: { name: "GitHub MCP", version: "1.2.3" }, instructions: "Call create_issue to open issues." }));
  assert.deepEqual(row.serverInfo, { name: "GitHub MCP", version: "1.2.3" });
  assert.equal(row.instructions, "Call create_issue to open issues.");
  const read = await store.mcp.server("github");
  assert.deepEqual(read.serverInfo, { name: "GitHub MCP", version: "1.2.3" }, "reads back from the store");
  assert.equal(read.instructions, "Call create_issue to open issues.");
});

test("a server saved without them reads null", async (t) => {
  const { store } = await storeOn(t);
  const row = await saveMcpServer(store, KEY, base());
  assert.equal(row.serverInfo, null);
  assert.equal(row.instructions, null);
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
