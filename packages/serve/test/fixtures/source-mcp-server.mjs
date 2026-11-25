// Controlled, authenticated upstream for native-source Move acceptance. Uses the real SDK transport; no model.
// Credentials exist only in this closure and the caller's private receipt. Audit stores fixed method/resource names
// and principal labels, never headers, argument values, URI variables, request IDs or exception text.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createMcpHandler, fromJsonSchema, McpServer, ProtocolError, ResourceTemplate } from "@modelcontextprotocol/server";
import { stranger } from "./stranger.mjs";

const VALUES = { alpha: 17, beta: 29, gamma: 41 };
const INPUT = { type: "object", properties: { item: { type: "string", enum: Object.keys(VALUES) } }, required: ["item"], additionalProperties: false };
const EMPTY = { type: "object", properties: {}, additionalProperties: false };
const METHODS = new Set(["initialize", "notifications/initialized", "server/discover", "ping", "tools/list", "tools/call", "resources/list", "resources/templates/list", "resources/read", "notifications/cancelled"]);
const RESOURCES = [
  { name: "catalog", uri: "fixture://catalog/info", mimeType: "application/json" },
  { name: "rules", uri: "fixture://catalog/rules", mimeType: "application/json" },
];
const TEMPLATES = [
  { name: "item", uriTemplate: "fixture://item/{item}", mimeType: "application/json" },
  { name: "note", uriTemplate: "fixture://note/{item}", mimeType: "application/json" },
];
const principalName = value => {
  if (typeof value !== "string" || !/^[a-z][a-z-]{0,31}$/.test(value)) throw new Error("Use a short fixture principal label.");
  return value;
};
const invalid = () => new ProtocolError(-32602, "Invalid fixture request.");

/** issue(principal) returns a fresh private bearer credential; multiple credentials may name one principal.
 * oauth accepts the existing fake-oauth-server's {issuer,accepts} plus a fixed principal. Tool selection is NOT
 * enforced here: delete_denied really dispatches if a broken source/destination gate sends it. resourceOnly has
 * no tool capability at all. pageSize bounds each list page, including tools and resource templates. */
export async function startSourceMcp({ resourceOnly = false, pageSize = 1, oauth } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Invalid fixture page size.");
  if (oauth) principalName(oauth.principal);
  const credentials = new Map(), audit = [], tools = new Map();
  const record = row => audit.push({ sequence: audit.length + 1, ...row });
  const principalOf = header => typeof header === "string" && header.startsWith("Bearer ")
    ? credentials.get(header.slice(7)) ?? (oauth?.accepts(header) ? oauth.principal : null) : null;
  const metadata = (name, destructive = false) => ({ name,
    description: destructive ? "Delete a controlled fixture item. This operation must remain denied by the source's policy." : "Read the fixture item's exact numeric value for this account.",
    inputSchema: destructive ? EMPTY : INPUT,
    annotations: { readOnlyHint: !destructive, destructiveHint: destructive, idempotentHint: !destructive, openWorldHint: false },
  });
  if (!resourceOnly) {
    tools.set("read_allowed", metadata("read_allowed"));
    tools.set("delete_denied", metadata("delete_denied", true));
  }
  const page = (kind, values, cursor) => {
    const match = cursor === undefined ? null : new RegExp(`^${kind}:([1-9][0-9]*)$`).exec(cursor);
    if (cursor !== undefined && !match) throw invalid();
    const from = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(from) || from > values.length) throw invalid();
    return { [kind]: values.slice(from, from + pageSize), ...(from + pageSize < values.length ? { nextCursor: `${kind}:${from + pageSize}` } : {}) };
  };
  const handle = createMcpHandler(({ requestInfo }) => {
    const principal = principalOf(requestInfo?.headers.get("authorization"));
    if (!principal) throw invalid(); // HTTP auth was checked before entering the SDK.
    const server = new McpServer({ name: resourceOnly ? "source-resources" : "source-tools", version: "1.0.0" });
    for (const [name, { inputSchema, ...config }] of tools) server.registerTool(name, { ...config, inputSchema: fromJsonSchema(inputSchema) }, args => {
      record({ phase: "dispatch", method: "tools/call", principal, tool: name });
      const value = name === "delete_denied" ? { principal, deleted: true } : { principal, item: args.item, value: VALUES[args.item] };
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    });
    for (const resource of RESOURCES) server.registerResource(resource.name, resource.uri, { mimeType: resource.mimeType }, uri => {
      record({ phase: "dispatch", method: "resources/read", principal, resource: resource.name });
      return { contents: [{ uri: uri.href, mimeType: resource.mimeType, text: JSON.stringify({ principal, marker: resource.name === "catalog" ? "catalog-v1" : "rules-v1" }) }] };
    });
    for (const template of TEMPLATES) server.registerResource(template.name, new ResourceTemplate(template.uriTemplate, { list: undefined }), { mimeType: template.mimeType }, (uri, variables) => {
      if (!Object.hasOwn(VALUES, variables.item)) throw invalid();
      record({ phase: "dispatch", method: "resources/read", principal, resource: template.name });
      return { contents: [{ uri: uri.href, mimeType: template.mimeType, text: JSON.stringify({ principal, item: variables.item, value: VALUES[variables.item] }) }] };
    });
    if (tools.size) server.server.setRequestHandler("tools/list", request => page("tools", [...tools.values()], request.params?.cursor));
    server.server.setRequestHandler("resources/list", request => page("resources", RESOURCES, request.params?.cursor));
    server.server.setRequestHandler("resources/templates/list", request => page("resourceTemplates", TEMPLATES, request.params?.cursor));
    return server;
  }, { onerror: () => {} }).fetch;
  const http = createServer(async (req, res) => {
    if (stranger(req, res)) return;
    try {
      const origin = `http://127.0.0.1:${http.address().port}`;
      const path = new URL(req.url, origin).pathname;
      if (oauth && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(path)) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [oauth.issuer] })); return;
      }
      if (path !== "/mcp") { req.resume(); res.writeHead(404).end(); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 128 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks); let message;
      try { message = JSON.parse(body.toString("utf8")); } catch {}
      const principal = principalOf(req.headers.authorization);
      for (const one of [message ?? {}].flat()) record({ phase: "request", method: METHODS.has(one?.method) ? one.method : "unknown", principal, authorized: principal !== null });
      if (!principal) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": oauth ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` : 'Bearer realm="source-fixture"' }).end('{"error":"unauthorized"}'); return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      const response = await handle(new Request(`${origin}/mcp`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end('{"error":"fixture failed"}');
      else res.end();
    }
  });
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`, audit,
    issue(principal) { const token = `fixture-${randomBytes(24).toString("hex")}`; credentials.set(token, principalName(principal)); return token; },
    revoke(token) { credentials.delete(token); },
    addReadTool(name) {
      if (resourceOnly || !/^[a-z][a-z_]{0,31}$/.test(name) || tools.has(name)) throw new Error("Invalid additional fixture tool.");
      tools.set(name, metadata(name));
    },
    close: () => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }),
  };
}
