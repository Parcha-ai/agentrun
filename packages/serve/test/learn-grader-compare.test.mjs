// The grader (learn/promote.ts gradeAnswers, runner/compare-end.ts): with no learning.agree_on, a replay run and an audit's
// shadow ask the agent's fast model once, at their end, whether their answer and the other one reach the same decision;
// the check (runner/promotion.ts decideCheck) and the audit (runner/audit.ts settleAudits) read that verdict through the
// one comparison (compareAnswers). An agree_on revision asks no model. A reply that is not the verdict, a failed request
// and a refusal of the run's cap all differ, in words saying so; the grader's request is the run's own spend, booked under
// its cap: a replay's is its check's cost, a shadow's the served run's learning cost.
//   (1) a check with no agree_on on differently worded answers promotes through the grader (with no fast model: held, 0 agreed);
//   (2) an agree_on revision's check sends no grader request;
//   (3) a grader reply that is not the verdict disagrees, and the record says why;
//   (4) the run's cap refusing the grader's request disagrees and books nothing;
//   (5) the audit compares through the grader, and its request is the served run's learning cost;
//   (6) the grader's cost is its check's replay runs' cost, the revision's check_usd;
//   (7) a person's stop while the grader's request hangs stops the replay at once, and its pair counts as differing;
//   (8) a verdict is of the two answers it read: the source run answering again after it was compared makes it stale.
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
import { landWorkflows, readmeOf, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { promotionsOf, GRADER_PROMPT, graderVerdictOf, gradeAnswers, compareAnswers, answersPair, COMPARE_UNREAD, COMPARE_CAP_HELD, COMPARE_STALE } = await import("../dist/learn/promote.js");
const { decideCheck, NEVER_WORD_FOR_WORD } = await import("../dist/runner/promotion.js");
const { graderAsk } = await import("../dist/runner/compare-end.js");
const { learningStoreOf } = await import("../dist/learn/store-of.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { askedForCompile } = await import("../dist/learn/compile.js");
const { seedOf, secretsShown } = await import("../dist/learning.js");
const { readAudits } = await import("../dist/learn/audit.js");
const { agentCostOverStore } = await import("../dist/store-reads/learning.js");

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
 *  answered AGENT_41. */
async function world(t, { learning, prior = 0, env = FAST, grader, priced, cap, hang } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-grader-compare-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : compiling(body) ? BROKEN_DRAFT : textOf((body?.messages ?? []).findLast((m) => m.role === "user")).includes(SAY_41) ? AGENT_41 : AGENT_PROSE),
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
  const price = (model, usage) => (priced ? priced(model, usage) : ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6);
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, learningStart, extra = {}) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learningStart ? { learning: learningStart } : {}), ...extra });
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    await ended(`prior-${i}`);
  }
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: FIRST }]);
  await server.settings.put("learning.promotions.agent-1", { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 3, agreed: 3, alone: 3, of: [] }, commit: seed }] });
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
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, startAt((await seedOf(dir, "agent-1")).sha), cap === undefined ? {} : { max_cost_usd: cap }) });
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
  const audits = async () => {
    const folder = learningStoreOf(dir, "agent-1");
    return await readAudits(folder);
  };
  const graderRequests = () => gw.requests.filter((request) => isGrader(request.body));
  return { dir, server, gw, start, ended, replays, replaysEnded, shadowOf, audits, graderRequests };
}

/** Lands `workflow` as the next revision of `answer` on the learning folder's main. */
async function landRevision(dir, workflow, runId) {
  const folder = learningStoreOf(dir, "agent-1");
  const merged = await learningCommit(folder, {
    kind: "merge", runId, reason: "revised answer", graded: {},
    files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(workflow) }, { path: "workflows/answer/README.md", text: readmeOf("answer", "Answers a question as a number") }],
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
}

/** Lands the revision and runs its check to its decision: the claim that starts the check, its 3 replays, and the claim
 *  after them, which decides it. The revision's newest record. */
