// workflow-first through the runner's adapter loop (runner/workflow-first.ts): a pi run of an agent whose learned revision
// holds one active workflow that fits the run's input starts on that workflow, before any turn of the agent's model.
//   - answered: the model proxy records hold the workflow's node requests alone, each labelled learned_workflow; the
//     gateway never sees an agent request; the run's metrics say path "workflow", its learned revision and the
//     workflow; its cost is the booked node $; its learning reads nothing new at no cost.
//   - handed back (the workflow's escalate guard holds): the same run goes on to the agent, whose first input carries
//     the workflow's trace; the run ends on the agent's answer, path "handed_back", its cost the node's $ and the agent's;
//     its end-of-run turn asks for the workflow's next revision by its name.
//   - workflow_first false, an input no workflow fits: the agent takes the run from its first turn, path "agent".
//   - learned_workflow set to ask: the run parks on the step before any node runs; approved, it runs.
//   - a stop while the step is asked: the claim that holds it ends the run stopped.
//   - the money rule: a workflow whose last 10 served runs cost more than the agent by hand stops running first, and the
//     run asks for its revision; under it, at a new digest, under 10 runs or with no by-hand baseline, it serves.
// pi's model and the node's go through the session proxy to a loopback gateway; no sleeps, no port races. The same on a
// CLI harness (the faux one the harness table hands the runner): one loop serves every harness.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { runTimeline, runEntries, runReflect } = await import("../dist/store-reads/journal.js");
const { said } = await import("../dist/learning-words.js");
const { agentCostOverStore } = await import("../dist/store-reads/learning.js");
const { LEARNED_CLIP } = await import("../dist/learned-workflow.js");
const { COST_WINDOW, costLineOf, workflowCostsOf, fits, workflowDigest, workflowFirstOf, pathMetrics, reviseOf, servedOf, WORKFLOW_FIRST } = await import("../dist/runner/workflow-first.js");
const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
const { recordPromotion } = await import("../dist/learn/promote.js");
const { answerAsServed, answerJson, structuredAnswer } = await import("../dist/answer-json.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const QUESTION = "What is six times seven";
const AGENT_SAYS = "The agent's own answer: 42.";

/** One extract node, then its guard: an `escalate` that hands the job back when the node is not sure. */
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
/** The digest of FLOWS' workflow as its seed lays it (workflow.json, JSON.stringify of it). */
const DIGEST = workflowDigest({ workflow: JSON.stringify(answerFlow) });

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
/** A request's text, every message's text blocks and the system prompt together. */
const textOf = (body) => [
  ...(Array.isArray(body?.system) ? body.system.map((block) => block?.text ?? "") : [String(body?.system ?? "")]),
  ...(body?.messages ?? []).flatMap((message) => (typeof message.content === "string" ? [message.content] : (message.content ?? []).map((block) => block?.text ?? (Array.isArray(block?.content) ? block.content.map((c) => c?.text ?? "").join("") : String(block?.content ?? ""))))),
].join("\n");
/** A node request: it offers the node's submit tool. Anything else is the agent's. */
const isNode = (request) => offers(request.body, "submit");

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A pi run of an agent that learned `answer`, on `input`; the node submits `{answer, sure}` (`sure` false hands back);
 *  the agent, when asked, answers AGENT_SAYS. `toolSettings` on the revision; `approve`: answer the run's first ask ("stop":
*  stop the run while it waits instead). `followUp`: once the run ends, a person's follow-up (a teacher's label on its
 *  answer) reopens it, and the run read is the follow-up's end; `first` is the row of the end before it. */
