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
//          completed), or "goose-1.59" (as "goose", but titled as Goose 1.59.2 titles a call of an extension's tool:
//          `agentrun: <tool, its underscores as spaces>`), or "antigravity" (an MCP call as agy 1.5.14 announces and asks
//          about it: named `mcp_agentrun_<tool>`, titled `Run mcp_agentrun_<tool>`, its rawInput the call's arguments
//          with agy's own `toolSummary` beside them, which the MCP call itself never carries; options Allow and Deny);
//   titleSummary: with style "goose-1.59", the summary Goose 1.59.2 writes after such a title for a call whose
//                 arguments it summarizes (a path): `agentrun: <tool> · <titleSummary>`;
//   askMcp: ask permission before an MCP call (default: by style); askNative: the native kinds that ask;
//   nativeLog: a file each native call that runs appends its title to;
//   countFile: a file each event (new, load, prompt, cancel, mcp, permission) is appended to, one JSON line;
//   systemPrompt: advertise sessionCapabilities.systemPrompt;
//   ignoreCancel: log session/cancel and go on as if it never came (an agent that keeps spending);
//   keepMcpOnCancel: on session/cancel, answer the prompt `cancelled` at once and leave an MCP call in flight open;
//   announce: "late" (with style "cursor"): an MCP call as Cursor 2026.11.13 announces it, a tool_call titled
//             "MCP: tool" with no input, then a tool_call_update titled `agentrun: <tool>` whose rawInput is
//             {providerIdentifier, toolName, args}; its permission request is titled `agentrun-<tool>: <tool>`;
//   models: the models session/new and session/load list ({modelId, name}), the first current; session/set_model
//           takes one of them and refuses any other;
//   writeAuth: at session/new and session/load, write $HOME/.config/cursor/auth.json holding the sha256 of the
//              CURSOR_API_KEY it was handed (a credential derived from the key, as Cursor writes one); authFile: that
//              file's path in HOME instead. A write that fails (the path is a folder) is said on stderr and the session
//              goes on, as Cursor's does;
//   leak: {path, what}: at the same points, also write `path` (under HOME) holding what a release that saves its key
//         elsewhere would: "key" the CURSOR_API_KEY as is, "base64" it in base64, "token" a JWT-shaped token (made
//         here, no real one). For the key walk's red: a leak its guard must see;
//   failNew: at session/new, print these words on stderr and exit 1 (Cursor's own refusals, the team admin's switch);
//   cursorDirs: keep sessions and read the CLI config where Cursor 2026.11.13 does (cursor-config/dist/paths.js): its
//               config directory is $CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else $HOME/.cursor; sessions in
//               <dir>/acp-sessions, and an edit, write, delete or move refused unasked when <dir>/cli-config.json denies
//               Write(**) (Cursor reports it completed all the same).
//   tally: a file the takes of a `retitled` native step are counted in: a step {native, title, retitled: [t2, t3, ...]}
//          asks with its title the first time and with the next of `retitled` each time it is taken again (the last
//          one repeats), its input's command that title, as Cursor writes a new command after a restart.
//   auth: {methods, home, key, leak}: initialize lists the sign-in methods `methods` (ids); session/new and
//         session/load are refused (authRequired) until `authenticate` takes one. `home` {method, env, file}: that
//         method reads `file` in the folder the variable `env` names, the sign-in a person's own login left there, and
//         rewrites it as an agent refreshing its token does. `key` {method, env}: that method reads the key in the
//         variable `env`. `leak`: at session/new, say the token or key it signed in with: "exit" on stderr, then exit 1;
//         "answer" in the words of the error it answers, alive.
//   grow: {bytes}: at each save of a session, append `bytes` random bytes to <sessions>/store.db-wal and rewrite a
//         store.db-shm beside it: a store that grows each turn, as Cursor's SQLite WAL does.
//   holdInit: a file; while it exists, initialize is not answered, so the host can send this process nothing.
// A script step {hang: true} is a model that never answers (until a cancel the agent heeds).
// The step the model takes is the number it took before: its session's history (calls, native calls, answers), plus the
// calls a recovery or context note names that its history does not hold, as a resumed model reads its conversation.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
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
/** Cursor's config directory, by its own rule (cursorDirs). */
const cursorDir = process.env.CURSOR_CONFIG_DIR?.trim() || (process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME, "cursor") : join(home, ".cursor"));
const store = config.cursorDirs ? join(cursorDir, "acp-sessions") : join(home, ".fake-acp", "sessions");
/** Whether Cursor's CLI config, where Cursor reads it, denies every Write (read at start, as Cursor reads it). */
const deniesWrite = (() => {
  if (!config.cursorDirs) return false;
  try {
    return JSON.parse(readFileSync(join(cursorDir, "cli-config.json"), "utf8")).permissions?.deny?.includes("Write(**)") === true;
  } catch {
    return false;
  }
})();
const EDITS = new Set(["edit", "delete", "move"]);

