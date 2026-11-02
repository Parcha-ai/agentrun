// The MCP endpoint, POST /v2/mcp: the Model Context Protocol over Streamable HTTP in its simplest form, one JSON-RPC
// message per POST, answered as JSON, stateless (no stream, no session). Its tools run the /v2 routes themselves: a tool
// calls the route that serves it in process, with the caller's token, so it checks and answers exactly as that route
// does, and a route's refusal is the tool's error. A run is started, then polled: no tool holds its call open for a run.
// The endpoint takes the Bearer token only, never the page's cookie, and refuses a browser Origin other than this
// server's own (the transport's rule against DNS rebinding; on loopback the Host check comes first, in server.ts).
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { homeBusy, storeBusy } from "./agents.js";
import { ApiError, invalid } from "./errors.js";
import { isJson, ownOrigin } from "./page.js";
import { isObject, type Json } from "./validate.js";

export const MCP_PATH = "/v2/mcp";
/** The protocol versions this endpoint speaks, newest first. `initialize` answers the client's when it is one of them,
 *  else the newest, as the protocol's negotiation says. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1 << 20;
/** The most a route's answer may hold here; a file is read up to MAX_TEXT. */
const MAX_ANSWER = 4 << 20;
/** The most of a file `runs_files` returns as text: a client's tool output is short (Claude Code's is about 25k tokens). */
export const MAX_TEXT = 64 << 10;
/** `runs_events`' page when the caller names no limit: small enough for a client's tool output. */
const EVENTS_LIMIT = 100;

/** A route of this server: server.ts's `route`, which throws ApiError for a refusal. */
export type Route = (req: IncomingMessage, res: ServerResponse, url: URL, path: string) => Promise<void>;
type Call = { method: "GET" | "POST" | "PUT"; path: string; query?: Json; body?: Json; headers?: Record<string, string> };
/** A route's answer as it would have gone out. `tooBig`: cut off at the limit, `bytes` holding what came before. */
type Answered = { status: number; headers: Record<string, string>; bytes: Buffer; tooBig: boolean };
type Context = { call: (call: Call, limit?: number) => Promise<Answered>; origin: string; version: string; requestId: string };
type Tool = { name: string; title: string; description: string; inputSchema: Json; annotations: Json; run: (args: Json, context: Context) => Promise<Json> };

/** An argument the tool cannot take: answered as the routes answer a body they refuse (422, by field). */
class ArgumentError extends Error {
  constructor(readonly field: string, readonly reason: string, message: string) {
    super(message);
  }
}
const text = (args: Json, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new ArgumentError(name, value === undefined ? "missing" : "wrong_type", `${name} is a non-empty string`);
  return value;
};
const optionalText = (args: Json, name: string): string | undefined => (args[name] === undefined ? undefined : text(args, name));
const id = encodeURIComponent;
const pick = (args: Json, keys: string[]): Json => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
const without = (args: Json, keys: string[]): Json => Object.fromEntries(Object.entries(args).filter(([k]) => !keys.includes(k)));
const runLink = (origin: string, run: string) => `${origin}/console/#/runs/${id(run)}`;

/** A route's JSON answer as a tool's result: the body as structured content and, for a client without it, as text; a
 *  refusal (4xx, 5xx) as an error result holding the route's error envelope. `extra` is added to a body that is no
 *  refusal. */