async function piRun(t, { input = { content: `${QUESTION}?`, question: QUESTION }, sure = true, learned = true, workflowFirst, toolSettings, approve = false, past = [], promotions = [], keptBefore: earlier = [], followUp, flows = FLOWS, answer, outputSchema, crashOnHandback = false, pastFromSecondClaim = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-workflow-first-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: answer ?? (sure ? 42 : 41), sure } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : AGENT_SAYS),
  });
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], ...(learned ? { learning: true } : {}), ...(toolSettings ? { toolSettings } : {}), ...(outputSchema ? { outputSchema } : {}) } });
  const seed = learned ? await landWorkflows(dir, "agent-1", flows) : undefined;
  // `promotions`: the agent's promotion records before the run (learn/promote.ts), as its replays left them.
  for (const record of promotions) await recordPromotion(server.settings, "agent-1", record, () => true);
  const launch = { input, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learned ? { learning: startAt(seed) } : {}), ...(workflowFirst === false ? { workflowFirst: false } : {}) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const crashingJournal = (journal) => new Proxy(journal, { get: (target, key) => (key === "commit" ? async (...args) => {
    const result = await target.commit(...args);
    if (!crashed && JSON.stringify(args[0]).includes("agentrun.workflow_first")) crash();
    return result;
  } : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  // `past`: earlier runs of the agent, newest first, as its store lists them (the money rule's read): laid before the
  // store's own rows, every other read the store's.
  // `pastFromSecondClaim`: the money rule reads them only once a first claim has built its spec (a claim after a crash).
  let claims = 0;
  const runsOf = { ...store.runs, list: async (filter) => [...(pastFromSecondClaim && claims < 1 ? [] : past), ...(await store.runs.list(filter))] };
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(store.runs) ?? {})) if (typeof store.runs[key] === "function" && key !== "list" && key !== "constructor") runsOf[key] = store.runs[key].bind(store.runs);
  // `keptBefore`: earlier runs' kept learning, newest first (learning_proposals), laid before the store's own the same way.
  const learningOf = { proposal: async (runId) => earlier.find((one) => one.runId === runId) ?? (await store.learning.proposal(runId)), proposals: async (agentId, options) => [...earlier.filter((one) => one.agentId === agentId), ...(await store.learning.proposals(agentId, options))], spend: (window) => store.learning.spend(window) };
  const depStore = past.length || earlier.length ? new Proxy(store, { get: (target, key) => (key === "runs" ? runsOf : key === "learning" ? learningOf : typeof target[key] === "function" ? target[key].bind(target) : target[key]) }) : store;
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store: depStore, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  // `approve: "stop-at-gate"`: the person's stop lands while the first claim is at the step's gate (the run's own gate,
  // asked before the ask is), so the claim that parks on the ask holds the stop. `claims`: the specs built, one per claim.
  const specOf = async (claim, run) => {
    const spec = await adapterRunSpecFromLaunch(launch, run, deps, claim);
    claims += 1;
    if (approve !== "stop-at-gate" || claims > 1) return spec;
    const gate = spec.gate;
    return { ...spec, gate: async (call) => {
      if (call.callId === "workflow-first") {
        await sendCommand(server, RUN, { kind: "stop" });
        await until(async () => (await server.runs.get(RUN)).state !== "running" || (await new Promise((resolve) => setTimeout(() => resolve(true), 300))), "the stop delivered", 5_000);
      }
      return gate ? gate(call) : undefined;
    } };
  };
  // `crashOnHandback`: the first runner is closed as the workflow's end reaches the record (its claim's signal aborts before
  // the handback goes to the agent, so that claim returns interrupted with the session still new); a second runner takes the
  // run, and the money rule (past runs, `pastFromSecondClaim`) now stops the workflow.
  let crashed = false;
  // The store the runners hold: its journals tell the crash when the workflow's end is committed.
  const runnerStore = crashOnHandback ? new Proxy(store, { get: (target, key) => (key === "journal" ? (claim) => crashingJournal(target.journal(claim)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) }) : store;
  const crash = () => {
    crashed = true;
    void runner.close();
    runner = startRunner({ store: runnerStore, name: "runner-b", ...TIMING, createLoop: createAdapterLoop(specOf) });
  };
  runner = startRunner({ store: runnerStore, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const settled = (states) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && now;
  }, `the run ${states.join("/")}`);
  let parked;
  if (approve && approve !== "stop-at-gate") {
    parked = await settled(["parked", "ended", "failed", "stopped"]);
    const callId = await until(async () => {
      const row = await server.runs.get(RUN);
      const entries = (await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx)).entries;
      return entries.find((entry) => entry.kind === "agentrun.ask")?.data?.callId;
    }, "the step's ask", 10_000);
    parked = { ...parked, callId, requestsWhileParked: gw.requests.length };
    await sendCommand(server, RUN, approve === "stop" ? { kind: "stop" } : { kind: "approve", body: { approval: callId } });
  }
  let row = await settled(["ended", "failed", "stopped"]);
  const first = followUp === undefined ? undefined : row;
  if (first) {
    await server.runs.reopen(RUN, { kind: "steer", body: { text: followUp } });
    await server.flush?.();
    row = await until(async () => {
      const now = await server.runs.get(RUN);
      return (now.endedAt ?? 0) > (first.endedAt ?? 0) && ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
    }, "the follow-up's end");
  }
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const all = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
  const requests = all.filter((record) => record.kind === "runner.request").map((record) => record.data);
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  const timeline = await runTimeline(server, RUN, ctx, { settled: true });
  const entries = await runEntries(server, RUN, ctx);
  const kept = await server.learning.proposal(RUN);
  const reflect = await runReflect(server, RUN, ctx);
  return { row, first, requests, turns, timeline, entries, kept, reflect, gateway: gw, seed, parked, logs, claims, server };
}

test("workflow alone: the run answers on its learned workflow with no agent-model request, path workflow, its node $ its cost", async (t) => {
  const { row, requests, turns, timeline, entries, kept, reflect, gateway, seed } = await piRun(t);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  // The model proxy records: the node's request alone, labelled learned_workflow; none of the agent's.
  assert.ok(requests.length >= 1, "the node made its request");
  assert.deepEqual(requests.filter((request) => request.host !== LEARNED_WORKFLOW_TOOL), [], `every request the proxy booked is the workflow's: ${JSON.stringify(requests)}`);
  assert.deepEqual(gateway.requests.filter((request) => !isNode(request)).map((request) => textOf(request.body).slice(0, 200)), [], "the gateway saw no agent request");
  // Its answer is the run's: the workflow's output, as the model's message.
  assert.ok(timeline.some((row) => ["assistant", "final_answer"].includes(row.kind) && /42/.test(row.text ?? "")), `the workflow's answer is the run's: ${JSON.stringify(timeline.map(({ kind, text }) => [kind, text]))}`);
  const { digest, ...served } = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST)?.data ?? {};
  assert.deepEqual(served, { workflow: "answer", revision: seed, call: "workflow-first", outcome: "answered" });
  // The run record: the path, the revision, the workflow; the cost is what the session booked for the node.
  assert.equal(row.metrics?.path, "workflow", JSON.stringify(row.metrics));
  assert.equal(row.metrics?.learned_revision, seed);
  assert.equal(row.metrics?.workflow, "answer");
  assert.match(String(row.metrics?.workflow_digest), /^[0-9a-f]{16}$/);
  assert.equal(row.metrics.workflow_digest, digest, "the run record's digest is the served workflow's");
  const booked = turns.reduce((sum, turn) => sum + (typeof turn.usd === "number" ? turn.usd : 0), 0);
  assert.ok(booked > 0, `the node's request is priced: ${JSON.stringify(turns)}`);
  assert.ok(Math.abs((row.costUsd ?? 0) - booked) < 1e-9, `the run's cost is the node's booked $: ${row.costUsd} vs ${booked}`);
  // Its learning: no end-of-run turn, nothing new, at no cost (the clean-use count reads path "workflow").
  assert.equal(reflect, undefined, "no end-of-run turn was placed");
  assert.deepEqual({ state: kept?.proposal?.state, reason: kept?.proposal?.reason, detail: kept?.proposal?.detail, look_back_usd: kept?.proposal?.look_back_usd }, { state: "dropped", reason: "empty", detail: said.onlyWorkflow, look_back_usd: 0 }, JSON.stringify(kept?.proposal));
});

