// The adapter's MCP server, the only way OpenCode reaches the host's tools: MCP's streamable HTTP subset OpenCode's client
// speaks, behind the session's own key, with a long call kept alive by progress notifications and stopped when its
// client goes away.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startMcpServer } from "../dist/harness-opencode/host/mcp.js";

const KEY = "session-key-not-a-secret";
const TOOLS = [{ name: "echo", description: "Echo the text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];

async function server(t, call, options = {}) {
  const mcp = await startMcpServer({ tools: TOOLS, key: KEY, call, ...options });
  t.after(() => mcp.close());
  return mcp;
}

const post = (url, body, { key = KEY, signal } = {}) => fetch(url, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify(body),
  ...(signal ? { signal } : {}),
});

/** The JSON-RPC messages of an event-stream answer. */
const messages = (text) => text.split("\n\n").map((block) => block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")).filter(Boolean).map((data) => JSON.parse(data));

test("it answers initialize in the client's own protocol version, lists exactly the host's tools, and takes notifications", async (t) => {
  const mcp = await server(t, async () => ({ text: "", isError: false }));
  const init = await (await post(mcp.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode", version: "1" } } })).json();
  assert.deepEqual(init, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "hands", version: "1" } } });
  assert.equal((await post(mcp.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const listed = await (await post(mcp.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json();
  assert.deepEqual(listed.result.tools, TOOLS);
  assert.deepEqual((await (await post(mcp.url, { jsonrpc: "2.0", id: 3, method: "ping" })).json()).result, {});
});

test("without the session's key nothing is answered, and the server's own event stream is not offered", async (t) => {
  let called = 0;
  const mcp = await server(t, async () => (called++, { text: "", isError: false }));
  assert.equal((await post(mcp.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: "another-key" })).status, 401);
  assert.equal((await post(mcp.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } }, { key: "" })).status, 401);
  assert.equal((await fetch(mcp.url, { headers: { authorization: `Bearer ${KEY}` } })).status, 405);
  assert.equal((await fetch(mcp.url.replace("/mcp", "/other"), { method: "POST", headers: { authorization: `Bearer ${KEY}` } })).status, 404);
  assert.equal(called, 0);
});

test("a call is answered as an event stream: progress while it runs, then its text, an error result marked as one", async (t) => {
  const mcp = await server(t, async (name, args) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return args.text === "fail" ? { text: "it failed", isError: true } : { text: `echo: ${args.text}`, isError: false };
  }, { progressMs: 25 });
  const answer = await post(mcp.url, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { text: "hi" }, _meta: { progressToken: "tok" } } });
  assert.equal(answer.headers.get("content-type"), "text/event-stream");
  const said = messages(await answer.text());
  const progress = said.filter((m) => m.method === "notifications/progress");
  assert.ok(progress.length >= 2, `progress while it ran: ${JSON.stringify(said)}`);
  assert.ok(progress.every((m) => m.params.progressToken === "tok"));
  assert.deepEqual(said.at(-1), { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "echo: hi" }], isError: false } });
  const failed = messages(await (await post(mcp.url, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "echo", arguments: { text: "fail" } } })).text());
  assert.deepEqual(failed, [{ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "it failed" }], isError: true } }], "no progress token: no progress");
});

test("a tool that is not the host's is an error result, never run", async (t) => {
  let called = 0;
  const mcp = await server(t, async () => (called++, { text: "", isError: false }));
  const said = await (await post(mcp.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } })).json();
  assert.deepEqual(said.result, { content: [{ type: "text", text: "unknown tool: bash" }], isError: true });
  assert.equal(called, 0);
});

test("a client that goes away before the answer stops the call", async (t) => {
  let stopped;
  const started = Promise.withResolvers();
  const mcp = await server(t, (name, args, signal) => new Promise((resolve) => {
    started.resolve();
    signal.addEventListener("abort", () => {
      stopped = true;
      resolve({ text: "stopped", isError: true });
    }, { once: true });
  }));
  const client = new AbortController();
  const asked = post(mcp.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } }, { signal: client.signal }).then((r) => r.text()).catch(() => undefined);
  await started.promise;
  client.abort();
  await asked;
  for (let i = 0; i < 50 && !stopped; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, true);
});
