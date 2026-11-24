// A fake of Firecrawl's keyless MCP endpoint on 127.0.0.1, for keyless Firecrawl's tests (firecrawl-keyless.ts): MCP's
// streamable HTTP transport, answering in event streams as Firecrawl's server does, and naming no session (Firecrawl's
// keyless endpoint returns no mcp-session-id). Only a POST to its own path, /v2/mcp-<a random nonce>, is the fake's: each
// is kept in `got` (headers and JSON body) and answered; any other request (another path or method, as the GET / a dev
// tool on the box sends to each new listener) is answered 404, never kept. `calls(tool)` counts the tools/call requests
// for one tool.
//
// `answer(name, args, n)` answers the nth tools/call (n counted over every tool): an object `{status, headers}` for that
// HTTP status with no JSON-RPC answer, `{rpcError}` for a JSON-RPC error with that message, or a tool result (`{content,
// isError?, structuredContent?}`). By default firecrawl_search answers SEARCH_HITS and firecrawl_scrape PAGE, as
// Firecrawl's keyless tools answer them. refusal() makes Firecrawl's keyless refusal (its recoveryPayload) as a tool
// result, in its structuredContent or its text; dailyLimit() its plain-text answer once its daily limit is spent.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** Firecrawl's own words in a refusal, with its sign-up link: a call never passes them on. */
export const FIRECRAWL_SIGNUP = "Keyless usage limit reached. Sign up for a free Firecrawl API key at https://www.firecrawl.dev/signup to continue.";

/** The results firecrawl_search answers by default, as its keyless tool does: JSON in its one text block. */
export const SEARCH_HITS = [
  { url: "https://first.example/widgets", title: "Widgets, explained", description: "All about [widgets](https://first.example/more) and   their uses.", position: 1, source: "web" },
  { url: "https://second.example/gadgets", title: "Gadgets", description: "A second result.", position: 2, source: "web" },
  { url: "not a url", title: "Broken", description: "No URL this server reads.", position: 3, source: "web" },
];
/** The page firecrawl_scrape answers by default. */
export const PAGE = { markdown: "# Read by Firecrawl\n\nThe answer is forty-two. See [the registry](https://registry.example/1).", metadata: { title: "Read by Firecrawl", sourceURL: "http://public.example/", statusCode: 200 } };

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** Firecrawl's keyless refusal of a call: `code`, its words and sign-up link, and `retry_after_seconds` where given; as
 *  the result's structuredContent (`where: "structured"`) or as JSON in its text (`where: "text"`). */
export function refusal(code, { retryAfter, where = "text" } = {}) {
  const payload = { code, request_id: "req-fake-1", auth_mode: "keyless", message: FIRECRAWL_SIGNUP, signup_url: "https://www.firecrawl.dev/signup", ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }) };
  return where === "structured" ? { content: [{ type: "text", text: FIRECRAWL_SIGNUP }], structuredContent: payload, isError: true } : { ...text(payload), isError: true };
}

/** Firecrawl's answer once its keyless daily limit is spent, as it was seen on 2026-11-24: plain text, no code. */
export const FIRECRAWL_DAILY_LIMIT = "daily limit without an account was reached";

/** Firecrawl's daily-limit answer to a call: a tool result marked isError (`where: "text"`), or a JSON-RPC error
 *  (`where: "rpc"`). */
export const dailyLimit = (where = "text") => (where === "rpc" ? { rpcError: FIRECRAWL_DAILY_LIMIT } : { content: [{ type: "text", text: FIRECRAWL_DAILY_LIMIT }], isError: true });

/** The default answer of each keyless tool. */
export const answers = (name) => (name === "firecrawl_search" ? text({ success: true, data: { web: SEARCH_HITS } }) : name === "firecrawl_scrape" ? text(PAGE) : { content: [{ type: "text", text: `Tool ${name} not found` }], isError: true });

export async function firecrawlServer(t, answer = (name) => answers(name)) {
  const path = `/v2/mcp-${randomUUID()}`;
  const got = [];
  let n = 0;
  const stream = (res, message) => res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || new URL(req.url, "http://h").pathname !== path) {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(400).end();
      return;
    }
    got.push({ headers: req.headers, body });
    if (body.method === "initialize") return stream(res, { id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "firecrawl-fastmcp", version: "3.41.0" } } });
    if (body.method === "notifications/initialized") return void res.writeHead(202).end();
    if (body.method !== "tools/call") return stream(res, { id: body.id, error: { code: -32601, message: "no such method" } });
    const said = await answer(body.params.name, body.params.arguments, (n += 1));
    if (said && typeof said.status === "number") return void res.writeHead(said.status, { "content-type": "application/json", ...said.headers }).end(JSON.stringify({ error: "refused" }));
    if (said && typeof said.rpcError === "string") return stream(res, { id: body.id, error: { code: -32000, message: said.rpcError } });
    return stream(res, { id: body.id, result: said });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const toolCalls = () => got.filter((one) => one.body.method === "tools/call");
  return { url: `http://127.0.0.1:${server.address().port}${path}`, got, toolCalls, calls: (tool) => toolCalls().filter((one) => one.body.params.name === tool).length };
}