test("handed back: the guard holds, the same run goes on to the agent with the workflow's trace, and ends on the agent's answer", async (t) => {
  const { row, requests, timeline, entries, gateway, seed } = await piRun(t, { sure: false });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  // The node ran first, then the agent: its first request carries the hand-back and the trace, then the job.
  const firstAgent = gateway.requests.findIndex((request) => !isNode(request));
  assert.ok(firstAgent > 0 && gateway.requests.slice(0, firstAgent).every(isNode), `the node's requests come first: ${gateway.requests.map(isNode)}`);
  const said = textOf(gateway.requests[firstAgent].body);
  assert.match(said, /Your learned workflow `answer` ran first on this job and handed it back to you/);
  assert.match(said, /handed the job back at its step "unsure": not sure of 41/);
  assert.match(said, /"sure":\s*false/);
  assert.match(said, new RegExp(QUESTION));
  // The agent finished it: its answer is the run's last word.
  const last = timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind));
  assert.equal(last?.text, AGENT_SAYS, JSON.stringify(timeline.map(({ kind, text }) => [kind, text])));
  // The run record: one run, path handed_back; its cost is the node's $ and the agent's together.
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.equal(row.metrics?.learned_revision, seed);
  assert.equal(row.metrics?.workflow, "answer");
  assert.equal(row.metrics?.workflow_digest, DIGEST, "the digest is the workflow text's");
  assert.ok(requests.some((request) => request.host === LEARNED_WORKFLOW_TOOL) && requests.some((request) => request.host === undefined), `node and agent requests both booked: ${JSON.stringify(requests)}`);
  assert.ok((row.costUsd ?? 0) > 0, `the run's cost: ${row.costUsd}`);
});

test("handed back: the compile turn asks for the workflow's next revision by its name, with the workflow as it is", async (t) => {
  const { gateway } = await piRun(t, { sure: false });
  const ask = gateway.requests.find((request) => !isNode(request) && /One more turn: revise your learned workflow `answer`\.\nYour learned workflow `answer` ran first on this run and handed it back to you\./.test(textOf(request.body)));
  assert.ok(ask, `the compile turn asked about \`answer\`: ${gateway.requests.map((request) => textOf(request.body).slice(0, 300)).join("\n---\n")}`);
  assert.match(textOf(ask.body), /Give `answer` again whole under its name/);
  assert.match(textOf(ask.body), /`answer` as it is now:/);
});

// A teacher's label sent after the run (a follow-up) is the feedback learning runs on: on a run its learned workflow served
// and on one it handed back, the follow-up's end looks back as a round of its own (learning_proposals keyed by run and
// round), kept beside the first round's, never dropped as a repeat of it. Its end-of-run turn reads the label. A run the
// workflow answered alone, then the agent answered a follow-up on, did not finish on the workflow alone: handed_back.
const LABEL = "Label: the reference answer is 42; keep the workflow's answer as it is.";
const roundsOf = async (server) => [await server.learning.proposal(RUN, 1), await server.learning.proposal(RUN, 2)];
/** The text of a request's last message: an end-of-run turn's is its prompt. */
const lastText = (body) => textOf({ messages: (body?.messages ?? []).slice(-1) }).trim();
/** The end-of-run turns asked after the label: the prompt is the last message, the label earlier in the conversation. */
const labelAsks = (gateway) => gateway.requests.filter((request) => !isNode(request) && /^The task is done\. Before the run ends/.test(lastText(request.body)) && textOf(request.body).includes(LABEL));

test("follow-up on a workflow-served run: the label's look-back is kept as round 2, beside round 1's drop, and the path turns handed_back", async (t) => {
  const { row, first, gateway, server } = await piRun(t, { followUp: LABEL });
  assert.equal(first.metrics?.path, "workflow", JSON.stringify(first.metrics));
  assert.equal(row.state, "ended", JSON.stringify(row));
  const [one, two] = await roundsOf(server);
  assert.deepEqual([one?.round, one?.proposal?.state, one?.proposal?.reason, one?.turn], [1, "dropped", "empty", null], `round 1 stands: ${JSON.stringify(one)}`);
  assert.equal(two?.round, 2, `the label's round is kept: ${JSON.stringify(two)}`);
  assert.notEqual(two.turn, null, "round 2 looked back");
  assert.ok(two.turn.asked.some((said) => said.includes(LABEL)), `round 2 heard the label: ${JSON.stringify(two.turn.asked)}`);
  assert.ok(two.proposal.look_back_usd > 0, `its look-back was asked and paid: ${JSON.stringify(two.proposal)}`);
  // The agent's first turn is the follow-up's: the job, what the workflow answered, then the label it is a word on.
  const firstAgent = gateway.requests.find((request) => !isNode(request));
  assert.match(textOf(firstAgent.body), new RegExp(`${QUESTION}[\\s\\S]*Your learned workflow \`answer\` ran first on this job and answered it\\. Its answer:[\\s\\S]*42[\\s\\S]*${LABEL.slice(0, 20)}`), textOf(firstAgent.body));
  assert.equal(labelAsks(gateway).length, 1, "its end-of-run turn was asked once, with the label in it");
  assert.ok(two.proposal.follow_up_usd > 0, `the label's own turn is the round's: ${JSON.stringify(two.proposal)}`);
  assert.equal(row.metrics?.path, "handed_back", `the agent answered the follow-up: ${JSON.stringify(row.metrics)}`);
  assert.equal(row.metrics?.workflow, "answer");
});

