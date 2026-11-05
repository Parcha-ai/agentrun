// The MCP endpoint (POST /v2/mcp), as a coding agent's MCP client meets it on the faux model: initialize, the ten tools,
// an agent made and run to its answer, its file and its events; the Bearer token taken and nothing else (no cookie, no
// credential, no foreign Origin, no GET); each tool answering as its /v2 routes do; and llms.txt, public.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { call, cookieOf, scratch, serve, withEnv } from "./support.mjs";

const TOOLS = ["whoami", "agents_list", "agents_create", "agents_revise", "runs_start", "runs_get", "runs_events", "runs_files", "runs_respond", "runs_cancel"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } };
/** A password for a test's owner, plainly no secret (as owner-auth.test.mjs makes them). */
const notSecret = (name) => `not-a-secret-${name}`;

/** One JSON-RPC message to the endpoint, as an MCP client sends it: the token, JSON, and both answer types accepted. */
function mcpClient(server, { token = server.token, headers = {} } = {}) {
  let id = 0;
  const post = async (message, extra = {}, method = "POST") => {
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers, ...extra },
      body: method === "POST" ? (typeof message === "string" ? message : JSON.stringify(message)) : undefined,
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
  /** runs_get until the run's status is one of `wanted`. */
  const until = async (runId, wanted) => {
    for (const end = Date.now() + 30_000; Date.now() < end; await sleep(100)) {
      const run = (await tool("runs_get", { run_id: runId })).structuredContent;
      if (wanted.includes(run.status)) return run;
    }
    assert.fail(`run ${runId} never reached ${wanted}`);
  };
  return { post, request, tool, until };
}

