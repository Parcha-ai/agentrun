// Promotion by replay through the runner (runner/promotion.ts, learn/promote.ts): a learned workflow's new digest with
// five graded inputs or more it fits does not serve first until a replay on them clears the bar.
//   - the first fitting run goes to the agent while the digest replays: one replay run per graded input, each the
//     workflow alone at workflow cost (path `replay`, no agent request, no end-of-run turn);
//   - a later run, every replay ended, is served first once the replay is within 2 points of the agent's graded answers;
//   - a replay the workflow hands back on counts as the agent's recorded answer, never as a failure; but one that hands
//     back every input would never answer alone: held. An escalate on a judge's field is recorded in a replay, not
//     obeyed, and the refit may switch it off; one on a draft's own field stays hard;
//   - a replay whose answers are wrong holds the digest: the run after it is the agent's;
//   - fewer than five graded inputs: promoted on its passing dry run, as before, and the record says so;
//   - champion/challenger: a promoted digest (the champion) keeps serving while a newer revision of it replays, and after
//     that revision's replay holds it; the revision serves only once its replay promotes it;
//   - one replay at a time, and a running replay finishes: a newer revision that comes while another replays is queued,
//     one queued before it is skipped (its record names the newer one), the replay at work is decided at a claim once
//     its runs ended (its verdict stands), then the queued one replays; the queue is records in the store, so a restart
//     keeps it; "newer" is the learning folder's main, never a run's launch time: a run pinned to an older commit
//     queues nothing;
//   - a replay that failed on its inputs (a step failed) is no evidence: held, never promoted on the agent's answers;
//   - a replay run runs only while its revision replays, and only on that revision: else it ends failed, no agent;
//   - a revision whose input the run does not fit (a new required field) leaves its champion serving the run.
// The graded runs are records the promotion reads (their grade, launch and row), on a pi run of the faux gateway.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, readmeOf, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { putGrade, promotionsOf, recordPromotion, servingOf } = await import("../dist/learn/promote.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { seedOf } = await import("../dist/learning.js");
const { CANARY } = await import("./fixtures/faux-jev.mjs");
const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = "The agent's own answer: 42.";

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
const DIGEST = workflowDigest({ workflow: JSON.stringify(answerFlow) });
const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const isNode = (request) => offers(request.body, "submit");

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A proxy in front of the gateway that holds each request whose body `held` matches until the caller goes away (a
 *  cancelled run's aborted request), so a run asking one stays in flight; `release()` sends each one held on, and holds
 *  none after. */
async function holdingProxy(t, origin, held) {
  const holding = new Set();
  const waiting = new Set();
  let released = false;
  const forward = async (req, res, body) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !["host", "content-length", "connection"].includes(key)));
    const answer = await fetch(`${origin}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
    res.writeHead(answer.status, Object.fromEntries([...answer.headers].filter(([key]) => !["content-length", "content-encoding", "transfer-encoding", "connection"].includes(key))));
    if (answer.body) Readable.fromWeb(answer.body).pipe(res);
    else res.end();
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (!released && held(body.toString("utf8"))) {
      const go = () => {
        waiting.delete(go);
        holding.delete(res);
        forward(req, res, body).catch(() => res.destroy());
      };
      holding.add(res);
      waiting.add(go);
      res.on("close", () => {
        holding.delete(res);
        waiting.delete(go);
      });
      return;
    }
    await forward(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const res of holding) res.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const release = () => {
    released = true;
    for (const go of [...waiting]) go();
  };
  return { url: `http://127.0.0.1:${server.address().port}`, holding, release };
}

/** An agent that learned `answer` and `graded` graded runs (their grade's `expected` fields: `expected`), a runner
 *  claiming every run from its stored launch. The node submits `{answer: 42, sure}`. `hold`: a model request whose body
 *  it matches is held until its run is cancelled. */
