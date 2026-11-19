// A stand-in ACP agent whose model is real to it: each prompt goes to ANTHROPIC_HOST's /v1/messages (the model proxy the
// adapter starts for a proxy-billed recipe), with the host's tools as agentrun__<name>, and each tool_use of one is asked
// about (session/request_permission) and called over the session's MCP server. It keeps its conversation in
// $HOME/.model-agent/sessions/<id>.json and loads it back on session/load. No binary, no network beyond loopback: the
// harness-check tests install it from a .tar.bz2 as a recipe's release.
// MODEL_AGENT_MODE (the recipe's env) bends it:
//   good       (default) as above;
//   own-tools  offers its own `shell` tool beside ours on every request, as an agent whose tools are not off;
//   side       asks its HTTPS proxy for telemetry.invalid:443 once at start, as an agent that phones home;
//   no-load    advertises no session/load, so a restart is a new session told the conversation;
//   goose-title titles each call as Goose 1.59.2 does (`agentrun: check echo`), which the adapter does not tie to a
//              tool of ours, so the host's gate is asked about it as the agent's own (`acp_other`);
//   plan       billed on its vendor's plan: its model is MODEL_AGENT_VENDOR (host:port), reached through HTTPS_PROXY's
//              CONNECT on its own key MODEL_AGENT_API_KEY, as a plan-billed agent reaches its vendor beyond loopback.
// Its model is MODEL_AGENT_MODEL; the proxy's address is ANTHROPIC_HOST, else ANTHROPIC_BASE_URL (the recipe's hostEnv).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";

const mode = process.env.MODEL_AGENT_MODE ?? "good";
const loads = mode !== "no-load";
const store = join(process.env.HOME ?? "/nonexistent", ".model-agent", "sessions");
const sessions = new Map();
const save = (session) => {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${session.id}.json`), JSON.stringify({ id: session.id, messages: session.messages }));
};

/** Asks the HTTPS proxy for a host beyond loopback, once: what a phoning-home agent does. */
const phoneHome = () => new Promise((resolve) => {
  const proxy = process.env.HTTPS_PROXY;
  if (!proxy) return resolve();
  const url = new URL(proxy);
  const req = httpRequest({ host: url.hostname, port: url.port, method: "CONNECT", path: "telemetry.invalid:443" });
  req.on("connect", (res, socket) => (socket.destroy(), resolve()));
  req.on("error", () => resolve());
  req.on("response", () => resolve());
  req.end();
});

/** A Messages request to the vendor at MODEL_AGENT_VENDOR (host:port), on the agent's own key, through a CONNECT tunnel
 *  of HTTPS_PROXY: a plan-billed agent's request beyond loopback. Plain HTTP inside the tunnel; a real one is TLS. */
const vendorPost = (body) => new Promise((resolve, reject) => {
  const proxy = new URL(process.env.HTTPS_PROXY ?? "http://proxy.invalid");
  const vendor = process.env.MODEL_AGENT_VENDOR ?? "";
  const refused = (status) => resolve({ status, text: async () => `the proxy refused the tunnel: ${status}` });
  const tunnel = httpRequest({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: vendor });
  tunnel.on("error", reject);
  tunnel.on("response", (res) => refused(res.statusCode));
  tunnel.on("connect", (res, socket) => {
    if (res.statusCode !== 200) return (socket.destroy(), refused(res.statusCode));
    const at = vendor.lastIndexOf(":");
    const headers = { "content-type": "application/json", "x-api-key": process.env.MODEL_AGENT_API_KEY ?? "", "anthropic-version": "2023-06-01", connection: "close" };
    const req = httpRequest({ host: vendor.slice(0, at), port: Number(vendor.slice(at + 1)), method: "POST", path: "/v1/messages", createConnection: () => socket, headers });
    req.on("error", reject);
    req.on("response", (answer) => {
      let raw = "";
      answer.setEncoding("utf8");
      answer.on("data", (chunk) => (raw += chunk));
      answer.on("end", () => (socket.destroy(), resolve({ status: answer.statusCode, text: async () => raw })));
    });
    req.end(body);
  });
  tunnel.end();
});

/** An MCP client over streamable HTTP. */
async function mcpClient(server) {
  let next = 1;
  const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
  const post = async (body) => {
    const response = await fetch(server.url, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    if (response.status === 202) return undefined;
    const raw = await response.text();
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) return raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === body.id);
    return JSON.parse(raw);
  };
  const call = async (method, params) => {
    const answer = await post({ jsonrpc: "2.0", id: next++, method, params });
    if (answer?.error) throw new Error(answer.error.message);
    return answer?.result;
  };
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "model-agent", version: "1" } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { call };
}

async function openSession(id, params, messages) {
  const server = (params.mcpServers ?? []).find((s) => s.name === "agentrun");
  const mcp = server ? await mcpClient(server) : undefined;
  const tools = mcp ? (await mcp.call("tools/list", {})).tools : [];
  const session = { id, messages, mcp, tools };
  sessions.set(id, session);
  return session;
}

/** One Messages request, streamed, read back into its content blocks and stop reason. */
async function ask(session) {
  const offered = session.tools.map((t) => ({ name: `agentrun__${t.name}`, description: t.description ?? "", input_schema: t.inputSchema ?? { type: "object" } }));
  if (mode === "own-tools") offered.push({ name: "shell", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } } } });
  const body = JSON.stringify({ model: process.env.MODEL_AGENT_MODEL, max_tokens: 1024, stream: true, messages: session.messages, tools: offered });
  const response = mode === "plan"
    ? await vendorPost(body)
    : await fetch(`${process.env.ANTHROPIC_HOST ?? process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
      body,
    });
  const raw = await response.text();
  if (response.status !== 200) throw new Error(`the model answered ${response.status}: ${raw.slice(0, 200)}`);
  const blocks = [];
  let stop = "end_turn";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "content_block_start") blocks[event.index] = event.content_block.type === "tool_use" ? { ...event.content_block, json: "" } : { ...event.content_block };
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") blocks[event.index].text += event.delta.text;
    if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") blocks[event.index].json += event.delta.partial_json;
    if (event.type === "message_delta" && event.delta.stop_reason) stop = event.delta.stop_reason;
  }
  const content = blocks.filter(Boolean).map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.json ? JSON.parse(b.json) : {} } : b));
  return { content, stop };
}

