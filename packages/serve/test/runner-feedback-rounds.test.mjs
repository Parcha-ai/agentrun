// A grade's feedback round (runner/feedback-round.ts) over a 20-run prequential stream: every run is graded with the
// teacher's label once it ended (PUT /runs/{id}/grade's logic: keepGrade), as the loop proof feeds
// labels back. The run's path is who wrote its final answer, and feedback is learning spend:
//   - a run its learned workflow answered alone, graded right or wrong: the grade is kept, nothing more: no reopen, no
//     request, no compile ask, path `workflow`, learning $0 (one wrong answer is one sample; a hold asks the revision);
//   - a run the agent finished, graded with a label: a correction round on it, its label one line of corrections.md, no
//     model turn asked (no compile is due), so its learning is $0 (agentCostOverStore: the job is its first round's, all
//     after it learning). Its first round, with no feedback yet, kept nothing.
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
const { gradesOf, markGradeRound, putGrade, recordPromotion } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { keepGrade, feedbackStatus, feedbackRoundOf } = await import("../dist/runner/feedback-round.js");
const { McpClaimRefused } = await import("../dist/runner/mcp-claim.js");
const { runLearningOverStore } = await import("../dist/store-reads/learning.js");
const { runEntries } = await import("../dist/store-reads/journal.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { secretsShown } = await import("../dist/learning.js");
const { servedAnswerStands } = await import("../dist/runner/workflow-first.js");
const { said } = await import("../dist/learning-words.js");
const { agentCostOverStore } = await import("../dist/store-reads/learning.js");
const { viewOverStore, answerOf } = await import("../dist/store-view.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = "The agent's own answer: 42.";
/** The agent's answer for an agent with an output schema (ANSWER_SCHEMA): its last fenced json block meets it. */
const AGENT_JSON = "The agent's own answer:\n\n```json\n{\"answer\": 42}\n```";
const ANSWER_SCHEMA = { type: "object", required: ["answer"], properties: { answer: { type: "number" } } };
const VIEW_DEPS = { origin: "", serverSecrets: () => [] };
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
 *  questions in `wrong`, else 42, sure either way; the agent answers AGENT_SAYS, after calling learned_workflow `answer`
 *  itself first on the questions in `calls`, or its `read` tool first on the questions in `reads` (a job by hand that
 *  costs more than a served one). A claim of a run in `refuse` is refused as its MCP step refuses one (nothing sent, the
 *  run ends failed). `learned`: false for an agent that learned nothing yet (no workflow, no promotion record);
 *  `learning`: its definition's learning (its compile_after). */
async function world(t, { wrong = new Set(), calls = new Set(), reads = new Set(), outputSchema, refuse = new Set(), learned = true, learning = true } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-feedback-rounds-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const question = (body) => Number(/Question (\d+)/.exec(JSON.stringify(body))?.[1]);
  const gw = await startFauxGateway({
    call: ({ body }) => {
      if (offers(body, "submit") && !hasResult(body)) return { name: "submit", input: { value: { answer: wrong.has(question(body)) ? 41 : 42, sure: true } } };
      if (offers(body, "learned_workflow") && !hasResult(body) && calls.has(question(body))) return { name: "learned_workflow", input: { name: "answer", input: { question: `Question ${question(body)}: what is six times seven?` } } };
      if (offers(body, "read") && !offers(body, "submit") && !hasResult(body) && reads.has(question(body))) return { name: "read", input: { path: "question.txt" } };
      return undefined;
    },
    text: ({ body }) => (offers(body, "submit") ? "submitted" : outputSchema ? AGENT_JSON : AGENT_SAYS),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning, ...(outputSchema ? { outputSchema } : {}) } });
  const seed = await landWorkflows(dir, "agent-1", learned ? FLOWS : []);
  // `answer` passed its check when it landed (runner/promotion.ts): the stream reads its grades, never a check of its own.
  const digest = workflowDigest({ workflow: JSON.stringify(answerFlow) });
  if (learned) await recordPromotion(server.learning, "agent-1", { workflow: "answer", digest, at: new Date().toISOString(), decided: "promote", reason: "checked before the stream", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5 } }, () => true);
  const price =(_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  const specOf = async (claim, run) => {
    if (refuse.has(claim.runId)) throw new McpClaimRefused("The MCP server test can't be used. Nothing was sent.");
    return specFromLaunch(claim, run);
  };
  const specFromLaunch = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  // `above`: the epoch its end's claim is past (a round keeps the run's end time, so a round's end is told by its claim).
  const ended = (id, after = 0, above = -1) => until(async () => {
    const row = await server.runs.get(id);
    return ["ended", "failed", "stopped"].includes(row?.state) && row.runner === null && (row.endedAt ?? 0) > after && row.epoch > above && row;
  }, `run ${id} ended`);
  // `offered`: the launch names the learned workflows its learned_workflow tool offers, as the server's does
  // (chooseWorkflows): a run whose agent calls the tool itself is classified by its timeline only then.
  const start = async (id, n, { byHand = false, offered = false } = {}) => {
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: `Question ${n}: what is six times seven?`, question: `Question ${n}: what is six times seven?` }, title: `q${n}`, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: { ...startAt(seed), ...(offered ? { workflows: ["answer"] } : {}) }, ...(byHand ? { workflow_first: false } : {}) } });
    return ended(id);
  };
  /** The grade route's work (server.ts gradeRun, keepGrade): the grade with the path its record says, kept with the
   *  feedback round it opened; a round opened is waited for to its end. `store`: the store it writes through; `at`: when
   *  it was given, by the API server's clock. */
  const grade = async (row, correct, label, store = server, at = new Date().toISOString()) => {
    const m = row.metrics ?? {};
    const graded = { run: row.id, correct, expected: { answer: 42 }, source: "eval", at, path: m.path ?? "agent", ...(m.workflow ? { workflow: m.workflow } : {}), ...(m.workflow_digest ? { digest: m.workflow_digest } : {}) };
    const kept = await keepGrade(store, "agent-1", graded, label);
    return { round: kept.feedback, kept, row: kept.feedback ? await ended(row.id, 0, row.epoch) : await server.runs.get(row.id) };
  };
  return { server, gw, start, ended, grade };
}

