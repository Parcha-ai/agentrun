import { ClientError } from "./client";
import type { Permission } from "./v2";

/** A tool as a remote MCP server lists it (`tools/list`, through the server's preview). */
/** A tool as a server lists it; on a saved server's read, with its permission as this server applies it to an agent that
 *  sets none (`permission`, under the server's tool settings), the owner's default and those it may be set to. */
export type McpTool = { name: string; title?: string; description?: string; input_schema?: unknown; permission?: Permission; default_permission?: Permission; permissions?: Permission[] };
export type McpAuthType = "none" | "bearer" | "headers" | "oauth";
/** A saved MCP server as GET /v2/settings/mcp-servers shows it: never a credential, only its state (`credential`: null
 *  for one that takes none). `prices`, per tool in USD, only when the server meters them. */
export type McpServer = {
  /** The tools it lists that no price meters (the read's `not_metered`): absent when every tool has a price. */
  not_metered?: string[];
  /** Its credential as every secret is read: set or not, how it came, when it last changed. Never a value. */
  secret?: { name: string; set: boolean; source: "env" | "console" | "sign-in" | null; changed_at: string | null };
  name: string; url: string; auth: { type: McpAuthType; headers?: string[] }; tools: McpTool[]; protocol?: string; listed_at?: string; updated_at?: string;
  credential: "sealed" | "unreadable" | "expired" | null;
  oauth?: { expires_at?: string; scopes: string[]; client: string; client_id?: string };
  prices?: Record<string, number>;
};
export type McpPreview = { protocol: string; server_info?: { name?: string; version?: string }; instructions?: string; tools: McpTool[] };
export type McpRefresh = { added: string[]; removed: string[]; changed: string[]; server: McpServer };
/** What a preview or save sends as `auth`: a credential only when one was typed (none: keep the sealed one). */
export type McpAuth = { type: Exclude<McpAuthType, "oauth"> | "oauth"; token?: string; headers?: Record<string, string> };
/** Capabilities' `features.mcp_client`. */
export type McpClientFeature = { auth?: string[]; harnesses?: string[] };

