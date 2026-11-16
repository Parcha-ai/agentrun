// Deleting a Composio-preset server in Settings removes the MCP server the preset made in the owner's Composio account too
// (DELETE /api/v3.1/mcp/{id}, sent with the saved key), then forgets our row. Composio's 404 is "already gone"; a refusal or
// no answer still forgets the row, and the answer says what to remove in Composio. Either way a preset's delete answers
// 200 with what it removed there in words (mcp-composio-cleanup.test.mjs: the auth config and account too). A server the
// preset did not make sends Composio nothing, and answers 204. The key is never in an answer or a log line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { secretWritePath, serve, serverLog } from "./support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const TOOLS = [{ slug: "HACKERNEWS_GET_FRONTPAGE", name: "Front page", description: "The front page." }];
/** The delete of the MCP server the save made on Composio: its id is the fake's, new each start. */
const MADE = { method: "DELETE", path: (path) => /^\/api\/v3\.1\/mcp\/srv_fake_[0-9a-f]+$/.test(path) };

async function setup(t, options = {}) {
  const composio = await startFakeComposio({ toolkits: { hackernews: { no_auth: true, tools: TOOLS } }, ...options });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  const saved = await server.api("PUT", "/settings/mcp-servers/hn/composio", { api_key: composio.apiKey, toolkit: "hackernews", tools: ["HACKERNEWS_GET_FRONTPAGE"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { composio, log, api: server.api, store: server.store };
}
const deleted = (s) => s.composio.to(`/api/v3.1/mcp/${s.composio.mcpId}`, "DELETE");

test("deleting a preset server deletes the one it made on Composio, with the saved key, then forgets our row", async (t) => {
  const s = await setup(t);
  const res = await s.api("DELETE", "/settings/mcp-servers/hn");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { deleted: true, composio: { removed: true, note: `Removed in Composio: the MCP server ${s.composio.mcpId}.` } });
  assert.equal(deleted(s).length, 1, "Composio was asked to delete the server it made");
  assert.ok(deleted(s)[0].keyOk, "the call carried the saved key as x-api-key");
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404, "our row is gone");
  assert.ok(!s.log.text().includes(s.composio.apiKey), "the log holds the key");
});

test("Composio's 404 means it is already gone: the delete goes on and says nothing is left to remove", async (t) => {
  const s = await setup(t, { fail: { ...MADE, status: 404 } });
  const res = await s.api("DELETE", "/settings/mcp-servers/hn");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.composio, { removed: true, note: `Removed in Composio: the MCP server ${s.composio.mcpId}.` });
  assert.equal(deleted(s).length, 1);
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404);
});

for (const status of [403, 500]) {
  test(`Composio ${status}: our row is still forgotten, and the answer says to remove it in Composio, never the key`, async (t) => {
    const s = await setup(t, { fail: { ...MADE, status } });
    const res = await s.api("DELETE", "/settings/mcp-servers/hn");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted, true);
    assert.equal(res.body.composio.removed, false);
    assert.equal(res.body.composio.note, `Left in Composio: the MCP server ${s.composio.mcpId}. Remove what is left of hn in Composio yourself: https://platform.composio.dev`);
    assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404, "our row is gone");
    assert.ok(!JSON.stringify(res.body).includes(s.composio.apiKey), "the answer holds the key");
    assert.ok(!s.log.text().includes(s.composio.apiKey), "the log holds the key");
  });
}

test("a server the preset did not make sends Composio nothing", async (t) => {
  const composio = await startFakeComposio({ toolkits: {} });
  t.after(() => composio.close());
  const mcp = await startFakeMcp();
  t.after(() => mcp.close());
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  const saved = await server.api("PUT", "/settings/mcp-servers/plain", { url: mcp.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const res = await server.api("DELETE", "/settings/mcp-servers/plain");
  assert.equal(res.status, 204, JSON.stringify(res.body));
  assert.equal(composio.calls.length, 0, "Composio was never called");
});

test("a preset whose saved key does not open here: our row is forgotten, nothing is sent to Composio, and the answer says to remove it there", async (t) => {
  const s = await setup(t);
  const row = await s.store.mcp.server("hn");
  // The row's address moved to another origin (a direct edit): its sealed key is bound to the old one, so it does not open.
  await s.store.mcp.put({ ...row, url: row.url.replace(new URL(row.url).origin, "http://127.0.0.1:1") });
  const res = await s.api("DELETE", "/settings/mcp-servers/hn");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.composio.removed, false);
  assert.match(res.body.composio.note, /^Left in Composio: the MCP server it made \(the saved key doesn't open here\)\. Remove what is left of hn in Composio yourself: https:\/\/platform\.composio\.dev$/);
  assert.equal(deleted(s).length, 0, "no DELETE was sent");
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404, "our row is gone");
});

test("a preset row the owner edited to another service (same path shape, another address and key) is no longer Composio's: deleting it sends that key nowhere near Composio", async (t) => {
  const s = await setup(t);
  const other = await startFakeMcp({ path: "/v3/mcp/x/mcp" });
  t.after(() => other.close());
  const edited = await s.api("PUT", "/settings/mcp-servers/hn", { url: other.url, auth: { type: "headers", headers: { "x-api-key": "not-a-secret" } } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  // The edit moved it off Composio: the MCP server the preset made there went then, with the key it was saved with.
  assert.deepEqual(edited.body.composio, { removed: true, note: `Removed in Composio: the MCP server ${s.composio.mcpId}.` });
  assert.equal(deleted(s).length, 1);
  const before = s.composio.calls.length;
  const res = await s.api("DELETE", "/settings/mcp-servers/hn");
  assert.equal(res.status, 204, "it is another service's server now, deleted as any other");
  assert.equal(s.composio.calls.length, before, "Composio got no call at all from the delete");
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404, "our row is gone");
});

test("a preset row moved to another address keeps the toolkit the same save names, and is url's, not Composio's", async (t) => {
  const s = await setup(t);
  const other = await startFakeMcp({ path: "/v3/mcp/x/mcp" });
  t.after(() => other.close());
  const named = await s.api("PUT", "/settings/mcp-servers/hn", { url: other.url, toolkit: "gmail", auth: { type: "headers", headers: { "x-api-key": "not-a-secret" } } });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  const read = await s.api("GET", "/settings/mcp-servers/hn");
  assert.equal(read.body.source, "url", "it is no longer Composio's");
  assert.equal(read.body.toolkit, "gmail", "the toolkit the owner named in that save is kept");
  const cleared = await s.api("PUT", "/settings/mcp-servers/hn", { url: other.url, toolkit: null, auth: { type: "headers", headers: { "x-api-key": "not-a-secret" } } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).body.toolkit, null);
});
