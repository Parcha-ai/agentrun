// The grader (learn/promote.ts gradeAnswers, runner/compare-end.ts): with no learning.agree_on, a replay run and an audit's
// shadow ask the agent's fast model once, at their end, whether their answer and the other one reach the same decision;
// the check (runner/promotion.ts decideCheck) and the audit (runner/audit.ts settleAudits) read that verdict through the
// one comparison (runner/promotion.ts checkInputOf: compareAnswers on a whole answer). An agree_on revision asks no model. A reply that is not the verdict, a failed request
// and a refusal of the run's cap all differ, in words saying so; the grader's request is the run's own spend, booked under
// its cap: a replay's is its check's cost, a shadow's the served run's learning cost.
//   (1) a check with no agree_on on differently worded answers promotes through the grader (with no fast model: held, 0 agreed);
//   (2) an agree_on revision's check sends no grader request;
//   (3) a grader reply that is not the verdict is asked once more; still not the verdict, it is unread: counted neither
//       way, and a check with fewer than READABLE_MIN readable comparisons does not decide, its hold saying so;
//   (4) the run's cap refusing the grader's request disagrees and books nothing;
//   (5) the audit compares through the grader, and its request is the served run's learning cost;
//   (6) the grader's cost is its check's replay runs' cost, the revision's check_usd;
//   (7) a person's stop while the grader's request hangs stops the replay at once, and its pair counts as differing;
//   (8) a verdict is of the two answers it read: the source run answering again after it was compared makes it stale;
//   (9) a graded source run's replay is compared with the grade's expected answer written over the agent's: the same
//       decision worded apart promotes, another decision holds with the grade's answer shown;
//   (10) a partial grade: the replay asks about the draft and the agent's answer with the grade's keys written over it,
//       never the grade's keys alone, and a draft that says that answer promotes;
//   (11) a grade given after the replays ended and before the check settled: each input is judged on what its grader
//       was asked, so the verdict is not stale;
//   (12) a draft equal to the agent's answer asks no model, and its replay still keeps the grade it was judged with;
//   (13) a run its owner corrected by message (no grade), whose recorded answer stays wrong: each replay's grader is
//       shown the correction beside that answer, and a draft that answers per the correction promotes;
//   (14) a replay repeating that wrong recorded answer word for word: the grader (the fast model, else the agent's own
//       model), asked with the correction, says it differs, its disagreement naming the owner's correction;
//   (15) an agent that answered again per the correction: a replay equal to that recorded answer is still asked with
//       the correction, and the grader's same decision promotes (only a verdict asked with the correction counts);
//   (16) a correction the checks refused was never taken, so it changes nothing.
// Plus the pieces alone: the verdict's parse, the one retry, the comparison, the check's words, the request's ends (its
// stop and its deadline among them).
// The agent's runs are real runs of the store on a pi run of the faux gateway, whose faux grader (fixtures/faux-grader.mjs)
// says two answers are the same when their JSON values match once their reasons are left out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, readmeOf, startAt, putPromotions } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { promotionsOf, putGrade, GRADER_PROMPT, graderVerdictOf, gradeAnswers, compareAnswers, answersPair, COMPARE_UNREAD, COMPARE_CAP_HELD, COMPARE_STALE } = await import("../dist/learn/promote.js");
const { answerJudged, answerOf, checkScoreOf, decideCheck, differentDecisionWords, notDecidedWords, unreadWords, NEVER_WORD_FOR_WORD } = await import("../dist/runner/promotion.js");
const { graderAsk } = await import("../dist/runner/compare-end.js");
const { check: checkFields, READABLE_MIN } = await import("../dist/learn/field-check.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { learningOf } = await import("../dist/learn/rows.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { askedForCompile } = await import("../dist/learn/compile.js");
const { secretsShown } = await import("../dist/learning.js");
const { readAudits } = await import("../dist/learn/audit.js");
const { agentCostOverStore, servingReplayOf } = await import("../dist/store-reads/learning.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** The host's fast model: the grader's (routeOf below routes every model to the faux gateway). */
const FAST = { AGENT_MODEL_FAST: "anthropic/claude-haiku-5-5" };
/** The agent's answer as a model writes it: prose, then a json fence with its reason. The workflow says the same
 *  decision as bare JSON, {"answer":42,"sure":true}: equal neither byte for byte nor as JSON values. */
const AGENT_PROSE = `Six times seven is 42, and I am sure of it.\n\n\`\`\`json\n${JSON.stringify({ answer: 42, sure: true, why: "six times seven is forty-two" })}\n\`\`\``;
/** A follow-up that makes the agent answer 41: another decision than the workflow's 42. */
const SAY_41 = "Count again: the answer is 41.";
const AGENT_41 = `On a second count it is 41.\n\n\`\`\`json\n${JSON.stringify({ answer: 41, sure: true, why: "counted again" })}\n\`\`\``;

/** The audit's draw (learn/audit.ts auditDrawn): a run id the default 1 in 10 never draws keeps its shadow out of a check. */
const drawn = (runId, k) => Number.parseInt(createHash("sha256").update(`audit:${runId}`).digest("hex").slice(0, 8), 16) % k === 0;
const undrawn = (prefix) => Array.from({ length: 50 }, (_, i) => `${prefix}-${i}`).filter((id) => !drawn(id, 10));

const answerFlow = (how = "Answer the question; say whether you are sure.") => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: how, out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
});
const REVISED = "Answer the question exactly; say whether you are sure.";
const FIRST = answerFlow();
const DIGEST = workflowDigest({ workflow: JSON.stringify(FIRST) });
const DIGEST_2 = workflowDigest({ workflow: JSON.stringify(answerFlow(REVISED)) });

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => (part?.type === "text" ? part.text : "")).join(""));
const compiling = (body) => askedForCompile(textOf((body?.messages ?? []).findLast((message) => message.role === "user"))) !== false;
/** A grader request: its system text is the grader's instructions. Only these are counted. */
const isGrader = (body) => JSON.stringify(body ?? null).includes(JSON.stringify(GRADER_PROMPT.split("\n")[0]).slice(1, -1));
/** A compile answer whose draft fails its dry run: no draft of the faux model lands, so the test lands each revision. */
const BROKEN_DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"question":"What is six times seven?"}\n---\n${JSON.stringify({ ...FIRST, root: { node: "chain", steps: [{ ...FIRST.root.steps[0], as: "other" }] } })}\n\`\`\`\``;

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const FINAL = ["ended", "failed", "stopped"];

