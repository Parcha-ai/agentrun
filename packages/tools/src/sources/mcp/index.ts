// MCP servers as a tool source: a toolkit is one saved server (`mcp:<server>`), an action one of its tools
// (`mcp:<server>/<tool>`). The adapter gets no store and no seal key. Per toolkit the kernel hands it the server's
// settings (custody.ts SETTING: url, auth, headers, price.<tool>) and its Credential, and its fetch is the kernel's.
//  - actions(): tools/list through the official client, every page, within serve's probe bounds (500 tools, 1 MiB of
//    snapshot, 64 pages, 4 MiB an answer, 15 s a request, 30 s the whole), each tool an ActionSpec whose version is the
//    hash of the whole listed snapshot (snapshot.ts), so a save pins it and a later listing shows a change.
//  - call(): tools/call over the kernel's fetch with the credential's headers alone, to the bound origin alone, never
//    through a redirect; every credential value the call took is cut from what comes back; never throws: a fault is a
//    refusal code with words.
//  - check(): the connection's handshake alone (server/discover, or initialize on a 2025-era server); never a tools/call.
import { randomUUID } from "node:crypto";
import { addressRefused, credentialHeaders, guardedFetch, NoCredential, type Seen, type ServerSettings, SETTING, SettingsInvalid, scrubWith, settingsOf, timedOut, Unsent, until } from "./custody.js";
import type { ActionId, ActionSpec, CallCtx, CallOutcome, Credential, Ctx, Custody, Price, RefusalCode, Risk, Toolkit, ToolSource } from "./protocol-draft.js";
import { mcpHeaderProblem, MCP_SERVER_NAME, MCP_TOOL_NAME, metaToolOf } from "./rules.js";
import { type ListedTool, snapshotVersion } from "./snapshot.js";

export { canonical, type ListedTool, snapshotVersion, versionedTool } from "./snapshot.js";
export { AUTH_TYPES, SETTING, SettingsInvalid, settingsOf } from "./custody.js";
export { META_REASON, mcpHeaderProblem, metaToolOf } from "./rules.js";

/** The longest answer the model reads whole; the rest is filed (serve's MCP_CLIP, monid's rule). */
export const MCP_CLIP = 60_000;
/** One call's bound, and a connection's (serve's gateway CALL_MS and CONNECT_MS). */
export const CALL_MS = 120_000;
export const CONNECT_MS = 30_000;
/** A listing's bounds (serve's probe). */
export const LIST_REQUEST_MS = 15_000;
export const LIST_MS = 30_000;
export const MAX_TOOLS = 500;
export const MAX_SNAPSHOT_BYTES = 2 ** 20;
export const MAX_PAGES = 64;

/** What `mcpSource` may be given: the client's name, and for tests the bounds. */
export type McpSourceOptions = { clientInfo?: { name: string; version: string }; bounds?: { callMs?: number; connectMs?: number; listRequestMs?: number; listMs?: number } };

/** A listing that failed, in words with every credential value cut; `code` the refusal it maps to. */
export class McpListFailed extends Error {
  override name = "McpListFailed";
  constructor(readonly code: RefusalCode | "invalid", message: string) {
    super(message);
  }
}