/** The grant `definition.tools` holds for a server's tool, and the server and tool a grant names (null: not one). */
export const mcpGrant = (server: string, tool: string) => `mcp:${server}/${tool}`;
export function grantOf(name: string): { server: string; tool: string } | null {
  const m = /^mcp:([^/]+)\/(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** The wire name budget a grant's `mcp__<server>__<tool>` must fit (packages/serve/src/catalog.ts, WIRE_NAME). */
const WIRE_NAME = /^[A-Za-z0-9_-]{1,52}$/;
/** Why the server's save refuses a grant by its name alone (packages/serve/src/runnable.ts): the server is named like
 *  the harnesses' own tools, or its wire name `mcp__<server>__<tool>` is not its own (a character a tool name can't
 *  carry) or is past the budget. Undefined when the name can be granted. */
export function grantNameProblem(server: string, tool: string): string | undefined {
  if (server === "hands") return "hands is the harnesses' own name: save this server under another to grant its tools";
  const wire = `mcp__${server}__${tool}`;
  if (WIRE_NAME.test(wire)) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(tool) ? `name too long to grant (${wire.length}/52)` : "its name has a character a tool name can't carry";
}

/** Why the save refuses a grant of `tool` on `harness`: its name (grantNameProblem), or, on claude-agent, a root
 *  `anyOf`, `allOf` or `oneOf` in its input schema, which the Claude Agent CLI drops the tool for (runnable.ts). The
 *  save's other schema checks are its own: a refusal of one is said at the field. */
export function grantProblem(server: string, tool: McpTool, harness: string): string | undefined {
  const schema = tool.input_schema;
  const root = harness === "claude-agent" && schema && typeof schema === "object" ? ["anyOf", "allOf", "oneOf"].find((key) => key in schema) : undefined;
  return grantNameProblem(server, tool.name) ?? (root ? `claude-agent drops a tool whose schema's root has ${root}` : undefined);
}

/** Each `mcp:` grant in `tools` that no saved server answers for: its server is gone, or no longer lists the tool. */
export function staleGrants(tools: readonly string[], servers: readonly McpServer[]): { grant: string; why: string }[] {
  return tools.flatMap((grant) => {
    const g = grantOf(grant);
    if (!g) return [];
    const server = servers.find((s) => s.name === g.server);
    if (!server) return [{ grant, why: `The MCP server ${g.server} is not saved here any more, so a run can't call it.` }];
    return server.tools.some((t) => t.name === g.tool) ? [] : [{ grant, why: `${g.server} no longer lists ${g.tool}: refresh it, or untick this.` }];
  });
}

/** A refused preview, save or sign-in in plain words; `signIn` when the server signs in with OAuth. */
export function mcpProblem(e: unknown): { text: string; detail?: string; signIn?: boolean } {
  if (!(e instanceof ClientError)) return { text: `The request didn't reach this server: ${e instanceof Error ? e.message : String(e)}` };
  const redirect = e.fields?.find((f) => f.field === "url" && f.reason === "redirect");
  if (e.code === "auth_required") return e.details?.auth === "oauth" ? { text: "This server signs in with OAuth.", detail: "Sign in to it: its tools are saved once you approve.", signIn: true } : { text: "This server asks for a token.", detail: e.message };
  if (e.code === "not_mcp") return { text: "This address doesn't speak MCP.", detail: e.message };
  if (redirect) return { text: "This address redirects; use the final address.", detail: redirect.message };
  if (e.status === 424) return { text: `The server failed: ${e.message}` };
  // A sign-in finishes only in a browser that started it at the address the authorization server sends it back to.
  if (e.code === "wrong_origin") return { text: "Sign in from this server's own address: the sign-in comes back there.", ...(typeof e.details?.open === "string" ? { detail: `Open ${e.details.open} and sign in from it.` } : {}) };
  if (e.code === "store_unreadable") return { text: "The file this server keeps its MCP servers in can't be read: restore it or remove it." };
  if (e.fields?.length) return { text: e.fields.map((f) => f.message).join(" ") };
  return { text: `${e.code}: ${e.message}` };
}

/** Why a sign-in failed, by the code its way back names (`error=`): an OAuth error its authorization server sent back
 *  (RFC 6749 4.1.2.1, the token request's 5.2, OpenID Connect's), or this server's own (mcp-oauth.ts reasonOf: an API
 *  error's code, `changed_meanwhile`, `sign_in_failed`). The one table: a code it doesn't know reads SIGN_IN_UNKNOWN,
 *  and no code is ever shown. Each reads after "Signing in to <server> failed: ". */
const SIGN_IN_FAILED: Record<string, string> = {
  access_denied: "the sign-in was declined on its approval page",
  invalid_scope: "its authorization server doesn't offer the scopes asked for: change them and sign in again",
  invalid_grant: "its authorization server didn't take the sign-in's code (it expired, or was used already): sign in again",
  invalid_client: "its authorization server didn't take this client: check the client ID and secret, or leave them empty",
  unauthorized_client: "its authorization server doesn't let this client sign in this way: check the client ID, or leave it empty",
  invalid_request: "its authorization server refused the sign-in's request",
  unsupported_response_type: "its authorization server doesn't support this way of signing in",
  unsupported_grant_type: "its authorization server doesn't support this way of signing in",
  invalid_target: "its authorization server won't give a token for this MCP server",
  server_error: "its authorization server failed: try again",
  temporarily_unavailable: "its authorization server is busy: try again in a moment",
  login_required: "its authorization server wants you to sign in on its page: sign in again",
  interaction_required: "its authorization server wants you to sign in on its page: sign in again",
  consent_required: "its authorization server wants your consent on its page: sign in again",
  auth_required: "the MCP server didn't take the token the sign-in gave",
  not_mcp: "the address doesn't speak MCP",
  input_invalid: "the MCP server's tools could not be kept (too many of them, or the address redirects)",
  upstream_failed: "the MCP server or its authorization server failed: try again",
  unavailable: "this server was stopping: sign in again",
  changed_meanwhile: "the server was changed or removed while you signed in, so nothing was saved",
};
const SIGN_IN_UNKNOWN = "the sign-in didn't finish: try again";
/** A failed sign-in's code in words (SIGN_IN_FAILED), never the code. */
export const signInFailure = (code: string | undefined): string => (code && Object.hasOwn(SIGN_IN_FAILED, code) ? SIGN_IN_FAILED[code]! : SIGN_IN_UNKNOWN);

/** The sign-in's way back, `?server=<name>&sign_in=ok|failed&error=<code>` after `#/settings/mcp`. */
export function signInOf(query: string | undefined): { server: string; ok: boolean; error?: string } | undefined {
  const q = new URLSearchParams(query ?? "");
  const server = q.get("server");
  const how = q.get("sign_in");
  if (!server || (how !== "ok" && how !== "failed")) return undefined;
  return { server, ok: how === "ok", ...(how === "failed" ? { error: q.get("error") ?? "sign_in_failed" } : {}) };
}

/** An MCP server's tool as the harnesses call it, `mcp__<server>__<tool>`, read `<server> · <tool>` (the harness's own
 *  `hands` server is not one); null for any other name. */
export function mcpToolLabel(name: string): string | null {
  const m = /^mcp__([a-z][a-z0-9-]{0,31})__(.+)$/.exec(name);
  return m && m[1] !== "hands" ? `${m[1]} · ${m[2]}` : null;
}
