// A cut point the provider cannot express is a host-side wrapper that announces `AT <name>` and blocks forever.
import fs from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { kernelProvider } from "@parcha/pi-browser/providers/kernel";
import { remoteDriver, remoteProvider } from "@parcha/pi-browser/testing";

const env = process.env;
// Each step is one model message: a call (`name` or `[name, args]`), or `{ round: [...] }`, several calls in one message.
const callOf = (step) => (Array.isArray(step) ? step : [step, {}]);
const script = JSON.parse(env.SCRIPT || "[]").map((step) => (step && step.round ? step.round.map(callOf) : [callOf(step)]));
const say = (line) => process.stdout.write(`${line}\n`);
// KILL_AT holds a process at that point for the test to kill: the first process, or a middle one between the first and the last.
const cut = async (name) => {
  if ((env.MODE !== "first" && env.MODE !== "middle") || env.KILL_AT !== name) return;
  say(`AT ${name}`);
  await new Promise(() => {});
};
// A pi-browser crossing (browser.*) is called synchronously: announced, then this thread blocks until the kill.
const crossing = (point) => {
  if (env.MODE !== "first" || env.KILL_AT !== point) return;
  fs.writeSync(1, `AT ${point}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const inner = env.KERNEL_URL
  ? kernelProvider({ env: { KERNEL_API_KEY: env.KERNEL_KEY, KERNEL_BASE_URL: env.KERNEL_URL }, confirm: { polls: 40, intervalMs: 25 } })
  : remoteProvider(env.FAKE);
const provider = {
  ...inner,
  // THROWING_DIAL: dial headers that throw, when the effect observer reads them, an error naming a connect URL with a
  // token, as a provider's SDK error can.
  attach: async (ref, signal) => { const target = await inner.attach(ref, signal); return env.THROWING_DIAL === "1" ? { ...target, dial: { url: target.dial?.url ?? target.sdkCdpUrl, get headers() { if (!new Error().stack.includes("effects.js")) return target.dial?.headers; throw new Error("connect failed: wss://connect.example.test/session?signingKey=SECRETTOKEN-0123456789"); } } } : target; },
  create: async (spec, signal) => { say(`TAG ${spec.tag}`); await cut("create-sent"); const ref = await inner.create(spec, signal); await cut("after-create"); return ref; },
  release: async (ref, signal) => { await cut("release-sent"); return inner.release(ref, signal); },
};
// HANDOFF_DIR: a port that logs each request to requests.jsonl and answers what the test wrote to `outcome`, else pending.
const handoff = env.HANDOFF_DIR ? {
  request: async (ask) => {
    fs.appendFileSync(`${env.HANDOFF_DIR}/requests.jsonl`, `${JSON.stringify({ requestId: ask.requestId, sessionTag: ask.sessionTag, sessionId: ask.sessionId ?? null })}\n`);
    await cut("handoff-requested");
    return { interactionId: `int-${ask.requestId}` };
  },
  outcome: async () => {
    await cut("handoff-polled");
    return fs.existsSync(`${env.HANDOFF_DIR}/outcome`) ? fs.readFileSync(`${env.HANDOFF_DIR}/outcome`, "utf8").trim() : "pending";
  },
} : undefined;
let providerCalls = 0;
// STUB_OBSERVER: an observer that sees one POST leave the browser as each run starts, so a cut run has sent requests.
const recorders = [];
const stub = { closed: false, holding: true, record(each) { recorders.push(each); return () => {}; }, async flush() {}, close() { stub.closed = true; } };
// GATE_CODE: a snapshot waits until a run of that code has reached the page, so the run is journaled while the snapshot runs.
let ran;
const gate = new Promise((resolve) => { ran = resolve; });
const driverFactory = remoteDriver(env.FAKE);
const driver = async (target, signal, options) => {
  const inner = await driverFactory(target, signal, options);
  if (env.STUB_OBSERVER !== "1" && !env.GATE_CODE && env.KILL_AT !== "snapshot-called") return inner;
  return {
    ...inner,
    // snapshot-called: a snapshot has made its driver call, after the call told a cut and before its answer was saved.
    snapshot: async (input) => { if (env.GATE_CODE) await gate; await cut("snapshot-called"); return inner.snapshot(input); },
    run: async (input) => {
      if (input.code === env.GATE_CODE) ran();
      if (env.STUB_OBSERVER === "1") for (const each of recorders) await each({ requestId: "req-1", method: "POST", origin: "https://example.test", path: "/submit", at: new Date().toISOString(), held: null, irreversible: null });
      return inner.run(input);
    },
  };
};
const rows = [];
const observerRows = [];

const tools = {
  snapshot: async (_args, port) => {
    const held = await port.hold("handoff-crash");
    await cut("held");
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, session: held.sessionId }) }] };
  },
  browser_read: async (_args, port) => {
    const session = await port.session();
    const page = await session.driver.page();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, session: session.sessionId, url: page.url, notice: session.notice, interrupted: session.interrupted?.callId ?? null }) }] };
  },
  run: async (args, port, call) => {
    const session = await port.session();
    await port.dispatching({ callId: call.callId, codeSha: "sha-of-the-code", url: session.record.lastUrl });
    // Credentials in the userinfo, under a query name the redactor knows, under names it does not, and in the fragment.
    const value = await session.driver.run({ actions: [{ op: "goto", url: ["https:", "//user:planted-password-0123456789@example.test/article?api_key=planted-credential-0123456789&code=planted-code-0123456789&session=planted-session-0123456789#access_token=planted-fragment-0123456789"].join("") }] });
    await port.navigated(value.url);
    await port.settle(call.callId);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, session: session.sessionId, value }) }] };
  },
};

const browser = createBrowserExtension({
  provider: async () => { providerCalls += 1; if (providerCalls === 1) await cut("provider"); return provider; },
  driver,
  // QUIET_OBSERVER: the same holding observer, which sees nothing leave the browser, so a cut run sent nothing.
  ...(env.STUB_OBSERVER === "1" || env.QUIET_OBSERVER === "1" ? { openObserver: async () => stub } : {}),
  ...(env.REAL_TOOLS === "1" ? {} : { tools }),
  evidence: { file: async () => null },
  onSession: async (row, change) => { rows.push({ change, tag: row.session.tag, state: row.session.state, label: row.label }); if (change === "updated") await cut("session-updated"); },
  onObserver: (row) => { observerRows.push(row); },
  createDeadlineMs: Number(env.CREATE_DEADLINE_MS ?? 300),
  crossing,
  ...(handoff ? { handoff } : {}),
  ...(env.WALL === "1" ? { decisions: { classifyPage: async () => ({ wall: "login_wall", injection: null, confidence: 0.9 }) } } : {}),
});

const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses(Array.from({ length: 40 }, () => (context) => {
  const round = context.messages.filter((m) => m.role === "assistant" && m.content.some((part) => part.type === "toolCall")).length;
  const calls = script[round];
  return calls ? fauxAssistantMessage(calls.map(([name, args], i) => fauxToolCall(name, args, { id: calls.length === 1 ? `call-${round}` : `call-${round}-${i}` })), { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
// run-answered: the run tool has returned its answer, and pi has not yet committed it. PARALLEL: a host that runs run and
// snapshot in parallel rounds.
const parallel = (tool) => (env.PARALLEL === "1" && (tool.name === "run" || tool.name === "snapshot") ? { ...tool, executionMode: "parallel" } : tool);
// snapshot-answered: the same for a snapshot, after it answered and before pi saved the answer.
const answered = { run: "run-answered", snapshot: "snapshot-answered" };
registry.install({ ...browser.extension, tools: browser.extension.tools.map((tool) => parallel(!answered[tool.name] ? tool : { ...tool, execute: async (...args) => { const out = await tool.execute(...args); await cut(answered[tool.name]); return out; } })) });

const harness = await Harness.open(await openNodeSqliteStorage(env.DB), { models, registry, onReport: () => {} }, ctx);
const config = { label: "node-a", run: "run-crash", policy: { ...(env.ACTIONS ? { actions: env.ACTIONS } : {}), proxies: true, verified: false, captcha: true, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: Number(env.IDLE_S ?? 0), batchTimeoutMs: 60_000, ...(env.OBSERVE ? { actions: env.OBSERVE } : {}) } };
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });

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
  return { tool: m.toolName, callId: m.toolCallId, isError: m.isError, text: m.content.filter((c) => c.type === "text").map((c) => c.text).join(" "), details: m.details ?? null };
});
result.rows = rows;
result.observer = observerRows;
fs.writeFileSync(env.OUT, JSON.stringify(result, null, 2));
await browser.close();
await harness.close(ctx);
say("DONE");
process.exit(0);
