// Promote once (runner/promotion.ts startCheck/settleCheck, learn/compile.ts compileDue, learning-setting.ts): an agent
// whose definition says `learning: { compile_after, agree_min, alone_min }` (each optional; true is every default)
// compiles its job once, at compile_after completed agent runs, and checks the draft once: a replay of it on the inputs
// of the agent's last compile_after completed runs, each judged against its best known answer: a grade's expected answer
// where the input's run has one, else the agent's own recorded answer (learn/field-check.ts; no teacher). It is promoted
// when, of those inputs, it answered at least alone_min alone and every field passes (against the agent's answers: at
// least agree_min of those said what the agent said); else held, and the agent's next run recompiles it once with the
// inputs it did not agree on as data; that revision is checked the same way, then promoted or stopped: nothing compiles
// again. A check's promotion is never moved by its served runs' grades, a refit or a second replay.
//   (a) no compile before compile_after completed runs, exactly one at it (a definition's 5);
//   (b) a passing draft promotes and serves workflow-first on the next fitting run;
//   (c) under a bar: held, the next run's compile asks for one revision with the disagreements, and that revision's check
//       promotes it;
//   (d) the revision's check holds it too: stopped, and no run after compiles anything;
//   (e) the definition's numbers stand in for the defaults: at agree_min 0.9, 4 of 5 is held (the default 0.8 passes it);
//   (f) on graded inputs, the grade's expected answer is the known answer of each key it holds, not the agent's;
//   and a check's promotion never queues a rival, never refits on its served runs' grades, never replays again.
// The agent's earlier runs are real runs of the store (its list, launches and journals), on a pi run of the faux gateway.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, putPromotions, readmeOf, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { childLoops } = await import("../dist/runner/run-child-host.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { putGrade, promotionsOf, promotionsShown, recordPromotion } = await import("../dist/learn/promote.js");
const { WORKFLOW_NAME } = await import("../dist/learn/workflow-draft.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { learningOf } = await import("../dist/learn/rows.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { askedForCompile } = await import("../dist/learn/compile.js");
const { secretsShown } = await import("../dist/learning.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** The agent's own answer to every question, in the output format the workflow gives it (its `answer` object): what
 *  each check scores the draft against. */
const AGENT_SAYS = JSON.stringify({ answer: 42, sure: true });

/** The learned workflow: one node answers the question as a number; an escalate hands it back when it is not sure.
 *  `how`: its node's instructions (a revision changes them, so the faux node can answer it otherwise). */
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

/** A compile answer whose draft fails its dry run (its answer's state is never written): the compile's failure is on a
 *  promotion record, and no draft ever lands from the faux model. */
const brokenDraft = (name = "answer") => `\`\`\`\`workflow ${name}\n---\ndescription: Answers a question as a number; use when asked\nexample: {"question":"What is six times seven?"}\n---\n${JSON.stringify({ ...FIRST, name, root: { node: "chain", steps: [{ ...FIRST.root.steps[0], as: "other" }] } })}\n\`\`\`\``;

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => (part?.type === "text" ? part.text : "")).join(""));
/** The request's last user message, when it is a compile ask (learn/compile.ts askedForCompile): its text, else "". */
const compileAskOf = (body) => {
  const last = (body?.messages ?? []).findLast((message) => message.role === "user");
  return askedForCompile(textOf(last)) ? textOf(last) : "";
};

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** An agent of `learning` whose `prior` earlier runs (questions "Question 0" … , oldest first) ended on its own path
 *  before `flows` landed on its learning (none: nothing lands), a runner claiming every run from its stored
 *  launch. The agent answers AGENT_SAYS; the workflow's node submits `submit(requestText)` ({answer: 42, sure: true}
 *  by default); a compile ask is answered with brokenDraft(draftName). `landsRevision`: the revision ask is refused
 *  instead (its turn ends before it answers: no draft of it failed its checks), for a test that lands the revision
 *  itself, as a graded recompile merges it. `env`: the runner's environment (a secret-named value in it is one the run
 *  refuses). */