const v2 = (server, method, path, body) =>
  fetch(`${server.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: await res.json() }));

test("demo: an MCP client sets up and drives an agent: initialize, the ten tools, agents_create, runs_start, runs_get until done, runs_files read, runs_events paged; then the token alone is taken: no cookie, no credential, no foreign Origin, no GET", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true });
  const mcp = mcpClient(server);
  const init = await mcp.request("initialize", INIT);
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "agentrun-serve");
  assert.match(init.result.instructions, /whoami.*runs_start.*runs_get/s);
  const initialized = await mcp.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual([initialized.status, initialized.text], [202, ""], "a notification is taken, with no body");

  const { tools } = (await mcp.request("tools/list")).result;
  assert.deepEqual(tools.map((tool) => tool.name), TOOLS, "exactly ten");
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 40, tool.name);
    assert.deepEqual(Object.keys(tool).sort(), ["annotations", "description", "inputSchema", "name", "title"], "only the tool's description goes out");
  }

  const me = (await mcp.tool("whoami", {})).structuredContent;
  assert.deepEqual([me.authenticated, me.credential, me.base_url, me.console_url], [true, "token", server.baseUrl, `${server.url}/`]);
  assert.ok(me.harnesses.includes("pi") && me.efforts.includes("high") && me.tools.includes("write"), JSON.stringify(me));

  const made = await mcp.tool("agents_create", { id: "writer", name: "Writer", instructions: "Write what you are asked to.", tools: ["write"] });
  assert.equal(made.structuredContent.agent_id, "writer");
  assert.deepEqual(JSON.parse(made.content[0].text), made.structuredContent, "the same answer as text, for a client without structured content");

  const started = (await mcp.tool("runs_start", { agent_id: "writer", input: { content: "Write the report." }, effort: "high" })).structuredContent;
  assert.deepEqual([started.status, started.effort, started.agent_id], ["queued", "high", "writer"]);
  const run = await mcp.until(started.run_id, ["completed", "failed", "cancelled"]);
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.result.final_answer, "I wrote report.md.");
  assert.equal(run.pending, null);
  assert.equal(run.console_url, `${server.url}/#/runs/${started.run_id}`);
  // The tool's answer is the route's, with its two additions.
  const direct = (await v2(server, "GET", `/runs/${started.run_id}`)).body;
  assert.deepEqual([run.status, run.result, run.revision, run.effort, run.cost], [direct.status, direct.result, direct.revision, direct.effort, direct.cost]);

  const listed = (await mcp.tool("runs_files", { run_id: started.run_id })).structuredContent;
  assert.deepEqual(listed.files.map((f) => f.path), ["report.md"]);
  const file = await mcp.tool("runs_files", { run_id: started.run_id, path: "report.md" });
  assert.deepEqual(file.content, [{ type: "text", text: "# Report\n\nThe answer is 42.\n" }]);
  assert.deepEqual([file.structuredContent.content_type, file.structuredContent.size_bytes, file.structuredContent.truncated], ["text/markdown", 28, false]);

  // The events, two rows a page: from 0, then each page's next_after, until a final page with no more.
  const rows = [];
  let pages = 1;
  for (let after = 0, end = Date.now() + 30_000; ; pages++) {
    const page = (await mcp.tool("runs_events", { run_id: started.run_id, after, limit: 2 })).structuredContent;
    assert.ok(page.rows.length <= 2);
    rows.push(...page.rows);
    if (page.final && !page.has_more) break;
    assert.ok(Date.now() < end, "the timeline turns final");
    after = page.next_after;
  }
  assert.ok(pages >= 2, `paged: ${pages} pages`);
  assert.ok(rows.some((row) => row.kind === "tool_use" && row.tool_name === "write"), "the write is among its events");
  assert.ok(rows.some((row) => row.kind === "final_answer"), "and the answer");

  // The token alone is taken.
  const page = { "content-type": "application/json", origin: server.url };
  const owned = await call(server.port, { method: "POST", path: "/v2/setup", headers: page, body: { password: notSecret("owner") } });
  assert.equal(owned.status, 201, owned.text);
  const cookie = cookieOf(owned);
  assert.equal((await call(server.port, { path: "/v2/agents", headers: { cookie } })).status, 200, "the cookie opens the rest of /v2");
  const byCookie = await call(server.port, { method: "POST", path: "/v2/mcp", headers: { ...page, cookie }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agents_list", arguments: {} } } });
  assert.equal(byCookie.status, 401, `the cookie is refused here: ${byCookie.text}`);
  const anonymous = await mcpClient(server, { token: null }).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
  assert.deepEqual([anonymous.status, anonymous.headers.get("www-authenticate"), anonymous.body.error.code], [401, "Bearer", -32001]);
  const foreign = await mcpClient(server, { headers: { origin: "https://evil.example" } }).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
  assert.deepEqual([foreign.status, foreign.body.error.code], [403, -32600]);
  const get = await mcp.post(undefined, {}, "GET");
  assert.deepEqual([get.status, get.headers.get("allow")], [405, "POST"]);
});

test("refused without the token, or with another one, and from a foreign Origin: nothing is done", async (t) => {
  const server = await serve(t);
  const create = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agents_create", arguments: { id: "sneaky", name: "s", instructions: "Answer." } } };
  for (const token of [null, "ar_local_not-this-servers-token-at-all"]) {
    const res = await mcpClient(server, { token }).post(create);
    assert.equal(res.status, 401, res.text);
    assert.deepEqual([res.body.jsonrpc, res.body.id, res.body.error.code], ["2.0", null, -32001]);
  }
  for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null"]) {
    const res = await mcpClient(server, { headers: { origin } }).post(create);
    assert.equal(res.status, 403, `${origin}: ${res.text}`);
  }
  assert.deepEqual((await v2(server, "GET", "/agents")).body.agents, [], "no agent was made");
  // This server's own Origin, and none, are taken.
  for (const headers of [{ origin: server.url }, {}]) assert.equal((await mcpClient(server, { headers }).post({ jsonrpc: "2.0", id: 2, method: "ping" })).status, 200, JSON.stringify(headers));
});

