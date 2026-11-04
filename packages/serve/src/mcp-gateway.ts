// A run's remote MCP servers, in the run's process: the one place every harness's MCP call goes through. pi calls it
// in-process, as the tools it binds for each granted `mcp:<server>/<tool>` (mcpRegistrations); a harness with its own
// MCP client calls it through the session proxy's /mcp/<server> (@parcha/agentrun-kernel/host mcpRoute).
//  - What a run may call is pinned at its first launch (runs.ts writes MCP_PIN in the run's directory): each granted
//    tool as the server listed it when its owner saved it, and the server's URL then. A later refresh of the server
//    never changes a running agent's tools.
//  - Its credentials come over the run's secrets pipe (secrets.ts mcpCredentials), only for the servers it grants, with
//    each server's URL now: one whose URL is not the pinned one is never sent anything, and the credential the pipe
//    holds for a moved server is none.
//  - One upstream client per server (the official SDK), connected at its first call; no redirect is followed, so a
//    credential goes nowhere but the pinned URL, and an answer past MAX_RESPONSE is cut off.
//  - A call is never sent twice: each harness records its intent before it reaches here (pi-durable's tool intent,
//    Claude's PreToolUse), and one a crash cut off is answered interrupted there. An aborted call aborts upstream.
//  - Every failure is a result the model reads, naming the server and never a header.
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { McpCallResult, McpTool, SessionMcp } from "@parcha/agentrun-kernel";
import { wireName } from "./catalog.js";
import { forModel } from "./result.js";
import { writeInWork } from "./workspace.js";

/** The run's pinned MCP tools, in its directory: written once, at its first launch. */
export const MCP_PIN = "mcp-tools.json";
/** A catalog name of an MCP tool: `mcp:<server>/<tool>`. A server name has no `_`, so `mcp__<server>__<tool>` splits one way. */
export const MCP_NAME = /^mcp:([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9_-]{1,64})$/;
/** The longest answer the model reads whole; the rest is filed in the run's work/ (monid's rule). */
export const MCP_CLIP = 60_000;
/** The most of one upstream answer read. */
export const MAX_RESPONSE = 4 * 1024 * 1024;
/** The longest one upstream call may take, and its first connection. */
export const CALL_MS = 120_000;
export const CONNECT_MS = 30_000;

/** Each pinned server: its URL then, and the granted tools as it listed them. */
export type McpPin = Record<string, { url: string; tools: McpTool[] }>;
/** The pipe's entry: each granted server's URL now, and its credential's headers when that URL is the pinned one. */
export type McpCredentials = Record<string, { url: string; headers?: Record<string, string> }>;

/** The servers saved on this server (mcp-servers.ts), as a launch reads them. */
export interface McpServerSource {
  server(name: string): { url: string; tools: readonly McpTool[] } | undefined;
  /** The server's credential, opened now: its headers, or undefined when it has none or it does not open. */
  headers(name: string): Record<string, string> | undefined;
}

/** `mcp:<server>/<tool>` read, or undefined for a name that is not one. */
export const mcpNameOf = (name: string): { server: string; tool: string } | undefined => {
  const match = MCP_NAME.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
};

/** The pin of a run granted `names`: each MCP tool among them that its server's snapshot holds. Keyed by server name
 *  with no prototype, as every map of names here is: a server named `constructor` is a server like any other. */
export function mcpPinOf(names: readonly string[], source: McpServerSource): McpPin {
  const pin: McpPin = Object.create(null);
  for (const name of names) {
    const parsed = mcpNameOf(name);
    const saved = parsed && source.server(parsed.server);
    const tool = saved?.tools.find((t) => t.name === parsed!.tool);
    if (!parsed || !saved || !tool) continue;
    if (!Object.hasOwn(pin, parsed.server)) pin[parsed.server] = { url: saved.url, tools: [] };
    pin[parsed.server]!.tools.push(tool);
  }
  return pin;
}

