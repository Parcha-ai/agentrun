// The tests' fake model endpoints on loopback (fixtures/faux-upstream.mjs, fixtures/faux-gateway.mjs) take any connection
// on their port, a stranger's too: another process on the box probes loopback ports with a bare `GET /` and no body (F3,
// a Go HTTP client). The upstream answers a request with no JSON body 400 and files no call for it; the gateway keeps its
// contract for a GET under its API paths (404, recorded: faux-gateway.test.mjs), answers one outside them (`GET /`) 404
// unrecorded, and a POST with no JSON body 400, unrecorded. Neither throws into the test. Every other fake that keeps
// the requests it got (the MCP, OAuth, Composio and git fakes, serve's Responses endpoint) answers the bare `GET /` 404
// and keeps it out of its log, so a count or a list of a fake's requests is the code under test's alone.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import fakeUpstream from "./fixtures/faux-upstream.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { gitHttp } from "./fixtures/git-http.mjs";
import { responsesEndpoint, scratch, withEnv } from "./support.mjs";

/** A bare request with no body, as the stranger's probe sends it. */
const probe = (url) => fetch(`${url}/`, { method: "GET", headers: { connection: "close" } });
const MESSAGE = { model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "the answer" }] }] };

test("the fake upstream answers a bare GET / with no body 400, mid-test, and files no model request for it", async (t) => {
  const calls = join(await scratch(t), "upstream.jsonl");
  writeFileSync(calls, "");
  withEnv(t, { AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: calls });
  // Served as the tests serve it (learn-workflow-run.test.mjs upstreamAt): every request's body handed to the fixture.
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const answer = await fakeUpstream(`http://upstream.invalid${req.url}`, { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const first = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "not-a-secret" }, body: JSON.stringify(MESSAGE) });
  assert.equal(first.status, 200);
  await first.text();
  const stranger = await probe(url);
  assert.equal(stranger.status, 400, "a request that is no model request is refused, not parsed");
  await stranger.text();
  const filed = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(filed.map((call) => call.path), ["/v1/messages"], "the stranger's request is not filed");
});

test("the fake gateway answers a bare GET / with no body 404, unrecorded, mid-test, never throws, and a POST whose body is not JSON 400, unrecorded: its requests read as the test sent them", async (t) => {
  const gw = await startFauxGateway();
  t.after(() => gw.close());
  const first = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "not-a-secret", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ ...MESSAGE, stream: false }) });
  assert.equal(first.status, 200);
  await first.text();
  const stranger = await probe(gw.url);
  assert.equal(stranger.status, 404, "the gateway's contract for a GET (faux-gateway.test.mjs): not answered");
  await stranger.text();
  const garbled = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
  assert.equal(garbled.status, 400, "a POST that is no model request is refused");
  await garbled.text();
  assert.deepEqual(gw.requests.map((request) => [request.method, request.path]), [["POST", "/v1/messages"]], "only the test's own request is recorded: the stranger's GET / and the garbled POST are not");
});

/** The stranger's probe at `origin`, mid-test: a fake answers it 404 and its log (`read()`) is what it was before. */
async function unheard(origin, read) {
  const before = JSON.stringify(read());
  const stranger = await probe(origin);
  await stranger.text();
  assert.equal(stranger.status, 404, "a bare GET / is no fake's");
  assert.equal(JSON.stringify(read()), before, "the stranger's GET / is not in its log");
}

test("the fake MCP server logs its client's requests and never a stranger's bare GET /", async (t) => {
  const mcp = await startFakeMcp();
  t.after(() => mcp.close());
  const listed = await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  await listed.text();
  assert.deepEqual(mcp.log.map((entry) => entry.method), ["tools/list"], "its client's request is logged");
  await unheard(new URL(mcp.url).origin, () => mcp.log);
});

test("the fake OAuth server logs its client's requests and never a stranger's bare GET /", async (t) => {
  const as = await startFakeOAuth();
  t.after(() => as.close());
  await (await fetch(`${as.issuer}/.well-known/oauth-authorization-server`)).text();
  assert.deepEqual(as.log.map((entry) => entry.path), ["/.well-known/oauth-authorization-server"], "its client's request is logged");
  await unheard(as.issuer, () => as.log);
});

test("the fake Composio counts its client's calls and never a stranger's bare GET /", async (t) => {
  const composio = await startFakeComposio({ toolkits: {} });
  t.after(() => composio.close());
  await (await fetch(`${composio.baseUrl}/api/v3/auth_configs`, { headers: { "x-api-key": composio.apiKey } })).text();
  assert.deepEqual(composio.calls.map((call) => call.path), ["/api/v3/auth_configs"], "its client's call is counted");
  await unheard(new URL(composio.baseUrl).origin, () => composio.calls);
});

test("the git smart HTTP server lists its client's requests and never a stranger's bare GET /", async (t) => {
  const git = await gitHttp(t, await scratch(t));
  await (await fetch(`${git.url}/acme/widgets.git/info/refs?service=git-upload-pack`)).text();
  assert.deepEqual(git.seen.map((one) => one.url), ["/acme/widgets.git/info/refs?service=git-upload-pack"], "its client's request is listed");
  await unheard(git.url, () => git.seen);
});

test("serve's Responses endpoint lists its client's requests and never a stranger's bare GET /", async (t) => {
  const endpoint = await responsesEndpoint(t, "42", 10);
  await (await fetch(`${endpoint.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", input: "hi", stream: true }) })).text();
  assert.deepEqual(endpoint.asked, ["POST /v1/responses"], "its client's request is listed");
  await unheard(endpoint.url, () => endpoint.asked);
});
