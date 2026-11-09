// The MCP server probe and request validation, shared between the file McpServers (mcp-servers.ts) and the store-backed one
// (mcp-servers-store.ts). Moved here verbatim so both answer and refuse byte-identically; the storage, sealing and sign-in
// state differ between the two, nothing here does. Until the cutover deletes mcp-servers.ts, the file class still carries
// its own copies; from the cutover on this is the one home (the switch repoints mcp-gateway.ts's UNUSABLE import here).
//
// Nothing here opens a credential or touches a store: listServer connects to a URL with the official SDK client, agrees a
// protocol revision and lists every tool (all pages, under caps); the validation turns a request body into a URL, auth and
// prices, or a 422; no redirect is followed, so a credential goes only where the owner sends it.
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { metaToolOf } from "./mcp-meta.js";
import { SIGN_IN_AGAIN } from "./mcp-oauth.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { isObject, unknownFields } from "./validate.js";

export const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The names AgentRun's own tools are called by, which no MCP server takes: claude-agent calls the kernel's host tools
 *  as `mcp__hands__<tool>`, and monid's are `monid_<tool>` (tool-gate.ts settingsKeyOf reads both as AgentRun's). */
export const RESERVED_MCP_NAMES: readonly string[] = ["hands", "monid"];
export const MCP_AUTH_TYPES = ["none", "bearer", "headers", "oauth"] as const;
/** Where an owner updates a saved MCP server, as people read it. */
const MCP_SETTINGS = "Settings → MCP servers";
/** Why a saved credential can't be used for a run's calls, each with its own remedy and no other, as the model reads it
 *  after "The MCP server <name>'s credential can't be used right now: " (mcp-gateway.ts). The one place they are said. */
export const UNUSABLE = {
  /** This server was started without its seal key. */
  noSealKey: `this server was started without its seal key (${SEAL_KEY_ENV}); start it with the key the credential was saved under, or update the credential in ${MCP_SETTINGS}`,
  /** Sealed under another seal key, or damaged. */
  damaged: `it was sealed under another seal key, or damaged; update it in ${MCP_SETTINGS}`,
  /** An OAuth sign-in its authorization server refused to refresh, or with no refresh token left. */
  signedOut: `its sign-in expired or was revoked: ${SIGN_IN_AGAIN}`,
  /** An access token past its expiry whose refresh got no answer: the sign-in itself is fine. */
  silent: "the sign-in server didn't answer; try again",
} as const;
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** How long an access token given with no expiry is taken to last: it is refreshed within the margin of then. */
export const UNKNOWN_EXPIRY_MS = 60 * 60_000;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const REQUEST_MS = 15_000;
const PREVIEW_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 2 ** 20;
const MAX_URL = 2048;
const MAX_VALUE_BYTES = 8192;
const MAX_HEADERS = 8;
/** What one server's snapshot may hold: every list and get reads it back whole. */
const MAX_TOOLS = 500;
const MAX_SNAPSHOT_BYTES = 2 ** 20;
const MAX_PAGES = 64;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Headers the transport sets itself, or that name the connection rather than the person. */
const RESERVED = new Set(["accept", "connection", "content-length", "content-type", "host", "last-event-id", "mcp-method", "mcp-name", "mcp-protocol-version", "mcp-session-id", "transfer-encoding"]);
const LOOPBACK_V4 = /^127(?:[.]\d{1,3}){3}$/;
const LOOPBACK_NAMES = ["localhost", "[::1]"]; // key-gate: loopback-rule plain http is allowed only to these hosts
const LOOPBACK = (host: string) => LOOPBACK_NAMES.includes(host) || LOOPBACK_V4.test(host);

export type AuthType = (typeof MCP_AUTH_TYPES)[number];
export type McpTool = { name: string; title?: string; description?: string; input_schema: unknown; output_schema?: unknown; annotations?: unknown };
/** A registry tool (input_schema, as the server listed it) in the harnesses' shape (the kernel's McpTool: inputSchema),
 *  as a run is pinned to it and a session binds it. */
export function boundTool(tool: McpTool): { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> } {
  return { name: tool.name, ...(tool.title ? { title: tool.title } : {}), ...(tool.description ? { description: tool.description } : {}), inputSchema: (tool.input_schema ?? {}) as Record<string, unknown>, ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}) };
}
export type Listed = { protocol: string; server_info: unknown; instructions?: string; tools: McpTool[] };
/** A tool's declared price in USD a call, by its name: what a run's cap holds and books for each call (mcp-gateway.ts). */
export type McpPrices = Record<string, number>;
export type HeaderMap = Record<string, string>;
export type Auth = { type: AuthType; headers?: HeaderMap };