async function world(t, { graded = 6, expected = { answer: 42 }, sure = true, flows = FLOWS, submit, hold, env = {} } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-promote-replay-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submit ? submit(JSON.stringify(body)) : { answer: 42, sure } } } : undefined),
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
  const seed = await landWorkflows(dir, "agent-1", flows);
  const launchOf = (question, at = seed) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt(at) });
  // The graded runs: ended on the agent's path, each with its launch, read where the promotion reads them.
  const old = new Map(Array.from({ length: graded }, (_, i) => [`graded-${i}`, launchOf(`Question ${i}`)]));
  for (const [run, launch] of old) await putGrade(server.settings, "agent-1", { run, correct: true, expected, source: "eval", at: new Date().toISOString(), path: "agent" });
  const runsOf = Object.create(store.runs);
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(store.runs) ?? {})) if (typeof store.runs[key] === "function" && key !== "constructor") runsOf[key] = store.runs[key].bind(store.runs);
  runsOf.get = async (id) => (old.has(id) ? { id, agentId: "agent-1", revisionId: "rev-1", state: "ended", metrics: { path: "agent" }, archivedAt: null, importedFrom: null, costUsd: 0.01, startedAt: 1, endedAt: 2 } : store.runs.get(id));
  runsOf.launch = async (id) => (old.has(id) ? { runId: id, body: old.get(id), sealed: null, createdAt: 1 } : store.runs.launch(id));
  const depStore = new Proxy(store, { get: (target, key) => (key === "runs" ? runsOf : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const proxy = hold ? await holdingProxy(t, gw.url, hold) : undefined;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: proxy?.url ?? gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store: depStore, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  /** The runner stopped and a new one started, as a server restart starts one: nothing of the last one's memory kept. */
  const restart = async () => {
    await runner.close();
    runner = startRunner({ store, name: "runner-b", ...TIMING, createLoop: createAdapterLoop(specOf) });
  };
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return ["ended", "failed", "stopped"].includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const start = async (id, question) => {
    // Launched as the server launches a run: at the learning folder's main now (a refit's revision once it landed).
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, (await seedOf(dir, "agent-1")).sha) });
    return ended(id);
  };
  /** A run launched now pinned to learning commit `at`, as a run made before main moved is. */
  const startPinned = async (id, question, at) => {
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, at) });
    return ended(id);
  };
  const replays = async () => (await server.runs.list({ agentId: "agent-1" })).filter((row) => row.id !== "run-1" && row.id !== "run-2");
  return { server, gw, logs, start, startPinned, launchOf, ended, replays, seed, dir, proxy, restart };
}

test("a new digest with graded inputs replays before it serves: the agent takes the run meanwhile, its tool never given the revision; within the bar, the next run is served first", { timeout: 180_000 }, async (t) => {
  const { server, gw, logs, start, replays } = await world(t);
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.state, "ended");
  assert.equal(first.metrics?.path, "agent", `the agent took the run while its workflow replays: ${JSON.stringify(first.metrics)}`);
  assert.ok(logs.some((line) => /replaying it on the agent's last 6 graded inputs/.test(line)), logs.join("\n"));
  // Nothing of the workflow serves while its only revision replays: the agent's learned_workflow tool is not given it to
  // run in the workflow's place either (chain14b: four runs ran a replaying draft through the tool).
  const asked = gw.requests.filter((request) => !isNode(request));
  assert.ok(asked.length > 0, "the agent took the run");
  assert.deepEqual(asked.filter((request) => offers(request.body, "learned_workflow")).length, 0, "no learned_workflow tool: no revision of it is promoted");
  assert.ok(logs.some((line) => line.includes(`the learned_workflow tool leaves out answer: ${DIGEST} is not promoted, and no revision of it serves`)), logs.join("\n"));
  // One replay run a graded input, each the workflow alone: path replay, answered, at workflow cost, no end-of-run turn.
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  for (const row of runs) {
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.equal(row.metrics?.path, "replay");
    assert.equal(row.metrics?.workflow_digest, DIGEST);
    assert.equal(row.metrics?.replay?.outcome, "answered");
    assert.match(row.metrics?.replay?.of, /^graded-\d$/);
    assert.ok(row.costUsd > 0, "at workflow cost: its node's request");
    assert.equal(await server.learning.proposal(row.id), undefined, "a replay asks nothing at its end");
  }
  assert.deepEqual([...new Set(runs.map((row) => row.metrics.replay.of))].sort(), Array.from({ length: 6 }, (_, i) => `graded-${i}`));
  const agentRequests = gw.requests.filter((request) => !isNode(request)).length;
  // The next fitting run: the replay is in, within the bar: promoted, and it serves first.
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "workflow", JSON.stringify(second.metrics));
  assert.equal(gw.requests.filter((request) => !isNode(request)).length, agentRequests, "no agent request for the served run");
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.map(({ decided, source }) => [decided, source]), [["replaying", "replay"], ["promote", "replay"]]);
  const { replay } = records[1];
  assert.deepEqual({ ...replay, of: replay.of.length }, { n: 6, agree: 0, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 0, of: 6, cost_usd: replay.cost_usd, skipped_tools: [], outcomes: { answered: 6, handed_back: 0, failed: 0, skipped_write: 0 } });
  assert.ok(replay.cost_usd > 0, "what the replay cost is on its record");
  assert.equal(records[1].digest, DIGEST);
});

