// CUT_BEFORE=<step>: the driver reaches Chrome through a TCP proxy whose live sockets are destroyed just before that
// step, so the CDP socket dies under a session Chrome keeps running. CUT_CLOSES=1 closes the proxy too.
import fs from "node:fs";
import net from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { stagehandDriver } from "../../dist/driver/stagehand.js";
import { cdpProvider } from "../../dist/providers/cdp.js";

const env = process.env;
const script = JSON.parse(env.SCRIPT || "[]").map((step) => (Array.isArray(step) ? step : [step, {}]));
const filed = [];
const local = cdpProvider({ chrome: { executablePath: env.CHROME, profileRoot: env.PROFILE_ROOT, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
const live = new Set();
let proxy = null;
const cut = env.CUT_BEFORE === undefined ? null : Number(env.CUT_BEFORE);
async function proxied() {
  if (cut === null) return local;
  let target = null;
  const server = net.createServer((client) => {
    // Only the driver's own connections: anything else on this port (another program probing ports) is dropped.
    if (!target) { client.destroy(); return; }
    const upstream = net.connect(target);
    for (const socket of [client, upstream]) { live.add(socket); socket.on("close", () => live.delete(socket)); socket.on("error", () => undefined); }
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  proxy = server;
  return { ...local, async attach(ref, signal) {
    const t = await local.attach(ref, signal);
    const url = new URL(t.sdkCdpUrl);
    target = { host: url.hostname, port: Number(url.port) };
    url.port = String(server.address().port);
    return { ...t, sdkCdpUrl: url.toString() };
  } };
}
const provider = await proxied();
const browser = createBrowserExtension({
  provider: () => provider,
  driver: stagehandDriver(),
  evidence: { file: async (label, record) => { filed.push({ tool: record.tool, final_url: record.facts.final_url }); return { path: `evidence/${label}/${record.tool}.md` }; } },
});
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses(Array.from({ length: 40 }, () => (context) => {
  const done = context.messages.filter((m) => m.role === "toolResult").length;
  const next = script[done];
  if (done === cut) { process.stdout.write(`CUT ${live.size} sockets\n`); for (const socket of live) socket.destroy(); if (env.CUT_CLOSES === "1") proxy?.close(); }
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
