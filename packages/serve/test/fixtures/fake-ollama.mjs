// A fake Ollama: its native API alone, GET /api/tags, POST /api/show and POST /api/chat, in Ollama's own shapes (the
// chat streamed as NDJSON, one JSON object a line, usage in prompt_eval_count and eval_count on the last). Every other
// request (another path or method, as the GET / a dev tool on the box sends each new listener) is answered 404 and
// never counted. No imports but node's, so a walk with no built serve takes it too (packages/agentrun/test/walk-model.mjs).
// Its models are synthetic: a name, its capabilities, its family and its context length, as /api/show reports them.
import { createServer } from "node:http";

/** The models a fake lists by default: one that does not take tools (tools as text) trained on a 40,960-token context,
 *  one that takes tools and thinks trained on 131,072, one that only embeds. A model with no `context_length` has none in
 *  its /api/show. */
export const SYNTH_MODELS = Object.freeze([
  { name: "synth-plain:1b", capabilities: ["completion"], family: "synthplain", context_length: 40_960 },
  { name: "synth-tools:2b", capabilities: ["completion", "tools", "thinking"], family: "synthtools", context_length: 131_072 },
  { name: "synth-embed:1b", capabilities: ["embedding"], family: "synthembed", context_length: 8_192 },
]);

/** A cloud model's fields (Ollama's `-cloud` tags, run on ollama.com): `remote_model` and `remote_host`, in /api/tags
 *  and /api/show alike, as a model given them names them. */
const remoteOf = (model) => Object.fromEntries(["remote_model", "remote_host"].filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));

const json = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

/**
 * The request handler: `models` as the fake lists them; `hang`, a fake that takes each request to its paths and never
 * answers (an Ollama stuck loading); `reply(body, n)` the answer to the n-th chat (from 1), as
 * `{ text?, thinking?, calls?: [{ name, arguments }], usage?: { input, output } }`, or `{ status, error }` for a refusal;
 * `got`, where each counted request is kept: `tags` (a count), `show` (each model asked), `chat` (each body).
 * `hangOn(route, body)`: true for a request it takes, counts and never answers (`tags`, `show` or `chat`), the rest
 * answered (an Ollama whose listing is stuck, or one model's /api/show).
 * The handler keeps a copy of `models`: a test changes what it lists through its `remove(tag)` (`ollama rm`), never by
 * changing the array it gave.
 */
export function ollamaHandler({ models: given = SYNTH_MODELS, reply = () => ({ text: "Done." }), hang = false, hangOn = () => false, got = { tags: 0, show: [], chat: [] } } = {}) {
  const models = [...given];
  let tagsDelayMs = 0;
  const handle = (req, res) => {
    const path = new URL(req.url ?? "/", "http://ollama").pathname;
    const route = req.method === "GET" && path === "/api/tags" ? "tags" : req.method === "POST" && path === "/api/show" ? "show" : req.method === "POST" && path === "/api/chat" ? "chat" : undefined;
    if (!route) {
      req.resume();
      return void res.writeHead(404).end();
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      if (hang) {
        if (route === "tags") got.tags += 1;
        return;
      }
      if (hangOn(route, body)) {
        if (route === "tags") got.tags += 1;
        if (route === "show") got.show.push(body?.model);
        return;
      }
      if (route === "tags") {
        got.tags += 1;
        const listed = { models: models.map((m) => ({ name: m.name, model: m.name, ...remoteOf(m), modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "0", details: { family: m.family } })) };
        return void setTimeout(() => json(res, 200, listed), tagsDelayMs);
      }
      if (route === "show") {
        got.show.push(body?.model);
        const model = models.find((m) => m.name === body?.model);
        if (!model) return json(res, 404, { error: `model '${body?.model}' not found` });
        return json(res, 200, { ...remoteOf(model), details: { family: model.family }, model_info: { "general.architecture": model.family, ...(model.context_length === undefined ? {} : { [`${model.family}.context_length`]: model.context_length }) }, capabilities: model.capabilities });
      }
      got.chat.push(body);
      const answer = reply(body, got.chat.length);
      if (answer.error) return json(res, answer.status ?? 500, { error: answer.error });
      const usage = answer.usage ?? { input: 12, output: 3 };
      const base = { model: body?.model, created_at: "2026-01-01T00:00:00Z" };
      const lines = [];
      if (answer.thinking) lines.push({ ...base, message: { role: "assistant", content: "", thinking: answer.thinking }, done: false });
      // Text in two chunks, so a reader joins deltas.
      const text = answer.text ?? "";
      const cut = Math.ceil(text.length / 2);
      for (const part of [text.slice(0, cut), text.slice(cut)]) if (part) lines.push({ ...base, message: { role: "assistant", content: part }, done: false });
      if (answer.calls?.length) lines.push({ ...base, message: { role: "assistant", content: "", tool_calls: answer.calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) }, done: false });
      lines.push({ ...base, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", total_duration: 1, prompt_eval_count: usage.input, eval_count: usage.output });
      if (body?.stream === false) {
        const message = { role: "assistant", content: text, ...(answer.thinking ? { thinking: answer.thinking } : {}), ...(answer.calls?.length ? { tool_calls: answer.calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) } : {}) };
        return json(res, 200, { ...base, message, done: true, done_reason: "stop", prompt_eval_count: usage.input, eval_count: usage.output });
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    });
  };
  /** `tag` gone from this fake, as `ollama rm` leaves an Ollama: no longer in /api/tags, and /api/show answers 404. */
  handle.remove = (tag) => {
    const at = models.findIndex((model) => model.name === tag);
    if (at < 0) throw new Error(`the fake Ollama lists no ${tag}`);
    models.splice(at, 1);
  };
  /** Each /api/tags answered `ms` late from now on (what it lists read when asked): an Ollama slow to list, so a listing
   *  asked behind a caller lands after that caller has moved on. */
  handle.slowTags = (ms) => void (tagsDelayMs = ms);
  return handle;
}

/** A fake Ollama on 127.0.0.1, closed at the test's end: `url` (http://127.0.0.1:<port>), `host` (127.0.0.1:<port>, the
 *  form OLLAMA_HOST usually takes), `got`, `remove(tag)` and `slowTags(ms)` (ollamaHandler's). `port`: one to listen on (an Ollama started late, on the
 *  address closedPort gave), else any. */
export async function fakeOllama(t, { port: asked = 0, ...options } = {}) {
  const got = { tags: 0, show: [], chat: [] };
  const handle = ollamaHandler({ ...options, got });
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(asked, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, got, remove: handle.remove, slowTags: handle.slowTags };
}

/** A loopback port nothing listens on: one a server held, then closed. */
export async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
