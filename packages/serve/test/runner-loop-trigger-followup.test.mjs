// A trigger's message is a queued command row that answers nothing (answers: false). A run parked on an approval and
// brought back with [the trigger's row, the approve] in that order: the approve answers the call, and the trigger's text
// arrives after, as a follow-up turn at the turn's end, never as a steer into the turn and never as the call's answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { piSpec } from "./conformance-pi.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createPiLoop } = await import("../dist/runner/loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TRIGGER = "the nightly trigger says yes";

test("a parked run brought back with [a trigger's row, the approve]: the approve answers, the trigger's text follows as a turn of its own", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools, ran } = suiteTools();
  const createLoop = createPiLoop(piSpec({ script: [{ call: "asked" }, { say: "done" }, { say: "after the trigger" }], tools, hooks: quiet }));
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const read = async () => {
    const row = await opened.server.runs.get("run-1");
    return { row, ...(await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)) };
  };
  await until(async () => (await opened.server.runs.get("run-1")).state === "parked" && (await opened.server.runs.get("run-1")).runner === null, "the run parked on its ask");
  const ask = (await read()).entries.find((entry) => entry.kind === "agentrun.ask");
  // In the inbox's order: the trigger's row first, then the person's approve.
  await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: TRIGGER, answers: false, origin: { kind: "trigger", trigger: "trigger-1" } } });
  await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: ask.data.callId } });
  const { row, entries } = await until(async () => {
    const now = await read();
    return now.row.state === "ended" && now.row.runner === null && now;
  }, "the run ended", 15_000);
  assert.equal(row.state, "ended");
  assert.equal(ran.asked, 1, "the approve answered the call: it ran once");
  const answers = entries.filter((entry) => entry.kind === "agentrun.answer");
  assert.deepEqual(answers.map((entry) => [entry.data.callId, entry.data.approved]), [[ask.data.callId, true]], "one answer, the approve's");
  const texts = messagesOf({ entries, tasks: [] }).map((message) => `${message.role}:${message.text}`);
  const done = texts.indexOf("model:done");
  const trigger = texts.findIndex((text) => text.endsWith(TRIGGER));
  assert.ok(done >= 0 && trigger > done, `the trigger's text follows the turn's answer, a turn of its own: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("model:after the trigger"), `the follow-up turn was answered: ${JSON.stringify(texts)}`);
});
