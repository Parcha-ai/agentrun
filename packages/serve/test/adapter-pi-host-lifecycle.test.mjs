// pi through the adapter loop runs a tool host's lifecycle where main's per-run process runs it (app.ts): what a binding
// registered with onConversation runs in the commit that creates each of the run's conversations; beforeResume, once the
// claim's Harness is open and before anything in it resumes; beforeRelease, when the claim lets the run go (its end, a
// park, a shutdown), while the Harness is still open. The spec hands the loop what its bindings registered (AdapterRunSpec
// .lifecycle); a fake binding here records each call, its claim's epoch, and the run's root conversation.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { HOST_API_MEMBERS } = await import("../dist/host-tools.js");
// A lease no stall outlasts (the lease sweep's STEADY_LEASE, not on this base yet): no claim is meant to be lost here.
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A runner on the adapter loop playing `script`, each claim's spec carrying a fake host's lifecycle that records into
 *  `log`: [hook, claim epoch, conversation id]. */
async function hosted(t, script) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const suite = suiteTools();
  const spec = piAdapterSpec({ script, tools: suite.tools, hooks: quiet });
  const log = [];
  const rootOf = async (harness) => (await harness.root(BACKGROUND_CONTEXT)).id;
  const loop = createAdapterLoop(async (claim, run) => ({
    ...(await spec(claim, run)),
    lifecycle: {
      onConversation: [async (_tx, conversationId) => void log.push(["conversation", claim.epoch, conversationId])],
      beforeResume: [async () => void log.push(["resume", claim.epoch])],
      beforeRelease: [async (harness) => void log.push(["release", claim.epoch, await rootOf(harness)])],
    },
  }), { restartLimit: MAX_RESTARTS });
  const runner = startRunner({ store: opened.runners[0], createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const settled = (state) => until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === state && row.runner === null && row;
  }, `the run ${state} and released`, 15_000);
  const root = async () => {
    const row = await opened.server.runs.get("run-1");
    const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
    // The root: the conversation the person's input went to.
    return { conversation: entries.find((entry) => entry.kind === "pi.user")?.conversationId, ask: entries.find((entry) => entry.kind === "agentrun.ask")?.data.callId };
  };
  return { opened, runner, suite, log, settled, root };
}

test("a parked run brought back: each claim's open runs beforeResume, the root's creating commit runs onConversation once, the park and the end run beforeRelease", async (t) => {
  const w = await hosted(t, [{ call: "asked" }, { say: "done" }]);
  const parked = await w.settled("parked");
  const { conversation, ask } = await w.root();
  assert.ok(conversation !== undefined && ask, "the run's root conversation and its ask");
  await sendCommand(w.opened.server, "run-1", { kind: "approve", body: { approval: ask } });
  const ended = await w.settled("ended");
  assert.ok(ended.epoch > parked.epoch, "brought back under a new claim");
  const first = parked.epoch - 1;
  const second = ended.epoch - 1;
  assert.deepEqual(w.log, [
    ["resume", first],
    ["conversation", first, conversation],
    ["release", first, conversation],
    ["resume", second],
    ["release", second, conversation],
  ], "resume at each claim's open, the root's conversation once, release at the park and at the end");
});

test("a shutdown while a tool runs: the claim's beforeRelease runs once, with the Harness still open", async (t) => {
  const w = await hosted(t, [{ call: "slow" }, { say: "done" }]);
  await w.suite.slowStarted;
  await w.runner.close();
  const { conversation } = await w.root();
  const row = await w.opened.server.runs.get("run-1");
  const claimed = row.epoch - 1;
  assert.deepEqual(w.log.filter(([hook]) => hook !== "conversation"), [["resume", claimed], ["release", claimed, conversation]], `released once at the shutdown: ${JSON.stringify(w.log)}`);
});

test("onConversation is for agent conversations only: the root and a subagent's (task-owned), never the loop's bookkeeping session", async () => {
  const { agentConversation } = await import("../dist/runner/adapter-loop.js");
  const { ROOT_CONVERSATION_ID } = await import("@earendil-works/pi-durable");
  assert.equal(typeof agentConversation, "function", "the loop's one rule for which conversations a host sees");
  assert.equal(agentConversation({ id: ROOT_CONVERSATION_ID, ownership: { kind: "ownerless" } }), true, "the root");
  assert.equal(agentConversation({ id: 7, ownership: { kind: "task", taskId: "task-1" } }), true, "a subagent's, owned by the task that opened it");
  assert.equal(agentConversation({ id: 5, ownership: { kind: "ownerless" } }), false, "an ownerless conversation that is not the root: the loop's session records");
});

test("a host tool's api gives its conversationId, as a browser host tool reads it", () => {
  assert.ok(HOST_API_MEMBERS.includes("conversationId"), `the host api's members: ${HOST_API_MEMBERS.join(", ")}`);
});
