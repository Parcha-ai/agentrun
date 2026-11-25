// The Composio preset in Settings → MCP servers. Composio is an MCP server like any other: the owner gives an API key, a
// toolkit and the actions to grant, this file has Composio make a managed MCP server for them (plain fetch, its REST API),
// and the result is saved through the one MCP save (mcp-servers-store.ts) with the key as a sealed x-api-key header. No
// adapter, no auth type, no key row of its own: after the save a Composio server is a saved MCP server, gated and
// metered like every other. The four meta tools Composio adds (serve/src/mcp-meta.ts) stay refused; the helper actions
// that connect an account are left off the server's address. The key goes only to Composio and into the sealed header: it
// is never logged, echoed or put in an error. A save may name it instead by a variable of the server's environment
// (`api_key_env`, COMPOSIO_API_KEY only, a secret the launcher hands the server and each runner over its pipe): the server
// then keeps the name, seals nothing, and reads the value at each use (composio-made.ts composioKeyFromEnv).
import { randomBytes } from "node:crypto";
import { textUpTo } from "./answer-text.js";
import { COMPOSIO_KEY_ENV, COMPOSIO_ORIGIN, composioKeyFromEnv, type Cleanup, type ComposioMade, type Made, type Thing } from "./composio-made.js";
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { priceValid } from "./mcp-probe.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
import { isObject, type Json, unknownFields } from "./validate.js";

/** Another Composio than the real one, and its fetch: a test's fake (the same seam as `archilControl`). `listDeadline`:
 *  the signal that ends the toolkit listing (composioToolkits), a test's own; else LIST_MS from its start. */
export type ComposioControl = { readonly baseUrl?: string; readonly fetch?: typeof fetch; readonly listDeadline?: () => AbortSignal };

const BASE = COMPOSIO_ORIGIN;
/** The fields a Composio save takes (composioSave): no `url`, no `headers`. */
const SAVE_FIELDS = ["api_key", "api_key_env", "toolkit", "tools", "user_id", "auth_config_id", "price_usd"] as const;
/** The one Composio user a server's actions run as, unless the owner names another. */
export const COMPOSIO_USER = "agentrun";
/** A Composio toolkit's slug, as a save takes it once trimmed and lower-cased. */
export const COMPOSIO_TOOLKIT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOLKIT = COMPOSIO_TOOLKIT;
/** A Composio user id, as a save's `user_id` and a run's binding take it. */
export const COMPOSIO_USER_ID = /^[A-Za-z0-9._@:-]{1,128}$/;
/** COMPOSIO_USER_ID in words, for the messages that refuse a user id. */
export const COMPOSIO_USER_ID_WORDS = "letters, digits and . _ @ : - (1 to 128)";
const USER_ID = COMPOSIO_USER_ID;
/** The `user_id` a save names for a per-run server, reserved for that and never a Composio user: the server keeps no user
 *  and no connected account, and each run names its own (mcp_auth.<server> = {composio_user_id, connected_account_id?}). */
export const COMPOSIO_PER_RUN = "per_run";
/** A Composio connected account's id, as a run's binding names one: Composio's are `ca_` and a short random id. At least
 *  8 characters in all, so the run's redactors (which hold a value of 8 or more) hold every one. */
export const COMPOSIO_ACCOUNT_ID = /^ca_[A-Za-z0-9_-]{5,64}$/;
/** Where Composio's MCP address names the user and the connected account its calls run as. */
const ADDRESS_USER = "user_id";
const ADDRESS_ACCOUNT = "connected_account_id";
/** A Composio auth config's id, as its dashboard and API show it (`ac_` and a nanoid). */
export const COMPOSIO_AUTH_CONFIG_ID = /^ac_[A-Za-z0-9_-]{1,64}$/;
const PAGE = 200;
const MAX_PAGES = 10;
const MAX_TOOLS = 500;
/** The longest action slug a save takes: Composio's are far shorter. */
const MAX_SLUG = 128;
const WAIT_MS = 20_000;
/** The most bytes read of any one Composio answer: a page of 200 actions with their descriptions is well under it. */
const MAX_ANSWER = 4 * 1024 * 1024;
/** The toolkit listing's one deadline, every page in all. */
const LIST_MS = 30_000;

