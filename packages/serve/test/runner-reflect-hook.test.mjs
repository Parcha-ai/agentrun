// The learning lane's end-of-run step on the runner (runner/reflect-hook.ts): no look-back turn and no grade. A run's
// owner's words are appended to corrections.md as one line; a due compile turn's draft is checked and committed directly;
// how it ended is kept beside the run's end (learning_proposals).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReflectHook } from "../dist/runner/reflect-hook.js";
import { COMPILE_TIMEOUT_MS, compilePrompt } from "../dist/learn/compile.js";
import { said, STOPPED } from "../dist/learning-words.js";

const claim = { runId: "run-1", runner: "runner-a", epoch: 1, until: 0, from: "running" };
/** The hooks' clock; a run's spend reads 0.01 throughout unless a test says otherwise. */
const AT = Date.UTC(2026, 10, 9, 5, 0, 0);
const ANSWERED = { answered_at: new Date(AT).toISOString(), job_cost_usd: 0.01, look_back_usd: 0 };

const FLOW = JSON.stringify({ v: 2, name: "answer", schemas: {}, root: { node: "chain", steps: [] } });
const BLOCK = `\`\`\`\`workflow answer\n---\ndescription: d\n---\n${FLOW}\n\`\`\`\``;
const NEW = { mode: "new", reference: "REF", traces: [], tools: [], judges: false };
const HELD = { workflow: "answer", digest: "0123456789abcdef", reason: "r" };
const REVISE = { mode: "revise", workflow: "answer", current: FLOW, held: HELD, base: "base-1", reference: "REF", traces: [], tools: [], judges: false };
/** What a passing draft commits: its two files. */
const DRAFT = { name: "answer", files: [{ path: "workflows/answer/workflow.json", text: FLOW }, { path: "workflows/answer/README.md", text: "---\nname: answer\ndescription: d\n---\n" }] };

/** A hook over fake deps. `answers`: what each compile ask resolves with, in turn (a further ask fails the test). */
function hookWith({ facts = {}, answers = [{ ended: true, answer: BLOCK }], words = [], refused = [], compile, checks, commit, nothingNew, refuse, round } = {}) {
  const calls = { asked: [], checked: [], committed: [], failed: [], refusedAsked: [] };
  const checkQueue = [...(checks ?? [])];
  const deps = {
    facts: async () => ({ learns: true, costUsd: 0.01, ...facts }),
    feedback: async () => words,
    correctionRefused: async (input) => (calls.refusedAsked.push(input), refused),
    ...(compile !== undefined ? { compileFacts: async (input) => (typeof compile === "function" ? compile(input) : compile) } : {}),
    compileFailed: async (input) => void calls.failed.push(input),
    checkDraft: async (input) => {
      calls.checked.push(input);
      return checkQueue.length ? checkQueue.shift() : { errors: [], kept: DRAFT, digest: "d1" };
    },
    commit: async (input) => (calls.committed.push(input), commit ? commit(input) : { ok: true, commit: "c1" }),
    ...(nothingNew ? { nothingNew } : {}),
    ...(refuse ? { refuse } : {}),
    ...(round ? { round } : {}),
    now: () => AT,
  };
  const hook = createReflectHook(deps);
  const input = (outcome = "completed") => ({
    runId: "run-1", agentId: "agent-1", claim, outcome, signal: new AbortController().signal,
    ask: async (prompt, opts) => {
      calls.asked.push({ prompt, opts });
      if (calls.asked.length > answers.length) throw new Error(`the compile turn was asked ${calls.asked.length} times`);
      return answers[calls.asked.length - 1];
    },
  });
  return { hook, input, calls };
}

const kept = (rows) => rows.also.find((row) => row.table === "learning_proposals").row.proposal;
const dropped = (reason, detail, extra = {}) => ({ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason, detail, ...extra } } });

test("a run that does not learn asks nothing and keeps nothing", async () => {
  const { hook, input, calls } = hookWith({ facts: { learns: false }, compile: NEW, words: ["Keep it short."] });
  assert.equal(await hook(input()), undefined);
  assert.deepEqual([calls.asked, calls.committed], [[], []]);
});

