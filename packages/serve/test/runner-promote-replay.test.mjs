// A new revision's one check through the runner (runner/promotion.ts startCheck/settleCheck, learn/promote.ts): a
// learned workflow's new digest does not serve first until a replay of it on the inputs of the agent's last
// compile_after completed runs clears the bar against the agent's own recorded answers.
//   - the first fitting run goes to the agent while the digest is checked: one replay run per input, each the workflow
//     alone at workflow cost (path `replay`, no agent request, no end-of-run turn);
//   - a later run, every replay ended, is served first once the draft answered enough inputs alone and enough of those
//     said what the agent said;
//   - a replay the workflow hands back on is never an answer alone: one that hands back every input is held;
//   - a replay whose answers differ from the agent's holds the digest: the run after it is the agent's;
//   - no completed run of the agent's it fits: never promoted; it stops, its record naming why ("nothing to check it on");
//   - every reserved input counts: a replay run never created by the check's deadline is a failed input;
//   - champion/challenger: a promoted digest (the champion) keeps serving while a newer revision of it is checked, and
//     after that revision's check holds it; the revision serves only once its check promotes it;
//   - one check at a time, and a running check finishes: a newer revision that comes while another is checked waits,
//     recording nothing (no queue); the check at work is decided at a claim once its runs ended (its verdict stands),
//     then the newest revision is checked; a restart keeps all of it (records in the store); "newer" is the learning
//     folder's main, never a run's launch time: a run pinned to an older commit starts nothing;
//   - a replay that failed on its inputs (a step failed) is no answer alone: held, never promoted on the agent's answers;
//   - a replay run runs only while its revision replays, and only on that revision: else it ends failed, no agent;
//   - a revision whose input the run does not fit (a new required field) leaves its champion serving the run.
// The agent's earlier runs are real runs of the store (its list, launches and journals), on a pi run of the faux gateway.
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
const { promotionsOf, recordPromotion, servingOf } = await import("../dist/learn/promote.js");
const { replayView } = await import("../dist/runner/promotion.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { PAST_RUNS, workflowDigest } = await import("../dist/runner/workflow-first.js");
const { seedOf } = await import("../dist/learning.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** The agent's own answer to every question, in the output format the workflow gives it: what a check scores against. */
const AGENT_SAYS = JSON.stringify({ answer: 42, sure: true });

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
const FINAL = ["ended", "failed", "stopped"];

/** DIGEST's records once run-2 (the agent's: its check held the draft) ended. Its end asked the one revision; the faux
 *  model's answer holds no draft, so that revision's failed draft is the newest record (compile once: the recompile's
 *  attempt, stopped). */
async function heldThenRevisionFailed(server) {
  const records = await promotionsOf(server.settings, "agent-1");
  const failed = records.at(-1);
  assert.deepEqual([failed.workflow, failed.decided, failed.check?.attempt, failed.check?.n, failed.check?.stopped], ["answer", "hold", 2, 0, true], JSON.stringify(failed));
  assert.match(failed.reason, /^its draft failed its checks: .+It was the recompile, so it stops/);
  return records.filter(({ digest }) => digest === DIGEST);
}
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

/** An agent of `learning` whose `prior` earlier runs ("Question 0" … , oldest first) ended on its own path, answering
 *  `says`, before `flows` landed in its learning folder, and a runner claiming every run from its stored launch. The
 *  node submits `submit(requestText)` ({answer: 42, sure: true} by default). `hold`: a model request whose body it
 *  matches is held until its run is cancelled or `proxy.release()`. */
async function world(t, { prior = 6, learning = true, says = AGENT_SAYS, flows = FLOWS, submit, hold, env = {}, runsCreate, pastUnread = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-promote-replay-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const opened = await openSqliteStore({ dataDir: dir, role: "runner" });
  // `runsCreate(create, run, launch)`: the runner's runs.create, in its place (a test's interleave before a create).
  // `pastUnread`: the money rule's read of the agent's past runs fails on the runner (it fails closed).
  const runs = (runsCreate || pastUnread) && new Proxy(opened.runs, { get: (target, key) => {
    if (key === "create" && runsCreate) return (run, launch) => runsCreate(opened.runs.create, run, launch);
    if (key === "list" && pastUnread) return async (filter) => {
      if (filter?.limit === PAST_RUNS) throw new Error("the past runs could not be read");
      return target.list(filter);
    };
    return typeof target[key] === "function" ? target[key].bind(target) : target[key];
  } });
  const store = runs ? new Proxy(opened, { get: (target, key) => (key === "runs" ? runs : typeof target[key] === "function" ? target[key].bind(target) : target[key]) }) : opened;
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submit ? submit(JSON.stringify(body)) : { answer: 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : says),
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
  const proxy = hold ? await holdingProxy(t, gw.url, hold) : undefined;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: proxy?.url ?? gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  /** The runner stopped and a new one started, as a server restart starts one: nothing of the last one's memory kept. */
  const restart = async () => {
    await runner.close();
    runner = startRunner({ store, name: "runner-b", ...TIMING, createLoop: createAdapterLoop(specOf) });
  };
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, at) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(at ? { learning: startAt(at) } : {}) });
  // The agent's earlier runs: each ended before the next starts (the newest last), no learning start, the agent's own.
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    const row = await ended(`prior-${i}`);
    assert.deepEqual([row.state, row.metrics?.path], ["ended", undefined], JSON.stringify(row));
  }
  const seed = await landWorkflows(dir, "agent-1", flows);
  const start = async (id, question) => {
    // Launched as the server launches a run: at the learning folder's main now.
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, (await seedOf(dir, "agent-1")).sha) });
    return ended(id);
  };
  /** A run launched now pinned to learning commit `at`, as a run made before main moved is. */
  const startPinned = async (id, question, at) => {
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, at) });
    return ended(id);
  };
  /** The replay runs the agent's checks made (their launch names the run replayed), whatever their state. */
  const replays = async () => {
    const out = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) if ((await server.runs.launch(row.id)).body?.replay) out.push(row);
    return out;
  };
  const replaysEnded = (count) => until(async () => {
    const all = await replays();
    return all.length === count && all.every((row) => FINAL.includes(row.state) && row.runner === null) && all;
  }, `the ${count} replay runs ended`);
  return { server, gw, logs, start, startPinned, launchOf, ended, replays, replaysEnded, seed, dir, proxy, restart };
}