test("a 20-run labelled stream: served runs, right or wrong, cost $0 learning and stay workflow; the wrong one's grade is kept and asks nothing; every correction round's turn is counted", { timeout: 300_000 }, async (t) => {
  const WRONG = 9;
  // The runs by hand read a file before they answer: their job costs more than a served run's, so the workflow stays
  // under the money rule's line (workflow-first.ts costLineOf) for the whole stream.
  const { server, gw, start, grade } = await world(t, { wrong: new Set([WRONG]), reads: new Set([1, 2, 3]) });
  const agentRequests = () => gw.requests.filter((request) => !isNode(request));
  const rows = new Map();
  for (let n = 1; n <= 20; n++) {
    const id = `run-${n}`;
    const first = await start(id, n, { byHand: n <= 3 });
    const servedRight = first.metrics?.path === "workflow" && n !== WRONG;
    const before = agentRequests().length;
    const result = n === WRONG ? (await viewOverStore(server, id, VIEW_DEPS)).result : undefined;
    const { round, row } = await grade(first, n !== WRONG, LABEL(n));
    rows.set(id, { n, first, row, round, result, asked: agentRequests().slice(before) });
    if (n <= 3) {
      assert.equal(first.metrics?.path, "agent", `run ${n} by hand: ${JSON.stringify(first.metrics)}`);
      assert.equal(round, "correction", "a labelled run the agent finished opens a correction round on the label");
    } else {
      assert.equal(first.metrics?.path, "workflow", `run ${n} served: ${JSON.stringify(first.metrics)}`);
      assert.ok(n === WRONG || servedRight, `run ${n} served and right: ${JSON.stringify(first.metrics)}`);
      assert.equal(round, null, `a served run's grade, ${n === WRONG ? "wrong" : "right"}, asks for nothing more`);
      assert.equal(agentRequests().length, before, "no request after the grade");
      assert.deepEqual([row.epoch, row.endedAt], [first.epoch, first.endedAt], "the run was not opened again");
      assert.equal(await server.learning.proposal(id, 2), undefined, "no second round");
    }
  }

  // The wrong served run: its grade is kept, wrong, naming no round; no request after it asked a compile, and its answer
  // stands.
  const wrong = rows.get(`run-${WRONG}`);
  const kept = (await gradesOf(server.learning, "agent-1")).find((one) => one.run === `run-${WRONG}`);
  assert.deepEqual([kept?.correct, kept?.path, kept?.workflow, kept?.feedback], [false, "workflow", "answer", null], `the wrong grade is kept: ${JSON.stringify(kept)}`);
  const compiles = agentRequests().filter((request) => /^One more turn: (revise your learned workflow|write this agent's job)/.test(lastText(request.body).trimStart()));
  assert.deepEqual(compiles.map((request) => lastText(request.body).slice(0, 80)), [], "no run of the stream asked a compile");
  assert.equal(wrong.row.metrics?.path, "workflow", `the path stays the workflow's: ${JSON.stringify(wrong.row.metrics)}`);
  assert.ok(wrong.result?.final_answer, `the served run had an answer: ${JSON.stringify(wrong.result)}`);
  assert.deepEqual((await viewOverStore(server, `run-${WRONG}`, VIEW_DEPS)).result, wrong.result, "the grade left the run's result as it was");

  // The cost per run: served runs, right or wrong, at $0 learning; a run by hand's label round asks no turn ($0 too), and
  // its first round, with no feedback, kept nothing and asked nothing.
  const { runs, summary } = await agentCostOverStore(server, "agent-1");
  assert.equal(runs.length, 20);
  const byId = new Map(runs.map((run) => [run.run_id, run]));
  for (const [id, { n }] of rows) {
    const run = byId.get(id);
    if (n <= 3) continue;
    assert.deepEqual([run.path, run.learning_usd], ["workflow", 0], `run ${n}: ${JSON.stringify(run)}`);
  }
  for (let n = 1; n <= 3; n++) {
    const id = `run-${n}`;
    const [r1, r2] = [await server.learning.proposal(id, 1), await server.learning.proposal(id, 2)];
    assert.deepEqual([r1.turn, r1.proposal.state, r1.proposal.detail, r1.proposal.look_back_usd], [null, "dropped", said.empty, 0], `round 1, no feedback, kept nothing: ${JSON.stringify(r1)}`);
    assert.deepEqual([r2.proposal.state, r2.proposal.corrections], ["merged", 1], `the label's round kept it as a correction: ${JSON.stringify(r2.proposal)}`);
    const run = byId.get(id);
    // The label's round asks no model turn (no compile is due in the stream: none asked above), so it spends nothing.
    assert.equal(r2.proposal.look_back_usd, 0, `round 2 asked no turn: ${JSON.stringify(r2.proposal)}`);
    assert.equal(run.learning_usd, 0, `run ${n}'s label round spent no learning: ${JSON.stringify(run)}`);
    near(run.cost_usd, r1.proposal.job_cost_usd, `run ${n}'s job is its first round's`);
    assert.equal(rows.get(id).row.metrics?.path, "agent");
  }
  assert.equal(summary.takeover?.run_id, "run-4", JSON.stringify(summary));
});

// A grade's correction round with a compile due: the correction the round takes (reflect-hook.ts `taken`) is part of
// what that round's compile is told, on every attempt, beside the owner's other corrections; one the checks refuse is
// never told. The agent learned nothing yet and compiles after 1 run: run 1's own compile answers no block on each
// attempt (a first compile's failure stops nothing), so the grade's round is due its compile again.
test("a grade's correction round with a compile due: each attempt of the round's compile is told the grade's words; a refused correction is told never", { timeout: 180_000 }, async (t) => {
  const isCompile = (request) => /^(One more turn: (revise your learned workflow|write this agent's job)|Your workflow draft did not pass the checks)/.test(lastText(request.body).trimStart());
  const WORDS = "Always answer in words, never digits.";
  // A character a reader does not see: corrections.md refuses the line (learn/check.ts unstorable).
  const REFUSED = `Answer in Roman numerals${String.fromCodePoint(0x200b)} from now on.`;
  for (const [label, told] of [[WORDS, true], [REFUSED, false]]) {
    const { gw, start, grade, server } = await world(t, { learned: false, learning: { compile_after: 1 } });
    const first = await start("run-1", 1);
    assert.equal(first.metrics?.path, "agent", JSON.stringify(first.metrics));
    assert.ok(gw.requests.some(isCompile), "run 1's own end asked its compile");
    const before = gw.requests.length;
    const { round } = await grade(first, false, label);
    assert.equal(round, "correction");
    const compiles = gw.requests.slice(before).filter(isCompile);
    assert.equal(compiles.length, 4, `the round's compile asked 1 + 3 attempts: ${compiles.map((request) => lastText(request.body).slice(0, 60)).join(" | ")}`);
    const kept = await server.learning.proposal("run-1", 2);
    assert.equal(kept?.proposal?.compiled?.attempts?.length, 4, JSON.stringify(kept?.proposal));
    if (told) {
      assert.ok(lastText(compiles[0].body).includes(WORDS), `the round's first compile ask holds the grade's words: ${lastText(compiles[0].body)}`);
      compiles.forEach((request, i) => assert.ok(textOf(request.body).includes(WORDS), `attempt ${i + 1}, as the model received it, holds the grade's words`));
      assert.equal(kept.proposal.corrections, 1, "the correction is kept too");
    } else {
      compiles.forEach((request, i) => assert.ok(!textOf(request.body).includes("Roman numerals"), `attempt ${i + 1} never holds the refused correction`));
      assert.equal(kept.proposal.corrections, undefined, "the refused correction is kept nowhere");
    }
  }
});

test("feedbackRoundOf: a served run graded right or wrong asks nothing, with words or none; a run the agent finished opens a correction round on a label; a replay nothing", () => {
  assert.equal(feedbackRoundOf({ correct: true, path: "workflow", workflow: "answer" }, "words"), undefined);
  assert.equal(feedbackRoundOf({ correct: false, path: "workflow", workflow: "answer" }, undefined), undefined);
  assert.equal(feedbackRoundOf({ correct: false, path: "workflow", workflow: "answer" }, "words"), undefined);
  assert.equal(feedbackRoundOf({ correct: true, path: "agent" }, "words"), "correction");
  assert.equal(feedbackRoundOf({ correct: false, path: "handed_back", workflow: "answer" }, "words"), "correction");
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
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served, label, { kind: "final_answer", text: "```\n{\"mcc\":\"5812\"}\n```" }]), true, "the agent restated the answer in an unlabelled fence");
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served, label, { kind: "final_answer", text: "{\"mcc\": \"5814\"}" }]), false, "the agent changed the answer");
  assert.equal(servedAnswerStands("42", [served, label, { kind: "final_answer", text: "Noted, thanks." }]), false, "a new answer of the agent's is the run's last word");
  const prose = "Here is the answer you asked for.\n\n```json\n{\"mcc\":\"5812\"}\n```\n\nTell me if you want anything else.";
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served, label, { kind: "final_answer", text: prose }]), true, "the agent restated the workflow's JSON inside prose: the same answer, the path stays workflow");
  assert.equal(servedAnswerStands("{\"mcc\": \"5812\"}", [served, label, { kind: "final_answer", text: prose.replace("5812", "5814") }]), false, "prose around a changed value is a new answer");
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

