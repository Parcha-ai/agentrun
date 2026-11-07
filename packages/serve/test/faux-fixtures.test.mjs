// The tests' fake model endpoints on loopback (fixtures/faux-upstream.mjs, fixtures/faux-gateway.mjs) take any connection
// on their port, a stranger's too: another process on the box probes loopback ports with a bare `GET /` and no body (F3,
// a Go HTTP client). Such a request is answered 400 and is no model request: it never throws into the test, and the
// requests a test asserts on stay exactly the ones it sent.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import fakeUpstream from "./fixtures/faux-upstream.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { scratch, withEnv } from "./support.mjs";

/** A bare request with no body, as the stranger's probe sends it. */
const probe = (url) => fetch(`${url}/`, { method: "GET", headers: { connection: "close" } });
const MESSAGE = { model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "the answer" }] }] };

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

test("the fake gateway answers a bare GET / with no body 400, mid-test, and does not record it among its requests", async (t) => {
  const gw = await startFauxGateway();
  t.after(() => gw.close());
  const first = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "not-a-secret", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ ...MESSAGE, stream: false }) });
  assert.equal(first.status, 200);
  await first.text();
  const stranger = await probe(gw.url);
  assert.equal(stranger.status, 400, "a request that is no model request is refused");
  await stranger.text();
  assert.deepEqual(gw.requests.map((request) => [request.method, request.path]), [["POST", "/v1/messages"]], "only the test's own request is recorded");
});