const PRIORS = Array.from({ length: 6 }, (_, i) => `prior-${i}`);

test("a new digest is checked before it serves: the agent takes the run meanwhile, its tool never given the revision; at the bar, the next run is served first", { timeout: 180_000 }, async (t) => {
  const { server, gw, logs, start, replaysEnded } = await world(t);
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.state, "ended");
  assert.equal(first.metrics?.path, "agent", `the agent took the run while its workflow is checked: ${JSON.stringify(first.metrics)}`);
  assert.ok(logs.some((line) => line.includes(`answer at ${DIGEST} is new: checking it on 6 inputs of the agent's last 20 completed runs against its own answers before it serves`)), logs.join("\n"));
  // Nothing of the workflow serves while its only revision is checked: the agent's learned_workflow tool is not given it
  // to run in the workflow's place either (chain14b: four runs ran a replaying draft through the tool).
  const asked = gw.requests.filter((request) => !isNode(request));
  assert.ok(asked.length > 0, "the agent took the run");
  assert.deepEqual(asked.filter((request) => offers(request.body, "learned_workflow")).length, 0, "no learned_workflow tool: no revision of it is promoted");
  assert.ok(logs.some((line) => line.includes(`the learned_workflow tool leaves out answer: ${DIGEST} is not promoted, and no revision of it serves`)), logs.join("\n"));
  // One replay run an input, each the workflow alone: path replay, answered, at workflow cost, no end-of-run turn.
  const runs = await replaysEnded(6);
  for (const row of runs) {
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.equal(row.metrics?.path, "replay");
    assert.equal(row.metrics?.workflow_digest, DIGEST);
    assert.equal(row.metrics?.replay?.outcome, "answered");
    assert.ok(row.costUsd > 0, "at workflow cost: its node's request");
    assert.equal(await server.learning.proposal(row.id), undefined, "a replay asks nothing at its end");
  }
  assert.deepEqual(runs.map((row) => row.metrics.replay.of).sort(), PRIORS, "the agent's own completed runs, never run-1 (the claimed one)");
  const agentRequests = gw.requests.filter((request) => !isNode(request)).length;
  // The next fitting run: the check is in, at the bar: promoted, and it serves first.
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "workflow", JSON.stringify(second.metrics));
  assert.equal(gw.requests.filter((request) => !isNode(request)).length, agentRequests, "no agent request for the served run");
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.map(({ decided }) => [decided]), [["replaying"], ["promote"]]);
  const { fields, ...check } = records[1].check;
  assert.deepEqual({ ...check, of: [...check.of].sort() }, { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 6, agreed: 6, alone: 6, agent_agreed: 6, of: PRIORS, cost_usd: check.cost_usd, outcomes: { answered: 6, handed_back: 0, failed: 0, skipped_write: 0 } });
  assert.ok(check.cost_usd > 0, "what the check cost is on its record");
  assert.deepEqual(Object.entries(fields).map(([name, one]) => [name, one.n, one.workflow_right, one.known, one.pass]), [["answer", 6, 6, "agent", true]], "the whole answer, judged against the agent's own");
  assert.equal(records[1].digest, DIGEST);
});