const said = (event) => config.countFile && appendFileSync(config.countFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`);
const save = (session) => {
  if (!loads) return;
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${session.id}.json`), JSON.stringify({ id: session.id, history: session.history }));
  if (config.grow) {
    // A store that grows by appending, as SQLite's WAL does: `bytes` more at each save, and its shared-memory index
    // rewritten beside it.
    const wal = join(store, "store.db-wal");
    appendFileSync(wal, randomBytes(config.grow.bytes));
    writeFileSync(join(store, "store.db-shm"), randomBytes(32 * 1024));
  }
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
said({ type: "start", env: Object.keys(process.env).sort(), home, cwd: process.cwd(), pgid, ...(config.cursorDirs ? { cursorDir, deniesWrite } : {}) });
const titleOf = (tool) => (style === "cursor" ? `agentrun-${tool}: ${tool}` : style === "antigravity" ? `Run mcp_agentrun_${tool}` : style === "goose-1.59" ? `agentrun: ${tool.replace(/_/g, " ")}${config.titleSummary ? ` · ${config.titleSummary}` : ""}` : `agentrun__${tool}`);
const late = style === "cursor" && config.announce === "late";
const models = config.models ? { currentModelId: config.models[0].modelId, availableModels: config.models } : undefined;
/** The credential Cursor derives from its key, in its private HOME: here the key's sha256, never the key. */
function writeAuth() {
  if (config.leak) {
    const key = process.env.CURSOR_API_KEY ?? "";
    const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const held = { key, base64: Buffer.from(key).toString("base64"), token: `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "fake", exp: 4102444800 })}.${part({ fake: "signature" })}` }[config.leak.what];
    const file = join(home, config.leak.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ held }));
  }
  if (!config.writeAuth) return;
  const file = join(home, config.authFile ?? ".config/cursor/auth.json");
  mkdirSync(dirname(file), { recursive: true });
  const keySha = createHash("sha256").update(process.env.CURSOR_API_KEY ?? "").digest("hex");
  try {
    writeFileSync(file, JSON.stringify({ keySha }));
  } catch (error) {
    // As Cursor 2026.11.13 does (src/utils/credential-persistence.ts): a credential it cannot save is said on stderr, and
    // the session goes on with the one it holds in memory.
    process.stderr.write(`\u001b[33m⚠ Cursor couldn't save your credentials. This session continues with the credentials it already has.\u001b[0m\nError: ${error.code}: illegal operation on a directory, open '${file}'\n`);
    said({ type: "auth", file, keySha, saved: false, code: error.code });
    return;
  }
  said({ type: "auth", file, keySha, saved: true });
}
const steps = (history) => history.filter((h) => h.kind === "call" || h.kind === "native" || h.kind === "say").length;
/** How many times script step `index` was taken before, across this agent's processes (config.tally, a file each take
 *  appends its index to); this take is added. */
function tally(index) {
  if (!config.tally) throw new Error("fake-acp: a retitled step needs config.tally");
  const before = existsSync(config.tally) ? readFileSync(config.tally, "utf8").split("\n").filter((line) => line === String(index)).length : 0;
  appendFileSync(config.tally, `${index}\n`);
  return before;
}
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
    : style === "antigravity"
    ? [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]
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
      const update = style === "antigravity"
        ? { toolCallId: id, name: `mcp_agentrun_${s.call}`, title: titleOf(s.call), kind: "other", status: "pending", rawInput: { ...args, toolSummary: `Call ${s.call}` }, args: { ...args, toolSummary: `Call ${s.call}` } }
        : { toolCallId: id, title: titleOf(s.call), kind: "other", status: "pending", rawInput: args };
      const entry = { kind: "call", id, tool: s.call, args, status: "pending" };
      session.history.push(entry);
      save(session);
      if (late) {
        // Cursor 2026.11.13: the call is announced with no name, then named by an update, then asked about by its own title.
        await notify({ sessionUpdate: "tool_call", toolCallId: id, title: "MCP: tool", kind: "other", status: "pending", rawInput: {} });
        await notify({ sessionUpdate: "tool_call_update", toolCallId: id, title: `agentrun: ${s.call}`, rawInput: { providerIdentifier: "agentrun", toolName: s.call, args } });
        await notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
      } else await notify({ sessionUpdate: "tool_call", ...update });
      if (askMcp && !(await permitted(client, session, late ? { toolCallId: id, title: titleOf(s.call), kind: "other", status: "pending" } : update))) {
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
        if (config.keepMcpOnCancel) {
          // The prompt's answer does not wait for the call: a cancel ends the turn with the MCP request still open.
          const call = session.mcp.request("tools/call", { name: s.call, arguments: args, _meta: { progressToken: id } });
          call.catch(() => {});
          const cancelled = new Promise((resolve) => (signal.aborted ? resolve("cancelled") : signal.addEventListener("abort", () => resolve("cancelled"), { once: true })));
          answer = await Promise.race([call, cancelled]);
          if (answer === "cancelled") return { stopReason: "cancelled" };
        } else answer = await session.mcp.request("tools/call", { name: s.call, arguments: args, _meta: { progressToken: id } }, signal);
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
      // A model that, taking a step again (after a restart), writes another command for it (retitled).
      const again = s.retitled?.length ? tally(step - 1) : 0;
      const title = again > 0 ? s.retitled[Math.min(again, s.retitled.length) - 1] : (s.title ?? s.native);
      const update = { toolCallId: id, title, kind: s.native, status: "pending", rawInput: again > 0 ? { ...(s.input ?? {}), command: title } : (s.input ?? {}) };
      const entry = { kind: "native", id, title: update.title, status: "pending" };
      session.history.push(entry);
      save(session);
      // {announce: false}: a permission request for a call no tool_call announced.
      if (s.announce !== false) await notify({ sessionUpdate: "tool_call", ...update });
      const allowed = deniesWrite && EDITS.has(s.native) ? false : askNative.has(s.native) ? await permitted(client, session, update) : true;
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
    if ("die" in s) {
      // Killed mid-turn (SIGKILL), as a host's kill takes it: no answer, no exit of its own.
      said({ type: "die" });
      process.kill(process.pid, "SIGKILL");
    }
    if ("hang" in s) {
      said({ type: "hang" });
      await new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true })));
      return { stopReason: "cancelled" };
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

