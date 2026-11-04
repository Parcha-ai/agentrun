// A stand-in for the pinned `opencode serve`, for tests: no OpenCode binary, no network beyond loopback. It speaks the
// subset of OpenCode's server the adapter uses, in OpenCode's shapes (recorded from the pinned build: test/fixtures):
//  - it takes `opencode serve`'s own `--hostname` and `--port` (127.0.0.1 and 0 when not given), listens there, prints
//    `opencode server listening on http://<hostname>:<port>`, and answers only with basic auth (`opencode`,
//    OPENCODE_SERVER_PASSWORD);
//  - `GET /event` (server-sent events: server.connected, message.updated, message.part.updated, message.part.delta,
//    session.status, session.idle, session.error), `POST /session`, `POST /session/:id/prompt_async`,
//    `POST /session/:id/abort`, `GET /session/:id/message`, `POST /sync/history`, `POST /sync/replay`;
//  - a prompt runs OpenCode's loop on the config it was given (OPENCODE_CONFIG_CONTENT): each step a Responses request to
//    its one provider (the adapter's model proxy, with its key), each function call the answer makes an MCP `tools/call`
//    to its one MCP server (the adapter's), until an answer makes none;
//  - every change is a sync event of the session's (its aggregate), so /sync/history gives the log and /sync/replay
//    rebuilds the session from it in a fresh process.
// FAKE_OPENCODE_EXIT_AFTER_CALL=<tool>: the process exits (as if killed) once that tool's MCP call has started.
// FAKE_OPENCODE_STALL_EVENTS=<n>: the process's first n event-stream requests get no answer at all.
// FAKE_OPENCODE_DROP_EVENTS_IN_TURN=1: the event stream ends as the first turn starts, and a new one is answered only
//   once that turn has answered: its text and its end come while no one listens.
// FAKE_OPENCODE_REJECT_PROMPT=1: prompt_async answers 400 with a reason, and runs nothing.
// FAKE_OPENCODE_EVENTS_GONE=<ms>: the first event stream says server.connected and ends at once, every later one is
//   answered 503, and the first /sync/history waits <ms> first: a drive's stream runs out of tries while the drive
//   mirrors a new session, before any turn.
// FAKE_OPENCODE_IGNORE_ABORT=1: `POST /session/:id/abort` answers 200 and the turn goes on: OpenCode does not end it.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
const provider = config.provider?.openai?.options ?? {};
const mcpEntry = config.mcp?.hands ?? {};
const agentName = config.default_agent ?? "hands";
const prompt = config.agent?.[agentName]?.prompt ?? "";
const exitAfter = process.env.FAKE_OPENCODE_EXIT_AFTER_CALL;
let stalls = Number(process.env.FAKE_OPENCODE_STALL_EVENTS ?? 0);
let dropInTurn = process.env.FAKE_OPENCODE_DROP_EVENTS_IN_TURN === "1";
const goneAfter = Number(process.env.FAKE_OPENCODE_EVENTS_GONE ?? 0);
let goneOpened = false;
let goneWaited = false;
/** While set, a new event-stream request waits for it before it is answered. */
let held;
const trace = process.env.FAKE_OPENCODE_TRACE;
const note = (line) => trace && appendFileSync(trace, `${JSON.stringify({ pid: process.pid, ...line })}\n`);

const id = (prefix) => `${prefix}_${Date.now().toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`;
const subscribers = new Set();
const emit = (type, properties) => {
  const data = `data: ${JSON.stringify({ id: id("evt"), type, properties })}\n\n`;
  for (const res of subscribers) res.write(data);
};

