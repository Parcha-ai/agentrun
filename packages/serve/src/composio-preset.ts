// The Composio preset in Settings → MCP servers. Composio is an MCP server like any other: the owner gives an API key, a
// toolkit and the actions to grant, this file has Composio make a managed MCP server for them (plain fetch, its REST API),
// and the result is saved through the one MCP save (mcp-servers-store.ts) with the key as a sealed x-api-key header. No
// adapter, no auth type, no key row of its own: after the save a Composio server is a saved MCP server, gated and
// metered like every other. The four meta tools Composio adds (serve/src/mcp-meta.ts) stay refused; the helper actions
// that connect an account are left off the server's address. The key goes only to Composio and into the sealed header: it
// is never logged, echoed or put in an error.
import { randomBytes } from "node:crypto";
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { isObject, type Json } from "./validate.js";

/** Another Composio than the real one, and its fetch: a test's fake (the same seam as `archilControl`). */
export type ComposioControl = { readonly baseUrl?: string; readonly fetch?: typeof fetch };

const BASE = "https://backend.composio.dev";
/** The one Composio user a server's actions run as, unless the owner names another. */
const USER = "agentrun";
const TOOLKIT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const USER_ID = /^[A-Za-z0-9._@-]{1,128}$/;
const PAGE = 200;
const MAX_PAGES = 10;
const MAX_TOOLS = 500;
const WAIT_MS = 20_000;

export type ComposioTool = { slug: string; name: string; description: string };
type Ask = (step: string, method: "GET" | "POST", path: string, body?: unknown, missing?: string) => Promise<Json>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const issue = (field: string, reason: string, message: string): InputIssue => ({ field, reason, message });