async function checked(w, ids) {
  await landRevision(w.dir, answerFlow(REVISED), ids[0]);
  await w.start(ids[0], "Question 10");
  const replays = await w.replaysEnded(3);
  await w.start(ids[1], "Question 11");
  const record = (await promotionsOf(w.server.settings, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  return { record, replays };
}

test("(1) no agree_on: the check's answers, worded apart, agree through the fast model and it promotes; with no fast model they are compared whole and held, 0 agreed", { timeout: 300_000 }, async (t) => {
  const ids = undrawn("one");
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
  const { record } = await checked(w, ids);
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual([record.check.n, record.check.alone, record.check.agreed, record.check.grader], [3, 3, 3, MODEL], JSON.stringify(record.check));
  assert.match(record.reason, /compared by the fast model \(claude-sonnet-5-5\)/);
  assert.equal(w.graderRequests().length, 3, "one grader request per replay");

  const ids2 = undrawn("whole");
  const none = await world(t, { learning: { compile_after: 3 }, prior: 3, env: {} });
  const held = (await checked(none, ids2)).record;
  assert.equal(held.decided, "hold", held.reason);
  assert.deepEqual([held.check.agreed, held.check.grader], [0, undefined]);
  assert.ok(held.reason.includes(NEVER_WORD_FOR_WORD), held.reason);
  assert.equal(none.graderRequests().length, 0, "no fast model: no grader request");
});

test("(2) an agree_on revision's check compares on its fields and sends no grader request", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3, agree_on: ["answer", "sure"] }, prior: 3 });
  const { record } = await checked(w, undrawn("on"));
  assert.equal(record.decided, "promote", record.reason);
  assert.deepEqual([record.check.agreed, record.check.agree_on, record.check.grader], [3, ["answer", "sure"], undefined]);
  assert.equal(w.graderRequests().length, 0);
});