// The money rule takes a workflow off a learning run's own tool (workflow-first.ts toolStopsOf), failing closed when the
// agent's past runs can't be read; a replay runs its revision whatever that read says (it serves no one, and is checked).
test("a replay runs its revision whatever the money rule can read: with the agent's past runs unreadable, each replay answers alone", { timeout: 180_000 }, async (t) => {
  const { start, replaysEnded } = await world(t, { pastUnread: true });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "agent", JSON.stringify(first.metrics));
  for (const row of await replaysEnded(6)) {
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.deepEqual([row.metrics?.path, row.metrics?.replay?.outcome], ["replay", "answered"], JSON.stringify(row.metrics));
  }
});

test("a check the workflow hands back on every input is held (it would never answer alone); its escalate on a draft stays hard in the replay, and no agent turn ran in it", { timeout: 180_000 }, async (t) => {
  const { server, gw, start, replaysEnded } = await world(t, { submit: () => ({ answer: 42, sure: false }) });
  await start("run-1", "What is six times seven");
  const agentAfterFirst = gw.requests.filter((request) => !isNode(request)).length;
  const runs = await replaysEnded(6);
  assert.deepEqual(runs.map((row) => [row.state, row.metrics?.replay?.outcome]), runs.map(() => ["ended", "handed_back"]));
  assert.equal(gw.requests.filter((request) => !isNode(request)).length, agentAfterFirst, "a hand-back in replay asks the agent nothing");
  const second = await start("run-2", "What is seven times six");
  // Every input handed back: it never answered alone: held, and nothing serves: the next run is the agent's.
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const records = await heldThenRevisionFailed(server);
  assert.deepEqual(records.map(({ decided }) => [decided]), [["replaying"], ["hold"]]);
  const decided = records.at(-1);
  assert.deepEqual({ n: decided.check.n, alone: decided.check.alone, agreed: decided.check.agreed, handed_back: decided.check.outcomes.handed_back }, { n: 6, alone: 0, agreed: 0, handed_back: 6 });
  assert.deepEqual(decided.check.disagreements.map((one) => [one.agent, typeof one.escalated, one.draft]), decided.check.disagreements.map(() => [AGENT_SAYS, "string", undefined]));
  assert.match(decided.reason, /^checked on 6 of the agent's inputs: answered 0 alone \(0\.0%, the bar 70\.0%\).*: held; the agent's next run recompiles it once/);
});

test("a check whose answers differ from the agent's holds the digest: the next run is the agent's", { timeout: 180_000 }, async (t) => {
  const { server, start, replaysEnded, logs } = await world(t, { submit: () => ({ answer: 41, sure: true }) });
  await start("run-1", "What is six times seven");
  await replaysEnded(6);
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const decided = (await heldThenRevisionFailed(server)).at(-1);
  assert.deepEqual({ decided: decided.decided, n: decided.check.n, alone: decided.check.alone, agreed: decided.check.agreed }, { decided: "hold", n: 6, alone: 6, agreed: 0 });
  assert.deepEqual(decided.check.disagreements.map((one) => [one.agent, one.draft]), decided.check.disagreements.map(() => [AGENT_SAYS, JSON.stringify({ answer: 41, sure: true })]));
  assert.deepEqual([decided.check.fields.answer.workflow_right, decided.check.fields.answer.pass], [0, false]);
  assert.deepEqual(decided.check.disagreements.map((one) => one.fields), decided.check.disagreements.map(() => ["answer"]), "each disagreement names the field it had wrong");
  assert.ok(logs.some((line) => line.includes(`answer at ${DIGEST} held:`)), logs.join("\n"));
});

test("a replay whose agent run is purged after the check read its input is never started (the store refuses it, nothing written): the check's other replay runs start, and the claimed run is the agent's", { timeout: 180_000 }, async (t) => {
  const { server, start, replays, replaysEnded, logs } = await world(t, {
    // The DELETE of prior-2 lands between the check's read of its launch and its replay's create.
    runsCreate: async (create, run, launch) => {
      if (launch?.body?.replay?.of === "prior-2") await server.runs.purge("prior-2", { meters: null, spend: { usd: null }, learning: null });
      return create(run, launch);
    },
  });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "agent", JSON.stringify(first.metrics));
  const made = await replaysEnded(5);
  assert.deepEqual(made.map((row) => row.metrics.replay.of).sort(), PRIORS.filter((id) => id !== "prior-2"), "every other input's replay started");
  assert.ok(logs.some((line) => /the replay \S+ is not started: the run it replays was purged/.test(line)), logs.join("\n"));
  assert.ok((await server.runs.get("prior-2")).purgedAt !== null);
  assert.equal((await replays()).length, 5, "no replay of the purged run is written");
});

