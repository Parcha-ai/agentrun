import { ClientError } from "./client";
import type { Permission, SecretMeta } from "./v2";

/** A tool as a remote MCP server lists it (`tools/list`, through the server's preview). */
/** A tool as a server lists it; on a saved server's read, with its permission as this server applies it to an agent that
 *  sets none (`permission`, under the server's tool settings), the owner's default and those it may be set to. */
/** What a tool does by its server's annotations (the server's read): read-only, destructive (marked destructiveHint),
 *  or a write (any other, one its server says nothing about included). */
export type ToolEffect = "read" | "write" | "destructive";
export type McpTool = { name: string; title?: string; description?: string; input_schema?: unknown; permission?: Permission; default_permission?: Permission; permissions?: Permission[]; effect?: ToolEffect;
  /** On a saved server's read: its permission is allow because of its server's Allow reads (the server's word). */
  allow_reads?: true;
  /** On a saved server's read: with no setting of its own, its server's Allow reads lets it run (the server's word), so
   *  allow is its fallback, whatever its own setting says now. */
  fallback_allow_reads?: true;
  /** A known meta tool (`grantable: false`, with the server's `reason`): never granted. */
  grantable?: false; reason?: string;
  /** Why a grant of it is refused where it would run, as the server says it (`*`: on every harness; else by harness id). */
  grant_problems?: Record<string, string> };
export type McpAuthType = "none" | "bearer" | "headers" | "oauth" | "github_app";
/** The one address a `github_app` server may have: GitHub's hosted MCP (the save refuses any other, so the App's tokens go to
 *  GitHub alone). */
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
/** Where a saved server's tools come from, which a template's MCP need is matched on with its toolkit. */
export type McpSource = "composio" | "github" | "url";
export const SOURCE_LABEL: Record<McpSource, string> = { composio: "Composio", github: "GitHub", url: "URL" };
const TOOLKIT = /^[a-z][a-z0-9-]{0,31}$/;
/** What `#/settings/mcp?add=` opens, for a server a template needs: the add form with its name (for GitHub's own, its
 *  address and credential; for a url server, its toolkit) filled, or, with `preset=composio`, the Composio form with its
 *  toolkit and the actions to tick. */
export type McpAdd = { name: string; auth?: "github_app"; preset?: "composio"; toolkit?: string; tools?: string[] };
/** `#/settings/mcp?add=<name>[&auth=github_app | &preset=composio&toolkit=<toolkit>&tools=<A,B>]`. Undefined when the query
 *  asks for none. */
export function addOf(query: string | undefined): McpAdd | undefined {
  const q = new URLSearchParams(query ?? "");
  const name = q.get("add");
  if (!name || !TOOLKIT.test(name)) return undefined;
  const toolkit = q.get("toolkit") ?? "";
  if (q.get("preset") === "composio" && TOOLKIT.test(toolkit)) {
    const tools = (q.get("tools") ?? "").split(",").filter((t) => /^[A-Za-z0-9_-]{1,128}$/.test(t)).slice(0, 64);
    return { name, preset: "composio", toolkit, ...(tools.length ? { tools } : {}) };
  }
  return { name, ...(q.get("auth") === "github_app" ? { auth: "github_app" as const } : {}) };
}
/** A saved MCP server as GET /v2/settings/mcp-servers shows it: never a credential, only its state (`credential`: null
 *  for one that takes none). `prices`, per tool in USD, only when the server meters them. */
export type McpServer = {
  /** The tools it lists that no price meters (the read's `not_metered`): absent when every tool has a price. */
  not_metered?: string[];
  /** Its credential as every secret is read: set or not, how it came, when it last changed. Never a value. */
  secret?: SecretMeta;
  name: string; url: string; auth: { type: McpAuthType; headers?: string[] }; tools: McpTool[]; protocol?: string; listed_at?: string; updated_at?: string;
  /** Where its tools come from and the toolkit they are (none: a url server its owner named no toolkit for). */
  source: McpSource; toolkit: string | null;
  credential: "sealed" | "unreadable" | "expired" | null;
  oauth?: { expires_at?: string; scopes: string[]; client: string; client_id?: string };
  prices?: Record<string, number>;
};
export type McpPreview = { protocol: string; server_info?: { name?: string; version?: string }; instructions?: string; tools: McpTool[] };
export type McpRefresh = { added: string[]; removed: string[]; changed: string[]; server: McpServer };
/** What a preview or save sends as `auth`: a credential only when one was typed (none: keep the sealed one). */
export type McpAuth = { type: McpAuthType; token?: string; headers?: Record<string, string> };
/** A Composio toolkit's actions (POST /settings/mcp-servers/composio/tools), `no_auth` when it needs no account. */
export type ComposioTools = { toolkit: string; no_auth: boolean; tools: { slug: string; name: string; description: string }[] };
/** Capabilities' `features.mcp_client`. */
export type McpClientFeature = { auth?: string[]; harnesses?: string[] };

