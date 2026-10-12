// scratch: the exact toolResult text and isError the pi-durable Harness produces for pi's coding tools on the Wasmer computer (Node SDK, the same edgejs.webc).
import { readFileSync } from "node:fs";
import { Wasmer } from "@wasmer/sdk/node";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { agentRegistry, rootAgent } from "../agent.ts";
import { WasmerEnv } from "../tab/wasmer-env.ts";

const wasmer = new Wasmer({ cache: { directory: "/tmp/d3-wasmer-cache" } });
await wasmer.ready();
const pkg = await wasmer.packages.load(readFileSync(new URL("../tab/dist/pkgs/edgejs.webc", import.meta.url)));
const sandbox = await wasmer.sandboxes.create({ packages: [pkg], shell: pkg.command("bash"), env: { LANG: "C.UTF-8" } });
const env = new WasmerEnv(sandbox as never, { id: "wasmer:t", env: { HOME: "/workspace", LANG: "C.UTF-8", TERM: "dumb" } });
const calls: [string, string, Record<string, unknown>][] = [
  ["1 bash echo hi", "bash", { command: "echo hi" }],
  ["2 bash true", "bash", { command: "true" }],
  ["3 bash echo out; exit 3", "bash", { command: "echo out; exit 3" }],
  ["4 bash node throw", "bash", { command: "node -e 'throw new Error(\"x\")'" }],
  ["5 read missing", "read", { path: "missing.txt" }],
  ["6 write ok", "write", { path: "w.txt", content: "hello\nworld\n" }],
  ["7 edit miss", "edit", { path: "w.txt", edits: [{ oldText: "nope", newText: "x" }] }],
  ["8 edit ok", "edit", { path: "w.txt", edits: [{ oldText: "hello", newText: "HI" }] }],
  ["9 read ok", "read", { path: "w.txt" }],
  ["10 bash stderr only", "bash", { command: "echo err >&2" }],
  ["11 bash grep missing", "bash", { command: "grep x w.txt" }],
  ["12 node process.exit(2)", "bash", { command: "node -e 'console.log(1); process.exit(2)'" }],
  ["14 bash long output", "bash", { command: "seq 1 50" }],
  ["15 bash cd persists?", "bash", { command: "mkdir -p sub && cd sub && pwd" }],
  ["16 bash pwd after", "bash", { command: "pwd" }],
];
let n = 0;
const stream = (model: any) => {
  const s = createAssistantMessageEventStream();
  const c = calls[n++];
  const content: any[] = c ? [{ type: "toolCall", id: `c${n}`, name: c[1], arguments: c[2] }] : [{ type: "text", text: "done" }];
  const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: c ? "toolUse" : "stop", timestamp: Date.now() };
  queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: message.stopReason, message }); s.end(); });
  return s;
};
const models = createModels();
models.setProvider(createProvider({ id: "pipe", name: "x", auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } }, models: [{ id: "m", name: "m", api: "openai-responses", provider: "pipe", baseUrl: "x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }], api: { stream, streamSimple: stream } as never }));
const registry = agentRegistry(async () => undefined, { switchTool: false });
const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
const root = await harness.root(ctx, { agent: { ...rootAgent("m"), model: { provider: "pipe", modelId: "m" } } });
await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
const msgs = (await root.context(ctx)).messages as any[];
const results = msgs.filter((m) => m.role === "toolResult");
results.forEach((r, i) => console.log(`### ${calls[i]?.[0]}\nisError=${r.isError}\n${JSON.stringify(r.content.map((c: any) => c.text).join(""))}`));
await env.cleanup();
await sandbox.close();
await wasmer.close();
