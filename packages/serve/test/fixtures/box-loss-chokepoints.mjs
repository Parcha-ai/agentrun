// A run's process for barriers-box-loss.test.mjs: a run on a local directory at synchronous = NORMAL, with a paying
// effect behind one of the server's real chokepoints.
//   box-loss-chokepoints.mjs <root> <effects file> <pi|kernel> <first|resume> <epoch>
// `pi`: a pi tool call behind the run's tool gate (RunGate.wrap); the faux model calls it once. `kernel`: a kernel
// effect (openDrive, `replay: "never"`) on the run's own session writer (durableSessions). `first`: the effect appends
// to the effects file, says "paid", and waits forever, so the test can lose the box while it is in flight. `resume`:
// reopen the run, let it recover, and print what became of the effect as one JSON line.
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRegistry, defineExtension, defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { EffectFailure, openDrive } from "@parcha/agentrun-kernel/kernel";
import { serialWriter } from "@parcha/agentrun-kernel/host";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";
import { durableSessions } from "../../dist/sessions.js";
import { RunGate } from "../../dist/tool-gate.js";

const [root, effects, which, phase, epoch] = process.argv.slice(2);
const pay = async () => {
  const fd = openSync(effects, "a");
  appendFileSync(fd, `${phase}\n`);
  fsyncSync(fd);
  closeSync(fd);
  process.stdout.write("paid\n");
  if (phase === "first") await new Promise(() => {});
  return { content: [{ type: "text", text: "paid" }] };
};

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 20 }, () => (context) =>
  context.messages.some((m) => m.role === "toolResult") ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("write", {}, { id: "pay-1" }), { stopReason: "toolUse" })));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const tool = defineTool({ name: "write", description: "Pay once.", parameters: Type.Object({}), replay: "unsafe", execute: pay });
const gateDir = join(root, "..", "gate");
for (const sub of ["root", "work", "data"]) mkdirSync(join(gateDir, sub), { recursive: true });
const gate = new RunGate({ root: join(gateDir, "root"), work: join(gateDir, "work"), data: join(gateDir, "data"), runId: "r1", harness: "pi" }, { write: { permission: "allow" } }, true, true);
const registry = createRegistry();
registry.install(defineExtension({ name: "tools", tools: [tool] }));
registry.install(gate.extension([tool]));

const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "r1" }, {
  ...localRun(root),
  epoch: Number(epoch),
  keepWal: true,
  synchronous: "NORMAL",
  harness: { models, registry },
  // As the server's app does: the gate takes the run's store before anything resumed can run a call.
  beforeResume: async (hook) => gate.prime(hook.harness, hook.context, hook.syncTarget),
});
const signal = new AbortController().signal;
const drive = async () => openDrive({ writer: serialWriter(await durableSessions(run.harness, ctx, run.store).open("k1")), signal });

if (phase === "first") {
  setInterval(() => {}, 1_000);
  if (which === "pi") {
    const conversation = await run.harness.root(ctx, { agent: { model } });
    await conversation.submit({ type: "input", content: "pay once" }, ctx);
  } else {
    await (await drive()).effect("tool:c1", { name: "pay", replay: "never", input: {} }, pay);
  }
} else {
  let outcome;
  if (which === "pi") {
    await run.harness.waitForIdle(ctx);
    const conversation = await run.harness.conversation(ROOT_CONVERSATION_ID, ctx);
    const entries = conversation ? (await conversation.entries({ order: "ascending" }, 500, undefined, ctx)).items : [];
    const result = JSON.stringify(entries.filter((e) => JSON.stringify(e).includes("pay-1") && JSON.stringify(e).includes("toolResult")));
    outcome = { conversation: Boolean(conversation), interrupted: /interrupted/.test(result) };
  } else {
    try {
      await (await drive()).effect("tool:c1", { name: "pay", replay: "never", input: {} }, pay);
      outcome = { ran: true };
    } catch (error) {
      outcome = { failed: error instanceof EffectFailure, interrupted: error?.error?.interrupted === true };
    }
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exit(0);
}