/** The session's state, rebuilt from its sync events alone. */
const sessions = new Map();
function apply(event) {
  const { aggregate_id: sid, type, data } = event;
  if (type === "session.created.1") sessions.set(sid, { id: sid, title: data.info.title, messages: [], events: [], busy: undefined });
  const s = sessions.get(sid);
  if (!s) return;
  s.events.push(event);
  if (type === "message.updated.1") {
    const at = s.messages.findIndex((m) => m.info.id === data.info.id);
    if (at >= 0) s.messages[at].info = data.info;
    else s.messages.push({ info: data.info, parts: [] });
  } else if (type === "message.part.updated.1") {
    const m = s.messages.find((x) => x.info.id === data.part.messageID);
    if (!m) return;
    const at = m.parts.findIndex((p) => p.id === data.part.id);
    if (at >= 0) m.parts[at] = data.part;
    else m.parts.push(data.part);
  }
}
/** A change of the session's: its sync event, applied, then published as the bus event OpenCode publishes for it. */
function record(sid, type, data) {
  const s = sessions.get(sid);
  const seq = s ? s.events.length : 0;
  const event = { id: id("evt"), aggregate_id: sid, seq, type: `${type}.1`, data };
  apply(event);
  emit(type, data);
}

const status = (sid, type) => {
  emit("session.status", { sessionID: sid, status: { type } });
  if (type === "idle") emit("session.idle", { sessionID: sid });
};

async function mcp(method, params, signal) {
  const res = await fetch(mcpEntry.url, {
    method: "POST",
    headers: { ...(mcpEntry.headers ?? {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (res.headers.get("content-type")?.startsWith("text/event-stream")) {
    const last = text.split("\n\n").map((b) => b.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")).filter(Boolean).map((d) => JSON.parse(d)).findLast((m) => "result" in m || "error" in m);
    return last;
  }
  return JSON.parse(text);
}

/** The model's input for the session so far: its messages as Responses items. */
function inputOf(s, system) {
  const input = [{ role: "system", content: system }];
  for (const m of s.messages) {
    for (const p of m.parts) {
      if (p.type === "text" && m.info.role === "user") input.push({ role: "user", content: [{ type: "input_text", text: p.text }] });
      else if (p.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: p.text }] });
      else if (p.type === "tool") {
        input.push({ type: "function_call", call_id: p.callID, name: p.tool, arguments: JSON.stringify(p.state.input ?? {}) });
        const output = p.state.status === "completed" ? p.state.output : p.state.status === "error" ? p.state.error : "[Tool execution was interrupted]";
        input.push({ type: "function_call_output", call_id: p.callID, output });
      }
    }
  }
  return input;
}

/** One Responses request, streamed: the text it says and the function calls it makes, read from its events. */
async function step(s, tools, system, signal) {
  const body = { model: config.model?.split("/").slice(1).join("/") ?? "model", input: inputOf(s, system), ...(tools.length ? { tools, tool_choice: "auto" } : {}), stream: true, store: false, max_output_tokens: config.provider?.openai?.models?.[Object.keys(config.provider.openai.models)[0]]?.limit?.output ?? 32000 };
  const res = await fetch(`${provider.baseURL}/responses`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal });
  if (res.status !== 200) {
    const text = await res.text();
    throw Object.assign(new Error(text.slice(0, 300) || `status ${res.status}`), { name: "APIError", statusCode: res.status });
  }
  const out = { text: "", calls: [], usage: undefined, deltas: [] };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      const e = JSON.parse(data);
      if (e.type === "response.output_text.delta") out.deltas.push(e.delta);
      if (e.type === "response.output_item.done" && e.item?.type === "function_call") out.calls.push(e.item);
      if (e.type === "response.completed") out.usage = e.response?.usage;
    }
  }
  out.text = out.deltas.join("");
  return out;
}

const running = new Map();

