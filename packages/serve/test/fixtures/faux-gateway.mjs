// A model gateway on loopback, for contract tests of the gateway path on every harness (pi, claude-agent, codex): no key,
// no network. It records each request as it arrived (method, path, the headers that carry a key or name an API version,
// and the JSON body) and answers the three APIs a gateway such as OpenRouter serves, each with its usage:
//   POST /v1/responses          OpenAI Responses (pi's gateway, codex)
//   POST /v1/messages           Anthropic Messages (claude-agent)
//   POST /v1/chat/completions   OpenAI Chat Completions
// A base with a path (`/api/v1/...`, as OpenRouter serves them) is answered the same: the route is the path's end. Any
// other path is recorded and answered 404, so a request sent to the wrong place shows in `requests` and fails its run.
// A POST whose body is not JSON is answered 400 and not recorded. A GET under the API's paths (`/v1/models`) is recorded and
// answered 404, as any other request, unless the gateway was given `models`: then GET /v1/models lists them, as OpenAI's
// list does (`{ object: "list", data: [{ id }] }`), to a request with the `key` it was given when it was given one (401
// to any other); one outside them (a stranger's bare `GET /` probing loopback ports, F2/F3) is
// answered 404 and not recorded.
// Streams when the request asks to (`stream: true`), else one JSON answer. A Responses or Chat Completions stream ends
// with `data: [DONE]`, as Chat Completions streams do: pi's OpenAI client stops on it in either, and codex's stand-in
// app-server reads to it.
//
//   const gateway = await startFauxGateway();
//   ... point a harness at gateway.url ...
//   gateway.requests[0] // { method, path, query, headers: { authorization, "x-api-key", "anthropic-version" }, body }
//   await gateway.close();
// `path` is without its query string, which `query` holds ("" for none): Claude's CLI asks `/v1/messages?beta=true`.
import { createServer } from "node:http";
import { graderAnswerOfBody } from "./faux-grader.mjs";
import { stranger } from "./stranger.mjs";

/** The routes answered, by the end of the request's path. */
export const ROUTES = Object.freeze({ responses: "/v1/responses", messages: "/v1/messages", chat: "/v1/chat/completions" });
/** The headers recorded for each request: the two that carry a key, and Anthropic's API version. */
export const RECORDED_HEADERS = Object.freeze(["authorization", "x-api-key", "anthropic-version"]);

/**
 * Starts the gateway on 127.0.0.1, on a port of its own.
 * @param {{ text?: string | ((request: GatewayRequest) => string), call?: (request: GatewayRequest) => { name: string, input: unknown } | undefined, refuse?: (request: GatewayRequest) => { status?: number, message: string } | undefined, usage?: { input?: number, output?: number, cacheRead?: number, cacheWrite?: number }, headers?: Record<string, string>, port?: number, models?: string[], key?: string }} [options]
 *   `text`: what every answer says (or a function of the request); `call`: a tool call to answer with instead, when it
 *   returns one (Messages' tool_use, Responses' function_call; not on Chat Completions); `refuse`: a refusal to answer
 *   with instead, when it returns one (its status, default 400, and `{ error: { message } }`, as OpenRouter refuses a
 *   request its model can't take; the request is still recorded); `usage`: the input and output
 *   tokens every answer reports (default 10 in, 2 out), and on Messages the prompt cache's reads and writes
 *   (`cache_read_input_tokens`, `cache_creation_input_tokens`; default 0); `headers`: headers every answer carries beside
 *   its content type (a gateway's own figure for what it cost, LiteLLM's `x-litellm-response-cost`); `port`: the port to
 *   listen on (default: one the system picks); `grader`: what a grader request (learn/promote.ts GRADER_PROMPT) is
 *   answered with, as a function of the request (default: the faux grader's verdict, fixtures/faux-grader.mjs), before
 *   `text`; `hang`: a request it records and never answers, when it returns true (its connection stays open until the
 *   client drops it or close()); `models`: the model ids GET /v1/models lists (else that GET is 404); `key`: the bearer
 *   token that list takes (else any).
 * @returns {Promise<{ url: string, requests: GatewayRequest[], close(): Promise<void> }>} `url` is the origin
 *   (`http://127.0.0.1:<port>`), with no path.
 * @typedef {{ method: string, path: string, query: string, headers: Record<string, string | undefined>, body: any }} GatewayRequest
 */
