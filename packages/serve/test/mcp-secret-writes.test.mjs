// MCP's slice of the secret writes: which MCP operations the one gate in the server's dispatch takes from the owner's
// signed-in page alone. A save that sends a value (a bearer token or a header's value), or that would drop or change the
// credential a saved server holds; a sign-in's start (its callback seals the token set the sign-in returns); removing a
// server; the private-network OAuth hosts (they widen where sign-ins send their codes and tokens). Everything else an API
// token may still do: a server with no credential, a change of prices, tools or url that keeps the saved credential, a
// preview or a refresh (nothing new is kept).
import assert from "node:assert/strict";
import { test } from "node:test";

const { mcpWritesSecret } = await import("../dist/mcp-secret-writes.js");
const TOKEN = `not-a-secret-${"bearer"}`;

test("the table: true only for a body that carries an MCP secret value, or the private-network hosts", () => {
  for (const [operation, body, writes, why] of [
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "bearer", token: TOKEN } }, true, "a bearer token"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "headers", headers: { "X-Api-Key": TOKEN } } }, true, "a header's value"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "headers", headers: { "X-Api-Key": "" } } }, true, "a header named with a value, empty or not, is a value sent"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "none", token: TOKEN } }, true, "a token in any auth, even one the save then refuses"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "none" } }, false, "no credential"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp" }, false, "no auth at all"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "bearer" }, prices: { add: 0.01 } }, false, "prices, the saved bearer kept"],
    ["saveMcpServer", { url: "https://mcp.example.test/v2/mcp", auth: { type: "headers" } }, false, "a new url, the saved headers kept"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "headers", headers: {} } }, false, "no header named"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "oauth" } }, false, "oauth keeps its sign-in"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "github_app" } }, false, "a github_app server keeps nothing: its token is minted per run"],
    ["saveMcpServer", null, false, "no body"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", client_id: "corp-app", client_secret: TOKEN }, true, "a client secret"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", client_id: "corp-app" }, true, "a client id alone: its callback seals the sign-in's token set"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", scopes: ["read"] }, true, "no client: the same"],
    ["previewMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "bearer", token: TOKEN } }, false, "a preview keeps nothing"],
    ["putMcpPrivateHosts", { hosts: [] }, true, "the private-network hosts, whatever the body"],
    ["deleteMcpServer", undefined, false, "a delete is decided by the stored server (below), not its request"],
    ["refreshMcpServer", {}, false, "a refresh carries none"],
    ["createAgent", { auth: { type: "bearer", token: TOKEN } }, false, "not an MCP operation"],
  ]) assert.equal(mcpWritesSecret(operation, body), writes, `${operation}: ${why}`);
});

test("MCP's operations are registered with the one gate, by this predicate; the document marks MCP's secret fields (that no marked operation is unguarded is secret-openapi.test.mjs')", async () => {
  const gate = await import("../dist/secret-writes.js");
  await import("../dist/mcp-servers-store.js");
  const { openapiDocument } = await import("../dist/openapi.js");
  for (const operation of ["saveMcpServer", "startMcpOAuth", "previewMcpServer", "putMcpPrivateHosts", "deleteMcpServer"]) assert.ok(gate.isSecretWriteOperation(operation), `${operation} is registered`);
  assert.ok(!gate.isSecretWriteOperation("refreshMcpServer") && gate.notSecretWriteReason("refreshMcpServer"), "a refresh is said, with why, to write no secret");
  const bearer = { url: "https://mcp.example.test/mcp", auth: { type: "bearer", token: TOKEN } };
  assert.equal(gate.writesSecret("saveMcpServer", bearer), true);
  assert.equal(gate.writesSecret("saveMcpServer", { url: bearer.url, auth: { type: "none" } }), false);
  assert.equal(gate.writesSecret("previewMcpServer", bearer), false, "a preview keeps nothing");
  const doc = openapiDocument(() => undefined);
  const marked = gate.markedOperations(doc);
  for (const operation of ["saveMcpServer", "startMcpOAuth"]) assert.ok(marked.includes(operation), `${operation}'s secret fields are marked: ${JSON.stringify(marked)}`);
  const save = doc.paths["/settings/mcp-servers/{name}"].put.requestBody.content["application/json"].schema.properties.auth;
  assert.equal(save.properties.token["x-agentrun-secret"], true, "auth.token");
  assert.equal(save.properties.headers.additionalProperties["x-agentrun-secret"], true, "auth.headers' values");
  assert.equal(doc.paths["/settings/mcp-servers/{name}/oauth/start"].post.requestBody.content["application/json"].schema.properties.client_secret["x-agentrun-secret"], true, "client_secret");
});

test("a save that would drop or change a saved server's credential is a secret write, read from the store; one that keeps it is not", async () => {
  const gate = await import("../dist/secret-writes.js");
  await import("../dist/mcp-servers-store.js");
  const rows = { held: { auth: "bearer", sealed: "sealed-bytes" }, open: { auth: "none", sealed: null } };
  const store = { mcp: { server: async (name) => rows[name] } };
  const url = "https://mcp.example.test/mcp";
  for (const [name, body, writes, why] of [
    ["held", { url, auth: { type: "none" } }, true, "auth none over a saved bearer drops it"],
    ["held", { url }, true, "no auth is none: drops it"],
    ["held", { url, auth: { type: "oauth" } }, true, "another auth type replaces it"],
    ["held", { url, auth: { type: "bearer" }, prices: { add: 0.01 } }, false, "the same type keeps the sealed bearer"],
    ["open", { url, auth: { type: "none" } }, false, "a server with no credential has none to drop"],
    ["new-one", { url, auth: { type: "none" } }, false, "a new server has none to drop"],
  ]) assert.equal(await gate.writesSecretFor("saveMcpServer", body, { params: [name], store }), writes, `${name}: ${why}`);
});

test("removing a saved server is a secret write when it holds a credential, read from the store; one with none is not, and the check keeps what it read", async () => {
  const gate = await import("../dist/secret-writes.js");
  await import("../dist/mcp-servers-store.js");
  const rows = { held: { auth: "bearer", sealed: "sealed-bytes", credentialChangedAt: 5 }, open: { auth: "none", sealed: null, credentialChangedAt: null } };
  const store = { mcp: { server: async (name) => rows[name] } };
  for (const [name, writes, seen] of [["held", true, { auth: "bearer", sealed: true, changedAt: 5 }], ["open", false, { auth: "none", sealed: false, changedAt: null }], ["gone", false, null]]) {
    const request = { params: [name], store };
    assert.equal(await gate.writesSecretFor("deleteMcpServer", undefined, request), writes, name);
    assert.deepEqual(request.seen, seen, `${name}: the removal lands only while the row is still this`);
  }
});