test("each tool checks and answers as its routes do: a refused definition, a bad argument, an unknown id and a refused run are tool errors with the route's error", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  const strip = ({ request_id: _, ...error }) => error;
  // A definition POST /v2/agents refuses, refused the same way, field by field.
  const viaTool = await mcp.tool("agents_create", { id: "bad", name: "bad", instructions: "Answer.", input_schema: {} }, { ok: false });
  const viaRoute = await v2(server, "POST", "/agents", { definition: { id: "bad", name: "bad", instructions: "Answer.", input_schema: {} } });
  assert.equal(viaRoute.status, 422);
  assert.deepEqual(strip(viaTool.structuredContent.error), strip(viaRoute.body.error));
  // A missing argument is the tool's error too, in the routes' 422 shape, never a protocol error.
  const missing = await mcp.tool("runs_get", {}, { ok: false });
  assert.deepEqual([missing.structuredContent.error.code, missing.structuredContent.error.fields[0].field], ["input_invalid", "run_id"]);
  assert.equal((await mcp.tool("runs_get", { run_id: "no-such-run" }, { ok: false })).structuredContent.error.code, "not_found");
  assert.equal((await mcp.tool("agents_revise", { agent_id: "nobody", instructions: "x" }, { ok: false })).structuredContent.error.code, "not_found");
  await mcp.tool("agents_create", { id: "calc", name: "Calc", instructions: "Answer.", tools: ["read"], model: "faux/faux-1" });
  const extra = await mcp.tool("runs_start", { agent_id: "calc", input: { content: "What is six times seven?" }, output: "slides" }, { ok: false });
  assert.deepEqual(extra.structuredContent.error.fields.map((f) => f.field), ["output"]);
  assert.equal((await mcp.tool("runs_start", { agent_id: "calc", input: { content: "hi" }, effort: "max" }, { ok: false })).structuredContent.error.fields[0].field, "effort");
  const one = (await mcp.tool("runs_start", { agent_id: "calc", input: { content: "What is six times seven?" } })).structuredContent;
  // A path the files route refuses is refused here too, never read.
  assert.equal((await mcp.tool("runs_files", { run_id: one.run_id, path: "../../.token" }, { ok: false })).structuredContent.error.code, "invalid_file_path");
  assert.equal((await mcp.tool("runs_events", { run_id: one.run_id, limit: 501 }, { ok: false })).structuredContent.error.code, "bad_request");

  // agents_revise: the fields given change, the rest stay, null clears one; the next run runs it.
  const revised = (await mcp.tool("agents_revise", { agent_id: "calc", instructions: "Answer in one word.", model: null, note: "shorter" })).structuredContent;
  assert.equal(revised.revisions, 2);
  const now = (await v2(server, "GET", "/agents/calc")).body.definition;
  assert.deepEqual([now.instructions, now.tools, now.model, now.name], ["Answer in one word.", ["read"], undefined, "Calc"]);
  const notes = (await v2(server, "GET", "/agents/calc/revisions")).body.revisions.map((r) => r.note);
  assert.equal(notes[0], "shorter");
});