async function world(t, { learning, prior = 0, flows = [{ name: "answer", description: "Answers a question as a number", workflow: FIRST }], submit, landsRevision = false, env = {}, draftName, childRuns = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-promote-once-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submit ? submit(JSON.stringify(body)) : { answer: 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : compileAskOf(body) ? brokenDraft(draftName) : AGENT_SAYS),
    refuse: ({ body }) => (landsRevision && compileAskOf(body).startsWith("One more turn: revise") ? { message: "the test lands this revision itself" } : undefined),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning } });
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  // `childRuns`: each run a process of its own (run-child-host.ts childLoops), as the CLI's start runs them: its model
  // the faux gateway's Messages route (ANTHROPIC_BASE_URL), on a dummy key its claim hands it; its store writes, its
  // promotion's among them, the runner's.
  const runEnv = childRuns ? { PATH: process.env.PATH, TMPDIR: dir, ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_API_KEY: `not-a-secret-${"pi"}`, ...env } : env;
  const deps = { env: runEnv, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  const createLoop = childRuns ? childLoops({ deps, isolation: { kind: "process", why: "a test's runner" }, log: deps.log }) : createAdapterLoop(specOf);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return ["ended", "failed", "stopped"].includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, learningStart) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learningStart ? { learning: learningStart } : {}) });
  // The agent's earlier runs: by hand, each ended before the next starts (the newest last), no learning start.
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    const row = await ended(`prior-${i}`);
    // No learning start: its runs learn nothing and have no workflow to take (no path metric), the agent's own all the same.
    assert.deepEqual([row.state, row.metrics?.path], ["ended", undefined], JSON.stringify(row));
  }
  if (flows.length) await landWorkflows(server, "agent-1", flows);
  /** Each run's compile asks: by run id, the asks its requests made (`compiles` reads them after the run). */
  const asks = new Map();
  /** Runs `id` on `question` at the agent's newest save now, as the server launches it; its compile asks kept. */
  const start = async (id, question) => {
    const before = gw.requests.length;
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, startAt((await server.learning.seed("agent-1")).save.id)) });
    const row = await ended(id);
    asks.set(id, gw.requests.slice(before).map((request) => compileAskOf(request.body)).filter(Boolean));
    return row;
  };
  /** The replay runs the agent's checks made (their launch names the run replayed), whatever their state. */
  const replays = async () => {
    const out = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) if ((await server.runs.launch(row.id)).body?.replay) out.push(row);
    return out;
  };
  const replaysEnded = (count) => until(async () => {
    const all = await replays();
    return all.length === count && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, `the ${count} replay runs ended`);
  return { dir, server, gw, logs, start, asks, replays, replaysEnded };
}

/** Lands `workflow` as the next revision of `answer` on the agent's learning, as a graded recompile merges it. */
async function landRevision(store, workflow, runId) {
  const merged = await learningCommit(learningOf(store, "agent-1"), {
    runId, reason: "revised answer",
    files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(workflow) }, { path: "workflows/answer/README.md", text: readmeOf("answer", "Answers a question as a number") }],
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
}

const decisions = async (server) => (await promotionsOf(server.learning, "agent-1")).map(({ digest, decided }) => [digest, decided]);

