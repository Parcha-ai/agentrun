// The MCP endpoint, POST /v2/mcp: the Model Context Protocol over Streamable HTTP, one JSON-RPC message per POST,
// answered as JSON (no server-sent stream, no session). Its tools are the /v2 routes themselves: a call is dispatched in
// process to the route that serves it, with the caller's token, so a tool checks and answers exactly as that route does.
// The endpoint takes the token only, never the page's cookie, and refuses a browser Origin other than this server's own
// (the transport's rule against DNS rebinding; on loopback the Host check comes first, in server.ts).
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { homeBusy, storeBusy } from "./agents.js";
import { ApiError } from "./errors.js";
import { isJson, ownOrigin } from "./page.js";
import { isObject, type Json } from "./validate.js";

export const MCP_PATH = "/v2/mcp";
/** The protocol versions this endpoint speaks, newest first. `initialize` answers the client's when it is one of them. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1 << 20;
/** The most a tool's answer (a file's bytes included) may hold; past it, the tool says where to read it instead. */
export const MAX_ANSWER = 4 << 20;

/** A route of this server: server.ts's `route`, which throws ApiError for a refusal. */
export type Route = (req: IncomingMessage, res: ServerResponse, url: URL, path: string) => Promise<void>;
type Call = { method: "GET" | "POST"; path: string; query?: Json; body?: Json; headers?: Record<string, string> };
type Tool = { name: string; title: string; description: string; inputSchema: Json; annotations: Json; call: (args: Json) => Call };
/** A route's answer as it would have gone out. */
type Answered = { status: number; type: string; bytes: Buffer; tooBig: boolean };

class ParamsError extends Error {}
const text = (args: Json, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new ParamsError(`${name} is a non-empty string`);
  return value;
};
const optionalText = (args: Json, name: string): string | undefined => (args[name] === undefined ? undefined : text(args, name));
const id = encodeURIComponent;
const pick = (args: Json, keys: string[]): Json => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
const without = (args: Json, keys: string[]): Json => Object.fromEntries(Object.entries(args).filter(([k]) => !keys.includes(k)));
const keyed = (args: Json): Record<string, string> => {
  const key = optionalText(args, "idempotency_key");
  return key === undefined ? {} : { "idempotency-key": key };
};

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const AGENT_ID = { type: "string", description: "The agent's id." };
const RUN_ID = { type: "string", description: "The run's id." };
const PAGE = {
  cursor: { type: "string", description: "next_cursor from the page before." },
  limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (default 20)." },
};
const IDEMPOTENCY_KEY = { type: "string", description: "Optional. The same key with the same arguments answers with the first call's result, never a second write." };

