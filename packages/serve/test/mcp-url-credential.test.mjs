// An MCP server's URL is kept and shown in plain text (its row's url, every read, the console), so a credential in its
// query would be too: a URL whose query names a parameter that looks like a credential (api_key, token, secret,
// signature, ...) is refused at every door that takes one (the preview, the save, the OAuth sign-in's start), in words
// that say to send it as a header, and nothing is kept or sent. A query of anything else (?version=2) is the server's own.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { serve, withEnv } from "./support.mjs";

const SECRET = `not-a-secret-${"query-credential"}`;

test("a URL whose query holds a credential-like parameter is refused at the preview, the save and the sign-in's start, in words, and nothing is kept or sent; ?version=2 still saves, and a bare key or session is the server's own", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { runner: false });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  for (const name of ["api_key", "API-Key", "apikey", "access_token", "token", "access_key", "secret", "client_secret", "auth", "password", "sig", "signature", "X-Api-Key"]) {
    const url = `${fake.url}?region=eu&${encodeURIComponent(name)}=${SECRET}`;
    const words = `${name} in the URL's query looks like a credential; send it as a header instead (Headers).`;
    for (const [door, answer] of [
      ["preview", await api("POST", "/settings/mcp-servers/preview", { url, auth: { type: "none" } })],
      ["save", await api("PUT", "/settings/mcp-servers/queried", { url, auth: { type: "none" } })],
      ["sign-in start", await api("POST", "/settings/mcp-servers/queried/oauth/start", { url })],
    ]) {
      assert.deepEqual([answer.status, answer.body.error?.code], [422, "input_invalid"], `${name} at the ${door}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(answer.body.error.fields.map((field) => [field.field, field.message]), [["url", words]], `${name} at the ${door}`);
      assert.ok(!JSON.stringify(answer.body).includes(SECRET), `${name} at the ${door}: the value is not said back`);
    }
  }
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body, { servers: [] }, "nothing kept");
  assert.equal(fake.log.length, 0, "nothing sent to the server");
  // A query of the server's own, nothing like a credential, is kept as given (and shown as its origin alone, as every URL).
  const plain = await api("PUT", "/settings/mcp-servers/versioned", { url: `${fake.url}?version=2`, auth: { type: "none" } });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.url, `${new URL(fake.url).origin}/…`);
  // A bare key, session or sessionid is as often the server's own lookup or routing value: kept, not refused.
  const routed = await api("PUT", "/settings/mcp-servers/routed", { url: `${fake.url}?key=docs&session=eu-1&sessionid=7`, auth: { type: "none" } });
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  assert.equal(routed.body.url, `${new URL(fake.url).origin}/…`);
});

test("a server listening on loopback is no local install unless its operator says so: an MCP server on loopback is refused at the save and the preview in words naming AGENTRUN_MCP_ALLOW_LOOPBACK, nothing sent; said so, it saves", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const hosted = await serve(t, { runner: false, mcpLoopback: false });
  const words = "127.0.0.1 is this machine; set AGENTRUN_MCP_ALLOW_LOOPBACK=1 when starting the server, only on a machine you alone use."; // key-gate: loopback-rule the refusal's own words
  for (const [door, answer] of [
    ["save", await hosted.api("PUT", "/settings/mcp-servers/local", { url: fake.url, auth: { type: "none" } })],
    ["preview", await hosted.api("POST", "/settings/mcp-servers/preview", { url: fake.url, auth: { type: "none" } })],
  ]) {
    assert.deepEqual([answer.status, answer.body.error?.code], [422, "input_invalid"], `${door}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.body.error.fields.map((field) => [field.field, field.message]), [["url", words]], door);
  }
  assert.equal(fake.log.length, 0, "nothing sent");
  const local = await serve(t, { runner: false, mcpLoopback: true });
  assert.equal((await local.api("PUT", "/settings/mcp-servers/local", { url: fake.url, auth: { type: "none" } })).status, 200);
});