test("agents_create and agents_revise pass any other definition field through to the route's own checks: a place round-trips, a field named outright wins, and one the route refuses is its 422", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  const made = (await mcp.tool("agents_create", { id: "placed", name: "Placed", instructions: "Answer.", definition: { place: { mode: "runner" }, instructions: "Not this." } })).structuredContent;
  assert.deepEqual(made.definition.place, { mode: "runner" });
  assert.equal(made.definition.instructions, "Answer.", "a field named outright wins over the same one in definition");
  assert.deepEqual((await v2(server, "GET", "/agents/placed")).body.definition.place, { mode: "runner" });
  const revised = (await mcp.tool("agents_revise", { agent_id: "placed", definition: { place: { mode: "sandbox", box: "bwrap" } }, note: "boxed" })).structuredContent;
  assert.deepEqual([revised.revisions, revised.definition.place, revised.definition.instructions], [2, { mode: "sandbox", box: "bwrap" }, "Answer."], "the place changes, the rest stays");
  // A field the route refuses is its own 422, by field; a definition that is no object is the tool's.
  const refused = await mcp.tool("agents_create", { id: "bad", name: "Bad", instructions: "Answer.", definition: { input_schema: {} } }, { ok: false });
  assert.deepEqual([refused.structuredContent.error.code, refused.structuredContent.error.fields.map((f) => f.field)], ["input_invalid", ["definition.input_schema"]]);
  // A null the tool does not clear (only model and thinking) reaches the route, which refuses it by field.
  const nulled = await mcp.tool("agents_revise", { agent_id: "placed", definition: { input_schema: null } }, { ok: false });
  assert.deepEqual([nulled.structuredContent.error.code, nulled.structuredContent.error.fields.map((f) => f.field)], ["input_invalid", ["definition.input_schema"]]);
  const unplaced = await mcp.tool("agents_revise", { agent_id: "placed", definition: { place: null } }, { ok: false });
  assert.deepEqual([unplaced.structuredContent.error.code, unplaced.structuredContent.error.fields[0].field], ["input_invalid", "definition.place"]);
  assert.deepEqual((await v2(server, "GET", "/agents/placed")).body.definition.place, { mode: "sandbox", box: "bwrap" }, "a refused revise changes nothing");
  const wrong = await mcp.tool("agents_revise", { agent_id: "placed", definition: "sandbox" }, { ok: false });
  assert.deepEqual([wrong.structuredContent.error.code, wrong.structuredContent.error.fields[0].field], ["input_invalid", "definition"]);
  // The tools say so.
  const { tools } = (await mcp.request("tools/list")).result;
  for (const name of ["agents_create", "agents_revise"]) assert.equal(tools.find((tool) => tool.name === name).inputSchema.properties.definition.type, "object", name);
});

test("runs_get names the question a waiting run asked, runs_respond answers it, and runs_cancel ends another", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  await mcp.tool("agents_create", { id: "asker", name: "Asker", instructions: "Answer.", tools: ["ask_person"] });
  const { run_id } = (await mcp.tool("runs_start", { agent_id: "asker", input: { content: "Pick a region." } })).structuredContent;
  const waiting = await mcp.until(run_id, ["input_required"]);
  assert.deepEqual([waiting.pending.kind, waiting.pending.question, typeof waiting.pending.asked_at], ["question", "Which region should I use?", "string"]);
  // The run's own field, as GET /v2/runs/{id} gives it: no scan of its timeline.
  assert.deepEqual((await v2(server, "GET", `/runs/${run_id}`)).body.pending, waiting.pending);
  assert.equal((await mcp.tool("runs_respond", { run_id, content: "eu" })).structuredContent.mode, "answer");
  const answered = await mcp.until(run_id, ["completed"]);
  assert.deepEqual(JSON.parse(answered.result.final_answer), { region: "eu" });
  assert.equal(answered.pending, null, "answered, it waits on nothing");

  const slow = (await mcp.tool("runs_start", { agent_id: "asker", input: { content: "Take your time." } })).structuredContent;
  await mcp.until(slow.run_id, ["working"]);
  assert.equal((await mcp.tool("runs_cancel", { run_id: slow.run_id })).structuredContent.cancel_requested, true);
  assert.equal((await mcp.until(slow.run_id, ["cancelled"])).status, "cancelled");
});

test("GET /v2/runs/{id}/timeline takes a limit: pages of at most that many rows, has_more between them", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  await mcp.tool("agents_create", { id: "calc", name: "Calc", instructions: "Answer." });
  const { run_id } = (await mcp.tool("runs_start", { agent_id: "calc", input: { content: "What is six times seven?" } })).structuredContent;
  await mcp.until(run_id, ["completed"]);
  // The status reads completed before the run is settled, and settling replaces its rows with the store's (the live
  // run:start and run:end rows go): every read is made once the timeline says final, so all of them see the same rows.
  let whole;
  for (const end = Date.now() + 5_000; !(whole = (await v2(server, "GET", `/runs/${run_id}/timeline`)).body).final; await sleep(50)) {
    assert.ok(Date.now() < end, `the run's timeline is final within 5 s: ${JSON.stringify({ status: whole.status, rows: whole.rows.map((r) => r.id) })}`);
  }
  const first = (await v2(server, "GET", `/runs/${run_id}/timeline?limit=1`)).body;
  assert.deepEqual([first.rows.length, first.has_more], [1, true]);
  const rest = (await v2(server, "GET", `/runs/${run_id}/timeline?after=${first.next_after}&limit=500`)).body;
  assert.deepEqual([...first.rows, ...rest.rows].map((r) => r.id).sort(), whole.rows.map((r) => r.id).sort());
  for (const limit of ["0", "501", "x"]) assert.equal((await v2(server, "GET", `/runs/${run_id}/timeline?limit=${limit}`)).status, 400, limit);
});