test("follow-up on a handed-back run: the label's look-back is kept as round 2, a later look, beside round 1's", async (t) => {
  const { row, first, gateway, server } = await piRun(t, { sure: false, followUp: LABEL });
  assert.equal(first.metrics?.path, "handed_back", JSON.stringify(first.metrics));
  assert.equal(row.state, "ended", JSON.stringify(row));
  const [one, two] = await roundsOf(server);
  assert.equal(one?.round, 1);
  assert.notEqual(one.turn, null, "round 1 looked back");
  assert.equal(two?.round, 2, `the label's round is kept: ${JSON.stringify(two)}`);
  assert.notEqual(two.turn, null, "round 2 looked back");
  assert.ok(two.turn.asked.some((said) => said.includes(LABEL)), `round 2 heard the label: ${JSON.stringify(two.turn.asked)}`);
  const asks = labelAsks(gateway);
  assert.equal(asks.length, 1, "its end-of-run turn was asked once, with the label in it");
  assert.match(textOf(asks[0].body), /You looked back on this run before/, "a later round's prompt");
  assert.equal(row.metrics?.path, "handed_back");
});

test("workflow_first false: the agent takes the run from its first turn, path agent", async (t) => {
  const { row, entries, gateway, logs } = await piRun(t, { workflowFirst: false });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(entries.some((entry) => entry.kind === WORKFLOW_FIRST), false);
  assert.equal(isNode(gateway.requests[0]), false, "the first request is the agent's");
  assert.equal(row.metrics?.path, "agent");
  assert.equal(row.metrics?.workflow, undefined);
  assert.ok(logs.some((line) => /workflow_first: false/.test(line)), JSON.stringify(logs));
});

test("an input no learned workflow fits: the agent takes the run, path agent, with nothing logged", async (t) => {
  const { row, entries, gateway, logs } = await piRun(t, { input: { content: `${QUESTION}?` } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(entries.some((entry) => entry.kind === WORKFLOW_FIRST), false);
  assert.equal(isNode(gateway.requests[0]), false, "the first request is the agent's");
  assert.equal(row.metrics?.path, "agent");
  assert.deepEqual(logs.filter((line) => line.startsWith("workflow-first:")), [], "none fitting is the common case: no line");
});

test("learned_workflow set to ask: the step parks before any node runs; approved, the workflow answers alone", async (t) => {
  const { row, parked, gateway, requests } = await piRun(t, { toolSettings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } }, approve: true });
  assert.equal(parked.state, "parked", `the run parked on the ask: ${JSON.stringify(parked)}`);
  assert.equal(parked.callId, "workflow-first", "the ask is the step's call");
  assert.equal(parked.requestsWhileParked, 0, "no model request before the approval");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "workflow", JSON.stringify(row.metrics));
  assert.ok(gateway.requests.every(isNode), "approved, it ran the workflow alone");
  assert.ok(requests.every((request) => request.host === LEARNED_WORKFLOW_TOOL));
});

test("learned_workflow set to ask: a stop while the step waits ends the run stopped, the workflow never run", async (t) => {
  const { row, parked, gateway } = await piRun(t, { toolSettings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } }, approve: "stop" });
  assert.equal(parked.state, "parked", `the run parked on the ask: ${JSON.stringify(parked)}`);
  assert.equal(row.state, "stopped", `the stop is taken, not parked again: ${JSON.stringify(row)}`);
  assert.equal(gateway.requests.length, 0, "no model request: the workflow never ran, the agent never asked");
});

test("learned_workflow set to ask: a stop that lands while the step is asked is taken by that claim, never parked on", async (t) => {
  const { row, gateway, claims } = await piRun(t, { toolSettings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } }, approve: "stop-at-gate" });
  assert.equal(row.state, "stopped", `the run ends stopped: ${JSON.stringify(row)}`);
  assert.equal(claims, 1, "the claim that held the stop took it; the run was never given back parked with its stop untaken");
  assert.equal(gateway.requests.length, 0, "the workflow never ran, the agent never asked");
});

/** Earlier runs of the agent, newest first, as the store lists them: `served` runs of FLOWS' workflow at `digest` (path
 *  handed_back), each at `servedUsd`, then `byHand` runs on the agent's path, each at `byHandUsd`. */
const pastRuns = ({ served = COST_WINDOW, servedUsd = 0.5, byHand = 3, byHandUsd = 0.2, digest = DIGEST } = {}) => {
  const at = Date.UTC(2026, 10, 12);
  const row = (i, metrics, costUsd) => ({ id: `past-${i}`, agentId: "agent-1", revisionId: "rev-1", state: "ended", startedAt: at - i * 60_000, endedAt: at - i * 60_000 + 1_000, costUsd, metrics, importedFrom: null, archivedAt: null, epoch: 1, runner: null });
  return [
    ...Array.from({ length: served }, (_, i) => row(i, { path: "handed_back", workflow: "answer", workflow_digest: digest, learned_revision: "s" }, servedUsd)),
    ...Array.from({ length: byHand }, (_, i) => row(served + i, { path: "agent", learned_revision: "s" }, byHandUsd)),
  ];
};