/** What `authenticate` signed in with (auth): the token's or the key's text; undefined before. */
let signedIn;
/** Refuses a session before the sign-in, where the config signs in; says it, where the config leaks it. */
const needsSignIn = () => {
  if (!config.auth) return;
  if (signedIn === undefined) throw RequestError.authRequired();
  if (config.auth.leak === "exit") {
    process.stderr.write(`fake-acp: the vendor refused the sign-in ${signedIn}\n`);
    process.exit(1);
  }
  if (config.auth.leak === "answer") throw RequestError.internalError(undefined, `the vendor refused the sign-in ${signedIn}`);
};
/** The sign-in `methodId` reads, or undefined when it has none. */
const signInWith = (methodId) => {
  const { home: login, key } = config.auth ?? {};
  if (login && methodId === login.method) {
    const file = process.env[login.env] ? join(process.env[login.env], login.file) : undefined;
    if (!file || !existsSync(file)) return undefined;
    const text = readFileSync(file, "utf8");
    writeFileSync(file, `${text.trim()}\n`);
    return text.trim();
  }
  if (key && methodId === key.method) return process.env[key.env] || undefined;
  return undefined;
};

const app = agent({ name: "fake-acp" })
  .onRequest("initialize", async () => {
    while (config.holdInit && existsSync(config.holdInit)) await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: config.advertiseLoad ?? loads,
        mcpCapabilities: { http: config.advertiseHttp ?? config.http ?? true, sse: false },
        ...(config.systemPrompt ? { sessionCapabilities: { systemPrompt: {} } } : {}),
      },
      agentInfo: { name: "fake-acp", version: "1.0.0" },
      authMethods: (config.auth?.methods ?? []).map((id) => ({ id, name: id })),
    };
  })
  .onRequest("authenticate", ({ params }) => {
    const text = signInWith(params.methodId);
    if (text === undefined) throw RequestError.authRequired({ methodId: params.methodId });
    said({ type: "authenticate", methodId: params.methodId, sha: createHash("sha256").update(text).digest("hex") });
    signedIn = text;
    return {};
  })
  .onRequest("session/new", async ({ params }) => {
    needsSignIn();
    if (config.failNew) {
      process.stderr.write(`${config.failNew}\n`);
      process.exit(1);
    }
    const id = `sess_${randomUUID()}`;
    const session = await openSession(id, params, []);
    save(session);
    writeAuth();
    said({ type: "new", sessionId: id, mcp: params.mcpServers.map((s) => s.type ?? "stdio"), system: session.system });
    return { sessionId: id, ...(models ? { models } : {}) };
  })
  // Not in the SDK's stable methods: Cursor's own (unstable ACP) method, so its params are taken as they come.
  .onRequest("session/set_model", (params) => params ?? {}, async ({ params }) => {
    if (!models?.availableModels.some((m) => m.modelId === params.modelId)) throw RequestError.invalidParams({ modelId: params.modelId });
    said({ type: "set_model", sessionId: params.sessionId, modelId: params.modelId });
    return {};
  })
  .onRequest("session/load", async ({ params, client }) => {
    needsSignIn();
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
    writeAuth();
    return models ? { models } : {};
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
    if (!config.ignoreCancel) sessions.get(params.sessionId)?.turn?.abort(new Error("cancelled"));
  });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
for (const session of sessions.values()) session.mcp?.close();
process.exit(0);
