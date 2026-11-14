// Deleting a Composio-preset server in Settings removes the MCP server the preset made in the owner's Composio account too
// (DELETE /api/v3.1/mcp/{id}, sent with the saved key), then forgets our row. Composio's 404 is "already gone"; a refusal or
// no answer still forgets the row, and the answer says what to remove in Composio. A server the preset did not make sends
// Composio nothing. The key is never in an answer or a log line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { secretWritePath, serve, serverLog } from "./support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const TOOLS = [{ slug: "HACKERNEWS_GET_FRONTPAGE", name: "Front page", description: "The front page." }];
const MADE = "/api/v3.1/mcp/srv_fake1";

async function setup(t, options = {}) {
  const composio = await startFakeComposio({ toolkits: { hackernews: { no_auth: true, tools: TOOLS } }, ...options });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  const saved = await server.api("PUT", "/settings/mcp-servers/hn/composio", { api_key: composio.apiKey, toolkit: "hackernews", tools: ["HACKERNEWS_GET_FRONTPAGE"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { composio, log, api: server.api };
}
const deleted = (s) => s.composio.to(MADE, "DELETE");

test("deleting a preset server deletes the one it made on Composio, with the saved key, then forgets our row", async (t) => {
  const s = await setup(t);
  const res = await s.api("DELETE", "/settings/mcp-servers/hn");
  assert.equal(res.status, 204, JSON.stringify(res.body));
  assert.equal(deleted(s).length, 1, "Composio was asked to delete the server it made");
  assert.ok(deleted(s)[0].keyOk, "the call carried the saved key as x-api-key");
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404, "our row is gone");
  assert.ok(!s.log.text().includes(s.composio.apiKey), "the log holds the key");
});

test("Composio's 404 means it is already gone: the delete goes on and says nothing is left to remove", async (t) => {
  const s = await setup(t, { fail: { path: MADE, status: 404 } });
  const res = await s.api("DELETE", "/settings/mcp-servers/hn");
  assert.equal(res.status, 204, JSON.stringify(res.body));
  assert.equal(deleted(s).length, 1);
  assert.equal((await s.api("GET", "/settings/mcp-servers/hn")).status, 404);
});

for (const status of [403, 500]) {
  test(`Composio ${status}: our row is still forgotten, and the answer says to remove it in Composio, never the key`, async (t) => {
    const s = await setup(t, { fail: { path: MADE, status } });
    const res = await s.api("DELETE", "/settings/mcp-servers/hn");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted, true);
    assert.equal(res.body.composio.removed, false);
    assert.match(res.body.composio.note, /Remove hn in Composio yourself/);
    assert.match(res.body.composio.note, /https:\/\/platform\.composio\.dev/);
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