test("money rule: a workflow whose last 10 served runs cost more than the agent by hand stops running first, and the run asks for a revision", async (t) => {
  const { row, gateway, entries, logs } = await piRun(t, { past: pastRuns({ servedUsd: 0.5, byHandUsd: 0.2 }) });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "agent", `the agent took the run: ${JSON.stringify(row.metrics)}`);
  assert.equal(gateway.requests.filter(isNode).length, 0, "the workflow never ran");
  const revise = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST)?.data;
  assert.deepEqual(revise, { workflow: "answer", digest: DIGEST, revision: revise?.revision, outcome: "needs_revision", served_usd: 0.5, by_hand_usd: 0.2, runs: COST_WINDOW }, "the run's journal keeps why, with the two numbers");
  assert.ok(logs.some((line) => /answer cost \$0\.5 a run over its last 10 served runs, at or over \$0\.2 by hand/.test(line)), JSON.stringify(logs));
  const ask = gateway.requests.find((request) => /no longer runs first: over its last 10 served runs it cost \$0\.5 a run, against \$0\.2 a run by hand/.test(textOf(request.body)));
  assert.ok(ask, `the compile turn asked for a revision: ${gateway.requests.map((request) => textOf(request.body).slice(0, 400)).join("\n---\n")}`);
  assert.match(textOf(ask.body), /Give `answer` again whole under its name/);
});

// A workflow its replay held (runner/promotion.ts): the agent takes the run, and its end-of-run compile turn asks for the
// workflow's revision with the replay's numbers; a hold of another digest (an older revision) asks for none.
test("held by its replay: the agent takes the run, and the compile turn asks for a revision with the replay's numbers; an older revision's hold asks nothing", async (t) => {
  const at = new Date().toISOString();
  const replay = { of: [], n: 20, agree: 13, agent_acc: 0.9, wf_acc: 0.7, delta: -0.2, handed_back: 4, cost_usd: 0.4 };
  const held = { workflow: "answer", digest: DIGEST, at, decided: "hold", source: "replay", reason: "replayed on 20 graded inputs: more than 2 pts under the agent", replay };
  const { row, gateway, logs } = await piRun(t, { promotions: [held] });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "agent", `the agent took the run: ${JSON.stringify(row.metrics)}`);
  assert.equal(gateway.requests.filter(isNode).length, 0, "the held workflow never ran");
  assert.ok(logs.some((line) => /answer at [0-9a-f]{16} is held/.test(line)), JSON.stringify(logs));
  const ask = gateway.requests.find((request) => /One more turn: revise your learned workflow `answer`\.\nYour learned workflow `answer` does not run first: replayed on 20 of the agent's graded inputs, it was right 70\.0% of the time \(4 handed back, each scored on the agent's answer\), against the agent's 90\.0%: -20\.0 pts, more than 2 pts under\./.test(textOf(request.body)));
  assert.ok(ask, `the compile turn asked for a revision with the replay's numbers: ${gateway.requests.map((request) => textOf(request.body)).filter((text) => text.includes("One more turn")).map((text) => text.slice(text.lastIndexOf("One more turn"), text.lastIndexOf("One more turn") + 600)).join("\n---\n")}`);
  assert.match(textOf(ask.body), /`answer` as it is now:/);
  assert.doesNotMatch(textOf(ask.body), /answer `No change\.`/);
  // A hold of an older revision: main's is a new digest, decided on its own (here on its dry run: no graded input), and
  // nothing asks for a revision.
  const older = await piRun(t, { promotions: [{ ...held, digest: "fedcba9876543210" }] });
  assert.equal(older.row.metrics?.path, "workflow", JSON.stringify(older.row.metrics));
  assert.ok(!older.gateway.requests.some((request) => /One more turn: revise your learned workflow/.test(textOf(request.body))), "an older revision's hold asks nothing");
});

// #2641 review (class C): once per hold. A run since the hold that compiled the held workflow asked already, whatever
// came of it (its draft failed its checks, or the grader dropped it), however many runs ago; one before the hold did not.
test("held: a compile of it since the hold, past the last 4 runs, asks no revision again; one from before the hold does", async (t) => {
  const at = new Date().toISOString();
  const replay = { of: [], n: 20, agree: 13, agent_acc: 0.9, wf_acc: 0.7, delta: -0.2, handed_back: 4, cost_usd: 0.4 };
  const held = { workflow: "answer", digest: DIGEST, at, decided: "hold", source: "replay", reason: "replayed on 20 graded inputs: more than 2 pts under the agent", replay };
  const past = pastRuns({ served: 0, byHand: 6 });
  const compiledAt = (createdAt) => [{ runId: "past-5", agentId: "agent-1", turn: null, createdAt, proposal: { state: "dropped", reason: "checker", detail: "d", compiled: { workflow: "answer", from_notes: [], attempts: [{ ok: false, errors: ["workflow: no root"] }] }, draft_errors: ["workflow: no root"] } }];
  const asksRevision = (gateway) => gateway.requests.some((request) => /One more turn: revise your learned workflow `answer`/.test(textOf(request.body)));
  const since = await piRun(t, { promotions: [held], past, keptBefore: compiledAt(Date.parse(at) + 1) });
  assert.equal(since.row.metrics?.path, "agent", JSON.stringify(since.row.metrics));
  assert.ok(!asksRevision(since.gateway), "asked once already, 6 runs ago: never again for this hold");
  const before = await piRun(t, { promotions: [held], past, keptBefore: compiledAt(Date.parse(at) - 60_000) });
  assert.ok(asksRevision(before.gateway), "a compile before the hold was not this hold's ask");
});

test("money rule: under the by-hand cost, a new digest, fewer than 10 served runs, or no by-hand baseline: the workflow serves", async (t) => {
  for (const [why, past] of [
    ["under the by-hand cost", pastRuns({ servedUsd: 0.1, byHandUsd: 0.2 })],
    ["a new revision of it (another digest's runs)", pastRuns({ servedUsd: 0.5, byHandUsd: 0.2, digest: "fedcba9876543210" })],
    ["9 served runs", pastRuns({ served: COST_WINDOW - 1, servedUsd: 0.5, byHandUsd: 0.2 })],
    ["no by-hand baseline", pastRuns({ servedUsd: 0.5, byHand: 0 })],
  ]) {
    await t.test(why, async (t) => {
      const { row, logs } = await piRun(t, { past });
      assert.equal(row.metrics?.path, "workflow", `${why}: ${JSON.stringify(row.metrics)}`);
      if (why === "no by-hand baseline") assert.ok(logs.some((line) => /no by-hand cost to hold answer to/.test(line)), JSON.stringify(logs));
    });
  }
});

