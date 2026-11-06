// A model gateway on loopback, for contract tests of the gateway path on every harness (pi, claude-agent, codex): no key,
// no network. It records each request as it arrived (method, path, the headers that carry a key or name an API version,
// and the JSON body) and answers the three APIs a gateway such as OpenRouter serves, each with its usage:
//   POST /v1/responses          OpenAI Responses (pi's gateway, codex)
//   POST /v1/messages           Anthropic Messages (claude-agent)
//   POST /v1/chat/completions   OpenAI Chat Completions
// A base with a path (`/api/v1/...`, as OpenRouter serves them) is answered the same: the route is the path's end. Any
// other path is recorded and answered 404, so a request sent to the wrong place shows in `requests` and fails its run.
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

/** The routes answered, by the end of the request's path. */
export const ROUTES = Object.freeze({ responses: "/v1/responses", messages: "/v1/messages", chat: "/v1/chat/completions" });
/** The headers recorded for each request: the two that carry a key, and Anthropic's API version. */
export const RECORDED_HEADERS = Object.freeze(["authorization", "x-api-key", "anthropic-version"]);

/**
 * Starts the gateway on 127.0.0.1, on a port of its own.
 * @param {{ text?: string | ((request: GatewayRequest) => string), usage?: { input?: number, output?: number }, port?: number }} [options]
 *   `text`: what every answer says (or a function of the request); `usage`: the input and output tokens every answer
 *   reports (default 10 in, 2 out); `port`: the port to listen on (default: one the system picks).
 * @returns {Promise<{ url: string, requests: GatewayRequest[], close(): Promise<void> }>} `url` is the origin
 *   (`http://127.0.0.1:<port>`), with no path.
 * @typedef {{ method: string, path: string, query: string, headers: Record<string, string | undefined>, body: any }} GatewayRequest
 */
export async function startFauxGateway(options = {}) {
  const requests = [];
  const usage = { input: options.usage?.input ?? 10, output: options.usage?.output ?? 2 };
  const textOf = (request) => (typeof options.text === "function" ? options.text(request) : options.text ?? "ok");
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const [path, ...rest] = (req.url ?? "/").split("?");
      const request = { method: req.method ?? "", path, query: rest.join("?"), headers: Object.fromEntries(RECORDED_HEADERS.map((name) => [name, req.headers[name]])), body };
      requests.push(request);
      const stream = body?.stream === true;
      if (req.method !== "POST") return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `no ${req.method} ${path} here` } }));
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

function messages(res, body, text, usage, stream) {
  const counts = { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output };
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

function chat(res, body, text, usage, stream) {
  const counts = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: 0 } };
  const base = { id: "chatcmpl_faux_1", created: 0, model: body?.model };
  if (!stream) return json(res, { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: counts });
  sse(res, [
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: counts },
  ], { done: true });
}