test("a run cut before its end-of-run step (a person's stop, or a fault) keeps its drop beside its end, and nothing is asked or written", async () => {
  for (const [cut, reason, detail] of [
    ["stopped", "cancelled", said.stopped(STOPPED.cancelled)],
    ["stopped-looking", "cancelled", said.stopped(STOPPED.cancelledLooking)],
    ["faulted", "crashed", said.stopped(STOPPED.crashed)],
  ]) {
    const { hook, input, calls } = hookWith({ compile: NEW, words: ["Keep it short."] });
    assert.deepEqual(await hook({ ...input("failed"), cut }), { also: [dropped(reason, detail)] }, cut);
    assert.deepEqual([calls.asked, calls.committed], [[], []], `${cut}: nothing asked or written`);
  }
  const { hook, input } = hookWith({ facts: { learns: false } });
  assert.equal(await hook({ ...input("failed"), cut: "stopped" }), undefined, "a run that does not learn keeps nothing, cut or not");
});

test("a cancelled run is dropped in the server's words; a run its cap stopped, or whose spend is unknown under a cap, asks no compile turn", async () => {
  const cancelled = hookWith({ facts: { cancelled: true }, compile: NEW });
  assert.deepEqual(await cancelled.hook(cancelled.input()), { also: [dropped("cancelled", said.stopped(STOPPED.cancelled))] });
  for (const [facts, reason, detail] of [
    [{ capReached: true }, "no_budget", said.noBudget],
    [{ capUsd: 1, costUsd: null, spentUsd: null }, "unknown_cost", said.unknownCost],
  ]) {
    const { hook, input, calls } = hookWith({ facts, compile: NEW });
    const rows = await hook(input());
    assert.deepEqual([kept(rows).state, kept(rows).reason, kept(rows).detail], ["dropped", reason, detail], reason);
    assert.deepEqual(calls.asked, [], `${reason}: no compile turn asked`);
  }
});

test("a capped run whose shown cost is unknown but whose spend under its cap is known is asked its compile turn, never skipped as out of budget", async () => {
  const { hook, input, calls } = hookWith({ facts: { capUsd: 5, costUsd: null, spentUsd: 2.1 }, compile: NEW });
  const rows = await hook(input());
  assert.equal(calls.asked.length, 1, "the compile turn is asked: the cap's own read leaves room");
  assert.equal(kept(rows).state, "merged", JSON.stringify(kept(rows)));
});

test("a run whose never-learn list can't be read learns nothing, saying why, and asks nothing", async () => {
  const { hook, input, calls } = hookWith({ compile: NEW, words: ["Keep it short."], refuse: async () => "unreadable" });
  assert.deepEqual(await hook(input()), { also: [dropped("reflect_failed", said.stopped(STOPPED.refuseUnread))] });
  assert.deepEqual([calls.asked, calls.committed], [[], []]);
});

test("a run with nothing said and no compile due keeps nothing, at no cost; one only its learned workflows answered says so", async () => {
  const plain = hookWith();
  assert.deepEqual(await plain.hook(plain.input()), { also: [dropped("empty", said.empty, ANSWERED)] });
  assert.deepEqual([plain.calls.asked, plain.calls.committed], [[], []]);
  for (const costUsd of [0.01, null]) {
    const { hook, input, calls } = hookWith({ facts: { costUsd }, nothingNew: async () => true, compile: undefined });
    assert.deepEqual(await hook(input()), { also: [dropped("empty", said.onlyWorkflow, { answered_at: ANSWERED.answered_at, job_cost_usd: costUsd, look_back_usd: 0 })] }, `job cost ${costUsd}`);
    assert.deepEqual(calls.asked, [], "nothing asked");
  }
});

