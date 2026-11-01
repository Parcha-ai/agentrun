// The MCP endpoint (POST /v2/mcp), as a coding agent's MCP client meets it on the faux model: initialize, the tools, an
// agent made and run to its answer and its file; the token required and a foreign Origin refused; each tool answering
// as its /v2 route does; and llms.txt, public.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { serve } from "./support.mjs";

const TOOLS = ["list_agents", "get_agent", "create_agent", "start_run", "list_runs", "get_run", "get_timeline", "list_run_files", "read_run_file", "send_message"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON-RPC message to the endpoint, as an MCP client sends it: the token, JSON, and both answer types accepted. */
function mcpClient(server, { token = server.token, headers = {} } = {}) {
  let id = 0;
  const post = async (message, extra = {}) => {
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers, ...extra },
      body: typeof message === "string" ? message : JSON.stringify(message),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
  };
  const request = async (method, params) => {
    const sent = ++id;
    const res = await post({ jsonrpc: "2.0", id: sent, method, ...(params === undefined ? {} : { params }) });
    assert.equal(res.status, 200, `${method}: ${res.text}`);
    assert.equal(res.body.id, sent);
    return res.body;
  };
  /** A tool's result; `ok` false expects a refusal (isError). */
  const tool = async (name, args, { ok = true } = {}) => {
    const { result, error } = await request("tools/call", { name, arguments: args });
    assert.equal(error, undefined, `${name}: ${JSON.stringify(error)}`);
    assert.equal(Boolean(result.isError), !ok, `${name}: ${JSON.stringify(result)}`);
    return result;
  };
  return { post, request, tool };
}

test("demo: an MCP client sets up and drives an agent: initialize, tools/list, create_agent, start_run, get_run until done, then its answer, its timeline and its file", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "agentrun-serve");
  assert.match(init.result.instructions, /start_run/);
  const initialized = await mcp.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual([initialized.status, initialized.text], [202, ""], "a notification is taken, with no body");

  const { tools } = (await mcp.request("tools/list")).result;
  assert.deepEqual(tools.map((tool) => tool.name), TOOLS);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.call, undefined, "only the tool's description goes out");
  }

  const made = await mcp.tool("create_agent", { definition: { id: "writer", version: 1, name: "Writer", instructions: "Write what you are asked to.", tools: ["write"], skills: [] } });
  assert.equal(made.structuredContent.agent_id, "writer");
  assert.deepEqual(JSON.parse(made.content[0].text), made.structuredContent, "the same answer as text, for a client without structured content");

  const started = (await mcp.tool("start_run", { agent_id: "writer", input: { content: "Write the report." }, effort: "high" })).structuredContent;
  assert.deepEqual([started.status, started.effort, started.agent_id], ["queued", "high", "writer"]);
  let run;
  for (const end = Date.now() + 30_000; Date.now() < end; await sleep(100)) {
    run = (await mcp.tool("get_run", { run_id: started.run_id })).structuredContent;
    if (["completed", "failed", "cancelled"].includes(run.status)) break;
  }
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.result.final_answer, "I wrote report.md.");
  // The tool's answer is the route's.
  const direct = await fetch(`${server.baseUrl}/runs/${started.run_id}`, { headers: { authorization: `Bearer ${server.token}` } }).then((res) => res.json());
  assert.deepEqual([run.status, run.result, run.revision, run.effort, run.cost], [direct.status, direct.result, direct.revision, direct.effort, direct.cost]);

  // The timeline, paged as its description says: from 0, then each page's next_after, until a final page with no more.
  const rows = [];
  for (let after = 0, end = Date.now() + 30_000; ; ) {
    const page = (await mcp.tool("get_timeline", { run_id: started.run_id, after, wait_ms: 1000 })).structuredContent;
    rows.push(...page.rows);
    if (page.final && !page.has_more) break;
    assert.ok(Date.now() < end, "the timeline turns final");
    after = page.next_after;
  }
  assert.ok(rows.some((row) => row.kind === "tool_use" && row.tool_name === "write"), "the write is on its timeline");
  assert.ok(rows.some((row) => row.kind === "final_answer"), "and the answer");
  const listed = (await mcp.tool("list_run_files", { run_id: started.run_id })).structuredContent;
  assert.deepEqual(listed.files.map((f) => f.path), ["report.md"]);
  const file = await mcp.tool("read_run_file", { run_id: started.run_id, path: "report.md" });
  assert.deepEqual(file.content, [{ type: "text", text: "# Report\n\nThe answer is 42.\n" }]);
  assert.deepEqual((await mcp.tool("list_runs", { agent_id: "writer" })).structuredContent.runs.map((r) => r.run_id), [started.run_id]);
});