/** An agent of `learning` with `prior` runs of its own ("Question 0" …), each answered AGENT_PROSE, the learned workflow
 *  `answer` landed and promoted, and a runner claiming every run from its stored launch on `env`. `grader(request)`: the
 *  grader's reply instead of the faux grader's; `priced(model, usage)`: each request's cost; `cap`: the cap of every run
 *  made after the prior ones; `hang(request)`: a request the gateway never answers. A follow-up that says SAY_41 is
 *  answered AGENT_41. `corrects`: the prior runs learn, and once each ended its owner sends it this message (a correction
 *  by message, no grade), which its follow-up answers with `fixed` (the agent answering again per it), else `says` again.
 *  `submits`: what the workflow's node submits. */
async function world(t, { learning, prior = 0, env = FAST, grader, priced, cap, hang, says = AGENT_PROSE, corrects, fixed, submits = { answer: 42, sure: true } } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-grader-compare-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submits } } : undefined),
    text: ({ body }) => {
      if (offers(body, "submit")) return "submitted";
      if (compiling(body)) return BROKEN_DRAFT;
      const last = textOf((body?.messages ?? []).findLast((m) => m.role === "user"));
      return last.includes(SAY_41) ? AGENT_41 : fixed !== undefined && corrects !== undefined && last.includes(corrects) ? fixed : says;
    },
    refuse: ({ body }) => (compiling(body) && textOf((body?.messages ?? []).findLast((m) => m.role === "user")).startsWith("One more turn: revise") ? { message: "the test lands any revision itself" } : undefined),
    ...(grader ? { grader } : {}),
    ...(hang ? { hang } : {}),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Graded" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [], learning } });
  // The tier of each route the runner asked for ("default": the run's own model; "fast": the host's fast model).
  const tiers = [];
  const price = (model, usage) => (priced ? priced(model, usage) : ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6);
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async (_ask, _env, tier) => (tiers.push(tier), route), computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, learningStart, extra = {}) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learningStart ? { learning: learningStart } : {}), ...extra });
  const priorStart = corrects === undefined ? undefined : startAt((await server.learning.seed("agent-1")).save.id);
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`, priorStart) });
    await ended(`prior-${i}`);
    if (corrects === undefined) continue;
    await server.runs.reopen(`prior-${i}`, { kind: "steer", body: { text: corrects } });
    await ended(`prior-${i}`);
  }
  const seed = await landWorkflows(server, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: FIRST }]);
  await putPromotions(server, "agent-1", [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 3, agreed: 3, alone: 3, of: [] }, commit: seed }]);
  const launches = async (pick) => {
    const out = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) {
      const launch = readLaunchBody((await server.runs.launch(row.id)).body);
      if (pick(launch)) out.push({ row: await server.runs.get(row.id), launch });
    }
    return out;
  };
  const shadowOf = async (id) => (await launches((launch) => launch?.audit?.of === id))[0];
  const start = async (id, question) => {
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, startAt((await server.learning.seed("agent-1")).save.id), cap === undefined ? {} : { max_cost_usd: cap }) });
    const row = await ended(id);
    const shadow = await shadowOf(id);
    if (shadow) await ended(shadow.row.id);
    return row;
  };
  const replaysEnded = (count, ms = 120_000) => until(async () => {
    const all = (await launches((launch) => launch?.replay)).map(({ row }) => row);
    return all.length === count && all.every((row) => FINAL.includes(row.state) && row.runner === null) && all;
  }, `the ${count} replay runs ended`, ms);
  const replays = async () => launches((launch) => launch?.replay);
  const audits = () => readAudits(server.learning, "agent-1");
  const graderRequests = () => gw.requests.filter((request) => isGrader(request.body));
  return { dir, server, gw, start, ended, replays, replaysEnded, shadowOf, audits, graderRequests, tiers };
}

/** Lands `workflow` as the next revision of `answer` on the agent's learning. */
async function landRevision(store, workflow, runId) {
  const merged = await learningCommit(learningOf(store, "agent-1"), {
    runId, reason: "revised answer",
    files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(workflow) }, { path: "workflows/answer/README.md", text: readmeOf("answer", "Answers a question as a number") }],
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
}

/** Lands the revision and runs its check to its decision: the claim that starts the check, its 3 replays, and the claim
 *  after them, which decides it. The revision's newest record. */
async function checked(w, ids) {
  await landRevision(w.server, answerFlow(REVISED), ids[0]);
  await w.start(ids[0], "Question 10");
  const replays = await w.replaysEnded(3);
  await w.start(ids[1], "Question 11");
  const record = (await promotionsOf(w.server.learning, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  return { record, replays };
}

test("(1) no agree_on: the check's answers, worded apart, agree through the fast model and it promotes; with no fast model the agent's own model compares them, one request per replay, and it promotes, saying so", { timeout: 300_000 }, async (t) => {
  const ids = undrawn("one");
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
  const { record } = await checked(w, ids);
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual([record.check.n, record.check.alone, record.check.agreed, record.check.grader], [3, 3, 3, MODEL], JSON.stringify(record.check));
  assert.match(record.reason, /compared by the fast model \(claude-sonnet-5-5\)/);
  assert.equal(w.graderRequests().length, 3, "one grader request per replay");
  assert.ok(w.tiers.includes("fast"), "the grader on the fast tier");

  const ids2 = undrawn("own");
  const own = await world(t, { learning: { compile_after: 3 }, prior: 3, env: {} });
  const promoted = (await checked(own, ids2)).record;
  assert.equal(promoted.decided, "promote", promoted.reason);
  assert.deepEqual([promoted.check.n, promoted.check.alone, promoted.check.agreed, promoted.check.grader], [3, 3, 3, MODEL], JSON.stringify(promoted.check));
  assert.match(promoted.reason, /compared by the agent's own model \(claude-sonnet-5-5; no fast model is set\)/);
  assert.ok(!promoted.reason.includes(NEVER_WORD_FOR_WORD), promoted.reason);
  assert.equal(own.graderRequests().length, 3, "no fast model: one request per replay, on the agent's own model");
  assert.ok(!own.tiers.includes("fast"), `no fast tier is routed: ${own.tiers}`);
});

test("(1b) no agree_on and no fast model: a replay whose answer is another decision than the agent's is held by the agent's own model, each disagreement in its words", { timeout: 300_000 }, async (t) => {
  // The agent answered 41 on each input; the workflow answers 42.
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, env: {}, says: AGENT_41 });
  const { record } = await checked(w, undrawn("own-wrong"));
  assert.equal(record.decided, "hold", record.reason);
  assert.deepEqual([record.check.agreed, record.check.grader], [0, MODEL], JSON.stringify(record.check));
  assert.equal(record.check.disagreements.length, 3);
  assert.match(record.reason, /its answers reached a different decision from the agent's on 3 of 3/);
  assert.match(record.reason, /compared by the agent's own model \(claude-sonnet-5-5; no fast model is set\)/);
  assert.ok(!record.reason.includes(NEVER_WORD_FOR_WORD), record.reason);
  assert.equal(w.graderRequests().length, 3, "one request per replay");
});

test("(2) an agree_on revision's check compares on its fields and sends no grader request", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3, agree_on: ["answer", "sure"] }, prior: 3 });
  const { record } = await checked(w, undrawn("on"));
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual([record.check.agreed, record.check.agree_on, record.check.grader], [3, ["answer", "sure"], undefined]);
  assert.equal(w.graderRequests().length, 0);
});

test("(3) a grader reply that is not the verdict is asked once more, then unread: counted neither way, and with fewer than 2 readable comparisons the check does not decide, its hold saying so", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, grader: () => "They look the same to me." });
  const { record } = await checked(w, undrawn("unread"));
  assert.equal(record.decided, "hold", record.reason);
  assert.deepEqual([record.check.agreed, record.check.grader, record.check.unread, record.check.undecided], [0, MODEL, 3, true]);
  // An unread comparison is no disagreement: none is listed, and the hold never says the workflow decided otherwise.
  assert.equal(record.check.disagreements, undefined, JSON.stringify(record.check.disagreements));
  assert.doesNotMatch(record.reason, /reached a different decision/);
  assert.ok(record.reason.includes(notDecidedWords(0, 3, 3)), record.reason);
  assert.ok(record.reason.includes(unreadWords(3)), record.reason);
  assert.equal(w.graderRequests().length, 6, "a reply that is no verdict is asked once more: two requests per replay");
});

test("(4) the run's cap refusing the grader's request disagrees and books nothing: the request never leaves", { timeout: 300_000 }, async (t) => {
  // Every request costs $0.99 under a $1 cap: a replay's node is admitted, its grader's request then is not.
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, priced: () => 0.99, cap: 1 });
  const { record, replays } = await checked(w, undrawn("cap"));
  assert.equal(record.decided, "hold", record.reason);
  assert.equal(record.check.agreed, 0);
  for (const one of record.check.disagreements) assert.equal(one.differs_on, COMPARE_CAP_HELD);
  assert.equal(w.graderRequests().length, 0, "no grader request reached the model");
  for (const row of replays) assert.equal(row.costUsd, 0.99, `${row.id}: the node's request alone is booked`);
});

