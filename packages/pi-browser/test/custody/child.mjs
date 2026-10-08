// One process of a custody crash scenario. `first` runs the scripted model until the parent SIGKILLs it (or to the end
// of the script); `second` reopens the same SQLite file, reconciles, resumes and runs the rest of the script; then the
// host ends the conversation and waits for every release. The provider and driver are the parent's fake backend over
// HTTP, so its ledger outlives this process. A cut point the provider cannot express is a host-side wrapper that
// announces `AT <name>` and blocks forever.
//
// With KERNEL_URL the provider is the real kernel provider against the parent's fake Kernel API, whose browsers are the
// fake backend's sessions, so the same ledger and driver hold.
//
// env: DB OUT FAKE MODE=first|second SCRIPT=<JSON steps> REAL_TOOLS=1 WALL=1 KILL_AT INACTIVE=1 RELEASE_AT_END=1 IDLE_S WAIT_MS CREATE_DEADLINE_MS
//      THROWING_DIAL=1 (the dial headers throw an error that names a connect URL and its token)
//      OBSERVE=allow|deny|ask (the conversation's action policy: the observer is asked for, and the fake's CDP port is closed)
//      KERNEL_URL KERNEL_KEY
import fs from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBrowserExtension } from "@agentrun/pi-browser/durable";
import { kernelProvider } from "@agentrun/pi-browser/providers/kernel";
import { remoteDriver, remoteProvider } from "@agentrun/pi-browser/testing";

const env = process.env;
// Each step is a tool name, or [tool, args].
const script = JSON.parse(env.SCRIPT || "[]").map((step) => (Array.isArray(step) ? step : [step, {}]));
const say = (line) => process.stdout.write(`${line}\n`);
const cut = async (name) => {
  if (env.MODE !== "first" || env.KILL_AT !== name) return;
  say(`AT ${name}`);
  await new Promise(() => {});
};

const inner = env.KERNEL_URL
  ? kernelProvider({ env: { KERNEL_API_KEY: env.KERNEL_KEY, KERNEL_BASE_URL: env.KERNEL_URL }, confirm: { polls: 40, intervalMs: 25 } })
  : remoteProvider(env.FAKE);
const provider = {
  ...inner,
  // THROWING_DIAL: a target whose dial headers throw, when the effect observer reads them, an error that names a connect URL with a token, as a provider's SDK error can.
  attach: async (ref, signal) => { const target = await inner.attach(ref, signal); return env.THROWING_DIAL === "1" ? { ...target, dial: { url: target.dial?.url ?? target.sdkCdpUrl, get headers() { if (!new Error().stack.includes("effects.js")) return target.dial?.headers; throw new Error("connect failed: wss://connect.example.test/session?signingKey=SECRETTOKEN-0123456789"); } } } : target; },
  create: async (spec, signal) => { say(`TAG ${spec.tag}`); await cut("create-sent"); const ref = await inner.create(spec, signal); await cut("after-create"); return ref; },
  release: async (ref, signal) => { await cut("release-sent"); return inner.release(ref, signal); },
};
let providerCalls = 0;
const rows = [];
const observerRows = [];

// Test implementations under the contract's names: a read and an action over the custody port, reporting what custody
// told them so the transcript shows it.
const tools = {
  browser_read: async (_args, port) => {
    const session = await port.session();
    const page = await session.driver.page();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, session: session.sessionId, url: page.url, notice: session.notice, interrupted: session.interrupted?.callId ?? null }) }] };
  },
  run: async (args, port, call) => {
    const session = await port.session();
    await port.dispatching({ callId: call.callId, codeSha: "sha-of-the-code", url: session.record.lastUrl });
    // Credentials in the userinfo, under a query name the redactor knows, under names it does not, and in the fragment.
    const value = await session.driver.run({ actions: [{ op: "goto", url: "https://user:planted-password-0123456789@example.test/article?api_key=planted-credential-0123456789&code=planted-code-0123456789&session=planted-session-0123456789#access_token=planted-fragment-0123456789" }] });
    await port.navigated(value.url);
    await port.settle();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, session: session.sessionId, value }) }] };
  },
};

const browser = createBrowserExtension({
  provider: async () => { providerCalls += 1; if (providerCalls === 1) await cut("provider"); return provider; },
  driver: remoteDriver(env.FAKE),
  ...(env.REAL_TOOLS === "1" ? {} : { tools }),
  evidence: { file: async () => null },
  onSession: (row, change) => { rows.push({ change, tag: row.session.tag, state: row.session.state, label: row.label }); },
  onObserver: (row) => { observerRows.push(row); },
  createDeadlineMs: Number(env.CREATE_DEADLINE_MS ?? 300),
  ...(env.WALL === "1" ? { decisions: { classifyPage: async () => ({ wall: "login_wall", injection: null, confidence: 0.9 }) } } : {}),
});

const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses(Array.from({ length: 40 }, () => (context) => {
  const done = context.messages.filter((m) => m.role === "toolResult").length;
  const next = script[done];
  return next ? fauxAssistantMessage([fauxToolCall(next[0], next[1], { id: `call-${done}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(browser.extension);

const harness = await Harness.open(await openNodeSqliteStorage(env.DB), { models, registry, onReport: () => {} }, ctx);
const config = { label: "node-a", run: "run-crash", policy: { proxies: true, verified: false, captcha: true, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: Number(env.IDLE_S ?? 0), batchTimeoutMs: 60_000, ...(env.OBSERVE ? { actions: env.OBSERVE } : {}) } };
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });

// A host reconciles at every open, before resume; on a fresh file there is nothing to reconcile.
const result = { mode: env.MODE, reconcile: await browser.reconcile(harness, () => env.INACTIVE !== "1", ctx) };
say("RECONCILED");
harness.resume();
const submission = await root.submit({ type: "input", content: "go", requestId: `go-${env.MODE}` }, ctx);
await submission.wait(ctx);
if (env.WAIT_MS) await new Promise((r) => setTimeout(r, Number(env.WAIT_MS)));
if (env.RELEASE_AT_END === "1") await browser.release(root, "close", ctx);
for (let i = 0; i < 200 && (await harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));

result.sessions = await harness.snapshot(browser.docs.Sessions, root.id, ctx);
result.inventory = await harness.snapshot(browser.docs.Inventory, ctx);
const page = await root.entries({}, 200, undefined, ctx);
result.results = [...page.items].reverse().filter((e) => e.kind === "pi.tool-result").map((e) => {
  const m = e.model[0];
  return { tool: m.toolName, isError: m.isError, text: m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ") };
});
result.rows = rows;
result.observer = observerRows;
fs.writeFileSync(env.OUT, JSON.stringify(result, null, 2));
await browser.close();
await harness.close(ctx);
say("DONE");
process.exit(0);
