// The first-run walk's local model (install-walk.sh first-run, npx-walk.sh): a fake Ollama on port 11434 (or the one
// given), which AgentRun lists and runs itself, as the setup prompt's Local model step says. No key, no network, no model
// download. It speaks Ollama's native API alone (packages/serve/test/fixtures/fake-ollama.mjs): GET /api/tags lists one
// model, `walk-model`, that calls tools; POST /api/show names its capabilities and context; POST /api/chat streams the
// same release notes each time. Each request's method and path is appended to the file given as its first argument.
//   node walk-model.mjs <request log> [port]
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { ollamaHandler } from "../../serve/test/fixtures/fake-ollama.mjs";

const [log, port = "11434"] = process.argv.slice(2);
const text = "Added\n- CSV export on the runs page.\n\nChanged\n- Workspace settings is now Settings.\n\nFixed\n- The date filter no longer resets after a refresh.";
const models = [{ name: "walk-model:latest", capabilities: ["completion", "tools"], family: "walkmodel", context_length: 32_768 }];
const ollama = ollamaHandler({ models, reply: () => ({ text, usage: { input: 10, output: 2 } }) });

const server = createServer((req, res) => {
  appendFileSync(log, `${req.method} ${(req.url ?? "/").split("?")[0]}\n`);
  ollama(req, res);
});
// 127.0.0.1 and ::1 both, where IPv6 is on; else 127.0.0.1 alone.
server.once("error", () => server.listen(Number(port), "127.0.0.1"));
server.listen({ port: Number(port), host: "::", ipv6Only: false });
server.on("listening", () => console.log(`walk model on 127.0.0.1:${port}`));