/** The grant `definition.tools` holds for a server's tool, and the server and tool a grant names (null: not one). */
/** What a preview's tool list is: the tools the server offers, listed with this credential, not what it lets this
 *  credential do (a read-only token sees write tools too). Shown with every preview. */
export const PREVIEW_SCOPE_NOTE = "These are the tools the server offers, not what this credential allows: a read-only token still sees its write tools. A call the credential can't make is refused by the server when a run makes it.";

export const mcpGrant = (server: string, tool: string) => `mcp:${server}/${tool}`;
export function grantOf(name: string): { server: string; tool: string } | null {
  const m = /^mcp:([^/]+)\/(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** Why the server refuses a grant of `tool` on `harness`, in its words, as its read of the saved server serves them
 *  (`grantable`, `reason` and `grant_problems`: packages/serve/src/mcp-servers-store.ts, the same checks as the save's
 *  422); undefined when nothing does. The console keeps no rule of its own. */
export function grantProblem(tool: McpTool, harness: string): string | undefined {
  if (tool.grantable === false) return `${tool.name} can't be granted: ${tool.reason ?? "it runs other actions by name."}`;
  return tool.grant_problems?.["*"] ?? tool.grant_problems?.[harness];
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

/** The words for a sign-in whose authorization server lets no app register itself: the owner makes an OAuth app with its
 *  provider, naming `callback` (the server's, from its answer's `details.oauth.callback`), and enters its Client ID and
 *  Secret. */
const NEEDS_CLIENT = (callback: string) => `Create an OAuth app with its provider (on GitHub, an OAuth App in your account's developer settings)${callback ? `, with ${callback} as its callback URL,` : ","} then enter its Client ID and Secret in this server's OAuth fields and sign in.`;

/** A refused preview, save or sign-in in plain words; `signIn` when the server signs in with OAuth; `needsClient` when
 *  that sign-in needs a Client ID entered by hand (its authorization server lets no app register itself: a preview's
 *  `details.oauth.registration: false`, or a start refused on `client_id` with `registration_unavailable`). The callback
 *  URL said is the one the server answered (AGENTRUN_PUBLIC_URL's when set), never this page's own address. */
export function mcpProblem(e: unknown): { text: string; detail?: string; signIn?: boolean; needsClient?: boolean } {
  if (!(e instanceof ClientError)) return { text: `The request didn't reach this server: ${e instanceof Error ? e.message : String(e)}` };
  const redirect = e.fields?.find((f) => f.field === "url" && f.reason === "redirect");
  const unregistrable = e.fields?.find((f) => f.field === "client_id" && f.reason === "registration_unavailable");
  const client = e.details?.oauth as { registration?: unknown; callback?: unknown } | undefined;
  const callback = typeof client?.callback === "string" ? client.callback : "";
  if (unregistrable) return { text: unregistrable.message, detail: NEEDS_CLIENT(callback), signIn: true, needsClient: true };
  if (e.code === "auth_required" && e.details?.auth === "oauth" && client?.registration === false) {
    return { text: "This server signs in with OAuth, and its sign-in lets no app register itself.", detail: NEEDS_CLIENT(callback), signIn: true, needsClient: true };
  }
  if (e.code === "auth_required") return e.details?.auth === "oauth" ? { text: "This server signs in with OAuth.", detail: "Sign in to it: its tools are saved once you approve.", signIn: true } : { text: "This server asks for a token.", detail: e.message };
  if (e.code === "github_not_connected") return { text: "GitHub is not connected on this server.", detail: `${e.message} A GitHub App server runs on this server's GitHub App: connect GitHub, or add a repository to its installation, in Settings → GitHub, then try again.` };
  if (e.code === "not_mcp")return { text: "This address doesn't speak MCP.", detail: e.message };
  if (redirect) return { text: "This address redirects; use the final address.", detail: redirect.message };
  if (e.status === 424) return { text: `The server failed: ${e.message}` };
  // A sign-in finishes only in a browser that started it at the address the authorization server sends it back to.
  if (e.code === "wrong_origin") return { text: "Sign in from this server's own address: the sign-in comes back there.", ...(typeof e.details?.open === "string" ? { detail: `Open ${e.details.open} and sign in from it.` } : {}) };
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
/** An MCP server's tool as a workflow's call node names it (`tool: "mcp:<server>/<tool>"`, the tool settings' key): its
 *  server and its tool, or null for any other tool. */
export const mcpCallTool = grantOf;

export function mcpToolLabel(name: string): string | null {
  const m = /^mcp__([a-z][a-z0-9-]{0,31})__(.+)$/.exec(name);
  return m && m[1] !== "hands" ? `${m[1]} · ${m[2]}` : null;
}