/** Each tool, by the /v2 route it calls. */
export const TOOLS: Tool[] = [
  {
    name: "list_agents", title: "List agents", annotations: READ,
    description: "The agents on this server, a page at a time (GET /v2/agents): each one's id, kind (agentic or workflow), current revision and run counts.",
    inputSchema: { type: "object", properties: { archived: { type: "boolean", description: "true lists only archived agents." }, ...PAGE } },
    call: (args) => ({ method: "GET", path: "/agents", query: pick(args, ["archived", "cursor", "limit"]) }),
  },
  {
    name: "get_agent", title: "Get an agent", annotations: READ,
    description: "One agent with its current definition (GET /v2/agents/{agent_id}).",
    inputSchema: { type: "object", required: ["agent_id"], properties: { agent_id: AGENT_ID } },
    call: (args) => ({ method: "GET", path: `/agents/${id(text(args, "agent_id"))}` }),
  },
  {
    name: "create_agent", title: "Create an agent", annotations: WRITE,
    description:
      "Creates an agent with its first revision (POST /v2/agents), checked exactly as that route checks it: a refusal names each field. An agentic definition: {id, version: 1, name, instructions, tools: [], skills: []}, with optional description, model (provider/model-id; absent, the server's default), thinking (capabilities features.thinking) and harness (pi, claude-agent or codex). A workflow definition holds `workflow` (an agentrun-dsl document) in place of instructions. `warnings` in the answer is what this server still lacks to run it.",
    inputSchema: {
      type: "object", required: ["definition"],
      properties: {
        definition: { type: "object", description: "The definition: id, version, name, and instructions or workflow (see the description)." },
        skills: { type: "object", additionalProperties: { type: "string" }, description: "Skill files by path, `<skill>/SKILL.md` for each name in definition.skills, each its text." },
        note: { type: "string", description: "What this revision is, kept with it." },
      },
    },
    call: (args) => ({ method: "POST", path: "/agents", body: args }),
  },
  {
    name: "start_run", title: "Start a run", annotations: { ...WRITE, openWorldHint: true },
    description:
      "Starts a run of an agent's current revision, or of `revision` (POST /v2/agents/{agent_id}/runs). An agentic run's input is {content: \"the first message\"}; a workflow run's is what its workflow's input schema takes. Answers the run, queued: follow it with get_run or get_timeline.",
    inputSchema: {
      type: "object", required: ["agent_id", "input"],
      properties: {
        agent_id: AGENT_ID,
        input: { type: "object", description: "{content: string} for an agentic agent; the workflow's input for a workflow agent." },
        effort: { type: "string", enum: ["low", "medium", "high"], description: "Optional: how hard the model thinks. Absent, the revision's own." },
        revision: { type: "string", description: "Optional: a revision id of this agent to run in place of the current one." },
        max_cost_usd: { type: "number", exclusiveMinimum: 0, description: "Optional, agentic runs only: the run ends failed (spend_cap_reached) rather than pass this cost." },
        idempotency_key: IDEMPOTENCY_KEY,
      },
    },
    call: (args) => ({ method: "POST", path: `/agents/${id(text(args, "agent_id"))}/runs`, body: without(args, ["agent_id", "idempotency_key"]), headers: keyed(args) }),
  },
  {
    name: "list_runs", title: "List runs", annotations: READ,
    description: "Runs, newest first, a page at a time: one agent's (GET /v2/agents/{agent_id}/runs), or every agent's (GET /v2/runs).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { ...AGENT_ID, description: "Optional: only this agent's runs." },
        status: { type: "string", description: "Optional: only runs with this status (queued, working, input_required, completed, failed, cancelled, paused)." },
        archived: { type: "boolean", description: "true lists only archived runs." },
        ...PAGE,
      },
    },
    call: (args) => {
      const agent = optionalText(args, "agent_id");
      return { method: "GET", path: agent === undefined ? "/runs" : `/agents/${id(agent)}/runs`, query: pick(args, ["status", "archived", "cursor", "limit"]) };
    },
  },
  {
    name: "get_run", title: "Get a run", annotations: READ,
    description:
      "A run's status and result (GET /v2/runs/{run_id}). status is queued, working, input_required (it asked a question: answer it with send_message), completed, failed, cancelled or paused. A completed run's answer is result.final_answer (agentic) or result.output (workflow); a failed run's reason is error. cost.usd is null while unknown, never $0.",
    inputSchema: { type: "object", required: ["run_id"], properties: { run_id: RUN_ID } },
    call: (args) => ({ method: "GET", path: `/runs/${id(text(args, "run_id"))}` }),
  },
  {
    name: "get_timeline", title: "Read a run's timeline", annotations: READ,
    description:
      "A page of the run's timeline (GET /v2/runs/{run_id}/timeline): its messages, thinking, tool calls and answer as rows. Start at after 0; each page's next_after is the next page's after. wait_ms holds the call up to that long (at most 25000) for a change. A page with final true and has_more false is the run's last.",
    inputSchema: {
      type: "object", required: ["run_id"],
      properties: {
        run_id: RUN_ID,
        after: { type: "integer", minimum: 0, description: "The change number to read from: 0, or next_after from the page before." },
        wait_ms: { type: "integer", minimum: 0, maximum: 25000, description: "Optional: wait up to this long for a change." },
      },
    },
    call: (args) => ({ method: "GET", path: `/runs/${id(text(args, "run_id"))}/timeline`, query: pick(args, ["after", "wait_ms"]) }),
  },
  {
    name: "list_run_files", title: "List a run's files", annotations: READ,
    description: "The files the run wrote in its workspace (GET /v2/runs/{run_id}/files): each one's path, size and type.",
    inputSchema: { type: "object", required: ["run_id"], properties: { run_id: RUN_ID } },
    call: (args) => ({ method: "GET", path: `/runs/${id(text(args, "run_id"))}/files` }),
  },
  {
    name: "read_run_file", title: "Read a run's file", annotations: READ,
    description: `One of the run's files (GET /v2/runs/{run_id}/files/{path}): text as text, an image as an image, anything else as a blob. A file over ${MAX_ANSWER >> 20} MiB is refused here; read it over HTTP.`,
    inputSchema: { type: "object", required: ["run_id", "path"], properties: { run_id: RUN_ID, path: { type: "string", description: "The file's path, as list_run_files gives it." } } },
    call: (args) => ({ method: "GET", path: `/runs/${id(text(args, "run_id"))}/files/${text(args, "path").split("/").map(id).join("/")}` }),
  },
  {
    name: "send_message", title: "Send a run a message", annotations: { ...WRITE, openWorldHint: true },
    description:
      "Sends an agentic run a message (POST /v2/runs/{run_id}/messages): the answer to the question it asked when its status is input_required, a steer while it works, or a follow-up once it completed. The answer's mode says which.",
    inputSchema: { type: "object", required: ["run_id", "content"], properties: { run_id: RUN_ID, content: { type: "string", description: "The message." }, idempotency_key: IDEMPOTENCY_KEY } },
    call: (args) => ({ method: "POST", path: `/runs/${id(text(args, "run_id"))}/messages`, body: without(args, ["run_id", "idempotency_key"]), headers: keyed(args) }),
  },
];