test("costLineOf: the newest 10 served runs at the digest against the agent's by-hand runs, or the runs before the workflow when there are none", () => {
  const at = Date.UTC(2026, 10, 12);
  const run = (i, metrics, costUsd) => ({ metrics, costUsd, startedAt: at - i * 60_000 });
  const served = (i, usd, extra = {}) => run(i, { path: i % 2 ? "workflow" : "handed_back", workflow: "answer", workflow_digest: "d", ...extra }, usd);
  const rows = [...Array.from({ length: 12 }, (_, i) => served(i, i < 10 ? 0.3 : 9)), run(12, { path: "agent" }, 0.1), run(13, { path: "agent" }, 0.3), run(14, { path: "agent" }, null)];
  assert.deepEqual(costLineOf(rows, "answer", "d"), { served: { runs: 10, mean_usd: 0.3 }, by_hand: { runs: 2, mean_usd: 0.2 } }, "the newest 10 served; by hand, cost known");
  assert.deepEqual(costLineOf(rows, "answer", "e").served, { runs: 0, mean_usd: null }, "another digest: none served");
  assert.deepEqual(costLineOf([...rows.slice(0, 12), run(20, {}, 0.4), run(21, null, 0.6)], "answer", "d").by_hand, { runs: 2, mean_usd: 0.5 }, "no agent path: the runs before the workflow's first");
  assert.equal(costLineOf(rows.slice(0, 12), "answer", "d").by_hand, null, "no baseline at all");
  assert.equal(reviseOf([]), undefined);
  assert.deepEqual(reviseOf([{ kind: WORKFLOW_FIRST, data: { workflow: "answer", digest: "d", outcome: "needs_revision", served_usd: 1, by_hand_usd: 0.5, runs: 10 } }]), { workflow: "answer", digest: "d", served_usd: 1, by_hand_usd: 0.5, runs: 10 });
  assert.equal(servedOf([{ kind: WORKFLOW_FIRST, data: { workflow: "answer", digest: "d", outcome: "needs_revision" } }]), undefined, "a revision ask served nothing");
  // What the agent's cost per run shows its owner: each workflow at its newest digest, over the line or not.
  const over = [...Array.from({ length: 10 }, (_, i) => served(i, 0.5)), run(10, { path: "agent" }, 0.2), served(11, 0.1, { workflow_digest: "old" })];
  assert.deepEqual(workflowCostsOf(over), [{ workflow: "answer", digest: "d", state: "needs_revision", served: { runs: 10, mean_usd: 0.5 }, by_hand: { runs: 1, mean_usd: 0.2 } }]);
  assert.deepEqual(workflowCostsOf([run(0, { path: "workflow", workflow: "answer", workflow_digest: "new" }, null), ...over]), [{ workflow: "answer", digest: "new", state: "serving", served: null, by_hand: { runs: 1, mean_usd: 0.2 } }], "a new digest starts from zero");
  assert.equal(workflowCostsOf([...Array.from({ length: 10 }, (_, i) => served(i, 0.1)), run(10, { path: "agent" }, 0.2)])[0].state, "serving", "under the line");
});

