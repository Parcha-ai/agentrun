// The Composio preset in Settings → MCP servers. Composio is an MCP server like any other: the owner gives an API key, a
// toolkit and the actions to grant, this file has Composio make a managed MCP server for them (plain fetch, its REST API),
// and the result is saved through the one MCP save (mcp-servers-store.ts) with the key as a sealed x-api-key header. No
// adapter, no auth type, no key row of its own: after the save a Composio server is a saved MCP server, gated and
// metered like every other. The four meta tools Composio adds (serve/src/mcp-meta.ts) stay refused; the helper actions
// that connect an account are left off the server's address. The key goes only to Composio and into the sealed header: it
// is never logged, echoed or put in an error.
import { randomBytes } from "node:crypto";
import type { Cleanup, ComposioMade, Made, Thing } from "./composio-made.js";
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
import { isObject, type Json } from "./validate.js";

/** Another Composio than the real one, and its fetch: a test's fake (the same seam as `archilControl`). */
export type ComposioControl = { readonly baseUrl?: string; readonly fetch?: typeof fetch };

const BASE = "https://backend.composio.dev";
/** The one Composio user a server's actions run as, unless the owner names another. */
export const COMPOSIO_USER = "agentrun";
const TOOLKIT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const USER_ID = /^[A-Za-z0-9._@-]{1,128}$/;
const PAGE = 200;
const MAX_PAGES = 10;
const MAX_TOOLS = 500;
const WAIT_MS = 20_000;

export type ComposioTool = { slug: string; name: string; description: string };
/** A Composio call (asking): its JSON answer, or the refusal in words that name its step. */
export type Ask = (step: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, missing?: string) => Promise<Json>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const issue = (field: string, reason: string, message: string): InputIssue => ({ field, reason, message });

/** A Composio call as `key`: its JSON answer, or an error in words that name `step` and never the key, and end with
 *  `outcome`, what the failure left (a save's: nothing was saved). */
export function asking(control: ComposioControl, key: string, signal: AbortSignal | undefined, outcome = "nothing was saved"): Ask {
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
      throw new ApiError("upstream_failed", `Composio did not answer while ${step}: ${outcome}.`);
    }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { /* not JSON: said below */ }
    if (res.ok) {
      if (isObject(json)) return json;
      // A delete may answer nothing at all.
      if (!raw.trim()) return {};
      throw new ApiError("upstream_failed", `Composio's answer while ${step} was not JSON: ${outcome}.`);
    }
    const said = isObject(json) && isObject(json.error) ? text(json.error.message) : isObject(json) ? text(json.message) : "";
    if (res.status === 401 || res.status === 403) throw invalid([issue("api_key", "refused", `Composio refused the API key while ${step}: check it in Composio's dashboard.`)]);
    if (res.status === 404 && missing) throw invalid([issue("toolkit", "not_found", missing)]);
    if (res.status >= 400 && res.status < 500) throw invalid([issue("body", "refused", `Composio refused the request while ${step} (${res.status})${said ? `: ${scrub(said)}` : ""}.`)]);
    throw new ApiError("upstream_failed", `Composio failed while ${step} (${res.status}): ${outcome}.`);
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
 *  (`{url, auth}`: the key a sealed header), and a toolkit that needs the person's account says where to connect it.
 *  `save` gets what the server stands on there too (`stands`, composio-made.ts): the auth config found or made and the
 *  account found or started, each marked whether this save made it, for its delete to remove what was made. */
