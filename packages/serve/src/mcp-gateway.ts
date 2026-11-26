// A run's remote MCP servers: the one place every harness's MCP call goes through. A claimed run's spec builds one per
// claim from its MCP claim step (runner/mcp-run.ts mcpForClaim); every harness calls it through the runner's host tools.
//  - What a run may call is pinned (mcpPinOf) when its agent's revision is saved: each granted tool as its server listed
//    it then, and the server's URL then. A later change or refresh of the server never changes the revision's tools;
//    saving the agent again pins them anew.
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
//  - A server with a meter (McpMeter; fal's, fal-price.ts) prices each billed call itself before it leaves: held and
//    booked the same way, at the meter's quote. A call it cannot price is refused unsent under a spend cap, and with
//    none runs booked as an unknown charge. A meter's keys (McpMeter.keys; fal's submission keys on fal's own host) are
//    scoped to the run on every call of its server as it leaves, and read back as the agent's own in what the model reads.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { McpCallResult, McpTool } from "@parcha/agentrun-kernel";
import { TOOL_UNMETERED } from "./timeline/index.js";
import { until } from "./until.js";
import { type FalMeterName, type MediaReader, meterFor, meterNamed } from "./fal-price.js";
import { filedAnswer } from "./filed-answer.js";
import { type ErrorFacts, type FileSetting, filedSummary, retryAfterHeader, UNREADABLE, unfiledSummary } from "./filed-tool.js";
import { saveOnce } from "./save-once.js";
import { paidLedger, paidStep } from "./paid-calls.js";
import { metaToolOf } from "./mcp-meta.js";
import { SIGN_IN_AGAIN } from "./mcp-oauth.js";
import { capped, mcpClient, scrub } from "./mcp-wire.js";
import { resourceResult, resourceToolOperation, resourceToolProblem } from "./mcp-resources.js";
import { mcpNameOf, mcpToolName } from "./tool-names.js";
import { type Workspace, workspaceAt, workspaceErrorWords } from "./workspace/index.js";

/** The longest answer the model reads whole; past it, the rest is filed in the run's work/ as lines read pages through
 *  (filed-answer.ts). Within the host's result bound (HOST_RESULT_MAX_CHARS), so every harness passes it whole. */
export const MCP_CLIP = 60_000;
/** The longest one upstream call may take, and its first connection. */
export const CALL_MS = 120_000;
export const CONNECT_MS = 30_000;

/** Each pinned server: its URL then, the granted tools as it listed them, the prices its owner declared for them, and
 *  the meter that prices its other calls (`fal`: fal-price.ts). */
export type McpPin = Record<string, { url: string; tools: McpTool[]; prices?: Record<string, number>; meter?: FalMeterName }>;
/** Each granted server's URL now, and its credential's headers when that URL is the pinned one (the claim step's). */
export type McpCredentials = Record<string, { url: string; headers?: Record<string, string>; /** What every request to it adds to its address's query for this run alone: a per-run Composio server's Composio user and connected account (the run's mcp_auth binding), never stored, held for the scrub as headers are. */ query?: Record<string, string>; /** Why its saved credential did not open: its calls are refused unsent. */ unopened?: string; /** When its credential ends (ms): a token minted for the run's launch (a github_app server's), whose calls past it are refused unsent, in words. */ expires_at?: number }>;

/** The servers a save pins from: each one's URL, its tools as it lists them now, its owner's prices, and either its
 *  owner's toolkit for it or, for a pin carried over, the meter it was pinned with. */
export interface McpServerSource {
  server(name: string): { url: string; tools: readonly McpTool[]; prices?: Readonly<Record<string, number>>; toolkit?: string | null; meter?: string } | undefined;
}

/** A meter's price for one call: what to hold before it leaves and why (`basis`), why it can't be priced
 *  (`unpriceable`, in words; the hold then covers only what could be), and what it charged, by the server's reply
 *  (none: no reply came back). Null: unknown. */
