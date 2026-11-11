// A run's remote MCP servers: the one place every harness's MCP call goes through. A claimed run's spec builds one per
// claim from its MCP claim step (runner/mcp-run.ts mcpForClaim); pi calls it through the runner's host tools, and a
// harness with its own MCP client through the session proxy's /mcp/<server> (@parcha/agentrun-kernel/host mcpRoute).
//  - What a run may call is pinned (mcpPinOf): each granted tool as the server listed it when its owner saved it, and
//    the server's URL then. A later refresh of the server never changes a running agent's tools.
//  - Its credentials come from the claim step, only for the servers it grants, with each server's URL now, read at every
//    call and every request: one whose URL is not the pinned one is never sent anything.
//  - One upstream client per server (the official SDK), connected at its first call; no redirect is followed, so a
//    credential goes nowhere but the pinned URL, and an answer past MAX_RESPONSE is cut off.
//  - A call is never sent twice: each harness records its intent before it reaches here (pi-durable's tool intent,
//    Claude's PreToolUse), and one a crash cut off is answered interrupted there. An aborted call aborts upstream.
//  - Every failure is a result the model reads, naming the server and never a header.
//  - The runner's adapter loop gates every call before its intent (tool-gate.ts RunGate.decide), as
//    `mcp:<server>/<tool>`: a call that reaches here was allowed.
//  - A tool its owner priced (the server's `prices`) is held at that price on the run's one ledger and booked as the
//    run's tool cost (paid-calls.ts paidStep): refused unsent when the cap cannot take it, or when no ledger books it. A
//    tool with no price runs, marked "not metered" on the run's root (TOOL_UNMETERED), outside the run's cost.
import { randomUUID } from "node:crypto";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { McpCallResult, McpTool, SessionMcp } from "@parcha/agentrun-kernel";
import { TOOL_UNMETERED } from "@parcha/pi-durable-agent/timeline";
import { filedAnswer } from "./filed-answer.js";
import { paidLedger, paidStep } from "./paid-calls.js";
import { metaToolOf } from "./mcp-meta.js";
import { SIGN_IN_AGAIN } from "./mcp-oauth.js";
import { mcpToolName } from "./tool-gate.js";
import { type Workspace, workspaceAt, workspaceErrorWords } from "./workspace/index.js";

/** A catalog name of an MCP tool: `mcp:<server>/<tool>`. A server name has no `_`, so `mcp__<server>__<tool>` splits one way. */
export const MCP_NAME = /^mcp:([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9_-]{1,64})$/;
/** The longest answer the model reads whole; past it, the rest is filed in the run's work/ as lines read pages through
 *  (filed-answer.ts). Within the host's result bound (HOST_RESULT_MAX_CHARS), so every harness passes it whole. */
export const MCP_CLIP = 60_000;
/** The most of one upstream answer read. */
export const MAX_RESPONSE = 4 * 1024 * 1024;
/** The longest one upstream call may take, and its first connection. */
export const CALL_MS = 120_000;
export const CONNECT_MS = 30_000;

/** Each pinned server: its URL then, the granted tools as it listed them, and the prices its owner declared for them. */
export type McpPin = Record<string, { url: string; tools: McpTool[]; prices?: Record<string, number> }>;
/** Each granted server's URL now, and its credential's headers when that URL is the pinned one (the claim step's). */
export type McpCredentials = Record<string, { url: string; headers?: Record<string, string>; /** Why its saved credential did not open: its calls are refused unsent. */ unopened?: string; /** When its credential ends (ms): a token minted for the run's launch (a github_app server's), whose calls past it are refused unsent, in words. */ expires_at?: number }>;

/** The servers saved on this server, as a claim's pin reads them. */
export interface McpServerSource {
  server(name: string): { url: string; tools: readonly McpTool[]; prices?: Readonly<Record<string, number>> } | undefined;
}

/** `mcp:<server>/<tool>` read, or undefined for a name that is not one. */
export const mcpNameOf = (name: string): { server: string; tool: string } | undefined => {
  const match = MCP_NAME.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
};

/** The most schema nodes, and the deepest nesting, a tool's declarations are checked through: past either the tool is
 *  refused, never walked further. */
