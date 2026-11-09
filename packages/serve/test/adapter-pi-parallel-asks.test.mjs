// pi through the adapter loop: two asked calls in one round (pi runs a round's calls in parallel). Each answer reaches
// only its own call: the person approves one pending call at a time by its approval (the call's id), the run parks again
// on the other, and both calls run once, each answered by the approve that names it; no expectation fails unhandled when
// the first ask seals the journal while the second's is in flight. The adapter loop's twin of runner-loop-parallel-asks.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

test("pi through the adapter: two asked calls in one round: each answer reaches only its own call, and each runs once", async (t) => {
  // Every rejection no one handled while the run ran: an expectation the seal failed before it was awaited.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools, ran } = suiteTools();
  const script = [{ calls: [{ call: "asked", args: { n: 1 } }, { call: "asked", args: { n: 2 } }] }, { say: "done" }];
  const runner = startRunner({ store: opened.runners[0], createLoop: piAdapterSubject.createLoop({ script, tools, hooks: quiet }), name: "runner-a", ...TIMING });
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
  assert.deepEqual(unhandled, [], "no expectation failed unhandled when the first ask sealed the journal");
  assert.equal(row.state, "ended", "both calls answered, the run ended");
  assert.equal(ran.asked, 2, "each call ran once");
  const answers = entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => entry.data.callId);
  assert.deepEqual([...answers].sort(), [...new Set(approvals)].sort(), "each answer is the approve that names its call");
  assert.equal(new Set(answers).size, 2, "two calls, two answers");
});