function resultOf(answer: Answered, extra: Json = {}): Json {
  if (answer.tooBig) return { content: [{ type: "text", text: `The answer is over ${MAX_ANSWER >> 20} MiB.` }], isError: true };
  const refused = answer.status >= 400;
  const parsed = answer.bytes.length ? (JSON.parse(answer.bytes.toString("utf8")) as unknown) : {};
  const body = isObject(parsed) ? { ...parsed, ...(refused ? {} : extra) } : { value: parsed };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, ...(refused ? { isError: true } : {}) };
}
const json = (answer: Answered): Json => JSON.parse(answer.bytes.toString("utf8")) as Json;
/** A tool that is one route: its answer is the tool's. */
const routed = (build: (args: Json) => Call) => async (args: Json, context: Context) => resultOf(await context.call(build(args)));

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const AGENT_ID = { type: "string", description: "The agent's id." };
const RUN_ID = { type: "string", description: "The run's id." };
const DEFINITION = {
  instructions: { type: "string", description: "What the agent does and how: its system prompt." },
  harness: { type: "string", enum: ["pi", "claude-agent", "codex"], description: "What runs it (default pi). whoami says which this server runs." },
  model: { type: ["string", "null"], description: "provider/model-id. Absent, this server's default (whoami names it)." },
  thinking: { type: ["string", "null"], description: "How hard the model thinks: one of whoami's thinking levels. Absent, the model's own." },
  tools: { type: "array", items: { type: "string" }, description: "The tools it may use, by name (whoami lists them); [] for none. It writes files only with a tool like write." },
};

