// A grade's feedback round (runner/feedback-round.ts) over a 20-run prequential stream: every run is graded with the
// teacher's label once it ended (PUT /runs/{id}/grade's logic: putGrade, then openFeedbackRound), as the loop proof feeds
// labels back. The run's path is who wrote its final answer, and feedback is learning spend:
//   - a run its learned workflow answered alone, graded right: the grade is kept, nothing more: no reopen, no request,
//     path `workflow`, learning $0;
//   - the same graded wrong: a revision ask for the workflow, never a re-run of the job: the run opens again, the agent is
//     asked its end-of-run turn alone (the look-back hears the job, the workflow's answer and the label; the compile turn
//     after it asks for the workflow again, with that answer and the label), the path stays `workflow`, and those turns'
//     $ is the run's learning, never its job's;
//   - a run the agent finished, graded with a label: a look-back round on it, no turn of the job's, and the cost per run
//     counts every round's look-back (agentCostOverStore: the job is its first round's, all after it learning).
// Then the rule itself (servedAnswerStands): a follow-up that ends with no new answer keeps the path; one the agent
// answered anew is `handed_back`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { putGrade } = await import("../dist/learn/promote.js");
const { openFeedbackRound, feedbackRoundOf } = await import("../dist/runner/feedback-round.js");
const { servedAnswerStands, sameAnswer } = await import("../dist/runner/workflow-first.js");
const { agentCostOverStore } = await import("../dist/store-reads/learning.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = "The agent's own answer: 42.";
const LABEL = (n) => `Review: the reference answer to question ${n} is 42.`;

const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};
const FLOWS = [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }];
const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const isNode = (request) => offers(request.body, "submit");
const textOf = (body) => [
  ...(Array.isArray(body?.system) ? body.system.map((block) => block?.text ?? "") : [String(body?.system ?? "")]),
  ...(body?.messages ?? []).flatMap((message) => (typeof message.content === "string" ? [message.content] : (message.content ?? []).map((block) => block?.text ?? (Array.isArray(block?.content) ? block.content.map((c) => c?.text ?? "").join("") : String(block?.content ?? ""))))),
].join("\n");
const lastText = (body) => textOf({ messages: (body?.messages ?? []).slice(-1) });
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** An agent that learned `answer`, a runner claiming every run from its stored launch. The node answers 41 to the
 *  questions in `wrong`, else 42, sure either way; the agent answers AGENT_SAYS. */
async function world(t, { wrong = new Set() } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-feedback-rounds-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: wrong.has(Number(/Question (\d+)/.exec(JSON.stringify(body))?.[1])) ? 41 : 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : AGENT_SAYS),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", FLOWS);
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id, after = 0) => until(async () => {
    const row = await server.runs.get(id);
    return ["ended", "failed", "stopped"].includes(row?.state) && row.runner === null && (row.endedAt ?? 0) > after && row;
  }, `run ${id} ended`);
  const start = async (id, n, { byHand = false } = {}) => {
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: `Question ${n}: what is six times seven?`, question: `Question ${n}: what is six times seven?` }, title: `q${n}`, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt(seed), ...(byHand ? { workflow_first: false } : {}) } });
    return ended(id);
  };
  /** The grade route's work (server.ts gradeRun): the grade with the path its record says, then its feedback round; a round
   *  opened is waited for to its end. */
  const grade = async (row, correct, label) => {
    const m = row.metrics ?? {};
    const graded = { run: row.id, correct, expected: { answer: 42 }, source: "eval", at: new Date().toISOString(), path: m.path ?? "agent", ...(m.workflow ? { workflow: m.workflow } : {}), ...(m.workflow_digest ? { digest: m.workflow_digest } : {}) };
    await putGrade(server.settings, "agent-1", graded);
    const round = await openFeedbackRound(server, graded, label);
    return { round, row: round ? await ended(row.id, row.endedAt ?? 0) : await server.runs.get(row.id) };
  };
  return { server, gw, start, grade };
}

