// The MCP registry and OAuth pending sign-ins as store rows (mcp-store.ts over store.mcp / store.mcpOauth), sealed with the
// store's one rule (§7): the registry credential bound to the url's origin inside the sealed plaintext, the pending
// sign-in's secret parts (its verifier and OAuth client) sealed by its state. These are the store-backed primitives the cut
// wires into McpServers / McpSignIns.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { listMcpServers, openServerCredential, putPendingSignIn, removeMcpServer, saveMcpServer, takePendingSignIn } = await import("../dist/mcp-store.js");

const KEY = Buffer.from(randomBytes(32));
const server = (over = {}) => ({ name: "github", url: "https://mcp.example.com/github", auth: "headers", protocol: "2025-06-18", tools: [{ name: "create_issue", grantable: true }], prices: { create_issue: 0.01 }, credential: { type: "headers", headers: { authorization: "Bearer gh-secret" } }, ...over });

test("a server's row saves with its credential sealed, opens back with the origin, and lists; removed; with no credential it stores null", async (t) => {
  const { store } = await storeOn(t);
  const row = await saveMcpServer(store, KEY, server());
  assert.deepEqual([row.name, row.url, row.auth, row.protocol], ["github", "https://mcp.example.com/github", "headers", "2025-06-18"]);
  assert.ok(row.sealed instanceof Uint8Array, "credential sealed to bytes");
  const opened = await openServerCredential(store, KEY, "github");
  assert.deepEqual(opened.credential.headers, { authorization: "Bearer gh-secret" }, "opens back");
  assert.equal(opened.credential.origin, "https://mcp.example.com", "the url origin is bound inside");
  assert.deepEqual((await listMcpServers(store)).map((r) => r.name), ["github"]);
  await removeMcpServer(store, "github");
  assert.equal(await store.mcp.server("github"), undefined, "removed");
  // A server with no credential (auth none) keeps no sealed bytes at all; opening it says none (store-seal.test.mjs).
  await saveMcpServer(store, KEY, { name: "public", url: "https://mcp.example.com/public", auth: "none", tools: [] });
  assert.equal((await store.mcp.server("public")).sealed, null);
});

test("a credential is refused as damaged when the row's url origin changed since it was sealed (never sent to a new host)", async (t) => {
  const { store } = await storeOn(t);
  const saved = await saveMcpServer(store, KEY, server());
  // A direct store edit of the url column by someone with DB write but not the seal key: reuse the sealed bytes under a new url.
  await store.mcp.put({ name: "github", url: "https://evil.example.com/github", auth: "headers", protocol: null, tools: [], prices: null, sealed: saved.sealed });
  assert.equal((await openServerCredential(store, KEY, "github")).unusable, "damaged", "origin mismatch: not sent");
});

// The `not-a-secret-` prefix keeps the source scan from flagging this dummy credential.
const CLIENT_SECRET = `not-a-secret-${"owner-client"}`;

test("a pending sign-in's verifier and client seal together by state and are taken once with its plain working state; another seal key does not open them", async (t) => {
  const { store, clock } = await storeOn(t);
  const other = Buffer.from(randomBytes(32));
  const client = { client_id: "c-1", client_secret: CLIENT_SECRET };
  const working = { discovery: { authorizationServerUrl: "https://as.example" }, url: "https://mcp.example.com/github" };
  await putPendingSignIn(store, KEY, { state: "st-1", server: "github", verifier: "pkce-verifier-xyz", client, working, expiresAt: clock.now + 600_000 });
  assert.equal(await takePendingSignIn(store, other, "st-1"), undefined, "another seal key can't open the sealed secret parts");
  await putPendingSignIn(store, KEY, { state: "st-2", server: "github", verifier: "pkce-verifier-xyz", client, working, expiresAt: clock.now + 600_000 });
  const took = await takePendingSignIn(store, KEY, "st-2");
  assert.deepEqual([took.server, took.verifier], ["github", "pkce-verifier-xyz"]);
  assert.deepEqual(took.client, client, "the OAuth client, with its secret, comes back from the sealed blob");
  assert.deepEqual(took.working, working, "the plain working state comes back for finish()");
  assert.equal(await takePendingSignIn(store, KEY, "st-2"), undefined, "taken once");
});

test("the client secret is only in the sealed column: the plain columns (server, working) never hold it, and the sealed one is ciphertext", async (t) => {
  const { store, clock } = await storeOn(t);
  const client = { client_id: "c-1", client_secret: CLIENT_SECRET };
  const working = { discovery: { authorizationServerUrl: "https://as.example" }, url: "https://mcp.example.com/github" };
  await putPendingSignIn(store, KEY, { state: "st", server: "github", verifier: "v", client, working, expiresAt: clock.now + 600_000 });
  // take() returns the row as the store holds it: `sealed` the ciphertext blob, `working` the plain column.
  const row = await store.mcpOauth.take("st");
  assert.ok(!JSON.stringify(row.working).includes(CLIENT_SECRET), "the plain working column holds no client secret");
  assert.ok(!row.server.includes(CLIENT_SECRET), "nor the server column");
  assert.ok(!Buffer.from(row.sealed).toString("latin1").includes(CLIENT_SECRET), "and the sealed column is ciphertext, not the secret in the clear");
});

test("takePendingSignIn treats one past its expiry as gone, with a clock", async (t) => {
  const { store, clock } = await storeOn(t);
  await putPendingSignIn(store, KEY, { state: "st-old", server: "github", verifier: "v", expiresAt: clock.now + 100 });
  assert.equal(await takePendingSignIn(store, KEY, "st-old", clock.now + 100), undefined, "at expiry, gone");
});