// Compile once: a draft that fails its checks is the compile's attempt, on a promotion record (a hold naming the failed
// check, nothing checked). The first earns the one recompile, as a check's hold does; the recompile's failure stops.
test("(a, e) compile_after 5 on the definition: runs 1-4 compile nothing, run 5 is asked its one compile, run 6 its one recompile, then none", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 5 }, flows: [] });
  const asked = [];
  for (let i = 1; i <= 8; i++) {
    const row = await w.start(`run-${i}`, `Question ${i}`);
    assert.equal(row.state, "ended", JSON.stringify(row));
    asked.push(w.asks.get(`run-${i}`).length > 0);
  }
  assert.deepEqual(asked, [false, false, false, false, true, true, false, false], "compiled at the 5th completed run, its one recompile at the 6th, never again");
  for (const id of ["run-5", "run-6"]) assert.ok(w.asks.get(id)[0].startsWith("One more turn: write this agent's job as a learned workflow."), w.asks.get(id)[0].slice(0, 200));
  const records = await promotionsOf(w.server.learning, "agent-1");
  assert.deepEqual(records.map(({ workflow, decided, check }) => [workflow, decided, check?.attempt, check?.n, check?.stopped ?? false]), [["answer", "hold", 1, 0, false], ["answer", "hold", 2, 0, true]], JSON.stringify(records));
  for (const { reason } of records) assert.match(reason, /^its draft failed its checks: .+/, reason);
  assert.notEqual(records[0].digest, records[1].digest, "each compile's failure is its own record");
});

// Review on #3064 (PRRT_kwDOUmdVMs64Qed-): a failed draft's name and errors are the model's words, cut of the run's own
// refuse values before its promotion record is saved or logged; the promotions read cuts only the server's secrets. A
// per-run credential that passes WORKFLOW_NAME (lowercase), named as the draft, reaches none of them.
test("a compile whose failed draft is named after a per-run credential: the credential is not in its promotion record, the promotions read or the log", { timeout: 180_000 }, async (t) => {
  const credential = ["run", "pass", randomBytes(8).toString("hex")].join("-");
  assert.match(credential, WORKFLOW_NAME, "a name the compile turn takes");
  const w = await world(t, { learning: { compile_after: 1 }, flows: [], env: { WIDGET_TOKEN: credential }, draftName: credential });
  const row = await w.start("run-1", "Question 1");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(w.asks.get("run-1").length > 0, true, "the first completed run is asked its compile");
  const records = await promotionsOf(w.server.learning, "agent-1");
  assert.deepEqual(records.map(({ decided, check }) => [decided, check?.attempt, check?.n]), [["hold", 1, 0]], JSON.stringify(records));
  assert.match(records[0].reason, /^its draft failed its checks: .+/, records[0].reason);
  assert.ok(w.logs.some((line) => line.includes("failed its checks (attempt 1)")), w.logs.join("\n"));
  const read = promotionsShown(records, secretsShown([]));
  for (const [where, text] of [["the saved record", JSON.stringify(records)], ["the promotions read", JSON.stringify(read)], ["the log", w.logs.join("\n")]]) {
    assert.equal(text.includes(credential), false, `${where} holds the run's credential: ${text.slice(0, 2_000)}`);
  }
});

test("(a) learning true: the default compile_after is 20, not an earlier count of notes or runs", { timeout: 180_000 }, async (t) => {
  const w = await world(t, { learning: true, prior: 18, flows: [] });
  const nineteenth = await w.start("run-19", "Question 19");
  assert.equal(nineteenth.state, "ended");
  assert.deepEqual(w.asks.get("run-19"), [], "19 completed runs: not due");
  await w.start("run-20", "Question 20");
  assert.equal(w.asks.get("run-20").length > 0, true, "the 20th completed run is asked its compile");
});