/** Each tool, by the /v2 routes it calls. Field names are the routes'. */
export const TOOLS: Tool[] = [
  {
    name: "whoami", title: "Check the connection", annotations: READ,
    description: "Checks the connection and the token, and says what this server runs: its version, its address and console, the harnesses, tools, efforts, thinking levels and default model it has (GET /v2/capabilities). Call it first.",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, context) => {
      const answer = await context.call({ method: "GET", path: "/capabilities" });
      if (answer.status >= 400) return resultOf(answer);
      const caps = json(answer) as { harnesses?: { id: string; available: boolean }[]; tools?: { name: string; available: boolean }[]; models?: Json; features?: { efforts?: string[]; thinking?: string[] } };
      const me = {
        authenticated: true, credential: "token", server: "agentrun-serve", version: context.version,
        base_url: `${context.origin}/v2`, console_url: `${context.origin}/console/`,
        harnesses: (caps.harnesses ?? []).filter((h) => h.available).map((h) => h.id),
        tools: (caps.tools ?? []).filter((t) => t.available).map((t) => t.name),
        efforts: caps.features?.efforts ?? [], thinking: caps.features?.thinking ?? [], models: caps.models ?? {},
      };
      return resultOf({ ...answer, bytes: Buffer.from(JSON.stringify(me)) });
    },
  },
  {
    name: "agents_list", title: "List agents", annotations: READ,
    description: "The agents on this server, 20 at a time (GET /v2/agents): each one's id, name, kind, current definition and run counts. next_cursor, when not null, is the next page's cursor.",
    inputSchema: { type: "object", properties: { cursor: { type: "string", description: "next_cursor from the page before." } } },
    run: routed((args) => ({ method: "GET", path: "/agents", query: pick(args, ["cursor"]) })),
  },
  {
    name: "agents_create", title: "Create an agent", annotations: WRITE,
    description: "Creates an agent (POST /v2/agents with these fields as its definition), checked as that route checks it: a refusal names each field. Ask the person before you create one. warnings in the answer is what this server still lacks to run it.",
    inputSchema: {
      type: "object", required: ["name", "instructions"],
      properties: {
        id: { type: "string", description: "Optional: the agent's id (letters, digits, . _ -); absent, the server makes one." },
        name: { type: "string", description: "The agent's name." },
        description: { type: "string", description: "Optional: one line on what it is for." },
        ...DEFINITION,
      },
    },
    run: routed((args) => ({ method: "POST", path: "/agents", body: { definition: args } })),
  },
  {
    name: "agents_revise", title: "Revise an agent", annotations: WRITE,
    description: "Makes the agent's next revision from its current definition with these fields changed (GET /v2/agents/{agent_id}, then PUT /v2/agents/{agent_id}/definition on that revision): fields you leave out stay; null clears model or thinking. Its next run runs the new revision. A revision saved in between is refused (precondition_failed), never overwritten. Its name and description stay as it was created.",
    inputSchema: { type: "object", required: ["agent_id"], properties: { agent_id: AGENT_ID, ...DEFINITION, note: { type: "string", description: "Optional: what this revision changes." } } },
    run: async (args, context) => {
      const agent = text(args, "agent_id");
      const read = await context.call({ method: "GET", path: `/agents/${id(agent)}` });
      if (read.status >= 400) return resultOf(read);
      const { agent_id: _agent, note, ...changes } = args;
      const merged: Json = { ...(json(read).definition as Json), ...changes };
      // The revision's number is the server's to give, and new instructions make an agentic revision.
      delete merged.version;
      if ("instructions" in changes) delete merged.workflow;
      for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
      const etag = read.headers.etag;
      return resultOf(await context.call({ method: "PUT", path: `/agents/${id(agent)}/definition`, body: { definition: merged, ...(note === undefined ? {} : { note }) }, headers: etag ? { "if-match": etag } : {} }));
    },
  },
  {
    name: "runs_start", title: "Start a run", annotations: { ...WRITE, openWorldHint: true },
    description: "Starts a run of the agent's current revision, or of `revision` (POST /v2/agents/{agent_id}/runs), and answers at once with the run, queued. Then call runs_get until its status is completed, failed or cancelled, or input_required (answer with runs_respond). An agentic run's input is {content: \"the first message\"}; a workflow run's is what its workflow's input schema takes.",
    inputSchema: {
      type: "object", required: ["agent_id", "input"],
      properties: {
        agent_id: AGENT_ID,
        input: { type: "object", description: "{content: string} for an agentic agent; the workflow's input for a workflow agent." },
        effort: { type: "string", enum: ["low", "medium", "high"], description: "Optional: how hard the model works on this run. Absent, the revision's own." },
        revision: { type: "string", description: "Optional: a revision id of this agent to run in place of the current one." },
      },
    },
    run: routed((args) => ({ method: "POST", path: `/agents/${id(text(args, "agent_id"))}/runs`, body: without(args, ["agent_id"]) })),
  },
  {
    name: "runs_get", title: "Get a run", annotations: READ,
    description: "A run's status and outcome (GET /v2/runs/{run_id}), with pending (the question it asked, while its status is input_required) and console_url (the run's page). status is queued, working, input_required, completed, failed, cancelled or paused. A completed run's answer is result.final_answer (agentic) or result.output (workflow); a failed run's reason is error; cost.usd is null while unknown, never $0.",
    inputSchema: { type: "object", required: ["run_id"], properties: { run_id: RUN_ID } },
    run: async (args, context) => {
      const run = text(args, "run_id");
      const answer = await context.call({ method: "GET", path: `/runs/${id(run)}` });
      if (answer.status >= 400) return resultOf(answer);
      const view = json(answer);
      return resultOf(answer, { pending: view.status === "input_required" && view.state === "waiting" ? await question(context, run) : null, console_url: runLink(context.origin, run) });
    },
  },
  {
    name: "runs_events", title: "Read a run's events", annotations: READ,
    description: `A page of the run's timeline (GET /v2/runs/{run_id}/timeline): its messages, thinking, tool calls and answer, as rows. Start with after 0; each page's next_after is the next page's after, and has_more says whether one waits. A page with final true and has_more false is the run's last. At most limit rows a page (default ${EVENTS_LIMIT}).`,
    inputSchema: {
      type: "object", required: ["run_id"],
      properties: {
        run_id: RUN_ID,
        after: { type: "integer", minimum: 0, description: "0, or next_after from the page before." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: `At most this many rows (default ${EVENTS_LIMIT}).` },
      },
    },
    run: routed((args) => ({ method: "GET", path: `/runs/${id(text(args, "run_id"))}/timeline`, query: { limit: EVENTS_LIMIT, ...pick(args, ["after", "limit"]) } })),
  },
  {
    name: "runs_files", title: "Read a run's files", annotations: READ,
    description: `What the run wrote. Without path, the list (GET /v2/runs/{run_id}/files): each file's path, size and type. With a path, that file (GET /v2/runs/{run_id}/files/{path}): its text, up to ${MAX_TEXT >> 10} KiB (truncated says when it is cut), or for a binary file its type, size and url.`,
    inputSchema: { type: "object", required: ["run_id"], properties: { run_id: RUN_ID, path: { type: "string", description: "Optional: a path from the list." } } },
    run: async (args, context) => {
      const run = text(args, "run_id");
      const path = optionalText(args, "path");
      if (path === undefined) return resultOf(await context.call({ method: "GET", path: `/runs/${id(run)}/files` }));
      const route = `/runs/${id(run)}/files/${path.split("/").map(id).join("/")}`;
      const answer = await context.call({ method: "GET", path: route }, MAX_TEXT);
      if (answer.status >= 400) return resultOf(answer);
      const type = (answer.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
      const size = Number(answer.headers["content-length"] ?? answer.bytes.length);
      const url = `${context.origin}/v2${route}`;
      const textual = type.startsWith("text/") || type === "application/json" || type === "application/x-ndjson";
      const file = { run_id: run, path, content_type: type, size_bytes: size, url, truncated: textual && answer.tooBig, text: textual ? answer.bytes.toString("utf8") : null };
      const shown = textual ? `${file.text}${file.truncated ? `\n\n[cut at ${MAX_TEXT >> 10} KiB of ${size} bytes: read the rest at ${url}]` : ""}` : `A ${type} file of ${size} bytes: download it from ${url} with the token.`;
      return { content: [{ type: "text", text: shown }], structuredContent: file };
    },
  },
  {
    name: "runs_respond", title: "Answer a run", annotations: { ...WRITE, openWorldHint: true },
    description: "Sends an agentic run a message (POST /v2/runs/{run_id}/messages): the answer to the question it asked (its status is input_required; runs_get's pending holds the question), or a follow-up once it completed. mode in the answer says which. Then poll runs_get again.",
    inputSchema: { type: "object", required: ["run_id", "content"], properties: { run_id: RUN_ID, content: { type: "string", description: "The answer, or the message." } } },
    run: routed((args) => ({ method: "POST", path: `/runs/${id(text(args, "run_id"))}/messages`, body: without(args, ["run_id"]) })),
  },
  {
    name: "runs_cancel", title: "Cancel a run", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Ends a run for good (POST /v2/runs/{run_id}/cancel): its status turns cancelled once its process has exited. It keeps what it did, and takes no more messages.",
    inputSchema: { type: "object", required: ["run_id"], properties: { run_id: RUN_ID } },
    run: routed((args) => ({ method: "POST", path: `/runs/${id(text(args, "run_id"))}/cancel` })),
  },
];

