// The Composio preset in Settings → MCP servers. Composio is an MCP server like any other: the owner gives an API key, a
// toolkit and the actions to grant, this file has Composio make a managed MCP server for them (plain fetch, its REST API),
// and the result is saved through the one MCP save (mcp-servers-store.ts) with the key as a sealed x-api-key header. No
// adapter, no auth type, no key row of its own: after the save a Composio server is a saved MCP server, gated and
// metered like every other. The four meta tools Composio adds (serve/src/mcp-meta.ts) stay refused; the helper actions
// that connect an account are left off the server's address. The key goes only to Composio and into the sealed header: it
// is never logged, echoed or put in an error.
import { randomBytes } from "node:crypto";
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
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
type Ask = (step: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, missing?: string) => Promise<Json>;

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
      // A delete may answer nothing at all.
      if (!raw.trim()) return {};
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

/** Whether a toolkit needs no sign-in. Composio's answer for one toolkit has no `no_auth` field (only its toolkit list
 *  does): it says so as every auth mode in `auth_config_details` being NO_AUTH. */
function needsNoAuth(kit: Json): boolean {
  if (kit.no_auth === true) return true;
  const modes = Array.isArray(kit.auth_config_details) ? kit.auth_config_details.map((d) => (isObject(d) ? text(d.mode) : "")) : [];
  return modes.length > 0 && modes.every((mode) => mode === "NO_AUTH");
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
  return { toolkit, no_auth: needsNoAuth(kit), tools };
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
export async function composioSave<T extends { tools?: readonly { name: string }[] }>(body: unknown, control: ComposioControl, save: (mcp: { url: string; auth: { type: "headers"; headers: Record<string, string> } }, made: { source: "composio"; toolkit: string | null }) => Promise<T>, name: string, signal?: AbortSignal, savedUrl?: () => Promise<string | undefined>): Promise<{ server: T; connect_url?: string; not_served?: string[] }> {
  const { key, toolkit, rest } = head(body);
  const tools = Array.isArray(rest.tools) ? rest.tools : [];
  const user = rest.user_id === undefined ? USER : typeof rest.user_id === "string" ? rest.user_id : "";
  const issues: InputIssue[] = [];
  if (!tools.length || tools.length > MAX_TOOLS || !tools.every((t) => typeof t === "string" && t)) issues.push(issue("tools", "invalid", `Send the slugs of the actions to grant: 1 to ${MAX_TOOLS} of them.`));
  if (!USER_ID.test(user)) issues.push(issue("user_id", "invalid", "A user_id is letters, digits and . _ @ - (at most 128)."));
  if (issues.length) throw invalid(issues);
  const ask = asking(control, key, signal);
  const kit = await ask("reading the toolkit", "GET", `/api/v3/toolkits/${encodeURIComponent(toolkit)}`, undefined, notFound(toolkit));
  const noAuth = needsNoAuth(kit);
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
  // From here a failure deletes the server Composio just made, so a failed save leaves nothing in the person's account
  // (best effort: the save's own error is the one answered). Not when the local entry was written before the save failed
  // (its flush, say): `savedUrl` reads the name's saved address, and one that is this server's keeps it.
  let url: string | undefined;
  try {
    const generated = await ask("making the MCP server's address", "POST", "/api/v3.1/mcp/servers/generate", { mcp_server_id: id, user_ids: [user], managed_auth_by_composio: true });
    const address = Array.isArray(generated.user_ids_url) ? text(generated.user_ids_url[0]) : "";
    if (!address) throw new ApiError("upstream_failed", "Composio gave no address for the MCP server: nothing was saved.");
    let connect: string | undefined;
    if (authConfig) {
      // Only an account under this server's auth config serves it: one ACTIVE under another config (a custom one) doesn't.
      const accounts = await ask("checking the connected account", "GET", `/api/v3/connected_accounts?user_ids=${encodeURIComponent(user)}&toolkit_slugs=${encodeURIComponent(toolkit)}&auth_config_ids=${encodeURIComponent(authConfig)}`);
      if (!(Array.isArray(accounts.items) ? accounts.items : []).some((a) => isObject(a) && a.status === "ACTIVE" && isObject(a.auth_config) && a.auth_config.id === authConfig)) {
        const link = await ask("making the connect link", "POST", "/api/v3/connected_accounts/link", { auth_config_id: authConfig, user_id: user });
        connect = text(link.redirect_url) || undefined;
      }
    }
    url = composioAddress(address);
    // Saved as what it is, a Composio server of this toolkit: a template that needs the toolkit maps to it, whatever its
    // name. A slug no template can name (mcp:<toolkit>/<tool>: no `_`) is saved as a Composio server of no toolkit.
    const server = await save({ url, auth: { type: "headers", headers: { "x-api-key": key } } }, { source: "composio", toolkit: MCP_SERVER_NAME.test(toolkit) ? toolkit : null });
    // Composio's server can leave out an action it was allowed (HACKERNEWS_GET_FRONTPAGE, live 11-13): say which, so a grant
    // doesn't vanish without a word. A toolkit with no account yet still lists its actions, so this holds before the connect.
    const listed = new Set((server.tools ?? []).map((tool) => tool.name));
    const missing = (tools as string[]).filter((slug) => !listed.has(slug));
    return { server, ...(connect ? { connect_url: connect } : {}), ...(missing.length ? { not_served: missing } : {}) };
  } catch (error) {
    if (url && savedUrl && (await savedUrl().catch(() => undefined)) === url) throw error;
    await ask("deleting the MCP server it made", "DELETE", `/api/v3.1/mcp/${encodeURIComponent(id)}`).catch(() => undefined);
    throw error;
  }
}

/** Where the owner removes a Composio MCP server by hand, said when this server could not. */
const DASHBOARD = "https://platform.composio.dev";
/** The Composio MCP server a saved preset address names (`/v3/mcp/<id>/mcp`, composioAddress): its id, or undefined. */
export const composioServerId = (address: string): string | undefined => {
  try { return /^\/v3\/mcp\/([^/]+)\/mcp$/.exec(new URL(address).pathname)?.[1]; } catch { return undefined; }
};

/** Deleting a preset server: the Composio MCP server `id` it made is deleted as `key` (the saved credential, held for this
 *  call only). Composio's 404 is "already gone"; a refusal, or no answer, is `removed: false` with what to do by hand, for
 *  the delete of our own row to go on regardless. */
export async function composioForget(control: ComposioControl, key: string, id: string, name: string, signal?: AbortSignal): Promise<{ removed: boolean; note?: string }> {
  try {
    await asking(control, key, signal)("deleting the MCP server it made", "DELETE", `/api/v3.1/mcp/${encodeURIComponent(id)}`, undefined, "gone");
    return { removed: true };
  } catch (error) {
    if (error instanceof ApiError && error.extra.fields?.[0]?.reason === "not_found") return { removed: true };
    return { removed: false, note: `Remove ${name} in Composio yourself: ${DASHBOARD}` };
  }
}