test("(b) a draft that says what the agent said on its last runs, alone, is promoted by its check and serves the next fitting run first; it never queues, refits or replays again", { timeout: 180_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5 });
  const first = await w.start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "agent", `the agent takes the run while the draft is checked: ${JSON.stringify(first.metrics)}`);
  assert.ok(w.logs.some((line) => line.includes(`answer at ${DIGEST} is new: checking it on 5 inputs of the agent's last 5 completed runs against its own answers before it serves`)), w.logs.join("\n"));
  const runs = await w.replaysEnded(5);
  assert.deepEqual(runs.map((row) => [row.state, row.metrics?.path, row.metrics?.replay?.outcome]), runs.map(() => ["ended", "replay", "answered"]));
  assert.deepEqual(runs.map((row) => row.metrics.replay.of).sort(), ["prior-0", "prior-1", "prior-2", "prior-3", "prior-4"], "the inputs of the agent's last 5 completed runs");
  const second = await w.start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST], `served first: ${JSON.stringify(second.metrics)}`);
  const records = await promotionsOf(w.server.learning, "agent-1");
  assert.deepEqual(records.map(({ decided }) => [decided]), [["replaying"], ["promote"]]);
  const { fields, ...check } = records[1].check;
  assert.deepEqual({ ...check, of: [...check.of].sort(), cost_usd: typeof check.cost_usd }, {
    compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, agent_agreed: 5,
    of: ["prior-0", "prior-1", "prior-2", "prior-3", "prior-4"], cost_usd: "number", outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 },
  });
  assert.deepEqual(Object.entries(fields).map(([name, one]) => [name, one.workflow_right, one.n, one.known, one.pass]), [["answer", 5, 5, "agent", true]]);
  // Its served runs graded wrong, 20 of them: a graded check would hold or refit it. A check's promotion stands.
  for (let i = 0; i < 20; i++) await putGrade(w.server.learning, "agent-1", { run: `served-${i}`, correct: false, expected: { answer: 41 }, source: "eval", at: new Date().toISOString(), path: "workflow", workflow: "answer", digest: DIGEST });
  const third = await w.start("run-3", "What is two times twenty-one");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", DIGEST], JSON.stringify(third.metrics));
  assert.deepEqual(await decisions(w.server), [[DIGEST, "replaying"], [DIGEST, "promote"]], "no queued, refit, graded or second replay record");
  assert.equal((await w.replays()).length, 5, "no second replay");
});

// Each run a process of its own, as the CLI's start runs them: the learning a run's end takes at its claim (the check's
// reservation, its replays, the promotion it decides) is the runner's, never a store write the run's process asks for.
test("(b) through a run's own process: the draft's check starts, replays the agent's last 5 inputs and promotes it, and the next run is served by it", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5, childRuns: true });
  const first = await w.start("run-1", "What is six times seven");
  assert.equal(first.state, "ended", JSON.stringify(first));
  const refused = () => w.logs.filter((line) => line.includes("a run's process may not"));
  const runs = await w.replaysEnded(5).catch((error) => assert.fail(`${error.message}; refused: ${JSON.stringify(refused())}`));
  assert.deepEqual(runs.map((row) => [row.state, row.metrics?.path, row.metrics?.replay?.outcome]), runs.map(() => ["ended", "replay", "answered"]), w.logs.join("\n"));
  const second = await w.start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST], `served first: ${JSON.stringify(second.metrics)}`);
  assert.deepEqual(await decisions(w.server), [[DIGEST, "replaying"], [DIGEST, "promote"]]);
  assert.deepEqual(refused(), [], "no store call refused to a run's process");
});