export type McpQuote = { holdUsd: number; basis: string; unpriceable?: string; chargeOf(reply: Record<string, unknown> | undefined): number | null };
/** A server's keys scoped to the run (fal's submission keys, fal-price.ts falKeys): `refused`, why a call's keys can't
 *  be scoped (it is then refused unsent); `out`, a call's arguments as they leave; `back`, the text of its answer or error
 *  as the model reads it, each scoped key read as the agent's own. */
export type McpKeys = { refused?(tool: string, args: Record<string, unknown>): string | undefined; out(tool: string, args: Record<string, unknown>): Record<string, unknown>; back(text: string): string };
/** A server's results kept as files: under `dir` (relative to the run's files), what `of` reads from a tool's answer. */
export type McpResults = { dir: string; of(tool: string, reply: Record<string, unknown>): { name: string; value: unknown }[] };
/** A server that prices its own calls. `ask` calls one of the server's tools with the run's credential, unbooked and
 *  unrecorded, and answers its raw result (none: it failed). `keys`: the keys it scopes to the run, on every call of
 *  the server, billed or not. */
export interface McpMeter {
  keys?: McpKeys;
  /** The results a server's answers carry that the run keeps as data (fal's completed jobs, fal-price.ts falResults):
   *  each one's `name` (one the meter vouches for as a plain file name: fal's request_id, a UUID) and `value`, filed by
   *  the gateway at `<dir>/<name>.json` in the run's files, saved once (save-once.ts). */
  results?: McpResults;
  bills(tool: string): boolean;
  quote(tool: string, args: Record<string, unknown>, ask: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>, signal: AbortSignal): Promise<McpQuote>;
}

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

/** The pin of a revision granted `names`: each MCP tool among them, as its server lists it (the save's listing). Keyed by
 *  server name with no prototype, as every map of names here is: a server named `constructor` is a server like any
 *  other. A granted tool that cannot be pinned (its server not saved, a tool it does not list, a header declaration it
 *  cannot send) throws, naming it and why: the save is refused, never kept without it. */
export function mcpPinOf(names: readonly string[], source: McpServerSource): McpPin {
  const pin: McpPin = Object.create(null);
  for (const name of names) {
    const parsed = mcpNameOf(name);
    const saved = parsed && source.server(parsed.server);
    const tool = saved?.tools.find((t) => t.name === parsed!.tool);
    if (!parsed) continue;
    // Gone since the save's check (deleted, or the server stopped listing the tool): the save is refused.
    if (!saved) throw new Error(`The MCP tool ${name} cannot be pinned: no MCP server ${parsed.server} is saved.`);
    if (!tool) throw new Error(`The MCP tool ${name} cannot be pinned: the MCP server ${parsed.server} does not list ${parsed.tool}.`);
    const resourceProblem = resourceToolProblem(tool);
    if (resourceProblem) throw new Error(`The MCP tool ${name} cannot be pinned: ${resourceProblem}.`);
    // A meta tool granted before the rule (mcp-meta.ts): refused here, never run.
    const meta = metaToolOf(saved.url, tool.name);
    if (meta) throw new Error(`${name} can't be granted: ${meta.reason}`);
    const declared = mcpHeaderProblem(tool.inputSchema);
    if (declared) throw new Error(`The MCP tool ${name} declares a header it cannot send: ${declared}.`);
    const meter = meterNamed(saved.url, saved.meter ?? saved.toolkit);
    if (!Object.hasOwn(pin, parsed.server)) pin[parsed.server] = { url: saved.url, tools: [], ...(meter ? { meter } : {}) };
    const pinned = pin[parsed.server]!;
    pinned.tools.push(tool);
    const price = saved.prices && Object.hasOwn(saved.prices, tool.name) ? saved.prices[tool.name] : undefined;
    // Keyed by a tool's name, which may be an object's own property (`__proto__`): no prototype to fall into.
    if (price !== undefined) (pinned.prices ??= Object.create(null) as Record<string, number>)[tool.name] = price;
  }
  return pin;
}

/** An HTTP answer's facts a call's error reads: its status, and the wait its Retry-After names (filed-tool.ts errorLine). */
type Answered = { last?: number; retryAfter?: number };