test("(3) a grader reply that is not the verdict disagrees: held, each disagreement saying the comparison could not be read", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3, grader: () => "They look the same to me." });
  const { record } = await checked(w, undrawn("unread"));
  assert.equal(record.decided, "hold", record.reason);
  assert.deepEqual([record.check.agreed, record.check.grader], [0, MODEL]);
  assert.equal(record.check.disagreements.length, 3);
  for (const one of record.check.disagreements) assert.ok(one.differs_on.startsWith(COMPARE_UNREAD), one.differs_on);
  assert.match(record.reason, /its answers reached a different decision from the agent's on 3 of 3 \(for example: the comparison could not be read/);
  assert.equal(w.graderRequests().length, 3, "a reply that is no verdict is asked once: no retry");
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
  await landRevision(w.dir, answerFlow(REVISED), ids[0]);
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
  const record = (await promotionsOf(w.server.settings, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  assert.equal(record.decided, "hold", record.reason);
  assert.equal(record.check.agreed, 0, JSON.stringify(record.check));
});

test("(8) a verdict is of the two answers it read: the source run answers 41 after its replay was compared, and the check never counts the old 'same'", { timeout: 300_000 }, async (t) => {
  const ids = undrawn("stale");
  const w = await world(t, { learning: { compile_after: 3 }, prior: 3 });
  await landRevision(w.dir, answerFlow(REVISED), ids[0]);
  await w.start(ids[0], "Question 10");
  const replays = await w.replaysEnded(3);
  for (const row of replays) assert.equal(row.metrics?.replay?.compared?.same, true, `${row.id}: ${JSON.stringify(row.metrics?.replay)}`);
  // A person follows up on one replay's source run, and it answers again, with another decision.
  const source = (await w.replays())[0].launch.replay.of;
  await w.server.runs.reopen(source, { kind: "steer", body: { text: SAY_41 } });
  await w.ended(source);
  await w.start(ids[1], "Question 11");
  const record = (await promotionsOf(w.server.settings, "agent-1")).findLast((one) => one.digest === DIGEST_2 && one.decided !== "replaying");
  assert.ok(record, "the revision's check decided");
  assert.equal(record.check.agreed, 2, JSON.stringify(record.check));
  assert.equal(record.decided, "hold", record.reason);
  const differs = record.check.disagreements.find((one) => one.run === source);
  assert.ok(differs, JSON.stringify(record.check.disagreements));
  assert.equal(differs.differs_on, COMPARE_STALE);
  assert.match(differs.agent ?? "", /41/, "the disagreement shows the source's newest answer");
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

test("gradeAnswers asks once more on a transport failure alone; a refusal, two failures, a cut request and a non-verdict differ, in words", async () => {
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
  assert.match(once.asked[0].user, /The job input:\n<<<\nin\n>>>\n\nThe agent's answer:\n<<<\na\n>>>\n\nThe workflow's answer:\n<<<\nb\n>>>/);
  const twice = graderOf([{ failed: "socket hang up" }, { failed: "socket hang up" }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", twice.grader), { same: false, grader: "fast-1", pair, differs_on: `${COMPARE_UNREAD}: its request failed twice` });
  const refused = graderOf([{ refused: "spend_cap_reached" }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", refused.grader), { same: false, grader: "fast-1", pair, differs_on: COMPARE_CAP_HELD });
  assert.equal(refused.asked.length, 1, "a refusal is not asked again");
  const cut = graderOf([{ cut: "its request was stopped with the run" }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", cut.grader), { same: false, grader: "fast-1", pair, differs_on: `${COMPARE_UNREAD}: its request was stopped with the run` });
  assert.equal(cut.asked.length, 1, "a stopped or timed-out request is not asked again");
  const prose = graderOf([{ text: "same" }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", prose.grader), { same: false, grader: "fast-1", pair, differs_on: `${COMPARE_UNREAD}: its reply was not the verdict asked for` });
  const differ = graderOf([{ text: '{"same": false, "differs_on": "mcc"}' }]);
  assert.deepEqual(await gradeAnswers("in", "a", "b", differ.grader), { same: false, grader: "fast-1", pair, differs_on: "mcc" });
  const unnamed = graderOf([{ text: '{"same": false, "differs_on": null}' }]);
  assert.equal((await gradeAnswers("in", "a", "b", unnamed.grader)).differs_on, "a decision it did not name");
});

test("compareAnswers: agree_on decides alone; equal answers agree with no verdict; else the grader's verdict on that same pair, else differ", () => {
  const verdict = { same: true, grader: "fast-1", pair: answersPair('{"a":2}', '{"a":1}') };
  assert.deepEqual(compareAnswers('{"a":1,"b":2}', '{"a":1,"b":3}', ["a"], { same: false, grader: "fast-1", differs_on: "a" }), { same: true });
  assert.deepEqual(compareAnswers('{"a":1}', '```json\n{"a":1}\n```', undefined), { same: true });
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}', undefined, verdict), verdict);
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}', undefined), { same: false });
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}', undefined, { same: true }), { same: false }, "a verdict no grader gave is none");
  assert.deepEqual(compareAnswers(null, '{"a":1}', undefined, verdict), { same: false });
  // A verdict on another pair (one of the answers changed since it was read), or naming none, is stale: they differ.
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":3}', undefined, verdict), { same: false, grader: "fast-1", differs_on: COMPARE_STALE });
  assert.deepEqual(compareAnswers('{"a":1}', '{"a":2}', undefined, { same: true, grader: "fast-1" }), { same: false, grader: "fast-1", differs_on: COMPARE_STALE });
  assert.notEqual(answersPair("a", "b"), answersPair("ab", ""), "the pair's two answers never run together");
});

/** The settings a promotion record is written through, in memory. */
function settingsOf() {
  const kv = new Map();
  return {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
}
async function decide(bar, compared) {
  const settings = settingsOf();
  const answer = '{"answer":42,"sure":true}';
  // Each verdict is of the row's own pair (gradeAnswers' `pair`).
  const rows = compared.map((one, i) => ({ of: `r-${i}`, input: `{"q":${i}}`, agent: AGENT_PROSE, outcome: "answered", answer, ...(one ? { compared: { ...one, pair: answersPair(AGENT_PROSE, answer) } } : {}) }));
  const read = { rows, cost: 0, outcomes: { answered: rows.length, handed_back: 0, skipped_write: 0, failed: 0 }, unstarted: 0 };
  const deps = { store: { settings }, agentId: "a", runId: "now", revisionId: "rev", launch: {}, context: ctx, log: () => {}, shown: async () => secretsShown([]) };
  return (await decideCheck(deps, "answer", "d1", { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1, ...bar }, read, () => true, {})).record;
}

test("the check's words: compared by the fast model, a different decision on k of n with an example, never 'word for word' when a grader ran", async () => {
  const same = { same: true, grader: "fast-1" };
  const differ = { same: false, grader: "fast-1", differs_on: "the answer's number" };
  const promoted = await decide({}, [same, same, same]);
  assert.equal(promoted.decided, "promote");
  assert.equal(promoted.check.grader, "fast-1");
  assert.match(promoted.reason, /3 of those said what the agent said, compared by the fast model \(fast-1\)/);
  const held = await decide({}, [same, differ, differ]);
  assert.equal(held.decided, "hold");
  assert.match(held.reason, /its answers reached a different decision from the agent's on 2 of 3 \(for example: the answer's number\)/);
  assert.ok(!held.reason.includes("word for word"), held.reason);
  assert.deepEqual(held.check.disagreements.map((one) => one.differs_on), ["the answer's number", "the answer's number"]);
  const whole = await decide({}, [undefined, undefined, undefined]);
  assert.ok(whole.reason.includes(NEVER_WORD_FOR_WORD), whole.reason);
  assert.equal(whole.check.grader, undefined);
  const on = await decide({ agree_on: ["answer"] }, [differ, differ, differ]);
  assert.equal(on.decided, "promote", "agree_on decides alone");
  assert.equal(on.check.grader, undefined);
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
