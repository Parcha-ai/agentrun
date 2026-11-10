// A fake network with one MCP server on it, reached only through the fetch it hands out: no sockets. The server speaks the
// 2026-07-28 revision's stateless Streamable HTTP (server/discover, tools/list in pages, tools/call), each answer JSON.
// Every request to any origin is logged with its headers, so a test can say where a credential went. Faults are set on
// `fake.fault` per JSON-RPC method (or "*"): a status, a redirect, a hang until the request's signal aborts, or a JSON-RPC
// error. A tool's `run` gets its arguments and the request's headers, so it can echo a credential back.

export const ORIGIN = "https://mcp.example.test";
export const URL_ = `${ORIGIN}/mcp`;
export const ELSEWHERE = "https://elsewhere.example.test";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The tools a fake starts with, by name. */
export const baseTools = () => ({
  add: { title: "Add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true }, run: ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }) },
  delete_thing: { description: "Delete a thing by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { destructiveHint: true }, run: ({ id }) => ({ content: [{ type: "text", text: `deleted ${id}` }] }) },
  write_line: { description: "Write a line.", inputSchema: { type: "object", properties: { line: { type: "string" } } }, run: ({ line }) => ({ content: [{ type: "text", text: `wrote ${line}` }] }) },
});

export function fakeMcpNetwork({ tools = baseTools(), pageSize = 2 } = {}) {
  const log = [];
  const fake = {
    tools,
    log,
    pageSize,
    /** `{ [method or "*"]: { status?, location?, hang?, rpcError?, body?, headers? } }`, read at each request. */
    fault: {},
    /** The JSON-RPC methods the server was asked, in order (notifications too). */
    methods: () => log.filter((entry) => entry.origin === ORIGIN).map((entry) => entry.method),
    fetch: async (input, init = {}) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers);
      const text = request.method === "POST" ? await request.text() : "";
      let message;
      try {
        message = JSON.parse(text);
      } catch {}
      log.push({ origin: url.origin, href: url.href, method: message?.method, tool: message?.method === "tools/call" ? message.params?.name : undefined, headers, redirect: init.redirect });
      if (url.origin !== ORIGIN) return json({ taken: true });
      const fault = fake.fault[message?.method] ?? fake.fault["*"];
      if (fault?.hang) {
        return new Promise((_, reject) => {
          const stop = () => reject(init.signal.reason ?? new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) return stop();
          init.signal?.addEventListener("abort", stop, { once: true });
        });
      }
      if (fault?.status) {
        const echoed = typeof fault.body === "function" ? fault.body(headers) : fault.body ?? `{"error":"refused"}`;
        return new Response(echoed, { status: fault.status, headers: { "content-type": "application/json", ...(fault.location ? { location: typeof fault.location === "function" ? fault.location(headers) : fault.location } : {}), ...(typeof fault.headers === "function" ? fault.headers(headers) : fault.headers ?? {}) } });
      }
      if (!message || message.id === undefined) return new Response(null, { status: 202 });
      const answer = (result) => json({ jsonrpc: "2.0", id: message.id, result: { ...result, resultType: "complete" } });
      if (fault?.rpcError) return json({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: typeof fault.rpcError === "function" ? fault.rpcError(headers) : fault.rpcError } });
      switch (message.method) {
        case "server/discover":
          return answer({ supportedVersions: ["2026-07-28"], capabilities: { tools: { listChanged: false } }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1.0.0" } } });
        case "tools/list": {
          const all = Object.entries(fake.tools).map(([name, { run: _run, ...tool }]) => ({ name, ...tool }));
          const at = Number(message.params?.cursor ?? 0);
          const page = all.slice(at, at + fake.pageSize);
          // A list result of the 2026-07-28 revision says how long it may be cached, and for whom.
          return answer({ tools: page, ttlMs: 0, cacheScope: "private", ...(at + fake.pageSize < all.length ? { nextCursor: String(at + fake.pageSize) } : {}) });
        }
        case "tools/call": {
          const tool = fake.tools[message.params?.name];
          if (!tool) return json({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `no tool ${message.params?.name}` } });
          return answer(await tool.run(message.params?.arguments ?? {}, headers));
        }
        default:
          return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
      }
    },
  };
  return fake;
}

/** A credential over `values` (header name to value): header() gives the pair as it is sent; nothing else reads it. */
export const credentialOf = (values, extra = {}) => ({
  header: (name, scheme) => [name, scheme ? `${scheme} ${values[name]}` : values[name]],
  connection: () => "connection-1",
  ...extra,
});