// Review on #3064 (PRRT_kwDOUmdVMs64PlpM): records saved in a state this release no longer writes (queued, skipped) are
// dropped on read, as if absent: no conversion. The promotions read shows neither, and the revision's check starts (its
// reservation needs no earlier record of it).
test("(b) a store holding a saved `queued` record of the revision and a `skipped` one: the promotions read shows neither, and the revision's check starts and promotes it", { timeout: 180_000 }, async (t) => {
  const { promotionsShown } = await import("../dist/learn/promote.js");
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5 });
  const at = new Date().toISOString();
  await putPromotions(w.server, "agent-1", [
    { workflow: "answer", digest: DIGEST, at, decided: "queued", source: "replay", reason: "queued behind another revision's replay" },
    { workflow: "answer", digest: DIGEST_2, at, decided: "skipped", source: "replay", reason: "skipped: a newer revision came first" },
  ]);
  const same = { text: (text) => text, name: (name) => name };
  assert.deepEqual(promotionsShown(await promotionsOf(w.server.learning, "agent-1"), same), { promotions: [], serving: [] }, "the read shows neither");
  await w.start("run-1", "What is six times seven");
  assert.ok(w.logs.some((line) => line.includes(`answer at ${DIGEST} is new: checking it on 5 inputs`)), w.logs.join("\n"));
  await w.replaysEnded(5);
  const second = await w.start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST], JSON.stringify(second.metrics));
  const shown = promotionsShown(await promotionsOf(w.server.learning, "agent-1"), same);
  assert.deepEqual(shown.promotions.map(({ digest, decided }) => [digest, decided]), [[DIGEST, "replaying"], [DIGEST, "promote"]], "neither old state is read or kept");
  assert.deepEqual(shown.serving, [{ workflow: "answer", digest: DIGEST, replaying: null }]);
});

test("(f) graded inputs: the check judges the whole answer against each grade's expected answer, not the agent's: a draft that says the expected answer where the agent said 42 is promoted", { timeout: 180_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5, submit: () => ({ answer: 41, sure: true }) });
  for (let i = 0; i < 5; i++) await putGrade(w.server.learning, "agent-1", { run: `prior-${i}`, correct: false, expected: { answer: 41, sure: true }, source: "eval", at: new Date().toISOString(), path: "agent" });
  await w.start("run-1", "What is six times seven");
  await w.replaysEnded(5);
  const second = await w.start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "workflow", JSON.stringify(second.metrics));
  const decided = (await promotionsOf(w.server.learning, "agent-1")).at(-1);
  assert.deepEqual([decided.decided, decided.check.n, decided.check.agreed], ["promote", 5, 5], decided.reason);
  assert.deepEqual(Object.fromEntries(Object.entries(decided.check.fields).map(([name, one]) => [name, one.by])), {
    answer: { grade: { n: 5, workflow_right: 5, agent_right: 0, pass: true } },
  }, "one field, the whole answer: right on all 5 against the grades, where the agent was right on none");
});

test("(e) agree_min 0.9 on the definition: 4 of 5 saying what the agent said is held (the default 0.8 would pass it)", { timeout: 180_000 }, async (t) => {
  const submit = (text) => (text.includes("Question 0") ? { answer: 41, sure: true } : { answer: 42, sure: true });
  const w = await world(t, { learning: { compile_after: 5, agree_min: 0.9 }, prior: 5, submit });
  await w.start("run-1", "What is six times seven");
  await w.replaysEnded(5);
  const second = await w.start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const records = await promotionsOf(w.server.learning, "agent-1");
  const held = records.findLast(({ digest }) => digest === DIGEST);
  assert.deepEqual([held.decided, held.check.agree_min, held.check.alone_min, held.check.n, held.check.agreed, held.check.alone], ["hold", 0.9, 0.7, 5, 4, 5], JSON.stringify(held.check));
  assert.deepEqual(held.check.disagreements, [{ run: "prior-0", input: JSON.stringify({ content: "Question 0?", question: "Question 0" }), agent: AGENT_SAYS, draft: JSON.stringify({ answer: 41, sure: true }), fields: ["answer"] }]);
  // Run-2's end asked the one revision; the faux model's draft of it failed its checks: the recompile's attempt, so it stops.
  const failed = records.at(-1);
  assert.deepEqual([failed.workflow, failed.decided, failed.check.attempt, failed.check.n, failed.check.stopped, failed.check.agree_min], ["answer", "hold", 2, 0, true, 0.9], JSON.stringify(failed));
  assert.match(failed.reason, /^its draft failed its checks: .+It was the recompile, so it stops/);
});