test("refused without the token, or with another one: 401 with a JSON-RPC error, and nothing is done", async (t) => {
  const server = await serve(t);
  for (const token of [null, "ar_local_not-this-servers-token-at-all"]) {
    const res = await mcpClient(server, { token }).post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_agent", arguments: { definition: { id: "sneaky", version: 1, name: "s", instructions: "Answer.", tools: [], skills: [] } } } });
    assert.equal(res.status, 401, res.text);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual([res.body.jsonrpc, res.body.id, res.body.error.code], ["2.0", null, -32001]);
  }
  const agents = await fetch(`${server.baseUrl}/agents`, { headers: { authorization: `Bearer ${server.token}` } }).then((res) => res.json());
  assert.deepEqual(agents.agents, [], "no agent was made");
});

test("refused from a foreign Origin, the token notwithstanding; this server's own Origin, and none, are taken", async (t) => {
  const server = await serve(t);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
  for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null"]) {
    const res = await mcpClient(server, { headers: { origin } }).post(init);
    assert.equal(res.status, 403, `${origin}: ${res.text}`);
    assert.equal(res.body.error.code, -32600);
  }
  for (const headers of [{ origin: `http://127.0.0.1:${server.port}` }, {}]) assert.equal((await mcpClient(server, { headers }).post(init)).status, 200, JSON.stringify(headers));
});

