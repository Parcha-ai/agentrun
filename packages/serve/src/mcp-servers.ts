// Remote MCP servers a person adds through /v2/settings/mcp-servers. A preview connects with the official SDK client
// (@modelcontextprotocol/client: 2026-07-28 first, 2025-era servers by its fallback), lists every tool and stores
// nothing. A save previews, then keeps the URL, the tool snapshot the person saw and the credential in
// DIR/mcp-servers.json (0600, written whole, synced, renamed), each header value sealed (AES-256-GCM, tool-keys.ts' seal
// key) and bound to `mcp:<server>:<header>`, so a value moved to another server or header does not open. No read
// returns a credential. No redirect is followed: a credential goes only to the URL the person gave.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { isObject, unknownFields } from "./validate.js";

export const MCP_SERVERS_FILE = "mcp-servers.json";
const FORMAT = "mcp-servers/1";
export const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MCP_AUTH_TYPES = ["none", "bearer", "headers"] as const;
const REQUEST_MS = 15_000;
const PREVIEW_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 2 ** 20;
const MAX_URL = 2048;
const MAX_VALUE_BYTES = 8192;
const MAX_HEADERS = 8;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Headers the transport sets itself, or that name the connection rather than the person. */
const RESERVED = new Set(["accept", "connection", "content-length", "content-type", "host", "last-event-id", "mcp-method", "mcp-name", "mcp-protocol-version", "mcp-session-id", "transfer-encoding"]);
const LOOPBACK_V4 = /^127(?:[.]\d{1,3}){3}$/;
const LOOPBACK_NAMES = ["localhost", "[::1]"]; // key-gate: loopback-rule plain http is allowed only to these hosts
const LOOPBACK = (host: string) => LOOPBACK_NAMES.includes(host) || LOOPBACK_V4.test(host);

type AuthType = (typeof MCP_AUTH_TYPES)[number];
export type McpTool = { name: string; title?: string; description?: string; input_schema: unknown; output_schema?: unknown; annotations?: unknown };
type Listed = { protocol: string; server_info: unknown; instructions?: string; tools: McpTool[] };
type Kept = Listed & { url: string; auth: { type: AuthType; sealed?: Record<string, string>; check?: string }; listed_at: string; updated_at: string };
type HeaderMap = Record<string, string>;
type Auth = { type: AuthType; headers?: HeaderMap };

export class McpServers {
  readonly file: string;
  private readonly key: Buffer | undefined;
  private readonly sealCheck: string | undefined;