test("a 20-run labelled stream: right served runs cost $0 learning and stay workflow; the wrong one gets a revision ask; every round's look-back is counted", { timeout: 300_000 }, async (t) => {
  const WRONG = 9;
  const { server, gw, start, grade } = await world(t, { wrong: new Set([WRONG]) });
  const agentRequests = () => gw.requests.filter((request) => !isNode(request));
  const rows = new Map();
  for (let n = 1; n <= 20; n++) {
    const id = `run-${n}`;
    const first = await start(id, n, { byHand: n <= 3 });
    const servedRight = first.metrics?.path === "workflow" && n !== WRONG;
    const before = agentRequests().length;
    const { round, row } = await grade(first, n !== WRONG, LABEL(n));
    rows.set(id, { n, first, row, round, asked: agentRequests().slice(before) });
    if (n <= 3) {
      assert.equal(first.metrics?.path, "agent", `run ${n} by hand: ${JSON.stringify(first.metrics)}`);
      assert.equal(round, "look_back", "a labelled run the agent finished looks back on the label");
    } else if (n === WRONG) {
      assert.equal(first.metrics?.path, "workflow", `run ${n} served: ${JSON.stringify(first.metrics)}`);
      assert.equal(round, "revise", "a wrong served answer asks for the workflow's revision");
    } else {
      assert.ok(servedRight, `run ${n} served and right: ${JSON.stringify(first.metrics)}`);
      assert.equal(round, null, "a right served run's grade asks for nothing more");
      assert.equal(agentRequests().length, before, "no request after a right grade");
      assert.equal(row.endedAt, first.endedAt, "the run was not opened again");
      assert.equal(await server.learning.proposal(id, 2), undefined, "no second round");
    }
  }

  // The wrong served run: one revision ask, no job re-run: every request after its grade is its end-of-run turn (the job,
  // the workflow's answer, the label and the ask first, then the prompt), and the path stays the workflow's.
  const wrong = rows.get(`run-${WRONG}`);
  assert.ok(wrong.asked.length >= 1, "the revision ask was asked");
  for (const request of wrong.asked) assert.ok(/The task is done\. Before the run ends|was not in the format|did not pass its dry run|Answer again|One more turn: revise your learned workflow|Your workflow draft did not pass the checks/i.test(lastText(request.body)), `only the end-of-run turn ran: ${lastText(request.body).slice(0, 300)}`);
  const ask = lastText(wrong.asked[0].body);
  assert.match(ask, new RegExp(`Question ${WRONG}: what is six times seven`), "the job");
  assert.match(ask, /Your learned workflow `answer` ran first on this job and answered it\. Its answer:\s+\{"answer":41,/, "what the workflow answered");
  assert.match(ask, new RegExp(LABEL(WRONG).replace(/[.?]/g, "\\$&")), "the label");
  assert.match(ask, /The task is done\. Before the run ends/, "then the end-of-run prompt");
  assert.doesNotMatch(ask, /Give `answer` again whole/, "the look-back keeps notes only: it asks for no workflow");
  // The compile turn after it asks for the revision, with the workflow's answer and the label.
  const compile = wrong.asked.map((request) => lastText(request.body)).find((text) => text.trimStart().startsWith("One more turn: revise your learned workflow `answer`."));
  assert.ok(compile, `the compile turn asked for the revision: ${wrong.asked.map((request) => lastText(request.body).slice(0, 80)).join(" | ")}`);
  assert.match(compile, /Your learned workflow `answer` answered this run alone, and a reviewer graded its answer wrong\./);
  assert.match(compile, /\{"answer":41,/, "the workflow's answer");
  assert.match(compile, new RegExp(LABEL(WRONG).replace(/[.?]/g, "\\$&")), "the label");
  assert.match(compile, /Give `answer` again whole under its name, changed so it answers cases like this one right or hands them back/, "the revision ask");
  assert.equal(wrong.row.metrics?.path, "workflow", `no new answer of the agent's: the path stays the workflow's: ${JSON.stringify(wrong.row.metrics)}`);
  const two = await server.learning.proposal(`run-${WRONG}`, 2);
  assert.equal(two?.round, 2, `the revision ask is round 2: ${JSON.stringify(two)}`);
  assert.ok(two.turn?.asked?.some((said) => said.includes(LABEL(WRONG))), `round 2 heard the label: ${JSON.stringify(two.turn)}`);
  assert.ok(two.proposal.look_back_usd > 0, "the ask was paid");
  near(two.proposal.follow_up_usd, 0, "no turn of the job's in the round");

  // The cost per run: right served runs at $0 learning; the wrong one's ask is learning, its job its node's; a run by hand
  // counts both rounds' look-backs.
  const { runs, summary } = await agentCostOverStore(server, "agent-1");
  assert.equal(runs.length, 20);
  const byId = new Map(runs.map((run) => [run.run_id, run]));
  for (const [id, { n }] of rows) {
    const run = byId.get(id);
    if (n <= 3 || n === WRONG) continue;
    assert.deepEqual([run.path, run.learning_usd], ["workflow", 0], `run ${n}: ${JSON.stringify(run)}`);
  }
  const one = await server.learning.proposal(`run-${WRONG}`, 1);
  const wrongCost = byId.get(`run-${WRONG}`);
  assert.equal(wrongCost.path, "workflow");
  near(wrongCost.cost_usd, one.proposal.job_cost_usd, "the wrong run's job is what its workflow cost");
  near(wrongCost.learning_usd, two.proposal.look_back_usd, "its revision ask is its learning");
  near(wrongCost.total_usd, wrong.row.costUsd, "its all-in is its row's");
  for (let n = 1; n <= 3; n++) {
    const id = `run-${n}`;
    const [r1, r2] = [await server.learning.proposal(id, 1), await server.learning.proposal(id, 2)];
    assert.ok(r1.proposal.look_back_usd > 0 && r2.proposal.look_back_usd > 0, `both rounds looked back: ${JSON.stringify([r1.proposal, r2.proposal])}`);
    const run = byId.get(id);
    near(run.learning_usd, r1.proposal.look_back_usd + r2.proposal.look_back_usd + (r2.proposal.follow_up_usd ?? 0), `run ${n} counts every round's look-back`);
    near(run.cost_usd, r1.proposal.job_cost_usd, `run ${n}'s job is its first round's`);
    assert.equal(rows.get(id).row.metrics?.path, "agent");
  }
  assert.equal(summary.takeover?.run_id, "run-4", JSON.stringify(summary));
});

test("feedbackRoundOf: a served run graded right asks nothing, wrong a revision; a run the agent finished looks back on a label; a replay nothing", () => {
  assert.equal(feedbackRoundOf({ correct: true, path: "workflow", workflow: "answer" }, "words"), undefined);
  assert.equal(feedbackRoundOf({ correct: false, path: "workflow", workflow: "answer" }, undefined), "revise");
  assert.equal(feedbackRoundOf({ correct: true, path: "agent" }, "words"), "look_back");
  assert.equal(feedbackRoundOf({ correct: false, path: "handed_back", workflow: "answer" }, "words"), "look_back");
  assert.equal(feedbackRoundOf({ correct: false, path: "agent" }, undefined), undefined);
  assert.equal(feedbackRoundOf({ correct: false, path: "replay", workflow: "answer" }, "words"), undefined);
});

test("servedAnswerStands: the path is who wrote the final answer; a follow-up with no new answer keeps it, a changed one hands it back", () => {
  const served = { kind: "final_answer", text: "{\"mcc\": \"5812\"}" };
  const label = { kind: "user_message", text: "Review: the reference is 5812." };
  const look = { kind: "final_answer", text: "NOTES: none", agent_label: "learning" };
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served]), true, "the workflow's answer alone");
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served, label, look]), true, "a feedback round: only the end-of-run turn answered");
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served, label, { kind: "final_answer", text: "```json\n{\"mcc\":\"5812\"}\n```" }]), true, "the agent said the same answer again");
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served, label, { kind: "final_answer", text: "{\"mcc\": \"5814\"}" }]), false, "the agent changed the answer");
  assert.equal(servedAnswerStands("42", [served, label, { kind: "final_answer", text: "Noted, thanks." }]), false, "a new answer of the agent's is the run's last word");
  assert.equal(sameAnswer(" 42 ", "42"), true);
  assert.equal(sameAnswer("{\"a\":1,\"b\":2}", "{\"b\": 2, \"a\": 1}"), true);
  assert.equal(sameAnswer("41", "42"), false);
});

