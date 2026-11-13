// A fake Composio on loopback: the REST calls the Composio preset makes (composio-preset.ts), each recorded, and the MCP
// endpoint its generate call names, a fake MCP server (fake-mcp-server.mjs) at /v3/mcp/<id>/mcp. As the real one does, it
// answers a request without the right x-api-key 401, and /v3/mcp/<id> without the /mcp suffix with a redirect.
// `toolkits`: by slug, `{ no_auth, tools: [{ slug, name, description }] }`; as the real one, a toolkit's own answer says
// no_auth only as `auth_config_details[].mode` "NO_AUTH" (only the toolkit list has a `no_auth` field). `authConfigs`: by toolkit slug, the auth configs
// it already has. `active`: toolkit slugs the user already has an ACTIVE connected account for. `fail`: `{ path, status }`
// makes the call whose path ends in `path` answer that status.
import { createServer } from "node:http";
import { startFakeMcp } from "./fake-mcp-server.mjs";

export async function startFakeComposio({ apiKey = "fake-test-key", toolkits, authConfigs = {}, active = [], fail } = {}) {
  const calls = [];
  const mcpKeys = [];
  const id = "srv_fake1";
  const mcp = await startFakeMcp({ path: `/v3/mcp/${id}/mcp`, inspect: (headers) => mcpKeys.push(headers["x-api-key"]) });
  const mcpOrigin = new URL(mcp.url).origin;
  let made = 0;
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://x");
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, keyOk: req.headers["x-api-key"] === apiKey });
    const reply = (status, value) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    if (req.headers["x-api-key"] !== apiKey) return reply(401, { error: { message: "Invalid API key" } });
    if (fail && url.pathname.endsWith(fail.path)) return reply(fail.status, { error: { message: `Composio refused ${fail.path}` } });
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
    if (req.method === "POST" && url.pathname === "/api/v3.1/mcp/servers/generate") return reply(200, { user_ids_url: body.user_ids.map((u) => `${mcpOrigin}/v3/mcp/${id}?user_id=${u}&include_composio_helper_actions=true`) });
    if (req.method === "GET" && url.pathname === "/api/v3/connected_accounts") return reply(200, { items: active.includes(url.searchParams.get("toolkit_slugs")) ? [{ status: "ACTIVE" }] : [{ status: "INITIATED" }] });
    if (req.method === "POST" && url.pathname === "/api/v3/connected_accounts/link") return reply(201, { redirect_url: `https://connect.composio.test/link/${body.auth_config_id}` });
    return reply(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${http.address().port}`,
    apiKey, calls, mcpKeys, mcpId: id, mcpLog: mcp.log,
    /** The calls to `path` (the Composio API's, exact), in order. */
    to: (path, method) => calls.filter((call) => call.path === path && (!method || call.method === method)),
    close: async () => { await mcp.close(); await new Promise((resolve) => (http.close(resolve), http.closeAllConnections())); },
  };
}