export const HEADER_SCAN_NODES = 10_000;
export const HEADER_SCAN_DEPTH = 64;
/** The keywords whose values are subschemas that `properties` alone does not reach, as the SDK client's check lists them
 *  (@modelcontextprotocol/client 2.4.0, NON_REACHABLE_SUBSCHEMA_KEYWORDS): a declaration under one is refused. Each
 *  holds a subschema or a list of them, but the OBJECT_VALUED ones, which map names to subschemas. */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set(["items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "patternProperties", "dependentSchemas", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$defs", "definitions"]);
const OBJECT_VALUED: ReadonlySet<string> = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);

/** Why a tool's `x-mcp-header` declarations (SEP-2243, the 2026-07-28 revision) cannot be mirrored into `Mcp-Param-*`
 *  headers, by the rules the SDK client applies when it lists tools: only on a property reached through `properties`
 *  alone, a non-empty RFC 9110 token, on a string, integer or boolean, unique without regard to case. Undefined when they
 *  can, or there are none. The SDK does the mirroring itself (callTool's `toolDefinition`), but it exports no form of this
 *  check, which it runs only inside its own `listTools()`. Like the SDK's, the walk goes through schema keywords alone
 *  (`properties` and SUBSCHEMA_KEYWORDS): a value under `default`, `examples`, `const` or `enum`, or an annotation, is
 *  data, never a declaration. Each object is visited once, from an explicit stack, within HEADER_SCAN_NODES and
 *  HEADER_SCAN_DEPTH. */
export function mcpHeaderProblem(inputSchema: unknown): string | undefined {
  const seen = new Map<string, string>();
  const visited = new WeakSet<object>();
  const stack: { node: unknown; path: readonly string[]; reachable: boolean }[] = [{ node: inputSchema, path: [], reachable: true }];
  for (let nodes = 0; stack.length; ) {
    const { node, path, reachable } = stack.pop()!;
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    if (++nodes > HEADER_SCAN_NODES) return `its input schema is larger than ${HEADER_SCAN_NODES} parts, more than its headers are checked through`;
    if (path.length > HEADER_SCAN_DEPTH) return `its input schema nests deeper than ${HEADER_SCAN_DEPTH} levels, more than its headers are checked through`;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, path, reachable: false });
      continue;
    }
    const schema = node as Record<string, unknown>;
    const where = path.length ? path.join(".") : "the schema's root";
    if (Object.hasOwn(schema, "x-mcp-header")) {
      const name = schema["x-mcp-header"];
      if (!reachable || !path.length) return `${where}: x-mcp-header is only allowed on a property reached through properties alone`;
      if (typeof name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return `${where}: x-mcp-header must be a header name (an RFC 9110 token)`;
      if (!["string", "integer", "boolean"].includes(schema.type as string)) return `${where}: x-mcp-header is only allowed on a string, integer or boolean`;
      const prior = seen.get(name.toLowerCase());
      if (prior !== undefined) return `x-mcp-header ${name} is declared twice (also as ${prior})`;
      seen.set(name.toLowerCase(), name);
    }
    for (const [key, child] of Object.entries(schema)) {
      if (!child || typeof child !== "object") continue;
      if (key === "properties") {
        if (!Array.isArray(child)) for (const [name, property] of Object.entries(child)) stack.push({ node: property, path: [...path, name], reachable });
      } else if (OBJECT_VALUED.has(key) && !Array.isArray(child)) {
        for (const sub of Object.values(child)) stack.push({ node: sub, path: [...path, `<${key}>`], reachable: false });
      } else if (SUBSCHEMA_KEYWORDS.has(key)) stack.push({ node: child, path: [...path, `<${key}>`], reachable: false });
    }
  }
  return undefined;
}

/** The pin of a run granted `names`: each MCP tool among them, as its server's snapshot holds it. Keyed by server name
 *  with no prototype, as every map of names here is: a server named `constructor` is a server like any other. A granted
 *  tool that cannot be pinned (its server no longer saved, the tool gone since a refresh, a header declaration it cannot
 *  send) throws, naming it and why: the run is refused, never started without it. */