/** The question a waiting run asked: its timeline's last `waiting` row, read through the timeline route. */
async function question(context: Context, run: string): Promise<Json | null> {
  let asked: Json | null = null;
  for (let after = 0, pages = 0; pages < 50; pages++) {
    const answer = await context.call({ method: "GET", path: `/runs/${id(run)}/timeline`, query: { after } });
    if (answer.status >= 400) return null;
    const page = json(answer) as { rows: Json[]; has_more: boolean; next_after: number };
    for (const row of page.rows) if (row.kind === "waiting" && (asked === null || (row.seq as number) > (asked.seq as number))) asked = row;
    if (!page.has_more) break;
    after = page.next_after;
  }
  return asked && { question: asked.text ?? asked.summary, asked_at: asked.timestamp };
}

const INSTRUCTIONS =
  "Tools over this AgentRun server's agents and runs. Call whoami first. To run an agent: agents_list (or agents_create, after asking the person), then runs_start, then runs_get every few seconds until its status is completed, failed or cancelled. input_required means it asked a question (runs_get's pending): answer it with runs_respond, or leave it for the person in the console (console_url). Read its steps with runs_events and what it wrote with runs_files.";

/** A route's answer, captured: its status, headers and bytes up to `limit`. A route that writes past it is cut off
 *  there (`tooBig`): a file stream stops. */