test("(5) the audit compares through the grader: the shadow's worded-apart answer agrees, and its grader request is the served run's learning cost", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { audit_every: 1 } });
  const served = await w.start("served-1", "What is six times seven");
  assert.equal(served.metrics?.path, "workflow");
  const shadow = (await w.shadowOf("served-1")).row;
  assert.equal(w.graderRequests().length, 1, "the shadow's one grader request");
  const { pair, ...verdict } = shadow.metrics?.audit?.compared ?? {};
  assert.deepEqual(verdict, { same: true, grader: MODEL });
  assert.match(pair ?? "", /^[0-9a-f]{64}$/, "the verdict names the two answers it read");
  await w.start("served-2", "What is seven times six");
  const row = (await w.audits()).find((one) => one.run === "served-1");
  assert.equal(row?.agreed, true, JSON.stringify(row));
  // Each request costs (10 x $3 + 2 x $15) / 1M: the shadow's answer and its grader request.
  const each = (10 * 3 + 2 * 15) / 1e6;
  assert.ok(Math.abs(shadow.costUsd - 2 * each) < 1e-12, `the shadow's cost holds its grader request: ${shadow.costUsd}`);
  const one = (await agentCostOverStore(w.server, "agent-1")).runs.find((each) => each.run_id === "served-1");
  assert.ok(Math.abs(one.learning_usd - shadow.costUsd) < 1e-9, JSON.stringify(one));
});

test("(6) the grader's requests are its check's cost: each replay books its node and its grader request, the revision's check_usd", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
  const { replays } = await checked(w, undrawn("cost"));
  const each = (10 * 3 + 2 * 15) / 1e6;
  for (const row of replays) assert.ok(Math.abs(row.costUsd - 2 * each) < 1e-12, `${row.id}: ${row.costUsd}`);
  const cost = await agentCostOverStore(w.server, "agent-1");
  const revision = (cost.bill?.revisions ?? cost.revisions).find((one) => one.digest === DIGEST_2);
  assert.ok(Math.abs(revision.check_usd - 3 * 2 * each) < 1e-9, JSON.stringify(revision));
});

// The replay's job ended before its grader is asked (its look-back), and that end is kept: a stop cuts the look-back
// only, so the replay ends with its job's end, never stopped.
test("(7) a person's stop while each replay's grader request hangs: every replay ends at once with its job's end, keeps no verdict, and its pair counts as differing", { timeout: 300_000 }, async (t) => {
  const ids = undrawn("stop");
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, hang: (request) => isGrader(request.body) });
  await landRevision(w.server, answerFlow(REVISED), ids[0]);
  await w.start(ids[0], "Question 10");
  await until(() => w.graderRequests().length === 3, "each replay's grader request is in flight", 120_000);
  for (const { row } of await w.replays()) await w.server.command(row.id, { kind: "stop" });
  // A stop never waits on the grader: well inside the 60 s a hung request would hold it, and the gateway never answers.
  const stopped = await w.replaysEnded(3, 20_000);
  for (const row of stopped) {
    assert.equal(row.state, "ended", `${row.id}: ${row.summary}`);
    assert.equal(row.metrics?.replay?.compared, undefined, `${row.id} keeps no verdict`);
  }
  await w.start(ids[1], "Question 11");
  const record = (await promotionsOf(w.server.learning, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  assert.equal(record.decided, "hold", record.reason);
  assert.equal(record.check.agreed, 0, JSON.stringify(record.check));
});

