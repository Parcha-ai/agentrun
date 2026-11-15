// A fake Composio on loopback: the REST calls the Composio preset makes (composio-preset.ts), each recorded, and the MCP
// endpoint its generate call names, a fake MCP server (fake-mcp-server.mjs) at /v3/mcp/<id>/mcp. As the real one does, it
// answers a request without the right x-api-key 401, and /v3/mcp/<id> without the /mcp suffix with a redirect.
// `toolkits`: by slug, `{ no_auth, tools: [{ slug, name, description }] }`; as the real one, a toolkit's own answer says
// no_auth only as `auth_config_details[].mode` "NO_AUTH" (only the toolkit list has a `no_auth` field). `authConfigs`: by toolkit slug, the auth configs
// it already has. `active`: toolkit slugs the user already has an ACTIVE connected account for, under the auth config the
// call names. `accounts`: by toolkit slug, the user's accounts as `{ status, auth_config, id?, created_at? }` (an ACTIVE one under another
// config, say); as the real one, `auth_config_ids` narrows the list to those under it. `noTools`: its MCP endpoint serves no tool at all. `listStatus`: its MCP endpoint answers every request after the first handshake with that HTTP status (an outage, not an answer "no"). `fail`: `{ path, status, method? }`
// makes the call whose path ends in `path` (or for which `path`, a function, holds) answer that status; a list of them
// fails each.
// Triggers (composio-triggers.ts): the project's one webhook subscription (`subscription`: one it already has, `{ webhook_url,
// secret? }`; a second create answers 409, as the real one does), its secret in every answer and new at each rotation;
// `triggerTypes`: by toolkit slug, the trigger types it lists (`pageSize` pages the list); and the trigger instances an
// upsert makes, one per slug, account and config (the same again answers the same id and turns it on again, as the real
// one does), each listed by GET /trigger_instances/active (a disabled one only with show_disabled=true), turned on and off
// by PATCH and deleted by DELETE /trigger_instances/manage/{id}. An upsert for an account that is not ACTIVE, or whose
// config misses a required field, is refused 400. Connected accounts carry their id (`ca_fake_<toolkit>`) and user_id.
// Its base URL carries a path of its own, new each start, and its MCP server's id is new each start too: a request on its
// port that the server under test didn't send (a port prober on the host GETs / on each new loopback listener; another
// test process's client may still call a port it freed, which this fake then took) is not one of its calls. Such a
// request is answered 404 and kept apart in `strays`, never in `calls`, so a stray without the key can't read as the
// server sending none (fixtures/stranger.mjs); `mcpLog` likewise holds only the requests on the MCP endpoint's own path.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { startFakeMcp } from "./fake-mcp-server.mjs";
import { stranger } from "./stranger.mjs";

/** An MCP endpoint that serves no tools, as Composio's does when none of the allowed actions is one it serves: it agrees a
 *  protocol and answers every other method "Method not found". */