// Review on #3032 (PRRT_kwDOUmdVMs64I-7l): a promotion with no input raced a newer revision's check. There is none now: a
// draft with nothing to check it on is never promoted. It stops with its cause on the record, and spends no recompile.
test("nothing to check it on (no completed run of the agent's it takes): never promoted; it stops naming the cause, and later runs check nothing", { timeout: 120_000 }, async (t) => {
  const { server, start, replays } = await world(t, { prior: 0 });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "agent", `never served unchecked: ${JSON.stringify(first.metrics)}`);
  assert.deepEqual(await replays(), [], "no replay run");
  const [record, ...more] = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(more, []);
  assert.deepEqual({ decided: record.decided, digest: record.digest, n: record.check.n, stopped: record.check.stopped, attempt: record.check.attempt }, { decided: "hold", digest: DIGEST, n: 0, stopped: true, attempt: 1 });
  assert.equal(record.reason, "nothing to check it on: the agent has no completed run of its own to check it against. It is not promoted, and it stops: nothing compiles again until a hold or its owner acts");
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  assert.deepEqual(await promotionsOf(server.settings, "agent-1"), [record], "stopped: no check starts again, nothing is promoted");
  assert.deepEqual(await replays(), []);
});

// Review on #3032 (PRRT_kwDOUmdVMs64I-7e): every reserved input counts. The server stopped after creating one of a
// check's 20 replay runs; past the check's deadline the 19 never created are failed inputs, so the one that agreed is
// 1 of 20, never 1 of 1.
test("a check whose launch was interrupted after 1 of its 20 runs, decided past its deadline after a restart: the 19 never created are failed inputs, so it is held, never promoted", { timeout: 180_000 }, async (t) => {
  const { server, start, replaysEnded, restart, logs } = await world(t);
  await start("run-1", "What is six times seven");
  const [made] = await replaysEnded(6);
  const [reserved] = await promotionsOf(server.settings, "agent-1");
  assert.equal(reserved.decided, "replaying");
  // The record as a launch interrupted after its first create left it, an hour and more ago: 20 reserved, 1 created.
  const at = made.metrics.replay.of;
  const missing = Array.from({ length: 19 }, (_, i) => `never-created-${i}`);
  const interrupted = { ...reserved, at: new Date(0).toISOString(), runs: [made.id, ...missing], inputs: [at, ...missing.map((_, i) => PRIORS[i % PRIORS.length])], replay_id: "interrupted", check: { ...reserved.check, compile_after: 20 } };
  assert.equal((await recordPromotion(server.settings, "agent-1", interrupted, () => true)).won, true);
  await restart();
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", `never promoted on the one input that ran: ${JSON.stringify(second.metrics)}\n${logs.join("\n")}`);
  const decided = (await heldThenRevisionFailed(server)).at(-1);
  assert.deepEqual({ decided: decided.decided, n: decided.check.n, alone: decided.check.alone, agreed: decided.check.agreed }, { decided: "hold", n: 20, alone: 1, agreed: 1 }, JSON.stringify(decided));
  assert.equal(decided.check.disagreements.filter((one) => one.failed).length, 19, "each one never created is a failed input");
  assert.match(decided.reason, /^checked on 20 of the agent's inputs: answered 1 alone \(5\.0%, the bar 70\.0%\); .* \(19 never started by the check's deadline/);
  assert.equal(await server.runs.get(missing[0]), undefined, "past its deadline nothing is created for it");
  // Carried from #3032 (PRRT_kwDOUmdVMs64NjVq): the outcomes are the check's rows, so they add up to its n: the 19 never
  // created are failed, on the record and over v2's replay read.
  const outcomes = { answered: 1, handed_back: 0, failed: 19, skipped_write: 0 };
  assert.deepEqual(decided.check.outcomes, outcomes, JSON.stringify(decided.check));
  assert.equal(decided.check.unstarted, 19, "the record says how many were never created");
  assert.doesNotMatch(decided.reason, /\(\d+ failed: a step failed/, `a run never created is said once, as never started: ${decided.reason}`);
  const view = await replayView({ store: server, agentId: "agent-1" }, "answer", DIGEST, "interrupted");
  assert.deepEqual({ status: view.status, decided: view.decided, inputs: view.inputs, outcomes: view.outcomes, n: view.score.n }, { status: "done", decided: "hold", inputs: 20, outcomes, n: 20 }, JSON.stringify(view));
});

// Every reserved run of a check never created (the server stopped right after reserving them): its read is failed, its
// rows all failed and all never started.
test("a check none of whose runs was ever created, decided past its deadline: v2's replay read is failed, every input failed and never started", { timeout: 180_000 }, async (t) => {
  const { server, start, replaysEnded, restart, logs } = await world(t);
  await start("run-1", "What is six times seven");
  await replaysEnded(6);
  const [reserved] = await promotionsOf(server.settings, "agent-1");
  const missing = Array.from({ length: 6 }, (_, i) => `never-created-${i}`);
  const interrupted = { ...reserved, at: new Date(0).toISOString(), runs: missing, inputs: reserved.inputs, replay_id: "none-created" };
  assert.equal((await recordPromotion(server.settings, "agent-1", interrupted, () => true)).won, true);
  await restart();
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", `${JSON.stringify(second.metrics)}\n${logs.join("\n")}`);
  // The held check's record: the recompile its hold asks then writes main's failed-draft hold after it (S3b).
  const decided = (await heldThenRevisionFailed(server)).at(-1);
  assert.deepEqual({ decided: decided.decided, n: decided.check.n, unstarted: decided.check.unstarted, outcomes: decided.check.outcomes }, { decided: "hold", n: 6, unstarted: 6, outcomes: { answered: 0, handed_back: 0, failed: 6, skipped_write: 0 } }, JSON.stringify(decided));
  const view = await replayView({ store: server, agentId: "agent-1" }, "answer", DIGEST, "none-created");
  assert.deepEqual({ status: view.status, decided: view.decided, inputs: view.inputs, failed: view.outcomes.failed }, { status: "failed", decided: "hold", inputs: 6, failed: 6 }, JSON.stringify(view));
});

/** answerFlow's revision: its step's instructions changed (a recompile), so its digest is new. */
const revisedFlow = { ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions: "Answer the question, revision two; say whether you are sure." }, answerFlow.root.steps[1]] } };
const REVISED = workflowDigest({ workflow: JSON.stringify(revisedFlow) });

