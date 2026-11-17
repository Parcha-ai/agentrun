#!/usr/bin/env node
// A stand-in ACP agent for the adapter's tests and the conformance suite: a stdio agent on the official SDK whose "model"
// is a script. No binary, no model, no network beyond loopback. Its one argument is a JSON config file:
//   script: the model's steps, the conformance suite's ScriptStep ({call, args} | {say, cut} | {sayLastSteer} |
//           {sayLastResult}) plus {native: kind, title, input}, a tool of the agent's own (a shell, an edit);
//   load: advertise session/load and keep sessions in $HOME/.fake-acp/sessions (default true);
//   advertiseLoad / advertiseHttp: what initialize says, when it should differ from what the agent does;
//   http: advertise MCP over HTTP (default true); the client then picks the transport;
//   style: "goose" (titles agentrun__<tool>, every tool asks permission, allow_always offered first) or "cursor"
//          (titles agentrun-<tool>: <tool>; MCP and execute ask, edits do not; a refused native call still reports
//          completed);
//   askMcp: ask permission before an MCP call (default: by style); askNative: the native kinds that ask;
//   nativeLog: a file each native call that runs appends its title to;
//   countFile: a file each event (new, load, prompt, cancel, mcp, permission) is appended to, one JSON line;
//   systemPrompt: advertise sessionCapabilities.systemPrompt.
// The step the model takes is the number it took before: its session's history (calls, native calls, answers), plus the
// calls a recovery or context note names that its history does not hold, as a resumed model reads its conversation.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const script = config.script ?? [];
const style = config.style ?? "goose";
const loads = config.load ?? true;
const askMcp = config.askMcp ?? true;
const askNative = new Set(config.askNative ?? (style === "cursor" ? ["execute"] : ["execute", "edit", "delete", "move", "fetch", "other"]));
const home = process.env.HOME ?? "/nonexistent";
const store = join(home, ".fake-acp", "sessions");

const said = (event) => config.countFile && appendFileSync(config.countFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`);
const save = (session) => {
  if (!loads) return;
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${session.id}.json`), JSON.stringify({ id: session.id, history: session.history }));
};
const sessions = new Map();
// What it was started with: the names in its environment (never their values), its HOME and its directory.
const pgid = (() => {
  try {
    return Number(readFileSync("/proc/self/stat", "utf8").replace(/^.*\) /s, "").split(" ")[2]);
  } catch {
    return undefined;
  }
})();
said({ type: "start", env: Object.keys(process.env).sort(), home, cwd: process.cwd(), pgid });
const titleOf = (tool) => (style === "cursor" ? `agentrun-${tool}: ${tool}` : `agentrun__${tool}`);
const steps = (history) => history.filter((h) => h.kind === "call" || h.kind === "native" || h.kind === "say").length;
const text = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text);

/** The calls a note names (`- name(...), call <id>:`), a nested one's (`<id>/<key>`) left out. */
const namedCalls = (note) => [...note.matchAll(/, call ([^\s:/]+):/g)].map((m) => m[1]);
/** A note's answers said so far (`- assistant: …`, a context note's). */
const notedAnswers = (note) => note.split("\n").filter((line) => line.startsWith("- assistant: ")).length;
/** The last quoted message in a note (`> ` lines). */
function lastQuote(note) {
  const groups = [];
  let current;
  for (const line of note.split("\n")) {
    if (line.startsWith("> ") || line === ">") {
      if (!current) groups.push((current = []));
      current.push(line.replace(/^> ?/, ""));
    } else current = undefined;
  }
  return groups.at(-1)?.join("\n");
}
/** The last call's result in a recovery note: the 4-space lines under its head, or what follows `failed: `. */
function lastNotedResult(note) {
  const lines = note.split("\n");
  let result;
  for (let i = 0; i < lines.length; i++) {
    const head = /^- .*, call [^\s:]+: (.*)$/.exec(lines[i]);
    if (!head) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith("    "); j++) body.push(lines[j].slice(4));
    result = body.length ? body.join("\n") : head[1].replace(/^failed: /, "");
  }
  return result;
}