/** How a server gets a seal key: what its launcher does (launcher/agentrun-serve). */
export const SEAL_KEY_HOW = `Start it with its launcher, agentrun-serve, which keeps one in agentrun/seal.key under $XDG_CONFIG_HOME (~/.config by default), made at the first start, 0600 in a 0700 directory; or hand it ${SEAL_KEY_ENV} (32 random bytes in base64).`;

export const notFound = (name: string) => new ApiError("not_found", `No MCP server ${name}: GET /v2/settings/mcp-servers lists them.`);
export const credentialMissing = (type: AuthType, message: string): InputIssue => ({ field: type === "bearer" ? "auth.token" : type === "oauth" ? "auth.type" : "auth.headers", reason: "missing", message: type === "oauth" ? `${message} An OAuth server is signed in to first: POST /v2/settings/mcp-servers/{name}/oauth/start.` : message });
export const nameOf = (name: string) => {
  if (!MCP_SERVER_NAME.test(name)) throw invalid([{ field: "name", reason: "invalid", message: "A server's name is 1 to 32 lowercase letters, digits and dashes, starting with a letter (no underscores, so mcp__<server>__<tool> splits one way)." }]);
  if (RESERVED_MCP_NAMES.includes(name)) throw invalid([{ field: "name", reason: "reserved", message: `'${name}' is reserved for AgentRun's own tools: a server under it would take their names and their permissions. Name the server another way.` }]);
};

/** `prices` for the tools `listed` still holds: a tool gone takes its price with it. Keyed by tool names with no prototype. */
export function pricesListed(prices: McpPrices | undefined, listed: readonly { name: string }[]): McpPrices {
  return Object.assign(Object.create(null), Object.fromEntries(Object.entries(prices ?? {}).filter(([tool]) => listed.some((t) => t.name === tool)))) as McpPrices;
}

/** `listed` with each known meta tool (mcp-meta.ts) marked `grantable: false` with its reason. */
export function marked<T extends { tools: McpTool[] }>(url: string, listed: T): T & { tools: (McpTool & { grantable?: false; reason?: string })[] } {
  return { ...listed, tools: listed.tools.map((tool) => {
    const meta = metaToolOf(url, tool.name);
    return meta ? { ...tool, grantable: false as const, reason: meta.reason } : tool;
  }) };
}

/** `text` with every credential value cut out: each header's value, and a bearer's token alone, which a server may
 *  echo without its scheme. */
export const scrub = (text: string, headers: HeaderMap): string =>
  Object.values(headers).flatMap((value) => [value, /^Bearer\s+(.+)$/i.exec(value)?.[1]]).filter((value): value is string => !!value).sort((a, b) => b.length - a.length).reduce((cut, value) => cut.split(value).join("[credential]"), text);

/** JSON with sorted keys, so two listings of one tool compare equal whatever order the server sends its fields in. */
export const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : isObject(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";

/** The body's prices: each tool's USD a call, a finite number, 0 or more. Which tools the server lists is checked once
 *  it has listed them. */
export function pricesOf(value: unknown, issues: InputIssue[]): McpPrices | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return void issues.push({ field: "prices", reason: "wrong_type", message: "prices is an object of the server's tool names to their price in USD a call." });
  const bad = Object.entries(value).filter(([, usd]) => typeof usd !== "number" || !Number.isFinite(usd) || usd < 0);
  for (const [tool] of bad) issues.push({ field: `prices.${tool}`, reason: "invalid", message: `prices.${tool} is a price in USD a call: a finite number, 0 or more.` });
  // Keyed by tool names, which may be an object's own properties (`__proto__`): no prototype to fall into.
  return bad.length ? undefined : (Object.assign(Object.create(null), value) as McpPrices);
}