test("a run with rounds: its impact and its cost per run read the same split: the job and its follow-up turns are the job's, every round's look-back its learning", async () => {
  const { impactLearningOf } = await import("../dist/store-reads/learning.js");
  const { roundsLooked } = await import("../dist/learn/ledger.js");
  const rounds = { answered_at: "2026-11-13T00:00:00.000Z", job_cost_usd: 0.6, look_back_usd: 0.1 };
  // Round 1's job $0.60, a follow-up turn $0.30, two compile turns $0.10: the row holds $1.00. A grade's feedback round
  // asks no job turn (feedback-round.ts): its spend is all in its look-back, learning's either way.
  assert.deepEqual(roundsLooked(rounds, 1.0), { answered_at: rounds.answered_at, job_cost_usd: 0.9, look_back_usd: 0.1 });
  assert.deepEqual(roundsLooked(rounds, null), { answered_at: rounds.answered_at, job_cost_usd: null, look_back_usd: 0.1 }, "an unknown row cost: the job, which holds the follow-up, is unknown, never round 1's figure");
  const impact = impactLearningOf({ state: "merged", reason: null, at: "2026-11-13T00:01:00.000Z" }, { seed: "a".repeat(40), section: "" }, undefined, rounds, 1.0);
  assert.equal(impact.job_cost_usd, 0.9, "the job and its follow-up turn");
  assert.equal(impact.look_back_usd, 0.1, "the look-backs alone are learning, as the cost per run counts them");
});

