import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startSourceMcp } from "./fixtures/source-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";

async function connected(t, fixture, token) {
  const client = new Client({ name: "source-move-fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  t.after(() => client.close());
  return client;
}
const text = result => JSON.parse(result.content[0].text);
const resourceText = result => JSON.parse(result.contents[0].text);
const dispatches = fixture => fixture.audit.filter(row => row.phase === "dispatch");

test("source and destination credentials identify their actual principal; tool grants remain a client responsibility", async t => {
  const fixture = await startSourceMcp(); t.after(() => fixture.close());
  const source = fixture.issue("team-a"), destination = fixture.issue("team-a"), other = fixture.issue("team-b");
  assert.notEqual(source, destination);
  const a = await connected(t, fixture, source), b = await connected(t, fixture, destination), c = await connected(t, fixture, other);
  const tools = await a.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ["read_allowed", "delete_denied"]);
  assert.equal(tools.tools[0].annotations.readOnlyHint, true);
  assert.equal(tools.tools[1].annotations.readOnlyHint, false);
  assert.equal(tools.tools[1].annotations.destructiveHint, true);
  for (const client of [a, b]) assert.deepEqual(text(await client.callTool({ name: "read_allowed", arguments: { item: "alpha" } })), { principal: "team-a", item: "alpha", value: 17 });
  assert.equal(text(await c.callTool({ name: "read_allowed", arguments: { item: "beta" } })).principal, "team-b");
  // The endpoint really can execute this tool. A later zero-dispatch native/managed test therefore proves the client's gate.
  assert.equal(text(await a.callTool({ name: "delete_denied", arguments: {} })).deleted, true);
  assert.deepEqual(dispatches(fixture).map(row => [row.tool, row.principal]), [["read_allowed", "team-a"], ["read_allowed", "team-a"], ["read_allowed", "team-b"], ["delete_denied", "team-a"]]);
  for (const token of [source, destination, other]) assert.ok(!JSON.stringify(fixture.audit).includes(token));
});

test("static resources and templates page independently and read through the authenticated SDK", async t => {
  const fixture = await startSourceMcp({ pageSize: 1 }); t.after(() => fixture.close());
  const client = await connected(t, fixture, fixture.issue("team-a"));
  const first = await client.request({ method: "resources/list" });
  assert.equal(first.resources.length, 1); assert.ok(first.nextCursor);
  const second = await client.request({ method: "resources/list", params: { cursor: first.nextCursor } });
  assert.equal(second.resources.length, 1); assert.notEqual(first.resources[0].uri, second.resources[0].uri);
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual((await client.listResources()).resources.map(row => row.uri), ["fixture://catalog/info", "fixture://catalog/rules"]);
  const templates = await client.listResourceTemplates();
  assert.deepEqual(templates.resourceTemplates.map(row => row.uriTemplate), ["fixture://item/{item}", "fixture://note/{item}"]);
  assert.deepEqual(resourceText(await client.readResource({ uri: "fixture://catalog/info" })), { principal: "team-a", marker: "catalog-v1" });
  assert.deepEqual(resourceText(await client.readResource({ uri: "fixture://item/gamma" })), { principal: "team-a", item: "gamma", value: 41 });
  assert.equal(dispatches(fixture).filter(row => row.method === "resources/read").length, 2);
  await assert.rejects(client.request({ method: "resources/list", params: { cursor: "not-a-cursor" } }));
});

test("a resource-only server advertises no tools and still supports authenticated list, templates and reads", async t => {
  const fixture = await startSourceMcp({ resourceOnly: true }); t.after(() => fixture.close());
  const client = await connected(t, fixture, fixture.issue("team-a"));
  assert.equal(client.getServerCapabilities().tools, undefined);
  assert.ok(client.getServerCapabilities().resources);
  assert.equal((await client.listResources()).resources.length, 2);
  assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 2);
  assert.equal(resourceText(await client.readResource({ uri: "fixture://note/beta" })).item, "beta");
  await assert.rejects(client.callTool({ name: "read_allowed", arguments: { item: "alpha" } }));
  assert.equal(dispatches(fixture).filter(row => row.method === "tools/call").length, 0);
});