export function urlOf(value: unknown, issues: InputIssue[]): URL | undefined {
  if (typeof value !== "string" || value === "") return void issues.push({ field: "url", reason: value === undefined ? "missing" : "wrong_type", message: "url is the MCP server's Streamable HTTP endpoint, as text." });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return void issues.push({ field: "url", reason: "invalid", message: "url is not a URL." });
  }
  if (value.length > MAX_URL) issues.push({ field: "url", reason: "too_long", message: `url is at most ${MAX_URL} characters.` });
  else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds a user or password: send a credential as auth instead." });
  else if (url.protocol === "http:" && !LOOPBACK(url.hostname)) issues.push({ field: "url", reason: "not_https", message: `url is http://${url.host}, which is not this machine's loopback: use https, or http only on loopback.` });
  else if (url.protocol !== "https:" && url.protocol !== "http:") issues.push({ field: "url", reason: "invalid", message: "url is https, or http on loopback." });
  url.hash = "";
  return url;
}

/** The body's auth: its type and, when it sends one, its credential as the headers it becomes. */
export function authOf(value: unknown, issues: InputIssue[]): Auth | undefined {
  if (value === undefined) return { type: "none" };
  if (!isObject(value)) return void issues.push({ field: "auth", reason: "wrong_type", message: "auth is {type: none|bearer|headers|oauth, token?, headers?}." });
  const before = issues.length;
  issues.push(...unknownFields(value, ["type", "token", "headers"]).map((issue) => ({ ...issue, field: `auth.${issue.field}` })));
  const type = value.type;
  if (!(MCP_AUTH_TYPES as readonly unknown[]).includes(type)) return void issues.push({ field: "auth.type", reason: "not_an_option", message: `auth.type is one of ${MCP_AUTH_TYPES.join(", ")}.` });
  const check = (field: string, text: unknown) => {
    if (typeof text !== "string" || text === "") issues.push({ field, reason: "wrong_type", message: `${field} is text, not empty.` });
    else if (CONTROL.test(text)) issues.push({ field, reason: "invalid", message: `${field} holds a control character.` });
    else if (Buffer.byteLength(text) > MAX_VALUE_BYTES) issues.push({ field, reason: "too_long", message: `${field} is at most ${MAX_VALUE_BYTES} bytes.` });
  };
  let headers: HeaderMap | undefined;
  if ((type === "none" || type === "oauth") && (value.token !== undefined || value.headers !== undefined)) issues.push({ field: "auth", reason: "not_allowed", message: type === "none" ? "auth.type none sends no credential." : "auth.type oauth takes its credential from a sign-in, never from a body." });
  if (type === "bearer") {
    if (value.headers !== undefined) issues.push({ field: "auth.headers", reason: "not_allowed", message: "A bearer credential is auth.token." });
    if (value.token !== undefined) {
      check("auth.token", value.token);
      headers = { authorization: `Bearer ${String(value.token)}` };
    }
  }
  if (type === "headers") {
    if (value.token !== undefined) issues.push({ field: "auth.token", reason: "not_allowed", message: "Named headers are auth.headers." });
    if (value.headers !== undefined) {
      const entries = isObject(value.headers) ? Object.entries(value.headers) : [];
      if (!entries.length || entries.length > MAX_HEADERS) issues.push({ field: "auth.headers", reason: "invalid", message: `auth.headers names 1 to ${MAX_HEADERS} headers and their values.` });
      headers = Object.create(null) as HeaderMap;
      for (const [name, text] of entries) {
        const lower = name.toLowerCase();
        if (!HEADER_NAME.test(name) || RESERVED.has(lower)) issues.push({ field: `auth.headers.${name}`, reason: "invalid", message: `${name} is not a header a credential may be sent in.` });
        else if (lower in headers) issues.push({ field: `auth.headers.${name}`, reason: "duplicate", message: `${name} is named twice.` });
        check(`auth.headers.${name}`, text);
        headers[lower] = String(text);
      }
    }
  }
  return issues.length > before ? undefined : { type: type as AuthType, ...(headers ? { headers } : {}) };
}

/** The OAuth scope list a sign-in body may send: 1 to 32 OAuth scopes. */
export const scopesValid = (scopes: unknown): boolean => Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 32 && scopes.every((scope) => typeof scope === "string" && SCOPE.test(scope));
/** The longest an OAuth client id or secret a sign-in body may send. */
export const MAX_OAUTH_VALUE_BYTES = MAX_VALUE_BYTES;
/** Whether an OAuth client id or secret a sign-in body sends is well formed (text, not empty, no control, within the cap). */
export const oauthValueValid = (text: unknown): boolean => typeof text === "string" && text !== "" && !CONTROL.test(text) && Buffer.byteLength(text) <= MAX_VALUE_BYTES;

/** What a response said about itself, for telling failures apart: the SDK's errors do not say whether a URL speaks MCP
 *  at all, or what a 401 asked for. */
