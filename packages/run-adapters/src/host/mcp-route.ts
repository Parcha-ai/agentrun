// A session's remote MCP servers as the harness's own MCP client sees them: one Streamable HTTP endpoint per server,
// `/mcp/<server>` on the session's model proxy, behind the session's key (the proxy checks it before this runs). It is
// stateless and small: `initialize` is answered here (the client's protocol version echoed when it is one this speaks),
// `ping`, `tools/list` from the session's granted tools, and `tools/call` through the host (`SessionMcp.call`), answered
// as an SSE stream from its first byte with a keepalive, so a slow call never meets a client's first-byte timeout. Any
// other method, `server/discover` (the 2026-07-28 probe a client falls back from) among them, is -32601. A GET (a
// client's server-sent stream) is 405; a notification or a client's response, 202. A client that disconnects, or sends
// `notifications/cancelled`, aborts its call; a cancel of a call that already ended is ignored.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpCallResult, SessionMcp } from "../types.js";
import { parseStrict } from "./proxy.js";

/** The protocol revisions answered, newest first: a client asking for another gets the newest. */
export const MCP_ROUTE_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY = 4 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

type Id = string | number;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));

export interface McpRouteOptions {
  /** How often a call in flight sends a keepalive. Default 15 s. */
  keepaliveMs?: number;
  /** The `_meta` key of a `tools/call` that carries the harness's own id for the call (McpClient.callIdMeta); none, the
   *  call has no id. */
  callIdMeta?: string;
}

/** The handler a model proxy mounts at `/mcp/<server>` (ModelProxyOptions.mcp). */
export type McpHandler = (server: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function mcpRoute(mcp: SessionMcp, options: McpRouteOptions = {}): McpHandler {
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const servers = new Map(mcp.servers.map((server) => [server.name, server]));
  /** Calls in flight, by server and JSON-RPC id. */
  const running = new Map<string, AbortController>();
  const keyOf = (server: string, id: Id) => `${server}\0${typeof id}:${id}`;

  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? { "content-length": "0" } : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const failure = (id: Id | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  return async (server, req, res) => {
    const served = servers.get(server);
    if (!served) return json(res, 404, failure(null, -32601, `this session has no MCP server ${server}`));
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-length": "0" });
      return void res.end();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return json(res, 413, failure(null, -32600, "the request is too large"));
      chunks.push(chunk as Buffer);
    }
    let message: Message;
    try {
      const parsed = parseStrict(Buffer.concat(chunks).toString("utf8"));
      if (!isPlain(parsed)) return json(res, 400, failure(null, -32600, "one JSON-RPC message per request; no batches"));
      message = parsed;
    } catch {
      return json(res, 400, failure(null, -32700, "the body is not JSON"));
    }
    const params = isPlain(message.params) ? message.params : {};
    // A notification, or the client's answer to a request: nothing to say back.
    if (typeof message.method !== "string" || message.id === undefined) {
      if (message.method === "notifications/cancelled" && isId(params.requestId)) running.get(keyOf(server, params.requestId))?.abort();
      return json(res, 202);
    }
    if (!isId(message.id)) return json(res, 400, failure(null, -32600, "the request's id must be a string or an integer"));
    const id = message.id;
    const answer = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id, result });
    switch (message.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = typeof asked === "string" && MCP_ROUTE_VERSIONS.includes(asked) ? asked : MCP_ROUTE_VERSIONS[0];
        return answer({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: `agentrun-${server}`, version: "1.0.0" } });
      }
      case "ping":
        return answer({});
      case "tools/list":
        return answer({ tools: served.tools.map((tool) => ({ name: tool.name, ...(tool.title ? { title: tool.title } : {}), description: tool.description ?? "", inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}) })) });
      case "tools/call":
        return call(server, id, params, req, res);
      default:
        return json(res, 200, failure(id, -32601, `${String(message.method).slice(0, 64)} is not a method this server answers`));
    }
  };

  async function call(server: string, id: Id, params: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const meta = isPlain(params._meta) ? params._meta : {};
    const progressToken = isId(meta.progressToken) ? meta.progressToken : undefined;
    // The harness's own id for the call, under the key its adapter declared (McpClient.callIdMeta), and no other.
    const own = options.callIdMeta !== undefined && Object.hasOwn(meta, options.callIdMeta) ? meta[options.callIdMeta] : undefined;
    const callId = typeof own === "string" ? own : undefined;
    const stream = String(req.headers.accept ?? "").includes("text/event-stream");
    const controller = new AbortController();
    const key = keyOf(server, id);
    running.set(key, controller);
    // A client gone before the answer: its call is aborted, upstream too.
    res.once("close", () => { if (!res.writableFinished) controller.abort(); });
    const send = (body: unknown) => res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    let timer: NodeJS.Timeout | undefined;
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      let beat = 0;
      timer = setInterval(() => {
        beat += 1;
        if (progressToken === undefined) res.write(": keepalive\n\n");
        else send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: beat } });
      }, keepaliveMs);
    }
    let result: McpCallResult;
    try {
      const name = params.name;
      const args = isPlain(params.arguments) ? params.arguments : {};
      const granted = typeof name === "string" && servers.get(server)!.tools.some((tool) => tool.name === name);
      result = granted
        // The door calls the session's MCP (serve's gateway.call); its target is the tool plane's one invoke() (fix 2).
        ? await mcp.call(server, name as string, args, { signal: controller.signal, ...(callId ? { callId } : {}) })
        : { content: [{ type: "text", text: `${String(name).slice(0, 64)} is not a tool of the MCP server ${server} in this session.` }], isError: true };
    } catch (error) {
      result = { content: [{ type: "text", text: `The MCP server ${server}'s call failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` }], isError: true };
    } finally {
      clearInterval(timer);
      running.delete(key);
    }
    if (res.destroyed) return;
    // What the client reads of the answer: its content, and whether it failed (never the host's `parked`).
    const body = { jsonrpc: "2.0", id, result: { content: result.content, ...(result.isError ? { isError: true } : {}) } };
    if (!stream) return json(res, 200, body);
    send(body);
    res.end();
  }
}