test("a replay the workflow hands back on every input is held (it would never answer alone); its escalate on a draft stays hard in the replay, and no agent turn ran in it", { timeout: 180_000 }, async (t) => {
  const { server, gw, start, replays } = await world(t, { sure: false });
  await start("run-1", "What is six times seven");
  const agentAfterFirst = gw.requests.filter((request) => !isNode(request)).length;
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  assert.deepEqual(runs.map((row) => [row.state, row.metrics?.replay?.outcome]), runs.map(() => ["ended", "handed_back"]));
  assert.equal(gw.requests.filter((request) => !isNode(request)).length, agentAfterFirst, "a hand-back in replay asks the agent nothing");
  const second = await start("run-2", "What is seven times six");
  // Every input handed back: within the bar on the agent's own answers, but it never answered alone: held, and its escalate
  // (on the draft's own field, no judge's) is no switch a refit has, so nothing serves: the next run is the agent's.
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.map(({ decided, source }) => [decided, source]), [["replaying", "replay"], ["hold", "replay"]]);
  const decided = records.at(-1);
  assert.deepEqual({ wf_acc: decided.replay.wf_acc, agent_acc: decided.replay.agent_acc, n: decided.replay.n, handed_back: decided.replay.handed_back, alone: "alone" in decided.replay }, { wf_acc: 1, agent_acc: 1, n: 6, handed_back: 6, alone: false });
  assert.match(decided.reason, /^it handed back every one of its 6 replayed inputs: it would never answer alone/);
});

/** answerFlow with a judge of its draft and an escalate on the judge's field (the MCC shape): the faux Jev says yes to
 *  every question, so `unsupported` is true and the escalate fires on every input, the draft right or not. */
const judgedFlow = {
  ...answerFlow,
  schemas: { ...answerFlow.schemas, Check: { type: "object", required: ["unsupported"], properties: { unsupported: { type: "boolean", description: "Is the answer unsupported by the question?" } } } },
  root: { node: "chain", steps: [
    answerFlow.root.steps[0],
    { node: "judge", label: "check", state: { answer: "{answer.answer}", question: "{question}" }, out: "Check", as: "check" },
    { node: "escalate", label: "unsupported", when: { predicate: "field_equals", path: "check.unsupported", value: true }, kind: "unsupported", stage: "check", summary: "the check says {answer.answer} is unsupported" },
  ] },
};

test("a judge-driven escalate is recorded in the replay, not obeyed: held for never answering alone, the refit switches it off, and the new revision promotes and answers alone", { timeout: 180_000 }, async (t) => {
  const env = { TYPESAFE_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV };
  const { server, start, replays, logs } = await world(t, { flows: [{ name: "answer", description: "Answers a question as a number", workflow: judgedFlow }], env });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "agent");
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  // Recorded, not obeyed: each replay went on to its draft, the escalate's row saying it fired.
  for (const row of runs) {
    assert.equal(row.metrics?.replay?.outcome, "answered", JSON.stringify(row.metrics));
    assert.deepEqual(row.metrics.guards.map(({ node, signal, p, escalated }) => [node, signal, p, escalated]), [["unsupported", "escalate", 0, false]]);
  }
  const second = await start("run-2", "What is seven times six");
  const records = await promotionsOf(server.settings, "agent-1");
  const held = records.find((one) => one.decided === "hold");
  assert.equal(held.digest, workflowDigest({ workflow: JSON.stringify(judgedFlow) }));
  assert.deepEqual({ n: held.replay.n, handed_back: held.replay.handed_back }, { n: 6, handed_back: 6 });
  assert.match(held.reason, /it would never answer alone/);
  const refit = records.at(-1);
  assert.deepEqual({ decided: refit.decided, source: refit.source, from: refit.refit.from, guards: refit.refit.guards }, { decided: "promote", source: "refit", from: held.digest, guards: [{ node: "unsupported", was: null, threshold: null, escalate: true }] });
  assert.deepEqual({ wf_acc: refit.replay.wf_acc, delta: refit.replay.delta, n: refit.replay.n, handed_back: refit.replay.handed_back, alone: "alone" in refit.replay }, { wf_acc: 1, delta: 0, n: 6, handed_back: 0, alone: false });
  assert.ok(logs.some((line) => /refit answer's guards over its replay held it \(6 rows\): unsupported escalate off/.test(line)), logs.join("\n"));
  // The refit serves this same run, alone: no escalate left to hand it back.
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", refit.digest], JSON.stringify(second.metrics));
});

test("a replay more than 2 points under the agent holds the digest: the next run is the agent's", { timeout: 180_000 }, async (t) => {
  const { server, start, replays, logs } = await world(t, { expected: { answer: 41 } });
  await start("run-1", "What is six times seven");
  await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null);
  }, "the six replay runs ended");
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const decided = (await promotionsOf(server.settings, "agent-1")).at(-1);
  assert.deepEqual({ decided: decided.decided, source: decided.source, wf_acc: decided.replay.wf_acc, agent_acc: decided.replay.agent_acc, delta: decided.replay.delta }, { decided: "hold", source: "replay", wf_acc: 0, agent_acc: 1, delta: -1 });
  assert.match(decided.reason, /more than 2 pts under the agent/);
  assert.ok(logs.some((line) => /held/.test(line)), logs.join("\n"));
});