async function startEmptyMcp(path, inspect, listStatus) {
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    inspect(req.headers);
    let message = {};
    try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    if (new URL(req.url, "http://x").pathname !== path) return void res.writeHead(404).end();
    if (message.id === undefined) return void res.writeHead(202).end();
    if (listStatus && message.method !== "initialize") return void res.writeHead(listStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "down" }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(message.method === "initialize"
      ? { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "composio", version: "1" } } }
      : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${http.address().port}${path}`, log: [], close: () => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())) };
}

/** GitHub's new-issue event as Composio lists it (live 11-14): a webhook trigger whose config needs owner and repo. */
export const ISSUE_ADDED = {
  slug: "GITHUB_ISSUE_ADDED_EVENT", name: "Issue Added Event", description: "Triggered when a new issue is added to the repository.", instructions: "", type: "webhook", types: ["webhook"],
  toolkit: { slug: "github", name: "GitHub", logo: "" }, version: "20260101_00",
  config: { type: "object", title: "WebhookConfigSchema", required: ["owner", "repo"], properties: { owner: { type: "string", title: "Owner", description: "Owner of the repository" }, repo: { type: "string", title: "Repo", description: "Repository name" } } },
  payload: { type: "object", properties: { title: { type: "string" }, number: { type: "integer" } } },
};
/** A polled one: Composio checks for it every few minutes. */
export const STAR_ADDED = {
  slug: "GITHUB_STAR_ADDED_EVENT", name: "Star Added", description: "Triggered when a star is added to the repository.", instructions: "", type: "poll", types: ["poll"],
  toolkit: { slug: "github", name: "GitHub", logo: "" }, version: "20260101_00",
  config: { type: "object", title: "PollConfigSchema", required: ["owner", "repo"], properties: { owner: { type: "string", title: "Owner" }, repo: { type: "string", title: "Repo" }, interval: { type: "number", default: 2, deprecated: true, title: "Interval" } } },
  payload: { type: "object", properties: {} },
};

/** When an account was made, as Composio lists it, for one that names no other. */
const ACCOUNT_MADE = "2026-11-13T20:26:18.916Z";

export async function startFakeComposio({ apiKey = "fake-test-key", toolkits, authConfigs = {}, active = [], accounts = {}, fail, noTools = false, listStatus, subscription, triggerTypes = { github: [ISSUE_ADDED, STAR_ADDED] }, pageSize } = {}) {
  const calls = [];
  const strays = [];
  const mcpKeys = [];
  const own = `/fake-composio-${randomBytes(6).toString("hex")}`;
  const id = `srv_fake_${randomBytes(4).toString("hex")}`;
  const inspect = (headers) => mcpKeys.push(headers["x-api-key"]);
  const mcp = noTools || listStatus ? await startEmptyMcp(`/v3/mcp/${id}/mcp`, inspect, listStatus) : await startFakeMcp({ path: `/v3/mcp/${id}/mcp`, inspect });
  const mcpOrigin = new URL(mcp.url).origin;
  let made = 0;
  let madeSubs = 0;
  let madeInstances = 0;
  const secretOf = () => `cmp_whsec-${randomBytes(18).toString("base64url")}`;
  const at = () => new Date().toISOString();
  /** The project's subscriptions (at most one), as Composio keeps them. */
  const subscriptions = subscription ? [{ id: `ws_fake_${++madeSubs}`, webhook_url: subscription.webhook_url, version: "V3", enabled_events: ["composio.trigger.message"], secret: subscription.secret ?? secretOf(), created_at: at(), updated_at: at() }] : [];
  /** The trigger instances, by id. */
  const instances = new Map();
  const accountOf = (kit) => (active.includes(kit) ? { id: `ca_fake_${kit}`, status: "ACTIVE" } : undefined);
  const fails = (Array.isArray(fail) ? fail : fail ? [fail] : []);
  const instanceView = (i) => ({ id: i.id, uuid: `uuid-${i.id}`, connected_account_id: i.connected_account_id, connected_account_uuid: `uuid-${i.connected_account_id}`, user_id: i.user_id, trigger_name: i.trigger_name, trigger_config: i.trigger_config, version: "20260101_00", type: "webhook", fallback_reason: null, polling_interval: null, egress_url: null, state: {}, updated_at: at(), disabled_at: i.disabled_at });
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://x");
    if (stranger(req, res, { own: (path) => path.startsWith(`${own}/`), strays })) return;
    url.pathname = url.pathname.slice(own.length);
    let body;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, keyOk: req.headers["x-api-key"] === apiKey });
    const reply = (status, value) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    if (req.headers["x-api-key"] !== apiKey) return reply(401, { error: { message: "Invalid API key" } });
    const failing = fails.find((f) => (!f.method || f.method === req.method) && (typeof f.path === "function" ? f.path(url.pathname) : url.pathname.endsWith(f.path)));
    if (failing) return reply(failing.status, { error: { message: `Composio refused ${url.pathname}` } });
    const slug = url.searchParams.get("toolkit_slug");
    if (req.method === "GET" && url.pathname === "/api/v3/tools") {
      const known = toolkits[slug];
      return known ? reply(200, { items: known.tools, next_cursor: null }) : reply(404, { error: { message: `Toolkit ${slug} not found` } });
    }
    const one = /^\/api\/v3\/toolkits\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) return toolkits[one[1]] ? reply(200, { slug: one[1], auth_config_details: [{ mode: toolkits[one[1]].no_auth === true ? "NO_AUTH" : "OAUTH2" }] }) : reply(404, { error: { message: "Toolkit not found" } });
    if (req.method === "GET" && url.pathname === "/api/v3/auth_configs") return reply(200, { items: authConfigs[slug] ?? [] });
    if (req.method === "POST" && url.pathname === "/api/v3/auth_configs") return reply(201, { auth_config: { id: `ac_made_${++made}` } });
    if (req.method === "POST" && url.pathname === "/api/v3.1/mcp/servers/custom") return reply(201, { id });
    if (req.method === "DELETE" && url.pathname === `/api/v3.1/mcp/${id}`) return reply(200, { id, deleted: true });
    if (req.method === "POST" && url.pathname === "/api/v3.1/mcp/servers/generate") return reply(200, { user_ids_url: body.user_ids.map((u) => `${mcpOrigin}/v3/mcp/${id}?user_id=${u}&include_composio_helper_actions=true`) });
    if (req.method === "GET" && url.pathname === "/api/v3/connected_accounts") {
      const kit = url.searchParams.get("toolkit_slugs");
      const under = url.searchParams.get("auth_config_ids");
      const listed = [...(accounts[kit] ?? []), active.includes(kit) ? { status: "ACTIVE", auth_config: under ?? "ac_unnamed" } : { status: "INITIATED", auth_config: under ?? "ac_unnamed" }];
      const user = url.searchParams.get("user_ids") ?? "agentrun";
      return reply(200, { items: listed.filter((a) => !under || a.auth_config === under).map((a) => ({ id: a.id ?? `ca_fake_${kit}${a.status === "ACTIVE" ? "" : `_${a.status.toLowerCase()}`}`, user_id: user, status: a.status, toolkit: { slug: kit }, auth_config: { id: a.auth_config }, created_at: a.created_at ?? ACCOUNT_MADE })) });
    }
    if (req.method === "POST" && url.pathname === "/api/v3/connected_accounts/link") return reply(201, { redirect_url: `https://connect.composio.test/link/${body.auth_config_id}` });
    // The project's webhook subscription: one at most.
    if (url.pathname === "/api/v3/webhook_subscriptions") {
      if (req.method === "GET") return reply(200, { items: subscriptions, next_cursor: null, total_pages: subscriptions.length ? 1 : 0, current_page: 1, total_items: subscriptions.length });
      if (req.method === "POST") {
        if (subscriptions.length) return reply(409, { error: { message: "A webhook subscription already exists for this project. Only one subscription is allowed per project.", code: 409, slug: "WebhookSubscription_AlreadyExists", status: 409 } });
        if (typeof body?.webhook_url !== "string" || !Array.isArray(body.enabled_events)) return reply(400, { error: { message: "webhook_url and enabled_events are required" } });
        const sub = { id: `ws_fake_${++madeSubs}`, webhook_url: body.webhook_url, version: body.version ?? "V3", enabled_events: body.enabled_events, secret: secretOf(), created_at: at(), updated_at: at() };
        subscriptions.push(sub);
        return reply(201, sub);
      }
    }
    const sub = /^\/api\/v3\/webhook_subscriptions\/([^/]+)(\/rotate_secret)?$/.exec(url.pathname);
    if (sub) {
      const found = subscriptions.find((s) => s.id === sub[1]);
      if (!found) return reply(404, { error: { message: `No webhook subscription ${sub[1]}` } });
      if (sub[2] && req.method === "POST") return (found.secret = secretOf(), found.updated_at = at(), reply(200, { id: found.id, secret: found.secret }));
      if (!sub[2] && req.method === "GET") return reply(200, found);
      if (!sub[2] && req.method === "PATCH") return (Object.assign(found, body.webhook_url ? { webhook_url: body.webhook_url } : {}, body.enabled_events ? { enabled_events: body.enabled_events } : {}, { updated_at: at() }), reply(200, found));
      if (!sub[2] && req.method === "DELETE") return (subscriptions.splice(subscriptions.indexOf(found), 1), reply(200, { success: true }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3/triggers_types") {
      const all = (url.searchParams.get("toolkit_slugs") ?? "").split(",").flatMap((kit) => triggerTypes[kit] ?? []);
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const size = pageSize ?? all.length;
      const page = all.slice(from, from + size);
      return reply(200, { items: page, next_cursor: from + size < all.length ? String(from + size) : null, total_pages: 1, current_page: 1, total_items: all.length });
    }
    const upsert = /^\/api\/v3\/trigger_instances\/([^/]+)\/upsert$/.exec(url.pathname);
    if (req.method === "POST" && upsert) {
      const type = Object.values(triggerTypes).flat().find((t) => t.slug === upsert[1]);
      if (!type) return reply(404, { error: { message: `Trigger type ${upsert[1]} not found` } });
      const kit = type.toolkit.slug;
      const account = accountOf(kit);
      if (!account || (body.connected_account_id && body.connected_account_id !== account.id)) return reply(400, { error: { message: `No active connection found for user ${body.user_id ?? ""} and toolkit ${kit}` } });
      const config = body.trigger_config ?? {};
      const missing = (type.config.required ?? []).filter((field) => config[field] === undefined || config[field] === "");
      if (missing.length) return reply(400, { error: { message: `Invalid trigger config: ${missing.join(", ")} required` } });
      const same = [...instances.values()].find((i) => i.trigger_name === type.slug && i.connected_account_id === account.id && JSON.stringify(i.trigger_config) === JSON.stringify(config));
      if (same) return (same.disabled_at = null, reply(200, { trigger_id: same.id, type: "webhook", fallback_reason: null, polling_interval: null }));
      const made = { id: `ti_fake_${++madeInstances}`, trigger_name: type.slug, connected_account_id: account.id, user_id: body.user_id ?? "agentrun", trigger_config: config, disabled_at: null };
      instances.set(made.id, made);
      return reply(201, { trigger_id: made.id, type: "webhook", fallback_reason: null, polling_interval: null });
    }
    if (req.method === "GET" && url.pathname === "/api/v3/trigger_instances/active") {
      const ids = url.searchParams.get("trigger_ids")?.split(",");
      const listed = [...instances.values()].filter((i) => (!ids || ids.includes(i.id)) && (i.disabled_at === null || url.searchParams.get("show_disabled") === "true"));
      return reply(200, { items: listed.map(instanceView), next_cursor: null, total_pages: 1, current_page: 1, total_items: listed.length });
    }
    const manage = /^\/api\/v3\/trigger_instances\/manage\/([^/]+)$/.exec(url.pathname);
    if (manage) {
      const found = instances.get(manage[1]);
      if (!found) return reply(404, { error: { message: `Trigger ${manage[1]} not found` } });
      if (req.method === "PATCH") {
        if (body?.status !== "enable" && body?.status !== "disable") return reply(400, { error: { message: "status is enable or disable" } });
        found.disabled_at = body.status === "disable" ? at() : null;
        return reply(200, { status: "success" });
      }
      if (req.method === "DELETE") return (instances.delete(found.id), reply(200, { trigger_id: found.id }));
    }
    return reply(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${http.address().port}${own}`,
    apiKey, calls, strays, mcpKeys, mcpId: id,
    /** The project's webhook subscriptions as Composio keeps them now (at most one), secret and all. */
    subscriptions,
    /** The trigger instances as Composio keeps them now, by id: `{ id, trigger_name, connected_account_id, user_id,
     *  trigger_config, disabled_at }`. */
    instances,
    /** The fake MCP server's log of the requests on its endpoint (a stray on another path is not one). */
    get mcpLog() { return mcp.log.filter((entry) => new URL(entry.path, "http://x").pathname === `/v3/mcp/${id}/mcp`); },
    /** The calls to `path` (the Composio API's, exact), in order. */
    to: (path, method) => calls.filter((call) => call.path === path && (!method || call.method === method)),
    close: async () => { await mcp.close(); await new Promise((resolve) => (http.close(resolve), http.closeAllConnections())); },
  };
}