/** What a launch hands the run for its pin: each pinned server's URL now, with its headers only when it has not moved. A
 *  server no longer saved is absent. */
export function mcpCredentialsOf(pin: McpPin, source: McpServerSource): McpCredentials {
  const out: McpCredentials = Object.create(null);
  for (const [name, pinned] of Object.entries(pin)) {
    const saved = source.server(name);
    if (!saved) continue;
    const headers = saved.url === pinned.url ? source.headers(name) : undefined;
    out[name] = { url: saved.url, ...(headers ? { headers } : {}) };
  }
  return out;
}

const said = (text: string, isError = false): McpCallResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** `text` with every credential value in it replaced, with or without its `Bearer `: an upstream answer or error that
 *  echoes a header never shows it to the model, the harness or the run's files. */
const scrub = (text: string, headers: Record<string, string>) =>
  Object.values(headers).flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")]).sort((a, b) => b.length - a.length).reduce((out, value) => (value.length >= 8 ? out.split(value).join("[redacted]") : out), text);

/** `work` until `signal` aborts: a connection shared by calls is never held by one that stopped. */
const until = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });

export interface McpGatewayOptions {
  pin: McpPin;
  credentials: McpCredentials;
  /** The run's work/, where an answer too long for the model is filed. */
  work: () => string;
  /** For tests: the fetch the upstream client sends with. */
  fetch?: typeof fetch;
}

export type McpGateway = SessionMcp;