type Seen = { status: number; headers: globalThis.Headers; rpc: Promise<boolean> };

/** Connect to `url`, agree a protocol revision, and list every tool (all pages), each request held to REQUEST_MS and
 *  MAX_RESPONSE_BYTES and the whole to PREVIEW_MS. A failure is an ApiError: 422 auth_required (with the auth the
 *  server asks for), 422 not_mcp, 422 input_invalid for a redirect, else 424 upstream_failed. */
export async function listServer(url: URL, headers: HeaderMap, version: string, stop?: AbortSignal): Promise<Listed> {
  const sdk = await import("@modelcontextprotocol/client");
  const deadline = AbortSignal.any([AbortSignal.timeout(PREVIEW_MS), ...(stop ? [stop] : [])]);
  const seen: Seen[] = [];
  let overflow = false;
  const watched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_MS), ...(init?.signal ? [init.signal] : [])]);
    const res = await fetch(input, { ...init, redirect: "manual", signal });
    const type = res.headers.get("content-type") ?? "";
    seen.push({ status: res.status, headers: res.headers, rpc: type.startsWith("text/event-stream") ? Promise.resolve(true) : type.includes("json") ? speaksJsonRpc(res.clone()) : Promise.resolve(false) });
    return capped(res, () => (overflow = true));
  };
  const transport = new sdk.StreamableHTTPClientTransport(url, { fetch: watched, requestInit: { headers, redirect: "manual" } });
  const client = new sdk.Client({ name: "agentrun-serve", version }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(transport, { timeout: REQUEST_MS, signal: deadline });
    // Paged here rather than by listTools(), which reads every page before answering: a snapshot past its caps
    // stops at the page that crosses them.
    const tools: McpTool[] = [];
    let bytes = 0;
    if (client.getServerCapabilities()?.tools) {
      for (let cursor: string | undefined, pages = 0; ; ) {
        const page = await client.request({ method: "tools/list", ...(cursor !== undefined ? { params: { cursor } } : {}) }, { timeout: PREVIEW_MS, signal: deadline });
        for (const tool of page.tools) {
          const kept: McpTool = {
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            input_schema: tool.inputSchema,
            ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          };
          tools.push(kept);
          bytes += Buffer.byteLength(JSON.stringify(kept));
          if (tools.length > MAX_TOOLS) throw invalid([{ field: "url", reason: "too_many_tools", message: `This server lists more than ${MAX_TOOLS} tools (${tools.length} so far, listing stopped): a server is kept with at most ${MAX_TOOLS}.` }]);
          if (bytes > MAX_SNAPSHOT_BYTES) throw invalid([{ field: "url", reason: "tools_too_large", message: `This server's tools come to more than ${MAX_SNAPSHOT_BYTES / 2 ** 20} MiB of names, descriptions and schemas (${tools.length} tools so far, listing stopped): a server is kept with at most ${MAX_SNAPSHOT_BYTES / 2 ** 20} MiB.` }]);
        }
        if (page.nextCursor === undefined || page.nextCursor === cursor) break;
        if (++pages >= MAX_PAGES) throw new ApiError("upstream_failed", `The MCP server's tool list did not end within ${MAX_PAGES} pages.`);
        cursor = page.nextCursor;
      }
    }
    const instructions = client.getInstructions();
    return {
      protocol: client.getNegotiatedProtocolVersion() ?? "unknown",
      server_info: client.getServerVersion() ?? null,
      ...(instructions ? { instructions } : {}),
      tools,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw await refusal(error, seen, overflow, url, headers, deadline, sdk);
  } finally {
    await client.close().catch(() => {});
  }
}

