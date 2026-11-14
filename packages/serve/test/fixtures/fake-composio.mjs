// A fake Composio on loopback: the REST calls the Composio preset makes (composio-preset.ts), each recorded, and the MCP
// endpoint its generate call names, a fake MCP server (fake-mcp-server.mjs) at /v3/mcp/<id>/mcp. As the real one does, it
// answers a request without the right x-api-key 401, and /v3/mcp/<id> without the /mcp suffix with a redirect.
// `toolkits`: by slug, `{ no_auth, tools: [{ slug, name, description }] }`; as the real one, a toolkit's own answer says
// no_auth only as `auth_config_details[].mode` "NO_AUTH" (only the toolkit list has a `no_auth` field). `authConfigs`: by toolkit slug, the auth configs
// it already has. `active`: toolkit slugs the user already has an ACTIVE connected account for, under the auth config the
// call names. `accounts`: by toolkit slug, the user's accounts as `{ status, auth_config }` (an ACTIVE one under another
// config, say); as the real one, `auth_config_ids` narrows the list to those under it. `noTools`: its MCP endpoint serves no tool at all. `listStatus`: its MCP endpoint answers every request after the first handshake with that HTTP status (an outage, not an answer "no"). `fail`: `{ path, status, method? }`
// makes the call whose path ends in `path` (or for which `path`, a function, holds) answer that status.
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

export async function startFakeComposio({ apiKey = "fake-test-key", toolkits, authConfigs = {}, active = [], accounts = {}, fail, noTools = false, listStatus } = {}) {
  const calls = [];
  const strays = [];
  const mcpKeys = [];
  const own = `/fake-composio-${randomBytes(6).toString("hex")}`;
  const id = `srv_fake_${randomBytes(4).toString("hex")}`;
  const inspect = (headers) => mcpKeys.push(headers["x-api-key"]);
  const mcp = noTools || listStatus ? await startEmptyMcp(`/v3/mcp/${id}/mcp`, inspect, listStatus) : await startFakeMcp({ path: `/v3/mcp/${id}/mcp`, inspect });
  const mcpOrigin = new URL(mcp.url).origin;
  let made = 0;
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
    if (fail && (!fail.method || fail.method === req.method) && (typeof fail.path === "function" ? fail.path(url.pathname) : url.pathname.endsWith(fail.path))) return reply(fail.status, { error: { message: `Composio refused ${url.pathname}` } });
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
      return reply(200, { items: listed.filter((a) => !under || a.auth_config === under).map((a) => ({ status: a.status, auth_config: { id: a.auth_config } })) });
    }
    if (req.method === "POST" && url.pathname === "/api/v3/connected_accounts/link") return reply(201, { redirect_url: `https://connect.composio.test/link/${body.auth_config_id}` });
    return reply(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${http.address().port}${own}`,
    apiKey, calls, strays, mcpKeys, mcpId: id,
    /** The fake MCP server's log of the requests on its endpoint (a stray on another path is not one). */
    get mcpLog() { return mcp.log.filter((entry) => new URL(entry.path, "http://x").pathname === `/v3/mcp/${id}/mcp`); },
    /** The calls to `path` (the Composio API's, exact), in order. */
    to: (path, method) => calls.filter((call) => call.path === path && (!method || call.method === method)),
    close: async () => { await mcp.close(); await new Promise((resolve) => (http.close(resolve), http.closeAllConnections())); },
  };
}