test("(f) graded inputs: a draft that says neither the expected 41 nor the agent's 42 is held, though the agent was wrong on every one", { timeout: 180_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5, submit: () => ({ answer: 7, sure: true }) });
  for (let i = 0; i < 5; i++) await putGrade(w.server.learning, "agent-1", { run: `prior-${i}`, correct: false, expected: { answer: 41, sure: true }, source: "eval", at: new Date().toISOString(), path: "agent" });
  await w.start("run-1", "What is six times seven");
  await w.replaysEnded(5);
  const second = await w.start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const held = (await promotionsOf(w.server.learning, "agent-1")).find((one) => one.decided === "hold" && one.check?.n);
  assert.ok(held, "the check held it");
  assert.deepEqual(Object.keys(held.check.fields), ["answer"], "no field is made from a grade's keys");
  assert.deepEqual(held.check.fields.answer.by, { grade: { n: 5, workflow_right: 0, agent_right: 0, pass: false } }, held.reason);
  assert.deepEqual(held.check.disagreements.map((one) => one.expected), Array.from({ length: 5 }, () => [{ field: "answer", known: "grade", value: JSON.stringify({ answer: 41, sure: true }) }]), "each disagreement carries the known answer it missed, whole");
});

/** Odd questions: the first revision answers 41 (the agent said 42) or hands back; the revision says 42 when `fixed`. */
const twice = (fixed) => (text) => (text.includes("exactly") && fixed ? { answer: 42, sure: true } : /Question [13]\b/.test(text) ? { answer: 41, sure: true } : /Question 2\b/.test(text) ? { answer: 42, sure: false } : { answer: 42, sure: true });

test("(c) under the bar: held, the next run is asked one revision with the inputs it disagreed on as data, and the revision's check promotes it", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5, submit: twice(true), landsRevision: true });
  await w.start("run-1", "Question 10");
  await w.replaysEnded(5);
  // The check is in: 4 of 5 alone (80%), 2 of those as the agent said (50%, under 80%): held, and this run is the
  // agent's; its end asks the one revision, the disagreements fenced as data.
  const second = await w.start("run-2", "Question 11");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const held = (await promotionsOf(w.server.learning, "agent-1")).at(-1);
  assert.deepEqual([held.digest, held.decided, held.check.attempt, held.check.n, held.check.alone, held.check.agreed, held.check.stopped], [DIGEST, "hold", 1, 5, 4, 2, undefined]);
  const wrong = JSON.stringify({ answer: 41, sure: true });
  assert.deepEqual(held.check.disagreements.map(({ run, draft, escalated }) => [run, draft ?? null, escalated === undefined ? null : "handed back"]).sort(), [["prior-1", wrong, null], ["prior-2", null, "handed back"], ["prior-3", wrong, null]]);
  assert.match(held.check.disagreements.find(({ run }) => run === "prior-2").escalated, /not sure of 42/, "the escalate's reason, as its learned_workflow result said it");
  const [ask] = w.asks.get("run-2");
  assert.ok(ask?.startsWith("One more turn: revise your learned workflow `answer`"), ask?.slice(0, 200));
  assert.match(ask, /checked on 5 inputs of your last 5 completed runs, it answered 4 alone \(80\.0%, at least 70\.0% needed\); field by field: answer: 2 of 4 said what the agent said \(50\.0%, the bar 80\.0%\)\. It fell short on answer\./);
  assert.match(ask, /The fields it had wrong: answer/, "each disagreement names the field it had wrong");
  // The disagreements' fence alone (the ask's traces of the agent's last runs name other inputs too).
  const fence = /----- begin (\w+): the disagreements -----\n([\s\S]*?)\n----- end \1 -----/.exec(ask)?.[2] ?? "";
  assert.ok(fence, ask.slice(0, 2000));
  for (const part of ["Question 1?", "Question 2?", "Question 3?", `The draft's answer: ${JSON.stringify({ answer: 41, sure: true })}`, "The draft handed it back", `Your answer: ${AGENT_SAYS}`]) assert.ok(fence.includes(part), part);
  for (const agreed of ["Question 0?", "Question 4?"]) assert.ok(!fence.includes(agreed), `${agreed}: an input it agreed on is not among them`);
  // The revision lands (the test lands it; the faux model refused the ask): its one check runs on the next run.
  await landRevision(w.server, answerFlow(REVISED), "run-2");
  const third = await w.start("run-3", "Question 12");
  assert.equal(third.metrics?.path, "agent");
  await w.replaysEnded(10);
  const fourth = await w.start("run-4", "Question 13");
  assert.deepEqual([fourth.metrics?.path, fourth.metrics?.workflow_digest], ["workflow", DIGEST_2], JSON.stringify(fourth.metrics));
  const records = await promotionsOf(w.server.learning, "agent-1");
  assert.deepEqual(records.map(({ digest, decided }) => [digest, decided]), [[DIGEST, "replaying"], [DIGEST, "hold"], [DIGEST_2, "replaying"], [DIGEST_2, "promote"]]);
  assert.deepEqual([records[3].check.attempt, records[3].check.n, records[3].check.agreed], [2, 5, 5]);
});