/** A Composio call as `key`: its JSON answer, or an error in words that name `step` and never the key. */
function asking(control: ComposioControl, key: string, signal: AbortSignal | undefined): Ask {
  const base = (control.baseUrl ?? BASE).replace(/\/+$/, "");
  const send = control.fetch ?? fetch;
  const scrub = (said: string) => said.split(key).join("[the key]").slice(0, 300);
  return async (step, method, path, body, missing) => {
    let res: Response;
    let raw: string;
    try {
      // No redirect is followed: it would carry the key to wherever it points.
      res = await send(`${base}${path}`, {
        method, redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(WAIT_MS)]),
        headers: { "x-api-key": key, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      raw = await res.text();
    } catch {
      throw new ApiError("upstream_failed", `Composio did not answer while ${step}: nothing was saved.`);
    }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { /* not JSON: said below */ }
    if (res.ok) {
      if (isObject(json)) return json;
      throw new ApiError("upstream_failed", `Composio's answer while ${step} was not JSON: nothing was saved.`);
    }
    const said = isObject(json) && isObject(json.error) ? text(json.error.message) : isObject(json) ? text(json.message) : "";
    if (res.status === 401 || res.status === 403) throw invalid([issue("api_key", "refused", `Composio refused the API key while ${step}: check it in Composio's dashboard.`)]);
    if (res.status === 404 && missing) throw invalid([issue("toolkit", "not_found", missing)]);
    if (res.status >= 400 && res.status < 500) throw invalid([issue("body", "refused", `Composio refused the request while ${step} (${res.status})${said ? `: ${scrub(said)}` : ""}.`)]);
    throw new ApiError("upstream_failed", `Composio failed while ${step} (${res.status}): nothing was saved.`);
  };
}

/** The key and toolkit of a body, checked. */
function head(body: unknown): { key: string; toolkit: string; rest: Json } {
  if (!isObject(body)) throw invalid([issue("body", "invalid", "The body is {api_key, toolkit}.")]);
  const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  const toolkit = typeof body.toolkit === "string" ? body.toolkit.trim().toLowerCase() : "";
  const issues: InputIssue[] = [];
  if (!key || key.length > 8192) issues.push(issue("api_key", "missing", "Send your Composio API key."));
  if (!TOOLKIT.test(toolkit)) issues.push(issue("toolkit", "invalid", "Send the toolkit's slug as Composio names it (github, slack, gmail...)."));
  if (issues.length) throw invalid(issues);
  return { key, toolkit, rest: body };
}

const notFound = (toolkit: string) => `Composio has no toolkit ${toolkit}: use its slug (github, slack, gmail...).`;

/** POST /settings/mcp-servers/composio/tools: a toolkit's actions, for the console's picker, and whether it needs no sign-in. */
export async function composioTools(body: unknown, control: ComposioControl, signal?: AbortSignal): Promise<{ toolkit: string; no_auth: boolean; tools: ComposioTool[] }> {
  const { key, toolkit } = head(body);
  const ask = asking(control, key, signal);
  const kit = await ask("reading the toolkit", "GET", `/api/v3/toolkits/${encodeURIComponent(toolkit)}`, undefined, notFound(toolkit));
  const tools: ComposioTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await ask("listing the toolkit's actions", "GET", `/api/v3/tools?toolkit_slug=${encodeURIComponent(toolkit)}&limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, notFound(toolkit));
    for (const item of Array.isArray(listed.items) ? listed.items : []) if (isObject(item) && text(item.slug)) tools.push({ slug: text(item.slug), name: text(item.name) || text(item.slug), description: text(item.description) });
    cursor = text(listed.next_cursor) || undefined;
    if (!cursor) break;
  }
  return { toolkit, no_auth: kit.no_auth === true, tools };
}

/** The address Composio's generate answers, made one this server's client can use: the helper actions that connect an
 *  account left off, and the path ended in /mcp (Composio redirects the bare one, which the client refuses on purpose). */
export function composioAddress(generated: string): string {
  const url = new URL(generated);
  url.searchParams.delete("include_composio_helper_actions");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return url.href;
}

/** PUT /settings/mcp-servers/{name}/composio: Composio makes the managed MCP server, `save` keeps it as a saved MCP server
 *  (`{url, auth}`: the key a sealed header), and a toolkit that needs the person's account says where to connect it. */
export async function composioSave<T>(body: unknown, control: ComposioControl, save: (mcp: { url: string; auth: { type: "headers"; headers: Record<string, string> } }) => Promise<T>, name: string, signal?: AbortSignal): Promise<{ server: T; connect_url?: string }> {
  const { key, toolkit, rest } = head(body);
  const tools = Array.isArray(rest.tools) ? rest.tools : [];
  const user = rest.user_id === undefined ? USER : typeof rest.user_id === "string" ? rest.user_id : "";
  const issues: InputIssue[] = [];
  if (!tools.length || tools.length > MAX_TOOLS || !tools.every((t) => typeof t === "string" && t)) issues.push(issue("tools", "invalid", `Send the slugs of the actions to grant: 1 to ${MAX_TOOLS} of them.`));
  if (!USER_ID.test(user)) issues.push(issue("user_id", "invalid", "A user_id is letters, digits and . _ @ - (at most 128)."));
  if (issues.length) throw invalid(issues);
  const ask = asking(control, key, signal);
  const kit = await ask("reading the toolkit", "GET", `/api/v3/toolkits/${encodeURIComponent(toolkit)}`, undefined, notFound(toolkit));
  const noAuth = kit.no_auth === true;
  let authConfig: string | undefined;
  if (!noAuth) {
    const configs = await ask("finding the toolkit's auth config", "GET", `/api/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
    const managed = (Array.isArray(configs.items) ? configs.items : []).find((c) => isObject(c) && c.is_composio_managed === true && c.status !== "DISABLED" && text(c.id));
    authConfig = managed ? text((managed as Json).id) : undefined;
    if (!authConfig) {
      const made = await ask("making the toolkit's auth config", "POST", "/api/v3/auth_configs", { toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth" } });
      authConfig = isObject(made.auth_config) ? text(made.auth_config.id) : "";
      if (!authConfig) throw new ApiError("upstream_failed", "Composio made no auth config: nothing was saved.");
    }
  }
  const made = await ask("making the MCP server", "POST", "/api/v3.1/mcp/servers/custom", {
    name: `ar-${name.slice(0, 18)}-${randomBytes(3).toString("hex")}`, toolkits: [toolkit], ...(authConfig ? { auth_config_ids: [authConfig] } : {}), allowed_tools: tools, managed_auth_via_composio: true,
  });
  const id = text(made.id);
  if (!id) throw new ApiError("upstream_failed", "Composio made no MCP server: nothing was saved.");
  const generated = await ask("making the MCP server's address", "POST", "/api/v3.1/mcp/servers/generate", { mcp_server_id: id, user_ids: [user], managed_auth_by_composio: true });
  const address = Array.isArray(generated.user_ids_url) ? text(generated.user_ids_url[0]) : "";
  if (!address) throw new ApiError("upstream_failed", "Composio gave no address for the MCP server: nothing was saved.");
  let connect: string | undefined;
  if (authConfig) {
    const accounts = await ask("checking the connected account", "GET", `/api/v3/connected_accounts?user_ids=${encodeURIComponent(user)}&toolkit_slugs=${encodeURIComponent(toolkit)}`);
    if (!(Array.isArray(accounts.items) ? accounts.items : []).some((a) => isObject(a) && a.status === "ACTIVE")) {
      const link = await ask("making the connect link", "POST", "/api/v3/connected_accounts/link", { auth_config_id: authConfig, user_id: user });
      connect = text(link.redirect_url) || undefined;
    }
  }
  const server = await save({ url: composioAddress(address), auth: { type: "headers", headers: { "x-api-key": key } } });
  return { server, ...(connect ? { connect_url: connect } : {}) };
}