async function refusal(error: unknown, seen: Seen[], overflow: boolean, url: URL, headers: HeaderMap, deadline: AbortSignal, sdk: typeof import("@modelcontextprotocol/client")): Promise<ApiError> {
  const upstream = (message: string, status?: number) => new ApiError("upstream_failed", message, status ? { details: { status } } : {});
  if (overflow) return upstream(`The MCP server answered more than ${MAX_RESPONSE_BYTES / 2 ** 20} MiB in one response.`);
  const redirect = seen.find((one) => one.status >= 300 && one.status < 400);
  if (redirect) {
    const to = redirect.headers.get("location");
    let where = to?.slice(0, 200);
    try {
      if (to) where = new URL(to, url).href;
    } catch {}
    return invalid([{ field: "url", reason: "redirect", message: scrub(`The MCP server answered ${redirect.status}${where ? `, pointing to ${where}` : ""}. Redirects are not followed, so a credential goes only where you send it: use the address it points to.`, headers) }]);
  }
  const denied = seen.find((one) => one.status === 401 || one.status === 403);
  if (denied) {
    const auth = await authAsked(url, denied.headers, deadline, sdk);
    const sent = Object.keys(headers).length > 0;
    const asks = auth === "oauth" ? `It signs in with OAuth: ${sent ? `${SIGN_IN_AGAIN}, or ` : ""}sign in with POST /v2/settings/mcp-servers/{name}/oauth/start and its url.` : "Send a bearer token or the headers it takes.";
    return new ApiError("auth_required", `The MCP server ${sent ? "refused the credential sent" : "asks for a credential"} (HTTP ${denied.status}). ${asks}`, { details: { auth, status: denied.status } });
  }
  const failed = seen.find((one) => one.status >= 500);
  if (failed) return upstream(`The MCP server answered HTTP ${failed.status}.`, failed.status);
  if (!seen.length) {
    if (deadline.aborted || timedOut(error)) return upstream(`The MCP server did not answer within ${REQUEST_MS / 1000} s.`);
    return upstream(`Could not reach the MCP server at ${url.origin}${causeCode(error) ? ` (${causeCode(error)})` : ""}.`);
  }
  if (!(await Promise.all(seen.map((one) => one.rpc))).some(Boolean)) return new ApiError("not_mcp", `${url.href} does not speak MCP over Streamable HTTP: it answered HTTP ${seen.at(-1)!.status} with no JSON-RPC reply.`);
  // The listing's own limit when it was the one that ran out, else one request's.
  if (deadline.aborted || timedOut(error)) return upstream(deadline.aborted ? `The MCP server did not finish listing its tools within ${PREVIEW_MS / 1000} s.` : `The MCP server did not answer a request within ${REQUEST_MS / 1000} s.`);
  // Cut every credential value from the SDK's words: a server may echo what it was sent.
  const said = scrub(error instanceof Error ? error.message : String(error), headers);
  return upstream(`The MCP server failed to list its tools: ${said.slice(0, 300)}`);
}

/** What a 401 or 403 asks for: `oauth` when the server names protected-resource metadata (its WWW-Authenticate, or a
 *  well-known document naming an authorization server), else `bearer`. The probe sends no credential. */
async function authAsked(url: URL, headers: globalThis.Headers, deadline: AbortSignal, sdk: typeof import("@modelcontextprotocol/client")): Promise<"oauth" | "bearer"> {
  if (sdk.extractWWWAuthenticateParams(new Response(null, { headers })).resourceMetadataUrl) return "oauth";
  try {
    const probe = async (input: string | URL | Request, init?: RequestInit) => capped(await fetch(input, { ...init, redirect: "manual", signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]) }), () => {});
    const metadata = await sdk.discoverOAuthProtectedResourceMetadata(url, undefined, probe);
    return metadata.authorization_servers?.length ? "oauth" : "bearer";
  } catch {
    return "bearer";
  }
}

/** Whether a JSON body is a JSON-RPC message, read no further than its first 64 KiB. */
async function speaksJsonRpc(res: Response): Promise<boolean> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return false;
    let text = "";
    for (let chunk = await reader.read(); !chunk.done && text.length < 65_536; chunk = await reader.read()) text += Buffer.from(chunk.value).toString("utf8");
    await reader.cancel().catch(() => {});
    return /"jsonrpc"\s*:\s*"2\.0"/.test(text);
  } catch {
    return false;
  }
}

/** `res` with its body cut off at MAX_RESPONSE_BYTES, `over` told when it is. */
function capped(res: Response, over: () => void): Response {
  if (!res.body || [101, 204, 205, 304].includes(res.status)) return res;
  let bytes = 0;
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        over();
        out.error(new Error(`response over ${MAX_RESPONSE_BYTES} bytes`));
      } else out.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const timedOut = (error: unknown): boolean => {
  for (let at = error; at instanceof Error; at = at.cause) if (at.name === "TimeoutError" || at.name === "AbortError" || /timed? ?out/i.test(at.message)) return true;
  return false;
};
const causeCode = (error: unknown): string | undefined => {
  for (let at = error; isObject(at); at = (at as { cause?: unknown }).cause) if (typeof at.code === "string" && /^E[A-Z]+$/.test(at.code)) return at.code;
  return undefined;
};