type Client = {
  connect(transport: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<void>;
  request(request: { method: string; params?: Record<string, unknown> }, options?: { timeout?: number; signal?: AbortSignal }): Promise<{ tools: ListedTool[]; nextCursor?: string }>;
  callTool(params: unknown, options?: unknown): Promise<Record<string, unknown>>;
  getServerCapabilities(): { tools?: unknown } | undefined;
  close(): Promise<void>;
};

/** The server name of toolkit `mcp:<server>`, or undefined. */
const serverOf = (toolkit: string): string | undefined => {
  const match = /^mcp:(.+)$/.exec(toolkit);
  return match && MCP_SERVER_NAME.test(match[1]!) ? match[1] : undefined;
};
/** `mcp:<server>/<tool>` read. */
const actionOf = (id: string): { server: string; tool: string } | undefined => {
  const match = /^mcp:([^/]+)\/(.+)$/.exec(id);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
};

const custodyOf = (server: string, settings: ServerSettings): Custody =>
  settings.auth === "none" ? { kind: "none" }
  : settings.auth === "oauth" ? { kind: "oauth", holder: "local", connectionRef: `mcp:${server}`, boundTo: settings.url.origin }
  : { kind: "sealed_key", keyRef: `mcp:${server}`, boundTo: settings.url.origin };

const riskOf = (annotations: Record<string, unknown> | undefined): Risk =>
  ({ level: annotations?.destructiveHint === true ? "destructive" : annotations?.readOnlyHint === true ? "read" : "write", from: "source_hint" });

const priceOf = (settings: ServerSettings, tool: string): Price => {
  const usd = Object.hasOwn(settings.prices, tool) ? settings.prices[tool] : undefined;
  return usd === undefined ? { kind: "not_metered" } : { kind: "metered", usdPerCall: usd, holdUsd: usd };
};

/** Why a tool is not granted, or true. */
function grantableOf(url: string, tool: ListedTool): ActionSpec["grantable"] {
  const meta = metaToolOf(url, tool.name);
  if (meta) return { reason: meta.reason };
  if (!MCP_TOOL_NAME.test(tool.name)) return { reason: `its name is not 1 to 64 letters, digits, _ and -, so it has no action id every harness can call` };
  const header = mcpHeaderProblem(tool.inputSchema);
  if (header) return { reason: `it declares a header it cannot send: ${header}` };
  return true;
}

/** The MCP source. */
export function mcpSource(options: McpSourceOptions = {}): ToolSource {
  const clientInfo = options.clientInfo ?? { name: "agentrun", version: "1.0.0" };
  const bounds = { callMs: CALL_MS, connectMs: CONNECT_MS, listRequestMs: LIST_REQUEST_MS, listMs: LIST_MS, ...options.bounds };

  /** A connected client for one server, every request through the guarded fetch; closed by the caller. */
  const open = async (settings: ServerSettings, credential: Credential | undefined, ctx: Pick<Ctx, "fetch">, values: Set<string>, seen: Seen, signal: AbortSignal, timeout: number): Promise<Client> => {
    // A server that takes a credential, handed none: nothing is sent.
    if (settings.auth !== "none" && !credential) throw new NoCredential(settings.auth);
    const sdk = await import("@modelcontextprotocol/client");
    const send = guardedFetch(ctx, settings.url.origin, () => credentialHeaders(settings, credential), values, seen);
    const transport = new sdk.StreamableHTTPClientTransport(new URL(settings.url.href), { fetch: send, requestInit: { redirect: "manual" } });
    // The 2026-07-28 revision first, a 2025-era server through its initialize, as serve's probe and gateway connect.
    const client = new sdk.Client(clientInfo, { capabilities: {}, versionNegotiation: { mode: "auto" } }) as unknown as Client;
    try {
      await client.connect(transport, { timeout, signal });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  };

  /** The refusal a failure maps to, with its words (every credential value cut by `clean`). */
  const faultOf = (error: unknown, seen: Seen, settings: ServerSettings, signal: AbortSignal, deadline: AbortSignal, clean: (text: string) => string, server: string): { code: RefusalCode; words: string } => {
    if (signal.aborted) return { code: "stopped", words: `The call to the MCP server ${server} was stopped.` };
    if (error instanceof NoCredential) return { code: settings.auth === "oauth" ? "needs_connection" : "key_refused", words: `The MCP server ${server} was not called: ${error.message}. Nothing was sent.` };
    if (seen.offOrigin !== undefined) return { code: "blocked_address", words: `The MCP server ${server} was not called: a request to ${clean(seen.offOrigin)} is off the origin its credential is bound to (${settings.url.origin}). Nothing was sent there.` };
    if (seen.refusedAddress || addressRefused(error)) return { code: "blocked_address", words: `The MCP server ${server}'s address is refused here; nothing was sent.` };
    if (seen.redirect) {
      const to = seen.redirect.location ? URL.parse(seen.redirect.location, settings.url)?.origin ?? "another address" : "another address";
      return { code: "upstream_error", words: clean(`The MCP server ${server} answered a redirect (HTTP ${seen.redirect.status}) to ${to}, which is never followed, so a credential goes only where its owner sends it. Nothing more was sent.`) };
    }
    // The first refusing status any request met (a 2025-era fallback after a refused handshake answers another), else
    // the last.
    const status = seen.statuses?.find((one) => [401, 402, 403, 429].includes(one) || one >= 500) ?? seen.last;
    if (status === 401 || status === 403) return settings.auth === "oauth"
      ? { code: "connection_expired", words: `The MCP server ${server} refused its sign-in (HTTP ${status}): it expired or was revoked. Sign in again in Settings → MCP servers.` }
      : { code: "key_refused", words: `The MCP server ${server} refused its credential (HTTP ${status}): update it in Settings → MCP servers.` };
    if (status === 402) return { code: "quota_exhausted", words: `The MCP server ${server} answered that its quota or payment is used up (HTTP 402).` };
    if (status === 429) return { code: "rate_limited", words: `The MCP server ${server} is limiting requests (HTTP 429); try again later.` };
    if (deadline.aborted || timedOut(error)) return { code: "timeout", words: `The MCP server ${server} did not answer in time.` };
    if (seen.overflow) return { code: "upstream_error", words: `The MCP server ${server} answered more than its answer may hold.` };
    if (status !== undefined && status >= 500) return { code: "upstream_error", words: `The MCP server ${server} failed (HTTP ${status}).` };
    const said = clean(String((error as Error)?.message ?? error)).slice(0, 300);
    return { code: "upstream_error", words: `The MCP server ${server} failed${status && status >= 400 ? ` (HTTP ${status})` : ""}: ${said}` };
  };

  /** Every tool `settings`' server lists, all pages, within the probe's bounds. */
  const list = async (server: string, settings: ServerSettings, ctx: Ctx): Promise<ListedTool[]> => {
    const values = new Set<string>();
    const seen: Seen = {};
    const clean = scrubWith(values, ctx.credential);
    const deadline = AbortSignal.timeout(bounds.listMs);
    const signal = AbortSignal.any([ctx.signal, deadline]);
    const opening = open(settings, ctx.credential, ctx, values, seen, signal, bounds.listRequestMs);
    try {
      const client = await until(opening, signal);
      const tools: ListedTool[] = [];
      let bytes = 0;
      if (client.getServerCapabilities()?.tools) {
        for (let cursor: string | undefined, pages = 0; ; ) {
          const page = await until(client.request({ method: "tools/list", ...(cursor !== undefined ? { params: { cursor } } : {}) }, { timeout: bounds.listRequestMs, signal }), signal);
          for (const tool of page.tools) {
            const kept: ListedTool = {
              name: tool.name,
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
            };
            tools.push(kept);
            bytes += Buffer.byteLength(JSON.stringify(kept));
            if (tools.length > MAX_TOOLS) throw new McpListFailed("invalid", `The MCP server ${server} lists more than ${MAX_TOOLS} tools (listing stopped): a server is kept with at most ${MAX_TOOLS}.`);
            if (bytes > MAX_SNAPSHOT_BYTES) throw new McpListFailed("invalid", `The MCP server ${server}'s tools come to more than ${MAX_SNAPSHOT_BYTES / 2 ** 20} MiB (listing stopped): a server is kept with at most ${MAX_SNAPSHOT_BYTES / 2 ** 20} MiB.`);
          }
          if (page.nextCursor === undefined || page.nextCursor === cursor) break;
          if (++pages >= MAX_PAGES) throw new McpListFailed("upstream_error", `The MCP server ${server}'s tool list did not end within ${MAX_PAGES} pages.`);
          cursor = page.nextCursor;
        }
      }
      return tools;
    } catch (error) {
      if (error instanceof McpListFailed) throw error;
      const fault = faultOf(error, seen, settings, ctx.signal, deadline, clean, server);
      throw new McpListFailed(fault.code, fault.words);
    } finally {
      // Closed behind the answer, also when a stop answered before the connection was made.
      void opening.then((client) => client.close(), () => undefined).catch(() => undefined);
    }
  };

  /** The answer's text, images and whether it was filed: text blocks joined (else its structured content), images kept;
   *  past MCP_CLIP, or with blocks that are neither, the whole answer is filed through `ctx.file` and the text says where.
   *  Every text is scrubbed first. */
  const outcomeOf = async (server: string, tool: string, result: Record<string, unknown>, clean: (text: string) => string, ctx: CallCtx): Promise<{ text: string; images?: { mime: string; data: string }[] }> => {
    const blocks = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : [];
    const texts = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text as string);
    const images = blocks.filter((block) => block?.type === "image" && typeof block.data === "string").map((block) => ({ mime: clean(String(block.mimeType ?? "application/octet-stream")), data: block.data as string }));
    let text = clean(texts.join("\n\n"));
    if (!text && result.structuredContent !== undefined) text = clean(JSON.stringify(result.structuredContent));
    const other = blocks.length - texts.length - images.length;
    const kept = images.length ? { images } : {};
    if (text.length <= MCP_CLIP && other === 0) return { text, ...kept };
    const name = `evidence/mcp/${server}/${tool}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
    const head = text.length > MCP_CLIP ? `${text.slice(0, MCP_CLIP)}\n[cut at ${MCP_CLIP} of ${text.length} characters; ` : `${text}\n[${other} block${other > 1 ? "s" : ""} that ${other > 1 ? "are" : "is"} not text; `;
    try {
      // The filed copy is scrubbed whole, image data included as the server sent it.
      const where = await ctx.file(name, clean(JSON.stringify(result)));
      return { text: `${head}the whole answer is in the run's files at ${where}]`, ...kept };
    } catch {
      return { text: `${head}the whole answer could not be saved]`, ...kept };
    }
  };

  const source: ToolSource = {
    id: "mcp",
    label: "MCP servers",
    caps: {
      connect: { unsupported: "the server's own sign-in (Settings → MCP servers): an OAuth server is signed in to where it is saved, not through this source" },
      quote: { unsupported: "an MCP server quotes no price: a tool costs what its owner set for it, or is not metered" },
      recover: { unsupported: "an MCP call has no id to read back after a crash: a call cut off is answered interrupted, never sent again" },
      triggers: { unsupported: "an MCP server starts no runs: use a schedule, webhook or GitHub trigger" },
      search: { unsupported: "a saved server is listed whole: grant its tools from the list" },
    },
    settings: { fields: [{ name: SETTING.url, secret: false }, { name: SETTING.auth, secret: false }, { name: SETTING.headers, secret: false }, { name: `${SETTING.price}<tool>`, secret: false }, { name: SETTING.name, secret: false }] },

    async check(ctx) {
      let settings: ServerSettings;
      try {
        settings = settingsOf(ctx.settings);
      } catch (error) {
        return { state: "unknown", words: `The MCP server's settings do not read: ${(error as Error).message}.` };
      }
      const values = new Set<string>();
      const seen: Seen = {};
      const clean = scrubWith(values, ctx.credential);
      const deadline = AbortSignal.timeout(bounds.listRequestMs);
      const signal = AbortSignal.any([ctx.signal, deadline]);
      const server = settings.name ?? settings.url.host;
      // The handshake alone: server/discover, or initialize on a 2025-era server. No tools/list, no tools/call.
      const opening = open(settings, ctx.credential, ctx, values, seen, signal, bounds.listRequestMs);
      void opening.then((client) => client.close(), () => undefined).catch(() => undefined);
      try {
        await until(opening, signal);
        return { state: "ok", words: `The MCP server ${server} answered.` };
      } catch (error) {
        const fault = faultOf(error, seen, settings, ctx.signal, deadline, clean, server);
        const refused = ["key_refused", "connection_expired", "needs_connection", "quota_exhausted"].includes(fault.code);
        return { state: refused ? "refused" : "unknown", words: fault.words };
      }
    },

    async toolkits(ctx) {
      // The saved servers are the kernel's registry, not this adapter's: it describes the one server its settings name.
      const name = ctx.settings[SETTING.name];
      if (!name || !MCP_SERVER_NAME.test(name) || !ctx.settings[SETTING.url]) return [];
      return [{ id: `mcp:${name}`, label: name, actions: "unknown", needsConnection: ctx.settings[SETTING.auth] === "oauth" }] satisfies Toolkit[];
    },

    async actions(toolkit, ctx, only) {
      const server = serverOf(toolkit);
      if (!server) throw new McpListFailed("invalid", `${toolkit} is not an MCP toolkit: mcp:<server>, the server's name in lowercase letters, digits and -.`);
      let settings: ServerSettings;
      try {
        settings = settingsOf(ctx.settings);
      } catch (error) {
        throw new McpListFailed("invalid", `The MCP server ${server}'s settings do not read: ${(error as Error).message}.`);
      }
      const tools = await list(server, settings, ctx);
      const version = snapshotVersion(tools);
      const custody = custodyOf(server, settings);
      const wanted = only && new Set(only.map((one) => actionOf(one)?.tool ?? one));
      return tools.filter((tool) => !wanted || wanted.has(tool.name)).map((tool): ActionSpec => ({
        id: `mcp:${server}/${tool.name}` as ActionId,
        title: tool.title ?? (typeof tool.annotations?.title === "string" ? tool.annotations.title : tool.name),
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? { type: "object" },
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        risk: riskOf(tool.annotations),
        price: priceOf(settings, tool.name),
        replay: "never",
        custody,
        resultMaxChars: MCP_CLIP,
        grantable: grantableOf(settings.url.href, tool),
        version,
      }));
    },

    async call(spec, args, ctx) {
      const named = actionOf(spec.id);
      const server = named?.server ?? "?";
      const refuse = (refusal: RefusalCode, text: string): CallOutcome => ({ text, isError: true, refusal });
      if (!named) return refuse("unsupported", `${spec.id} is not an MCP action: mcp:<server>/<tool>. Nothing was sent.`);
      let settings: ServerSettings;
      try {
        settings = settingsOf(ctx.settings);
      } catch (error) {
        return refuse("upstream_error", `The MCP server ${server}'s settings do not read: ${(error as SettingsInvalid).message}. Nothing was sent.`);
      }
      // The credential goes to the origin the action was pinned with, and the server's address now must be it.
      const boundTo = spec.custody.kind === "none" ? settings.url.origin : spec.custody.boundTo;
      if (settings.url.origin !== boundTo) return refuse("blocked_address", `The MCP server ${server}'s address changed since this action was pinned (${boundTo}, now ${settings.url.origin}); nothing was sent. Save the agent again to use it at its new address.`);
      const meta = metaToolOf(settings.url.href, named.tool);
      if (meta) return refuse("unsupported", `${spec.id} can't be granted: ${meta.reason} Nothing was sent.`);
      const price = spec.price.kind === "metered" && typeof spec.price.usdPerCall === "number" ? spec.price.usdPerCall : undefined;
      const values = new Set<string>();
      const seen: Seen = {};
      const clean = scrubWith(values, ctx.credential);
      const deadline = AbortSignal.timeout(bounds.callMs);
      const signal = AbortSignal.any([ctx.signal, deadline]);
      // What the owner says a call costs, once its tools/call left; absent when unpriced or when it never left.
      const charged = () => (price !== undefined && seen.sentCall ? { chargedUsd: price } : {});
      const opening = open(settings, ctx.credential, ctx, values, seen, signal, bounds.connectMs);
      try {
        const client = await until(opening, signal);
        // The pinned definition, so the SDK mirrors its x-mcp-header parameters into Mcp-Param-* headers.
        const result = await until(client.callTool({ name: named.tool, arguments: (args ?? {}) as Record<string, unknown> }, { signal, timeout: bounds.callMs, toolDefinition: { name: named.tool, inputSchema: spec.inputSchema } }), signal);
        return { ...(await outcomeOf(server, named.tool, result, clean, ctx)), isError: result.isError === true, ...charged() };
      } catch (error) {
        const fault = faultOf(error, seen, settings, ctx.signal, deadline, clean, server);
        return { ...refuse(fault.code, clean(fault.words)), ...charged() };
      } finally {
        // Closed behind the answer: a stop answers at once, the connection let go after it.
        void opening.then((client) => client.close(), () => undefined).catch(() => undefined);
      }
    },
  };
  return source;
}

/** Whether an error from `actions()` is a refusal the kernel reads, with its code. */
export const listRefusalOf = (error: unknown): RefusalCode | "invalid" | undefined => (error instanceof McpListFailed ? error.code : error instanceof SettingsInvalid ? "invalid" : error instanceof Unsent ? "blocked_address" : undefined);