test("(8) a verdict is of the two answers it read: the source run answers 41 after its replay was compared, and the check never counts the old 'same'", { timeout: 300_000 }, async (t) => {
  const ids = undrawn("stale");
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
  await landRevision(w.server, answerFlow(REVISED), ids[0]);
  await w.start(ids[0], "Question 10");
  const replays = await w.replaysEnded(3);
  for (const row of replays) assert.equal(row.metrics?.replay?.compared?.same, true, `${row.id}: ${JSON.stringify(row.metrics?.replay)}`);
  // A person follows up on one replay's source run, and it answers again, with another decision.
  const source = (await w.replays())[0].launch.replay.of;
  await w.server.runs.reopen(source, { kind: "steer", body: { text: SAY_41 } });
  await w.ended(source);
  await w.start(ids[1], "Question 11");
  const record = (await promotionsOf(w.server.learning, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  assert.equal(record.check.agreed, 2, JSON.stringify(record.check));
  assert.equal(record.decided, "hold", record.reason);
  const differs = record.check.disagreements.find((one) => one.run === source);
  assert.ok(differs, JSON.stringify(record.check.disagreements));
  assert.equal(differs.differs_on, COMPARE_STALE);
  assert.match(differs.agent ?? "", /41/, "the disagreement shows the source's newest answer");
});

test("(9) a graded source run: its replay asks the fast model about the draft and the grade's expected answer, not the agent's; the same decision promotes, another holds, the expected answer shown whole", { timeout: 300_000 }, async (t) => {
  const graded = async (prefix, expected) => {
    const ids = undrawn(prefix);
    const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
    for (let i = 0; i < 3; i++) await putGrade(w.server.learning, "agent-1", { run: `prior-${i}`, correct: false, expected, source: "eval", at: new Date().toISOString(), path: "agent" });
    const { record } = await checked(w, ids);
    const users = w.graderRequests().map((request) => JSON.stringify(request.body));
    return { record, users };
  };
  // The agent said 42 (graded wrong); the expected answer says 42 too, with its own reason: the same decision, worded apart.
  const same = { answer: 42, sure: true, why: "checked by hand" };
  const promoted = await graded("expected-same", same);
  assert.equal(promoted.record.decided, "promote", promoted.record.reason);
  assert.deepEqual(promoted.record.check.fields.answer.by, { grade: { n: 3, workflow_right: 3, agent_right: 0 } });
  assert.equal(promoted.users.length, 3, "one grader request per replay");
  assert.ok(promoted.users.every((one) => one.includes("checked by hand") && !one.includes("six times seven is forty-two")), "each compares the draft with the expected answer, never the agent's");

  const other = { answer: 41, sure: true };
  const held = await graded("expected-other", other);
  assert.equal(held.record.decided, "hold", held.record.reason);
  assert.deepEqual(Object.keys(held.record.check.fields), ["answer"]);
  assert.deepEqual(held.record.check.disagreements.map((one) => one.expected), Array.from({ length: 3 }, () => [{ field: "answer", known: "grade", value: JSON.stringify(other) }]));
});

test("(10) a partial grade ({answer: 42} of the agent's {answer, sure, why}): each replay asks the fast model about the draft and the agent's answer with the grade's keys written over it; the draft {answer: 42, sure: true} says that decision and promotes", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
  for (let i = 0; i < 3; i++) await putGrade(w.server.learning, "agent-1", { run: `prior-${i}`, correct: true, expected: { answer: 42 }, source: "eval", at: new Date().toISOString(), path: "agent" });
  const { record } = await checked(w, undrawn("expected-partial"));
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual(record.check.fields.answer.by, { grade: { n: 3, workflow_right: 3, agent_right: 3 } });
  const corrected = JSON.stringify({ answer: 42, sure: true, why: "six times seven is forty-two" });
  const users = w.graderRequests().map((request) => JSON.stringify(request.body));
  assert.equal(users.length, 3, "one grader request per replay");
  assert.ok(users.every((one) => one.includes(JSON.stringify(`The known answer:\n<<<\n${corrected}\n>>>`).slice(1, -1))), `each asks against the corrected answer: ${users[0]}`);
});

test("(11) a grade given between the replays' end and the check's settle: each input is judged on what its fast model was asked (no grade then), so the verdict stands and the revision promotes; the grade counts from the next check", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
  const ids = undrawn("graded-late");
  await landRevision(w.server, answerFlow(REVISED), ids[0]);
  await w.start(ids[0], "Question 10");
  const replays = await w.replaysEnded(3);
  for (const row of replays) assert.equal(row.metrics?.replay?.compared?.graded, null, `${row.id}: its verdict says no grade was there when it was asked`);
  for (let i = 0; i < 3; i++) await putGrade(w.server.learning, "agent-1", { run: `prior-${i}`, correct: false, expected: { answer: 41 }, source: "eval", at: new Date().toISOString(), path: "agent" });
  await w.start(ids[1], "Question 11");
  const record = (await promotionsOf(w.server.learning, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual(record.check.fields.answer.by, { agent: { n: 3, workflow_right: 3, agent_right: 3 } });
  assert.ok(!record.reason.includes(COMPARE_STALE), record.reason);
});

test("(12) a draft equal to the agent's answer, no grade when its replays ended, then a correction before the settle: each replay keeps that it was judged with no grade (no model asked), and the check promotes on that; the correction counts from the next check", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, says: JSON.stringify({ answer: 42, sure: true }) });
  const ids = undrawn("equal-late");
  await landRevision(w.server, answerFlow(REVISED), ids[0]);
  await w.start(ids[0], "Question 10");
  const replays = await w.replaysEnded(3);
  for (const row of replays) assert.equal(row.metrics?.replay?.compared?.graded, null, `${row.id}: its record says it was judged with no grade`);
  assert.equal(w.graderRequests().length, 0, "equal answers: no model asked");
  for (let i = 0; i < 3; i++) await putGrade(w.server.learning, "agent-1", { run: `prior-${i}`, correct: false, expected: { answer: 41 }, source: "eval", at: new Date().toISOString(), path: "agent" });
  await w.start(ids[1], "Question 11");
  const record = (await promotionsOf(w.server.learning, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual(record.check.fields.answer.by, { agent: { n: 3, workflow_right: 3, agent_right: 3 } });
});

/** The owner's correction by message: their words, no grade. The agent's follow-up answers 42 again (it is not SAY_41). */
const CORRECTION = "That is wrong: in this job six times seven counts as 41, so the answer is 41.";
/** Every string in a request body, depth first. */
const stringsIn = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : value && typeof value === "object" ? Object.values(value).flatMap(stringsIn) : []);
/** A stand-in grader: the same decision only when it was shown the owner's correction and the workflow's answer says 41. */
const correctionGrader = (request) => {
  const user = stringsIn(request.body).find((one) => one.includes("The workflow's answer:\n<<<")) ?? "";
  const draft = /The workflow's answer:\n<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? "";
  let says;
  try {
    says = JSON.parse(draft).answer;
  } catch {
    says = undefined;
  }
  const same = user.includes(CORRECTION) && says === 41;
  return JSON.stringify({ same, differs_on: same ? null : "the answer" });
};
/** Each prior run's newest round kept: its correction by message merged into corrections.md, one line (what the bug's
 *  walk saw), or dropped by the checks. */
const correctedPriors = async (w, state) => {
  for (let i = 0; i < 3; i++) {
    const kept = await w.server.learning.proposal(`prior-${i}`);
    assert.equal(kept?.round, 2, `prior-${i}: its follow-up's round`);
    assert.equal(kept.proposal.state, state, JSON.stringify(kept.proposal));
    if (state === "merged") assert.equal(kept.proposal.corrections, 1, JSON.stringify(kept.proposal));
  }
};

