// Under --faux only: the fetch web_search's keyless Exa search sends through (exa-keyless.ts), in place of Exa's MCP
// endpoint: a stateful MCP server on the streamable HTTP transport, answering in event streams. initialize names a
// session, notifications/initialized is taken (202), and tools/call of web_search_exa answers Exa's text, a result per
// section, or as AGENTRUN_TEST_FAUX_EXA says. It is a comma-separated list, one entry for each search this process
// sends in turn (the last stands for every one after it): empty or `ok`, the results; a number, that HTTP status with
// Exa's JSON-RPC error (a 429 with Retry-After 30, as Exa's free limit answers); `429:<s>`, a 429 with Retry-After <s>;
// `limited`, Exa's own notice of its free limit inside a 200 (a tool result marked isError and `ai.exa/rateLimited`,
// its text telling the user to fix their MCP URL), as Exa answers when its search API refuses a keyless call. Each
// request is filed in AGENTRUN_TEST_FAUX_EXA_CALLS: its method, session, arguments and whether it held a key.
import { appendFileSync } from "node:fs";

const SESSION = "sess-faux-exa-1";
const stream = (message, headers = {}) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
/** Exa's own words past its free limit, which name a fix (an API key in its MCP URL) that means nothing to a person
 *  using agentrun: a search answers none of them. */
export const EXA_LIMIT_TEXT = "You've hit Exa's free MCP rate limit. Create a free Exa account to get your own usage allowance and rate limits. No payment method required.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys , and then update Exa MCP URL to this https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY";

/** Exa's answer to a search for `query`: `n` results, the first the public page with a note before it. */
export function exaText(query, n) {
  const first = "Title: Public page\nURL: http://public.example/\nPublished: 2026-10-01T00:00:00.000Z\nAuthor: N/A\nHighlights:\nThe answer is forty-two.\nSee [the registry](https://registry.example/1) for more.";
  const rest = Array.from({ length: Math.max(0, n - 1) }, (_, i) => `Title: Result ${i + 2} for ${query}\nURL: https://result.example/${i + 2}\nPublished: N/A\nAuthor: N/A\nText: Excerpt ${i + 2}.`);
  return `Note: results may be cached.\n\n${[first, ...rest].join("\n\n---\n\n")}`;
}

let searches = 0;
let counted = "";
/** The entry of AGENTRUN_TEST_FAUX_EXA the next search is answered by: counted from the first search under this mode. */
function step(mode) {
  if (mode !== counted) [counted, searches] = [mode, 0];
  const steps = mode.split(",");
  return steps[Math.min(searches++, steps.length - 1)].trim();
}

/** Counts searches from the first again, as a process that has sent none (a test that sets the same mode twice). */
export const resetFauxExa = () => void ([counted, searches] = ["", 0]);

export default async function fakeExa(url, init = {}) {
  const headers = new Headers(init.headers);
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  if (process.env.AGENTRUN_TEST_FAUX_EXA_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_EXA_CALLS, `${JSON.stringify({ pid: process.pid, url: String(url), method: body.method, session: headers.get("mcp-session-id"), keyed: headers.has("x-api-key") || headers.has("authorization"), ...(body.params?.name ? { tool: body.params.name, arguments: body.params.arguments } : {}) })}\n`);
  if (body.method === "initialize") return stream({ id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "faux-exa", version: "0" } } }, { "mcp-session-id": SESSION });
  if (headers.get("mcp-session-id") !== SESSION) return new Response("unknown session", { status: 404 });
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (body.method !== "tools/call" || body.params?.name !== "web_search_exa") return stream({ id: body.id, error: { code: -32601, message: "no such method" } });
  const answer = step(process.env.AGENTRUN_TEST_FAUX_EXA ?? "");
  const status = /^(\d+)(?::(\d+))?$/.exec(answer);
  if (status) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: EXA_LIMIT_TEXT } }), { status: Number(status[1]), headers: { "content-type": "application/json", "retry-after": status[2] ?? "30" } });
  if (answer === "limited") return stream({ id: body.id, result: { content: [{ type: "text", text: EXA_LIMIT_TEXT }], isError: true, _meta: { "ai.exa/rateLimited": true } } });
  return stream({ id: body.id, result: { content: [{ type: "text", text: exaText(body.params.arguments.query, body.params.arguments.numResults ?? 10) }] } });
}