test("the path compares the workflow's answer as it produced it and as the agent was shown it: a held value the redactor cut does not make a restated answer look changed", async () => {
  const { runPathOverStore } = await import("../dist/store-reads/learning.js");
  const { redactSecrets } = await import("../dist/learn/secrets.js");
  const held = "tok_live_9f3Kq2Zr7Lm4Xw8B";
  const produced = `{"mcc":"5812","source":"https://site.test/menu?key=${held}"}`;
  const shown = redactSecrets(produced, [held], Number.POSITIVE_INFINITY);
  assert.notEqual(shown, produced, "the redactor cuts the held value");
  const restated = [{ kind: "final_answer", text: produced }, { kind: "user_message", text: "Is that right?" }, { kind: "final_answer", text: shown }];
  assert.equal(servedAnswerStands(produced, restated), false, "compared with the produced answer alone, the restated one looks changed");
  assert.equal(servedAnswerStands(produced, restated, shown), true, "the answer as the agent was shown it stands");
  assert.equal(servedAnswerStands(produced, [...restated.slice(0, 2), { kind: "final_answer", text: shown.replace("5812", "5814") }], shown), false, "a changed one still hands it back");
  assert.equal(runPathOverStore.length >= 3, true);
});

test("a run with rounds: its impact and its cost per run read the same split: the job is its first round's, every later turn its learning", async () => {
  const { impactLearningOf, roundsLooked } = await import("../dist/store-reads/learning.js");
  const rounds = { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.6, look_back_usd: 0.1, grade_usd: 0.02 };
  // Round 1's job $0.60, a follow-up turn $0.30, two look-backs $0.10: the row holds $1.00.
  assert.deepEqual(roundsLooked(rounds, 1.0), { answered_at: rounds.answered_at, job_cost_usd: 0.6, look_back_usd: 0.4 });
  assert.deepEqual(roundsLooked(rounds, null), { answered_at: rounds.answered_at, job_cost_usd: 0.6, look_back_usd: null }, "an unknown row cost with the job known: the spend after the job is unknown, never the look-backs added up as settled");
  const impact = impactLearningOf({ state: "merged", reason: null, at: "2026-11-13T00:01:00.000Z" }, { seedNotes: 1 }, undefined, rounds, 1.0);
  assert.equal(impact.job_cost_usd, 0.6, "the job is round 1's");
  assert.equal(impact.look_back_usd, 0.4, "the follow-up turn is learning, as the cost per run counts it");
  assert.equal(impact.grade_usd, 0.02);
});
