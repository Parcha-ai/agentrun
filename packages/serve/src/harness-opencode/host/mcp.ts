// The session's host tools as an MCP server on the loopback interface, for OpenCode's MCP client. Written for AgentRun.
//
// OpenCode reaches a tool that is not its own only through MCP. The adapter turns every OpenCode tool off and gives it
// this one server, `hands`, so the model is offered exactly the host's tools, named `hands_<name>` (OpenCode names an MCP
// tool `<server>_<tool>`). The transport is MCP's streamable HTTP, the subset OpenCode's client uses:
//  - `POST /mcp` with one JSON-RPC message and the session's own key as a bearer token (compared in constant time):
//    `initialize`, `ping` and `tools/list` are answered as JSON, a notification gets 202, and `tools/call` is answered as
//    an event stream that carries a progress notification every `progressMs` while the call runs, then its result. A call
//    may wait on a person (`ask_person`) far longer than an MCP client's request timeout, and OpenCode's client resets
//    that timeout on each progress notification.
//  - `GET /mcp` (a stream of the server's own notifications, which this server never sends) is 405, as the
//    specification allows; any other path or method is 404.
// The server never runs a tool itself: `call` does, through the kernel's tool bridge, so each call is an effect whose
// intent is durable before it runs. A client that goes away before the answer aborts the call's signal.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { sameKey } from "@parcha/agentrun-kernel/host";

/** A tool as the MCP server lists it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A call's answer, as the bridge gives it. */
export interface McpAnswer {
  text: string;
  isError: boolean;
  images?: readonly { mimeType: string; data: string }[];
}

export interface McpServerOptions {
  tools: readonly McpTool[];
  /** The key OpenCode sends (`Authorization: Bearer <key>`). */
  key: string;
  /** Run one call: the host tool's own name, the arguments OpenCode sent, and a signal that aborts when the client goes. */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpAnswer>;
  /** How often a running call reports progress. Default 15 s. */
  progressMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface McpServer {
  /** The endpoint: `/mcp` on the loopback interface, on the port the system chose. */
  readonly url: string;
  /** Waits, at most `ms`, for the calls under way to settle (a host tool's own run, whatever became of its client):
   *  true when none is left. */
  settle(ms: number): Promise<boolean>;
  /** Stops the server: the calls under way are aborted, then waited for, at most CLOSE_SETTLE_MS, so none outlives the
   *  drive that started it unless it ignores its abort that long. */
  close(): Promise<void>;
}

/** How long close() waits for the calls it aborted to settle. */
export const CLOSE_SETTLE_MS = 5_000;

/** The MCP protocol versions this server speaks; a client's own is answered in kind when it is one of them. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 8 * 1024 * 1024;
/** Where the server listens and OpenCode connects to it: this machine only, on the port the system chose. */
const ADDRESS = "http://127.0.0.1/mcp"; // key-gate: loopback-rule the MCP server of the adapter listens here and OpenCode connects here, 127.0.0.1 only

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function json(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) return void res.writeHead(status).end();
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function bodyOf(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Start the server on the loopback interface, on a port of the system's choosing. */
export async function startMcpServer(options: McpServerOptions): Promise<McpServer> {
  if (!options.key) throw new Error("opencode: the MCP server needs the session's key");
  const tools = options.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const known = new Set(tools.map((t) => t.name));
  const progressMs = options.progressMs ?? 15_000;
  const open = new Set<AbortController>();
  // Each call's own run (options.call), until it settles: what settle() and close() wait for.
  const running = new Set<Promise<unknown>>();
  const settle = async (ms: number): Promise<boolean> => {
    if (running.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([Promise.allSettled([...running]).then(() => true), new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
    clearTimeout(timer);
    return done && running.size === 0;
  };
  let closed = false;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      options.log?.("opencode: the MCP server failed a request", { error: String((err as Error)?.message ?? err).slice(0, 200) });
      if (!res.headersSent) json(res, 500, error(null, -32603, "internal error"));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp") return json(res, 404);
    const auth = String(req.headers.authorization ?? "");
    if (!sameKey(auth.startsWith("Bearer ") ? auth.slice(7) : "", options.key)) return json(res, 401);
    if (req.method === "GET") return void res.writeHead(405, { allow: "POST" }).end();
    if (req.method === "DELETE") return json(res, 200);
    if (req.method !== "POST") return json(res, 404);
    if (closed) return json(res, 503);
    const text = await bodyOf(req);
    if (text === undefined) return json(res, 413, error(null, -32600, "the request is too large"));
    let message: Message;
    try {
      message = JSON.parse(text) as Message;
    } catch {
      return json(res, 400, error(null, -32700, "the body is not JSON"));
    }
    if (!isPlain(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      // A response or a batch: this server sends no requests and takes one message at a time.
      return json(res, 400, error(isPlain(message) ? message.id : null, -32600, "one JSON-RPC request or notification at a time"));
    }
    const { id, method } = message;
    const params = isPlain(message.params) ? message.params : {};
    if (id === undefined) return json(res, 202);
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = VERSIONS.includes(asked) ? asked : VERSIONS[1];
        return json(res, 200, { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "hands", version: "1" } } });
      }
      case "ping":
        return json(res, 200, { jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return json(res, 200, { jsonrpc: "2.0", id, result: { tools } });
      case "tools/call":
        return call(id, params, req, res);
      default:
        return json(res, 200, error(id, -32601, `no method ${method.slice(0, 80)}`));
    }
  }

  async function call(id: unknown, params: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const name = typeof params.name === "string" ? params.name : "";
    if (!known.has(name)) return json(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${name.slice(0, 80)}` }], isError: true } });
    const args = isPlain(params.arguments) ? params.arguments : {};
    const meta = isPlain(params._meta) ? params._meta : {};
    const token = typeof meta.progressToken === "string" || typeof meta.progressToken === "number" ? meta.progressToken : undefined;
    const controller = new AbortController();
    open.add(controller);
    // The client going away (its abort, its process ending) stops the call; a finished answer does not.
    let answered = false;
    res.on("close", () => {
      if (!answered) controller.abort(new Error("the MCP client went away before the answer"));
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (body: unknown) => res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    let progress = 0;
    const timer = token === undefined ? undefined : setInterval(() => {
      progress += 1;
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress } });
    }, progressMs);
    try {
      const work = options.call(name, args, controller.signal);
      running.add(work);
      void work.then(() => running.delete(work), () => running.delete(work));
      const answer = await work;
      const content: unknown[] = [{ type: "text", text: answer.text }, ...(answer.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))];
      answered = true;
      send({ jsonrpc: "2.0", id, result: { content, isError: answer.isError } });
    } catch (err) {
      answered = true;
      // The drive is stopping (an interrupt, a halt): the call has no answer the log holds, so none is given.
      send(error(id, -32603, String((err as Error)?.message ?? err).slice(0, 500)));
    } finally {
      if (timer) clearInterval(timer);
      open.delete(controller);
      res.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, new URL(ADDRESS).hostname, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("opencode: the MCP server has no port");
  const url = new URL(ADDRESS);
  url.port = String(address.port);
  return {
    url: url.href,
    settle,
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of open) controller.abort(new Error("the session's MCP server closed"));
      if (!(await settle(CLOSE_SETTLE_MS))) options.log?.("opencode: a host tool call was still running when the MCP server closed", { running: running.size });
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
