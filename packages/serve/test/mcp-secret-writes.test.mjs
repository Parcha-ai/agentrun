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

test("the table: true only for a body that carries an MCP secret value to keep, or the private-network hosts", () => {
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
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "per_run", headers: { authorization: `Bearer ${TOKEN}` } } }, false, "a per_run server keeps nothing: its headers only list its tools"],
    ["saveMcpServer", null, false, "no body"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", client_id: "corp-app", client_secret: TOKEN }, true, "a client secret"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", client_id: "corp-app" }, true, "a client id alone: its callback seals the sign-in's token set"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", scopes: ["read"] }, true, "no client: the same"],
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
  for (const operation of ["saveMcpServer", "startMcpOAuth", "putMcpPrivateHosts", "deleteMcpServer"]) assert.ok(gate.isSecretWriteOperation(operation), `${operation} is registered`);
  // Said, with why, to write no secret: the dispatch's check never reads them, so a token's preview (its body's token is
  // marked secret, and kept nowhere) and refresh always go through.
  for (const operation of ["refreshMcpServer", "previewMcpServer"]) assert.ok(!gate.isSecretWriteOperation(operation) && gate.notSecretWriteReason(operation), `${operation} writes no secret, said with why`);
  const bearer = { url: "https://mcp.example.test/mcp", auth: { type: "bearer", token: TOKEN } };
  assert.equal(gate.writesSecret("saveMcpServer", bearer), true);
  assert.equal(gate.writesSecret("saveMcpServer", { url: bearer.url, auth: { type: "none" } }), false);
  const doc = openapiDocument(() => undefined);
  const marked = gate.markedOperations(doc);
  assert.ok(marked.includes("previewMcpServer"), "a preview's token is marked secret all the same");
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

test("removing a saved server is refused to the token when it holds a credential or the token did not save it, read from the store; one the token saved with none is not, and the check keeps what it read", async () => {
  const gate = await import("../dist/secret-writes.js");
  await import("../dist/mcp-servers-store.js");
  const none = { auth: "none", sealed: null, credentialChangedAt: null };
  const rows = { held: { auth: "bearer", sealed: "sealed-bytes", credentialChangedAt: 5, createdAt: 1 }, open: { ...none, createdAt: 2 }, owners: { ...none, createdAt: 3 }, stale: { ...none, createdAt: 4 }, unrecorded: { ...none, createdAt: 5 } };
  // Each row's source record: the token's mark on held (sealed all the same) and open; none on owners; stale's was written
  // for an earlier row under the name (of 1), so it is not this row's.
  const records = { "mcp.source/held": { source: "url", toolkit: null, of: 1, by: "token" }, "mcp.source/open": { source: "url", toolkit: null, of: 2, by: "token" }, "mcp.source/owners": { source: "url", toolkit: null, of: 3 }, "mcp.source/stale": { source: "url", toolkit: null, of: 1, by: "token" } };
  const store = { mcp: { server: async (name) => rows[name] }, settings: { get: async (key) => records[key] } };
  const open = { auth: "none", sealed: false, changedAt: null };
  for (const [name, refused, seen, why] of [
    ["held", true, { auth: "bearer", sealed: true, changedAt: 5 }, "it holds a credential, whoever saved it"],
    ["open", false, open, "the token saved it with none"],
    ["owners", true, open, "the owner saved it: no token's mark"],
    ["stale", true, open, "the token's mark was for another row under the name"],
    ["unrecorded", true, open, "no record at all (a row written by hand, or saved before the mark): the owner's"],
    ["gone", false, null, "no row: the delete answers 404"],
  ]) {
    const request = { params: [name], store };
    assert.equal(await gate.writesSecretFor("deleteMcpServer", undefined, request), refused, `${name}: ${why}`);
    assert.deepEqual(request.seen, seen, `${name}: the removal lands only while the row is still this`);
  }
});