export async function composioSave<T extends { tools?: readonly { name: string }[] }>(body: unknown, control: ComposioControl, save: (mcp: { url: string; auth: { type: "headers"; headers: Record<string, string> } }, made: { source: "composio"; toolkit: string | null }, stands: ComposioMade) => Promise<T>, name: string, signal?: AbortSignal, savedUrl?: () => Promise<string | undefined>): Promise<{ server: T; connect_url?: string; not_served?: string[] }> {
  const { key, toolkit, rest } = head(body);
  const tools = Array.isArray(rest.tools) ? rest.tools : [];
  const user = rest.user_id === undefined ? COMPOSIO_USER : typeof rest.user_id === "string" ? rest.user_id : "";
  const issues: InputIssue[] = [];
  if (!tools.length || tools.length > MAX_TOOLS || !tools.every((t) => typeof t === "string" && t)) issues.push(issue("tools", "invalid", `Send the slugs of the actions to grant: 1 to ${MAX_TOOLS} of them.`));
  if (!USER_ID.test(user)) issues.push(issue("user_id", "invalid", "A user_id is letters, digits and . _ @ - (at most 128)."));
  if (issues.length) throw invalid(issues);
  const ask = asking(control, key, signal);
  // What this save made at Composio. A failure removes it all again (the MCP server, the account its connect link started,
  // then the auth config), so a failed save leaves nothing it made in the person's account, and never removes what it
  // found there. The save's own error is the one answered, saying what is left when Composio refuses a removal too. Not
  // when the local entry was written before the save failed (its flush, say): `savedUrl` reads the name's saved address,
  // and one that is this server's keeps it all.
  const madeHere: Removable[] = [];
  let url: string | undefined;
  try {
    const kit = await ask("reading the toolkit", "GET", `/api/v3/toolkits/${encodeURIComponent(toolkit)}`, undefined, notFound(toolkit));
    const noAuth = needsNoAuth(kit);
    let authConfig: string | undefined;
    let madeConfig = false;
    if (!noAuth) {
      const configs = await ask("finding the toolkit's auth config", "GET", `/api/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
      const managed = (Array.isArray(configs.items) ? configs.items : []).find((c) => isObject(c) && c.is_composio_managed === true && c.status !== "DISABLED" && text(c.id));
      authConfig = managed ? text((managed as Json).id) : undefined;
      if (!authConfig) {
        const made = await ask("making the toolkit's auth config", "POST", "/api/v3/auth_configs", { toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth" } });
        authConfig = isObject(made.auth_config) ? text(made.auth_config.id) : "";
        if (!authConfig) throw new ApiError("upstream_failed", "Composio made no auth config: nothing was saved.");
        madeConfig = true;
        madeHere.push({ kind: "auth_config", id: authConfig });
      }
    }
    const made = await ask("making the MCP server", "POST", "/api/v3.1/mcp/servers/custom", {
      name: `ar-${name.slice(0, 18)}-${randomBytes(3).toString("hex")}`, toolkits: [toolkit], ...(authConfig ? { auth_config_ids: [authConfig] } : {}), allowed_tools: tools, managed_auth_via_composio: true,
    });
    const id = text(made.id);
    if (!id) throw new ApiError("upstream_failed", "Composio made no MCP server: nothing was saved.");
    madeHere.push({ kind: "mcp", id });
    const generated = await ask("making the MCP server's address", "POST", "/api/v3.1/mcp/servers/generate", { mcp_server_id: id, user_ids: [user], managed_auth_by_composio: true });
    const address = Array.isArray(generated.user_ids_url) ? text(generated.user_ids_url[0]) : "";
    if (!address) throw new ApiError("upstream_failed", "Composio gave no address for the MCP server: nothing was saved.");
    let connect: string | undefined;
    const accounts: Made[] = [];
    if (authConfig) {
      // Only an account under this server's auth config serves it: one ACTIVE under another config (a custom one) doesn't.
      const listed = await ask("checking the connected account", "GET", `/api/v3/connected_accounts?user_ids=${encodeURIComponent(user)}&toolkit_slugs=${encodeURIComponent(toolkit)}&auth_config_ids=${encodeURIComponent(authConfig)}`);
      const active = (Array.isArray(listed.items) ? listed.items : []).find((a) => isObject(a) && a.status === "ACTIVE" && isObject(a.auth_config) && a.auth_config.id === authConfig);
      if (active) {
        if (text((active as Json).id)) accounts.push({ id: text((active as Json).id), made: false });
      } else {
        // The link starts the connected account it connects (connected_account_id): this save's, removed with the server.
        const link = await ask("making the connect link", "POST", "/api/v3/connected_accounts/link", { auth_config_id: authConfig, user_id: user });
        connect = text(link.redirect_url) || undefined;
        if (text(link.connected_account_id)) {
          accounts.push({ id: text(link.connected_account_id), made: true });
          madeHere.push({ kind: "account", id: text(link.connected_account_id) });
        }
      }
    }
    const stands: ComposioMade = { user, auth_config: authConfig ? { id: authConfig, made: madeConfig } : null, accounts };
    url = composioAddress(address);
    // Saved as what it is, a Composio server of this toolkit: a template that needs the toolkit maps to it, whatever its
    // name. A slug no template can name (mcp:<toolkit>/<tool>: no `_`) is saved as a Composio server of no toolkit.
    // Composio leaves out an action it does not serve, and a server that serves none of the picked ones lists no tools at
    // all: its MCP answers the listing "Method not found" (JSON-RPC -32601). Only that answer says "none served", in words
    // naming the picked actions; any other failure (no DNS, a timeout, an HTTP 500) stays the 424 it is.
    const server = await save({ url, auth: { type: "headers", headers: { "x-api-key": key } } }, { source: "composio", toolkit: MCP_SERVER_NAME.test(toolkit) ? toolkit : null }, stands).catch((error: unknown) => {
      if (!(error instanceof ApiError) || error.code !== "upstream_failed" || error.extra.details?.rpc_code !== METHOD_NOT_FOUND) throw error;
      throw invalid([issue("tools", "not_served", `Composio's ${toolkit} server doesn't serve ${(tools as string[]).join(", ")}: pick another action.`)]);
    });
    // Composio's server can leave out an action it was allowed (HACKERNEWS_GET_FRONTPAGE, live 11-13): say which, so a grant
    // doesn't vanish without a word. A toolkit with no account yet still lists its actions, so this holds before the connect.
    const listed = new Set((server.tools ?? []).map((tool) => tool.name));
    const missing = (tools as string[]).filter((slug) => !listed.has(slug));
    return { server, ...(connect ? { connect_url: connect } : {}), ...(missing.length ? { not_served: missing } : {}) };
  } catch (error) {
    if (url && savedUrl && (await savedUrl().catch(() => undefined)) === url) throw error;
    const left = await removing(ask, [...madeHere].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]), []);
    if (!left.length || !(error instanceof ApiError)) throw error;
    throw new ApiError(error.code, `${error.message} ${said(name, [], [], left).note}`, error.extra, error.headers);
  }
}

/** A thing at Composio a save or a delete may remove. */
type Removable = Thing | { kind: "mcp"; id: string };
/** The order things are removed in: the MCP server, then the accounts, then the auth config they are under. */
const ORDER: Record<Removable["kind"], number> = { mcp: 0, account: 1, auth_config: 2 };
/** Removes `things` at Composio in order, each named in `removed` once gone (Composio's 404: already gone); answers
 *  those it could not remove, named. */
async function removing(ask: Ask, things: readonly Removable[], removed: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const thing of things) {
    const path = thing.kind === "mcp" ? `/api/v3.1/mcp/${encodeURIComponent(thing.id)}` : thing.kind === "account" ? `/api/v3/connected_accounts/${encodeURIComponent(thing.id)}` : `/api/v3/auth_configs/${encodeURIComponent(thing.id)}`;
    try {
      await ask(`deleting ${named(thing)}`, "DELETE", path, undefined, "gone");
      removed.push(named(thing, true));
    } catch (error) {
      if (error instanceof ApiError && error.extra.fields?.[0]?.reason === "not_found") removed.push(named(thing, true));
      else left.push(named(thing));
    }
  }
  return left;
}

/** JSON-RPC's "Method not found": what a Composio MCP server with none of the picked actions answers a tool listing. */
const METHOD_NOT_FOUND = -32601;

/** Where the owner removes a Composio MCP server by hand, said when this server could not. */
const DASHBOARD = "https://platform.composio.dev";
/** The Composio MCP server a saved preset address names (`/v3/mcp/<id>/mcp`, composioAddress): its id, or undefined. */
export const composioServerId = (address: string): string | undefined => {
  try { return /^\/v3\/mcp\/([^/]+)\/mcp$/.exec(new URL(address).pathname)?.[1]; } catch { return undefined; }
};

/** A thing at Composio as the words name it; `removed`: as a removal names it (an account its connect link with it). */
const named = (thing: Thing | { kind: "mcp"; id: string }, removed = false): string =>
  thing.kind === "mcp" ? `the MCP server ${thing.id}` : thing.kind === "auth_config" ? `the auth config ${thing.id}` : `the connected account ${thing.id}${removed ? " (its connect link with it)" : ""}`;
/** "a", "a and b", "a, b and c". */
const listed = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** What a delete's answer says it did at Composio, in words: what it removed, what it kept and why (another saved server
 *  uses it, or this server didn't make it), and what is left, with where to remove that by hand. `removed`: nothing is
 *  left there. */
function said(name: string, removed: string[], kept: (Thing & { by?: string })[], left: string[]): { removed: boolean; note: string } {
  const parts: string[] = [];
  if (removed.length) parts.push(`Removed in Composio: ${listed(removed)}.`);
  if (kept.length) parts.push(`${parts.length ? "Kept there" : "Kept in Composio"}: ${kept.map((thing) => `${named(thing)}, which ${thing.by ? `${thing.by} uses too` : "AgentRun didn't make"}`).join("; ")}.`);
  if (left.length) parts.push(`${parts.length ? "Left there" : "Left in Composio"}: ${listed(left)}. Remove what is left of ${name} in Composio yourself: ${DASHBOARD}`);
  return { removed: left.length === 0, note: parts.join(" ") };
}

/** What the answer to a delete says when this server could not ask Composio at all (the saved key does not open here, or
 *  the address names no Composio server): all of it is left there, to remove by hand. `mcp`: the MCP server left, by its
 *  id when known (true: the one it made; false: none). `over`: a save over a server, which says what it keeps too. */
export const composioNote = (name: string, cleanup?: Cleanup, mcp: string | boolean = true, over = false): { removed: false; note: string } =>
  ({ removed: false, note: said(name, [], over ? cleanup?.kept ?? [] : [], [`${listed([...(typeof mcp === "string" ? [named({ kind: "mcp", id: mcp })] : mcp ? ["the MCP server it made"] : []), ...(cleanup?.remove ?? []).map((thing) => named(thing))])} (the saved key doesn't open here)`]).note });

/** Deleting a preset server: the Composio MCP server `id` it made is deleted as `key` (the saved credential, held for this
 *  call only), then what `cleanup` says this server made for it and nothing else uses (composio-made.ts: its connected
 *  accounts, then their auth config). Composio's 404 is "already gone"; a refusal, or no answer, leaves that one there and
 *  says so, for the delete of our own row to go on regardless. The answer says in words what went, what stays and why.
 *  A save over a server does the same with what the save before made that it left (ComposioDropped); no `id` when the
 *  row still names the MCP server it named. */
export async function composioForget(control: ComposioControl, key: string, id: string | undefined, name: string, signal?: AbortSignal, cleanup?: Cleanup): Promise<{ removed: boolean; note: string }> {
  const removed: string[] = [];
  const left = await removing(asking(control, key, signal, "it is still there"), [...(id ? [{ kind: "mcp" as const, id }] : []), ...(cleanup?.remove ?? [])], removed);
  return said(name, removed, cleanup?.kept ?? [], left);
}