/** One MCP connection: streamable HTTP, or a stdio server the agent starts. */
async function mcpClient(server) {
  let next = 1;
  if (server.type === "http") {
    const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
    const post = async (body, signal) => {
      const response = await fetch(server.url, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body), signal });
      if (response.status === 202) return undefined;
      const raw = await response.text();
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const messages = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
        return messages.find((m) => m.id === body.id);
      }
      return JSON.parse(raw);
    };
    const request = async (method, params, signal) => {
      const answer = await post({ jsonrpc: "2.0", id: next++, method, params }, signal);
      if (answer?.error) throw new Error(answer.error.message);
      return answer?.result;
    };
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "1" } });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { request, close() {} };
  }
  const child = spawn(server.command, server.args ?? [], { env: { ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])), PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    signal?.addEventListener("abort", () => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })}\n`);
      waiting.delete(id);
      reject(new Error("cancelled"));
    }, { once: true });
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { request, close: () => child.kill() };
}

async function openSession(id, params, history) {
  const servers = params.mcpServers ?? [];
  const server = servers.find((s) => s.name === "agentrun") ?? servers[0];
  const mcp = server ? await mcpClient(server) : undefined;
  const session = { id, history, mcp, turn: undefined, system: params.systemPrompt ? text(params.systemPrompt.content ?? []).join("\n") : undefined };
  sessions.set(id, session);
  return session;
}

/** Ask the client about a call; true when it allowed it once. */
async function permitted(client, session, update) {
  const options = style === "cursor"
    ? [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "allow-always", name: "Always allow", kind: "allow_always" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }]
    : [{ optionId: "allow_always", name: "Always Allow", kind: "allow_always" }, { optionId: "allow_once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject_once", name: "Deny Once", kind: "reject_once" }, { optionId: "reject_always", name: "Always Deny", kind: "reject_always" }];
  const answer = await client.request("session/request_permission", { sessionId: session.id, toolCall: update, options });
  const chosen = answer.outcome.outcome === "selected" ? options.find((o) => o.optionId === answer.outcome.optionId) : undefined;
  said({ type: "permission", toolCallId: update.toolCallId, title: update.title, outcome: answer.outcome.outcome, kind: chosen?.kind });
  return chosen?.kind === "allow_once" || chosen?.kind === "allow_always";
}

async function takeTurn(client, session, prompt, signal) {
  const blocks = text(prompt);
  const said_ = blocks.at(-1) ?? "";
  const notes = blocks.filter((b) => b.includes("[Recovery]") || b.includes("[Context]")).join("\n");
  const known = new Set(session.history.filter((h) => h.kind === "call").map((h) => h.id));
  const extra = [...new Set(namedCalls(notes))].filter((id) => !known.has(id));
  let step = steps(session.history) + extra.length + notedAnswers(notes);
  session.history.push({ kind: "user", text: said_ });
  save(session);
  const notify = (update) => client.notify("session/update", { sessionId: session.id, update });
  let lastResult = lastNotedResult(notes) ?? [...session.history].reverse().find((h) => (h.kind === "call" || h.kind === "native") && h.result !== undefined)?.result;
  for (;;) {
    if (signal.aborted) return { stopReason: "cancelled" };
    const s = script[step];
    if (!s) return { stopReason: "end_turn" };
    step++;
    if ("call" in s) {
      const id = `call_${step - 1}`;
      const args = s.args ?? {};
      const update = { toolCallId: id, title: titleOf(s.call), kind: "other", status: "pending", rawInput: args };
      const entry = { kind: "call", id, tool: s.call, args, status: "pending" };
      session.history.push(entry);
      save(session);
      await notify({ sessionUpdate: "tool_call", ...update });
      if (askMcp && !(await permitted(client, session, update))) {
        if (signal.aborted) return { stopReason: "cancelled" };
        entry.status = "failed";
        entry.result = "the client refused the call";
        lastResult = entry.result;
        save(session);
        await notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
        continue;
      }
      said({ type: "mcp", tool: s.call, toolCallId: id });
      let answer;
      try {
        answer = await session.mcp.request("tools/call", { name: s.call, arguments: args, _meta: { progressToken: id } }, signal);
      } catch (error) {
        entry.status = "failed";
        save(session);
        await notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
        if (signal.aborted) return { stopReason: "cancelled" };
        lastResult = String(error?.message ?? error);
        entry.result = lastResult;
        continue;
      }
      const result = (answer?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      entry.status = answer?.isError ? "failed" : "completed";
      entry.result = result;
      lastResult = result;
      save(session);
      await notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: entry.status, content: [{ type: "content", content: { type: "text", text: result } }] });
      continue;
    }
    if ("native" in s) {
      const id = `native_${step - 1}`;
      const update = { toolCallId: id, title: s.title ?? s.native, kind: s.native, status: "pending", rawInput: s.input ?? {} };
      const entry = { kind: "native", id, title: update.title, status: "pending" };
      session.history.push(entry);
      save(session);
      await notify({ sessionUpdate: "tool_call", ...update });
      const allowed = askNative.has(s.native) ? await permitted(client, session, update) : true;
      if (signal.aborted) return { stopReason: "cancelled" };
      if (allowed && config.nativeLog) appendFileSync(config.nativeLog, `${update.title}\n`);
      entry.status = allowed ? "completed" : "failed";
      entry.result = allowed ? `ran ${update.title}` : "the client refused the call";
      lastResult = entry.result;
      save(session);
      // Cursor reports a refused call completed: the client must never trust it.
      await notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: style === "cursor" ? "completed" : entry.status });
      continue;
    }
    let words;
    if ("say" in s) words = s.say;
    else if ("sayLastResult" in s) words = lastResult ?? "";
    else if ("sayLastSteer" in s) words = (notes.includes("[Recovery]") ? lastQuote(blocks.find((b) => b.includes("[Recovery]"))) : undefined) ?? said_;
    else words = "";
    session.history.push({ kind: "say", text: words });
    save(session);
    if (words) await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } });
    return { stopReason: s.cut ? "max_tokens" : "end_turn" };
  }
}

const app = agent({ name: "fake-acp" })
  .onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: config.advertiseLoad ?? loads,
      mcpCapabilities: { http: config.advertiseHttp ?? config.http ?? true, sse: false },
      ...(config.systemPrompt ? { sessionCapabilities: { systemPrompt: {} } } : {}),
    },
    agentInfo: { name: "fake-acp", version: "1.0.0" },
  }))
  .onRequest("session/new", async ({ params }) => {
    const id = `sess_${randomUUID()}`;
    const session = await openSession(id, params, []);
    save(session);
    said({ type: "new", sessionId: id, mcp: params.mcpServers.map((s) => s.type ?? "stdio"), system: session.system });
    return { sessionId: id };
  })
  .onRequest("session/load", async ({ params, client }) => {
    const file = join(store, `${params.sessionId}.json`);
    if (!loads || !existsSync(file)) throw RequestError.resourceNotFound(params.sessionId);
    const { history } = JSON.parse(readFileSync(file, "utf8"));
    const session = await openSession(params.sessionId, params, history);
    said({ type: "load", sessionId: params.sessionId, steps: steps(history) });
    // The history goes back to the client as it happened: a client keeps it off its timeline.
    for (const h of history) {
      if (h.kind === "user") await client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: h.text } } });
      if (h.kind === "say" && h.text) await client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: h.text } } });
      if (h.kind === "call" || h.kind === "native") {
        await client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "tool_call", toolCallId: h.id, title: h.kind === "call" ? titleOf(h.tool) : h.title, status: "pending", rawInput: h.args ?? {} } });
        await client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "tool_call_update", toolCallId: h.id, status: h.status === "pending" ? "failed" : h.status } });
      }
    }
    return {};
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw RequestError.resourceNotFound(params.sessionId);
    const controller = new AbortController();
    session.turn = controller;
    said({ type: "prompt", sessionId: session.id, text: text(params.prompt) });
    try {
      return await takeTurn(client, session, params.prompt, controller.signal);
    } finally {
      session.turn = undefined;
    }
  })
  .onNotification("session/cancel", ({ params }) => {
    said({ type: "cancel", sessionId: params.sessionId });
    sessions.get(params.sessionId)?.turn?.abort(new Error("cancelled"));
  });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
for (const session of sessions.values()) session.mcp?.close();
process.exit(0);