export type ComposioTool = { slug: string; name: string; description: string };
/** A Composio call (asking): its JSON answer, or the refusal in words that name its step. */
export type Ask = (step: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, missing?: string | InputIssue) => Promise<Json>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const issue = (field: string, reason: string, message: string): InputIssue => ({ field, reason, message });

/** A Composio call as `key`: its JSON answer, or an error in words that name `step` and never the key nor a `sealed`
 *  value (a trigger's sealed config), and end with `outcome`, what the failure left (a save's: nothing was saved). A call
 *  with sealed values in play passes on none of Composio's words. Composio's 404 is `missing` when given: the words of a
 *  toolkit it has not, or the refusal on another field. An answer over MAX_ANSWER is refused in words, unread. */
export function asking(control: ComposioControl, key: string, signal: AbortSignal | undefined, outcome = "nothing was saved", sealed: readonly string[] = []): Ask {
  const base = (control.baseUrl ?? BASE).replace(/\/+$/, "");
  const send = control.fetch ?? fetch;
  // Composio's words may quote what it was sent, as sent, JSON-escaped or percent-encoded. With a sealed value in play
  // (`sealed`) none of its words go on, as no match is sure to find every form of it; otherwise they go on with the key
  // out in each of those forms.
  const withheld = sealed.some(Boolean);
  const forms = [...new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)])].filter(Boolean).sort((a, b) => b.length - a.length);
  const scrub = (said: string) => forms.reduce((text, form) => text.split(form).join("[the key]"), said).slice(0, 300);
  return async (step, method, path, body, missing) => {
    let res: Response;
    let raw: string | undefined;
    try {
      // No redirect is followed: it would carry the key to wherever it points.
      res = await send(`${base}${path}`, {
        method, redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(WAIT_MS)]),
        headers: { "x-api-key": key, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      raw = await textUpTo(res, MAX_ANSWER);
    } catch {
      throw new ApiError("upstream_failed", `Composio did not answer while ${step}: ${outcome}.`);
    }
    if (raw === undefined) throw new ApiError("upstream_failed", `Composio's answer while ${step} was over ${MAX_ANSWER / (1024 * 1024)} MiB: ${outcome}.`);
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
    if (res.status === 404 && missing) throw invalid([typeof missing === "string" ? issue("toolkit", "not_found", missing) : missing]);
    if (res.status >= 400 && res.status < 500 && withheld) throw invalid([issue("body", "refused", `Composio refused the request while ${step} (HTTP ${res.status}): ${outcome}. Its answer is withheld because the request carried a sealed value.`)]);
    if (res.status >= 400 && res.status < 500) throw invalid([issue("body", "refused", `Composio refused the request while ${step} (${res.status})${said ? `: ${scrub(said)}` : ""}.`)]);
    throw new ApiError("upstream_failed", `Composio failed while ${step} (${res.status}): ${outcome}.`);
  };
}

/** The key and toolkit of a body, checked. The key is the body's `api_key`, or, where `keyEnv` is taken (a save), the value
 *  of the variable its `api_key_env` names: COMPOSIO_KEY_ENV only, so no other secret of the server's environment is sent
 *  to Composio. `keyEnv` in the answer: the key came from there. */