async function loop(sid, user) {
  const s = sessions.get(sid);
  const controller = new AbortController();
  running.set(sid, controller);
  const signal = controller.signal;
  status(sid, "busy");
  let release;
  if (dropInTurn) {
    dropInTurn = false;
    held = new Promise((resolve) => (release = resolve));
    for (const res of [...subscribers]) {
      subscribers.delete(res);
      res.end();
    }
    note({ dropped: "/event" });
  }
  let error;
  try {
    const listed = await mcp("tools/list", {}, signal);
    const tools = (listed.result?.tools ?? []).map((t) => ({ type: "function", name: `hands_${t.name}`, description: t.description, parameters: { ...t.inputSchema, type: "object", additionalProperties: false }, strict: false }));
    const system = [prompt, `<env>\n  Working directory: ${process.cwd()}\n</env>`, ...(user.system ? [user.system] : [])].filter(Boolean).join("\n");
    for (;;) {
      const assistant = { id: id("msg"), sessionID: sid, role: "assistant", parentID: user.id, time: { created: Date.now() }, modelID: "model", providerID: "openai", mode: agentName, agent: agentName, path: { cwd: process.cwd(), root: process.cwd() }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
      record(sid, "message.updated", { sessionID: sid, info: assistant });
      const answer = await step(s, tools, system, signal);
      if (answer.deltas.length) {
        const part = { id: id("prt"), sessionID: sid, messageID: assistant.id, type: "text", text: "", time: { start: Date.now() } };
        record(sid, "message.part.updated", { sessionID: sid, part, time: Date.now() });
        for (const delta of answer.deltas) emit("message.part.delta", { sessionID: sid, messageID: assistant.id, partID: part.id, field: "text", delta });
        record(sid, "message.part.updated", { sessionID: sid, part: { ...part, text: answer.text, time: { start: part.time.start, end: Date.now() } }, time: Date.now() });
      }
      for (const call of answer.calls) {
        const input = JSON.parse(call.arguments || "{}");
        const part = { id: id("prt"), sessionID: sid, messageID: assistant.id, type: "tool", callID: call.call_id, tool: call.name, state: { status: "running", input, time: { start: Date.now() } } };
        record(sid, "message.part.updated", { sessionID: sid, part, time: Date.now() });
        if (exitAfter && call.name === `hands_${exitAfter}`) {
          note({ exitingAt: call.call_id });
          // As a kill would: the call has reached the MCP server, and nothing after it is recorded.
          void mcp("tools/call", { name: call.name.slice("hands_".length), arguments: input, _meta: { progressToken: 1 } }).catch(() => {});
          setTimeout(() => process.kill(process.pid, "SIGKILL"), 300);
          await new Promise(() => {});
        }
        const result = await mcp("tools/call", { name: call.name.slice("hands_".length), arguments: input, _meta: { progressToken: 1 } }, signal);
        const text = (result.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n\n");
        const state = result.error ? { status: "error", input, error: result.error.message, time: { start: part.state.time.start, end: Date.now() } }
          : result.result?.isError ? { status: "error", input, error: text || "MCP tool returned an error", time: { start: part.state.time.start, end: Date.now() } }
          : { status: "completed", input, output: text, title: "", metadata: {}, time: { start: part.state.time.start, end: Date.now() } };
        record(sid, "message.part.updated", { sessionID: sid, part: { ...part, state }, time: Date.now() });
      }
      const usage = answer.usage ?? {};
      record(sid, "message.updated", { sessionID: sid, info: { ...assistant, time: { ...assistant.time, completed: Date.now() }, tokens: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: answer.calls.length ? "tool-calls" : "stop" } });
      if (!answer.calls.length) break;
    }
  } catch (err) {
    error = signal.aborted ? { name: "MessageAbortedError", data: { message: "The operation was aborted." } } : { name: err?.name ?? "UnknownError", data: { message: String(err?.message ?? err) } };
  } finally {
    running.delete(sid);
  }
  if (error) emit("session.error", { sessionID: sid, error });
  status(sid, "idle");
  if (release) {
    held = undefined;
    release();
  }
}

const json = (res, status, body) => {
  if (body === undefined) return void res.writeHead(status).end();
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) return json(res, 401, { error: "unauthorized" });
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  note({ method: req.method, path });
  if (req.method === "GET" && path === "/event") {
    if (stalls > 0) {
      stalls -= 1;
      note({ stalled: "/event" });
      return; // no headers, no body: the client's own timeout ends it
    }
    if (goneAfter) {
      if (goneOpened) {
        note({ refused: "/event" });
        return json(res, 503, { error: "the event stream is gone" });
      }
      goneOpened = true;
      note({ ended: "/event" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      return res.end(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", properties: {} })}\n\n`);
    }
    if (held) await held;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", properties: {} })}\n\n`);
    subscribers.add(res);
    req.on("close", () => subscribers.delete(res));
    return;
  }
  if (req.method === "POST" && path === "/session") {
    const sid = id("ses");
    const info = { id: sid, slug: sid, projectID: "global", directory: process.cwd(), title: body?.title ?? "New session", version: "1.19.5", time: { created: Date.now(), updated: Date.now() } };
    record(sid, "session.created", { sessionID: sid, info });
    return json(res, 200, info);
  }
  if (req.method === "POST" && path === "/sync/history") {
    if (goneAfter && !goneWaited) {
      goneWaited = true;
      await new Promise((resolve) => setTimeout(resolve, goneAfter));
    }
    const exclude = body ?? {};
    const all = [...sessions.values()].flatMap((s) => s.events).filter((e) => !(e.aggregate_id in exclude && e.seq <= exclude[e.aggregate_id]));
    return json(res, 200, all.sort((a, b) => a.seq - b.seq));
  }
  if (req.method === "POST" && path === "/sync/replay") {
    const events = body?.events ?? [];
    if (!events.length) return json(res, 400, { error: "no events" });
    for (const e of events) apply({ id: e.id, aggregate_id: e.aggregateID, seq: e.seq, type: e.type, data: e.data });
    note({ replayed: events.length });
    return json(res, 200, { sessionID: events[0].aggregateID });
  }
  if (req.method === "GET" && path === "/session/status") {
    return json(res, 200, Object.fromEntries([...running.keys()].map((sid) => [sid, { type: "busy" }])));
  }
  const m = /^\/session\/([^/]+)\/(prompt_async|abort|message)$/.exec(path);
  if (m) {
    const [, sid, action] = m;
    const s = sessions.get(sid);
    if (!s) return json(res, 404, { error: "no session" });
    if (action === "message" && req.method === "GET") return json(res, 200, s.messages);
    if (action === "abort" && req.method === "POST") {
      if (process.env.FAKE_OPENCODE_IGNORE_ABORT !== "1") running.get(sid)?.abort();
      return json(res, 200, true);
    }
    if (action === "prompt_async" && req.method === "POST" && process.env.FAKE_OPENCODE_REJECT_PROMPT === "1") {
      return json(res, 400, { name: "BadRequest", data: { message: "agent hands is not configured" } });
    }
    if (action === "prompt_async" && req.method === "POST") {
      if (running.has(sid)) return json(res, 409, { error: "busy" });
      const user = { id: body.messageID ?? id("msg"), sessionID: sid, role: "user", time: { created: Date.now() }, agent: body.agent, model: body.model, ...(body.system ? { system: body.system } : {}) };
      if (!s.messages.some((x) => x.info.id === user.id)) {
        record(sid, "message.updated", { sessionID: sid, info: user });
        for (const p of body.parts ?? []) record(sid, "message.part.updated", { sessionID: sid, part: { id: id("prt"), sessionID: sid, messageID: user.id, type: "text", text: p.text }, time: Date.now() });
      }
      note({ prompt: user.id, system: body.system ?? null });
      void loop(sid, user);
      return json(res, 204);
    }
  }
  json(res, 404, { error: "not found" });
});

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) && argv[argv.indexOf(name) + 1] !== undefined ? argv[argv.indexOf(name) + 1] : fallback);
const hostname = flag("--hostname", "127.0.0.1");
server.listen(Number(flag("--port", "0")), hostname, () => {
  process.stdout.write(`opencode server listening on http://${hostname}:${server.address().port}\n`);
});