test("(c, d) the revision's check holds it too: stopped, its numbers on the record, and no run after it compiles anything", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5, submit: twice(false), landsRevision: true });
  await w.start("run-1", "Question 10");
  await w.replaysEnded(5);
  await w.start("run-2", "Question 11");
  assert.equal(w.asks.get("run-2").length > 0, true, "the one revision is asked");
  await landRevision(w.server, answerFlow(REVISED), "run-2");
  await w.start("run-3", "Question 12");
  await w.replaysEnded(10);
  const fourth = await w.start("run-4", "Question 13");
  assert.equal(fourth.metrics?.path, "agent", "nothing serves: the agent keeps the runs");
  const records = await promotionsOf(w.server.learning, "agent-1");
  assert.deepEqual(records.map(({ digest, decided }) => [digest, decided]), [[DIGEST, "replaying"], [DIGEST, "hold"], [DIGEST_2, "replaying"], [DIGEST_2, "hold"]]);
  const stopped = records[3];
  // On the newest 5: run-2 and run-1 (42), prior-4 (42), prior-3 (41), prior-2 (handed back): 4 alone, 3 agree (75%).
  assert.deepEqual([stopped.check.attempt, stopped.check.stopped, stopped.check.n, stopped.check.alone, stopped.check.agreed], [2, true, 5, 4, 3]);
  assert.deepEqual(stopped.check.of, ["run-2", "run-1", "prior-4", "prior-3", "prior-2"]);
  assert.match(stopped.reason, /held on answer, and this was the recompile's check, so it stops: nothing compiles again until a hold or its owner acts$/);
  // Every run after the stop is still the agent's and asks no compile.
  for (let i = 5; i <= 8; i++) {
    const row = await w.start(`run-${i}`, `Question ${10 + i}`);
    assert.equal(row.metrics?.path, "agent", JSON.stringify(row.metrics));
    assert.deepEqual(w.asks.get(`run-${i}`), [], `run-${i} compiles nothing`);
  }
  assert.equal((await w.replays()).length, 10, "no third check");
});

/** Two learned workflows of an agent: `answer` stopped (its one recompile's check held it too) and `second` held (its
 *  recompile still owed). `secondNeeds`: a field `second`'s input takes, so a run without it does not fit `second`. */
