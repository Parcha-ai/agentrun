// One process of an observed-effects crash scenario on a real local Chrome: the extension with the cdp provider (Chrome
// runs in its own process group, so it outlives this process) and the test driver, the `ask` action policy with a host
// that approves, a scripted faux model. `first` runs until the parent SIGKILLs it; `second` reopens the same SQLite
// file, reconciles, resumes, runs the rest of the script and ends the conversation.
//
// env: DB OUT BASE PROFILE MODE=first|second SCRIPT=<JSON [tool, args] steps> HANG_APPROVE=1 (the first process's host
// announces `AT approve` and never answers)
import fs from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBrowserExtension } from "@agentrun/pi-browser/durable";
import { cdpProvider } from "../../dist/providers/cdp.js";
import { cdpDriver } from "./cdp-driver.mjs";
import { CHROME } from "../fixtures/local-chrome.mjs";

const env = process.env;
const script = JSON.parse(env.SCRIPT);
const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: env.PROFILE, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
const browser = createBrowserExtension({
  provider: () => provider,
  driver: cdpDriver(env.BASE),
  evidence: { file: async () => null },
  decisions: { approveEffect: env.MODE === "first" && env.HANG_APPROVE === "1" ? async () => { process.stdout.write("AT approve\n"); return new Promise(() => {}); } : async () => true },
});

const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses(Array.from({ length: 20 }, () => (context) => {
  const done = context.messages.filter((m) => m.role === "toolResult").length;
  const next = script[done];
  return next ? fauxAssistantMessage([fauxToolCall(next[0], next[1] ?? {}, { id: `call-${done}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(browser.extension);
const harness = await Harness.open(await openNodeSqliteStorage(env.DB), { models, registry, onReport: () => {} }, ctx);
const config = { label: "node-a", run: "run-effects", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000, actions: "ask" } };
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
await browser.reconcile(harness, () => true, ctx);
harness.resume();
await (await root.submit({ type: "input", content: "go", requestId: `go-${env.MODE}` }, ctx)).wait(ctx);
if (env.MODE === "second") await browser.release(root, "close", ctx);
for (let i = 0; i < 300 && (await harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
const sessions = await harness.snapshot(browser.docs.Sessions, root.id, ctx);
const page = await root.entries({}, 200, undefined, ctx);
const results = [...page.items].reverse().filter((e) => e.kind === "pi.tool-result").map((e) => ({ isError: e.model[0].isError, text: e.model[0].content.filter((c) => c.type === "text").map((c) => c.text).join("\n") }));
fs.writeFileSync(env.OUT, JSON.stringify({ sessions, results }, null, 2));
await browser.close();
await harness.close(ctx);
process.exit(0);