test("(13) a run corrected by message (no grade) whose recorded answer stays wrong: each replay asks the fast model with the owner's correction beside the recorded answer, so a draft that answers per the correction promotes", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, corrects: CORRECTION, submits: { answer: 41, sure: true }, grader: correctionGrader });
  await correctedPriors(w, "merged");
  const { record, replays } = await checked(w, undrawn("corrected"));
  assert.equal(record.decided, "promote", record.reason);
  for (const row of replays) assert.equal(row.metrics?.replay?.compared?.corrected, CORRECTION, `${row.id}: its verdict keeps the correction it was asked against`);
  assert.deepEqual(record.check.fields.answer.by, { grade: { n: 3, workflow_right: 3, agent_right: 0 } }, "the agent's recorded answer is known wrong");
  const users = w.graderRequests().map((request) => JSON.stringify(request.body));
  assert.equal(users.length, 3, "one grader request per replay");
  assert.ok(users.every((one) => one.includes(CORRECTION)), `each is shown the correction: ${users[0]}`);
});

test("(14) a replay repeating the corrected run's wrong recorded answer word for word: the fast model is asked with the correction (no equal-answer shortcut) and, judging per it, says they differ: held; with no fast model the agent's own model is asked the same and holds it the same", { timeout: 300_000 }, async (t) => {
  const says = JSON.stringify({ answer: 42, sure: true });
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, says, corrects: CORRECTION, grader: correctionGrader });
  await correctedPriors(w, "merged");
  const { record } = await checked(w, undrawn("repeats"));
  assert.equal(record.decided, "hold", record.reason);
  assert.equal(record.check.agreed, 0, JSON.stringify(record.check));
  assert.deepEqual(record.check.fields.answer.by, { grade: { n: 3, workflow_right: 0, agent_right: 0 } });
  assert.equal(w.graderRequests().length, 3, "equal answers still ask the fast model: only a verdict asked with the correction counts");
  assert.ok(w.graderRequests().every((request) => JSON.stringify(request.body).includes(CORRECTION)), "each is asked with the correction");
  assert.deepEqual(record.check.disagreements.map((one) => one.expected), Array.from({ length: 3 }, () => [{ field: "answer", known: "correction", value: CORRECTION }]));

  // No fast model: the agent's own model is the grader, asked with the correction the same way.
  const own = await world(t, { learning: { compile_after: 3 }, prior: 3, env: {}, says, corrects: CORRECTION, grader: correctionGrader });
  await correctedPriors(own, "merged");
  const held = (await checked(own, undrawn("repeats-own"))).record;
  assert.equal(held.decided, "hold", held.reason);
  assert.equal(held.check.agreed, 0, JSON.stringify(held.check));
  assert.deepEqual(held.check.fields.answer.by, { grade: { n: 3, workflow_right: 0, agent_right: 0 } });
  assert.equal(own.graderRequests().length, 3, "no fast model: one request per replay, on the agent's own model");
  assert.ok(own.graderRequests().every((request) => JSON.stringify(request.body).includes(CORRECTION)), "each is asked with the correction");
  assert.match(held.reason, /compared by the agent's own model \(claude-sonnet-5-5; no fast model is set\)/);
  assert.deepEqual(held.check.disagreements.map((one) => one.expected), Array.from({ length: 3 }, () => [{ field: "answer", known: "correction", value: CORRECTION }]));
});

test("(15) an agent that answered again per its owner's correction: a replay equal to that recorded answer is still asked with the correction (no equal-answer shortcut), the verdict says the same decision, and it promotes", { timeout: 300_000 }, async (t) => {
  const fixed = JSON.stringify({ answer: 41, sure: true });
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, corrects: CORRECTION, fixed, submits: { answer: 41, sure: true }, grader: correctionGrader });
  await correctedPriors(w, "merged");
  for (let i = 0; i < 3; i++) assert.equal(await answerOf(w.server, `prior-${i}`, ctx), fixed, `prior-${i}: its recorded answer is its follow-up's, per the correction`);
  const { record, replays } = await checked(w, undrawn("re-answered"));
  assert.equal(record.decided, "promote", record.reason);
  assert.equal(record.check.agreed, 3, JSON.stringify(record.check));
  assert.deepEqual(record.check.fields.answer.by, { grade: { n: 3, workflow_right: 3, agent_right: 0 } }, "the verdict counts, equal answers or not; the agent's answer is still counted as corrected");
  for (const row of replays) {
    assert.equal(row.metrics?.replay?.compared?.corrected, CORRECTION, `${row.id}: its verdict keeps the correction it was asked against`);
    assert.equal(row.metrics?.replay?.compared?.same, true, `${row.id}: the same decision`);
  }
  assert.equal(w.graderRequests().length, 3, "equal answers still ask the fast model");
});

test("(16) a correction the checks refused (a hidden character) was never taken: it changes nothing, and a draft equal to the recorded answer promotes on the agent's answer with no model asked", { timeout: 300_000 }, async (t) => {
  const says = JSON.stringify({ answer: 42, sure: true });
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, says, corrects: "The answer is 41.‮", grader: correctionGrader });
  await correctedPriors(w, "dropped");
  const { record } = await checked(w, undrawn("refused"));
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual(record.check.fields.answer.by, { agent: { n: 3, workflow_right: 3, agent_right: 3 } });
  assert.equal(w.graderRequests().length, 0, "equal answers: no model asked");
});

test("the grader's verdict: one JSON object, bare or the whole of one fence; anything else is none", () => {
  assert.deepEqual(graderVerdictOf('{"same": true, "differs_on": null}'), { same: true, differs_on: null });
  assert.deepEqual(graderVerdictOf('```json\n{"same": false, "differs_on": " the code "}\n```'), { same: false, differs_on: "the code" });
  assert.deepEqual(graderVerdictOf('{"same": false}'), { same: false, differs_on: null });
  assert.deepEqual(graderVerdictOf('```\n{"same": true}\n```'), { same: true, differs_on: null }, "an unlabelled whole fence");
  assert.deepEqual(graderVerdictOf('  ```json\r\n{"same": true, "differs_on": null}\r\n```  '), { same: true, differs_on: null }, "a json-labelled whole fence, padded");
  assert.equal(graderVerdictOf('```json\n{"same": false}\n```\n```json\n{"same": true}\n```'), undefined, "two verdicts: none, never the last");
  assert.equal(graderVerdictOf('Sure:\n```json\n{"same": true}\n```'), undefined, "prose around a fence");
  for (const text of ["same", '{"same": "yes"}', '{"same": true, "differs_on": 3}', 'Sure: {"same": true}', "[true]"]) assert.equal(graderVerdictOf(text), undefined, text);
});

