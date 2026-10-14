// Crash and resume. Run it twice. The first run opens a page, sets its title, then kills itself with SIGKILL between two
// tool calls. The second run recovers the same Chrome from the run's own store and reads the title the first one set.
// A scripted model stands in for a real one, so no API key is needed. Needs @earendil-works/pi-durable, chord and pi-ai.
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";

const dir = process.env.DEMO_DIR ?? join(tmpdir(), "pi-browser-crash-demo");
const first = !existsSync(join(dir, "run.db"));
mkdirSync(dir, { recursive: true });
const browser = createBrowserExtension({ provider: () => cdpProvider({ chrome: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", profileRoot: join(dir, "chrome") } }), driver: stagehandDriver(), evidence: { file: async () => null } });
const steps = [["run", { code: 'await page.goto("about:blank"); await page.evaluate(() => { document.title = "set before the crash"; })' }], ["browser_read", { what: "title" }]];
const faux = fauxProvider({ models: [{ id: "scripted" }] });
faux.setResponses(Array.from({ length: 9 }, () => (context) => {
  const done = context.messages.filter((m) => m.role === "toolResult").length;
  if (done === 1 && first) process.kill(process.pid, "SIGKILL");
  return steps[done] ? fauxAssistantMessage([fauxToolCall(...steps[done], { id: `call-${done}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
}));
const models = createModels(); models.setProvider(faux.provider);
const registry = createRegistry(); registry.install(browser.extension);
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "run.db")), { models, registry, onReport: () => {} }, ctx);
const config = { label: "demo", run: "crash-demo", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000, actions: "allow" } };
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "scripted" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
await browser.reconcile(harness, () => true, ctx);
harness.resume();
await (await root.submit({ type: "input", content: "go", requestId: "go" }, ctx)).wait(ctx);
for (const e of (await root.entries({}, 50, undefined, ctx)).items.reverse()) if (e.kind === "pi.tool-result") console.log(e.model[0].content.map((c) => c.text).join(""));
await browser.release(root, "close", ctx); await browser.close(); await harness.close(ctx); process.exit(0);