function head(body: unknown, { keyEnv = false }: { keyEnv?: boolean } = {}): { key: string; toolkit: string; rest: Json; keyEnv?: typeof COMPOSIO_KEY_ENV } {
  if (!isObject(body)) throw invalid([issue("body", "invalid", `The body is {${keyEnv ? "api_key or api_key_env" : "api_key"}, toolkit}.`)]);
  const toolkit = typeof body.toolkit === "string" ? body.toolkit.trim().toLowerCase() : "";
  const issues: InputIssue[] = [];
  let key = "";
  let named: typeof COMPOSIO_KEY_ENV | undefined;
  if (keyEnv && body.api_key_env !== undefined) {
    if (body.api_key !== undefined) issues.push(issue("api_key_env", "not_allowed", "Send api_key or api_key_env, not both."));
    else if (body.api_key_env !== COMPOSIO_KEY_ENV) issues.push(issue("api_key_env", "invalid", `api_key_env names the variable the key is read from, and only ${COMPOSIO_KEY_ENV} is taken.`));
    else {
      named = COMPOSIO_KEY_ENV;
      key = composioKeyFromEnv(named) ?? "";
      if (!key) issues.push(issue("api_key_env", "missing", `${COMPOSIO_KEY_ENV} is not set where AgentRun runs: set it to your Composio API key, then save again.`));
    }
  } else {
    key = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!key || key.length > 8192) issues.push(issue("api_key", "missing", keyEnv ? `Send your Composio API key, or api_key_env: "${COMPOSIO_KEY_ENV}" to read it from the server's environment.` : "Send your Composio API key."));
  }
  if (!TOOLKIT.test(toolkit)) issues.push(issue("toolkit", "invalid", "Send the toolkit's slug as Composio names it (github, slack, gmail...)."));
  if (issues.length) throw invalid(issues);
  return { key, toolkit, rest: body, ...(named ? { keyEnv: named } : {}) };
}

/** Whether a toolkit needs no sign-in. Composio's answer for one toolkit has no `no_auth` field (only its toolkit list
 *  does): it says so as every auth mode in `auth_config_details` being NO_AUTH. */
function needsNoAuth(kit: Json): boolean {
  if (kit.no_auth === true) return true;
  const modes = Array.isArray(kit.auth_config_details) ? kit.auth_config_details.map((d) => (isObject(d) ? text(d.mode) : "")) : [];
  return modes.length > 0 && modes.every((mode) => mode === "NO_AUTH");
}

const notFound = (toolkit: string) => `Composio has no toolkit ${toolkit}: use its slug (github, slack, gmail...).`;

/** Every page of the Composio listing at `path` (a query of its own, to which each page's cursor is added), at most `max`:
 *  what `keep` takes of each item (an item it answers undefined for is dropped), so no page is held past its own read,
 *  and whether the list ended within them (`complete`). A cursor Composio names a second time ends the list there, not
 *  complete. */