test("fewer than five graded inputs: promoted on its passing dry run, as before, and its record says so", { timeout: 120_000 }, async (t) => {
  const { server, start, replays } = await world(t, { graded: 3 });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "workflow", JSON.stringify(first.metrics));
  assert.deepEqual(await replays(), [], "no replay run");
  const [record] = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual({ decided: record.decided, source: record.source, digest: record.digest }, { decided: "promote", source: "dry_run", digest: DIGEST });
  assert.match(record.reason, /3 graded inputs it fits, fewer than 5: promoted on its passing dry run/);
});

/** One guarded agent step (its own confidence, `self`), its guard at `threshold`. */
const guardedFlow = (threshold) => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "agent", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", tools: [], tier: "fast", guard: { signal: "self", threshold } },
});

test("a replay held with a guard set too low gets one refit: the cheapest threshold within the bar lands as a new revision, promoted, and serves", { timeout: 180_000 }, async (t) => {
  // Odd questions: a wrong answer at confidence 0.3; even ones: right at 0.9. At threshold 0.1 the wrong ones serve.
  const submit = (text) => (/Question (\d+)/.exec(text)?.[1] % 2 === 1 ? { answer: 41, confidence: 0.3 } : { answer: 42, confidence: 0.9 });
  const flow = guardedFlow(0.1);
  const { server, start, replays, logs } = await world(t, { flows: [{ name: "answer", description: "Answers a question as a number", workflow: flow }], submit });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "agent");
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  // Record-only: every replay answered, its guard read at the least threshold the DSL takes.
  for (const row of runs) {
    assert.equal(row.metrics?.replay?.outcome, "answered", JSON.stringify(row.metrics));
    assert.deepEqual(row.metrics.guards.map(({ threshold, escalated }) => [threshold, escalated]), [[1e-9, false]]);
  }
  const second = await start("run-2", "What is seven times six");
  const records = await promotionsOf(server.settings, "agent-1");
  const held = records.find((one) => one.decided === "hold");
  assert.equal(held.digest, workflowDigest({ workflow: JSON.stringify(flow) }));
  assert.deepEqual({ wf_acc: held.replay.wf_acc, agent_acc: held.replay.agent_acc }, { wf_acc: 0.5, agent_acc: 1 });
  const refit = records.at(-1);
  assert.deepEqual({ decided: refit.decided, source: refit.source, from: refit.refit.from, guards: refit.refit.guards }, { decided: "promote", source: "refit", from: held.digest, guards: [{ node: "answer", was: 0.1, threshold: 0.9 }] });
  assert.deepEqual({ wf_acc: refit.replay.wf_acc, delta: refit.replay.delta, handed_back: refit.replay.handed_back }, { wf_acc: 1, delta: 0, handed_back: 3 });
  assert.ok(logs.some((line) => /refit answer's guards over its replay held it \(6 rows\): answer 0\.1 -> 0\.9/.test(line)), logs.join("\n"));
  // The held digest never serves: its refit, promoted on its rows, is the champion and serves this same run from its commit.
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", refit.digest], JSON.stringify(second.metrics));
  assert.equal(typeof refit.commit, "string", "the refit's record names its learning commit");
  // The new revision is on the learning folder's main, at the refit's digest: the next run is laid from it.
  const third = await start("run-3", "Question 4");
  assert.equal(third.metrics?.workflow_digest, refit.digest, JSON.stringify(third.metrics));
  assert.equal(third.metrics?.path, "workflow", "an even question: sure enough, it serves");
  const fourth = await start("run-4", "Question 5");
  assert.equal(fourth.metrics?.path, "handed_back", "an odd one: under 0.9, handed back to the agent");
});

/** answerFlow's revision: its step's instructions changed (a wrong served grade's revise), so its digest is new. */
const revisedFlow = { ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions: "Answer the question, revision two; say whether you are sure." }, answerFlow.root.steps[1]] } };
const REVISED = workflowDigest({ workflow: JSON.stringify(revisedFlow) });

/** `run` (served at `digest`) graded wrong, then `flow`, its revision, landed on the folder's main from `seed`, as the
 *  end-of-run turn lands one. */
async function reviseOn(w, run, digest, flow, seed) {
  await putGrade(w.server.settings, "agent-1", { run, correct: false, source: "feedback", at: new Date().toISOString(), path: "workflow", workflow: "answer", digest });
  const folder = learningWorkspace({ mode: "local", data: w.dir, agentId: "agent-1" });
  try {
    const merged = await learningCommit(folder.workspace, { kind: "merge", runId: `revise-${run}`, reason: `revise answer: ${run} was graded wrong`, graded: {}, seed,
      files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(flow) }, { path: "workflows/answer/README.md", text: readmeOf("answer", "Answers a question as a number") }] });
    assert.equal(merged.ok, true, JSON.stringify(merged));
  } finally {
    await folder.end();
  }
}

