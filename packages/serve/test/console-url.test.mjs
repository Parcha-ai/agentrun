// A run and an agent read over the API carry their console page (`console_url`), at the address people open: the public
// URL when the server has one, else its own. MCP's runs_get answers the route's field, so the two never differ.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, call, follow, serve } from "./support.mjs";

const PUBLIC = "https://agents.example.com";

async function mcpRun(server, runId) {
  const res = await fetch(`${server.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "runs_get", arguments: { run_id: runId } } }),
  });
  return (await res.json()).result.structuredContent;
}

for (const [label, options, originOf] of [["its own address", {}, (server) => server.url], ["a public URL", { publicUrl: PUBLIC }, () => PUBLIC]]) {
  test(`with ${label}, a run's start, read and list, an agent's read and list, and MCP's runs_get carry the console page`, async (t) => {
    const server = await serve(t, options);
    const origin = originOf(server);
    const { api } = server;
    const created = await api("POST", "/agents", agent("demo"));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.console_url, `${origin}/#/agents/demo`);
    assert.equal((await api("GET", "/agents/demo")).body.console_url, `${origin}/#/agents/demo`);
    assert.deepEqual((await api("GET", "/agents")).body.agents.map((a) => a.console_url), [`${origin}/#/agents/demo`]);

    const started = await api("POST", "/agents/demo/runs", { input: { content: "What is the answer?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const page = `${origin}/#/runs/${encodeURIComponent(started.body.run_id)}`;
    assert.equal(started.body.console_url, page);
    await follow(api, started.body.run_id, ["completed"]);
    assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.console_url, page);
    assert.deepEqual((await api("GET", "/runs")).body.runs.map((r) => r.console_url), [page]);
    assert.deepEqual((await api("GET", "/agents/demo/runs")).body.runs.map((r) => r.console_url), [page]);
    assert.equal((await mcpRun(server, started.body.run_id)).console_url, page);
  });
}

/** A request sent to the server with `host` as its Host header, as a tunnel (`ssh -L`) or a forwarded port delivers it. */
const through = (server, host) => (method, path, body) =>
  call(server.port, { method, path: `/v2${path}`, headers: { host, authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json", accept: "application/json, text/event-stream" }) }, body });

for (const [label, options, expected] of [["no public URL: the address the request reached", {}, (host) => `http://${host}`], ["a public URL: it wins over the request's Host", { publicUrl: PUBLIC }, () => PUBLIC]]) {
  test(`through a tunnel's own port, with ${label}; MCP's runs_get says the same as GET for the same Host`, async (t) => {
    const server = await serve(t, options);
    const host = `localhost:${server.port + 1000}`;
    const api = through(server, host);
    const origin = expected(host);
    const created = await api("POST", "/agents", agent("demo"));
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.console_url, `${origin}/#/agents/demo`);
    assert.equal((await api("GET", "/agents/demo")).json.console_url, `${origin}/#/agents/demo`);
    assert.deepEqual((await api("GET", "/agents")).json.agents.map((a) => a.console_url), [`${origin}/#/agents/demo`]);
    const started = await api("POST", "/agents/demo/runs", { input: { content: "What is the answer?" } });
    assert.equal(started.status, 202, started.text);
    const page = `${origin}/#/runs/${encodeURIComponent(started.json.run_id)}`;
    assert.equal(started.json.console_url, page);
    await follow(server.api, started.json.run_id, ["completed"]);
    assert.equal((await api("GET", `/runs/${started.json.run_id}`)).json.console_url, page);
    assert.deepEqual((await api("GET", "/runs")).json.runs.map((r) => r.console_url), [page]);
    assert.deepEqual((await api("GET", "/agents/demo/runs")).json.runs.map((r) => r.console_url), [page]);
    assert.equal((await api("POST", `/runs/${started.json.run_id}/archive`)).json.console_url, page);
    const mcp = await api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "runs_get", arguments: { run_id: started.json.run_id } } });
    assert.equal(mcp.json.result.structuredContent.console_url, page);
  });
}