async function takeTurn(client, session, prompt) {
  const text = prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  session.messages.push({ role: "user", content: text });
  save(session);
  const notify = (update) => client.notify("session/update", { sessionId: session.id, update });
  for (let step = 0; step < 6; step++) {
    const { content, stop } = await ask(session);
    session.messages.push({ role: "assistant", content });
    save(session);
    const uses = content.filter((b) => b.type === "tool_use");
    if (stop !== "tool_use" || !uses.length) {
      const words = content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (words) await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } });
      return { stopReason: "end_turn" };
    }
    const results = [];
    for (const use of uses) {
      // goose-title: the call titled as Goose 1.59.2 titles it, `agentrun: check echo`.
      const title = mode === "goose-title" && use.name.startsWith("agentrun__") ? `agentrun: ${use.name.slice("agentrun__".length).replace(/_/g, " ")}` : use.name;
      const update = { toolCallId: use.id, title, kind: "other", status: "pending", rawInput: use.input };
      await notify({ sessionUpdate: "tool_call", ...update });
      const options = [{ optionId: "allow_once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject_once", name: "Deny Once", kind: "reject_once" }];
      const answer = await client.request("session/request_permission", { sessionId: session.id, toolCall: update, options });
      const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow_once";
      let result = "the client refused the call";
      let failed = !allowed;
      if (allowed && use.name.startsWith("agentrun__") && session.mcp) {
        try {
          const called = await session.mcp.call("tools/call", { name: use.name.slice("agentrun__".length), arguments: use.input, _meta: { progressToken: use.id } });
          result = (called?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
          failed = called?.isError === true;
        } catch (error) {
          result = String(error?.message ?? error);
          failed = true;
        }
      } else if (allowed) result = "ran";
      await notify({ sessionUpdate: "tool_call_update", toolCallId: use.id, status: failed ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: result } }] });
      results.push({ type: "tool_result", tool_use_id: use.id, content: result, ...(failed ? { is_error: true } : {}) });
    }
    session.messages.push({ role: "user", content: results });
    save(session);
  }
  return { stopReason: "max_turn_requests" };
}

if (mode === "side") await phoneHome();

const app = agent({ name: "model-agent" })
  .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: loads, mcpCapabilities: { http: true, sse: false } }, agentInfo: { name: "model-agent", version: "1.0.0" } }))
  .onRequest("session/new", async ({ params }) => {
    const session = await openSession(`sess_${randomUUID()}`, params, []);
    save(session);
    return { sessionId: session.id };
  })
  .onRequest("session/load", async ({ params }) => {
    const file = join(store, `${params.sessionId}.json`);
    if (!loads || !existsSync(file)) throw RequestError.resourceNotFound(params.sessionId);
    await openSession(params.sessionId, params, JSON.parse(readFileSync(file, "utf8")).messages);
    return {};
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw RequestError.resourceNotFound(params.sessionId);
    return takeTurn(client, session, params.prompt);
  })
  .onNotification("session/cancel", () => {});

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
process.exit(0);