export function mcpGateway(options: McpGatewayOptions): McpGateway {
  type Upstream = { callTool(params: unknown, options: unknown): Promise<unknown> };
  const clients = new Map<string, Promise<Upstream>>();
  const pins = new Map(Object.entries(options.pin));
  const credentials = new Map(Object.entries(options.credentials));
  /** Each server's last HTTP status, which tells a refused credential from another failure. */
  const statuses = new Map<string, { last?: number }>();
  const send = options.fetch ?? fetch;

  /** The fetch one server's client sends with: its credential added, no redirect followed, at most MAX_RESPONSE read. */
  const guarded = (headers: Record<string, string>, status: { last?: number }) => async (input: string | URL | Request, init: RequestInit = {}) => {
    const sent = new Headers(init.headers);
    for (const [name, value] of Object.entries(headers)) sent.set(name, value);
    const response = await send(input, { ...init, headers: sent, redirect: "manual" });
    status.last = response.status;
    if (response.status >= 300 && response.status < 400) throw new Error(`it answered a redirect (HTTP ${response.status}), which is never followed`);
    if (!response.body) return response;
    let read = 0;
    const capped = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        read += chunk.byteLength;
        if (read > MAX_RESPONSE) controller.error(new Error(`its answer is longer than ${MAX_RESPONSE} bytes`));
        else controller.enqueue(chunk);
      },
    }));
    return new Response(capped, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  const connect = (server: string, url: string, headers: Record<string, string>): Promise<Upstream> => {
    let upstream = clients.get(server);
    if (!upstream) {
      const status: { last?: number } = {};
      statuses.set(server, status);
      upstream = (async () => {
        const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
        const client = new Client({ name: "agentrun", version: "1.0.0" }, { capabilities: {} });
        await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: guarded(headers, status) as never }), { timeout: CONNECT_MS });
        return client as unknown as Upstream;
      })();
      clients.set(server, upstream);
      // A server that did not connect is tried again at the next call.
      upstream.catch(() => clients.delete(server));
    }
    return upstream;
  };

  /** The model's text of `result`: its text blocks joined, its structured content when it has no text; past MCP_CLIP, or
   *  with blocks that are not text, the whole result is filed under work/evidence/mcp/<server>/ and the text says where. */
  const textOf = async (server: string, tool: string, result: Record<string, unknown>, headers: Record<string, string>): Promise<string> => {
    const blocks = Array.isArray(result.content) ? (result.content as { type?: unknown; text?: unknown }[]) : [];
    const texts = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text as string);
    let text = scrub(texts.join("\n\n"), headers);
    if (!text && result.structuredContent !== undefined) text = scrub(JSON.stringify(result.structuredContent), headers);
    const other = blocks.length - texts.length;
    if (text.length <= MCP_CLIP && other === 0) return text;
    const name = `${tool}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
    const head = text.length > MCP_CLIP ? `${text.slice(0, MCP_CLIP)}\n[cut at ${MCP_CLIP} of ${text.length} characters; ` : `${text}\n[${other} block${other > 1 ? "s" : ""} that ${other > 1 ? "are" : "is"} not text; `;
    try {
      await writeInWork(options.work(), ["evidence", "mcp", server], name, scrub(JSON.stringify(result), headers)).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" || !(await lstat(join(options.work(), "evidence", "mcp", server, name)).then((held) => held.isFile(), () => false))) throw error;
      });
    } catch (error) {
      return `${head}the whole answer could not be saved (${(error as NodeJS.ErrnoException)?.code ?? "write failed"})]`;
    }
    return `${head}the whole answer is in the run's files at evidence/mcp/${server}/${name}]`;
  };

  /** The call itself, to a server whose address is the pinned one. A gate's decision or a paid call's hold goes around
   *  it, in `call` below: the one place every harness's call passes before anything is sent. */
  const forward = async (server: string, url: string, headers: Record<string, string>, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> => {
    try {
      const upstream = await until(connect(server, url, headers), signal);
      const result = (await upstream.callTool({ name: tool, arguments: args }, { signal, timeout: CALL_MS })) as Record<string, unknown>;
      return said(await textOf(server, tool, result, headers), result.isError === true);
    } catch (error) {
      if (signal.aborted) return said(`The call to the MCP server ${server} was stopped.`, true);
      // The next call connects again (a server that dropped its session, say); this one is never sent again.
      clients.delete(server);
      const status = statuses.get(server)?.last;
      if (status === 401 || status === 403) return said(`The MCP server ${server} refused its credential; update it in Settings → MCP servers.`, true);
      const why = scrub(String((error as Error)?.message ?? error), headers).slice(0, 300);
      return said(`The MCP server ${server} failed${status && status >= 400 ? ` (HTTP ${status})` : ""}: ${why}`, true);
    }
  };

  return {
    servers: [...pins].map(([name, pinned]) => ({ name, tools: pinned.tools })),
    async call(server, tool, args, { signal }) {
      const pinned = pins.get(server);
      if (!pinned?.tools.some((t) => t.name === tool)) return said(`${tool} is not a tool of the MCP server ${server} in this run.`, true);
      const now = credentials.get(server);
      if (!now) return said(`The MCP server ${server} is no longer saved on this server; nothing was sent.`, true);
      if (now.url !== pinned.url) return said(`The MCP server ${server}'s address changed since this run started; nothing was sent. Start a new run to use it at its new address.`, true);
      return forward(server, pinned.url, now.headers ?? {}, tool, args, signal);
    },
  };
}

/** pi's tools for the gateway's servers: each granted tool under its wire name (`mcp__<server>__<tool>`), with the pinned
 *  description and schema, never run again after a crash. */
export function mcpRegistrations(gateway: McpGateway): ToolRegistration[] {
  return gateway.servers.flatMap((server) =>
    server.tools.map((tool) =>
      defineTool({
        name: wireName(`mcp:${server.name}/${tool.name}`),
        description: tool.description || tool.title || `${tool.name}, a tool of the MCP server ${server.name}.`,
        replay: "unsafe",
        parameters: tool.inputSchema as never,
        execute: async (args, _api, context) => {
          const result = await gateway.call(server.name, tool.name, (args ?? {}) as Record<string, unknown>, { signal: context?.abortSignal ?? new AbortController().signal });
          return forModel(result.content.map((block) => block.text).join("\n\n"), { isError: result.isError === true });
        },
      }) as unknown as ToolRegistration,
    ),
  );
}