test("a run whose agent called learned_workflow itself, graded wrong, label and all: the grade is kept and opens no round; the path stays workflow (#2648 review)", { timeout: 120_000 }, async (t) => {
  const { server, gw, start, grade } = await world(t, { wrong: new Set([5]), calls: new Set([5]) });
  const first = await start("run-called", 5, { byHand: true, offered: true });
  assert.ok(gw.requests.some((request) => (request.body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_use" && block.name === "learned_workflow"))), "the agent called the workflow itself");
  assert.deepEqual([first.metrics?.path, first.metrics?.workflow], ["workflow", "answer"], `the job did only that: ${JSON.stringify(first.metrics)}`);
  const before = gw.requests.length;
  const { round, row } = await grade(first, false, LABEL(5));
  assert.equal(round, null, "a wrong answer of the workflow's opens no round");
  assert.equal(gw.requests.length, before, "no request after the grade");
  assert.deepEqual([row.epoch, row.endedAt], [first.epoch, first.endedAt], "the run was not opened again");
  const read = await runLearningOverStore(server, "run-called", secretsShown([]), []);
  assert.deepEqual([read?.graded?.correct, read?.graded?.feedback, read?.graded?.path, read?.graded?.workflow], [false, null, "workflow", "answer"], `the learning read keeps the grade, naming no round: ${JSON.stringify(read?.graded)}`);
  assert.deepEqual([row.metrics?.path, row.metrics?.workflow], ["workflow", "answer"], JSON.stringify(row.metrics));
  assert.equal(await server.learning.proposal("run-called", 2), undefined, "no second round");
});

test("a run whose agent called its learned workflow, the answer the workflow's, is served by that revision as a platform-served one is: its record, its view and its ledger row name the call's digest, and the revision's spend is shared over it", { timeout: 180_000 }, async (t) => {
  const { summarize } = await import("../dist/learn/ledger.js");
  const { server, start } = await world(t, { calls: new Set([5]), reads: new Set([1]) });
  const digest = workflowDigest({ workflow: JSON.stringify(answerFlow) });
  await start("run-hand", 1, { byHand: true });
  const platform = await start("run-served", 6);
  assert.deepEqual([platform.metrics?.path, platform.metrics?.workflow_digest], ["workflow", digest], `the platform served it first: ${JSON.stringify(platform.metrics)}`);
  const called = await start("run-called", 5, { byHand: true, offered: true });
  const calls = called.metrics?.workflow_calls ?? [];
  assert.deepEqual(calls.map((call) => [call.caller, call.digest]), [["agent", digest]], `the agent's own call, at the revision: ${JSON.stringify(called.metrics)}`);
  assert.deepEqual([called.metrics?.path, called.metrics?.workflow, called.metrics?.workflow_digest], ["workflow", "answer", digest], `its record names the call's digest: ${JSON.stringify(called.metrics)}`);
  assert.equal((await viewOverStore(server, "run-called", VIEW_DEPS)).workflow?.digest, digest, "the run view names the revision that ran");
  const { rows } = await server.learning.ledger("agent-1");
  assert.equal(rows.find((one) => one.runId === "run-called")?.digest, digest, "its ledger row names the revision");
  // The revision's $0.40 compile (kept on the run by hand) spread over its first two served runs: the platform's and the
  // agent's, $0.20 each.
  const spend = [{ runId: "run-hand", agentId: "agent-1", round: 1, kind: "compile", ofRun: null, workflow: "answer", digest, usd: 0.4 }];
  const out = summarize({ rows, spend, shadows: new Map(), revisions: [{ workflow: "answer", digest, k: 2, state: "serving" }], compileAfter: 2 });
  assert.deepEqual(["run-served", "run-called"].map((id) => out.figures.get(id)?.share_usd), [0.2, 0.2], "each served run carries its share");
  assert.deepEqual(out.bill.revisions.map((one) => [one.served, one.attributed_usd, one.unattributed_usd]), [[2, 0.4, 0]], JSON.stringify(out.bill.revisions));
});

test("a graded run keeps its answer: its feedback round's words are no message of the job's, so result.final_answer and result.output stand after the round (#2648 review)", { timeout: 120_000 }, async (t) => {
  const { server, start, grade } = await world(t, { outputSchema: ANSWER_SCHEMA });
  const first = await start("run-graded", 1, { byHand: true });
  assert.equal(first.metrics?.path, "agent", "the agent finished it: a label opens a correction round");
  const before = await viewOverStore(server, "run-graded", VIEW_DEPS);
  assert.equal(before.status, "completed");
  assert.deepEqual([before.result?.final_answer, before.result?.output], [AGENT_JSON, { answer: 42 }], `the job's answer and its output: ${JSON.stringify(before.result)}`);
  const { round, row } = await grade(first, false, LABEL(1));
  assert.equal(round, "correction", "a labelled run the agent finished opens a correction round on the label");
  assert.ok(row.epoch > first.epoch, "the run was opened again and ended");
  assert.equal(row.endedAt, first.endedAt, "at its job's end: the round keeps it");
  const kept = (await server.learning.proposal("run-graded", 2))?.proposal;
  assert.deepEqual([kept?.state, kept?.corrections], ["merged", 1], `the round kept the label as a correction: ${JSON.stringify(kept)}`);
  const after = await viewOverStore(server, "run-graded", VIEW_DEPS);
  assert.equal(after.status, "completed");
  assert.deepEqual(after.result, before.result, `the round left the run's answer and output as they were: ${JSON.stringify(after.result)}`);
  const { runTimeline } = await import("../dist/store-reads/journal.js");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const shown = (await runTimeline(server, "run-graded", BACKGROUND_CONTEXT, { settled: true })).filter((one) => one.kind === "user_message" && one.text === LABEL(1));
  assert.deepEqual(shown.map((one) => one.id.endsWith(":feedback")), [true], `the grade's words still show, once, as the reviewer's message, marked: ${JSON.stringify(shown)}`);
});

test("the job's turns: a grade's words' row (FEEDBACK_SUFFIX) is no message of the job's for any reader: the answer, the path, nothing new, the messages a stop stands after, a run's trace; a person's follow-up still is", async () => {
  const { withoutFeedbackRounds } = await import("../dist/store-reads/journal.js");
  const { runPathOf, onlyLearnedWorkflows, traceFrom } = await import("../dist/runner/learning-end.js");
  const { isMessageRow, isFeedbackRow, FEEDBACK_SUFFIX } = await import("../dist/timeline/index.js");
  const { usersOf, stoppedAt } = await import("../dist/run-view.js");
  const row = (id, kind, extra = {}) => ({ id, kind, agent_label: null, parent_tool_use_id: null, text: null, ...extra });
  const job = [row("0:1", "user_message", { text: "Question 1" }), row("0:2", "tool_use", { tool_name: "learned_workflow", tool_use_id: "c1" }), row("0:3", "tool_result", { tool_name: "learned_workflow", tool_use_id: "c1", tool_status: "success" }), row("0:4", "final_answer", { text: "42" })];
  const words = row(`0:7${FEEDBACK_SUFFIX}`, "user_message", { text: "Review: wrong." });
  const round = [words, row("0:8", "error"), row("0:9", "user_message", { text: "asked", agent_label: "learning" }), row("0:10", "final_answer", { text: "NOTES", agent_label: "learning" })];
  const graded = [...job, ...round];
  const person = row("0:17", "user_message", { text: "Why 42?" });
  // The mark.
  assert.equal(FEEDBACK_SUFFIX, ":feedback");
  assert.deepEqual([isFeedbackRow(words), isMessageRow(words)], [true, false], "a grade's words are shown, never a message a turn took");
  assert.deepEqual([isFeedbackRow(person), isMessageRow(person)], [false, true], "a person's message is one");
  // The view.
  assert.deepEqual(withoutFeedbackRounds(graded), [...job, ...round.slice(2)], "the round's words and the rows up to the next message are left out");
  assert.deepEqual(withoutFeedbackRounds(job), job, "a run with no round reads as it is");
  // The answer (GET /runs/{id} result.final_answer, and result.output read from it).
  assert.equal(answerOf(graded), "42", "a grade never cuts the job's answer off");
  assert.equal(answerOf([...graded, person]), null, "a person's follow-up with no answer of its own still has none");
  assert.equal(answerOf([...graded, person, row("0:18", "final_answer", { text: "Six times seven." })]), "Six times seven.");
  // The path, and nothing new to look back on.
  assert.deepEqual([runPathOf(graded), onlyLearnedWorkflows(graded)], ["workflow", true], "the round is learning, never the agent going on");
  assert.deepEqual([runPathOf([...graded, person, row("0:18", "final_answer", { text: "41" })]), onlyLearnedWorkflows([...graded, person])], ["handed_back", false], "a person's follow-up after the round is the job's");
  // The messages a stop stands after (run-view.ts usersOf, stoppedAt): a grade is no newer message.
  assert.equal(usersOf(graded), usersOf(job) + 1, "the job's message and the end-of-run turn's ask; never the grade's words");
  const heard = [...job, words];
  assert.equal(stoppedAt({ stopped_at: "0:4" }, heard), true, "a stop still stands after a grade's words");
  assert.equal(stoppedAt({ stopped_after: usersOf(job) }, heard), true, "counted, the grade's words are no message");
  assert.equal(stoppedAt({ stopped_at: "0:4" }, [...heard, person]), false, "a person's message after it moves on");
  // A run's trace for a later compile: the person's messages after the first, never a grade's.
  assert.deepEqual(traceFrom(graded, []).feedback, [], "a grade is not the person's feedback");
  assert.deepEqual(traceFrom([...graded, person], []).feedback, ["Why 42?"]);
  assert.equal(traceFrom(graded, []).answer, "42");
});

test("a grade of an archived run, or of a run of an archived agent, is kept and opens no round: closed history starts no paid learning (#2648 review)", { timeout: 120_000 }, async (t) => {
  const { server, start, grade } = await world(t);
  const archived = await start("run-archived", 1, { byHand: true });
  assert.equal(archived.metrics?.path, "agent", "the agent finished it: a label opens a correction round");
  await server.runs.archive(archived.id, true);
  const one = await grade(archived, false, LABEL(1));
  assert.equal(one.round, null, "an archived run opens no round");
  assert.equal(one.row.state, "ended");
  assert.deepEqual([one.row.epoch, one.row.endedAt], [archived.epoch, archived.endedAt], "the archived run was never opened again");
  const ofArchived = await start("run-of-archived", 2, { byHand: true });
  await server.agents.archive("agent-1", true);
  const two = await grade(ofArchived, false, LABEL(2));
  assert.equal(two.round, null, "a run of an archived agent opens no round");
  assert.deepEqual([two.row.epoch, two.row.endedAt], [ofArchived.epoch, ofArchived.endedAt], "the run of the archived agent was never opened again");
});

// A served run graded wrong, with words, a right answer or neither, opens no round and asks no compile, of its run or of
// the next one; the grade is kept as given (the graded hold, replay and refit read it).
test("a wrong grade of a served run opens no round and asks no compile; the grade is kept", { timeout: 120_000 }, async (t) => {
  const { server, gw, start } = await world(t, { wrong: new Set([4, 5, 6]) });
  const agentRequests = () => gw.requests.filter((request) => !isNode(request));
  const compiles = (requests) => requests.map((request) => lastText(request.body).trimStart()).filter((text) => text.startsWith("One more turn:"));
  for (const [n, expected, label] of [[4, { answer: 42 }, undefined], [5, undefined, undefined], [6, { answer: 42 }, LABEL(6)]]) {
    const first = await start(`run-wrong-${n}`, n);
    const m = first.metrics ?? {};
    assert.equal(m.path, "workflow", `run ${n} served: ${JSON.stringify(m)}`);
    const before = agentRequests().length;
    const kept = await keepGrade(server, "agent-1", { run: first.id, correct: false, ...(expected ? { expected } : {}), source: "eval", at: new Date().toISOString(), path: m.path, workflow: m.workflow, ...(m.workflow_digest ? { digest: m.workflow_digest } : {}) }, label);
    assert.deepEqual([kept.correct, kept.feedback, kept.workflow], [false, null, "answer"], `the grade is kept, naming no round: ${JSON.stringify(kept)}`);
    assert.deepEqual(agentRequests().slice(before).map((request) => lastText(request.body).slice(0, 80)), [], "no request after the grade");
    const row = await server.runs.get(first.id);
    assert.deepEqual([row.state, row.epoch, row.endedAt], ["ended", first.epoch, first.endedAt], "the run was not opened again");
    assert.equal(await server.learning.proposal(first.id, 2), undefined, "no second round");
  }
  assert.deepEqual((await gradesOf(server.learning, "agent-1")).map((grade) => [grade.run, grade.correct, grade.feedback]).sort(), [["run-wrong-4", false, null], ["run-wrong-5", false, null], ["run-wrong-6", false, null]]);
  // The next served run asks no compile either: the grades are kept, and only a hold of the workflow asks its revision.
  const before = agentRequests().length;
  const next = await start("run-after", 7);
  assert.equal(next.metrics?.path, "workflow", JSON.stringify(next.metrics));
  assert.deepEqual(compiles(agentRequests().slice(before)), [], "no compile was asked");
});

// The kept grade names the round it opened only once the round opened (keepGrade: the grade first, then the reopen, then
// the round on the kept grade): a reopen that fails leaves a grade that names none, never one that claims a round; one
// that opens marks the kept grade in place, so its seq (a serving digest's new-grades cursor) moves once per grade.
test("a grade names its round only once the round opened: a failed reopen leaves it naming none; an opened one marks it in place, its seq kept", { timeout: 120_000 }, async (t) => {
  const { server, start, grade } = await world(t);
  const first = await start("run-reopen", 1, { byHand: true });
  assert.equal(first.metrics?.path, "agent", "the agent finished it: a label opens a correction round");
  const failing = { settings: server.settings, learning: server.learning, agents: server.agents, runs: { get: (id) => server.runs.get(id), launch: (id) => server.runs.launch(id), reopen: async () => { throw new Error("the store went away") } } };
  await assert.rejects(grade(first, false, LABEL(1), failing), /the store went away/);
  const [failed] = await gradesOf(server.learning, "agent-1");
  assert.deepEqual([failed?.run, failed?.feedback], ["run-reopen", null], `the grade is kept, naming no round: ${JSON.stringify(failed)}`);
  const unopened = await server.runs.get("run-reopen");
  assert.deepEqual([unopened.epoch, unopened.endedAt], [first.epoch, first.endedAt], "the run was never opened again");
  const none = (await runLearningOverStore(server, "run-reopen", secretsShown([]), []))?.graded;
  assert.deepEqual([none?.feedback, none?.feedback_status], [null, null], `the read says no round: ${JSON.stringify(none)}`);

  const { round, kept } = await grade(first, false, LABEL(1));
  assert.equal(round, "correction");
  const [marked] = await gradesOf(server.learning, "agent-1");
  assert.deepEqual([marked.feedback, marked.seq, marked.at], ["correction", kept.seq, kept.at], `marked in place: ${JSON.stringify(marked)}`);
  assert.equal(kept.seq, failed.seq + 1, "one new seq per grade, none for the round's mark");
});

// Review on #2858 (round 2): a round's end is read from its run's journal, which one writer orders (the store's command
// id on the round's steer, the runner's FEEDBACK entry naming it, then the run's end entry), never by comparing the API
// server's `graded_at` with the runner's `ended_at`. A grade dated after the round's end (a runner whose clock trails
// the server's) still reads its round ended; a round whose run has not ended since its words, or whose steer no runner
// took yet, reads running.
test("a grade's round reads ended from its run's journal, never a clock: a grade dated after the round's end still reads it ended", { timeout: 120_000 }, async (t) => {
  const { server, start, grade } = await world(t);
  const first = await start("run-skew", 1, { byHand: true });
  const { round, kept, row } = await grade(first, false, LABEL(1), server, "2099-01-01T00:00:00.000Z");
  assert.equal(round, "correction");
  assert.ok(row.endedAt < Date.parse(kept.at), `the runner's end is dated before the grade: ${row.endedAt} vs ${kept.at}`);
  const read = (await runLearningOverStore(server, first.id, secretsShown([]), []))?.graded;
  assert.deepEqual([read?.feedback, read?.feedback_status], ["correction", "ended"], `the round ended: ${JSON.stringify(read)}`);

  const [marked] = await gradesOf(server.learning, "agent-1");
  assert.equal(typeof marked.feedbackCommand, "number", `the grade keeps its round's steer: ${JSON.stringify(marked)}`);
  const entries = await runEntries(server, first.id, BACKGROUND_CONTEXT);
  const taken = { id: marked.feedbackCommand, refused: null };
  assert.equal(feedbackStatus(entries, taken), "ended");
  const end = entries.findLastIndex((entry) => entry.kind === "agentrun.end");
  assert.equal(feedbackStatus(entries.slice(0, end), taken), "running", "no end after its words yet: running");
  assert.equal(feedbackStatus(entries, { id: marked.feedbackCommand + 1, refused: null }), "running", "a newer round whose steer no runner took yet: running");
  assert.equal(feedbackStatus(entries, undefined), "running", "a steer row that can't be read, with no FEEDBACK naming it: running");
});

// Review on #2858 (round 3): a reopened run can end before its runner takes the round's steer (its claim refused while
// its MCP credentials were made fresh: an end with nothing sent). The runner writes no FEEDBACK entry then; the end's
// own commit refuses the steer row (refuseLeftovers). The read says the round settled without running (`not_run`),
// never "running" for good; the store's refusal is written in the end's transaction, so no clock is compared here either.
test("a reopened run that ends before it takes the round's words reads not_run, settled", { timeout: 120_000 }, async (t) => {
  const refuse = new Set();
  const { server, start, grade } = await world(t, { refuse });
  const first = await start("run-refused", 1, { byHand: true });
  refuse.add(first.id);
  const { round, kept, row } = await grade(first, false, LABEL(1));
  assert.equal(round, "correction");
  assert.equal(row.state, "failed", `the reopened claim was refused: ${JSON.stringify(row)}`);
  const entries = await runEntries(server, first.id, BACKGROUND_CONTEXT);
  assert.ok(!entries.some((entry) => entry.kind === "agentrun.feedback"), "no FEEDBACK entry: the round never ran");
  const [steer] = await server.commands(first.id, kept.feedbackCommand - 1);
  assert.deepEqual([steer?.id, typeof steer?.refused], [kept.feedbackCommand, "string"], `the end refused the round's steer: ${JSON.stringify(steer)}`);
  const read = (await runLearningOverStore(server, first.id, secretsShown([]), []))?.graded;
  assert.deepEqual([read?.feedback, read?.feedback_status], ["correction", "not_run"], `the round settled, not run: ${JSON.stringify(read)}`);
});

// Review on #2858 (round 4): a store that fails while the read looks up the round's steer row is a failed read, never a
// 200 saying "running" (which the console would never retry); the console's failed-read retry covers it.
test("a store failure while the read looks up the round's steer fails the read, it does not read running", { timeout: 120_000 }, async (t) => {
  const { server, start, grade } = await world(t);
  const first = await start("run-store-down", 1, { byHand: true });
  await grade(first, false, LABEL(1));
  const failing = new Proxy(server, { get: (target, key) => {
    if (key === "commands") return async () => { throw new Error("the store went away") };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(runLearningOverStore(failing, first.id, secretsShown([]), []), /the store went away/);
});

// Two grades of one run can share their `at` (a millisecond): the second replaces the first, then the first's round
// opens. The round marks the grade it was opened for (its run, `at` and `seq`), never its replacement.
test("a round marks only the grade it was opened for: a replacement given in the same millisecond stays naming none", async () => {
  // The agent's grade records in memory, each write one change of them (Store.learning changeRecords).
  const kept = new Map();
  let seq = 0;
  const rows = {
    records: async (_agentId, kind) => structuredClone(kept.get(kind) ?? []),
    changeRecords: async (_agentId, kind, update) => {
      const out = update(structuredClone(kept.get(kind) ?? []));
      if ("records" in out) kept.set(kind, out.records.map((one) => ({ ...one, seq: one.seq ?? ++seq, at: one.at ?? 0 })));
      return out.result;
    },
  };
  const at = "2026-11-14T10:05:00.000Z";
  const first = await putGrade(rows, "agent-1", { run: "run-same-ms", correct: false, source: "feedback", at, path: "agent", feedback: null });
  const second = await putGrade(rows, "agent-1", { run: "run-same-ms", correct: true, source: "feedback", at, path: "agent", feedback: null });
  await markGradeRound(rows, "agent-1", first, { round: "correction", command: 1 });
  const [only] = await gradesOf(rows, "agent-1");
  assert.deepEqual([only.seq, only.correct, only.feedback], [second.seq, true, null], `the replacement names no round: ${JSON.stringify(only)}`);
});

// The read's `graded.workflow` is a learned workflow's name, cut as every other learning name is (`shown.name`): a secret
// registered after the run never shows in GET /runs/{id}/learning.
test("a run's learning read hides a secret in its grade's workflow name", { timeout: 120_000 }, async (t) => {
  const { server, start } = await world(t);
  const done = await start("run-secret-name", 1, { byHand: true });
  const secret = "registered-after-the-run-7781";
  await putGrade(server.learning, "agent-1", { run: done.id, correct: false, source: "feedback", at: new Date().toISOString(), path: "workflow", workflow: `answer-${secret}`, feedback: null });
  const read = await runLearningOverStore(server, done.id, secretsShown([secret]), [secret]);
  assert.ok(read?.graded, `the read says the grade: ${JSON.stringify(read)}`);
  assert.ok(!JSON.stringify(read.graded).includes(secret), `the secret is hidden: ${JSON.stringify(read.graded)}`);
  assert.equal(read.graded.workflow, "[redacted]");
});