test("the owner's words are one line of corrections.md: checked against main first, then committed by the run with no model turn", async () => {
  const { hook, input, calls } = hookWith({ words: ["Keep the summary", " to three lines. "] });
  const rows = await hook(input());
  assert.deepEqual(calls.asked, [], "no model turn for a correction");
  assert.deepEqual(calls.refusedAsked.map(({ agentId, text }) => [agentId, text]), [["agent-1", "Keep the summary to three lines."]]);
  assert.deepEqual(calls.committed.map(({ runId, agentId, round, draft, correction }) => ({ runId, agentId, round, draft, correction })), [{ runId: "run-1", agentId: "agent-1", round: 1, draft: undefined, correction: "Keep the summary to three lines." }]);
  assert.deepEqual(kept(rows), { state: "merged", reason: null, merged: "c1", corrections: 1, detail: said.merged([], 1), ...ANSWERED });
});

test("a correction the checks refuse is dropped in their words, never written; one past the cap says the cap's own sentence", async () => {
  const secret = [{ rule: "secret_value", path: "corrections.md", detail: "it holds a value the host keeps secret" }];
  const refusedOne = hookWith({ words: ["Use the key."], refused: secret });
  const rows = await refusedOne.hook(refusedOne.input());
  assert.deepEqual(refusedOne.calls.committed, [], "nothing written");
  assert.deepEqual([kept(rows).state, kept(rows).reason, kept(rows).detail, kept(rows).problems], ["dropped", "checker", said.checker(secret), secret]);
  const full = [{ rule: "too_large", path: "corrections.md", detail: "corrections.md would be past its 2 KB cap." }];
  const capped = hookWith({ words: ["One more."], refused: full });
  assert.equal(kept(await capped.hook(capped.input())).detail, said.correctionsFull(full[0].detail));
  // The check itself failing: refused as unchecked, never written.
  const failing = createReflectHook({ facts: async () => ({ learns: true, costUsd: 0.01 }), feedback: async () => ["One more."], correctionRefused: async () => { throw new Error("gone"); }, checkDraft: async () => ({ errors: [] }), commit: async () => { throw new Error("never"); }, now: () => AT });
  const failed = kept(await failing({ runId: "run-1", agentId: "agent-1", claim, outcome: "completed", signal: new AbortController().signal, ask: async () => { throw new Error("never"); } }));
  assert.deepEqual([failed.state, failed.reason], ["dropped", "checker"]);
});

test("a due compile turn is asked with the server's prompt, origin reflect, its step and deadline, keeping the job's figures with its first ask", async () => {
  const { hook, input, calls } = hookWith({ compile: NEW });
  await hook(input());
  assert.equal(calls.asked.length, 1);
  assert.equal(calls.asked[0].prompt, compilePrompt(NEW));
  assert.deepEqual(calls.asked[0].opts, { origin: "reflect", deadlineMs: COMPILE_TIMEOUT_MS, step: "compile-1", keep: { answered_at: ANSWERED.answered_at, job_cost_usd: 0.01 } });
});

