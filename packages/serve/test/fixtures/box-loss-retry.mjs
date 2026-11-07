// A capped pi request on a real run store at synchronous NORMAL, for retry-mark-box-loss.test.mjs: pi-durable-disk's
// DurableRun on a local directory, serve's marks and cap on real pi-ai (Anthropic's API, its fetch scripted: no key, no
// network). Its first attempt is lost once it left (a reset), so the request is marked ended at its hold before pi-ai
// tries again; the retry writes <signal> and never answers, so the test can kill the process, or lose the box, while it
// is out.
//   box-loss-retry.mjs <run dir> <signal>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry } from "@earendil-works/pi-durable";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";
import { capModels, spentIn } from "../../dist/cap.js";
import { markRequests } from "../../dist/request-start.js";

const [dir, signal] = process.argv.slice(2);
/** $1 a million output tokens, a ceiling of 1,000 and free input: the request is held at $0.001. */
const MODEL = { id: "claude-x", name: "Claude X", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"], cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000 };

const pi = createModels();
pi.setProvider(anthropicProvider());
const marked = await markRequests(pi);
const capped = await capModels(marked.models, 1, spentIn(join(dir, "store", "run.sqlite")));
const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "run-1" }, { ...localRun(dir), synchronous: "NORMAL", keepWal: true, harness: { registry: createRegistry(), models: {} } });
await run.harness.root(context);
marked.open(run);
let attempt = 0;
const fetch = async () => {
  attempt += 1;
  if (attempt === 1) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) });
  writeFileSync(signal, String(process.pid));
  return new Promise(() => {});
};
process.stdout.write("open\n");
await capped.streamSimple(MODEL, { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] }, { apiKey: `not-a-secret-${"retry"}`, fetch, maxRetries: 2, maxRetryDelayMs: 1 }).result();