/** A request's address refused by the guarded fetch below, before anything left: thrown only there, and told apart by
 *  its class, never by its words. A server's error answer can carry the same words after it ran the call (the SDK puts
 *  the body of a failed POST in its error's message), and reading them as this refusal would say a call that may have
 *  run was never sent. */
class AddressRefused extends Error {
  constructor(readonly reason: string) {
    super(`its address is refused here: ${reason}`);
  }
}
/** The reason of the address refusal an error is, or a cause the SDK wrapped it in: the one request's own, so a
 *  refusal of one call is never read as another's. */
function addressRefusal(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof AddressRefused) return e.reason;
  }
  return undefined;
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
/** The refusal of a call of a tool whose stored file setting does not read (filed-tool.ts UNREADABLE). */
const unreadableFile = (server: string, tool: string): string => `${mcpToolName(server, tool)} can't be called: its file setting in the agent's tool settings does not read, so no call is let through until the owner sets it again or removes it (Settings → Tools). Nothing was sent.`;

export interface McpGatewayOptions {
  pin: McpPin;
  credentials: McpCredentials;
  /** The run's Workspace, where an answer too long for the model is filed (the run's process still hands its folder's
   *  path in Mode 1). Read only when a call's answer files something, and awaited: a host may open the Workspace then,
   *  once, rather than for every claim (run-child-host.ts). A Workspace that cannot be opened files nothing, as a write
   *  that fails does. */
  work: () => Workspace | string | Promise<Workspace>;
  /** For tests: the fetch the upstream client sends with. */
  fetch?: typeof fetch;
  /** For tests: the bound on one call (CALL_MS) and on a server's first connection (CONNECT_MS). */
  bounds?: { callMs?: number; connectMs?: number };
  /** The run's commit to its store: an unpriced call's "not metered" is written on its root. */
  commit?: () => McpCommit | undefined;
  /** Where each request to a server may go, asked before anything is sent to it: the runner's MCP claim passes the
   *  address rule (mcp-oauth.ts mcpServerAt) with the owner's private-network hosts read now, and a fetch dialled at the
   *  address it checked (`send`; none, `fetch` as it is). A refusal is said to the model, nothing sent. None: every
   *  request goes as `fetch` sends it. */
  reach?: (url: string, signal: AbortSignal) => Promise<{ refused: string } | { send?: typeof fetch }>;
  /** The claim's per-call check of a server's credential (its custody stamp): awaited before each call is checked for
   *  sending, it may drop the credential (`credentials[server].unopened`), which the call then refuses unsent; one that
   *  throws (a store read failed, the call was stopped) refuses the call unsent too, in words, and the run goes on. Only
   *  the runner's MCP claim step passes it: a github_app token whose App was disconnected or replaced. */
  beforeCall?: (server: string, signal: AbortSignal) => Promise<void>;
  /** Whether the run has a spend cap: under one, a metered call that cannot be priced is refused unsent. None: it has. */
  capped?: boolean;
  /** Reads a metered job's input media, for one priced by its length. None: such a job cannot be priced. */
  media?: MediaReader;
  /** For tests: the clock a meter's prices are kept by. */
  now?: () => number;
  /** The run's id: what a meter scopes a server's keys to (McpMeter.keys). None: no key is scoped. */
  run?: string;
  /** The file setting of a server's tool, read from the agent's own tool settings (filed-tool.ts filedBy): each answer
   *  of it, an error answer too, is filed whole in its folder of the run's files, and the tool's result is only a
   *  summary. UNREADABLE for a tool: a stored setting that does not read, and every call of the tool is refused unsent.
   *  None, or undefined for a tool: its answers are the model's, as always. */
  filed?: (server: string, tool: string) => FileSetting | typeof UNREADABLE | undefined;
}

/** A run's journal commit. */
export type McpCommit = <T>(change: (tx: unknown) => Promise<T>) => Promise<T>;

/** The gateway: a session's servers, and their calls. `credentials` is read at every call and every request, never
 *  copied: a change the claim step makes after (a token refreshed behind the claim, a server removed) reaches it, even
 *  through a client already connected. */
export type McpGateway = {
  servers: readonly { name: string; tools: readonly McpTool[] }[];
  call(server: string, tool: string, args: Record<string, unknown>, context: { signal: AbortSignal; callId?: string }): Promise<McpCallResult>;
  /** The credential values the calls in flight hold for their scrub, every call's together (none when idle). */
  heldValues(): string[];
};

