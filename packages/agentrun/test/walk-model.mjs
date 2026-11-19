// The first-run walk's local model (install-walk.sh first-run): a stand-in for Ollama on localhost:11434, as the setup
// prompt's Local model step points AgentRun at it. No key, no network. It answers OpenAI Responses (pi's gateway API) and
// Chat Completions, streamed or not, with the same release notes and 10 input and 2 output tokens (the answers' shapes are
// the serve tests' faux gateway's, packages/serve/test/fixtures/faux-gateway.mjs, which needs a built serve), and appends
// each request's method and path to the file given as its first argument.
//   node walk-model.mjs <request log> [port]
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [log, port = "11434"] = process.argv.slice(2);
const text = "Added\n- CSV export on the runs page.\n\nChanged\n- Workspace settings is now Settings.\n\nFixed\n- The date filter no longer resets after a refresh.";
const usage = { input: 10, output: 2 };

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end("data: [DONE]\n\n");
};
const json = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

function responses(res, body) {
  const item = { type: "message", id: "msg_walk_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: "resp_walk_1", object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!body.stream) return json(res, 200, response);
  sse(res, [
    { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]);
}

function chat(res, body) {
  const counts = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: 0 } };
  const base = { id: "chatcmpl_walk_1", created: 0, model: body.model };
  if (!body.stream) return json(res, 200, { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: counts });
  sse(res, [
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: counts },
  ]);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const path = (req.url ?? "/").split("?")[0];
    appendFileSync(log, `${req.method} ${path}\n`);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      return json(res, 400, { error: { message: "the body is not JSON" } });
    }
    if (req.method === "POST" && path.endsWith("/responses")) return responses(res, body ?? {});
    if (req.method === "POST" && path.endsWith("/chat/completions")) return chat(res, body ?? {});
    json(res, 404, { error: { message: `no ${req.method} ${path} here` } });
  });
});
// localhost resolves to ::1 or 127.0.0.1 by the machine: both, where IPv6 is on; else 127.0.0.1 alone.
server.once("error", () => server.listen(Number(port), "127.0.0.1"));
server.listen({ port: Number(port), host: "::", ipv6Only: false });
server.on("listening", () => console.log(`walk model on localhost:${port}`));