test("adding a tool changes the upstream catalogue, while revoked credentials cannot dispatch and reconnect preserves principal", async t => {
  const fixture = await startSourceMcp(); t.after(() => fixture.close());
  const old = fixture.issue("team-a"), client = await connected(t, fixture, old);
  assert.equal((await client.listTools()).tools.length, 2);
  fixture.addReadTool("later_read");
  assert.deepEqual((await client.listTools()).tools.map(row => row.name), ["read_allowed", "delete_denied", "later_read"]);
  fixture.revoke(old);
  const before = dispatches(fixture).length;
  await assert.rejects(client.callTool({ name: "later_read", arguments: { item: "alpha" } }));
  assert.equal(dispatches(fixture).length, before);
  const next = fixture.issue("team-a"), reconnected = await connected(t, fixture, next);
  assert.equal(text(await reconnected.callTool({ name: "later_read", arguments: { item: "alpha" } })).principal, "team-a");
  assert.ok(fixture.audit.some(row => row.phase === "request" && row.authorized === false && row.principal === null));
  for (const token of [old, next]) assert.ok(!JSON.stringify(fixture.audit).includes(token));
});

test("audit never retains headers, arguments, unknown method names, resource values or request IDs", async t => {
  const fixture = await startSourceMcp(); t.after(() => fixture.close());
  const token = fixture.issue("team-a");
  const bare = await fetch(fixture.url, { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(bare.status, 401, "a credential without the Bearer scheme is not authentication");
  for (const body of [{ jsonrpc: "2.0", id: token, method: token, params: { token } },
    { jsonrpc: "2.0", id: token, method: "resources/read", params: { uri: `fixture://item/${token}` } }]) {
    await fetch(fixture.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  }
  assert.ok(fixture.audit.length > 0);
  assert.ok(!JSON.stringify(fixture.audit).includes(token));
  assert.ok(fixture.audit.every(row => Object.keys(row).every(key => ["sequence", "phase", "method", "principal", "authorized", "tool", "resource"].includes(key))));
  assert.ok(fixture.audit.some(row => row.method === "unknown"));
});

test("the existing PKCE fixture can authenticate the same endpoint after OAuth reconnect", async t => {
  const oauth = await startFakeOAuth(); t.after(() => oauth.close());
  const fixture = await startSourceMcp({ oauth: { issuer: oauth.issuer, accepts: oauth.accepts, principal: "oauth-team" } }); t.after(() => fixture.close());
  const response = await fetch(fixture.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert.equal(response.status, 401);
  const metadata = /resource_metadata="([^"]+)"/.exec(response.headers.get("www-authenticate"))[1];
  assert.deepEqual(await (await fetch(metadata)).json(), { resource: fixture.url, authorization_servers: [oauth.issuer] });
  const grant = async () => {
    const redirect = "http://127.0.0.1/callback", verifier = randomBytes(32).toString("base64url");
    const registration = await (await fetch(`${oauth.issuer}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json();
    const authorize = new URL(`${oauth.issuer}/authorize`);
    authorize.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirect, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: fixture.url });
    const approved = await fetch(authorize, { redirect: "manual" }); assert.equal(approved.status, 302);
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    const exchange = await fetch(`${oauth.issuer}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: redirect, code_verifier: verifier, code }) });
    assert.equal(exchange.status, 200);
    return exchange.json();
  };
  const set = await grant();
  const client = await connected(t, fixture, set.access_token);
  assert.equal(text(await client.callTool({ name: "read_allowed", arguments: { item: "alpha" } })).principal, "oauth-team");
  oauth.revoke();
  await assert.rejects(client.callTool({ name: "read_allowed", arguments: { item: "alpha" } }));
  const next = await grant(), reconnected = await connected(t, fixture, next.access_token);
  assert.equal(text(await reconnected.callTool({ name: "read_allowed", arguments: { item: "beta" } })).principal, "oauth-team");
  for (const token of [set.access_token, set.refresh_token, next.access_token, next.refresh_token]) assert.ok(!JSON.stringify(fixture.audit).includes(token));
});
