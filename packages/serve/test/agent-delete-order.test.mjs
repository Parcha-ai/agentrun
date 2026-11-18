// The delete's order, over a fake host that records every call (agent-delete.ts deleteExternalAgent): the refusal before
// any cancel, every run final before the learning delete, the learning
// delete before anything of step 3, each run's things before its rows, and the agent's row last. A refusal at any step
// leaves step 3 untouched.
import assert from "node:assert/strict";
import { test } from "node:test";

const { deleteExternalAgent } = await import("../dist/agent-delete.js");
const { LearningInFlight } = await import("../dist/learn/delete.js");

/** A host over a fake store: `runs` maps run id to its state; a cancelled run reads `stopped` from the next read on
 *  (after `endAfter` reads). `cannot` names runs whose cancel answers false; `busy` makes the learning delete refuse
 *  (LearningInFlight), `fails` makes it throw another error. */
function fakeHost({ runs = { r1: "ended", r2: "working" }, cannot = [], busy = false, fails = false, endAfter = 1, waitMs = 2_000, upstreamFails = false } = {}) {
  const calls = [];
  const states = new Map(Object.entries(runs));
  const cancelled = new Map();
  const store = {
    triggers: { list: async (agentId) => { calls.push(`triggers.list:${agentId}`); return [{ id: "t1" }]; } },
    runs: {
      every: async () => {
        for (const [id, reads] of cancelled) {
          if (reads + 1 >= endAfter) states.set(id, "stopped");
          cancelled.set(id, reads + 1);
        }
        return [...states].map(([id, state]) => ({ id, state }));
      },
      remove: async (runId) => { calls.push(`runs.remove:${runId}`); states.delete(runId); },
    },
    agents: { remove: async (agentId) => calls.push(`agents.remove:${agentId}`) },
  };
  const host = {
    store,
    deleteLearning: async (given, agentId) => {
      assert.equal(given, store);
      const going = [...states.values()].filter((state) => !["ended", "stopped", "failed"].includes(state));
      calls.push(`learning:${agentId}:going=${going.length}`);
      if (busy) throw new LearningInFlight(agentId, ["r9"]);
      if (fails) throw new Error("the learning folder could not be read");
    },
    refuse: async (agentId) => calls.push(`refuse:${agentId}`),
    cancel: async (runId) => {
      calls.push(`cancel:${runId}`);
      if (cannot.includes(runId)) return false;
      if (!cancelled.has(runId)) cancelled.set(runId, 0);
      return true;
    },
    removeTriggerThere: async (id) => {
      calls.push(`removeTriggerThere:${id}`);
      if (upstreamFails) throw new Error("not removed upstream");
    },
    removeTriggerSettings: async (id) => calls.push(`removeTriggerSettings:${id}`),
    removeTrigger: async (id) => calls.push(`removeTrigger:${id}`),
    forgetSignIns: async (agentId) => calls.push(`forgetSignIns:${agentId}`),
    removeOwnComputer: async (agentId) => calls.push(`removeOwnComputer:${agentId}`),
    removeDisk: async (agentId) => calls.push(`removeDisk:${agentId}`),
    forgetRun: async (agentId, runId) => calls.push(`forgetRun:${runId}`),
    forgetAgent: async (agentId) => calls.push(`forgetAgent:${agentId}`),
    waitMs,
    pollMs: 5,
  };
  return { host, calls };
}

test("the delete runs in its order: refuse, cancel each run going and wait for it, the learning delete with none going, then triggers, sign-ins, computer, disk, each run's things before its rows, the agent last", async () => {
  const { host, calls } = fakeHost({ endAfter: 3 });
  await deleteExternalAgent(host, "a");
  assert.deepEqual(calls, [
    "refuse:a",
    "cancel:r2",
    "learning:a:going=0",
    "triggers.list:a",
    "removeTriggerThere:t1",
    "removeTriggerSettings:t1",
    "removeTrigger:t1",
    "forgetSignIns:a",
    "removeOwnComputer:a",
    "removeDisk:a",
    "forgetRun:r1",
    "runs.remove:r1",
    "forgetRun:r2",
    "runs.remove:r2",
    "forgetAgent:a",
    "agents.remove:a",
  ]);
});

test("a trigger's registration upstream is removed before its row; one that fails there keeps the row and stops the delete before anything else of step 3", async () => {
  const { host, calls } = fakeHost({ upstreamFails: true });
  await assert.rejects(deleteExternalAgent(host, "a"), /not removed upstream/);
  assert.deepEqual(calls, ["refuse:a", "cancel:r2", "learning:a:going=0", "triggers.list:a", "removeTriggerThere:t1"]);
});

test("a run this server cannot end is 409 runs_in_flight before the learning delete, after the refusal; nothing of step 3 is done", async () => {
  const { host, calls } = fakeHost({ cannot: ["r2"] });
  await assert.rejects(deleteExternalAgent(host, "a"), (error) => error.code === "runs_in_flight" && error.status === 409 && /cannot end \(r2\)/.test(error.message));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2"]);
});

test("a run still going at the wait's end is 409 runs_in_flight; the learning delete is not called", async () => {
  const { host, calls } = fakeHost({ endAfter: Number.POSITIVE_INFINITY, waitMs: 30 });
  await assert.rejects(deleteExternalAgent(host, "a"), (error) => error.code === "runs_in_flight" && /not ended yet \(r2\)/.test(error.message));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2"], "each run is cancelled once, however long the wait");
});

test("the learning delete's refusal (LearningInFlight) is 409 learning_busy with its words and what is in flight; nothing of step 3 is done", async () => {
  const { host, calls } = fakeHost({ busy: true });
  await assert.rejects(deleteExternalAgent(host, "a"), (error) => error.code === "learning_busy" && error.status === 409 && /learning is at work in r9/.test(error.message) && JSON.stringify(error.extra.details) === JSON.stringify({ runs: ["r9"] }));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2", "learning:a:going=0"]);
});

test("any other failure of the learning delete is thrown as it is, never learning_busy; nothing of step 3 is done", async () => {
  const { host, calls } = fakeHost({ fails: true });
  await assert.rejects(deleteExternalAgent(host, "a"), (error) => error.code === undefined && /could not be read/.test(error.message));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2", "learning:a:going=0"]);
});