/** Lands `flow`, a revision of answer, on the learning folder's main from `seed`, as a compile turn lands one. */
async function landRevision(w, runId, flow, seed) {
  const folder = learningWorkspace({ mode: "local", data: w.dir, agentId: "agent-1" });
  try {
    const merged = await learningCommit(folder.workspace, { kind: "merge", runId, reason: "revised answer", graded: {}, seed,
      files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(flow) }, { path: "workflows/answer/README.md", text: readmeOf("answer", "Answers a question as a number") }] });
    assert.equal(merged.ok, true, JSON.stringify(merged));
  } finally {
    await folder.end();
  }
}

/** The world with answerFlow promoted at the folder's seed (the champion, as a claim records it) serving one run, then
 *  its revision landed on the folder's main. The served run is no check input (the workflow answered it): the revision
 *  is checked on the agent's six earlier runs. */
async function championWorld(t, opts = {}) {
  const w = await world(t, opts);
  await recordPromotion(w.server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "promoted", commit: w.seed }, (was) => was === undefined);
  const served = await w.start("run-1", "What is six times seven");
  assert.deepEqual([served.metrics?.path, served.metrics?.workflow_digest], ["workflow", DIGEST], "the champion serves");
  await landRevision(w, "compile-1", revisedFlow, w.seed);
  return w;
}