// A workflow whose one output field is a string (answerFlow's output is a record of a number and a flag, so JSON): the tool hands back
// that string as it is, whatever the node submits, as long as a test likes.
const textFlow = {
  ...answerFlow,
  schemas: { ...answerFlow.schemas, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question in words.", out: "Answer", as: "answer", tier: "fast" }] },
};
const TEXT_FLOWS = [{ name: "answer", description: "Answers a question in words", workflow: textFlow }];

test("a workflow's answer the tool cut goes back to the agent: no agent turn could recover its ending, so the run never ends on it", async (t) => {
  const { row, entries, gateway, timeline } = await piRun(t, { flows: TEXT_FLOWS, answer: "a long answer. ".repeat(Math.ceil((LEARNED_CLIP + 5_000) / 15)) });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  const firstAgent = gateway.requests.find((request) => !isNode(request));
  assert.match(textOf(firstAgent.body), /Your learned workflow `answer` ran first on this job and handed it back to you/);
  assert.equal(timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text, AGENT_SAYS, "the agent's answer is the run's last word");
});

test("a workflow's answer under the cut is the run's own answer", async (t) => {
  const { row, entries, gateway } = await piRun(t, { flows: TEXT_FLOWS, answer: "a long answer. ".repeat(Math.floor((LEARNED_CLIP - 1_000) / 15)) });
  assert.equal(row.metrics?.path, "workflow", JSON.stringify(row.metrics));
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.equal(gateway.requests.filter((request) => !isNode(request)).length, 0);
});

/** The run's final answer, as the timeline shows it. */
const finalOf = (timeline) => timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text ?? "";

test("an agent with an output schema: a one-field workflow's bare code is served as the schema's object, its result.output meets the schema", async (t) => {
  const outputSchema = { type: "object", required: ["mcc"], properties: { mcc: { type: "string" } } };
  const code = await piRun(t, { flows: TEXT_FLOWS, answer: "5462", outputSchema });
  assert.equal(code.row.metrics?.path, "workflow", JSON.stringify(code.row.metrics));
  const said = finalOf(code.timeline);
  assert.match(said, /^```json\n[\s\S]*\n```$/, `the answer is one fenced json block: ${said}`);
  assert.deepEqual(structuredAnswer(said, outputSchema), { value: { mcc: "5462" } }, "the code is the schema's field as a string, never a JSON number");
});

test("an agent with an output schema: a one-field workflow's text (not JSON) is served as the schema's object", async (t) => {
  const outputSchema = { type: "object", required: ["category"], properties: { category: { type: "string" } } };
  const words = await piRun(t, { flows: TEXT_FLOWS, answer: "Grocery stores", outputSchema });
  assert.equal(words.row.metrics?.path, "workflow", JSON.stringify(words.row.metrics));
  assert.deepEqual(words.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["answered"]);
  assert.deepEqual(structuredAnswer(finalOf(words.timeline), outputSchema), { value: { category: "Grocery stores" } });
});

test("an agent with an output schema: a workflow's object output is served as it is, fenced; without a schema it is left as the workflow gave it", async (t) => {
  const outputSchema = { type: "object", properties: { answer: { type: "number" } } };
  const json = await piRun(t, { outputSchema });
  assert.equal(json.row.metrics?.path, "workflow", JSON.stringify(json.row.metrics));
  assert.deepEqual(structuredAnswer(finalOf(json.timeline), outputSchema), { value: { answer: 42, sure: true } });
  const bare = await piRun(t);
  assert.doesNotMatch(finalOf(bare.timeline), /```/);
});

test("an agent with an output schema: an output that cannot be shaped to it goes back to the agent, the reason in its handback", async (t) => {
  const outputSchema = { type: "object", required: ["answer"], properties: { answer: { type: "number" } } };
  const words = await piRun(t, { flows: TEXT_FLOWS, answer: "forty-two", outputSchema });
  assert.equal(words.row.metrics?.path, "handed_back", JSON.stringify(words.row.metrics));
  assert.deepEqual(words.entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  const handed = words.timeline.find((one) => /handed it back to you/.test(one.text ?? ""));
  assert.ok(handed, "the agent's first input is the handback");
  assert.match(handed.text, /forty-two/, "the workflow's own answer is in it");
  assert.match(handed.text, /does not meet the agent's output schema: \/answer/, `the reason is in it: ${handed.text}`);
});

test("answerAsServed: one answer as served for serving, replay and grading; what it serves reads back as the value it shaped", () => {
  const mcc = { type: "object", required: ["mcc"], properties: { mcc: { type: "string" } } };
  const cases = [
    ["5462", mcc, { mcc: "5462" }],
    ["Grocery stores", mcc, { mcc: "Grocery stores" }],
    ['{"mcc":"5462"}', mcc, { mcc: "5462" }],
    ["7", { type: "object", required: ["n"], properties: { n: { type: "number" }, why: { type: "string" } } }, { n: 7 }],
    ['Done.\n```json\n{"mcc":"5999"}\n```', mcc, { mcc: "5999" }],
  ];
  for (const [output, schema, value] of cases) {
    const served = answerAsServed(output, schema);
    assert.deepEqual(served.value, value, `${output}: ${JSON.stringify(served)}`);
    assert.deepEqual(structuredAnswer(served.text, schema), { value }, `${output}: the grade path (result.output) reads what serving shaped`);
  }
  // A replay of a one-field workflow agrees with its graded answer: the replay's answer is the served one, read as a value.
  const replayed = answerAsServed("5462", mcc);
  assert.deepEqual(answerJson(replayed.text), { value: { mcc: "5462" } });
  assert.match(answerAsServed("forty-two", { type: "object", required: ["n"], properties: { n: { type: "number" } } }).why ?? "", /^its answer does not meet the agent's output schema: \/n /);
  assert.deepEqual(answerAsServed("5462", undefined), { text: "5462", value: "5462" }, "no schema: as the workflow gave it");
});

test("a claim that dies after the workflow handed the job back: the next claim sends the handback even when the money rule now stops the workflow", async (t) => {
  const { row, gateway, entries, claims } = await piRun(t, { sure: false, crashOnHandback: true, past: pastRuns({ servedUsd: 0.5, byHandUsd: 0.2 }), pastFromSecondClaim: true });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"], "one step on the record: the money rule's stop added none");
  assert.equal(gateway.requests.filter(isNode).length > 0, true, "the workflow ran once, on the first claim");
  const firstAgent = gateway.requests.find((request) => !isNode(request));
  assert.match(textOf(firstAgent.body), /Your learned workflow `answer` ran first on this job and handed it back to you/, "the agent's first input is the handback, not the bare job");
});

test("the cost page reads the workflows' history over the same window the launch's money rule does (the agent's newest PAST_RUNS runs)", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-workflow-first-cost-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const at = Date.UTC(2026, 10, 12);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(`run-${i}`);
    await store.runs.create({ id: `run-${i}`, agentId: "agent-1", revisionId: "rev-1" });
  }
  await store.flush?.();
  const db = new DatabaseSync(join(dir, "store.sqlite"), { timeout: 5_000 });
  try {
    // run-0 the newest; the three older ones are served runs of one digest, the newest of them at 0.9, the oldest two at 0.1.
    ids.forEach((id, i) => db.prepare("UPDATE runs SET state = 'ended', started_at = ?, ended_at = ?, cost_usd = ?, metrics = ? WHERE id = ?").run(at - i * 60_000, at - i * 60_000 + 1_000, i === 0 ? 0.9 : 0.1, JSON.stringify({ path: "handed_back", workflow: "answer", workflow_digest: DIGEST, learned_revision: "s" }), id));
  } finally {
    db.close();
  }
  const seen = [];
  // A store whose history window is two runs: its list honours `limit`, newest first, as the runner's does at PAST_RUNS.
  const windowed = new Proxy(store, { get: (target, key) => (key === "runs" ? { ...store.runs, list: async (filter) => (seen.push(filter?.limit), (await store.runs.list(filter)).slice(0, filter?.limit === undefined ? undefined : 2)) } : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  const { workflows } = await agentCostOverStore(windowed, "agent-1");
  assert.ok(seen.includes(500), `the history is asked for at the runner's window: ${JSON.stringify(seen)}`);
  assert.equal(workflows[0]?.served?.runs, 2, `the window's two runs, not all four: ${JSON.stringify(workflows)}`);
});

test("workflowFirstOf: one fitting workflow serves; none, two, a workflow run, no learning start, or workflow_first false do not", async () => {
  const flow = (name, required) => ({ name, description: "", workflow: JSON.stringify({ ...answerFlow, name, schemas: { ...answerFlow.schemas, In: { type: "object", required, properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])) } } }) });
  const launch = { input: { content: "c", question: "q" }, learning: { seed: "abc" } };
  const logs = [];
  const log = (line) => logs.push(line);
  const { serve: one } = await workflowFirstOf("agentic", [flow("answer", ["question"])], launch, log);
  assert.deepEqual({ ...one, digest: typeof one.digest }, { name: "answer", digest: "string", input: launch.input, revision: "abc" });
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["question"]), flow("other", ["content"])], launch, log), {}, "two fit: the agent's");
  assert.ok(logs.some((line) => /2 of 2 learned workflows fit/.test(line)), JSON.stringify(logs));
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["missing"])], launch, log), {}, "none fit");
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", [])], launch, log), {}, "no required field: never fits");
  assert.deepEqual(await workflowFirstOf("workflow", [flow("answer", ["question"])], launch, log), {}, "a workflow run is not agentic");
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["question"])], { ...launch, learning: undefined }, log), {}, "no learning start");
  assert.deepEqual(await workflowFirstOf("agentic", [flow("answer", ["question"])], { ...launch, workflowFirst: false }, log), {}, "forced to the agent");
  assert.equal(fits({ name: "x", description: "", workflow: "not json" }, launch.input, resolveSchemaForWorkflow), false);
  // The run record carries the path only for a run that learns, as the run-end classifier gives it.
  assert.deepEqual(pathMetrics({ input: {} }, { path: "workflow", workflow: "answer" }), {});
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, undefined), { path: "agent", learned_revision: "abc" });
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, { path: "handed_back", workflow: "answer", digest: "d" }), { path: "handed_back", learned_revision: "abc", workflow: "answer", workflow_digest: "d" });
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, { path: "workflow", workflow: "answer" }), { path: "workflow", learned_revision: "abc", workflow: "answer" }, "the agent called it itself: no digest");
  // What the step did, from its entry alone.
  assert.equal(servedOf([]), undefined);
  assert.deepEqual(servedOf([{ kind: WORKFLOW_FIRST, data: { workflow: "answer", digest: "d", outcome: "handed_back" } }]), { outcome: "handed_back", workflow: "answer", digest: "d" });
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const HARNESS = "codex";