test("a saved URL's path and query are held as a secret: every read shows its origin and \"/…\", a credential no list names included, and sending that back keeps the saved URL, which alone is called", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api, store } = await serve(t, { runner: false });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  // A name no list holds (api_token), and a secret in the query a provider like Zapier would put in the path.
  const url = `${fake.url}?api_token=${SECRET}&sk=${SECRET}-path`;
  const shown = `${new URL(fake.url).origin}/…`;
  const saved = await api("PUT", "/settings/mcp-servers/hidden", { url, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  for (const [read, answer] of [["the save's answer", saved], ["GET one", await api("GET", "/settings/mcp-servers/hidden")], ["GET the list", await api("GET", "/settings/mcp-servers")]]) {
    assert.ok(!JSON.stringify(answer.body).includes(SECRET), `${read} shows none of it: ${JSON.stringify(answer.body)}`);
    assert.ok(JSON.stringify(answer.body).includes(JSON.stringify(shown)), `${read} shows the origin and "/…"`);
  }
  // The console's edit sends the shown URL back: the saved one is kept, and a refresh calls it whole.
  const again = await api("PUT", "/settings/mcp-servers/hidden", { url: shown, auth: { type: "none" } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await store.mcp.server("hidden")).url, url, "the saved URL is kept as it was");
  assert.equal((await api("POST", "/settings/mcp-servers/hidden/refresh")).status, 200);
  assert.ok(fake.log.length > 0, "the server was called");
  // Every name a provider may put a credential under, listed or not: none is ever shown back whole.
  for (const name of ["api_token", "private_token", "key", "x-auth-token", "access_key_id"]) {
    const slot = `q-${name.replace(/[^a-z]/g, "")}`;
    const answer = await api("PUT", `/settings/mcp-servers/${slot}`, { url: `${fake.url}?${name}=${SECRET}`, auth: { type: "none" } });
    const reads = JSON.stringify([answer.body, (await api("GET", `/settings/mcp-servers/${slot}`)).body, (await api("GET", "/settings/mcp-servers")).body]);
    assert.ok(!reads.includes(SECRET), `${name}: shown back whole (save ${answer.status})`);
  }
});

/** A server that answers every path ending in /mcp as the fake MCP server does: a secret path segment is the server's own,
 *  as Zapier's /mcp/<key>/sse is. */
async function pathProxy(t, fake) {
  const target = new URL(fake.url);
  const http = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname.endsWith("/mcp") ? "/mcp" : req.url;
    const out = request({ host: target.hostname, port: target.port, path, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    req.pipe(out);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())));
  return `http://127.0.0.1:${http.address().port}`;
}

test("a credential in a saved URL's path is never shown back: the save's answer, the server's read and the list show its origin and \"/…\"", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { runner: false });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const base = await pathProxy(t, fake);
  const saved = await api("PUT", "/settings/mcp-servers/pathed", { url: `${base}/sk-ak-${SECRET}/mcp`, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const reads = JSON.stringify([saved.body, (await api("GET", "/settings/mcp-servers/pathed")).body, (await api("GET", "/settings/mcp-servers")).body]);
  assert.ok(!reads.includes(SECRET), `the path secret is shown: ${reads.slice(0, 400)}`);
  assert.equal(saved.body.url, `${base}/…`);
});

test("a row saved before the save refused a credential in its URL's query is refused at its tools refresh, in the same words, and nothing is sent", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api, store } = await serve(t, { runner: false });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const url = `${fake.url}?api_key=${SECRET}`;
  // As an earlier server kept it: the row is in the store as it was saved then.
  await store.mcp.put({ name: "old", url, auth: "none", tools: [{ name: "add", input_schema: { type: "object" } }], sealed: null });
  const words = "api_key in the URL's query looks like a credential; send it as a header instead (Headers).";
  for (const [door, answer] of [
    ["tools refresh", await api("POST", "/settings/mcp-servers/old/refresh")],
  ]) {
    assert.deepEqual([answer.status, answer.body.error?.code], [422, "input_invalid"], `${door}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.body.error.fields.map((field) => [field.field, field.message]), [["url", words]], door);
    assert.ok(!JSON.stringify(answer.body).includes(SECRET), `${door}: the value is not said back`);
  }
  assert.equal(fake.log.length, 0, "nothing sent to the server");
});