/** A revision's answer: 42 on the graded questions (their expected answer), and on the questions the champion served and
 *  was graded wrong for (42 there), another answer: a revision promotes only by answering those right by the grade, never
 *  by saying what was graded wrong again. The champion says 42 throughout. */
const revisedSubmit = (text) => ({ answer: text.includes("revision") && !text.includes("Question ") ? 54 : 42, sure: true });

/** The world with answerFlow promoted at the folder's seed (the champion, as a claim records it), one run it served graded
 *  wrong, then its revision landed on the folder's main as the end-of-run turn lands one. That served run is a graded
 *  input too (path workflow): the revision replays on it and the six graded runs, seven replay runs. */
async function championWorld(t, opts = {}) {
  const w = await world(t, { submit: revisedSubmit, ...opts });
  await recordPromotion(w.server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", source: "dry_run", reason: "promoted on its passing dry run", commit: w.seed }, (was) => was === undefined);
  const served = await w.start("run-1", "What is six times seven");
  assert.deepEqual([served.metrics?.path, served.metrics?.workflow_digest], ["workflow", DIGEST], "the champion serves");
  await reviseOn(w, "run-1", DIGEST, revisedFlow, w.seed);
  const settled = async () => until(async () => {
    const mine = (await w.server.runs.list({ agentId: "agent-1" })).filter((row) => !/^run-/.test(row.id));
    return mine.length === 7 && mine.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && mine;
  }, "the revision's seven replay runs ended");
  return { ...w, settled };
}

test("champion/challenger: a served champion graded wrong gets a revision; the champion serves while it replays; once its replay promotes it, the revision serves", { timeout: 180_000 }, async (t) => {
  const { server, start, settled, logs } = await championWorld(t);
  // The revision replays on the agent's graded inputs; the champion's digest serves this run meanwhile, never the agent.
  const second = await start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves while its revision replays: ${JSON.stringify(second.metrics)}\n${logs.join("\n")}`);
  assert.ok(logs.some((line) => line.includes(`champion at ${DIGEST} serves this run while ${REVISED} is not promoted`)), logs.join("\n"));
  assert.deepEqual(servingOf(await promotionsOf(server.settings, "agent-1")), [{ workflow: "answer", digest: DIGEST, replaying: REVISED }]);
  const runs = await settled();
  for (const row of runs) assert.deepEqual([row.metrics?.path, row.metrics?.workflow_digest, row.metrics?.replay?.outcome], ["replay", REVISED, "answered"], JSON.stringify(row.metrics));
  // Its replay is within the bar: promoted, and the next run is the revision's.
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", REVISED], JSON.stringify(third.metrics));
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.filter((one) => one.digest === REVISED).map(({ decided }) => decided), ["replaying", "promote"]);
  assert.ok(records.every((one) => typeof one.commit === "string"), "every record names the learning commit its text is at");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: REVISED, replaying: null }]);
});

test("champion/challenger: a revision its replay holds never serves; the champion keeps serving", { timeout: 180_000 }, async (t) => {
  // The revision answers 41 where the graded answer is 42; the champion answers 42.
  const submit = (text) => ({ answer: text.includes("revision two") ? 41 : 42, sure: true });
  const { server, start, settled } = await championWorld(t, { submit });
  const second = await start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST]);
  await settled();
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", DIGEST], `held: the champion still serves: ${JSON.stringify(third.metrics)}`);
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.filter((one) => one.digest === REVISED).map(({ decided }) => decided), ["replaying", "hold"]);
  assert.equal(records.filter((one) => one.digest === DIGEST).at(-1).decided, "promote", "a held revision never stops its champion");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: DIGEST, replaying: null }]);
});

/** revisedFlow's own revision (a second wrong served grade's), so its digest is new again. */
const thirdFlow = { ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions: "Answer the question, revision three; say whether you are sure." }, answerFlow.root.steps[1]] } };
const THIRD = workflowDigest({ workflow: JSON.stringify(thirdFlow) });
const FINAL = ["ended", "failed", "stopped"];

/** thirdFlow's own revision (a third wrong served grade's). */
const fourthFlow = { ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions: "Answer the question, revision four; say whether you are sure." }, answerFlow.root.steps[1]] } };
const FOURTH = workflowDigest({ workflow: JSON.stringify(fourthFlow) });

test("one replay at a time, and a running replay finishes: drafts that come meanwhile queue, the older one skipped for the newest, which replays next once the running replay is decided (its verdict stands), across a restart", { timeout: 240_000 }, async (t) => {
  // Revision two's replay runs ask the model and are held there, in flight, until released.
  const w = await championWorld(t, { hold: (body) => body.includes("revision two") });
  const { server, start, logs, proxy, dir, restart } = w;
  const replaysOf = async (digest) => (await server.runs.list({ agentId: "agent-1" })).filter((row) => !/^run-/.test(row.id)).filter((row) => row.id && digestOf.get(row.id) === digest);
  const digestOf = new Map();
  const decidedOf = (records, digest) => records.filter((one) => one.digest === digest).map(({ decided }) => decided);
  const second = await start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves while revision two replays: ${logs.join("\n")}`);
  const firstReplay = (await promotionsOf(server.settings, "agent-1")).find((one) => one.digest === REVISED && one.decided === "replaying");
  assert.equal(firstReplay?.runs?.length, 7, "revision two replays on the six graded inputs and run-1, the champion's run graded wrong");
  for (const id of firstReplay.runs) digestOf.set(id, REVISED);
  await until(() => proxy.holding.size === 7, "revision two's seven replay runs in flight, each held at its model request");
  // Draft B: revision three lands on the folder's main while revision two replays. A run's claim queues it.
  await reviseOn(w, "run-2", DIGEST, thirdFlow, (await seedOf(dir, "agent-1")).sha);
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves while revision three waits: ${JSON.stringify(third.metrics)}\n${logs.join("\n")}`);
  let records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual([decidedOf(records, REVISED), decidedOf(records, THIRD)], [["replaying"], ["queued"]], JSON.stringify(records));
  assert.match(records.at(-1).reason, new RegExp(`queued behind ${REVISED}'s replay on 7 graded inputs`));
  assert.equal(proxy.holding.size, 7, "revision two's replay runs are still at work: none cancelled");
  // Draft C: revision four lands on top. Its claim queues it, and skips revision three, naming it.
  await reviseOn(w, "run-3", DIGEST, fourthFlow, (await seedOf(dir, "agent-1")).sha);
  const fourth = await start("run-4", "What is seven times six, again");
  assert.deepEqual([fourth.metrics?.path, fourth.metrics?.workflow_digest], ["workflow", DIGEST], JSON.stringify(fourth.metrics));
  records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual([decidedOf(records, REVISED), decidedOf(records, THIRD), decidedOf(records, FOURTH)], [["replaying"], ["queued", "skipped"], ["queued"]], JSON.stringify(records));
  const skipped = records.filter((one) => one.digest === THIRD).at(-1);
  assert.equal(skipped.skipped_by, FOURTH);
  assert.equal(skipped.reason, `a newer draft ${FOURTH} arrived before its replay could start: only the newest queued revision replays next`);
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: DIGEST, replaying: REVISED }], "the console reads revision two replaying");
  assert.equal(proxy.holding.size, 7, "still none cancelled");
  // Revision two's replay finishes: every run ends answered, never cancelled.
  proxy.release();
  const finished = await until(async () => {
    const rows = await replaysOf(REVISED);
    return rows.length === 7 && rows.every((row) => FINAL.includes(row.state) && row.runner === null) && rows;
  }, "revision two's replay runs ended");
  for (const row of finished) assert.deepEqual([row.state, row.metrics?.replay?.outcome], ["ended", "answered"], JSON.stringify(row));
  // The queue is the records in the store: a restarted runner's next claim decides revision two (its verdict stands:
  // promoted, it serves) and starts revision four's replay. Revision three never replays.
  await restart();
  const fifth = await start("run-5", "What is six times seven, once more");
  assert.deepEqual([fifth.metrics?.path, fifth.metrics?.workflow_digest], ["workflow", REVISED], `revision two, promoted by its finished replay, serves while revision four replays: ${JSON.stringify(fifth.metrics)}\n${logs.join("\n")}`);
  records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual([decidedOf(records, REVISED), decidedOf(records, THIRD), decidedOf(records, FOURTH)], [["replaying", "promote"], ["queued", "skipped"], ["queued", "replaying"]], JSON.stringify(records));
  const fourthReplay = records.findLast((one) => one.digest === FOURTH);
  assert.equal(fourthReplay.runs.length, 9, "revision four replays on the six graded inputs and the three served runs graded wrong");
  for (const id of fourthReplay.runs) digestOf.set(id, FOURTH);
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: REVISED, replaying: FOURTH }]);
  await until(async () => {
    const rows = await replaysOf(FOURTH);
    return rows.length === 9 && rows.every((row) => FINAL.includes(row.state) && row.runner === null);
  }, "revision four's replay runs ended");
  // Revision four's replay gets its verdict: within the bar, it serves the next run. Replay runs in all: 7 + 9.
  const sixth = await start("run-6", "What is seven times six, once more");
  assert.deepEqual([sixth.metrics?.path, sixth.metrics?.workflow_digest], ["workflow", FOURTH], JSON.stringify(sixth.metrics));
  const all = (await server.runs.list({ agentId: "agent-1" })).filter((row) => !/^run-/.test(row.id));
  assert.equal(all.length, 16, "every replay run is revision two's or four's (7 and 9), none of revision three");
  const after = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(decidedOf(after, FOURTH), ["queued", "replaying", "promote"]);
  assert.deepEqual(servingOf(after), [{ workflow: "answer", digest: FOURTH, replaying: null }]);
  for (const line of [`${THIRD} is new: queued behind ${REVISED}'s replay`, `${THIRD} skipped: a newer draft ${FOURTH}`, `${REVISED} promoted:`, `${FOURTH} is next: replaying it`]) assert.ok(logs.some((one) => one.includes(line)), `${line}\n${logs.join("\n")}`);
});

