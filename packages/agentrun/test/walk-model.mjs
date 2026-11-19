// The first-run walk's local model (install-walk.sh first-run): a stand-in for Ollama on localhost:11434, as the setup
// prompt's Local model step points AgentRun at it. No key, no network. It answers OpenAI Responses (pi's gateway API) and
// Chat Completions, streamed or not, with the same release notes and 10 input and 2 output tokens, in the serve tests'
// gateway's shapes (packages/serve/test/fixtures/gateway-answers.mjs), and appends each request's method and path to the
// file given as its first argument.
//   node walk-model.mjs <request log> [port]
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { chat, responses } from "../../serve/test/fixtures/gateway-answers.mjs";

const [log, port = "11434"] = process.argv.slice(2);
const text = "Added\n- CSV export on the runs page.\n\nChanged\n- Workspace settings is now Settings.\n\nFixed\n- The date filter no longer resets after a refresh.";
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const json = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

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
    if (req.method === "POST" && path.endsWith("/responses")) return responses(res, body, text, usage, body?.stream === true);
    if (req.method === "POST" && path.endsWith("/chat/completions")) return chat(res, body, text, usage, body?.stream === true);
    json(res, 404, { error: { message: `no ${req.method} ${path} here` } });
  });
});
// localhost resolves to ::1 or 127.0.0.1 by the machine: both, where IPv6 is on; else 127.0.0.1 alone.
server.once("error", () => server.listen(Number(port), "127.0.0.1"));
server.listen({ port: Number(port), host: "::", ipv6Only: false });
server.on("listening", () => console.log(`walk model on localhost:${port}`));
