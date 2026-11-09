// Two asked calls in one round (pi runs a round's calls in parallel): each answer reaches only its own call. The person
// approves one pending call at a time by its approval (the call's id); the run parks again on the other, and every call
// runs once, answered by the approve that names it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createPiLoop } = await import("../dist/runner/loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

test("two asked calls in one round: each answer reaches only its own call, and each runs once", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  // The model's first answer calls `asked` twice in one round; then it answers.
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 16 }, () => (context) =>
    context.messages.some((message) => message.role === "assistant")
      ? fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })
      : fauxAssistantMessage([fauxToolCall("asked", { n: 1 }), fauxToolCall("asked", { n: 2 })], { stopReason: "toolUse" })));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const ran = [];
  const asked = { name: "asked", description: "Asked.", parameters: { type: "object", properties: { n: { type: "number" } } }, replaySafe: false, run: async (args) => (ran.push(args.n), `ran ${args.n}`) };
  const createLoop = createPiLoop(() => ({ models, model: { provider: model.provider, modelId: model.id }, input: "Do both.", tools: [asked], gate: () => "ask", hooks: quiet }));
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const read = async () => {
    const row = await opened.server.runs.get("run-1");
    return { row, ...(await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)) };
  };
  const approvals = [];
  for (let round = 0; round < 6; round++) {
    const now = await until(async () => {
      const state = await read();
      return state.row.runner === null && ["parked", "ended"].includes(state.row.state) && state;
    }, "the run parked or ended", 15_000);
    if (now.row.state === "ended") break;
    const answered = new Set(now.entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => entry.data.callId));
    const pending = now.entries.filter((entry) => entry.kind === "agentrun.ask" && !answered.has(entry.data.callId)).map((entry) => entry.data.callId);
    assert.ok(pending.length > 0, `a parked run waits on an asked call: ${JSON.stringify(now.entries.map((entry) => entry.kind))}`);
    const callId = pending[0];
    approvals.push(callId);
    await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: callId } });
    await until(async () => (await read()).row.epoch > now.row.epoch, "the approve woke the run", 10_000);
  }
  const { row, entries } = await read();
  assert.equal(row.state, "ended", "both calls answered, the run ended");
  assert.deepEqual([...ran].sort(), [1, 2], `each call ran once: ${JSON.stringify(ran)}`);
  const answers = entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => entry.data.callId);
  assert.deepEqual([...answers].sort(), [...new Set(approvals)].sort(), "each answer is the approve that names its call");
  assert.equal(new Set(answers).size, 2, "two calls, two answers");
});