test("a replay whose workflow fails on every input (a step failed: a credential or tool the replay ran without) is no evidence: held, never promoted on the agent's answers", { timeout: 180_000 }, async (t) => {
  // The node's answer is off its schema every time: the step fails, the workflow hands the run back on a failure.
  const { server, start, replays } = await world(t, { submit: () => ({ answer: "forty-two", sure: true }) });
  await start("run-1", "What is six times seven");
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => FINAL.includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  assert.deepEqual(runs.map((row) => row.metrics?.replay?.outcome), runs.map(() => "failed"), JSON.stringify(runs.map((row) => row.metrics)));
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", `held: the agent takes the run: ${JSON.stringify(second.metrics)}`);
  const decided = (await promotionsOf(server.settings, "agent-1")).at(-1);
  assert.deepEqual({ decided: decided.decided, source: decided.source, n: decided.replay.n }, { decided: "hold", source: "replay", n: 0 });
  assert.match(decided.reason, /only 0 replays answered or handed back \(6 failed/);
});

test("a replay run its claim cannot lay at its digest ends failed: the agent is never asked", { timeout: 120_000 }, async (t) => {
  const { server, gw, launchOf, ended } = await world(t);
  await server.runs.create({ id: "replay-stale", agentId: "agent-1", revisionId: "rev-1" }, { body: { ...launchOf("Question 0"), replay: { of: "graded-0", workflow: "answer", digest: "0000000000000000" } } });
  const row = await ended("replay-stale");
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.match(row.summary ?? "", /laid no workflow by that name at that digest/);
  assert.equal(gw.requests.length, 0, "no model request: neither the workflow nor the agent ran");
});

test("a replay run whose revision was decided already never runs, its cancel lost or not", { timeout: 120_000 }, async (t) => {
  const { server, gw, launchOf, ended } = await world(t);
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "hold", source: "replay", reason: "held at its deadline", runs: ["replay-orphan"] }, (was) => was === undefined);
  await server.runs.create({ id: "replay-orphan", agentId: "agent-1", revisionId: "rev-1" }, { body: { ...launchOf("Question 0"), replay: { of: "graded-0", workflow: "answer", digest: DIGEST } } });
  const row = await ended("replay-orphan");
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.match(row.summary ?? "", /that revision is held already/);
  assert.equal(gw.requests.length, 0, "no model request");
});