export function mcpGateway(options: McpGatewayOptions): McpGateway {
  type Upstream = { callTool(params: unknown, options: unknown): Promise<unknown>; request(params: unknown, options: unknown): Promise<unknown> };
  /** Each server's client, with the account query it was connected with (`query`, JSON): a message that binds the run to
   *  another account connects again, so no session made as one account carries another's calls. */
  const clients = new Map<string, { query: string; upstream: Promise<Upstream> }>();
  const pins = new Map(Object.entries(options.pin));
  const meters = new Map([...pins].map(([server, pinned]) => [server, meterFor(pinned, { media: options.media, now: options.now, run: options.run })] as const));
  const credentials: Pick<Map<string, McpCredentials[string]>, "get"> = { get: (server) => (Object.hasOwn(options.credentials, server) ? options.credentials[server] : undefined) };
  /** Each server's last HTTP status, which tells a refused credential from another failure: what a call reads that failed
   *  before it sent its own request (its connect). (An address refusal is never kept here: it is read from each call's
   *  own error, since calls to one server run at once.) */
  const statuses = new Map<string, Answered>();
  /** A call's own request's status and wait, kept with the call that sent it (forward), never on the server's connection:
   *  calls to one server run at once, so another call's answer never stands for this one's. */
  const answeredBy = new AsyncLocalStorage<Answered>();
  const send = options.fetch ?? fetch;
  /** The credential values each call in flight took or its server's requests sent while it was out, one set per call, by
   *  server: a refresh can swap a token between a call taking its headers and a request leaving, so
   *  what its answer or error is scrubbed of is every one of them, never only the headers it took. A call's set goes when
   *  the call ends, so nothing held outlives the calls that sent it. */
  const inFlight = new Map<string, Set<Set<string>>>();
  const hold = (server: string, headers: Record<string, string>): Record<string, string> => {
    for (const values of inFlight.get(server) ?? []) for (const value of Object.values(headers)) values.add(value);
    return headers;
  };
  /** The run's account query of `server` now (none for a server that takes none). */
  const queryOf = (server: string): Record<string, string> => credentials.get(server)?.query ?? {};
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
    scrub(text, [...Object.values(headers), ...values, ...Object.values(credentials.get(server)?.headers ?? {}), ...Object.values(queryOf(server))]);

  /** The fetch one server's client sends with: its credential added, no redirect followed, at most MAX_RESPONSE read. */
  const guarded = (server: string, headers: Record<string, string> | (() => Record<string, string>), status: Answered, query: Record<string, string> = {}) => async (input: string | URL | Request, init: RequestInit = {}) => {
    // The account its client was connected as, set over whatever the request's address says, and held for the scrub.
    if (Object.keys(query).length) {
      hold(server, query);
      const at = new URL(input instanceof Request ? input.url : String(input));
      for (const [name, value] of Object.entries(query)) at.searchParams.set(name, value);
      input = input instanceof Request ? new Request(at, input) : at.href;
    }
    // Its address checked first, every request: a name that resolves somewhere private now is refused before anything
    // (its credential among it) leaves, and the request is dialled at the address checked.
    let through = send;
    if (options.reach) {
      const at = await options.reach(input instanceof Request ? input.url : String(input), init.signal ?? AbortSignal.timeout(options.bounds?.connectMs ?? CONNECT_MS));
      if ("refused" in at) {
        throw new AddressRefused(at.refused);
      }
      if (at.send) through = at.send;
    }
    const sent = new Headers(init.headers);
    // Live credentials: the server's headers as they are at this request, held for the scrub before they leave.
    for (const [name, value] of Object.entries(hold(server, typeof headers === "function" ? headers() : headers))) sent.set(name, value);
    const response = await through(input, { ...init, headers: sent, redirect: "manual" });
    status.last = response.status;
    // Its wait, when it names one: a filed tool's error line says it (filed-tool.ts errorLine), never the body.
    status.retryAfter = retryAfterHeader(response.headers.get("retry-after"));
    // And the call's own, when a call sent it (answeredBy).
    const own = answeredBy.getStore();
    if (own) Object.assign(own, { last: status.last, retryAfter: status.retryAfter });
    if (response.status >= 300 && response.status < 400) throw new Error(`it answered a redirect (HTTP ${response.status}), which is never followed`);
    return capped(response);
  };

  const connect = (server: string, url: string, headers: Record<string, string>): Promise<Upstream> => {
    const query = queryOf(server);
    const key = JSON.stringify(query);
    const held = clients.get(server);
    if (held && held.query === key) return held.upstream;
    const status: Answered = {};
    statuses.set(server, status);
    const upstream = (async () => {
      const { client, transport } = mcpClient(await import("@modelcontextprotocol/client"), { name: "agentrun", version: "1.0.0", url: new URL(url), fetch: guarded(server, () => credentials.get(server)?.headers ?? {}, status, query) as never });
      await client.connect(transport, { timeout: options.bounds?.connectMs ?? CONNECT_MS });
      return client as unknown as Upstream;
    })();
    const made = { query: key, upstream };
    clients.set(server, made);
    // A server that did not connect is tried again at the next call.
    upstream.catch(() => clients.get(server) === made && clients.delete(server));
    return upstream;
  };

  /** The answer's text, as textOf reads it before any clip, scrubbed: `other`, how many blocks of it are not text. */
  const answerOf = (result: Record<string, unknown>, clean: (text: string) => string): { text: string; other: number } => {
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
    return { text, other: blocks.length - texts.length };
  };

  /** The model's text of `result`: its text blocks and its embedded text resources (GitHub's get_file_contents answers a
   *  file as one) joined, its structured content when it has neither. Past MCP_CLIP, its start and the rest filed in the
   *  run's evidence/mcp/<server>/ as readable lines, through its Workspace (never through a link), the text saying where
   *  and the read offset that goes on (filed-answer.ts), so read pages through it with no shell. With blocks that are
   *  neither (an image, a blob), the whole result is filed there as JSON, and the text says where. `clean` scrubs every
   *  credential the call's server took or sent. */
  const textOf = async (server: string, tool: string, result: Record<string, unknown>, clean: (text: string) => string): Promise<string> => {
    const { text, other } = answerOf(result, clean);
    if (text.length <= MCP_CLIP && other === 0) return text;
    const name = `${tool}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    if (other === 0) return filedAnswer(async () => workspaceAt(await options.work()), `evidence/mcp/${server}`, name, text, MCP_CLIP);
    const head = text.length > MCP_CLIP ? `${text.slice(0, MCP_CLIP)}\n[cut at ${MCP_CLIP} of ${text.length} characters; ` : `${text}\n[${other} block${other > 1 ? "s" : ""} that ${other > 1 ? "are" : "is"} not text; `;
    try {
      await workspaceAt(await options.work()).write(`evidence/mcp/${server}/${name}.json`, clean(JSON.stringify(result)));
    } catch (error) {
      // The Workspace's code and the port's line for it, never the error's message, which names paths.
      return `${head}the whole answer could not be saved (${workspaceErrorWords(error) ?? (error as { code?: string })?.code ?? "write failed"})]`;
    }
    return `${head}the whole answer is in the run's files at evidence/mcp/${server}/${name}.json]`;
  };

  /** An answer of a tool the agent's setting files (options.filed): written whole, scrubbed, at
   *  <folder>/<tool>-<time>-<id>.json in the run's files before the model is answered, and the tool's result the summary
   *  alone (filed-tool.ts), never through the clip. An error answer is filed the same way and its summary answers an
   *  error, so the model can still react through a shown field. An answer with blocks that are not text is filed as the
   *  whole result's JSON. A write that fails (or a Workspace that cannot open) answers an error in the Workspace's words,
   *  none of the answer shown. */
  const filedOf = async (setting: FileSetting, tool: string, text: string, error?: ErrorFacts): Promise<McpCallResult> => {
    const path = `${setting.folder}/${tool.replace(/[^A-Za-z0-9_.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
    try {
      await workspaceAt(await options.work()).write(path, text);
    } catch (error) {
      // The Workspace's code and the port's line for it, never the error's message, which names paths.
      return said(unfiledSummary(tool, text, setting.folder, workspaceErrorWords(error) ?? (typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "write failed")), true);
    }
    return said(filedSummary(tool, text, path, setting.show, error), error !== undefined);
  };

  /** The results `result` carries that `server`'s meter keeps (McpMeter.results), each filed at its `<dir>/<name>.json`
   *  in the run's files, once (save-once.ts): a file, folder or link already there is kept, and a link on the way is never
   *  followed. Scrubbed as the model's text is. Nothing is said of it in the answer, and a result that could not be filed
   *  is left out: a filing never fails the call. */
  const fileResults = async (server: string, tool: string, result: Record<string, unknown>, clean: (text: string) => string): Promise<void> => {
    const results = meters.get(server)?.results;
    if (!results) return;
    let found: { name: string; value: unknown }[];
    try {
      found = results.of(tool, result);
    } catch {
      return;
    }
    if (!found.length) return;
    let work: Workspace;
    try {
      work = workspaceAt(await options.work());
    } catch {
      return;
    }
    for (const { name, value } of found) {
      try {
        await saveOnce(work, `${results.dir}/${name}.json`, clean(JSON.stringify(value) ?? "null"));
      } catch {
        // Not filed: a link on the way, a write that failed. The answer stands as the server gave it.
      }
    }
  };

  /** The call itself, to a server whose address is the pinned one. A gate's decision or a paid call's hold goes around
   *  it, in `call` below: the one place every harness's call passes before anything is sent. */
  /** `sending`, when given, runs once the server is connected and right before the call leaves: its refusal (a text)
   *  keeps the call from leaving. A call that never got that far (a failed connect, a stop) never ran it. `outcome`
   *  takes the server's raw result, when one came back. */
  const forward = async (server: string, url: string, headers: Record<string, string>, tool: McpTool, args: Record<string, unknown>, signal: AbortSignal, sending?: () => Promise<string | undefined>, outcome: { unsent?: true; raw?: Record<string, unknown>; quiet?: true } = {}, back?: McpKeys["back"]): Promise<McpCallResult> => {
    let connected = false;
    const operation = resourceToolOperation(tool);
    const boundedSignal = operation ? AbortSignal.any([signal, AbortSignal.timeout(options.bounds?.callMs ?? CALL_MS)]) : signal;
    // Read at each use: a token refreshed while the call is out, and sent, is scrubbed with the one it took.
    const held = callSet(server);
    const scrubbed = scrubberOf(server, hold(server, headers), held.values);
    // Every text the model reads of the call (its answer, a filed one, an error), its keys read as the agent's own.
    const clean = back ? (text: string) => back(scrubbed(text)) : scrubbed;
    hold(server, queryOf(server));
    // What this call's own request was answered with (answeredBy): read by its error, never another call's.
    const own: Answered = {};
    try {
      const upstream = await until(connect(server, url, headers), boundedSignal);
      connected = true;
      if (sending && !signal.aborted) {
        const refused = await sending();
        if (refused) return said(refused, true);
      }
      // The pinned definition, so the SDK mirrors its x-mcp-header parameters into Mcp-Param-* headers on a 2026-07-28
      // server, as its own listing would have it do.
      const result = await answeredBy.run(own, async () => operation
        ? await resourceResult(upstream, operation, args, boundedSignal, options.bounds?.callMs ?? CALL_MS, scrubbed)
        : (await upstream.callTool({ name: tool.name, arguments: args }, { signal, timeout: options.bounds?.callMs ?? CALL_MS, toolDefinition: { name: tool.name, inputSchema: tool.inputSchema } })) as Record<string, unknown>);
      outcome.raw = result;
      // A meter's own read (`quiet`): its raw result is all that is wanted, nothing filed for a model to read.
      if (outcome.quiet) return said("", result.isError === true);
      // Filed before the answer is given, so a model that reads it next finds it.
      await fileResults(server, tool.name, result, clean);
      const filing = options.filed?.(server, tool.name);
      // UNREADABLE never gets here (unsendable refuses it unsent); never answered unfiled either way.
      if (filing === UNREADABLE) return said(unreadableFile(server, tool.name), true);
      if (filing) {
        const { text: answer, other } = answerOf(result, clean);
        // An error answer's status is the transport's (200), so only its own fields can name a retry time.
        return await filedOf(filing, tool.name, other === 0 ? answer : clean(JSON.stringify(result)), result.isError === true ? {} : undefined);
      }
      return said(await textOf(server, tool.name, result, clean), result.isError === true);
    } catch (error) {
      if (signal.aborted) return said(`The call to the MCP server ${server} was stopped.`, true);
      if (boundedSignal.aborted) return said(`The resource operation on the MCP server ${server} exceeded its deadline.`, true);
      // The next call connects again (a server that dropped its session, say); this one is never sent again.
      clients.delete(server);
      // Its address refused before the request left (reach): nothing reached it. Read from this call's own error, never
      // from the server's shared state: another call's refusal says nothing of whether this one was sent.
      const refused = addressRefusal(error);
      if (refused !== undefined) {
        // `sending` may have run already (the connection was open): the request's own address check refused it, so the call
        // never left and `outcome` says so, for the caller that books a price only for a call that went.
        outcome.unsent = true;
        return said(`The MCP server ${server}'s address is refused here: ${refused}. Nothing was sent.`, true);
      }
      // Its own request's status and wait once it was connected; before that, its connect's (the server's connection).
      const seen = connected ? own : (statuses.get(server) ?? {});
      const status = seen.last;
      // An OAuth token that expired mid-run is not refreshed here (no channel to serve for it): the next launch does.
      if (status === 401 || status === 403) return said(`The MCP server ${server} refused its credential (its sign-in expired or was revoked, or its key changed): ${SIGN_IN_AGAIN}, or update its credential there.`, true);
      // It never answered at all: its connection failed before any HTTP status, so nothing reached it.
      if (!connected && status === undefined) return said(`The MCP server ${server} could not be reached at ${URL.parse(url)?.origin ?? "its address"} (${clean(unreachable(error))}); nothing was sent.`, true);
      // A filed tool's protocol error (a JSON-RPC error, an HTTP error answer) is the server's words as an answer is: filed
      // whole and answered with its summary and what its structure says, none of its words shown.
      const filing = outcome.quiet ? undefined : options.filed?.(server, tool.name);
      if (filing && filing !== UNREADABLE) {
        const { ProtocolError } = await import("@modelcontextprotocol/client");
        const thrown = error as { code?: unknown; message?: unknown; data?: unknown };
        const code = ProtocolError.isInstance(error) && Number.isInteger(thrown.code) ? (thrown.code as number) : undefined;
        const body = { error: { ...(code !== undefined ? { code } : {}), message: String(thrown?.message ?? error), ...(thrown?.data !== undefined ? { data: thrown.data } : {}) } };
        const retryAfterS = seen.retryAfter;
        return await filedOf(filing, tool.name, clean(JSON.stringify(body)), { ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}), ...(retryAfterS !== undefined ? { retryAfterS } : {}) });
      }
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
    // A file setting that does not read fails closed, as a broken pin does: never a call whose answer goes to the model
    // unfiled.
    if (options.filed?.(server, tool) === UNREADABLE) return unreadableFile(server, tool);
    const resourceProblem = resourceToolProblem(pinned.tools.find(t => t.name === tool));
    if (resourceProblem) return `The MCP operation ${tool} is invalid: ${resourceProblem}. Nothing was sent.`;
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
    // The credential's custody checked first: one the claim drops now is refused below, unsent. A check that could not
    // be made (a store read failed, the call was stopped) refuses this call unsent too, in words: never sent unchecked.
    if (options.beforeCall) {
      try {
        await options.beforeCall(server, signal);
      } catch {
        return said(`The MCP server ${server}'s credential can't be used right now: it could not be checked just now. Nothing was sent.`, true);
      }
    }
    const why = unsendable(server, tool);
    if (why) return said(why, true);
    // A key the server could not take once scoped to the run, refused before anything is priced or held.
    const keys = meters.get(server)?.keys;
    const keyless = keys?.refused?.(tool, args);
    if (keyless) return said(`${mcpToolName(server, tool)} was not sent: ${keyless}. Nothing was sent.`, true);
    const { url, prices, tools: pinnedTools } = pins.get(server)!;
    const listed = pinnedTools.find((t) => t.name === tool)!;
    // Whether the call left for the server: only then is it booked, at its price or as not metered.
    let went = false;
    let raw: Record<string, unknown> | undefined;
    // The server's keys scoped to the run as the call leaves (fal's submission keys): its price is read from the call as
    // the agent made it.
    const call = async (mark: () => Promise<string | undefined> = async () => undefined) => {
      const outcome: { unsent?: true; raw?: Record<string, unknown> } = {};
      const result = await forward(server, url, credentials.get(server)?.headers ?? {}, listed, keys ? keys.out(tool, args) : args, signal, async () => {
        const refused = await mark();
        went = refused === undefined;
        return refused;
      }, outcome, keys?.back);
      // The request's own address check refused it after the mark: it never left, so nothing is booked.
      if (outcome.unsent) went = false;
      raw = outcome.raw;
      return result;
    };
    const name = mcpToolName(server, tool);
    const label = { tool: name, charged_by: server, call: callId };
    const commit = options.commit?.();
    const price = prices && Object.hasOwn(prices, tool) ? prices[tool] : undefined;
    const meter = price === undefined && meters.get(server)?.bills(tool) ? meters.get(server) : undefined;
    if (price === undefined && !meter) {
      const result = await call();
      if (commit && went) await record(commit, TOOL_UNMETERED, label).catch(() => undefined);
      return result;
    }
    // On the runner's one ledger (paid-calls.ts Ledger.paid): held there at its price before it leaves and settled at its
    // price once it left (nothing when it never left), in place of this process's spend and the root's marks.
    const onLedger = paidLedger();
    if (!onLedger) return said(`${name} was not sent: this call has no run to book its price under.`, true);
    if (price !== undefined) {
      const stepped = await paidStep(onLedger, callId ?? name, { name, holdUsd: price, basis: `the price its owner set for ${name}`, by: label.charged_by }, () => call(), () => (went ? price : 0));
      return "refused" in stepped ? said(stepped.refused, true) : stepped.result;
    }
    // The meter reads its prices from the server itself: the run's credential, no record, no booking.
    const ask = async (asked: string, input: Record<string, unknown>) => {
      const outcome: { raw?: Record<string, unknown>; quiet: true } = { quiet: true };
      await forward(server, url, credentials.get(server)?.headers ?? {}, { name: asked, inputSchema: { type: "object" } }, input, signal, undefined, outcome);
      return outcome.raw;
    };
    const quote = await meter!.quote(tool, args, ask, signal);
    if (quote.unpriceable && (options.capped ?? true)) return said(`${name} was not sent: ${quote.unpriceable}, so a run with a spend cap can't send it. Nothing was sent.`, true);
    // Settled by the server's reply; one that left and brought none back, at the meter's word for it (fal: its hold).
    const stepped = await paidStep(onLedger, callId ?? name, { name, holdUsd: quote.holdUsd, basis: quote.basis, by: label.charged_by }, () => call(), () => (went ? quote.chargeOf(raw) : 0));
    return "refused" in stepped ? said(stepped.refused, true) : stepped.result;
  };

  const gateway: McpGateway = {
    servers: [...pins].map(([name, pinned]) => ({ name, tools: pinned.tools })),
    heldValues: () => [...new Set([...inFlight.values()].flatMap((calls) => [...calls].flatMap((values) => [...values])))],
    async call(server, tool, args, { signal, callId }) {
      // Only what no sign-in can change is refused here: the rest (a credential that did not open, a server since removed)
      // is read by sent() after beforeCall, which opens the row again, so a call after the owner signs in again goes.
      if (!pins.get(server)?.tools.some((t) => t.name === tool)) return said(`${tool} is not a tool of the MCP server ${server} in this run.`, true);
      return sent(server, tool, args, callId ?? `mcp_${randomUUID()}`, signal);
    },
  };
  return gateway;
}