test("each tool checks and answers as its route does: a refused definition, an unknown agent and a refused run are tool errors with the route's error, and a key replays", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  const direct = (method, path, body) => fetch(`${server.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const strip = ({ request_id: _, ...error }) => error;
  // A definition POST /v2/agents refuses, refused the same way, field by field.
  const bad = { definition: { id: "bad", version: 1, name: "bad", instructions: "Answer.", tools: [], skills: [], input_schema: {} } };
  const viaTool = await mcp.tool("create_agent", bad, { ok: false });
  const viaRoute = await direct("POST", "/agents", bad);
  assert.equal(viaRoute.status, 422);
  assert.deepEqual(strip(viaTool.structuredContent.error), strip(viaRoute.body.error));
  assert.equal(viaTool.structuredContent.error.code, "input_invalid");
  // Unknown ids, and a field the run body does not keep.
  assert.equal((await mcp.tool("get_agent", { agent_id: "nobody" }, { ok: false })).structuredContent.error.code, "not_found");
  assert.equal((await mcp.tool("get_run", { run_id: "no-such-run" }, { ok: false })).structuredContent.error.code, "not_found");
  await mcp.tool("create_agent", { definition: { id: "calc", version: 1, name: "Calc", instructions: "Answer.", tools: [], skills: [] } });
  const extra = await mcp.tool("start_run", { agent_id: "calc", input: { content: "What is six times seven?" }, output: "slides" }, { ok: false });
  assert.deepEqual(extra.structuredContent.error.fields.map((f) => f.field), ["output"]);
  assert.equal((await mcp.tool("start_run", { agent_id: "calc", input: { content: "hi" }, effort: "max" }, { ok: false })).structuredContent.error.fields[0].field, "effort");
  // An Idempotency-Key replays the first run, as the route does.
  const once = await mcp.tool("start_run", { agent_id: "calc", input: { content: "What is six times seven?" }, idempotency_key: "k-1" });
  const again = await mcp.tool("start_run", { agent_id: "calc", input: { content: "What is six times seven?" }, idempotency_key: "k-1" });
  assert.equal(again.structuredContent.run_id, once.structuredContent.run_id);
  // A path the files route refuses is refused here too, never read.
  assert.equal((await mcp.tool("read_run_file", { run_id: once.structuredContent.run_id, path: "../../.token" }, { ok: false })).structuredContent.error.code, "invalid_file_path");
});

test("send_message answers a run that asked a question, and the run goes on to its answer", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  await mcp.tool("create_agent", { definition: { id: "asker", version: 1, name: "Asker", instructions: "Answer.", tools: ["ask_person"], skills: [] } });
  const { run_id } = (await mcp.tool("start_run", { agent_id: "asker", input: { content: "Pick a region." } })).structuredContent;
  const until = async (status) => {
    for (const end = Date.now() + 30_000; Date.now() < end; await sleep(100)) {
      const run = (await mcp.tool("get_run", { run_id })).structuredContent;
      if (run.status === status) return run;
    }
    assert.fail(`the run never reached ${status}`);
  };
  await until("input_required");
  const sent = (await mcp.tool("send_message", { run_id, content: "eu" })).structuredContent;
  assert.equal(sent.mode, "answer");
  assert.deepEqual(JSON.parse((await until("completed")).result.final_answer), { region: "eu" });
});

test("the protocol's own refusals: an unknown method or tool, a missing argument, a batch, bad JSON, another method than POST, an unknown protocol version", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  assert.equal((await mcp.request("resources/list")).error.code, -32601);
  assert.equal((await mcp.request("tools/call", { name: "drop_tables", arguments: {} })).error.code, -32602);
  assert.match((await mcp.request("tools/call", { name: "get_run", arguments: {} })).error.message, /run_id is a non-empty string/);
  assert.equal((await mcp.request("tools/call", { name: "get_run", arguments: "r1" })).error.code, -32602);
  assert.deepEqual((await mcp.request("ping")).result, {});
  const batch = await mcp.post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.deepEqual([batch.status, batch.body.error.code], [400, -32600]);
  const broken = await mcp.post("{ not json");
  assert.deepEqual([broken.status, broken.body.error.code], [400, -32700]);
  assert.equal((await mcp.post({ jsonrpc: "1.0", id: 1, method: "ping" })).status, 400);
  assert.equal((await mcp.post({ jsonrpc: "2.0", id: null, method: "ping" })).status, 400, "a request's id is never null");
  const version = await mcp.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
  assert.deepEqual([version.status, version.body.error.code], [400, -32600]);
  assert.equal((await mcp.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-03-26" })).status, 200);
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`${server.baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${server.token}`, accept: "text/event-stream" } });
    assert.deepEqual([res.status, res.headers.get("allow")], [405, "POST"], method);
  }
  const typed = await fetch(`${server.baseUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "text/plain" }, body: "{}" });
  assert.equal(typed.status, 415);
  // An older client's version is answered as it asked; an unknown one, with this server's newest.
  assert.equal((await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } })).result.protocolVersion, "2024-11-05");
  assert.equal((await mcp.request("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } })).result.protocolVersion, "2025-06-18");
});

test("GET /llms.txt: public, the repository's text, naming the MCP endpoint and the document", async (t) => {
  const server = await serve(t);
  const res = await fetch(`${server.url}/llms.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  const text = await res.text();
  assert.equal(text, await readFile(new URL("../src/llms.txt", import.meta.url), "utf8"));
  for (const named of ["/v2/mcp", "/v2/openapi.json", "start_run", "agentrun-serve"]) assert.ok(text.includes(named), named);
  assert.ok(!text.includes(server.token), "no token in it");
  assert.equal((await fetch(`${server.url}/llms.txt`, { method: "POST" })).status, 405);
});

test("the MCP SDK's own client connects, lists the tools and calls one", async (t) => {
  let sdk;
  try {
    sdk = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/streamableHttp.js")]);
  } catch {
    return t.skip("@modelcontextprotocol/sdk is not installed here");
  }
  const [{ Client }, { StreamableHTTPClientTransport }] = sdk;
  const server = await serve(t);
  const client = new Client({ name: "sdk-check", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${server.token}` } } });
  await client.connect(transport);
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), TOOLS);
  const listed = await client.callTool({ name: "list_agents", arguments: {} });
  assert.deepEqual(listed.structuredContent, { agents: [], next_cursor: null });
});
