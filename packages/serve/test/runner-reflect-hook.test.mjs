// The learning lane's end-of-run turn on the runner (runner/reflect-hook.ts): the server's rules, moved. Whether a run
// looks back (learning-run.ts reflectSkip), how its turn ended (closeLearning), and the rows kept beside its end: the
// turn and its proposal (learning_proposals), and a queued learning run only when there is something to grade.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReflectHook } from "../dist/runner/reflect-hook.js";
import { parseReflection, reflectPrompt } from "../dist/learn/index.js";
import { said, STOPPED } from "../dist/learning-words.js";

const claim = { runId: "run-1", runner: "runner-a", epoch: 1, until: 0, from: "running" };
/** The hooks' clock, and what a run that looked back keeps of its answer with it: its spend reads 0.01 throughout. */
const AT = Date.UTC(2026, 10, 9, 5, 0, 0);
const ANSWERED = { answered_at: new Date(AT).toISOString(), job_cost_usd: 0.01, look_back_usd: 0 };

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
    now: () => AT,
  };
  const hook = createReflectHook(deps);
  const input = (outcome = "completed") => ({
    runId: "run-1", agentId: "agent-1", claim, outcome, signal: new AbortController().signal,
    ask: async (prompt, opts) => {
      calls.asked.push({ prompt, opts });
      // The turn and at most one re-ask: a third ask fails the test where it happens, never spinning.
      if (calls.asked.length > 2) throw new Error(`the end-of-run turn was asked ${calls.asked.length} times`);
      return answer;
    },
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

test("the learning run a proposal queues names the grade model the hook is given (gradeModelOf, as main's server resolves it), and none when it is given none", async () => {
  const deps = (extra = {}) => ({
    facts: async () => ({ learns: true, costUsd: 0.01 }),
    promptFacts: async () => ({ active: 0, tools: [] }),
    asked: async () => ({ asked: ["Find the bug."] }),
    check: async () => ({ state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { notes: [{ file: "a.md", text: "x" }] } }),
    newRunId: () => "run-learn-1",
    ...extra,
  });
  const input = { runId: "run-1", agentId: "agent-1", claim, outcome: "completed", signal: new AbortController().signal, ask: async () => ({ ended: true, answer: "```note a.md\nx\n```" }) };
  const queued = async (extra) => (await createReflectHook(deps(extra))(input)).also.find((row) => row.table === "learning_run")?.row;
  assert.deepEqual(await queued({ gradeModel: "claude-sonnet-4-5" }), { id: "run-learn-1", model: "claude-sonnet-4-5" }, "the grade model, on the learning run");
  assert.deepEqual(await queued(), { id: "run-learn-1" }, "none given: none named, and the agent's own grades it");
});

test("a proposal keeps the turn and queues one learning run beside the end", async () => {
  const { hook, input, calls } = hookWith();
  const rows = await hook(input("failed"));
  assert.equal(calls.checked.length, 1, "the answer is checked once");
  assert.deepEqual(calls.checked[0].turn, { answer: "```note\n...\n```", asked: ["Find the bug."] });
  assert.equal(calls.checked[0].outcome, "failed", "the checks read how the job ended");
  assert.deepEqual(rows, {
    also: [
      { table: "learning_proposals", row: { turn: { answer: "```note\n...\n```", asked: ["Find the bug."] }, proposal: { state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { seed: "abc", notes: [{ file: "a.md", text: "x" }], asked: ["Find the bug."] }, detail: said.proposed(1, 0, 0), ...ANSWERED } } },
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
    assert.deepEqual(rows.also[0].row.proposal, { ...result, state: "dropped", detail, ...ANSWERED }, result.reason);
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
    const after = dropped(reason, detail);
    assert.deepEqual(await hook(input()), { also: [{ ...after, row: { ...after.row, proposal: { ...after.row.proposal, ...ANSWERED } } }] }, reason);
    assert.deepEqual(calls.checked, [], `${reason}: nothing checked`);
  }
});

/** A skill in the end-of-run format, fenced with `fence` (the format asks for four backticks). */
const SKILL_TEXT = "---\nname: find-policies\ndescription: Find a store's refund policy\n---\n# Find policies\n\nOpen /policies/ first.\n";
const skillAnswer = (fence) => `Here is what I learned.\n\n${fence}skill find-policies\n${SKILL_TEXT}${fence}\n`;

/** A hook whose checks are the parser's (parseReflection), its turn answering `answers` in order (one each ask; a third
 *  ask fails the test), on a clock that each ask moves by `askMs`. */
function parsedHook(answers, { askMs = 0, deadlineMs = 300_000 } = {}) {
  const calls = { asked: [], checked: [] };
  let clock = 1_000_000;
  const hook = createReflectHook({
    facts: async () => ({ learns: true, costUsd: 0.01 }),
    promptFacts: async () => ({ active: 0, tools: [] }),
    asked: async () => ({ asked: ["Find the policy."] }),
    check: async ({ turn }) => {
      calls.checked.push(turn.answer);
      const parsed = parseReflection(turn.answer);
      if (!parsed.ok) return parsed.reason === "empty" ? { state: "dropped", reason: "empty" } : { state: "dropped", reason: "unparsed", detail: parsed.detail };
      return { state: "proposed", notes: parsed.notes.length, skills: parsed.skills?.length ?? 0, workflows: parsed.workflows?.length ?? 0, proposal: { skills: parsed.skills } };
    },
    newRunId: () => "run-learn-1",
    deadlineMs,
    now: () => clock,
  });
  const input = {
    runId: "run-1", agentId: "agent-1", claim, outcome: "completed", signal: new AbortController().signal,
    ask: async (prompt, opts) => {
      calls.asked.push({ prompt, opts });
      if (calls.asked.length > answers.length) throw new Error(`asked ${calls.asked.length} times`);
      clock += askMs;
      return { ended: true, answer: answers[calls.asked.length - 1] };
    },
  };
  return { hook, input, calls };
}

test("an answer the parser refuses is asked again once, in the same turn, quoting the parser's detail: a skill opened with three backticks, then four, is proposed", async () => {
  const { hook, input, calls } = parsedHook([skillAnswer("```"), skillAnswer("````")]);
  const rows = await hook(input);
  assert.equal(calls.asked.length, 2, "asked again once");
  const [, again] = calls.asked;
  assert.ok(again.prompt.includes("a skill's block must open with four backticks: ````skill <name>"), `the parser's own detail: ${again.prompt}`);
  assert.match(again.prompt, /give the whole answer again in the format/i);
  assert.deepEqual(again.opts, { origin: "reflect", deadlineMs: 300_000, again: true }, "the re-ask: the turn's origin, its own request, what is left of the deadline");
  const kept = rows.also.find((row) => row.table === "learning_proposals").row;
  assert.equal(kept.turn.answer, skillAnswer("````"), "the turn kept is the answer read");
  assert.equal(kept.proposal.state, "proposed");
  assert.equal(kept.proposal.skills, 1, "the skill is proposed");
  assert.ok(rows.also.some((row) => row.table === "learning_run"), "a learning run is queued");
});

test("an answer refused twice is dropped as it was, asked twice and never a third time", async () => {
  const { hook, input, calls } = parsedHook([skillAnswer("```"), skillAnswer("```")]);
  const rows = await hook(input);
  assert.equal(calls.asked.length, 2, "one re-ask, no loop");
  assert.deepEqual(rows.also.map((row) => row.table), ["learning_proposals"], "no learning run");
  const kept = rows.also[0].row;
  assert.equal(kept.turn.answer, skillAnswer("```"));
  assert.deepEqual([kept.proposal.state, kept.proposal.reason, kept.proposal.detail], ["dropped", "unparsed", said.unparsed]);
});

test("the re-ask is inside the turn's deadline: it gets what the first answer left, and none when the first used it all", async () => {
  const left = parsedHook([skillAnswer("```"), skillAnswer("````")], { askMs: 240_000, deadlineMs: 300_000 });
  await left.hook(left.input);
  assert.deepEqual(left.calls.asked.map((ask) => ask.opts.deadlineMs), [300_000, 60_000], "the second ask has the minute left");
  const spent = parsedHook([skillAnswer("```"), skillAnswer("````")], { askMs: 300_000, deadlineMs: 300_000 });
  const rows = await spent.hook(spent.input);
  assert.equal(spent.calls.asked.length, 1, "no time left: not asked again");
  assert.deepEqual([rows.also[0].row.proposal.state, rows.also[0].row.proposal.reason], ["dropped", "unparsed"]);
});

/** A hook whose run's spend reads `spent` in turn (the job's when it answered, then the run's once its turn closed), its
 *  clock at `at`; the turn's ask resolves with `answer`. */
function timedHook({ spent, at, answer = { ended: true, answer: "```note\n...\n```" }, facts = {} }) {
  const reads = [...spent];
  const hook = createReflectHook({
    facts: async () => ({ learns: true, ...facts, costUsd: reads.length > 1 ? reads.shift() : reads[0] }),
    promptFacts: async () => ({ active: 1, tools: [] }),
    asked: async () => ({ asked: ["Find the bug."] }),
    check: async () => ({ state: "proposed", notes: 1, skills: 0, workflows: 0, proposal: { seed: "abc", notes: [], asked: [] } }),
    newRunId: () => "run-learn-1",
    now: () => at,
  });
  const input = { runId: "run-1", agentId: "agent-1", claim, outcome: "completed", signal: new AbortController().signal, ask: async () => answer };
  return { hook, input };
}

test("a run that looked back keeps when its job answered, what the job cost and what looking back cost (learning-run.ts closeLearning), on its proposal and on a drop after the turn", async () => {
  const at = Date.UTC(2026, 10, 9, 6, 0, 0);
  const first = timedHook({ spent: [0.3, 0.42], at });
  const kept = (await first.hook(first.input)).also[0].row.proposal;
  assert.equal(kept.answered_at, new Date(at).toISOString(), "when the job answered: as the turn starts");
  assert.equal(kept.job_cost_usd, 0.3, "the run's spend as its job answered");
  assert.equal(kept.look_back_usd, 0.12, "the run's spend once its turn closed, less the job's");
  const { hook, input } = timedHook({ spent: [0.3, 0.5], at, answer: { timedOut: true } });
  const late = (await hook(input)).also[0].row.proposal;
  assert.deepEqual([late.reason, late.answered_at, late.job_cost_usd, late.look_back_usd], ["reflect_timeout", new Date(at).toISOString(), 0.3, 0.2], "a turn past its deadline keeps them too");
  const unknown = timedHook({ spent: [0.3, null], at });
  assert.equal((await unknown.hook(unknown.input)).also[0].row.proposal.look_back_usd, null, "a spend not known once the turn closed: looking back's cost is unknown");
});

test("a run that never looked back keeps no answer time and no look-back cost", async () => {
  const { hook, input } = timedHook({ spent: [1], at: 0, facts: { capReached: true } });
  const kept = (await hook(input)).also[0].row.proposal;
  assert.equal(kept.reason, "no_budget");
  assert.ok(!("answered_at" in kept) && !("job_cost_usd" in kept) && !("look_back_usd" in kept), JSON.stringify(kept));
});

test("checks that fail on their own drop the learning, saying so, and queue no run", async () => {
  const { hook, input } = hookWith({ check: () => { throw new Error("no seed"); } });
  assert.deepEqual(await hook(input()), { also: [{ table: "learning_proposals", row: { turn: { answer: "```note\n...\n```", asked: ["Find the bug."] }, proposal: { state: "dropped", reason: "propose_failed", detail: said.stopped(STOPPED.notChecked), ...ANSWERED } } }] });
});