export function mcpPinOf(names: readonly string[], source: McpServerSource): McpPin {
  const pin: McpPin = Object.create(null);
  for (const name of names) {
    const parsed = mcpNameOf(name);
    const saved = parsed && source.server(parsed.server);
    const tool = saved?.tools.find((t) => t.name === parsed!.tool);
    if (!parsed) continue;
    // Gone since the run's check (deleted, or a refresh removed the tool): the run is refused, never started without it.
    if (!saved) throw new Error(`The MCP tool ${name} cannot be pinned: the MCP server ${parsed.server} is no longer saved.`);
    if (!tool) throw new Error(`The MCP tool ${name} cannot be pinned: ${parsed.tool} is no longer one of its tools since the last refresh.`);
    // A meta tool granted before the rule (mcp-meta.ts): refused here, never run.
    const meta = metaToolOf(saved.url, tool.name);
    if (meta) throw new Error(`${name} can't be granted: ${meta.reason}`);
    const declared = mcpHeaderProblem(tool.inputSchema);
    if (declared) throw new Error(`The MCP tool ${name} declares a header it cannot send: ${declared}.`);
    if (!Object.hasOwn(pin, parsed.server)) pin[parsed.server] = { url: saved.url, tools: [] };
    const pinned = pin[parsed.server]!;
    pinned.tools.push(tool);
    const price = saved.prices && Object.hasOwn(saved.prices, tool.name) ? saved.prices[tool.name] : undefined;
    // Keyed by a tool's name, which may be an object's own property (`__proto__`): no prototype to fall into.
    if (price !== undefined) (pinned.prices ??= Object.create(null) as Record<string, number>)[tool.name] = price;
  }
  return pin;
}


/** Why a connection failed, in a few words: the network's own code, read down the error's causes (the SDK wraps fetch's
 *  error, which wraps the socket's), else the deepest message, cut short. */
function unreachable(error: unknown): string {
  const WORDS: Record<string, string> = {
    ECONNREFUSED: "connection refused", ECONNRESET: "the connection was reset", ENOTFOUND: "its name did not resolve", EAI_AGAIN: "its name did not resolve",
    ETIMEDOUT: "the connection timed out", UND_ERR_CONNECT_TIMEOUT: "the connection timed out", EHOSTUNREACH: "no route to it", ENETUNREACH: "no route to it",
  };
  let deepest = "connection failed";
  for (let at: unknown = error, depth = 0; at && depth < 6; at = (at as { cause?: unknown }).cause, depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && WORDS[code]) return WORDS[code]!;
    if (typeof code === "string" && /CERT|TLS|SSL/.test(code)) return "its TLS certificate was not accepted";
    const message = (at as { message?: unknown }).message;
    if (typeof message === "string" && message) deepest = message.slice(0, 80);
  }
  return deepest;
}

const said = (text: string, isError = false): McpCallResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** `text` with every credential value in `values` replaced, whole and as its bare token (with any one-word scheme, such
 *  as `Bearer ` or `Basic `, taken off): an upstream answer or error that echoes a header, or only its token, never shows
 *  it to the model, the harness or the run's files. */
const scrub = (text: string, values: Iterable<string>) =>
  [...values].flatMap((value) => [value, value.replace(/^[A-Za-z][A-Za-z0-9_-]*\s+(?=\S+$)/, "")]).sort((a, b) => b.length - a.length).reduce((out, value) => (value.length >= 8 ? out.split(value).join("[redacted]") : out), text);

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
  /** The run's Workspace, where an answer too long for the model is filed (the run's process still hands its folder's
   *  path). */
  work: () => Workspace | string;
  /** For tests: the fetch the upstream client sends with. */
  fetch?: typeof fetch;
  /** For tests: the bound on one call (CALL_MS) and on a server's first connection (CONNECT_MS). */
  bounds?: { callMs?: number; connectMs?: number };
  /** The run's commit to its store: an unpriced call's "not metered" is written on its root. */
  commit?: () => McpCommit | undefined;
}

/** A run's journal commit. */
export type McpCommit = <T>(change: (tx: unknown) => Promise<T>) => Promise<T>;

/** What a call with no call id answers where a gate must know it by one: nothing was sent. */
export const noCallId = (name: string): string => `The ${name} call was not sent: it came with no call id, so it cannot wait for a person's approval.`;