async function pages<T>(ask: Ask, step: string, path: string, max: number, keep: (item: unknown) => T | undefined, missing?: string): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < max; page++) {
    const listed = await ask(step, "GET", `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, missing);
    if (Array.isArray(listed.items)) for (const item of listed.items) {
      const kept = keep(item);
      if (kept !== undefined) items.push(kept);
    }
    cursor = text(listed.next_cursor) || undefined;
    if (!cursor) return { items, complete: true };
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  return { items, complete: false };
}

/** A toolkit's actions, every page (at most MAX_PAGES), at its latest version: without toolkit_versions Composio lists its
 *  base version (00000000_00), which leaves out the actions added since (linear 21 of 48, stripe 33 of 435, live 11-18),
 *  though its MCP servers serve them. `complete`: the list ended within MAX_PAGES. */
async function toolkitTools(ask: Ask, toolkit: string): Promise<{ tools: ComposioTool[]; complete: boolean }> {
  const toolOf = (item: unknown): ComposioTool | undefined => (isObject(item) && text(item.slug) ? { slug: text(item.slug), name: text(item.name) || text(item.slug), description: text(item.description) } : undefined);
  const { items: tools, complete } = await pages(ask, "listing the toolkit's actions", `/api/v3/tools?toolkit_slug=${encodeURIComponent(toolkit)}&toolkit_versions=latest&limit=${PAGE}`, MAX_PAGES, toolOf, notFound(toolkit));
  return { tools, complete };
}

/** POST /settings/mcp-servers/composio/tools: a toolkit's actions, for the console's picker, and whether it needs no sign-in. */
export async function composioTools(body: unknown, control: ComposioControl, signal?: AbortSignal): Promise<{ toolkit: string; no_auth: boolean; tools: ComposioTool[] }> {
  const { key, toolkit } = head(body);
  const ask = asking(control, key, signal);
  const kit = await ask("reading the toolkit", "GET", `/api/v3/toolkits/${encodeURIComponent(toolkit)}`, undefined, notFound(toolkit));
  const { tools } = await toolkitTools(ask, toolkit);
  return { toolkit, no_auth: needsNoAuth(kit), tools };
}

/** The listed slug a missing one means when it is that slug in another case (linear_list_issues for LINEAR_LIST_ISSUES). */
const likelySlug = (slug: string, slugs: readonly string[]): string | undefined => {
  const want = slug.toUpperCase();
  return slugs.find((s) => s.toUpperCase() === want);
};

/** A toolkit Composio offers, as the console's toolkit picker shows it: its slug and its name. */
export type ComposioToolkit = { slug: string; name: string };
/** The most pages of the toolkit list read (PAGE each): Composio offers about a thousand. */
const MAX_TOOLKIT_PAGES = 20;

/** POST /settings/mcp-servers/composio/toolkits: the toolkits Composio offers, every page (at most MAX_TOOLKIT_PAGES, all
 *  within LIST_MS), by name: each one's slug, as a save takes it (a slug outside COMPOSIO_TOOLKIT is left out), and its
 *  name. Stores nothing. */
export async function composioToolkits(body: unknown, control: ComposioControl, signal?: AbortSignal): Promise<{ toolkits: ComposioToolkit[] }> {
  if (!isObject(body)) throw invalid([issue("body", "invalid", "The body is {api_key}.")]);
  const extra = unknownFields(body, ["api_key"]);
  if (extra.length) throw invalid(extra);
  const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!key || key.length > 8192) throw invalid([issue("api_key", "missing", "Send your Composio API key.")]);
  const within = control.listDeadline?.() ?? AbortSignal.timeout(LIST_MS);
  const ask = asking(control, key, signal ? AbortSignal.any([signal, within]) : within, "no toolkit was listed");
  const toolkitOf = (item: unknown): ComposioToolkit | undefined => {
    const slug = isObject(item) ? text(item.slug).trim().toLowerCase() : "";
    return TOOLKIT.test(slug) ? { slug, name: text((item as Json).name).trim() || slug } : undefined;
  };
  const found = new Map<string, ComposioToolkit>();
  const { items } = await pages(ask, "listing the toolkits", `/api/v3/toolkits?sort_by=alphabetically&limit=${PAGE}`, MAX_TOOLKIT_PAGES, toolkitOf);
  for (const kit of items) if (!found.has(kit.slug)) found.set(kit.slug, kit);
  return { toolkits: [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.slug.localeCompare(b.slug)) };
}

/** Whether a saved Composio server's account is connected, as a refresh last read it at Composio: `connected`, an ACTIVE
 *  account under its auth config; `pending`, only one its connect link started and not yet finished; `expired`, only an
 *  expired one; `none`, no account (or only failed or inactive ones); `unknown`, Composio didn't answer. */
export type ComposioAccountState = "connected" | "pending" | "expired" | "none" | "unknown";
/** `labels`: each connected account's own label, for the owner to tell which account it is: the alias the owner gave it,
 *  else the name Composio shows for it (`state.val.displayName`), else the word id Composio gave it. Never its id (which
 *  a run's binding names), and nothing else of its state, which holds its tokens. */
export type ComposioAccount = { state: ComposioAccountState; labels?: string[] };
/** The longest label kept, and the most labels. */
const MAX_LABEL = 120;
const MAX_LABELS = 10;

/** `value` as a label: one line of text, cut to MAX_LABEL; none when empty or shaped as an account's id. */
function accountLabel(value: unknown): string | undefined {
  const line = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_LABEL).trim() : "";
  return line && !COMPOSIO_ACCOUNT_ID.test(line) ? line : undefined;
}

const labelOf = (account: Json): string | undefined =>
  accountLabel(account.alias) ?? (isObject(account.state) && isObject(account.state.val) ? accountLabel(account.state.val.displayName) : undefined) ?? accountLabel(account.word_id);

/** The connected accounts of `of.user` for `of.toolkit` under `of.auth_config` (under every config where none is named;
 *  ACTIVE ones alone with `active`), as Composio lists them now: only those Composio names as that user's. One with no
 *  user_id (a field Composio's docs say it will stop answering) is never kept, though Composio was asked for this user's
 *  alone: nothing says whose it is, so the user connects one again. None, unasked, for a user that is no Composio user id
 *  (COMPOSIO_USER_ID): a blank one Composio may read as every user. */
export async function accountsUnder(ask: Ask, of: { user: string; toolkit: string; auth_config?: string }, active = false): Promise<Json[]> {
  if (!COMPOSIO_USER_ID.test(of.user)) return [];
  const enc = encodeURIComponent;
  const listed = await ask("checking the connected account", "GET", `/api/v3/connected_accounts?user_ids=${enc(of.user)}&toolkit_slugs=${enc(of.toolkit)}${of.auth_config ? `&auth_config_ids=${enc(of.auth_config)}` : ""}${active ? "&statuses=ACTIVE" : ""}`);
  return (Array.isArray(listed.items) ? listed.items : []).filter((a): a is Json =>
    isObject(a) && a.user_id === of.user && (!of.auth_config || (isObject(a.auth_config) && a.auth_config.id === of.auth_config)) && (!active || a.status === "ACTIVE"));
}

/** The account of a saved Composio server's user for its toolkit, under its auth config (accountsUnder), as Composio
 *  lists it now: one Composio names as that user's (accountsUnder), which gives its labels too. `unknown`, unasked, for a user that is no one Composio user (empty, which Composio
 *  reads as every user). */
export async function composioAccount(ask: Ask, of: { user: string; toolkit: string; auth_config: string }): Promise<ComposioAccount> {
  if (!COMPOSIO_USER_ID.test(of.user)) return { state: "unknown" };
  const mine = await accountsUnder(ask, of);
  const active = mine.filter((a) => a.status === "ACTIVE");
  if (active.length) {
    const labels = [...new Set(active.map(labelOf).filter((label): label is string => !!label))].slice(0, MAX_LABELS);
    return { state: "connected", ...(labels.length ? { labels } : {}) };
  }
  if (mine.some((a) => a.status === "INITIATED" || a.status === "INITIALIZING")) return { state: "pending" };
  if (mine.some((a) => a.status === "EXPIRED")) return { state: "expired" };
  return { state: "none" };
}

/** The toolkit's Composio-managed auth config not disabled, the one a save that names none stands on: none, if Composio
 *  has none for it yet. */
export async function managedConfig(ask: Ask, toolkit: string): Promise<string | undefined> {
  const configs = await ask("finding the toolkit's auth config", "GET", `/api/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
  const managed = (Array.isArray(configs.items) ? configs.items : []).find((c) => isObject(c) && c.is_composio_managed === true && c.status !== "DISABLED" && text(c.id));
  return isObject(managed) ? text(managed.id) : undefined;
}

/** The address Composio's generate answers, made one this server's client can use: the helper actions that connect an
 *  account left off, and the path ended in /mcp (Composio redirects the bare one, which the client refuses on purpose).
 *  `perRun`: with no user and no connected account in it either, for each run to name its own (composioRunAddress). */
export function composioAddress(generated: string, perRun = false): string {
  const url = new URL(generated);
  url.searchParams.delete("include_composio_helper_actions");
  if (perRun) for (const name of [ADDRESS_USER, ADDRESS_ACCOUNT]) url.searchParams.delete(name);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return url.href;
}

/** The Composio user a per-run server's tools are listed as (its save, refresh, preview and an agent's save): Composio's
 *  MCP endpoint refuses an address that names no user, its listing too, and any user lists the server's tools. Outside
 *  COMPOSIO_USER_ID (the ~), so no save and no run's binding can name it: never stored, never used for a call. */
export const COMPOSIO_LISTING_USER = "agentrun~tool-listing";

/** The address a per-run Composio server's tools are listed at: its saved one (no user, no account) as
 *  COMPOSIO_LISTING_USER. */
export function composioListingAddress(saved: URL): URL {
  const url = new URL(saved.href);
  url.searchParams.set(ADDRESS_USER, COMPOSIO_LISTING_USER);
  return url;
}

/** What a run's requests to a per-run Composio server add to its saved address: the Composio user and, when the run's
 *  binding names one, the connected account its calls run as (Composio's MCP endpoint reads both from the query). */
export const composioRunQuery = (binding: { readonly user_id: string; readonly connected_account_id?: string }): Record<string, string> =>
  ({ [ADDRESS_USER]: binding.user_id, ...(binding.connected_account_id ? { [ADDRESS_ACCOUNT]: binding.connected_account_id } : {}) });

/** PUT /settings/mcp-servers/{name}/composio: Composio makes the managed MCP server, `save` keeps it as a saved MCP server
 *  (`{url, auth}`: the key a sealed header; `prices`, each granted action at `price_usd` when the body names one), and a
 *  toolkit that needs the person's account says where to connect it. The auth config is the body's `auth_config_id` (one
 *  the owner has, a custom OAuth app's say: read first, and refused unless it is this toolkit's and enabled), else the
 *  toolkit's Composio-managed one, found or made. `save` gets what the server stands on there too (`stands`,
 *  composio-made.ts): the auth config found or made and the account found or started, each marked whether this save made
 *  it, for its delete to remove what was made. The key is the body's `api_key`, or COMPOSIO_API_KEY's value when the body
 *  sends `api_key_env` (head): then `stands.key_env` names it, and the store seals no credential. */
export async function composioSave<T extends { tools?: readonly { name: string }[] }>(body: unknown, control: ComposioControl, save: (mcp: { url: string; auth: { type: "headers"; headers: Record<string, string> }; prices?: Record<string, number> }, made: { source: "composio"; toolkit: string | null }, stands: ComposioMade) => Promise<T>, name: string, signal?: AbortSignal, savedUrl?: () => Promise<string | undefined>): Promise<{ server: T; connect_url?: string; not_served?: string[] }> {
  // No address and no headers of the caller's own: Composio makes the server and answers its address, and the key is the
  // one header sent. Any field the save does not take is refused before anything is sent, never ignored.
  if (isObject(body)) {
    const extra = unknownFields(body, SAVE_FIELDS);
    if (extra.length) throw invalid(extra);
  }
  const { key, toolkit, rest, keyEnv } = head(body, { keyEnv: true });
  const tools = Array.isArray(rest.tools) ? rest.tools : [];
  const user = rest.user_id === undefined ? COMPOSIO_USER : typeof rest.user_id === "string" ? rest.user_id : "";
  const price = rest.price_usd;
  const ownConfig = rest.auth_config_id === undefined ? undefined : typeof rest.auth_config_id === "string" ? rest.auth_config_id : "";
  const issues: InputIssue[] = [];
  if (!tools.length || tools.length > MAX_TOOLS || !tools.every((t) => typeof t === "string" && t && t.length <= MAX_SLUG)) issues.push(issue("tools", "invalid", `Send the slugs of the actions to grant: 1 to ${MAX_TOOLS} of them, each at most ${MAX_SLUG} characters.`));
  if (!USER_ID.test(user)) issues.push(issue("user_id", "invalid", `A user_id is ${COMPOSIO_USER_ID_WORDS}, or "${COMPOSIO_PER_RUN}" for a server each run names its own account for.`));
  if (price !== undefined && !priceValid(price)) issues.push(issue("price_usd", "invalid", "price_usd is what each call of the server's actions costs, in USD: a finite number, 0 or more."));
  if (ownConfig !== undefined && !COMPOSIO_AUTH_CONFIG_ID.test(ownConfig)) issues.push(issue("auth_config_id", "invalid", "An auth_config_id is the id Composio shows for an auth config: ac_ then letters, digits, _ and - (at most 64 after ac_)."));
  if (issues.length) throw invalid(issues);
  // A per-run server: no user, no account, no connect link here; each run names its own (mcp_auth).
  const perRun = user === COMPOSIO_PER_RUN;
  // Every granted action at the one price, saved as the server's prices: each call is held and booked as any priced MCP
  // call (mcp-gateway.ts). None named: the server's prices as they stand, for the actions it still lists (a server saved
  // with none: "not metered").
  const prices = priceValid(price) ? Object.fromEntries([...new Set(tools as string[])].map((slug) => [slug, price])) : undefined;
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
    // Every slug is one the toolkit lists (at its latest version), before anything is made: Composio makes a server
    // allowing a slug it doesn't have, which then serves nothing under that name. A list longer than MAX_PAGES refuses
    // nothing on what it didn't read; the check after the save (not_served) still names an action left out.
    const offered = await toolkitTools(ask, toolkit);
    const slugs = offered.tools.map((tool) => tool.slug);
    const unknown = offered.complete ? [...new Set(tools as string[])].filter((slug) => !slugs.includes(slug)) : [];
    if (unknown.length) {
      const names = unknown.map((slug) => {
        const likely = likelySlug(slug, slugs);
        return likely ? `${slug} (did you mean ${likely}?)` : slug;
      });
      throw invalid([issue("tools", "not_found", `Composio's ${toolkit} toolkit has no action ${listed(names, "or")}: pick from its list (POST /settings/mcp-servers/composio/tools). Nothing was saved.`)]);
    }
    const noAuth = needsNoAuth(kit);
    if (noAuth && ownConfig) throw invalid([issue("auth_config_id", "not_allowed", `Composio's ${toolkit} toolkit needs no account, so no auth config: send no auth_config_id. Nothing was saved.`)]);
    let authConfig: string | undefined;
    let madeConfig = false;
    if (ownConfig) {
      // The owner's own auth config (a custom OAuth app's): the server and its connect link are made against it, as it is.
      // Read first, so one Composio doesn't know, of another toolkit, or disabled is refused before anything is made.
      const config = await ask("reading the auth config", "GET", `/api/v3/auth_configs/${encodeURIComponent(ownConfig)}`, undefined, issue("auth_config_id", "not_found", `Composio has no auth config ${ownConfig} in this key's project: use the id its dashboard shows for one of the ${toolkit} toolkit's. Nothing was saved.`));
      const of = isObject(config.toolkit) ? text(config.toolkit.slug).toLowerCase() : "";
      if (of !== toolkit) throw invalid([issue("auth_config_id", "wrong_toolkit", `The auth config ${ownConfig} is ${of ? `the ${of} toolkit's` : "no toolkit's Composio names"}, not ${toolkit}'s: use one of ${toolkit}'s. Nothing was saved.`)]);
      if (config.status === "DISABLED") throw invalid([issue("auth_config_id", "disabled", `The auth config ${ownConfig} is disabled in Composio: enable it there, or use another. Nothing was saved.`)]);
      authConfig = ownConfig;
    } else if (!noAuth) {
      authConfig = await managedConfig(ask, toolkit);
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
    // A per-run server's address is generated as the default user's (the one answer shape known, user_ids_url), then
    // saved with no user and no account in it (composioAddress): generating an address makes nothing at Composio.
    const generated = await ask("making the MCP server's address", "POST", "/api/v3.1/mcp/servers/generate", { mcp_server_id: id, user_ids: [perRun ? COMPOSIO_USER : user], managed_auth_by_composio: true });
    const address = Array.isArray(generated.user_ids_url) ? text(generated.user_ids_url[0]) : "";
    if (!address) throw new ApiError("upstream_failed", "Composio gave no address for the MCP server: nothing was saved.");
    let connect: string | undefined;
    const accounts: Made[] = [];
    if (authConfig && !perRun) {
      // Only an account under this server's auth config serves it: one ACTIVE under another config (a custom one) doesn't.
      const [active] = await accountsUnder(ask, { user, toolkit, auth_config: authConfig }, true);
      if (active) {
        if (text(active.id)) accounts.push({ id: text(active.id), made: false });
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
    // One the owner named is theirs (`named`): never recorded as made here, whoever made it (composio-made.ts). A key read
    // from the environment (`key_env`): the save lists the tools with it, and the store keeps the variable's name alone.
    const stands: ComposioMade = { user, auth_config: authConfig ? { id: authConfig, made: madeConfig, ...(ownConfig ? { named: true as const } : {}) } : null, accounts, ...(perRun ? { per_run: true as const } : {}), ...(keyEnv ? { key_env: keyEnv } : {}) };
    url = composioAddress(address, perRun);
    // Saved as what it is, a Composio server of this toolkit: a template that needs the toolkit maps to it, whatever its
    // name. A slug no template can name (mcp:<toolkit>/<tool>: no `_`) is saved as a Composio server of no toolkit.
    // Composio leaves out an action it does not serve, and a server that serves none of the picked ones lists no tools at
    // all: its MCP answers the listing "Method not found" (JSON-RPC -32601). Only that answer says "none served", in words
    // naming the picked actions; any other failure (no DNS, a timeout, an HTTP 500) stays the 424 it is.
    const server = await save({ url, auth: { type: "headers", headers: { "x-api-key": key } }, ...(prices ? { prices } : {}) }, { source: "composio", toolkit: MCP_SERVER_NAME.test(toolkit) ? toolkit : null }, stands).catch((error: unknown) => {
      if (!(error instanceof ApiError) || error.code !== "upstream_failed" || error.extra.details?.rpc_code !== METHOD_NOT_FOUND) throw error;
      throw invalid([issue("tools", "not_served", `Composio's ${toolkit} server doesn't serve ${(tools as string[]).join(", ")}: pick another action.`)]);
    });
    // Composio's server can leave out an action it was allowed (HACKERNEWS_GET_FRONTPAGE, live 11-13): say which, so a grant
    // doesn't vanish without a word. A toolkit with no account yet still lists its actions, so this holds before the connect.
    const served = new Set((server.tools ?? []).map((tool) => tool.name));
    const missing = (tools as string[]).filter((slug) => !served.has(slug));
    return { server, ...(connect ? { connect_url: connect } : {}), ...(missing.length ? { not_served: missing } : {}) };
  } catch (error) {
    if (url && savedUrl && (await savedUrl().catch(() => undefined)) === url) throw error;
    const left = await removing(ask, [...madeHere].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]), []);
    if (!left.length || !(error instanceof ApiError)) throw error;
    // In its message, and in its details too when it was refused on a field (422 input_invalid): a page that shows the
    // fields' words in place of the message still says what is left at Composio.
    const note = said(name, [], [], left).note;
    throw new ApiError(error.code, `${error.message} ${note}`, error.extra.fields?.length ? { ...error.extra, details: { ...error.extra.details, composio: note } } : error.extra, error.headers);
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
/** "a", "a and b", "a, b and c" (or "a, b or c"). */
const listed = (items: string[], word = "and"): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`);

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
