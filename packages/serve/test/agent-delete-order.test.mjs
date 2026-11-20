// The delete's order, over a fake host that records every call (agent-delete.ts deleteAgent): the refusal before
// any cancel, every run final before the learning delete, the learning
// delete before anything of step 3, each run's things before its rows, and the agent's row last. A refusal at any step
// leaves step 3 untouched. A run's (deleteRun): the runs made from it first, then its grades, then its things, its row
// last; one not final refuses before anything is deleted.
import assert from "node:assert/strict";
import { test } from "node:test";

const { deleteAgent, deleteRun } = await import("../dist/agent-delete.js");
const { LearningInFlight } = await import("../dist/learn/delete.js");
const { StoreConstraint } = await import("../dist/store/index.js");

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
    // With its agent's delete a run is never deleted alone: its agent's disk goes whole.
    forgetRun: async (agentId, runId, alone) => calls.push(`forgetRun:${runId}${alone ? ":alone" : ""}`),
    forgetAgent: async (agentId) => calls.push(`forgetAgent:${agentId}`),
    waitMs,
    pollMs: 5,
  };
  return { host, calls };
}

test("the delete runs in its order: refuse, cancel each run going and wait for it, the learning delete with none going, then triggers, sign-ins, computer, disk, each run's things before its rows, the agent last", async () => {
  const { host, calls } = fakeHost({ endAfter: 3 });
  await deleteAgent(host, "a");
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
  await assert.rejects(deleteAgent(host, "a"), /not removed upstream/);
  assert.deepEqual(calls, ["refuse:a", "cancel:r2", "learning:a:going=0", "triggers.list:a", "removeTriggerThere:t1"]);
});

test("a run this server cannot end is 409 runs_in_flight before the learning delete, after the refusal; nothing of step 3 is done", async () => {
  const { host, calls } = fakeHost({ cannot: ["r2"] });
  await assert.rejects(deleteAgent(host, "a"), (error) => error.code === "runs_in_flight" && error.status === 409 && /cannot end \(r2\)/.test(error.message));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2"]);
});

test("a run still going at the wait's end is 409 runs_in_flight; the learning delete is not called", async () => {
  const { host, calls } = fakeHost({ endAfter: Number.POSITIVE_INFINITY, waitMs: 30 });
  await assert.rejects(deleteAgent(host, "a"), (error) => error.code === "runs_in_flight" && /not ended yet \(r2\)/.test(error.message));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2"], "each run is cancelled once, however long the wait");
});

test("the learning delete's refusal (LearningInFlight) is 409 learning_busy with its words and what is in flight; nothing of step 3 is done", async () => {
  const { host, calls } = fakeHost({ busy: true });
  await assert.rejects(deleteAgent(host, "a"), (error) => error.code === "learning_busy" && error.status === 409 && /learning is at work in r9/.test(error.message) && JSON.stringify(error.extra.details) === JSON.stringify({ runs: ["r9"] }));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2", "learning:a:going=0"]);
});

test("any other failure of the learning delete is thrown as it is, never learning_busy; nothing of step 3 is done", async () => {
  const { host, calls } = fakeHost({ fails: true });
  await assert.rejects(deleteAgent(host, "a"), (error) => error.code === undefined && /could not be read/.test(error.message));
  assert.deepEqual(calls, ["refuse:a", "cancel:r2", "learning:a:going=0"]);
});

/** A run delete's host over a fake store: `runs` maps run id to [agent, state]; `made` maps a run to the runs made from
 *  it (a name not in `runs` is a run not there); `removeRefuses` makes the store refuse that run's remove as not final. */
function runHost({ runs, made = {}, removeRefuses } = {}) {
  const calls = [];
  const rows = new Map(Object.entries(runs).map(([id, [agentId, state]]) => [id, { id, agentId, state }]));
  const store = {
    runs: {
      get: async (id) => rows.get(id),
      remove: async (id) => {
        if (id === removeRefuses) throw new StoreConstraint(`run ${id} is running: only a final run is removed`);
        calls.push(`runs.remove:${id}`);
        rows.delete(id);
      },
    },
  };
  const host = {
    store,
    madeFrom: async (id) => made[id] ?? [],
    forgetRun: async (agentId, id, alone) => calls.push(`forgetRun:${agentId}:${id}${alone ? ":alone" : ""}`),
    forgetGrades: async (agentId, id) => calls.push(`forgetGrades:${agentId}:${id}`),
    at: (step, id) => calls.push(`at:${step}:${id}`),
  };
  return { host, calls, rows };
}

test("a run's delete: each run made from it first (its own made runs before it), then its grades, then its things before its rows; every one alone", async () => {
  const { host, calls } = runHost({
    runs: { r: ["a", "ended"], shadow: ["a", "ended"], replay: ["b", "stopped"], "replay-of-replay": ["b", "failed"] },
    made: { r: ["replay", "shadow", "not-there"], replay: ["replay-of-replay", "r"] },
  });
  await deleteRun(host, "r");
  assert.deepEqual(calls, [
    "forgetRun:b:replay-of-replay:alone", "at:run_forgotten:replay-of-replay", "runs.remove:replay-of-replay",
    "forgetRun:b:replay:alone", "at:run_forgotten:replay", "runs.remove:replay",
    "forgetRun:a:shadow:alone", "at:run_forgotten:shadow", "runs.remove:shadow",
    "at:run_made_from_gone:r",
    "forgetGrades:a:r",
    "forgetRun:a:r:alone", "at:run_forgotten:r", "runs.remove:r",
  ]);
});

test("a run not final, or one made from it not final, is 409 run_not_final naming each, nothing deleted; an unknown run is 404", async () => {
  for (const [runs, live] of [
    [{ r: ["a", "running"], shadow: ["a", "ended"] }, ["r"]],
    [{ r: ["a", "ended"], shadow: ["a", "queued"] }, ["shadow"]],
  ]) {
    const { host, calls } = runHost({ runs, made: { r: ["shadow"] } });
    await assert.rejects(deleteRun(host, "r"), (error) => error.code === "run_not_final" && error.status === 409 && JSON.stringify(error.extra.details) === JSON.stringify({ runs: live }));
    assert.deepEqual(calls, [], "nothing deleted");
  }
  const { host } = runHost({ runs: {} });
  await assert.rejects(deleteRun(host, "r"), (error) => error.code === "not_found" && error.status === 404);
});

test("a run opened again since it was read (the store refuses its remove) is 409 run_not_final, its row kept", async () => {
  const { host, rows } = runHost({ runs: { r: ["a", "ended"] }, removeRefuses: "r" });
  await assert.rejects(deleteRun(host, "r"), (error) => error.code === "run_not_final" && error.status === 409);
  assert.ok(rows.has("r"));
});