/** The same run on a CLI harness (the faux codex, through the runner's dispatch): the agent, when it gets a turn, says
 *  its thinking (faux-harness.mjs "Say your thinking."). */
async function cliRun(t, { sure = true } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-workflow-first-cli-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: ({ body }) => {
    const offered = (body?.tools ?? []).some((tool) => tool?.name === "submit");
    const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
    return offered && !answered ? { name: "submit", input: { value: { answer: sure ? 42 : 41, sure } } } : undefined;
  } });
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say your thinking.", harness: HARNESS, tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", FLOWS);
  const launch = { input: { content: `${QUESTION}?`, question: QUESTION }, title: "t", place: { mode: "runner" }, harness: HARNESS, model: { provider: "openai", modelId: "gpt-6.1-terra" }, learning: startAt(seed) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const env = { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-6.1-terra", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === HARNESS ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const all = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
  const requests = all.filter((record) => record.kind === "runner.request").map((record) => record.data);
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  const timeline = await runTimeline(server, RUN, ctx, { settled: true });
  return { row, requests, turns, timeline, seed };
}

test("CLI: the workflow answers alone, no harness request, path workflow, its node $ the run's cost", async (t) => {
  const { row, requests, turns, timeline, seed } = await cliRun(t);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(requests.length >= 1 && requests.every((request) => request.host === LEARNED_WORKFLOW_TOOL), `only the node's requests: ${JSON.stringify(requests)}`);
  assert.deepEqual({ path: row.metrics?.path, learned_revision: row.metrics?.learned_revision, workflow: row.metrics?.workflow }, { path: "workflow", learned_revision: seed, workflow: "answer" });
  const booked = turns.reduce((sum, turn) => sum + (typeof turn.usd === "number" ? turn.usd : 0), 0);
  assert.ok(booked > 0 && Math.abs((row.costUsd ?? 0) - booked) < 1e-9, `the run's cost is the node's booked $: ${row.costUsd} vs ${booked}`);
  assert.ok(timeline.some((one) => ["assistant", "final_answer"].includes(one.kind) && /42/.test(one.text ?? "")), JSON.stringify(timeline.map(({ kind, text }) => [kind, text])));
});

test("CLI: handed back, the harness takes the same run with the trace and ends it, path handed_back", async (t) => {
  const { row, requests, timeline } = await cliRun(t, { sure: false });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.ok(requests.some((request) => request.host === LEARNED_WORKFLOW_TOOL) && requests.some((request) => request.host === undefined), `node and harness requests both booked: ${JSON.stringify(requests)}`);
  const handed = timeline.find((one) => /handed it back to you/.test(one.text ?? ""));
  assert.ok(handed, `the harness's input carries the hand-back: ${JSON.stringify(timeline.map(({ kind, text }) => [kind, text?.slice(0, 80)]))}`);
  assert.match(handed.text, /handed the job back at its step "unsure": not sure of 41/);
  assert.match(timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text ?? "", /^Thinking /);
});
