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
//   - the deopt breaker: a workflow that handed back more than half of its last 10 runs at its digest is skipped.
// pi's model and the node's go through the session proxy to a loopback gateway; no sleeps, no port races. The same on a
// CLI harness (the faux one the harness table hands the runner): one loop serves every harness.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { BREAKER_WINDOW, breakerOf, fits, workflowFirstOf, pathMetrics, WORKFLOW_FIRST } = await import("../dist/runner/workflow-first.js");
const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");

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
 *  stop the run while it waits instead). */
async function piRun(t, { input = { content: `${QUESTION}?`, question: QUESTION }, sure = true, learned = true, workflowFirst, toolSettings, approve = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-workflow-first-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: sure ? 42 : 41, sure } } } : undefined),
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
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], ...(learned ? { learning: true } : {}), ...(toolSettings ? { toolSettings } : {}) } });
  const seed = learned ? await landWorkflows(dir, "agent-1", FLOWS) : undefined;
  const launch = { input, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...(learned ? { learning: startAt(seed) } : {}), ...(workflowFirst === false ? { workflowFirst: false } : {}) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  const settled = (states) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && now;
  }, `the run ${states.join("/")}`);
  let parked;
  if (approve) {
    parked = await settled(["parked", "ended", "failed", "stopped"]);
    const callId = await until(async () => {
      const row = await server.runs.get(RUN);
      const entries = (await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx)).entries;
      return entries.find((entry) => entry.kind === "agentrun.ask")?.data?.callId;
    }, "the step's ask", 10_000);
    parked = { ...parked, callId, requestsWhileParked: gw.requests.length };
    await sendCommand(server, RUN, approve === "stop" ? { kind: "stop" } : { kind: "approve", body: { approval: callId } });
  }
  const row = await settled(["ended", "failed", "stopped"]);
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
  return { row, requests, turns, timeline, entries, kept, reflect, gateway: gw, seed, parked, logs };
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
  assert.ok(requests.some((request) => request.host === LEARNED_WORKFLOW_TOOL) && requests.some((request) => request.host === undefined), `node and agent requests both booked: ${JSON.stringify(requests)}`);
  assert.ok((row.costUsd ?? 0) > 0, `the run's cost: ${row.costUsd}`);
});

test("handed back: the end-of-run turn asks for the workflow's next revision by its name", async (t) => {
  const { gateway } = await piRun(t, { sure: false });
  const ask = gateway.requests.find((request) => !isNode(request) && /handed it back to you\. If a change to it would have let it finish this case/.test(textOf(request.body)));
  assert.ok(ask, `the reflect turn asked about \`answer\`: ${gateway.requests.map((request) => textOf(request.body).slice(-300)).join("\n---\n")}`);
  assert.match(textOf(ask.body), /give `answer` again whole under its name/);
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

test("the deopt breaker skips a workflow that handed back more than half its last runs at its digest", async () => {
  const digest = "0123456789abcdef";
  const runs = (handed, of, extra = {}) => Array.from({ length: of }, (_, i) => ({ path: i < handed ? "handed_back" : "workflow", workflow: "answer", workflow_digest: digest, ...extra }));
  assert.deepEqual(breakerOf(runs(6, BREAKER_WINDOW), "answer", digest), { handedBack: 6, of: BREAKER_WINDOW });
  assert.equal(breakerOf(runs(5, BREAKER_WINDOW), "answer", digest), undefined, "half is not more than half");
  assert.equal(breakerOf(runs(9, 9), "answer", digest), undefined, "a window not yet full never trips");
  assert.equal(breakerOf(runs(10, 10), "answer", "fedcba9876543210"), undefined, "a new revision of the workflow starts clean");
  assert.equal(breakerOf(runs(10, 10, { workflow: "other" }), "answer", digest), undefined, "another workflow's runs are not its record");
  // Agent-path runs between them do not count, and only the newest window is read.
  assert.deepEqual(breakerOf([{ path: "agent" }, ...runs(0, 4), ...runs(10, 10)], "answer", digest), { handedBack: 6, of: BREAKER_WINDOW }, "the newest 10: 4 served, 6 handed back");
  assert.equal(breakerOf([{ path: "agent" }, ...runs(0, 5), ...runs(10, 10)], "answer", digest), undefined, "the newest 10: 5 served, 5 handed back");
});

test("workflowFirstOf: one fitting workflow serves; none, two, a workflow run, no learning start, a breaker open, or workflow_first false do not", async () => {
  const flow = (name, required) => ({ name, description: "", workflow: JSON.stringify({ ...answerFlow, name, schemas: { ...answerFlow.schemas, In: { type: "object", required, properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])) } } }) });
  const launch = { input: { content: "c", question: "q" }, learning: { seed: "abc" } };
  const logs = [];
  const log = (line) => logs.push(line);
  const one = await workflowFirstOf("agentic", [flow("answer", ["question"])], launch, log);
  assert.deepEqual({ ...one, digest: typeof one.digest }, { name: "answer", digest: "string", input: launch.input, revision: "abc" });
  assert.equal(await workflowFirstOf("agentic", [flow("answer", ["question"]), flow("other", ["content"])], launch, log), undefined, "two fit: the agent's");
  assert.ok(logs.some((line) => /2 of 2 learned workflows fit/.test(line)), JSON.stringify(logs));
  assert.equal(await workflowFirstOf("agentic", [flow("answer", ["missing"])], launch, log), undefined, "none fit");
  assert.equal(await workflowFirstOf("agentic", [flow("answer", [])], launch, log), undefined, "no required field: never fits");
  assert.equal(await workflowFirstOf("workflow", [flow("answer", ["question"])], launch, log), undefined, "a workflow run is not agentic");
  assert.equal(await workflowFirstOf("agentic", [flow("answer", ["question"])], { ...launch, learning: undefined }, log), undefined, "no learning start");
  assert.equal(await workflowFirstOf("agentic", [flow("answer", ["question"])], { ...launch, workflowFirst: false }, log), undefined, "forced to the agent");
  const past = async () => Array.from({ length: 10 }, () => ({ path: "handed_back", workflow: "answer", workflow_digest: one.digest }));
  assert.equal(await workflowFirstOf("agentic", [flow("answer", ["question"])], launch, log, past), undefined, "the breaker is open");
  assert.ok(logs.some((line) => /answer handed back 10 of its last 10 runs/.test(line)), JSON.stringify(logs));
  assert.equal(fits({ name: "x", description: "", workflow: "not json" }, launch.input, resolveSchemaForWorkflow), false);
  // The run record carries the path only for a run that learns.
  assert.deepEqual(pathMetrics({ input: {} }, []), {});
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, []), { path: "agent", learned_revision: "abc" });
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