class Answer extends Writable {
  status = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  private tooBig = false;
  private size = 0;
  private readonly chunks: Buffer[] = [];
  readonly settled: Promise<void>;
  constructor(private readonly limit: number) {
    super();
    this.settled = new Promise((done) => (this.once("finish", done), this.once("close", done)));
    // The cut-off is this stream's own error: whoever pipes into it sees it, and nothing else is told.
    this.on("error", () => undefined);
  }
  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.headersSent = true;
    return this;
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, next: (error?: Error | null) => void): void {
    const room = this.limit - this.size;
    this.size += chunk.length;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, Math.max(0, room)));
      this.tooBig = true;
      return next(new Error("over the answer limit"));
    }
    this.chunks.push(chunk);
    next();
  }
  answered(): Answered {
    return { status: this.status, headers: this.headers, bytes: Buffer.concat(this.chunks), tooBig: this.tooBig };
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** GET /llms.txt: what this server is, for a coding agent, without a credential. The text is the repository's
 *  `src/llms.txt`, copied beside the server by the build; it holds no data of this server's. */
export async function answerLlms(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError("method_not_allowed", `${req.method} is not a method of /llms.txt`, {}, { allow: "GET, HEAD" });
  const body = await readFile(new URL("./llms.txt", import.meta.url));
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": String(body.length), "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** The endpoint: `route` serves each tool, `authorized` checks an Authorization header against the token. */
export function mcpEndpoint({ route, authorized, authFailed, version }: { route: Route; authorized: (header: string) => boolean; authFailed: (route: string, reason: string) => void; version: string }) {
  function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  /** A route's answer to `call`, made with the caller's own Authorization: a synthetic request into `route`, and a
   *  response that captures what it writes. A refusal is the route's error envelope, as it would have gone out. */
  async function dispatch(call: Call, authorization: string, requestId: string, limit = MAX_ANSWER): Promise<Answered> {
    const search = new URLSearchParams(Object.entries(call.query ?? {}).map(([k, v]) => [k, String(v)]));
    const target = `/v2${call.path}${search.size ? `?${search}` : ""}`;
    const body = call.body === undefined ? [] : [Buffer.from(JSON.stringify(call.body))];
    const headers = { authorization, accept: "application/json", ...(call.body === undefined ? {} : { "content-type": "application/json" }), ...call.headers };
    const req = Object.assign(Readable.from(body), { method: call.method, url: target, headers }) as unknown as IncomingMessage;
    const res = new Answer(limit);
    try {
      await route(req, res as unknown as ServerResponse, new URL(target, "http://serve"), call.path);
      if (!res.writableEnded && !res.destroyed) throw new Error(`${call.method} ${target} gave no answer`);
      await res.settled;
    } catch (error) {
      const known = error instanceof ApiError ? error : storeBusy(error) ? homeBusy() : new ApiError("internal", (error as Error)?.message ?? String(error));
      if (!(error instanceof ApiError) && !storeBusy(error)) process.stderr.write(`agentrun-serve: mcp: ${(error as Error)?.stack ?? String(error)}\n`);
      return { status: known.status, headers: { "content-type": "application/json" }, bytes: Buffer.from(JSON.stringify(known.body(requestId))), tooBig: false };
    }
    return res.answered();
  }

  /** One JSON-RPC request's result, or its error. */
  async function handle(method: string, params: unknown, req: IncomingMessage, requestId: string): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    switch (method) {
      case "initialize": {
        const asked = isObject(params) ? params.protocolVersion : undefined;
        const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return { result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agentrun-serve", title: "AgentRun Server", version }, instructions: INSTRUCTIONS } };
      }
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: TOOLS.map(({ run: _run, ...tool }) => tool) } };
      case "tools/call": {
        if (!isObject(params) || typeof params.name !== "string") return { error: { code: -32602, message: "tools/call takes {name, arguments}" } };
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return { error: { code: -32602, message: `no tool ${params.name}: tools/list names them` } };
        const authorization = String(req.headers.authorization);
        const context: Context = { call: (call, limit) => dispatch(call, authorization, requestId, limit), origin: ownOrigin(req), version, requestId };
        try {
          if (params.arguments !== undefined && !isObject(params.arguments)) throw new ArgumentError("arguments", "wrong_type", "arguments is an object");
          return { result: await tool.run((params.arguments as Json | undefined) ?? {}, context) };
        } catch (error) {
          // An argument the tool cannot take is the tool's error, as the protocol asks, in the routes' own 422 shape.
          if (!(error instanceof ArgumentError)) throw error;
          const body = invalid([{ field: error.field, reason: error.reason, message: error.message }]).body(requestId);
          return { result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true } };
        }
      }
    }
    return { error: { code: -32601, message: `no method ${method} here: this server offers initialize, ping, tools/list and tools/call` } };
  }

  async function read(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= MAX_BODY) chunks.push(chunk as Buffer);
    }
    return size > MAX_BODY ? null : Buffer.concat(chunks);
  }

  return async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = String(res.getHeader("x-request-id") ?? "");
    const origin = req.headers.origin;
    if (origin !== undefined && origin.toLowerCase() !== ownOrigin(req)) return reply(res, 403, rpcError(null, -32600, "this Origin may not call this server's MCP endpoint"));
    // The token only: the page's session cookie is not taken here (server.ts answers this path before the page).
    const authorization = req.headers.authorization;
    if (authorization === undefined || !authorized(authorization)) {
      authFailed(MCP_PATH, authorization === undefined ? "no_credential" : "wrong_token");
      return reply(res, 401, rpcError(null, -32001, "the MCP endpoint needs Authorization: Bearer <the token in the data directory>"), { "www-authenticate": "Bearer" });
    }
    if (req.method !== "POST") return reply(res, 405, rpcError(null, -32600, "the MCP endpoint takes POST only: this server opens no stream and keeps no session"), { allow: "POST" });
    const asked = req.headers["mcp-protocol-version"];
    if (asked !== undefined && !PROTOCOL_VERSIONS.includes(String(asked))) return reply(res, 400, rpcError(null, -32600, `MCP-Protocol-Version ${asked} is not one this server speaks (${PROTOCOL_VERSIONS.join(", ")})`));
    if (!isJson(req)) return reply(res, 415, rpcError(null, -32600, "the body must be application/json"));
    const raw = await read(req);
    if (raw === null) return reply(res, 413, rpcError(null, -32600, `the body is over ${MAX_BODY} bytes`));
    let message: unknown;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(res, 400, rpcError(null, -32700, "the body is not JSON"));
    }
    if (Array.isArray(message)) return reply(res, 400, rpcError(null, -32600, "a batch is not taken: send one message per request"));
    if (!isObject(message) || message.jsonrpc !== "2.0") return reply(res, 400, rpcError(null, -32600, "not a JSON-RPC 2.0 message"));
    const rpcId = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (!("method" in message)) {
      // A response to a request of ours (this server sends none): taken, with no body, when it is one.
      if (!("id" in message) || ("result" in message) === ("error" in message)) return reply(res, 400, rpcError(rpcId, -32600, "not a JSON-RPC request, notification or response"));
      return reply(res, 202);
    }
    if (typeof message.method !== "string") return reply(res, 400, rpcError(rpcId, -32600, "method is a string"));
    // A notification: taken, with no body.
    if (!("id" in message)) return reply(res, 202);
    if (rpcId === null) return reply(res, 400, rpcError(null, -32600, "a request's id is a string or a number"));
    const answered = await handle(message.method, message.params, req, requestId);
    return reply(res, 200, { jsonrpc: "2.0", id: rpcId, ...answered });
  };
}