test("a held replay's leftover run never runs once its revision replays again: only the newer replay's runs claim", { timeout: 120_000 }, async (t) => {
  const { server, gw, launchOf, ended } = await world(t);
  const at = () => new Date().toISOString();
  // Replay A held at its deadline, its cancel lost: run replay-a-left is still queued. Its owner then starts replay B.
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: at(), decided: "hold", source: "replay", reason: "held at its deadline", runs: ["replay-a-left"], inputs: ["graded-0"], replay_id: "replay-a" }, (was) => was === undefined);
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: at(), decided: "replaying", source: "replay", reason: "replaying again", runs: ["replay-b-0"], inputs: ["graded-0"], replay_id: "replay-b" }, (was) => was?.decided === "hold");
  const replayBody = { ...launchOf("Question 0"), replay: { of: "graded-0", workflow: "answer", digest: DIGEST } };
  await server.runs.create({ id: "replay-a-left", agentId: "agent-1", revisionId: "rev-1" }, { body: replayBody });
  const left = await ended("replay-a-left");
  assert.equal(left.state, "failed", JSON.stringify(left));
  assert.match(left.summary ?? "", /not one of its runs/);
  assert.equal(gw.requests.length, 0, "no model request: replay A's leftover spent nothing");
  await server.runs.create({ id: "replay-b-0", agentId: "agent-1", revisionId: "rev-1" }, { body: replayBody });
  const own = await ended("replay-b-0");
  assert.equal(own.state, "ended", JSON.stringify(own));
  assert.ok(gw.requests.some((request) => isNode(request)), "replay B's own run ran its workflow");
});