async function stoppedAndHeld(t, secondNeeds) {
  const second = { ...answerFlow(REVISED), name: "second", schemas: { ...answerFlow().schemas, In: { type: "object", required: secondNeeds ?? ["question"], properties: { question: { type: "string" }, other: { type: "string" } } } } };
  const w = await world(t, { learning: { compile_after: 5 }, prior: 5, flows: [{ name: "answer", description: "Answers a question as a number", workflow: FIRST }, { name: "second", description: "Answers it again as a number", workflow: second }] });
  const at = new Date().toISOString();
  const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7 };
  const hold = (workflow, digest, check) => ({ workflow, digest, at, decided: "hold", reason: "held", check });
  await recordPromotion(w.server.learning, "agent-1", hold("answer", DIGEST, { ...bar, attempt: 2, n: 5, alone: 4, agreed: 3, stopped: true }), () => true);
  await recordPromotion(w.server.learning, "agent-1", hold("second", workflowDigest({ workflow: JSON.stringify(second) }), { ...bar, attempt: 1, n: 5, alone: 4, agreed: 2 }), () => true);
  return w;
}

test("(c) a stopped workflow is never asked a recompile: with `answer` stopped and `second` held, both fitting, the ask revises `second`", { timeout: 180_000 }, async (t) => {
  const w = await stoppedAndHeld(t);
  await w.start("run-1", "Question 10");
  // The compile turn's retries (a draft that failed its dry run is asked again) are not revision asks.
  const revisions = w.asks.get("run-1").filter((ask) => ask.startsWith("One more turn: revise your learned workflow"));
  assert.equal(revisions.length > 0, true, "the held workflow is asked its revision");
  for (const ask of revisions) assert.ok(ask.startsWith("One more turn: revise your learned workflow `second`"), `never the stopped one: ${ask.slice(0, 160)}`);
});

test("(c) a stopped workflow is never asked a recompile, whatever else is held: `answer` stopped, `second` held but not fitting the run, no compile ask", { timeout: 180_000 }, async (t) => {
  const w = await stoppedAndHeld(t, ["question", "other"]);
  await w.start("run-1", "Question 10");
  assert.deepEqual(w.asks.get("run-1"), []);
});

// Review on #3032 r4 (PRRT_kwDOUmdVMs64MQC-): the compile ask counts the agent's own completed runs before anything limits
// the read, as the check's inputs are: 250 runs a workflow served since never push the agent's own N out of the window.
test("(a) compile_after 5, 5 own completed runs then 250 workflow-served runs, the workflow retired: the compile ask still fires", async () => {
  const { compileAskOf: askOf } = await import("../dist/runner/learning-end.js");
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ id: `own-${i}`, agentId: "agent-1", revisionId: "rev-1", state: "ended", outcome: "completed", metrics: null, archivedAt: null, importedFrom: null });
  for (let i = 0; i < 250; i++) rows.push({ id: `served-${i}`, agentId: "agent-1", revisionId: "rev-1", state: "ended", outcome: "completed", metrics: { path: "workflow", workflow: "answer" }, archivedAt: null, importedFrom: null });
  rows.push({ id: "now", agentId: "agent-1", revisionId: "rev-1", state: "running", outcome: null, metrics: null, archivedAt: null, importedFrom: null });
  const newestFirst = [...rows].reverse();
  let opened = 0;
  const store = {
    settings: { get: async () => undefined },
    runs: {
      get: async (id) => rows.find((row) => row.id === id),
      list: async ({ state, archived, limit } = {}) => newestFirst.filter((row) => (state === undefined || row.state === state) && (archived === undefined || (row.archivedAt !== null) === archived)).slice(0, limit),
    },
    agents: { revision: async () => ({ body: { learning: { compile_after: 5 } } }) },
    // Past the due count, the turn reads the agent's learning (its saves): each read counted, and failed here.
    learning: { proposal: async () => undefined, records: async () => [], ...Object.fromEntries(["saveOf", "newest", "itemsAt"].map((read) => [read, async () => { opened++; throw new Error("learning read: the compile is due"); }])) },
  };
  const deps = { store };
  await askOf(deps, { runId: "now", agentId: "agent-1", outcome: "completed", refuse: [], seedWorkflows: 0 }).catch(() => undefined);
  assert.equal(opened > 0, true, "the 5 own runs are found behind the 250 served ones: the compile is due");
});
