// A remote MCP server for tests, on loopback: Streamable HTTP through the official SDK (@modelcontextprotocol/server),
// speaking the 2026-07-28 revision (with the SDK's 2025 fallback) or, with `era: "legacy"`, 2025-era `initialize` only.
// With a `token` it answers 401 to a request without `Authorization: Bearer <token>`; with `oauth` too, its 401 names
// protected-resource metadata, as a server behind OAuth does. Every request is logged: method, tool, and whether an
// Authorization header came, never its value.
import { createServer } from "node:http";
import { createMcpHandler, fromJsonSchema, legacyStatelessFallback, McpServer } from "@modelcontextprotocol/server";

const number = { type: "number" };
const text = { type: "string" };
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const answer = (value) => ({ content: [{ type: "text", text: String(value) }] });

/** The tools every fake serves, by name; a test may add, change or drop one, and the next list shows it. */
export const baseTools = () => ({
  add: { title: "Add", description: "Add two numbers.", input: object({ a: number, b: number }), annotations: { readOnlyHint: true }, run: ({ a, b }) => answer(a + b) },
  slow_write: { description: "Write a line after a wait.", input: object({ line: text, seconds: number }), run: async ({ line, seconds }) => (await new Promise((done) => setTimeout(done, seconds * 1000)), answer(`wrote ${line}`)) },
  delete_thing: { description: "Delete a thing by id.", input: object({ id: text }), annotations: { destructiveHint: true }, run: ({ id }) => answer(`deleted ${id}`) },
  paid: { description: "A call the server bills.", input: object({ query: text }), run: ({ query }) => answer(`paid for ${query}`) },
});

export async function startFakeMcp({ era = "modern", token, oauth = false, port = 0, name = "fake-mcp" } = {}) {
  const tools = baseTools();
  const log = [];
  const factory = () => {
    const server = new McpServer({ name, version: "1.0.0" });
    for (const [tool, { run, input, ...config }] of Object.entries(tools)) server.registerTool(tool, { ...config, inputSchema: fromJsonSchema(input) }, run);
    return server;
  };
  const handle = era === "legacy" ? legacyStatelessFallback(factory) : createMcpHandler(factory).fetch;
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {}
    for (const one of [message ?? {}].flat()) log.push({ http: req.method, path: req.url, method: one.method, tool: one.method === "tools/call" ? one.params?.name : undefined, authorization: req.headers.authorization !== undefined });
    const base = `http://127.0.0.1:${http.address().port}`;
    if (req.url === "/.well-known/oauth-protected-resource" || req.url === "/.well-known/oauth-protected-resource/mcp") {
      if (!oauth) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] }));
    }
    if (req.url !== "/mcp") return void res.writeHead(404).end();
    if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": oauth ? `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` : 'Bearer realm="fake"' });
      return void res.end('{"error":"unauthorized"}');
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const response = await handle(new Request(`${base}${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise((resolve) => http.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  return { url, log, tools, close: () => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())) };
}

