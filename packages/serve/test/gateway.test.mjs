// A run's gateway, from the box's side: a client that holds only the run's token reaches its model and its network tools
// through serve, and never sees serve's credential. The providers are fake HTTP servers on loopback: no key, no network,
// no box. pi-ai's own clients are pointed at it the way a pi run in a box would be.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { anthropicGatewayPolicy, responsesGatewayPolicy } from "../dist/gateway-policies.js";
import { GATEWAY_SOCKET, startRunGateway } from "../dist/gateway.js";
import { runModels } from "../dist/model.js";

/** serve's credentials, which only the fake providers may see. */
const ANTHROPIC_KEY = "anthropic-cred-of-serve";
const OPENAI_KEY = "openai-cred-of-serve";
const CLAUDE = "claude-sonnet-4-5";
const GPT = "gpt-6-luna";

const anthropicEvents = (text) => [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: CLAUDE, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];
const responsesEvents = (text) => {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
  ];
};

/** A provider on loopback: it records each request it gets (path, headers, body) and streams `events` back. */
async function fakeProvider(t, events) {
  const got = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      got.push({ method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined });
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, got };
}

/** One raw request, over a unix socket (`socketPath`) or to `origin`: status, headers, text and parsed JSON. */
function send({ socketPath, origin, method = "POST", path, headers = {}, body }) {
  const where = socketPath ? { socketPath } : { host: new URL(origin).hostname, port: new URL(origin).port };
  return new Promise((resolve, reject) => {
    const req = request({ ...where, method, path, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** A gateway with both providers mounted and `tools`, on a socket in a fresh directory (or on loopback with `tcp`). */
async function gateway(t, { tools = [], tcp = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const logged = [];
  const anthropic = await fakeProvider(t, anthropicEvents("hello from anthropic"));
  const openai = await fakeProvider(t, responsesEvents("hello from openai"));
  const gw = await startRunGateway({
    ...(tcp ? {} : { socketDir: dir }),
    upstreams: {
      anthropic: { policy: anthropicGatewayPolicy({ models: [CLAUDE] }), origin: anthropic.origin, credential: () => ANTHROPIC_KEY },
      openai: { policy: responsesGatewayPolicy({ models: [GPT] }), origin: openai.origin, credential: () => OPENAI_KEY },
    },
    tools,
    log: (message, detail) => logged.push(JSON.stringify({ message, ...detail })),
  });
  t.after(async () => {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (options) => send({ ...(tcp ? { origin: gw.url } : { socketPath: gw.socketPath }), ...options });
  return { gw, dir, anthropic, openai, logged, call };
}

/** A host tool that records each run and answers with its arguments; `hold` keeps a run open until it resolves. */
function recorded(name, replay, hold) {
  const tool = {
    name, description: name, inputSchema: { type: "object" }, replay, runs: [],
    async call(args, { callId, signal }) {
      tool.runs.push({ args, callId, signal });
      if (hold) await hold(signal);
      return { text: `${name} ${JSON.stringify(args)}`, isError: false };
    },
  };
  return tool;
}

const until = async (ready, what) => {
  for (const end = Date.now() + 5_000; !ready(); await new Promise((resolve) => setTimeout(resolve, 2))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

test("over its socket, an Anthropic request and a Responses request each reach their own provider with serve's credential, and the client never sees it", async (t) => {
  const { gw, anthropic, openai, logged, call } = await gateway(t);
  const messages = await call({
    path: "/anthropic/v1/messages?beta=true",
    headers: { "x-api-key": gw.token, "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "x-stainless-lang": "js" },
    body: { model: CLAUDE, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(messages.status, 200);
  assert.match(messages.text, /hello from anthropic/);
  const responses = await call({ path: "/openai/v1/responses", headers: { authorization: `Bearer ${gw.token}` }, body: { model: GPT, input: [{ role: "user", content: "hi" }], stream: true, store: false } });
  assert.equal(responses.status, 200);
  assert.match(responses.text, /hello from openai/);
  // Each provider got its own request alone, on its own route, with serve's credential where its protocol carries a key.
  assert.deepEqual(anthropic.got.map((r) => r.url), ["/v1/messages?beta=true"]);
  assert.deepEqual(openai.got.map((r) => r.url), ["/v1/responses"]);
  assert.equal(anthropic.got[0].headers["x-api-key"], ANTHROPIC_KEY);
  assert.equal(anthropic.got[0].headers.authorization, undefined);
  assert.equal(anthropic.got[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(anthropic.got[0].headers["anthropic-beta"], "fine-grained-tool-streaming-2025-05-14", "a beta the client sends passes");
  assert.equal(anthropic.got[0].headers["x-stainless-lang"], undefined, "only the protocol's own headers are forwarded");
  assert.equal(openai.got[0].headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(anthropic.got[0].body.model, CLAUDE);
  assert.equal(openai.got[0].body.model, GPT);
  // The run's token reaches no provider; serve's credentials reach neither the client nor the log.
  for (const r of [...anthropic.got, ...openai.got]) assert.ok(!JSON.stringify(r).includes(gw.token));
  for (const answer of [messages, responses]) for (const secret of [ANTHROPIC_KEY, OPENAI_KEY]) assert.ok(!JSON.stringify(answer).includes(secret));
  for (const secret of [ANTHROPIC_KEY, OPENAI_KEY, gw.token]) assert.ok(!logged.join("\n").includes(secret));
});

test("pi-ai's own clients, with the run's token as their key, get their answers through the gateway: Anthropic's by its provider's base URL, Responses by serve's gateway mode", async (t) => {
  const { gw, anthropic, openai } = await gateway(t, { tcp: true });
  // pi-ai's Anthropic provider as it ships; its auth names the key and the base URL, which pi-ai applies to each request.
  const models = createModels();
  models.setProvider({ ...anthropicProvider(), auth: { apiKey: { name: "the run's gateway", resolve: async () => ({ auth: { apiKey: gw.token, baseUrl: `${gw.url}/anthropic` } }) } } });
  const said = await models.complete(models.getModel("anthropic", CLAUDE), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
  assert.equal(said.stopReason, "stop", said.errorMessage);
  assert.equal(said.content.map((block) => block.text ?? "").join(""), "hello from anthropic");
  assert.equal(anthropic.got.length, 1);
  assert.equal(anthropic.got[0].url, "/v1/messages?beta=true");
  assert.equal(anthropic.got[0].headers["x-api-key"], ANTHROPIC_KEY);
  assert.equal(anthropic.got[0].body.model, CLAUDE);
  // Responses: serve's own gateway mode, as a pi run would be started in a box.
  const env = { AGENT_MODEL_BASE_URL: `${gw.url}/openai/v1`, AGENT_MODEL_API_KEY: gw.token, AGENT_MODEL: GPT };
  const { models: run, model } = await runModels(env, undefined);
  const answer = await run.complete(run.getModel(model.provider, model.modelId), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(answer.content.map((block) => block.text ?? "").join(""), "hello from openai");
  assert.equal(openai.got.length, 1);
  assert.equal(openai.got[0].url, "/v1/responses");
  assert.equal(openai.got[0].headers.authorization, `Bearer ${OPENAI_KEY}`);
  for (const r of [...anthropic.got, ...openai.got]) assert.ok(!JSON.stringify(r).includes(gw.token));
});

test("no token or a wrong one is 401 on every route (a provider's, a tool's, an unknown path); after revoke() the right one is 401 too; the token is in no answer and no log line", async (t) => {
  const { gw, anthropic, openai, logged, call } = await gateway(t, { tools: [recorded("echo", "safe")] });
  const bearer = (key) => ({ authorization: `Bearer ${key}` });
  const routes = [
    { path: "/anthropic/v1/messages", key: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }), body: { model: CLAUDE, max_tokens: 8, messages: [] }, ok: 200 },
    { path: "/openai/v1/responses", key: bearer, body: { model: GPT, input: [] }, ok: 200 },
    { path: "/tools/echo", key: bearer, body: { callId: "c1", args: {} }, ok: 200 },
    { method: "GET", path: "/nowhere", key: bearer, ok: 404 },
  ];
  const answers = [];
  const wrong = Buffer.alloc(32, 7).toString("base64url");
  for (const route of routes) {
    for (const headers of [{}, route.key(wrong), route.key(gw.token.slice(0, -1)), route.key(`${gw.token}x`)]) {
      const answer = await call({ ...route, headers });
      answers.push(answer);
      assert.equal(answer.status, 401, `${route.path} with ${JSON.stringify(Object.keys(headers))}`);
    }
  }
  // A token sent where no key goes (in the path) is not one, and is not repeated.
  answers.push(await call({ method: "GET", path: `/tools/${gw.token}` }));
  assert.equal(answers.at(-1).status, 401);
  assert.equal(anthropic.got.length + openai.got.length, 0, "nothing was forwarded");
  for (const route of routes) assert.equal((await call({ ...route, headers: route.key(gw.token) })).status, route.ok, `${route.path} with the token`);
  gw.revoke();
  assert.equal(gw.revoked, true);
  for (const route of routes) {
    const answer = await call({ ...route, headers: route.key(gw.token) });
    answers.push(answer);
    assert.equal(answer.status, 401, `${route.path} after revoke()`);
  }
  assert.equal(anthropic.got.length, 1);
  assert.equal(openai.got.length, 1);
  for (const answer of answers) assert.ok(!JSON.stringify(answer).includes(gw.token));
  assert.ok(logged.some((line) => line.includes("[run token]")), "the token sent in the path was logged scrubbed");
  assert.ok(!logged.join("\n").includes(gw.token));
});

test("the socket is made 0600 in the directory serve names, nothing else is left there, and close() removes it", async (t) => {
  const { gw, dir, call } = await gateway(t);
  assert.equal(gw.socketPath, join(dir, GATEWAY_SOCKET));
  const made = statSync(gw.socketPath);
  assert.ok(made.isSocket());
  assert.equal(made.mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [GATEWAY_SOCKET]);
  assert.equal((await call({ method: "GET", path: "/nowhere", headers: { authorization: `Bearer ${gw.token}` } })).status, 404);
  await gw.close();
  assert.equal(gw.revoked, true);
  assert.equal(existsSync(gw.socketPath), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("the token is 32 random bytes of its own gateway, and no enumerable field: the gateway logged or serialized does not carry it", async (t) => {
  const one = await gateway(t, { tcp: true });
  const two = await gateway(t, { tcp: true });
  assert.equal(Buffer.from(one.gw.token, "base64url").length, 32);
  assert.notEqual(one.gw.token, two.gw.token);
  assert.ok(!Object.keys(one.gw).includes("token"));
  assert.ok(!JSON.stringify(one.gw).includes(one.gw.token));
  assert.ok(!inspect(one.gw, { depth: 5 }).includes(one.gw.token));
});

test("/tools/<name>: an unknown tool is 404; a safe tool runs once per call id, sent again or at once; a never tool's repeat is refused and never runs", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const read = recorded("read", "safe");
  const fetchPage = recorded("fetch_page", "safe", () => held);
  const write = recorded("write", "never");
  const { gw, call } = await gateway(t, { tools: [read, fetchPage, write] });
  const tool = (name, body, method = "POST") => call({ method, path: `/tools/${name}`, headers: { authorization: `Bearer ${gw.token}` }, body });
  assert.equal((await tool("nope", { callId: "c0", args: {} })).status, 404);
  assert.equal((await tool("../read", { callId: "c0", args: {} })).status, 404);
  assert.equal((await tool("read", undefined, "GET")).status, 405);
  // A safe tool: one call id sent twice runs once, and the repeat gets the first answer (not one for its own args).
  const first = await tool("read", { callId: "c1", args: { path: "a.txt" } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { text: 'read {"path":"a.txt"}', isError: false });
  const again = await tool("read", { callId: "c1", args: { path: "b.txt" } });
  assert.deepEqual(again.json, first.json);
  assert.equal(read.runs.length, 1);
  // Sent twice at once: still one run, and both get its answer.
  const both = [tool("fetch_page", { callId: "f1", args: { url: "https://example.com" } }), tool("fetch_page", { callId: "f1", args: { url: "https://example.com" } })];
  await until(() => fetchPage.runs.length === 1, "the first fetch_page call");
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const [a, b] = await Promise.all(both);
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, b.json);
  assert.equal(fetchPage.runs.length, 1);
  // A never tool: the first call runs; its repeat is refused and does not run.
  assert.equal((await tool("write", { callId: "w1", args: { path: "x" } })).status, 200);
  const replayed = await tool("write", { callId: "w1", args: { path: "x" } });
  assert.equal(replayed.status, 409);
  assert.equal(write.runs.length, 1);
  // A call id is one call: sent to another tool it is refused, whichever ran it.
  assert.equal((await tool("write", { callId: "c1", args: {} })).status, 409);
  assert.equal((await tool("read", { callId: "w1", args: {} })).status, 409);
  assert.equal(read.runs.length + write.runs.length, 2);
  // A body that is not { callId, args }.
  for (const body of [{ args: {} }, { callId: "", args: {} }, { callId: "has space", args: {} }, { callId: "c2", args: {}, extra: 1 }, '{"callId":"c2","callId":"c3"}', "not json"]) {
    assert.equal((await tool("read", body)).status, 400, JSON.stringify(body));
  }
  assert.equal(read.runs.length, 1);
});

test("a tool that throws answers isError, with the token never in its text; revoke() aborts a call in flight, and every later call is 401", async (t) => {
  let gw;
  const boom = { name: "boom", description: "", inputSchema: {}, replay: "safe", call: async () => { throw new Error(`no route to the host for ${gw.token}`); } };
  const hang = recorded("web_fetch", "safe", (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve)));
  const made = await gateway(t, { tools: [boom, hang] });
  gw = made.gw;
  const tool = (name, body) => made.call({ path: `/tools/${name}`, headers: { authorization: `Bearer ${gw.token}` }, body });
  const failed = await tool("boom", { callId: "b1", args: {} });
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.json, { text: "the tool failed: no route to the host for [run token]", isError: true });
  const pending = tool("web_fetch", { callId: "h1", args: {} });
  await until(() => hang.runs.length === 1, "the web_fetch call");
  gw.revoke();
  assert.equal(hang.runs[0].signal.aborted, true);
  assert.equal((await pending).status, 200);
  assert.equal((await tool("boom", { callId: "b2", args: {} })).status, 401);
  assert.ok(!made.logged.join("\n").includes(gw.token));
});

test("through the gateway only the run's models pass, and nothing a provider would fetch, run or hold for the box; what pi-ai sends passes as it is", async (t) => {
  const { gw, anthropic, openai, call } = await gateway(t);
  const viaAnthropic = (body) => call({ path: "/anthropic/v1/messages", headers: { "x-api-key": gw.token, "anthropic-version": "2023-06-01" }, body });
  const viaResponses = (body) => call({ path: "/openai/v1/responses", headers: { authorization: `Bearer ${gw.token}` }, body });
  const user = [{ role: "user", content: "hi" }];
  const blocks = (...content) => [{ role: "user", content }];
  for (const body of [
    { model: "claude-other", max_tokens: 8, messages: user },
    { max_tokens: 8, messages: user },
    { model: CLAUDE, max_tokens: 8, messages: user, tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] },
    { model: CLAUDE, max_tokens: 8, messages: user, tools: [{ type: "web_search_20250305", name: "web_search" }] },
    { model: CLAUDE, max_tokens: 8, messages: user, mcp_servers: [{ type: "url", url: "https://mcp.example.com", name: "x" }] },
    { model: CLAUDE, max_tokens: 8, messages: user, container: "container_1" },
    { model: CLAUDE, max_tokens: 8, messages: blocks({ type: "image", source: { type: "url", url: "https://example.com/a.png" } }) },
    { model: CLAUDE, max_tokens: 8, messages: blocks({ type: "document", source: { type: "file", file_id: "file_1" } }) },
    { model: CLAUDE, max_tokens: 8, messages: [{ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { type: "code_execution_20250825", name: "code_execution" } } }] }] },
  ]) {
    const answer = await viaAnthropic(body);
    assert.ok([400, 403].includes(answer.status), `${answer.status} for ${JSON.stringify(body)}`);
  }
  for (const body of [
    { model: "gpt-other", input: user },
    { model: GPT, input: user, tools: [{ type: "web_search" }] },
    { model: GPT, input: user, tools: [{ type: "namespace", name: "n", tools: [{ type: "code_interpreter" }] }] },
    { model: GPT, input: [{ type: "additional_tools", role: "developer", tools: [{ type: "mcp", server_url: "https://mcp.example.com" }] }] },
    { model: GPT, input: blocks({ type: "input_image", image_url: "https://example.com/a.png" }) },
    { model: GPT, input: blocks({ type: "input_file", file_url: "https://example.com/a.pdf" }) },
    { model: GPT, input: blocks({ type: "input_file", file_id: "file_1" }) },
    { model: GPT, input: user, previous_response_id: "resp_1" },
    { model: GPT, input: user, conversation: "conv_1" },
  ]) {
    const answer = await viaResponses(body);
    assert.ok([400, 403].includes(answer.status), `${answer.status} for ${JSON.stringify(body)}`);
  }
  assert.equal(anthropic.got.length + openai.got.length, 0, "nothing refused was forwarded");
  // pi-ai's shapes: client tools, a tool added as the conversation goes, inline images, and fields no table here lists.
  const image = "iVBORw0KGgo=";
  const messages = {
    model: CLAUDE, max_tokens: 8, stream: true, a_field_from_later: { on: true },
    tools: [{ name: "read", description: "", input_schema: { type: "object" } }, { type: "custom", name: "write", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image } }] },
      { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "edit", input_schema: { type: "object" } } } }] },
    ],
  };
  const responses = {
    model: GPT, stream: true, store: false, prompt_cache_key: "session-1", service_tier: "flex",
    tools: [{ type: "function", name: "read", parameters: {} }, { type: "custom", name: "patch" }],
    input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "wait" }] }] },
      { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${image}` }] },
    ],
  };
  assert.equal((await viaAnthropic(messages)).status, 200);
  assert.equal((await viaResponses(responses)).status, 200);
  assert.deepEqual(anthropic.got.map((r) => r.body), [messages]);
  assert.deepEqual(openai.got.map((r) => r.body), [responses]);
});

test("a provider is mounted under one lowercase segment other than tools, and a tool under a name of its own", async () => {
  const upstream = { policy: responsesGatewayPolicy({ models: [GPT] }), origin: "https://provider.invalid", credential: () => OPENAI_KEY };
  for (const name of ["tools", "Open", "a/b", ""]) await assert.rejects(startRunGateway({ upstreams: { [name]: upstream } }), /mounted under/);
  const echo = recorded("echo", "safe");
  await assert.rejects(startRunGateway({ tools: [echo, recorded("echo", "never")] }), /a name of its own/);
  await assert.rejects(startRunGateway({ tools: [recorded("a b", "safe")] }), /a name of its own/);
});