test("the protocol's own refusals: an unknown method or tool, a batch, bad JSON, a malformed message, another method than POST, an unknown protocol version", async (t) => {
  const server = await serve(t);
  const mcp = mcpClient(server);
  assert.equal((await mcp.request("resources/list")).error.code, -32601);
  assert.equal((await mcp.request("tools/call", { name: "drop_tables", arguments: {} })).error.code, -32602);
  assert.deepEqual((await mcp.request("ping")).result, {});
  const batch = await mcp.post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.deepEqual([batch.status, batch.body.error.code], [400, -32600]);
  const broken = await mcp.post("{ not json");
  assert.deepEqual([broken.status, broken.body.error.code], [400, -32700]);
  assert.equal((await mcp.post({ jsonrpc: "1.0", id: 1, method: "ping" })).status, 400);
  assert.equal((await mcp.post({ jsonrpc: "2.0", id: null, method: "ping" })).status, 400, "a request's id is never null");
  const notText = await mcp.post({ jsonrpc: "2.0", id: 7, method: 123 });
  assert.deepEqual([notText.status, notText.body.id, notText.body.error.code], [400, 7, -32600]);
  for (const odd of [{ jsonrpc: "2.0", id: 8 }, { jsonrpc: "2.0", id: 9, result: {}, error: { code: 1, message: "x" } }, { jsonrpc: "2.0", result: {} }]) {
    const res = await mcp.post(odd);
    assert.deepEqual([res.status, res.body.error.code], [400, -32600], JSON.stringify(odd));
  }
  for (const taken of [{ jsonrpc: "2.0", id: 5, result: {} }, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }]) {
    const res = await mcp.post(taken);
    assert.deepEqual([res.status, res.text], [202, ""], JSON.stringify(taken));
  }
  const version = await mcp.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
  assert.deepEqual([version.status, version.body.error.code], [400, -32600]);
  for (const known of ["2025-11-25", "2025-06-18", "2025-03-26"]) assert.equal((await mcp.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": known })).status, 200, known);
  // A session id is not this server's to keep: ignored.
  assert.equal((await mcp.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-session-id": "abc" })).status, 200);
  for (const method of ["GET", "DELETE"]) {
    const res = await mcp.post(undefined, {}, method);
    assert.deepEqual([res.status, res.headers.get("allow")], [405, "POST"], method);
  }
  assert.equal((await mcp.post("{}", { "content-type": "text/plain" })).status, 415);
  // An older client's version is answered as it asked; an unknown one, with this server's newest.
  assert.equal((await mcp.request("initialize", { ...INIT, protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18");
  assert.equal((await mcp.request("initialize", { ...INIT, protocolVersion: "2099-01-01" })).result.protocolVersion, "2025-11-25");
});

test("GET /llms.txt: public, the repository's text, naming the MCP endpoint and the document", async (t) => {
  const server = await serve(t);
  const res = await fetch(`${server.url}/llms.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  const text = await res.text();
  assert.equal(text, await readFile(new URL("../src/llms.txt", import.meta.url), "utf8"));
  for (const named of ["/v2/mcp", "/v2/openapi.json", "runs_start", "## Start", "## API", "## MCP", "## Optional"]) assert.ok(text.includes(named), named);
  assert.ok(!text.includes(server.token), "no token in it");
  assert.equal((await fetch(`${server.url}/llms.txt`, { method: "POST" })).status, 405);
});

test("the MCP SDK's own client connects, lists the ten tools and calls one", async (t) => {
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
  assert.equal((await client.callTool({ name: "whoami", arguments: {} })).structuredContent.authenticated, true);
  assert.deepEqual((await client.callTool({ name: "agents_list", arguments: {} })).structuredContent, { agents: [], next_cursor: null });
});

test("the timeline's limit, read while an answered run's end is carried back: its pages are the whole timeline, and the same rows once the run is final", async (t) => {
  // The run's process cannot exit while the gate's file is missing: the reads below land between the answer and the
  // carry back, the window "GET /v2/runs/{id}/timeline takes a limit" can land in on a loaded machine.
  const gate = join(await scratch(t), "gate");
  withEnv(t, { EXIT_GATE: gate });
  const server = await serve(t, { faux: new URL("./fixtures/faux-answer-slow-exit.mjs", import.meta.url).pathname });
  const mcp = mcpClient(server);
  await mcp.tool("agents_create", { id: "calc", name: "Calc", instructions: "Answer." });
  const { run_id } = (await mcp.tool("runs_start", { agent_id: "calc", input: { content: "What is six times seven?" } })).structuredContent;
  await mcp.until(run_id, ["completed"]);
  /** The whole timeline's ids, checked against the same timeline read one row, then the rest. */
  const read = async () => {
    const whole = (await v2(server, "GET", `/runs/${run_id}/timeline`)).body;
    const first = (await v2(server, "GET", `/runs/${run_id}/timeline?limit=1`)).body;
    const rest = (await v2(server, "GET", `/runs/${run_id}/timeline?after=${first.next_after}&limit=500`)).body;
    assert.deepEqual([...first.rows, ...rest.rows].map((r) => r.id).sort(), whole.rows.map((r) => r.id).sort());
    return { ids: whole.rows.map((r) => r.id), final: whole.final };
  };
  const answered = await read();
  assert.equal(answered.final, false, "read before the run's end is carried back");
  await writeFile(gate, "");
  for (const end = Date.now() + 30_000; !(await v2(server, "GET", `/runs/${run_id}/timeline?wait_ms=1000`)).body.final; ) assert.ok(Date.now() < end, "the run's end is carried back");
  const ended = await read();
  assert.equal(ended.final, true);
  assert.deepEqual(ended.ids, answered.ids, "no row a reader saw goes when the run's end is carried back");
});

test("a run paused at its spend cap: the instructions, runs_get and runs_respond say it waits for its cap to be raised and is not answered; runs_get gives pending kind budget, and runs_respond is refused 409 budget_reached", async (t) => {
  const server = await serve(t, { faux: new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname });
  const mcp = mcpClient(server);
  const init = await mcp.request("initialize", INIT);
  assert.match(init.result.instructions, /pending kind budget.*paused at its spend cap.*do not answer it/s);
  const { tools } = (await mcp.request("tools/list")).result;
  const described = Object.fromEntries(tools.map((tool) => [tool.name, tool.description]));
  assert.match(described.runs_get, /\{kind: "budget", cap_usd, spent_usd, needs_usd, suggested_cap_usd, said, at\}/);
  assert.match(described.runs_get, /waits for its cap to be raised, PATCH \/v2\/runs\/\{run_id\} \{max_cost_usd\}, which a person decides; suggested_cap_usd is a raise that resumes it/);
  assert.match(described.runs_respond, /paused at its spend cap \(pending kind budget\) takes no message: 409 budget_reached/);
  // The run: a $0.05 cap under the least of one request ($0.1024), paused before anything was sent.
  await mcp.tool("agents_create", { id: "capped", name: "Capped", instructions: "Answer." });
  const started = await v2(server, "POST", "/agents/capped/runs", { input: { content: "hi" }, max_cost_usd: 0.05 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const paused = await mcp.until(started.body.run_id, ["input_required", "failed"]);
  assert.deepEqual([paused.status, paused.state, paused.pending?.kind, paused.pending?.cap_usd], ["input_required", "waiting", "budget", 0.05], JSON.stringify(paused));
  const refused = await mcp.tool("runs_respond", { run_id: started.body.run_id, content: "go on" }, { ok: false });
  assert.match(JSON.stringify(refused), /budget_reached/);
});