test("champion/challenger: the champion serves while its revision is checked; once its check promotes it, the revision serves", { timeout: 180_000 }, async (t) => {
  const { server, start, replaysEnded, logs } = await championWorld(t);
  // The revision is checked on the agent's own inputs; the champion's digest serves this run meanwhile, never the agent.
  const second = await start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves while its revision is checked: ${JSON.stringify(second.metrics)}\n${logs.join("\n")}`);
  assert.ok(logs.some((line) => line.includes(`champion at ${DIGEST} serves this run while ${REVISED} is not promoted`)), logs.join("\n"));
  assert.deepEqual(servingOf(await promotionsOf(server.settings, "agent-1")), [{ workflow: "answer", digest: DIGEST, replaying: REVISED }]);
  const runs = await replaysEnded(6);
  for (const row of runs) assert.deepEqual([row.metrics?.path, row.metrics?.workflow_digest, row.metrics?.replay?.outcome], ["replay", REVISED, "answered"], JSON.stringify(row.metrics));
  assert.deepEqual(runs.map((row) => row.metrics.replay.of).sort(), PRIORS, "never run-1, which the champion answered");
  // Its check clears the bar: promoted, and the next run is the revision's.
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", REVISED], JSON.stringify(third.metrics));
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.filter((one) => one.digest === REVISED).map(({ decided }) => [decided]), [["replaying"], ["promote"]]);
  assert.ok(records.every((one) => typeof one.commit === "string"), "every record names the learning commit its text is at");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: REVISED, replaying: null }]);
});

test("champion/challenger: a revision its check holds never serves; the champion keeps serving", { timeout: 180_000 }, async (t) => {
  // The revision answers 41 where the agent said 42; the champion answers 42.
  const submit = (text) => ({ answer: text.includes("revision two") ? 41 : 42, sure: true });
  const { server, start, replaysEnded } = await championWorld(t, { submit });
  const second = await start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST]);
  await replaysEnded(6);
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", DIGEST], `held: the champion still serves: ${JSON.stringify(third.metrics)}`);
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.filter((one) => one.digest === REVISED).map(({ decided }) => decided), ["replaying", "hold"]);
  assert.equal(records.filter((one) => one.digest === DIGEST).at(-1).decided, "promote", "a held revision never stops its champion");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: DIGEST, replaying: null }]);
});

/** revisedFlow's own revision, so its digest is new again. */
const thirdFlow = { ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions: "Answer the question, revision three; say whether you are sure." }, answerFlow.root.steps[1]] } };
const THIRD = workflowDigest({ workflow: JSON.stringify(thirdFlow) });

/** thirdFlow's own revision. */
const fourthFlow = { ...answerFlow, root: { ...answerFlow.root, steps: [{ ...answerFlow.root.steps[0], instructions: "Answer the question, revision four; say whether you are sure." }, answerFlow.root.steps[1]] } };
const FOURTH = workflowDigest({ workflow: JSON.stringify(fourthFlow) });

test("one check at a time, and a running check finishes: revisions that come meanwhile wait and record nothing (no queue); the newest is checked once the running check is decided (its verdict stands), across a restart", { timeout: 240_000 }, async (t) => {
  // Revision two's replay runs ask the model and are held there, in flight, until released.
  const w = await championWorld(t, { hold: (body) => body.includes("revision two") });
  const { server, start, logs, proxy, dir, restart, replays } = w;
  const decidedOf = (records, digest) => records.filter((one) => one.digest === digest).map(({ decided }) => decided);
  const replaysOf = async (digest) => (await replays()).filter((row) => digestOf.get(row.id) === digest);
  const digestOf = new Map();
  const second = await start("run-2", "What is seven times six");
  assert.deepEqual([second.metrics?.path, second.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves while revision two is checked: ${logs.join("\n")}`);
  const firstCheck = (await promotionsOf(server.settings, "agent-1")).find((one) => one.digest === REVISED && one.decided === "replaying");
  assert.equal(firstCheck?.runs?.length, 6, "revision two is checked on the agent's six earlier runs");
  for (const id of firstCheck.runs) digestOf.set(id, REVISED);
  await until(() => proxy.holding.size === 6, "revision two's six replay runs in flight, each held at its model request");
  // Revision three lands on the folder's main while revision two is checked. A run's claim leaves it waiting.
  await landRevision(w, "compile-2", thirdFlow, (await seedOf(dir, "agent-1")).sha);
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves while revision three waits: ${JSON.stringify(third.metrics)}\n${logs.join("\n")}`);
  let records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual([decidedOf(records, REVISED), decidedOf(records, THIRD)], [["replaying"], []], JSON.stringify(records));
  assert.equal(proxy.holding.size, 6, "revision two's replay runs are still at work: none cancelled");
  // Revision four lands on top. Its claim waits too; revision three is never checked and never recorded.
  await landRevision(w, "compile-3", fourthFlow, (await seedOf(dir, "agent-1")).sha);
  const fourth = await start("run-4", "What is seven times six, again");
  assert.deepEqual([fourth.metrics?.path, fourth.metrics?.workflow_digest], ["workflow", DIGEST], JSON.stringify(fourth.metrics));
  records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual([decidedOf(records, REVISED), decidedOf(records, THIRD), decidedOf(records, FOURTH)], [["replaying"], [], []], JSON.stringify(records));
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: DIGEST, replaying: REVISED }], "the console reads revision two being checked");
  assert.equal(proxy.holding.size, 6, "still none cancelled");
  // Revision two's check finishes: every run ends answered, never cancelled.
  proxy.release();
  const finished = await until(async () => {
    const rows = await replaysOf(REVISED);
    return rows.length === 6 && rows.every((row) => FINAL.includes(row.state) && row.runner === null) && rows;
  }, "revision two's replay runs ended");
  for (const row of finished) assert.deepEqual([row.state, row.metrics?.replay?.outcome], ["ended", "answered"], JSON.stringify(row));
  // The records are in the store: a restarted runner's next claim decides revision two (its verdict stands: promoted, it
  // serves) and starts revision four's check. Revision three is never checked.
  await restart();
  const fifth = await start("run-5", "What is six times seven, once more");
  assert.deepEqual([fifth.metrics?.path, fifth.metrics?.workflow_digest], ["workflow", REVISED], `revision two, promoted by its finished check, serves while revision four is checked: ${JSON.stringify(fifth.metrics)}\n${logs.join("\n")}`);
  records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual([decidedOf(records, REVISED), decidedOf(records, THIRD), decidedOf(records, FOURTH)], [["replaying", "promote"], [], ["replaying"]], JSON.stringify(records));
  const fourthCheck = records.findLast((one) => one.digest === FOURTH);
  assert.deepEqual([fourthCheck.runs.length, fourthCheck.check.attempt], [6, 1], "revision four is checked on the agent's six earlier runs (every run since was served): a first check");
  for (const id of fourthCheck.runs) digestOf.set(id, FOURTH);
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: REVISED, replaying: FOURTH }]);
  await until(async () => {
    const rows = await replaysOf(FOURTH);
    return rows.length === 6 && rows.every((row) => FINAL.includes(row.state) && row.runner === null);
  }, "revision four's replay runs ended");
  // Revision four's check gets its verdict: at the bar, it serves the next run. Replay runs in all: 6 + 6.
  const sixth = await start("run-6", "What is seven times six, once more");
  assert.deepEqual([sixth.metrics?.path, sixth.metrics?.workflow_digest], ["workflow", FOURTH], JSON.stringify(sixth.metrics));
  assert.equal((await replays()).length, 12, "every replay run is revision two's or four's (6 and 6), none of revision three");
  const after = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(decidedOf(after, FOURTH), ["replaying", "promote"]);
  assert.deepEqual(after.filter((one) => one.digest !== DIGEST).map((one) => one.decided), ["replaying", "promote", "replaying", "promote"], "no queued, skipped or replay record");
  assert.deepEqual(servingOf(after), [{ workflow: "answer", digest: FOURTH, replaying: null }]);
  for (const line of [`${THIRD} waits: ${REVISED} is being checked (one check at a time)`, `${FOURTH} waits: ${REVISED} is being checked (one check at a time)`, `${REVISED} promoted:`, `${FOURTH} is new: checking it on 6 inputs`]) assert.ok(logs.some((one) => one.includes(line)), `${line}\n${logs.join("\n")}`);
});

test("a check whose workflow fails on every input (a step failed: a credential or tool the replay ran without) never answered alone: held, never promoted on the agent's answers", { timeout: 180_000 }, async (t) => {
  // The node's answer is off its schema every time: the step fails, the workflow hands the run back on a failure.
  const { server, start, replaysEnded } = await world(t, { submit: () => ({ answer: "forty-two", sure: true }) });
  await start("run-1", "What is six times seven");
  const runs = await replaysEnded(6);
  assert.deepEqual(runs.map((row) => row.metrics?.replay?.outcome), runs.map(() => "failed"), JSON.stringify(runs.map((row) => row.metrics)));
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", `held: the agent takes the run: ${JSON.stringify(second.metrics)}`);
  const decided = (await heldThenRevisionFailed(server)).at(-1);
  assert.deepEqual({ decided: decided.decided, n: decided.check.n, alone: decided.check.alone, failed: decided.check.outcomes.failed }, { decided: "hold", n: 6, alone: 0, failed: 6 });
  assert.match(decided.reason, /answered 0 alone .*\(6 failed: a step failed, or it was still at work at the check's deadline\): held/);
});

test("a replay run its claim cannot lay at its digest ends failed: the agent is never asked", { timeout: 120_000 }, async (t) => {
  const { server, gw, launchOf, ended, seed } = await world(t, { prior: 0 });
  await server.runs.create({ id: "replay-stale", agentId: "agent-1", revisionId: "rev-1" }, { body: { ...launchOf("Question 0", seed), replay: { of: "graded-0", workflow: "answer", digest: "0000000000000000" } } });
  const row = await ended("replay-stale");
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.match(row.summary ?? "", /laid no workflow by that name at that digest/);
  assert.equal(gw.requests.length, 0, "no model request: neither the workflow nor the agent ran");
});

test("a replay run whose revision was decided already never runs, its cancel lost or not", { timeout: 120_000 }, async (t) => {
  const { server, gw, launchOf, ended, seed } = await world(t, { prior: 0 });
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "hold", reason: "held at its deadline", runs: ["replay-orphan"] }, (was) => was === undefined);
  await server.runs.create({ id: "replay-orphan", agentId: "agent-1", revisionId: "rev-1" }, { body: { ...launchOf("Question 0", seed), replay: { of: "graded-0", workflow: "answer", digest: DIGEST } } });
  const row = await ended("replay-orphan");
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.match(row.summary ?? "", /that revision is held already/);
  assert.equal(gw.requests.length, 0, "no model request");
});

test("a held replay's leftover run never runs once its revision replays again: only the newer replay's runs claim", { timeout: 120_000 }, async (t) => {
  const { server, gw, launchOf, ended, seed } = await world(t, { prior: 0 });
  const at = () => new Date().toISOString();
  // Replay A held at its deadline, its cancel lost: run replay-a-left is still queued. Its owner then starts replay B.
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: at(), decided: "hold", reason: "held at its deadline", runs: ["replay-a-left"], inputs: ["graded-0"], replay_id: "replay-a" }, (was) => was === undefined);
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: at(), decided: "replaying", reason: "replaying again", runs: ["replay-b-0"], inputs: ["graded-0"], replay_id: "replay-b" }, (was) => was?.decided === "hold");
  const replayBody = { ...launchOf("Question 0", seed), replay: { of: "graded-0", workflow: "answer", digest: DIGEST } };
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

test("a run pinned to an older revision, launched after the newest one's check started, never supersedes it: the champion serves it", { timeout: 180_000 }, async (t) => {
  const w = await championWorld(t);
  const { server, start, startPinned, logs, dir, replaysEnded } = w;
  // Revision two is on main (no claim laid it yet); revision three lands on top of it, and a run at main starts its check.
  const two = (await seedOf(dir, "agent-1")).sha;
  await landRevision(w, "compile-2", thirdFlow, two);
  const third = await start("run-3", "What is six times seven, again");
  assert.deepEqual([third.metrics?.path, third.metrics?.workflow_digest], ["workflow", DIGEST]);
  assert.equal((await promotionsOf(server.settings, "agent-1")).filter((one) => one.digest === THIRD).at(-1)?.decided, "replaying");
  // A run pinned to revision two's commit, made after revision three's check started.
  const old = await startPinned("run-old", "What is seven times six", two);
  assert.deepEqual([old.metrics?.path, old.metrics?.workflow_digest], ["workflow", DIGEST], `the champion serves the older pin: ${JSON.stringify(old.metrics)}\n${logs.join("\n")}`);
  const records = await promotionsOf(server.settings, "agent-1");
  assert.equal(records.filter((one) => one.digest === THIRD).at(-1)?.decided, "replaying", `revision three is still checked: ${JSON.stringify(records)}`);
  assert.deepEqual(records.filter((one) => one.digest === REVISED), [], "revision two starts nothing");
  await replaysEnded(6);
});

test("a revision that adds a required input field leaves its champion serving the inputs the champion takes", { timeout: 180_000 }, async (t) => {
  const w = await world(t, { prior: 0 });
  const { server, start, seed } = w;
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "promoted", commit: seed }, (was) => was === undefined);
  // The revision asks for a locale too: a run with a question alone does not fit it, and does fit the champion.
  const wide = { ...answerFlow, schemas: { ...answerFlow.schemas, In: { type: "object", required: ["question", "locale"], properties: { question: { type: "string" }, locale: { type: "string" } } } } };
  await landRevision(w, "compile-1", wide, seed);
  const run = await start("run-1", "What is six times seven");
  assert.deepEqual([run.metrics?.path, run.metrics?.workflow_digest], ["workflow", DIGEST], JSON.stringify(run.metrics));
});

test("a held revision whose input the champion does not take: the agent takes the run, and its learned_workflow tool runs the champion, never the held revision", { timeout: 180_000 }, async (t) => {
  const w = await world(t, { prior: 0 });
  const { server, gw, logs, seed, dir, ended, launchOf } = w;
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "promoted", commit: seed }, (was) => was === undefined);
  // The revision on the folder's main takes a `query` where the champion takes a `question`; its check held it.
  const renamed = { ...answerFlow, schemas: { ...answerFlow.schemas, In: { type: "object", required: ["query"], properties: { query: { type: "string" } } } } };
  await landRevision(w, "compile-1", renamed, seed);
  const main = (await seedOf(dir, "agent-1")).sha;
  const held = workflowDigest({ workflow: JSON.stringify(renamed) });
  await recordPromotion(server.settings, "agent-1", { workflow: "answer", digest: held, at: new Date().toISOString(), decided: "hold", reason: "checked on 6 of the agent's inputs: held", commit: main }, (was) => was === undefined);
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
