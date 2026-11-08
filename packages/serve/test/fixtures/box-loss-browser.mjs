// A run's process for browser-session-barrier.test.mjs: a run on a local directory at synchronous = NORMAL whose model
// opens a browser session through pi-browser's durable extension, with serve's browser spend as its `beforeCreate`
// (browser-cost.ts' opening: the session's open recorded in the run's journal, and the journal synced).
//   box-loss-browser.mjs <root> <fake backend url> <first|resume> <epoch>
// `first`: the session is created at the fake vendor; the process says `created <tag>` and waits forever, so the test can
// lose the box once a billed session exists. `resume`: reopen the run, let pi-browser reconcile what its custody tracks
// (the run is no longer active, so a session found is released), and print what the store and the reconcile hold as one
// JSON line.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { remoteDriver, remoteProvider } from "@parcha/pi-browser/testing";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";
import * as cost from "../../dist/browser-cost.js";
import { settleIn } from "../../dist/paid-calls.js";

const [root, fake, phase, epoch] = process.argv.slice(2);
const inner = remoteProvider(fake);
const provider = {
  ...inner,
  create: async (spec, signal) => {
    const made = await inner.create(spec, signal);
    process.stdout.write(`created ${spec.tag}\n`);
    if (phase === "first") await new Promise(() => {});
    return made;
  },
};
let browser;
// The record's kind as browser-cost.ts names it; a build without the barrier has neither it nor `opening`.
const BROWSER_SESSION_OPEN = cost.BROWSER_SESSION_OPEN ?? "agentrun.browser_session_open";
const spend = cost.browserSpend("browserbase", { usdPerHour: 0.12, minimumS: 60 }, 0, (conversation, context) => browser.release(conversation, "close", context));
browser = createBrowserExtension({
  provider: () => provider,
  driver: remoteDriver(fake),
  evidence: { file: async () => null },
  beforeCreate: spend.opening,
  tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
});

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 10 }, () => (context) =>
  context.messages.some((m) => m.role === "toolResult") ? fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }) : fauxAssistantMessage([fauxToolCall("browser_read", {}, { id: "open-1" })], { stopReason: "toolUse" })));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const registry = createRegistry();
registry.install(browser.extension);

const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "r1" }, {
  ...localRun(root),
  epoch: Number(epoch),
  keepWal: true,
  synchronous: "NORMAL",
  harness: { models, registry },
  // As the server's app does: the run's journal for its barriers, before anything resumed can run.
  beforeResume: async (hook) => settleIn(undefined, hook.syncTarget),
});
const config = { label: "run", run: "r1", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };

if (phase === "first") {
  setInterval(() => {}, 1_000);
  const conversation = await run.harness.root(ctx, { agent: { model }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(run.harness, () => true, ctx);
  await conversation.submit({ type: "input", content: "open the browser" }, ctx);
} else {
  // Each step said on stderr, so a resume that does not end says where it stood.
  const step = (what) => process.stderr.write(`${new Date().toISOString()} ${what}\n`);
  step("opened");
  const reconcile = await browser.reconcile(run.harness, () => false, ctx);
  step(`reconciled ${JSON.stringify(reconcile)}`);
  for (let i = 0; i < 200 && (await run.harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  step(`tasks ${JSON.stringify((await run.harness.inspect(ctx)).tasks.map((task) => task.kind ?? task))}`);
  await browser.drain(run.harness, ctx);
  step("drained");
  const conversation = await run.harness.conversation(ROOT_CONVERSATION_ID, ctx);
  const entries = conversation ? (await conversation.entries({ order: "ascending" }, 500, undefined, ctx)).items : [];
  const opens = entries.filter((e) => e.kind === BROWSER_SESSION_OPEN).map((e) => e.data);
  const sessions = conversation ? (await run.harness.snapshot(browser.docs.Sessions, ROOT_CONVERSATION_ID, ctx))?.sessions ?? [] : [];
  process.stdout.write(`${JSON.stringify({ opens, sessions: sessions.map((s) => ({ tag: s.tag, state: s.state })), reconcile })}\n`);
  step("written");
  await browser.close();
  step("closed");
  process.exit(0);
}