test("a draft that passes its checks is committed directly with the run's correction, in one merge; the record is kept with the learning", async () => {
  const { hook, input, calls } = hookWith({ compile: NEW, words: ["Keep it short."], facts: {} });
  const rows = await hook(input());
  assert.equal(calls.checked.length, 1);
  assert.deepEqual([calls.checked[0].draft.name, calls.checked[0].revised], ["answer", undefined]);
  assert.equal(calls.committed.length, 1, "one merge a round");
  assert.deepEqual([calls.committed[0].draft, calls.committed[0].correction], [DRAFT, "Keep it short."]);
  const end = kept(rows);
  assert.deepEqual([end.state, end.merged, end.corrections], ["merged", "c1", 1]);
  assert.deepEqual(end.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  assert.deepEqual(end.compiled, { workflow: "answer", attempts: [{ ok: true, errors: [] }], digest: "d1" });
  assert.equal(end.detail, said.merged([{ name: "answer" }], 1));
});

test("a correction the merge refuses beside a passing draft (corrections.md filled during the compile) is reported as the check before the compile reports one; the draft merges", async () => {
  const full = [{ rule: "too_large", path: "corrections.md", detail: "corrections.md would hold 2090 bytes; the cap is 2048 bytes" }];
  const { hook, input, calls } = hookWith({ compile: NEW, words: ["Keep it short."], commit: () => ({ ok: true, commit: "c1", refusedCorrection: full }) });
  const end = kept(await hook(input()));
  assert.equal(calls.committed[0].correction, "Keep it short.", "the correction went to the merge");
  assert.deepEqual([end.state, end.merged, end.corrections, end.problems], ["merged", "c1", undefined, full]);
  assert.deepEqual(end.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  assert.equal(end.detail, said.merged([{ name: "answer" }], 0, full));
  // As the check before the compile reports a correction it refuses.
  const before = hookWith({ compile: NEW, words: ["Keep it short."], refused: full });
  const earlier = kept(await before.hook(before.input()));
  assert.deepEqual([earlier.state, earlier.corrections, earlier.problems, earlier.detail], [end.state, end.corrections, end.problems, end.detail]);
});

test("a draft held for its owner's OK (its README held) is merged as pending", async () => {
  const held = { ...DRAFT, held: ["workflows/answer/README.md"] };
  const { hook, input } = hookWith({ compile: NEW, checks: [{ errors: [], kept: held, digest: "d1" }] });
  const end = kept(await hook(input()));
  assert.deepEqual(end.workflows, [{ file: "workflows/answer/workflow.json", name: "answer", pending: true }]);
  assert.equal(end.detail, said.merged([{ name: "answer", pending: true }], 0));
});

test("a draft the checks refuse goes back with their words; one that never passes is recorded on compile once, never silent, and the correction beside it still lands", async () => {
  const errors = ["workflows/answer/workflow.json: its dry run failed"];
  const answers = Array.from({ length: 4 }, () => ({ ended: true, answer: BLOCK }));
  const refusedAll = hookWith({ compile: NEW, answers, checks: Array.from({ length: 4 }, () => ({ errors })) });
  const rows = await refusedAll.hook(refusedAll.input());
  assert.deepEqual(refusedAll.calls.asked.map(({ opts }) => opts.step), ["compile-1", "compile-2", "compile-3", "compile-4"]);
  assert.match(refusedAll.calls.asked[1].prompt, /its dry run failed/);
  assert.deepEqual(refusedAll.calls.committed, [], "nothing written");
  assert.deepEqual(refusedAll.calls.failed.map(({ workflow, errors: said }) => [workflow, said]), [["answer", errors]], "compile once: the failed attempt is on record");
  const end = kept(rows);
  assert.deepEqual([end.state, end.reason, end.draft_errors], ["dropped", "checker", errors]);
  assert.equal(end.compiled.attempts.length, 4);
  assert.equal(end.detail, said.checker([{ rule: "workflow" }]));

  const beside = hookWith({ compile: NEW, words: ["Keep it short."], answers, checks: Array.from({ length: 4 }, () => ({ errors })) });
  const merged = kept(await beside.hook(beside.input()));
  assert.deepEqual([merged.state, merged.corrections, merged.workflows], ["merged", 1, undefined]);
  assert.deepEqual(merged.problems, [{ rule: "workflow", detail: errors[0] }]);
  assert.deepEqual([beside.calls.committed[0].draft, beside.calls.committed[0].correction], [undefined, "Keep it short."]);
});

test("a fixed draft after a refused one is committed, every attempt recorded", async () => {
  const errors = ["workflows/answer/workflow.json: its dry run failed"];
  const { hook, input, calls } = hookWith({ compile: NEW, answers: [{ ended: true, answer: BLOCK }, { ended: true, answer: BLOCK }], checks: [{ errors }] });
  const end = kept(await hook(input()));
  assert.equal(calls.asked.length, 2);
  assert.deepEqual(end.compiled.attempts, [{ ok: false, errors }, { ok: true, errors: [] }]);
  assert.deepEqual(calls.failed, [], "a draft that passed records no failure");
  assert.equal(end.state, "merged");
});

test("a revision is checked against the commit its text was read at, kept with its first ask; a restart's answer keeps that ask's commit", async () => {
  const first = hookWith({ compile: REVISE, nothingNew: async () => true });
  await first.hook(first.input());
  assert.deepEqual(first.calls.asked[0].opts.keep, { answered_at: ANSWERED.answered_at, job_cost_usd: 0.01, compile_base: "base-1" });
  assert.deepEqual(first.calls.checked[0].revised, { workflow: "answer", base: "base-1" });
  const again = hookWith({ compile: REVISE, nothingNew: async () => true, answers: [{ ended: true, answer: BLOCK, kept: { answered_at: "2026-11-09T04:00:00.000Z", job_cost_usd: 0.002, compile_base: "base-0" } }] });
  const end = kept(await again.hook(again.input()));
  assert.deepEqual(again.calls.checked[0].revised, { workflow: "answer", base: "base-0" }, "the earlier claim's commit, never this claim's read");
  assert.deepEqual([end.state, end.answered_at, end.job_cost_usd, end.look_back_usd], ["merged", "2026-11-09T04:00:00.000Z", 0.002, 0.008], "the job's figures are the earlier ask's; what it spent since is learning's");
});

test("a compile ask the cap refused keeps nothing, saying so; a turn that failed or timed out is recorded as an attempt and drops as failed, never as a refused draft", async () => {
  const capped = hookWith({ compile: NEW, answers: [{ failed: { code: "run-failed", message: "spend_cap_reached ($1.00): the cap is reached" } }] });
  const end = kept(await capped.hook(capped.input()));
  assert.deepEqual([end.state, end.reason, end.detail], ["dropped", "no_budget", said.noBudget]);
  for (const answer of [{ timedOut: true }, { failed: { code: "run-failed", message: "the model refused" } }]) {
    const { hook, input, calls } = hookWith({ compile: NEW, answers: [answer] });
    const out = kept(await hook(input()));
    assert.deepEqual([out.state, out.reason, out.detail, out.draft_errors], ["dropped", "reflect_failed", said.stopped(STOPPED.unanswered), ["the turn ended before it answered"]], JSON.stringify(answer));
    assert.equal(out.problems, undefined, "no draft answered: no check refused it");
    assert.deepEqual(out.compiled.attempts, [{ ok: false, errors: ["the turn ended before it answered"] }]);
    assert.deepEqual(calls.failed, [], "no draft answered: no compile-once record");
  }
});

test("a merge that could not be written drops the learning: unavailable as failed, a conflict in the checks' words", async () => {
  const unavailable = hookWith({ words: ["Keep it short."], commit: () => ({ ok: false, reason: "unavailable", problems: [] }) });
  const one = kept(await unavailable.hook(unavailable.input()));
  assert.deepEqual([one.state, one.reason, one.detail], ["dropped", "reflect_failed", said.stopped(STOPPED.failed)]);
  const thrown = hookWith({ words: ["Keep it short."], commit: () => { throw new Error("the folder is gone"); } });
  assert.equal(kept(await thrown.hook(thrown.input())).reason, "reflect_failed");
  const problems = [{ rule: "conflict", path: "workflows/answer/workflow.json", detail: "main changed it since the run's seed" }];
  const conflict = hookWith({ compile: NEW, commit: () => ({ ok: false, reason: "conflict", problems }) });
  const two = kept(await conflict.hook(conflict.input()));
  assert.deepEqual([two.state, two.reason, two.problems], ["dropped", "checker", problems]);
});

test("every string the step keeps is cut of what the run must never learn", async () => {
  const value = "hold-this-value-0123456789";
  const { hook, input } = hookWith({ refuse: async () => [value], words: [`Use ${value}.`], refused: [{ rule: "secret_value", path: "corrections.md", detail: `it holds ${value}` }] });
  const rows = await hook(input());
  assert.ok(!JSON.stringify(rows).includes(value), JSON.stringify(rows));
});

test("a later round's rows carry its round", async () => {
  const { hook, input } = hookWith({ words: ["Keep it short."], round: 2 });
  const rows = await hook(input());
  assert.equal(rows.also[0].row.round, 2);
  assert.equal(rows.also[0].row.proposal.state, "merged");
});