test("gradeAnswers asks once more on a transport failure or a reply that is not the verdict; a refusal differs; two failures, a cut request and two non-verdicts are unread, in words", async () => {
  const graderOf = (replies) => {
    const asked = [];
    return { asked, grader: { model: "fast-1", ask: async (request) => (asked.push(request), replies.shift()) } };
  };
  // Every verdict names the two answers it read (agent "a", workflow "b").
  const pair = answersPair("a", "b");
  const once = graderOf([{ failed: "socket hang up" }, { text: '{"same": true, "differs_on": null}' }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", once.grader), { same: true, grader: "fast-1", pair });
  assert.equal(once.asked.length, 2);
  assert.equal(once.asked[0].system, GRADER_PROMPT);
  // The first answer is the known one: the agent's own, or a grade's correction of it (compare-end.ts).
  assert.match(GRADER_PROMPT, /^You compare two answers to the same job input: the known answer and a learned workflow's answer\./);
  assert.match(once.asked[0].user, /The job input:\n<<<\nin\n>>>\n\nThe known answer:\n<<<\na\n>>>\n\nThe workflow's answer:\n<<<\nb\n>>>/);
  const twice = graderOf([{ failed: "socket hang up" }, { failed: "socket hang up" }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", twice.grader), { same: false, unread: true, grader: "fast-1", pair, differs_on: `${COMPARE_UNREAD}: its request failed twice` });
  const refused = graderOf([{ refused: "spend_cap_reached" }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", refused.grader), { same: false, grader: "fast-1", pair, differs_on: COMPARE_CAP_HELD });
  assert.equal(refused.asked.length, 1, "a refusal is not asked again");
  const cut = graderOf([{ cut: "its request was stopped with the run" }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", cut.grader), { same: false, unread: true, grader: "fast-1", pair, differs_on: `${COMPARE_UNREAD}: its request was stopped with the run` });
  assert.equal(cut.asked.length, 1, "a stopped or timed-out request is not asked again");
  // A reply that is not the verdict is asked once more: a verdict then is the verdict; two such replies are unread
  // (counted neither way by the check), never a disagreement.
  const proseOnce = graderOf([{ text: "same" }, { text: '{"same": true, "differs_on": null}' }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", proseOnce.grader), { same: true, grader: "fast-1", pair });
  assert.equal(proseOnce.asked.length, 2, "a reply that is not the verdict is asked once more");
  const prose = graderOf([{ text: "same" }, { text: "They look the same to me." }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", prose.grader), { same: false, unread: true, grader: "fast-1", pair, differs_on: `${COMPARE_UNREAD}: its reply was not the verdict asked for, twice` });
  assert.equal(prose.asked.length, 2, "asked twice at most");
  const failedThenProse = graderOf([{ failed: "socket hang up" }, { text: "same" }]);
  assert.equal((await gradeAnswers("in", "a", "b", failedThenProse.grader)).unread, true);
  assert.equal(failedThenProse.asked.length, 2, "one more request in all, whatever the first one's end");
  const differ = graderOf([{ text: '{"same": false, "differs_on": "mcc"}' }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", differ.grader), { same: false, grader: "fast-1", pair, differs_on: "mcc" });
  const unnamed = graderOf([{ text: '{"same": false, "differs_on": null}' }]);
  assert.equal((await gradeAnswers("in", "a", "b", unnamed.grader)).differs_on, "a decision it did not name");
});

test("the one comparison: agree_on's fields decide alone; compareAnswers: equal answers agree with no verdict; else the grader's verdict on that same pair, else differ", () => {
  const verdict = { same: true, grader: "fast-1", pair: answersPair('{"a":2}', '{"a":1}') };
  assert.equal(answerJudged({ agent: '{"a":1,"b":3}', answer: '{"a":1,"b":2}', compared: { same: false, grader: "fast-1", differs_on: "a" } }, ["a"]), true, "under agree_on the fields decide, never a verdict");
  assert.deepEqual(compareAnswers('{"a":1}', '```json\n{"a":1}\n```'), { same: true });
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}', verdict), verdict);
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}'), { same: false });
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}', { same: true }), { same: false }, "a verdict no grader gave is none");
  assert.deepEqual(compareAnswers(null, '{"a":1}', verdict), { same: false });
  // A verdict on another pair (one of the answers changed since it was read), or naming none, is stale: they differ.
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":3}', verdict), { same: false, grader: "fast-1", differs_on: COMPARE_STALE });
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}', { same: true, grader: "fast-1" }), { same: false, grader: "fast-1", differs_on: COMPARE_STALE });
  assert.notEqual(answersPair("a", "b"), answersPair("ab", ""), "the pair's two answers never run together");
});

test("a known answer its owner corrected: only a verdict asked with the correction counts, equal answers or not; the field is known from the owner, the agent's answer wrong", async () => {
  const [agent, draft, words] = ['{"a":1}', '{"a":2}', "It is 2, not 1."];
  const asked = { same: true, grader: "fast-1", pair: answersPair(draft, agent), corrected: words };
  assert.deepEqual(compareAnswers(agent, agent, undefined, true), { same: false }, "equal answers, no verdict: they differ");
  assert.deepEqual(compareAnswers(draft, agent, asked, true), asked);
  const { corrected: _, ...unasked } = asked;
  assert.deepEqual(compareAnswers(draft, agent, unasked, true), { same: false }, "a verdict asked without the correction is none");
  assert.deepEqual(compareAnswers(agent, agent, { ...asked, pair: answersPair(agent, agent) }, true), { ...asked, pair: answersPair(agent, agent) }, "equal answers: the verdict asked with the correction decides");
  // The check's own judging (checkInputOf, through answerJudged): with no verdict asked with the correction the input is
  // unjudged, neither right nor wrong (the words may be a question or thanks); with one, it decides.
  assert.equal(answerJudged({ agent, answer: agent, corrected: words }, undefined), null, "equal answers, no verdict: unjudged");
  assert.equal(answerJudged({ agent, answer: draft, corrected: words, compared: unasked }, undefined), null, "a verdict asked without the correction: unjudged");
  assert.equal(answerJudged({ agent, answer: draft, corrected: words, compared: asked }, undefined), true);
  assert.equal(answerJudged({ agent, answer: agent, corrected: words, compared: { same: false, grader: "fast-1", pair: answersPair(agent, agent), corrected: words } }, undefined), false, "the verdict, asked with it, says they differ");
  // Judged field by field: right only as the verdict says, equal to the agent's answer or not; the agent's own wrong.
  const field = (workflow, agrees) => ({ input_id: "r", outcome: "answered", fields: { answer: { workflow, agent: { a: 1 }, agrees, agent_correct: false, correction: words } } });
  const verdict = checkFields([field({ a: 2 }, true), field({ a: 1 }, true), field({ a: 1 }, false), field({ a: 3 }, undefined)], { agree_min: 0.8, alone_min: 0.7 });
  assert.deepEqual(verdict.fields.answer.by, { grade: { n: 4, workflow_right: 2, agent_right: 0 } });
  assert.deepEqual(verdict.misses.map((one) => [one.known, one.expected]), [["correction", words], ["correction", words]]);
  // The grader is told the correction wins, and reads it fenced as data beside the known answer.
  assert.match(GRADER_PROMPT, /the correction wins where the two differ/);
  const users = [];
  await gradeAnswers("q", agent, draft, { model: "fast-1", ask: async (request) => (users.push(request.user), { text: '{"same": true}' }) }, words);
  assert.ok(users[0].includes(`The known answer:\n<<<\n${agent}\n>>>\n\nThe owner's correction of the known answer:\n<<<\n${words}\n>>>`), users[0]);
});

test("correctionOf: each round's merged correction, oldest first, the oldest dropped past corrections.md's cap all told; a dropped or refused round keeps none", async () => {
  const { correctionOf } = await import("../dist/runner/promotion.js");
  const { CORRECTIONS_CAP, correctionLine } = await import("../dist/learn/corrections.js");
  const of = (rows) => ({ learning: { proposal: async (_runId, round) => { const row = round === undefined ? rows.at(-1) : rows[round - 1]; return row ? { round: round ?? rows.length, proposal: row } : undefined; } } });
  const merged = (correction) => ({ state: "merged", corrections: 1, correction });
  assert.equal(await correctionOf(of([]), "r"), undefined);
  assert.equal(await correctionOf(of([merged("It is 2."), { state: "dropped", reason: "checker" }, merged(" Not 3 either. ")]), "r"), "It is 2.\nNot 3 either.");
  assert.equal(await correctionOf(of([{ state: "merged", correction: "words with no corrections count" }]), "r"), undefined, "merged with no correction kept: none");
  const big = "x".repeat(CORRECTIONS_CAP / 2);
  const words = await correctionOf(of([merged(`a${big}`), merged(`b${big}`), merged("newest")]), "r");
  assert.equal(words, `b${big}\nnewest`, "the oldest round dropped to fit the cap");
  assert.ok(Buffer.byteLength(words) <= CORRECTIONS_CAP);
  // The merge measured the words with their whitespace folded (correctionLine): read back the same way, a message whose
  // raw text is past the cap but whose folded line fit is kept, never dropped.
  const spaced = `It is${" \n".repeat(200)}${"z".repeat(CORRECTIONS_CAP - 100)}`;
  assert.ok(Buffer.byteLength(spaced) > CORRECTIONS_CAP && Buffer.byteLength(correctionLine(spaced)) <= CORRECTIONS_CAP);
  assert.equal(await correctionOf(of([merged(spaced)]), "r"), `It is ${"z".repeat(CORRECTIONS_CAP - 100)}`, "folded as merged, and kept");
  assert.equal(await correctionOf(of([merged("It  is\n 2.")]), "r"), "It is 2.");
});

/** The learning rows a promotion record is written through, in memory: one agent's records of each kind, and workflow
 *  `answer` at digest d1 (the revision a check decides on, held by the agent's learning). */
function learningRowsOf() {
  const kinds = new Map();
  let seq = 0;
  return {
    records: async (_agentId, kind) => structuredClone(kinds.get(kind) ?? []),
    changeRecords: async (_agentId, kind, update) => {
      const out = update(structuredClone(kinds.get(kind) ?? []));
      if ("records" in out) kinds.set(kind, out.records.map((one) => ({ ...one, seq: one.seq ?? ++seq, at: 0 })));
      return out.result;
    },
    versions: async () => [{ digest: "d1" }],
  };
}
async function decide(bar, compared) {
  const learning = learningRowsOf();
  const answer = '{"answer":42,"sure":true}';
  // Each verdict is of the row's own pair (gradeAnswers' `pair`).
  const rows = compared.map((one, i) => ({ of: `r-${i}`, input: `{"q":${i}}`, agent: AGENT_PROSE, outcome: "answered", answer, ...(one ? { compared: { ...one, pair: answersPair(AGENT_PROSE, answer) } } : {}) }));
  const read = { rows, cost: 0, outcomes: { answered: rows.length, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 };
  const deps = { store: { learning }, agentId: "a", runId: "now", revisionId: "rev", launch: {}, context: ctx, log: () => {}, shown: async () => secretsShown([]) };
  return (await decideCheck(deps, "answer", "d1", { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1, ...bar }, read, () => true, {})).record;
}

test("with no agree_on the grader's verdicts judge the whole answer's field: promoted on 3 of 3, held on 1 of 3 with each disagreement's decision; none and never equal is the hint; agree_on decides alone", async () => {
  const same = { same: true, grader: "fast-1" };
  const differ = { same: false, grader: "fast-1", differs_on: "the answer's number" };
  const numbers = (record) => Object.entries(record.check.fields).map(([name, one]) => [name, one.workflow_right, one.n, one.known, one.pass]);
  const promoted = await decide({}, [same, same, same]);
  assert.deepEqual([promoted.decided, promoted.check.grader, numbers(promoted)], ["promote", "fast-1", [["answer", 3, 3, "agent", true]]]);
  const held = await decide({}, [same, differ, differ]);
  assert.deepEqual([held.decided, numbers(held)], ["hold", [["answer", 1, 3, "agent", false]]]);
  assert.deepEqual(held.check.disagreements.map((one) => [one.differs_on, one.fields]), [["the answer's number", ["answer"]], ["the answer's number", ["answer"]]]);
  assert.ok(held.reason.includes(differentDecisionWords(2, 3, "the answer's number")), held.reason);
  assert.ok(!held.reason.includes(NEVER_WORD_FOR_WORD), "a grader ran: no hint");
  const whole = await decide({}, [undefined, undefined, undefined]);
  assert.deepEqual([whole.decided, whole.check.grader, numbers(whole)], ["hold", undefined, [["answer", 0, 3, "agent", false]]]);
  assert.ok(whole.reason.includes(NEVER_WORD_FOR_WORD), whole.reason);
  const on = await decide({ agree_on: ["answer"] }, [differ, differ, differ]);
  assert.deepEqual([on.decided, on.check.grader, numbers(on)], ["promote", undefined, [["answer", 3, 3, "agent", true]]], "agree_on decides alone");
});

test("an unread comparison counts neither way: promoted on 2 of 2 readable, held on 1 of 2 naming the unread one, and under READABLE_MIN readable the check does not decide", async () => {
  const same = { same: true, grader: "fast-1" };
  const differ = { same: false, grader: "fast-1", differs_on: "the answer's number" };
  const unread = { same: false, unread: true, grader: "fast-1", differs_on: `${COMPARE_UNREAD}: its reply was not the verdict asked for, twice` };
  const numbers = (record) => Object.entries(record.check.fields).map(([name, one]) => [name, one.workflow_right, one.n, one.unread ?? 0, one.pass]);
  assert.equal(READABLE_MIN, 2);
  const promoted = await decide({}, [same, same, unread]);
  assert.deepEqual([promoted.decided, numbers(promoted), promoted.check.unread, promoted.check.undecided], ["promote", [["answer", 2, 2, 1, true]], 1, undefined], promoted.reason);
  assert.ok(promoted.reason.includes(unreadWords(1)), promoted.reason);
  assert.equal(promoted.check.disagreements, undefined, "an unread comparison is no disagreement");
  const held = await decide({}, [differ, same, unread]);
  assert.deepEqual([held.decided, numbers(held), held.check.undecided], ["hold", [["answer", 1, 2, 1, false]], undefined], held.reason);
  assert.ok(held.reason.includes(differentDecisionWords(1, 2, "the answer's number")), held.reason);
  assert.ok(held.reason.includes(unreadWords(1)), held.reason);
  assert.ok(!held.reason.includes("not decided"), held.reason);
  assert.deepEqual(held.check.disagreements.map((one) => one.differs_on), ["the answer's number"]);
  const undecided = await decide({}, [same, unread, unread]);
  assert.deepEqual([undecided.decided, numbers(undecided), undecided.check.unread, undecided.check.undecided], ["hold", [["answer", 1, 1, 2, true]], 2, true], undecided.reason);
  assert.ok(undecided.reason.includes(notDecidedWords(1, 3, 2)), undecided.reason);
  assert.match(undecided.reason, /; the agent's next run recompiles it once with the inputs it did not agree on$/);
  // A recompile's check that cannot decide still stops: an always-unreadable grader never compiles on every run.
  const stopped = await decide({ attempt: 2 }, [unread, unread, unread]);
  assert.deepEqual([stopped.decided, stopped.check.stopped, stopped.check.undecided], ["hold", true, true], stopped.reason);
  assert.ok(stopped.reason.includes(notDecidedWords(0, 3, 3)), stopped.reason);
  assert.match(stopped.reason, /, and this was the recompile's check, so it stops: /);
});

test("an unread comparison is out of both sides' accuracy: the agent's count, the cost summary's shares and the replay's score read the inputs that could be compared", async () => {
  const same = { same: true, grader: "fast-1" };
  const unread = { same: false, unread: true, grader: "fast-1", differs_on: `${COMPARE_UNREAD}: its reply was not the verdict asked for, twice` };
  const promoted = await decide({}, [same, same, unread]);
  assert.equal(promoted.decided, "promote", promoted.reason);
  // Neither side: the agent's answer on the unread input is not counted right, as the workflow's is not counted wrong.
  assert.deepEqual([promoted.check.alone, promoted.check.agreed, promoted.check.agent_agreed, promoted.check.unread], [3, 2, 2, 1]);
  // Promoted on 2 of 2 read: the cost summary says 100%, never 66.7%, on the 2 it could compare.
  assert.deepEqual(servingReplayOf([promoted], [{ path: "workflow", workflow: "answer" }]), { n: 3, workflow_pct: 100, agent_pct: 100, cleared: true, agreed: 2, alone: 2, agree_min: 0.8 });
  // The replay's score: decided on the 2 it could compare, no accuracy lost on the unread one.
  assert.deepEqual(checkScoreOf(promoted.check), { n: 2, agree: 2, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 0 });
});

test("graderAsk: a reply's text, a cap refusal as refused (nothing sent), any other failure as failed, with pi-ai's retries off", async () => {
  const model = { id: "fast-1", provider: "p" };
  const portOf = (answer) => {
    const asked = [];
    return { asked, models: { getModels: () => [model], getModel: () => model, streamSimple: () => { throw new Error("unused"); }, completeSimple: async (m, context, options) => (asked.push({ m, context, options }), answer()) } };
  };
  const ok = portOf(() => ({ content: [{ type: "text", text: '{"same":' }, { type: "text", text: " true}" }], stopReason: "stop" }));
  assert.deepEqual(await graderAsk(ok.models, { system: "S", user: "U" }), { text: '{"same": true}' });
  assert.equal(ok.asked[0].context.systemPrompt, "S");
  assert.equal(ok.asked[0].context.messages[0].content, "U");
  assert.equal(ok.asked[0].options.maxRetries, 0);
  const capped = portOf(() => ({ content: [], stopReason: "error", errorMessage: '400 {"error":{"type":"spend_cap_reached","message":"over the cap"}}' }));
  assert.ok("refused" in (await graderAsk(capped.models, { system: "S", user: "U" })));
  const thrown = portOf(() => { throw new Error("ECONNRESET"); });
  assert.deepEqual(await graderAsk(thrown.models, { system: "S", user: "U" }), { failed: "ECONNRESET" });
  const down = { getModels: () => [], completeSimple: async () => assert.fail("never sent") };
  assert.ok("failed" in (await graderAsk(down, { system: "S", user: "U" })));
});

test("graderAsk: a request that never answers is cut by the run's stop, or at its deadline, through the one signal it is handed", async () => {
  const model = { id: "fast-1", provider: "p" };
  const hung = () => {
    const signals = [];
    return { signals, models: { getModels: () => [model], getModel: () => model, streamSimple: () => { throw new Error("unused"); }, completeSimple: (m, context, options) => (signals.push(options.signal), new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }))) } };
  };
  const stopping = hung();
  const stop = new AbortController();
  const asked = graderAsk(stopping.models, { system: "S", user: "U" }, { signal: stop.signal, deadlineMs: 60_000 });
  stop.abort(new Error("the run was stopped"));
  assert.deepEqual(await asked, { cut: "its request was stopped with the run" });
  assert.equal(stopping.signals[0]?.aborted, true, "the request's own signal is aborted");
  const late = hung();
  assert.deepEqual(await graderAsk(late.models, { system: "S", user: "U" }, { deadlineMs: 30 }), { cut: "its request gave no answer within 0.03 s" });
  assert.equal(late.signals[0]?.aborted, true);
  const already = hung();
  const gone = new AbortController();
  gone.abort();
  assert.deepEqual(await graderAsk(already.models, { system: "S", user: "U" }, { signal: gone.signal }), { cut: "its request was stopped with the run" });
  assert.equal(already.signals.length, 0, "a run stopped already sends nothing");
});