/** The gateway: a session's servers, and their calls. `credentials` is read at every call and every request, never
 *  copied: a change the claim step makes after (a token refreshed behind the claim, a server removed) reaches it, even
 *  through a client already connected. */
export type McpGateway = Omit<SessionMcp, "call"> & {
  call(server: string, tool: string, args: Record<string, unknown>, context: { signal: AbortSignal; callId?: string }): Promise<McpCallResult>;
  /** The credential values the calls in flight hold for their scrub, every call's together (none when idle). */
  heldValues(): string[];
};

export function mcpGateway(options: McpGatewayOptions): McpGateway {
  type Upstream = { callTool(params: unknown, options: unknown): Promise<unknown> };
  const clients = new Map<string, Promise<Upstream>>();
  const pins = new Map(Object.entries(options.pin));
  const credentials: Pick<Map<string, McpCredentials[string]>, "get"> = { get: (server) => (Object.hasOwn(options.credentials, server) ? options.credentials[server] : undefined) };
  /** Each server's last HTTP status, which tells a refused credential from another failure. */
  const statuses = new Map<string, { last?: number }>();
  const send = options.fetch ?? fetch;
  /** The credential values each call in flight took or its server's requests sent while it was out, one set per call, by
   *  server: with liveCredentials a refresh can swap a token between a call taking its headers and a request leaving, so
   *  what its answer or error is scrubbed of is every one of them, never only the headers it took. A call's set goes when
   *  the call ends, so nothing held outlives the calls that sent it. */
  const inFlight = new Map<string, Set<Set<string>>>();
  const hold = (server: string, headers: Record<string, string>): Record<string, string> => {
    for (const values of inFlight.get(server) ?? []) for (const value of Object.values(headers)) values.add(value);
    return headers;
  };
  /** A call's own set, held while it is out (released by the call's end). */
  const callSet = (server: string): { values: Set<string>; release(): void } => {
    const values = new Set<string>();
    let calls = inFlight.get(server);
    if (!calls) inFlight.set(server, (calls = new Set()));
    calls.add(values);
    return {
      values,
      release: () => {
        calls.delete(values);
        if (calls.size === 0 && inFlight.get(server) === calls) inFlight.delete(server);
      },
    };
  };
  /** A call's scrub: the headers it took, every value its server's requests took or sent while it was out, and its
   *  credential now. */
  const scrubberOf = (server: string, headers: Record<string, string>, values: Set<string>) => (text: string) =>
    scrub(text, [...Object.values(headers), ...values, ...Object.values(credentials.get(server)?.headers ?? {})]);

  /** The fetch one server's client sends with: its credential added, no redirect followed, at most MAX_RESPONSE read. */
  const guarded = (server: string, headers: Record<string, string> | (() => Record<string, string>), status: { last?: number }) => async (input: string | URL | Request, init: RequestInit = {}) => {
    const sent = new Headers(init.headers);
    // Live credentials: the server's headers as they are at this request, held for the scrub before they leave.
    for (const [name, value] of Object.entries(hold(server, typeof headers === "function" ? headers() : headers))) sent.set(name, value);
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
        // The 2026-07-28 revision first, a 2025-era server through its initialize, as a preview connects.
        const client = new Client({ name: "agentrun", version: "1.0.0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
        await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: guarded(server, () => credentials.get(server)?.headers ?? {}, status) as never }), { timeout: options.bounds?.connectMs ?? CONNECT_MS });
        return client as unknown as Upstream;
      })();
      clients.set(server, upstream);
      // A server that did not connect is tried again at the next call.
      upstream.catch(() => clients.delete(server));
    }
    return upstream;
  };

  /** The model's text of `result`: its text blocks and its embedded text resources (GitHub's get_file_contents answers a
   *  file as one) joined, its structured content when it has neither. Past MCP_CLIP, its start and the rest filed in the
   *  run's evidence/mcp/<server>/ as readable lines, through its Workspace (never through a link), the text saying where
   *  and the read offset that goes on (filed-answer.ts), so read pages through it with no shell. With blocks that are
   *  neither (an image, a blob), the whole result is filed there as JSON, and the text says where. `clean` scrubs every
   *  credential the call's server took or sent. */
  const textOf = async (server: string, tool: string, result: Record<string, unknown>, clean: (text: string) => string): Promise<string> => {
    const blocks = Array.isArray(result.content) ? (result.content as { type?: unknown; text?: unknown; resource?: { uri?: unknown; mimeType?: unknown; text?: unknown } }[]) : [];
    const texts = blocks.flatMap((block) => {
      if (block?.type === "text" && typeof block.text === "string") return [block.text];
      const resource = block?.type === "resource" ? block.resource : undefined;
      if (typeof resource?.text !== "string") return [];
      const about = [typeof resource.uri === "string" ? resource.uri : "", typeof resource.mimeType === "string" ? `(${resource.mimeType})` : ""].filter(Boolean).join(" ");
      return [`[resource${about ? ` ${about}` : ""}]\n${resource.text}`];
    });
    let text = clean(texts.join("\n\n"));
    if (!text && result.structuredContent !== undefined) text = clean(JSON.stringify(result.structuredContent));
    const other = blocks.length - texts.length;
    if (text.length <= MCP_CLIP && other === 0) return text;
    const name = `${tool}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    if (other === 0) return filedAnswer(() => workspaceAt(options.work()), `evidence/mcp/${server}`, name, text, MCP_CLIP);
    const head = text.length > MCP_CLIP ? `${text.slice(0, MCP_CLIP)}\n[cut at ${MCP_CLIP} of ${text.length} characters; ` : `${text}\n[${other} block${other > 1 ? "s" : ""} that ${other > 1 ? "are" : "is"} not text; `;
    try {
      await workspaceAt(options.work()).write(`evidence/mcp/${server}/${name}.json`, clean(JSON.stringify(result)));
    } catch (error) {
      // The Workspace's code and the port's line for it, never the error's message, which names paths.
      return `${head}the whole answer could not be saved (${workspaceErrorWords(error) ?? (error as { code?: string })?.code ?? "write failed"})]`;
    }
    return `${head}the whole answer is in the run's files at evidence/mcp/${server}/${name}.json]`;
  };

  /** The call itself, to a server whose address is the pinned one. A gate's decision or a paid call's hold goes around
   *  it, in `call` below: the one place every harness's call passes before anything is sent. */
  /** `sending`, when given, runs once the server is connected and right before the call leaves: its refusal (a text)
   *  keeps the call from leaving. A call that never got that far (a failed connect, a stop) never ran it. */
  const forward = async (server: string, url: string, headers: Record<string, string>, tool: McpTool, args: Record<string, unknown>, signal: AbortSignal, sending?: () => Promise<string | undefined>): Promise<McpCallResult> => {
    let connected = false;
    // Read at each use: a token refreshed while the call is out, and sent, is scrubbed with the one it took.
    const held = callSet(server);
    const clean = scrubberOf(server, hold(server, headers), held.values);
    try {
      const upstream = await until(connect(server, url, headers), signal);
      connected = true;
      if (sending && !signal.aborted) {
        const refused = await sending();
        if (refused) return said(refused, true);
      }
      // The pinned definition, so the SDK mirrors its x-mcp-header parameters into Mcp-Param-* headers on a 2026-07-28
      // server, as its own listing would have it do.
      const result = (await upstream.callTool({ name: tool.name, arguments: args }, { signal, timeout: options.bounds?.callMs ?? CALL_MS, toolDefinition: { name: tool.name, inputSchema: tool.inputSchema } })) as Record<string, unknown>;
      return said(await textOf(server, tool.name, result, clean), result.isError === true);
    } catch (error) {
      if (signal.aborted) return said(`The call to the MCP server ${server} was stopped.`, true);
      // The next call connects again (a server that dropped its session, say); this one is never sent again.
      clients.delete(server);
      const status = statuses.get(server)?.last;
      // An OAuth token that expired mid-run is not refreshed here (no channel to serve for it): the next launch does.
      if (status === 401 || status === 403) return said(`The MCP server ${server} refused its credential (its sign-in expired or was revoked, or its key changed): ${SIGN_IN_AGAIN}, or update its credential there.`, true);
      // It never answered at all: its connection failed before any HTTP status, so nothing reached it.
      if (!connected && status === undefined) return said(`The MCP server ${server} could not be reached at ${URL.parse(url)?.origin ?? "its address"} (${clean(unreachable(error))}); nothing was sent.`, true);
      const why = clean(String((error as Error)?.message ?? error)).slice(0, 300);
      return said(`The MCP server ${server} failed${status && status >= 400 ? ` (HTTP ${status})` : ""}: ${why}`, true);
    } finally {
      held.release();
    }
  };

  /** A record on the run's root, through its commit. */
  const record = (commit: McpCommit, kind: string, data: Record<string, string | number | null>) => commit(async (tx) => void (await (tx as { appendEntry(conversation: number, entry: unknown): Promise<unknown> }).appendEntry(ROOT_CONVERSATION_ID, { kind, data })));

  /** Why `tool` of `server` cannot be sent now, or undefined. */
  const unsendable = (server: string, tool: string): string | undefined => {
    const pinned = pins.get(server);
    if (!pinned?.tools.some((t) => t.name === tool)) return `${tool} is not a tool of the MCP server ${server} in this run.`;
    const meta = metaToolOf(pinned.url, tool);
    if (meta) return `mcp:${server}/${tool} can't be granted: ${meta.reason} Nothing was sent.`;
    const now = credentials.get(server);
    if (!now) return `The MCP server ${server} is no longer saved on this server; nothing was sent.`;
    if (now.url !== pinned.url) return `The MCP server ${server}'s address changed since this run started; nothing was sent. Start a new run to use it at its new address.`;
    // A credential that does not open is never a call without it.
    // The reason carries its own remedy (mcp-servers.ts UNUSABLE): nothing is added to it here.
    if (now.unopened !== undefined) return `The MCP server ${server}'s credential can't be used right now: ${now.unopened}.`;
    // A token minted for this run's launch is not renewed while it runs: past its end, said, never sent to be refused.
    if (now.expires_at !== undefined && Date.now() >= now.expires_at) return `The GitHub token for this run expired: it is minted again when the run resumes. Nothing was sent to the MCP server ${server}.`;
    return undefined;
  };

  /** A call the gate let go: a priced one under the run's cap and booked, an unpriced one marked not metered. */
  const sent = async (server: string, tool: string, args: Record<string, unknown>, callId: string, signal: AbortSignal): Promise<McpCallResult> => {
    const why = unsendable(server, tool);
    if (why) return said(why, true);
    const { url, prices, tools: pinnedTools } = pins.get(server)!;
    const listed = pinnedTools.find((t) => t.name === tool)!;
    // Whether the call left for the server: only then is it booked, at its price or as not metered.
    let went = false;
    const call = (mark: () => Promise<string | undefined> = async () => undefined) => forward(server, url, credentials.get(server)?.headers ?? {}, listed, args, signal, async () => {
      const refused = await mark();
      went = refused === undefined;
      return refused;
    });
    const name = mcpToolName(server, tool);
    const label = { tool: name, charged_by: server, call: callId };
    const commit = options.commit?.();
    const price = prices && Object.hasOwn(prices, tool) ? prices[tool] : undefined;
    if (price === undefined) {
      const result = await call();
      if (commit && went) await record(commit, TOOL_UNMETERED, label).catch(() => undefined);
      return result;
    }
    // On the runner's one ledger (paid-calls.ts Ledger.paid): held there at its price before it leaves and settled at its
    // price once it left (nothing when it never left), in place of this process's spend and the root's marks.
    const onLedger = paidLedger();
    if (onLedger) {
      const stepped = await paidStep(onLedger, callId ?? name, { name, holdUsd: price, basis: `the price its owner set for ${name}`, by: label.charged_by }, () => call(), () => (went ? price : 0));
      return "refused" in stepped ? said(stepped.refused, true) : stepped.result;
    }
    return said(`${name} was not sent: this call has no run to book its price under.`, true);
  };

  const gateway: McpGateway = {
    servers: [...pins].map(([name, pinned]) => ({ name, tools: pinned.tools })),
    heldValues: () => [...new Set([...inFlight.values()].flatMap((calls) => [...calls].flatMap((values) => [...values])))],
    async call(server, tool, args, { signal, callId }) {
      const why = unsendable(server, tool);
      if (why) return said(why, true);
      return sent(server, tool, args, callId ?? `mcp_${randomUUID()}`, signal);
    },
  };
  return gateway;
}
