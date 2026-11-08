// The learning lane's end-of-run turn on the runner (runner/reflect-hook.ts): the server's rules, moved. Whether a run
// looks back (learning-run.ts reflectSkip), how its turn ended (closeLearning), and the rows kept beside its end: the
// turn and its proposal (learning_proposals), and a queued learning run only when there is something to grade.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReflectHook } from "../dist/runner/reflect-hook.js";
import { reflectPrompt } from "../dist/learn/index.js";
import { said, STOPPED } from "../dist/learning-words.js";

const claim = { runId: "run-1", runner: "runner-a", epoch: 1, until: 0, from: "running" };

/** A hook over fake deps; `answer` is what the turn's ask resolves with. */
function hookWith({ facts = {}, answer = { ended: true, answer: "```note\n...\n```" }, check } = {}) {
  const calls = { asked: [], checked: [] };
  const deps = {
    facts: async () => ({ learns: true, costUsd: 0.01, ...facts }),
    promptFacts: async () => ({ active: 3, tools: ["read", "web_search"] }),
    asked: async () => ({ asked: ["Find the bug."] }),
    check: async (input) => {
      calls.checked.push(input);
      return check ? check(input) : { state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { seed: "abc", notes: [{ file: "a.md", text: "x" }], asked: ["Find the bug."] } };
    },
    newRunId: () => "run-learn-1",
  };
  const hook = createReflectHook(deps);
  const input = (outcome = "completed") => ({
    runId: "run-1", agentId: "agent-1", claim, outcome, signal: new AbortController().signal,
    ask: async (prompt, opts) => (calls.asked.push({ prompt, opts }), answer),
  });
  return { hook, input, calls };
}

const dropped = (reason, detail) => ({ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason, detail } } });

test("a run that does not learn asks nothing and keeps nothing", async () => {
  const { hook, input, calls } = hookWith({ facts: { learns: false } });
  assert.equal(await hook(input()), undefined);
  assert.deepEqual(calls.asked, []);
});

test("a run cut before it could look back (a person's stop, or a fault) keeps its drop beside its end, and nothing is asked", async () => {
  for (const [cut, reason, detail] of [
    ["stopped", "cancelled", said.stopped(STOPPED.cancelled)],
    ["stopped-looking", "cancelled", said.stopped(STOPPED.cancelledLooking)],
    ["faulted", "crashed", said.stopped(STOPPED.crashed)],
  ]) {
    const { hook, input, calls } = hookWith();
    assert.deepEqual(await hook({ ...input("failed"), cut }), { also: [dropped(reason, detail)] }, cut);
    assert.deepEqual(calls.asked, [], `${cut}: nothing asked`);
  }
  const { hook, input } = hookWith({ facts: { learns: false } });
  assert.equal(await hook({ ...input("failed"), cut: "stopped" }), undefined, "a run that does not learn keeps nothing, cut or not");
});

test("a cancelled run, one its cap stopped, and one whose spend is unknown under a cap: dropped in the server's words, nothing asked", async () => {
  for (const [facts, reason, detail] of [
    [{ cancelled: true }, "cancelled", said.stopped(STOPPED.cancelled)],
    [{ capReached: true }, "no_budget", said.noBudget],
    [{ capUsd: 1, costUsd: null }, "unknown_cost", said.unknownCost],
  ]) {
    const { hook, input, calls } = hookWith({ facts });
    assert.deepEqual(await hook(input()), { also: [dropped(reason, detail)] }, reason);
    assert.deepEqual(calls.asked, [], `${reason}: nothing asked`);
  }
});

test("the turn is asked with the server's prompt, its origin reflect, within its deadline", async () => {
  const { hook, input, calls } = hookWith();
  await hook(input());
  assert.equal(calls.asked.length, 1);
  assert.equal(calls.asked[0].prompt, reflectPrompt({ dir: ".learning", active: 3, tools: ["read", "web_search"] }));
  assert.deepEqual(calls.asked[0].opts, { origin: "reflect", deadlineMs: 5 * 60_000 });
});

test("a proposal keeps the turn and queues one learning run beside the end", async () => {
  const { hook, input, calls } = hookWith();
  const rows = await hook(input("failed"));
  assert.equal(calls.checked.length, 1, "the answer is checked once");
  assert.deepEqual(calls.checked[0].turn, { answer: "```note\n...\n```", asked: ["Find the bug."] });
  assert.equal(calls.checked[0].outcome, "failed", "the checks read how the job ended");
  assert.deepEqual(rows, {
    also: [
      { table: "learning_proposals", row: { turn: { answer: "```note\n...\n```", asked: ["Find the bug."] }, proposal: { state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { seed: "abc", notes: [{ file: "a.md", text: "x" }], asked: ["Find the bug."] }, detail: said.proposed(1, 0, 0) } } },
      { table: "learning_run", row: { id: "run-learn-1" } },
    ],
  });
});

test("an answer with nothing to keep, or out of format, or refused by the checks, queues no learning run", async () => {
  for (const [result, detail] of [
    [{ state: "dropped", reason: "empty" }, said.empty],
    [{ state: "dropped", reason: "unparsed", detail: "no note blocks" }, said.unparsed],
    [{ state: "dropped", reason: "checker", problems: [{ rule: "too_many_notes" }] }, said.checker([{ rule: "too_many_notes" }])],
  ]) {
    const { hook, input } = hookWith({ check: () => result });
    const rows = await hook(input());
    assert.ok(rows !== undefined, `${result.reason}: the learning's end is kept`);
    assert.equal(rows.also.length, 1, `${result.reason}: one row`);
    assert.equal(rows.also[0].table, "learning_proposals");
    assert.deepEqual(rows.also[0].row.proposal, { ...result, state: "dropped", detail }, result.reason);
    assert.ok(!rows.also.some((row) => row.table === "learning_run"), `${result.reason}: no learning run`);
  }
});

test("a turn past its deadline, one the cap refused, and one that failed: dropped in the server's words", async () => {
  for (const [answer, reason, detail] of [
    [{ timedOut: true }, "reflect_timeout", said.stopped(STOPPED.timedOut)],
    [{ failed: { code: "run-failed", message: "spend_cap_reached ($1.00): the cap is reached" } }, "no_budget", said.noBudget],
    [{ failed: { code: "run-failed", message: "the model refused" } }, "reflect_failed", said.stopped(STOPPED.failed)],
  ]) {
    const { hook, input, calls } = hookWith({ answer });
    assert.deepEqual(await hook(input()), { also: [dropped(reason, detail)] }, reason);
    assert.deepEqual(calls.checked, [], `${reason}: nothing checked`);
  }
});

test("checks that fail on their own drop the learning, saying so, and queue no run", async () => {
  const { hook, input } = hookWith({ check: () => { throw new Error("no seed"); } });
  assert.deepEqual(await hook(input()), { also: [{ table: "learning_proposals", row: { turn: { answer: "```note\n...\n```", asked: ["Find the bug."] }, proposal: { state: "dropped", reason: "propose_failed", detail: said.stopped(STOPPED.notChecked) } } }] });
});