test("a run pinned to an older revision, launched after the newest one's replay started, never supersedes it: the champion serves it", { timeout: 180_000 }, async (t) => {
  const w = await championWorld(t);
  const { server, start, startPinned, logs, dir } = w;
  // Revision two is on main (no claim laid it yet); revision three lands on top of it, and a run at main starts its replay.
  const two = (await seedOf(dir, "agent-1")).sha;
  await reviseOn(w, "run-1b", DIGEST, thirdFlow, two);
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", DIGEST]);
  assert.equal((await promotionsOf(server.settings, "agent-1")).filter((one) => one.digest === THIRD).at(-1)?.decided, "replaying");
  // A run pinned to revision two's commit, made after revision three's replay started.
  const old = await startPinned("run-old", "What is seven times six", two);
  assert.deepEqual([old.metrics?.path, old.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves the older pin: ${JSON.stringify(old.metrics)}\n${logs.join("\n")}`);
  const records = await promotionsOf(server.settings, "agent-1");
  assert.equal(records.filter((one) => one.digest === THIRD).at(-1)?.decided, "replaying", `revision three still replays: ${JSON.stringify(records)}`);
  assert.deepEqual(records.filter((one) => one.digest === REVISED), [], "revision two starts nothing");
  await until(async () => {
    const mine = (await server.runs.list({ agentId: "agent-1" })).filter((row) => !/^run-/.test(row.id));
    return mine.length === 7 && mine.every((row) => FINAL.includes(row.state) && row.runner === null);
  }, "revision three's replay runs ended: the six graded inputs and run-1 (run-1b is graded, never ran)");
});

test("a revision that adds a required input field leaves its champion serving the inputs the champion takes", { timeout: 180_000 }, async (t) => {
  const w = await world(t);
  const { server, start, seed } = w;
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", source: "dry_run", reason: "promoted on its passing dry run", commit: seed }, (was) => was === undefined);
  // The revision asks for a locale too: a run with a question alone does not fit it, and does fit the champion.
  const wide = { ...answerFlow, schemas: { ...answerFlow.schemas, In: { type: "object", required: ["question", "locale"], properties: { question: { type: "string" }, locale: { type: "string" } } } } };
  await reviseOn(w, "served-0", DIGEST, wide, seed);
  const run = await start("run-1", "What is six times seven");
  assert.deepEqual([run.metrics?.path, run.metrics?.workflow_digest], ["workflow", DIGEST], JSON.stringify(run.metrics));
});

test("a held revision whose input the champion does not take: the agent takes the run, and its learned_workflow tool runs the champion, never the held revision", { timeout: 180_000 }, async (t) => {
  const w = await world(t);
  const { server, gw, logs, seed, dir, ended, launchOf } = w;
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", source: "dry_run", reason: "promoted on its passing dry run", commit: seed }, (was) => was === undefined);
  // The revision on the folder's main takes a `query` where the champion takes a `question`; its replay held it.
  const renamed = { ...answerFlow, schemas: { ...answerFlow.schemas, In: { type: "object", required: ["query"], properties: { query: { type: "string" } } } } };
  await reviseOn(w, "served-0", DIGEST, renamed, seed);
  const main = (await seedOf(dir, "agent-1")).sha;
  const held = workflowDigest({ workflow: JSON.stringify(renamed) });
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: held, at: new Date().toISOString(), decided: "hold", source: "replay", reason: "replayed on 6 graded inputs: more than 2 pts under the agent", commit: main }, (was) => was === undefined);
  // A run whose input the held revision takes and the champion does not: nothing serves it first.
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { ...launchOf("What is six times seven", main), input: { content: "What is six times seven?", query: "What is six times seven" } } });
  const run = await ended("run-1");
  assert.equal(run.metrics?.path, "agent", JSON.stringify(run.metrics));
  // The agent's tool runs the champion (its input line names `question`), never the held revision (`query`).
  const tools = gw.requests.filter((request) => !isNode(request)).map((request) => (request.body?.tools ?? []).find((tool) => tool?.name === "learned_workflow"));
  assert.ok(tools.length > 0 && tools.every(Boolean), "the agent is offered the learned_workflow tool on every turn");
  for (const tool of tools) {
    assert.match(tool.description, /question/, tool.description);
    assert.doesNotMatch(tool.description, /query/, `the held revision is never the agent's to run: ${tool.description}`);
  }
  assert.ok(logs.some((line) => line.includes(`the learned_workflow tool runs answer's champion at ${DIGEST}, not ${held}, which is not promoted`)), logs.join("\n"));
});
