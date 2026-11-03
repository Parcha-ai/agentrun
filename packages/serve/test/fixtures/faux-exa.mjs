// Under --faux only: the fetch web_search's keyless Exa search sends through (exa-keyless.ts), in place of Exa's MCP
// endpoint: a stateful MCP server on the streamable HTTP transport, answering in event streams. initialize names a
// session, notifications/initialized is taken (202), and tools/call of web_search_exa answers Exa's text, a result per
// section, or as AGENTRUN_TEST_FAUX_EXA says: a number answers that HTTP status (429 with Retry-After, as Exa's free limit
// does). Each request is filed in AGENTRUN_TEST_FAUX_EXA_CALLS: its method, session, arguments and whether it held a key.
import { appendFileSync } from "node:fs";

const SESSION = "sess-faux-exa-1";
const stream = (message, headers = {}) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });

/** Exa's answer to a search for `query`: `n` results, the first the public page with a note before it. */
export function exaText(query, n) {
  const first = "Title: Public page\nURL: http://public.example/\nPublished: 2026-10-01T00:00:00.000Z\nAuthor: N/A\nHighlights:\nThe answer is forty-two.\nSee [the registry](https://registry.example/1) for more.";
  const rest = Array.from({ length: Math.max(0, n - 1) }, (_, i) => `Title: Result ${i + 2} for ${query}\nURL: https://result.example/${i + 2}\nPublished: N/A\nAuthor: N/A\nText: Excerpt ${i + 2}.`);
  return `Note: results may be cached.\n\n${[first, ...rest].join("\n\n---\n\n")}`;
}

export default async function fakeExa(url, init = {}) {
  const headers = new Headers(init.headers);
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  if (process.env.AGENTRUN_TEST_FAUX_EXA_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_EXA_CALLS, `${JSON.stringify({ pid: process.pid, url: String(url), method: body.method, session: headers.get("mcp-session-id"), keyed: headers.has("x-api-key") || headers.has("authorization"), ...(body.params?.name ? { tool: body.params.name, arguments: body.params.arguments } : {}) })}\n`);
  const mode = process.env.AGENTRUN_TEST_FAUX_EXA ?? "";
  if (body.method === "initialize") return stream({ id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "faux-exa", version: "0" } } }, { "mcp-session-id": SESSION });
  if (headers.get("mcp-session-id") !== SESSION) return new Response("unknown session", { status: 404 });
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (/^\d+$/.test(mode)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "You've hit Exa's free MCP rate limit." } }), { status: Number(mode), headers: { "content-type": "application/json", "retry-after": "30" } });
  if (body.method !== "tools/call" || body.params?.name !== "web_search_exa") return stream({ id: body.id, error: { code: -32601, message: "no such method" } });
  return stream({ id: body.id, result: { content: [{ type: "text", text: exaText(body.params.arguments.query, body.params.arguments.numResults ?? 10) }] } });
}