export async function startFauxGateway(options = {}) {
  const requests = [];
  const usage = { input: options.usage?.input ?? 10, output: options.usage?.output ?? 2, cacheRead: options.usage?.cacheRead ?? 0, cacheWrite: options.usage?.cacheWrite ?? 0 };
  const textOf = (request) => {
    const verdict = graderAnswerOfBody(request.body);
    if (verdict !== undefined) return options.grader ? options.grader(request) : verdict;
    return typeof options.text === "function" ? options.text(request) : options.text ?? "ok";
  };
  const extra = options.headers ?? {};
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // A POST whose body is not JSON is no model request: answered 400 and never recorded among a test's requests.
        if (req.method === "POST") return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not a model request: its body is not JSON" } }));
        body = raw;
      }
      const [path, ...rest] = (req.url ?? "/").split("?");
      // A request outside the API's own paths (none under /v1/) that is no POST is no client's: a stranger's probe of a
      // loopback port (a bare `GET /`, F2/F3). Answered 404 and never recorded among a test's requests (fixtures/stranger.mjs).
      if (stranger(req, res, { own: (at, method) => method === "POST" || at.includes("/v1/") })) return;
      const request = { method: req.method ?? "", path, query: rest.join("?"), headers: Object.fromEntries(RECORDED_HEADERS.map((name) => [name, req.headers[name]])), body };
      requests.push(request);
      const stream = body?.stream === true;
      // Every answer carries the gateway's own headers (`headers`), an error's as well as a model's.
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (status, headers) => writeHead(status, { ...headers, ...extra });
      if (req.method === "GET" && options.models && path.endsWith("/v1/models")) {
        if (options.key && request.headers.authorization !== `Bearer ${options.key}`) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "the key is not this gateway's" } }));
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: options.models.map((id) => ({ id, object: "model" })) }));
      }
      if (req.method !== "POST") return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `no ${req.method} ${path} here` } }));
      // A request the test holds open: recorded, never answered (close() ends its connection).
      if (options.hang?.(request)) return;
      const refused = options.refuse?.(request);
      if (refused) return void res.writeHead(refused.status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: refused.message } }));
      const call = options.call?.(request);
      if (call && path.endsWith(ROUTES.responses)) return responsesCall(res, body, call, usage, stream);
      if (call && path.endsWith(ROUTES.messages)) return messagesCall(res, body, call, usage, stream);
      if (path.endsWith(ROUTES.responses)) return responses(res, body, textOf(request), usage, stream);
      if (path.endsWith(ROUTES.messages)) return messages(res, body, textOf(request), usage, stream);
      if (path.endsWith(ROUTES.chat)) return chat(res, body, textOf(request), usage, stream);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `no route ${path} here` } }));
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(options.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const sse = (res, events, { named = false, done = false } = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) res.write(`${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
  res.end(done ? "data: [DONE]\n\n" : "");
};
const json = (res, value) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));

function responses(res, body, text, usage, stream) {
  const item = { type: "message", id: "msg_faux_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: "resp_faux_1", object: "response", status: "completed", model: body?.model, output: [item], usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!stream) return json(res, response);
  sse(res, [
    { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ], { done: true });
}

/** A Messages answer's usage: its input and output, and the prompt cache's writes and reads. */
const messagesCounts = (usage) => ({ input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite, cache_read_input_tokens: usage.cacheRead, output_tokens: usage.output });

function messages(res, body, text, usage, stream) {
  const counts = messagesCounts(usage);
  const message = { id: "msg_faux_1", type: "message", role: "assistant", model: body?.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: counts };
  if (!stream) return json(res, message);
  sse(res, [
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...counts, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: counts },
    { type: "message_stop" },
  ], { named: true });
}

/** A Responses answer that is one function call: `call.name` with `call.input` as its arguments. */
function responsesCall(res, body, call, usage, stream) {
  const args = JSON.stringify(call.input ?? {});
  const item = { type: "function_call", id: "fc_faux_1", call_id: "call_faux_1", name: call.name, arguments: args, status: "completed" };
  const response = { id: "resp_faux_1", object: "response", status: "completed", model: body?.model, output: [item], usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!stream) return json(res, response);
  sse(res, [
    { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: args },
    { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: args },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ], { done: true });
}

/** A Messages answer that is one tool_use block: `call.name` with `call.input`. */
function messagesCall(res, body, call, usage, stream) {
  const counts = messagesCounts(usage);
  const block = { type: "tool_use", id: "toolu_faux_1", name: call.name, input: call.input ?? {} };
  const message = { id: "msg_faux_1", type: "message", role: "assistant", model: body?.model, content: [block], stop_reason: "tool_use", stop_sequence: null, usage: counts };
  if (!stream) return json(res, message);
  sse(res, [
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...counts, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { ...block, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: counts },
    { type: "message_stop" },
  ], { named: true });
}

function chat(res, body, text, usage, stream) {
  const counts = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: 0 } };
  const base = { id: "chatcmpl_faux_1", created: 0, model: body?.model };
  if (!stream) return json(res, { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: counts });
  sse(res, [
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: counts },
  ], { done: true });
}
