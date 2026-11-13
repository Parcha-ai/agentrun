// Under --faux only: the fetch the Anthropic and OpenAI providers send through (model.ts FAUX_UPSTREAM_ENV), in place of
// their APIs: it answers web_search's one request to the provider's hosted search (hosted-search.ts) as each provider
// streams it, the search, its result, and a short answer citing the public page, with the searches it ran in its usage.
// AGENTRUN_TEST_FAUX_UPSTREAM set to "pause" ends Anthropic's answer on pause_turn. Each request's path, key header and
// body are filed in AGENTRUN_TEST_FAUX_UPSTREAM_CALLS.
import { appendFileSync } from "node:fs";

const PAGE = "http://public.example/";
const ANSWER = "The public page says the answer is forty-two.";
const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

function anthropic(body) {
  const query = body.messages?.[0]?.content?.[0]?.text ?? "";
  const pause = process.env.AGENTRUN_TEST_FAUX_UPSTREAM === "pause";
  return sse([
    { type: "message_start", message: { id: "msg_faux_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 20_000, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: PAGE, title: "Public page", encrypted_content: "enc-1", page_age: "October 1, 2026" }, { type: "web_search_result", url: "https://result.example/2", title: "Result 2", encrypted_content: "enc-2" }] } },
    { type: "content_block_stop", index: 1 },
    ...(pause ? [] : [
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "", citations: [] } },
      { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: PAGE, title: "Public page", encrypted_index: "ix-1", cited_text: "The answer is forty-two." } } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: ANSWER } },
      { type: "content_block_stop", index: 2 },
    ]),
    { type: "message_delta", delta: { stop_reason: pause ? "pause_turn" : "end_turn", stop_sequence: null }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } } },
    { type: "message_stop" },
  ]);
}

function openai(body) {
  const query = body.input?.[0]?.content?.[0]?.text ?? "";
  const search = { type: "web_search_call", id: "ws_faux_1", status: "completed", action: { type: "search", query, sources: [{ type: "url", url: PAGE }, { type: "url", url: "https://result.example/2" }] } };
  const text = `${ANSWER} ([public.example](${PAGE}))`;
  const message = { type: "message", id: "msg_faux_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url: PAGE, title: "Public page", start_index: ANSWER.length + 1, end_index: text.length }] }] };
  return sse([
    { type: "response.created", response: { id: "resp_faux_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...search, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: search },
    { type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_faux_1", output_index: 1, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response: { id: "resp_faux_1", status: "completed", output: [search, message], usage: { input_tokens: 20_000, output_tokens: 40, total_tokens: 20_040, input_tokens_details: { cached_tokens: 0 } }, tool_usage: { web_search: { num_requests: 1 } } } },
  ]);
}

export default async function fakeUpstream(url, init = {}) {
  const path = new URL(String(url)).pathname;
  const headers = new Headers(init.headers);
  // A request with no JSON body is no model request: a stranger's probe of a loopback port (a bare `GET /`, F3) is
  // answered 400, never parsed into the test or filed among its calls.
  let body;
  try {
    body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body ?? new Uint8Array()));
  } catch {
    return new Response("not a model request: its body is not JSON", { status: 400 });
  }
  if (process.env.AGENTRUN_TEST_FAUX_UPSTREAM_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_UPSTREAM_CALLS, `${JSON.stringify({ path, key: headers.get("x-api-key") ?? headers.get("authorization"), body })}\n`);
  if (path === "/v1/messages") return anthropic(body);
  if (path === "/v1/responses") return openai(body);
  return new Response("not here", { status: 404 });
}