const INSTRUCTIONS =
  "Tools over this AgentRun server's agents and runs. To run an agent: create_agent (or list_agents for one that exists), then start_run, then get_run until its status is completed, failed or cancelled; input_required means it asked a question, which send_message answers. Read the answer from the run's result, its steps with get_timeline, and what it wrote with list_run_files and read_run_file.";

/** A route's answer as it would have gone out: its status, headers and bytes. A route that writes past `limit` is cut
 *  off there (`tooBig`): a file stream stops, and the tool says so. */
class Answer extends Writable {
  status = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  tooBig = false;
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
    this.size += chunk.length;
    if (this.size > this.limit) {
      this.tooBig = true;
      return next(new Error("over the answer limit"));
    }
    this.chunks.push(chunk);
    next();
  }
  answered(): Answered {
    return { status: this.status, type: (this.headers["content-type"] ?? "").split(";")[0]!.trim(), bytes: Buffer.concat(this.chunks), tooBig: this.tooBig };
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

  /** A tool's call, through the route that serves it, with the caller's own Authorization. */
  async function dispatch(call: Call, authorization: string, requestId: string): Promise<Answered> {
    const search = new URLSearchParams(Object.entries(call.query ?? {}).map(([k, v]) => [k, String(v)]));
    const target = `/v2${call.path}${search.size ? `?${search}` : ""}`;
    const body = call.body === undefined ? [] : [Buffer.from(JSON.stringify(call.body))];
    const headers = { authorization, accept: "application/json", ...(call.body === undefined ? {} : { "content-type": "application/json" }), ...call.headers };
    const req = Object.assign(Readable.from(body), { method: call.method, url: target, headers }) as unknown as IncomingMessage;
    const res = new Answer(MAX_ANSWER);
    try {
      await route(req, res as unknown as ServerResponse, new URL(target, "http://serve"), call.path);
      if (!res.writableEnded && !res.destroyed) throw new Error(`${call.method} ${target} gave no answer`);
      await res.settled;
    } catch (error) {
      const known = error instanceof ApiError ? error : storeBusy(error) ? homeBusy() : new ApiError("internal", (error as Error)?.message ?? String(error));
      if (!(error instanceof ApiError) && !storeBusy(error)) process.stderr.write(`agentrun-serve: mcp: ${(error as Error)?.stack ?? String(error)}\n`);
      return { status: known.status, type: "application/json", bytes: Buffer.from(JSON.stringify(known.body(requestId))), tooBig: false };
    }
    return res.answered();
  }

  /** A tool's result, from its route's answer: JSON as structured content (and as text, for a client without it), a
   *  refusal as an error result carrying the route's error envelope, a file as text, an image or a blob. */
  function resultOf(tool: Tool, answer: Answered, origin: string, call: Call): Json {
    const refused = answer.status >= 400;
    if (answer.tooBig) return { content: [{ type: "text", text: `The answer is over ${MAX_ANSWER >> 20} MiB: read it over HTTP, GET ${origin}/v2${call.path}.` }], isError: true };
    if (tool.name === "read_run_file" && !refused) {
      const mime = answer.type || "application/octet-stream";
      if (mime.startsWith("text/") || mime === "application/json" || mime === "application/x-ndjson") return { content: [{ type: "text", text: answer.bytes.toString("utf8") }] };
      if (mime.startsWith("image/")) return { content: [{ type: "image", data: answer.bytes.toString("base64"), mimeType: mime }] };
      return { content: [{ type: "resource", resource: { uri: `${origin}/v2${call.path}`, mimeType: mime, blob: answer.bytes.toString("base64") } }] };
    }
    if (!answer.bytes.length) return { content: [{ type: "text", text: `Done (${answer.status}).` }], ...(refused ? { isError: true } : {}) };
    const json = JSON.parse(answer.bytes.toString("utf8")) as unknown;
    return { content: [{ type: "text", text: JSON.stringify(json) }], ...(isObject(json) ? { structuredContent: json } : {}), ...(refused ? { isError: true } : {}) };
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
        return { result: { tools: TOOLS.map(({ call: _call, ...tool }) => tool) } };
      case "tools/call": {
        if (!isObject(params) || typeof params.name !== "string") return { error: { code: -32602, message: "tools/call takes {name, arguments}" } };
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return { error: { code: -32602, message: `no tool ${params.name}: tools/list names them` } };
        if (params.arguments !== undefined && !isObject(params.arguments)) return { error: { code: -32602, message: "arguments is an object" } };
        let call: Call;
        try {
          call = tool.call((params.arguments as Json | undefined) ?? {});
        } catch (error) {
          if (error instanceof ParamsError) return { error: { code: -32602, message: `${tool.name}: ${error.message}` } };
          throw error;
        }
        const answer = await dispatch(call, String(req.headers.authorization), requestId);
        return { result: resultOf(tool, answer, ownOrigin(req), call) };
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
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (!("method" in message)) {
      // A response to a request of ours (this server sends none): taken, with no body, when it is one.
      if (!("id" in message) || ("result" in message) === ("error" in message)) return reply(res, 400, rpcError(id, -32600, "not a JSON-RPC request, notification or response"));
      return reply(res, 202);
    }
    if (typeof message.method !== "string") return reply(res, 400, rpcError(id, -32600, "method is a string"));
    // A notification: taken, with no body.
    if (!("id" in message)) return reply(res, 202);
    if (id === null) return reply(res, 400, rpcError(null, -32600, "a request's id is a string or a number"));
    const answered = await handle(message.method, message.params, req, requestId);
    return reply(res, 200, { jsonrpc: "2.0", id, ...answered });
  };
}
