// One process of a real-Chrome scenario: the package's page tools over the Stagehand driver and the cdp provider (a
// local Chrome under PROFILE_ROOT that outlives this process, as a kept session does), on a SQLite file. `first` runs
// the scripted model until the parent SIGKILLs it; `second` reopens the file, reconciles, resumes and runs the rest of
// the script, then releases. Each step is a tool name or [tool, args]; the model takes the next step per tool result.
//
// OUT gets each tool result and each receipt filed (its tool and final_url).
// env: DB OUT MODE=first|second SCRIPT=<JSON steps> PROFILE_ROOT CHROME BATCH_TIMEOUT_MS (the conversation's policy)
import fs from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBrowserExtension } from "@agentrun/pi-browser/durable";
import { stagehandDriver } from "../../dist/driver/stagehand.js";
import { cdpProvider } from "../../dist/providers/cdp.js";

const env = process.env;
const script = JSON.parse(env.SCRIPT || "[]").map((step) => (Array.isArray(step) ? step : [step, {}]));
const filed = [];
const provider = cdpProvider({ chrome: { executablePath: env.CHROME, profileRoot: env.PROFILE_ROOT, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
const browser = createBrowserExtension({
  provider: () => provider,
  driver: stagehandDriver(),
  evidence: { file: async (label, record) => { filed.push({ tool: record.tool, final_url: record.facts.final_url }); return { path: `evidence/${label}/${record.tool}.md` }; } },
});
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses(Array.from({ length: 40 }, () => (context) => {
  const done = context.messages.filter((m) => m.role === "toolResult").length;
  const next = script[done];
  if (next) process.stdout.write(`STEP ${done} ${next[0]}\n`);
  return next ? fauxAssistantMessage([fauxToolCall(next[0], next[1], { id: `call-${done}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(browser.extension);

const harness = await Harness.open(await openNodeSqliteStorage(env.DB), { models, registry, onReport: () => {} }, ctx);
const config = { label: "node-a", run: "run-real-chrome", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: Number(env.BATCH_TIMEOUT_MS ?? 60_000) } };
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
const result = { mode: env.MODE, reconcile: await browser.reconcile(harness, () => true, ctx) };
harness.resume();
await (await root.submit({ type: "input", content: "go", requestId: `go-${env.MODE}` }, ctx)).wait(ctx);
await browser.release(root, "close", ctx);
for (let i = 0; i < 200 && (await harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
const page = await root.entries({}, 200, undefined, ctx);
result.results = [...page.items].reverse().filter((e) => e.kind === "pi.tool-result").map((e) => {
  const m = e.model[0];
  return { tool: m.toolName, isError: m.isError, text: m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ") };
});
result.filed = filed;
fs.writeFileSync(env.OUT, JSON.stringify(result, null, 2));
await browser.close();
await harness.close(ctx);
process.stdout.write("DONE\n");
process.exit(0);