  constructor(data: string, env: NodeJS.ProcessEnv, private readonly version: string) {
    this.file = join(data, MCP_SERVERS_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    this.sealCheck = this.key && createHmac("sha256", this.key).update(`agentrun-serve ${FORMAT} key check`).digest("base64url");
  }

  get atRest(): "sealed" | "unavailable" {
    return this.key ? "sealed" : "unavailable";
  }

  list() {
    const servers = this.kept();
    if (servers === "unreadable") return { servers: [], file_unreadable: true as const };
    return { servers: Object.keys(servers).sort().map((name) => this.view(name, servers[name]!)) };
  }

  get(name: string) {
    return this.view(name, this.need(name));
  }

  /** POST preview: `{url, auth}`, or `{name}` for a saved server with its sealed credential. Stores nothing. */
  async preview(body: Record<string, unknown>, stop?: AbortSignal): Promise<Listed> {
    if (body.name !== undefined && body.url === undefined) {
      const issues = unknownFields(body, ["name"]);
      if (issues.length) throw invalid(issues);
      const name = String(body.name);
      const kept = this.need(name);
      return listServer(new URL(kept.url), this.opened(name, kept, "name"), this.version, stop);
    }
    const { url, auth } = this.admit(body);
    if (auth.type !== "none" && !auth.headers) throw invalid([credentialMissing(auth.type, "A preview needs the credential it is to connect with.")]);
    return listServer(url, auth.headers ?? {}, this.version, stop);
  }

  /** PUT: preview, then keep the server with the tools listed. A body with no credential keeps the sealed one, while
   *  the auth type and the URL's origin stay the same. */
  async save(name: string, body: Record<string, unknown>, stop?: AbortSignal) {
    if (!MCP_SERVER_NAME.test(name)) throw invalid([{ field: "name", reason: "invalid", message: "A server's name is 1 to 32 lowercase letters, digits and dashes, starting with a letter (no underscores, so mcp__<server>__<tool> splits one way)." }]);
    const { url, auth } = this.admit(body);
    if (auth.type !== "none" && !this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no MCP server credential: it never keeps one in the clear.`);
    const was = this.servers()[name];
    let headers = auth.headers;
    if (auth.type !== "none" && !headers) {
      if (!was || was.auth.type !== auth.type) throw invalid([credentialMissing(auth.type, `The server ${name} has no saved ${auth.type} credential to keep.`)]);
      if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the credential again, so a saved one never goes to another origin.`)]);
      headers = this.opened(name, was, auth.type === "bearer" ? "auth.token" : "auth.headers");
    }
    const listed = await listServer(url, headers ?? {}, this.version, stop);
    const now = new Date().toISOString();
    const sealed = headers && Object.fromEntries(Object.entries(headers).map(([header, value]) => [header, seal(this.key!, Buffer.from(value, "utf8"), aad(name, header)).toString("base64")]));
    const servers = this.servers();
    servers[name] = { url: url.href, auth: { type: auth.type, ...(sealed ? { sealed, check: this.sealCheck } : {}) }, ...listed, listed_at: now, updated_at: now };
    this.write(servers);
    return this.view(name, servers[name]);
  }

  /** POST refresh: list the saved server's tools again, keep them, and say what was added, removed and changed. */
  async refresh(name: string, stop?: AbortSignal) {
    const was = this.need(name);
    const listed = await listServer(new URL(was.url), this.opened(name, was, "name"), this.version, stop);
    const servers = this.servers();
    const now = servers[name];
    if (!now) throw notFound(name);
    if (now.url !== was.url) throw new ApiError("unavailable", `The server ${name} was changed while its tools were listed: refresh it again.`);
    const before = new Map(now.tools.map((tool) => [tool.name, canonical(tool)]));
    const after = new Map(listed.tools.map((tool) => [tool.name, canonical(tool)]));
    servers[name] = { ...now, ...listed, listed_at: new Date().toISOString() };
    this.write(servers);
    return {
      added: [...after.keys()].filter((tool) => !before.has(tool)),
      removed: [...before.keys()].filter((tool) => !after.has(tool)),
      changed: [...after.keys()].filter((tool) => before.has(tool) && before.get(tool) !== after.get(tool)),
      server: this.view(name, servers[name]!),
    };
  }

  remove(name: string): void {
    const servers = this.servers();
    if (!servers[name]) throw notFound(name);
    delete servers[name];
    this.write(servers);
  }

  private need(name: string): Kept {
    const kept = this.servers()[name];
    if (!kept) throw notFound(name);
    return kept;
  }

  private view(name: string, kept: Kept) {
    const { auth, ...rest } = kept;
    const opened = auth.type === "none" ? null : this.open(name, kept);
    return {
      name,
      ...rest,
      auth: { type: auth.type, ...(auth.type === "headers" ? { headers: Object.keys(auth.sealed ?? {}) } : {}) },
      credential: opened === null ? null : "headers" in opened ? ("sealed" as const) : opened.unreadable,
    };
  }

  private open(name: string, kept: Kept): { headers: HeaderMap } | { unreadable: "seal_key_missing" | "unreadable" } {
    if (!this.key) return { unreadable: "seal_key_missing" };
    if (kept.auth.check !== this.sealCheck || !isObject(kept.auth.sealed)) return { unreadable: "unreadable" };
    try {
      return { headers: Object.fromEntries(Object.entries(kept.auth.sealed).map(([header, value]) => [header, unseal(this.key!, Buffer.from(value, "base64"), aad(name, header)).toString("utf8")])) };
    } catch {
      return { unreadable: "unreadable" };
    }
  }

  /** The saved credential, opened, or the refusal that asks for it again. */
  private opened(name: string, kept: Kept, field: string): HeaderMap {
    if (kept.auth.type === "none") return {};
    const opened = this.open(name, kept);
    if ("headers" in opened) return opened.headers;
    if (opened.unreadable === "seal_key_missing") throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so the saved credential of ${name} does not open.`);
    throw invalid([{ field, reason: "missing", message: `The saved credential of ${name} does not open here (sealed under another seal key, or damaged): send it again.` }]);
  }

  /** A body's URL and auth, or 422. */
  private admit(body: Record<string, unknown>): { url: URL; auth: Auth } {
    const issues = unknownFields(body, ["url", "auth"]);
    const url = urlOf(body.url, issues);
    const auth = authOf(body.auth, issues);
    if (issues.length) throw invalid(issues);
    return { url: url!, auth: auth! };
  }

  /** The saved servers: none with no file, "unreadable" when the file does not read as this format. */
  private kept(): Record<string, Kept> | "unreadable" {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return isObject(doc) && doc.format === FORMAT && isObject(doc.servers) ? ({ ...doc.servers } as Record<string, Kept>) : "unreadable";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : "unreadable";
    }
  }

  /** The saved servers, or 409: a file that does not read is never written over, so no saved server is lost to it. */
  private servers(): Record<string, Kept> {
    const kept = this.kept();
    if (kept === "unreadable") throw new ApiError("store_unreadable", `${MCP_SERVERS_FILE} in the data directory does not read as ${FORMAT}: nothing is read from it or written to it until it is restored or removed.`);
    return kept;
  }

  private write(servers: Record<string, Kept>): void {
    writeDurableSync(this.file, `${JSON.stringify({ format: FORMAT, servers }, null, 2)}\n`);
  }
}

const aad = (name: string, header: string) => `mcp:${name}:${header}`;
const notFound = (name: string) => new ApiError("not_found", `No MCP server ${name}: GET /v2/settings/mcp-servers lists them.`);
const credentialMissing = (type: AuthType, message: string): InputIssue => ({ field: type === "bearer" ? "auth.token" : "auth.headers", reason: "missing", message });

/** JSON with sorted keys, so two listings of one tool compare equal whatever order the server sends its fields in. */
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : isObject(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";

function urlOf(value: unknown, issues: InputIssue[]): URL | undefined {
  if (typeof value !== "string" || value === "") return void issues.push({ field: "url", reason: value === undefined ? "missing" : "wrong_type", message: "url is the MCP server's Streamable HTTP endpoint, as text." });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return void issues.push({ field: "url", reason: "invalid", message: "url is not a URL." });
  }
  if (value.length > MAX_URL) issues.push({ field: "url", reason: "too_long", message: `url is at most ${MAX_URL} characters.` });
  else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds a user or password: send a credential as auth instead." });
  else if (url.protocol === "http:" && !LOOPBACK(url.hostname)) issues.push({ field: "url", reason: "not_https", message: "url is https, or http on this machine's loopback." });
  else if (url.protocol !== "https:" && url.protocol !== "http:") issues.push({ field: "url", reason: "invalid", message: "url is https, or http on loopback." });
  url.hash = "";
  return url;
}

/** The body's auth: its type and, when it sends one, its credential as the headers it becomes. */
function authOf(value: unknown, issues: InputIssue[]): Auth | undefined {
  if (value === undefined) return { type: "none" };
  if (!isObject(value)) return void issues.push({ field: "auth", reason: "wrong_type", message: "auth is {type: none|bearer|headers, token?, headers?}." });
  const before = issues.length;
  issues.push(...unknownFields(value, ["type", "token", "headers"]).map((issue) => ({ ...issue, field: `auth.${issue.field}` })));
  const type = value.type;
  if (type === "oauth") return void issues.push({ field: "auth.type", reason: "not_yet", message: "OAuth sign-in to an MCP server is not here yet: use a bearer token or named headers the server accepts." });
  if (!(MCP_AUTH_TYPES as readonly unknown[]).includes(type)) return void issues.push({ field: "auth.type", reason: "not_an_option", message: `auth.type is one of ${MCP_AUTH_TYPES.join(", ")}.` });
  const check = (field: string, text: unknown) => {
    if (typeof text !== "string" || text === "") issues.push({ field, reason: "wrong_type", message: `${field} is text, not empty.` });
    else if (CONTROL.test(text)) issues.push({ field, reason: "invalid", message: `${field} holds a control character.` });
    else if (Buffer.byteLength(text) > MAX_VALUE_BYTES) issues.push({ field, reason: "too_long", message: `${field} is at most ${MAX_VALUE_BYTES} bytes.` });
  };
  let headers: HeaderMap | undefined;
  if (type === "none" && (value.token !== undefined || value.headers !== undefined)) issues.push({ field: "auth", reason: "not_allowed", message: "auth.type none sends no credential." });
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
      headers = {};
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

/** What a response said about itself, for telling failures apart: the SDK's errors do not say whether a URL speaks MCP
 *  at all, or what a 401 asked for. */
type Seen = { status: number; headers: globalThis.Headers; rpc: Promise<boolean> };

/** Connect to `url`, agree a protocol revision, and list every tool (all pages), each request held to REQUEST_MS and
 *  MAX_RESPONSE_BYTES and the whole to PREVIEW_MS. A failure is an ApiError: 422 auth_required (with the auth the
 *  server asks for), 422 not_mcp, 422 input_invalid for a redirect, else 424 upstream_failed. */
async function listServer(url: URL, headers: HeaderMap, version: string, stop?: AbortSignal): Promise<Listed> {
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
    const { tools } = await client.listTools(undefined, { timeout: PREVIEW_MS, signal: deadline });
    const instructions = client.getInstructions();
    return {
      protocol: client.getNegotiatedProtocolVersion() ?? "unknown",
      server_info: client.getServerVersion() ?? null,
      ...(instructions ? { instructions } : {}),
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: tool.inputSchema,
        ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    };
  } catch (error) {
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
    return invalid([{ field: "url", reason: "redirect", message: `The MCP server answered ${redirect.status}${to ? `, pointing to ${new URL(to, url).href}` : ""}. Redirects are not followed, so a credential goes only where you send it: use the address it points to.` }]);
  }
  const denied = seen.find((one) => one.status === 401 || one.status === 403);
  if (denied) {
    const auth = await authAsked(url, denied.headers, sdk);
    const sent = Object.keys(headers).length > 0;
    const asks = auth === "oauth" ? "It signs in with OAuth, which is not here yet; a bearer token or headers it accepts work." : "Send a bearer token or the headers it takes.";
    return new ApiError("auth_required", `The MCP server ${sent ? "refused the credential sent" : "asks for a credential"} (HTTP ${denied.status}). ${asks}`, { details: { auth, status: denied.status } });
  }
  const failed = seen.find((one) => one.status >= 500);
  if (failed) return upstream(`The MCP server answered HTTP ${failed.status}.`, failed.status);
  if (!seen.length) {
    if (deadline.aborted || timedOut(error)) return upstream(`The MCP server did not answer within ${REQUEST_MS / 1000} s.`);
    return upstream(`Could not reach the MCP server at ${url.origin}${causeCode(error) ? ` (${causeCode(error)})` : ""}.`);
  }
  if (!(await Promise.all(seen.map((one) => one.rpc))).some(Boolean)) return new ApiError("not_mcp", `${url.href} does not speak MCP over Streamable HTTP: it answered HTTP ${seen.at(-1)!.status} with no JSON-RPC reply.`);
  if (deadline.aborted || timedOut(error)) return upstream(`The MCP server did not finish listing its tools within ${PREVIEW_MS / 1000} s.`);
  // Cut every credential value from the SDK's words: a server may echo what it was sent.
  const said = Object.values(headers).reduce((text, value) => text.split(value).join("[credential]"), error instanceof Error ? error.message : String(error));
  return upstream(`The MCP server failed to list its tools: ${said.slice(0, 300)}`);
}

/** What a 401 or 403 asks for: `oauth` when the server names protected-resource metadata (its WWW-Authenticate, or a
 *  well-known document naming an authorization server), else `bearer`. The probe sends no credential. */
async function authAsked(url: URL, headers: globalThis.Headers, sdk: typeof import("@modelcontextprotocol/client")): Promise<"oauth" | "bearer"> {
  if (sdk.extractWWWAuthenticateParams(new Response(null, { headers })).resourceMetadataUrl) return "oauth";
  try {
    const probe = (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(5_000) });
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
