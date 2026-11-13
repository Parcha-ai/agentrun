// The runner's other model callers speak the route's wire, as pi does (runner/adapters/pi.ts policyFor, port-models.ts
// sessionModel): the learning grader (learning-ask.ts bookedAsk) and a workflow's model nodes (workflow-spec.ts
// providerFromRoute). Each takes the policy of its route's API (claude-agent's on Messages, codex's on Responses, no
// fork) and points pi-ai's client of that API at its session proxy, so an OpenAI-family model is reached on its own
// Responses wire, never through the Messages translation (model-route.ts messagesFetch). Their routes are asked on both of
// pi's wires (PI_WIRES): the learning dispatch's (harness-loops.ts) and the workflow's (routeProviderOf).
//
// Table-driven over WIRES, through the loopback gateway stand-in: on each wire the grade and a model node land on that
// wire's path, are booked on the run's own ledger, and past the cap are refused before they are sent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf, providerFromRoute, routeProviderOf } = await import("../dist/runner/workflow-spec.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { bookedAsk } = await import("../dist/runner/learning-ask.js");
const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { runLearningEnd } = await import("../dist/store-reads/learning.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { capModelOf, PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");
const { WIRES } = await import("../dist/wires.js");
const { beforeRequestOf } = await import("../../run-adapters/dist/kernel/cap/index.js");

const KEY = `not-a-secret-${"w"}`;
const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", why: "useful" }] });
/** The gateway env serve's operator sets: its own Responses route, priced $1 a million each way. */
const GATEWAY_ENV = (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: "team-model", AGENT_MODEL_PRICE: "1,1" });

/** On each wire, a source whose route speaks it straight to the gateway (no translation), and where its requests land. */
const SOURCES = {
  "anthropic-messages": { model: "anthropic/claude-sonnet-4-5", env: (url) => ({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: url }), path: "/v1/messages" },
  "openai-responses": { model: undefined, env: GATEWAY_ENV, path: "/v1/responses" },
};

/** A source pi-ai speaks neither wire to: OpenRouter's openai/* models are openai-completions in pi-ai, not a wire of
 *  WIRES, so their route stays the Messages translation (model-route.ts messagesFetch, the runner's redactor on it), and
 *  their requests land on Chat Completions. */
const TRANSLATED = { model: "openrouter/openai/gpt-5", env: () => ({ OPENROUTER_API_KEY: KEY }), path: "/v1/chat/completions" };
/** A fetch that sends each request to the gateway at `url`, on its own path: OpenRouter's origin stood in for. */
const toGateway = (url) => (target, init) => fetch(`${url}${new URL(String(target)).pathname}`, init);

/** The route pi gets for `wire`'s source, at the gateway. */
async function routeFor(wire, gateway) {
  const source = SOURCES[wire];
  const route = await routeOf(source.model, source.env(gateway.url), "default", PI_WIRES);
  assert.deepEqual([route.provider.api, route.fetch], [wire, undefined], `${wire}: the source's own route, not translated`);
  return route;
}

/** The dollars run `runId`'s sessions booked, read under a reader's claim. */
async function spentIn(store, runId) {
  const row = await store.runs.get(runId);
  const harness = await Harness.open(store.journal({ runId, runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    let spent = 0;
    for (const key of await sessions.keys()) spent += sessionSpendOf(await sessions.read(key)).spentUsd;
    return spent;
  } finally {
    await harness.close(ctx);
  }
}

/** run-1 ended keeping NOTE, its learning run learn-1 queued, as the run's end commit writes them. */
async function ended(t) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  return { store, dir };
}

/** learn-1 claimed and run with the grader's ask on `route` (its proxy's upstream the gateway), under `capUsd`. */
async function gradeOn(t, route, capUsd) {
  const { store, dir } = await ended(t);
  const ask = bookedAsk({ ...route, beforeRequest: beforeRequestOf({ capUsd: () => capUsd, modelOf: () => capModelOf(route) }) });
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const end = await learningLoopFactory({ store, data: dir, ask })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  return { end, store };
}

for (const wire of Object.keys(SOURCES)) {
  test(`${wire}: the learning grade lands on its wire's path, is booked in the learning run's records, and past the cap is refused before it is sent`, async (t) => {
    const gateway = await startFauxGateway({ text: KEEP, usage: { input: 1_000, output: 40 } });
    t.after(() => gateway.close());
    const route = await routeFor(wire, gateway);
    const { end, store } = await gradeOn(t, route, 1);
    assert.deepEqual(end, { state: "ended" });
    assert.deepEqual(gateway.requests.map((request) => request.path), [SOURCES[wire].path], `one grade request, on ${wire}'s path`);
    const learning = await runLearningEnd(store, "run-1");
    assert.equal(learning?.state, "merged", JSON.stringify(learning));
    assert.ok(learning.cost_usd.grade > 0, `the grade's dollars: ${JSON.stringify(learning.cost_usd)}`);
    assert.ok(Math.abs((await spentIn(store, "learn-1")) - learning.cost_usd.grade) < 1e-12, "booked in the learning run's own records");

    const before = gateway.requests.length;
    const refused = await gradeOn(t, route, 1e-9);
    assert.deepEqual(refused.end, { state: "ended" });
    assert.equal(gateway.requests.length, before, "past the cap: not sent");
    assert.equal((await runLearningEnd(refused.store, "run-1"))?.reason, "grade_failed");
  });
}

test("a model on neither wire (OpenRouter's openai-completions) keeps the translated route: its grade still lands, on Chat Completions, and is booked", async (t) => {
  const gateway = await startFauxGateway({ text: KEEP, usage: { input: 1_000, output: 40 } });
  t.after(() => gateway.close());
  const route = await routeOf(TRANSLATED.model, TRANSLATED.env(), "default", PI_WIRES, toGateway(gateway.url));
  assert.equal(route.provider.api, "anthropic-messages", "the translation's own Messages face");
  assert.equal(typeof route.fetch, "function", "translated, through the route's fetch");
  const { end, store } = await gradeOn(t, route, 1);
  assert.deepEqual(end, { state: "ended" });
  assert.equal(gateway.requests.length, 1, "one grade request");
  assert.ok(gateway.requests[0].path.endsWith(TRANSLATED.path), `on Chat Completions (OpenRouter's base holds /api): ${gateway.requests[0].path}`);
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.ok(learning.cost_usd.grade > 0, `the grade's dollars: ${JSON.stringify(learning.cost_usd)}`);
});

/** A one-model-node workflow (extract): it reads {question} and submits {answer}. */
const answerFlow = () => ({
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
});

/** run-1, a workflow run of answerFlow under `capUsd`, run by a runner whose model nodes take `providerOf`; its row once
 *  it leaves running. */
async function workflowOn(t, providerOf, capUsd) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wires-callers-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: answerFlow() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { question: "Six times seven?" }, title: "t", place: { mode: "runner" }, max_cost_usd: capUsd } });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf })), name: "runner-a", ...TIMING });
  const started = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (!["queued", "running"].includes(row.state) && row.runner === null) return { row, store: server };
    if (Date.now() - started > 30_000) assert.fail(`the run never left running: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const wire of Object.keys(SOURCES)) {
  test(`${wire}: a workflow model node lands on its wire's path, is booked on the run's ledger, and past the cap is refused before it is sent`, async (t) => {
    const gateway = await startFauxGateway({ call: () => ({ name: "submit", input: { answer: 42 } }), usage: { input: 1_000, output: 40 } });
    t.after(() => gateway.close());
    const route = await routeFor(wire, gateway);
    const { row, store } = await workflowOn(t, async () => providerFromRoute(route), 100);
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.ok(gateway.requests.length >= 1 && gateway.requests.every((request) => request.path === SOURCES[wire].path), JSON.stringify(gateway.requests.map((request) => request.path)));
    assert.ok(row.costUsd > 0, `booked: ${row.costUsd}`);
    assert.ok(Math.abs((await spentIn(store, "run-1")) - row.costUsd) < 1e-12, "the run's cost is its sessions' booking");

    const before = gateway.requests.length;
    const refused = await workflowOn(t, async () => providerFromRoute(route), 1e-9);
    assert.notEqual(refused.row.state, "ended", JSON.stringify(refused.row));
    assert.equal(gateway.requests.length, before, "past the cap: not sent");
  });
}

test("the table names every wire", () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), Object.keys(WIRES).sort());
});

test("a workflow's model route is asked on both of pi's wires: on serve's gateway its model node gets the gateway's own Responses route, not the Messages translation", async () => {
  const provider = await routeProviderOf(GATEWAY_ENV("http://127.0.0.1:9"))("default");
  assert.deepEqual([provider.api, provider.modelId, provider.fetch], ["openai-responses", "team-model", undefined]);
});

test("the learning dispatch asks the grade's route on both of pi's wires, and its grade lands on the gateway's Responses path", async (t) => {
  const gateway = await startFauxGateway({ text: KEEP });
  t.after(() => gateway.close());
  const { store, dir } = await ended(t);
  const asked = [];
  const deps = {
    env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32),
    computerForClaim: async () => ({ release: async () => {} }),
    routeOf: async (_model, _env, tier, wires) => (asked.push(wires), routeOf(undefined, GATEWAY_ENV(gateway.url), tier, wires)),
  };
  const factory = await resolveRunnerLoop(deps)("learning", await store.runs.launch("learn-1"), "learn-1");
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const end = await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual(asked, [PI_WIRES], "asked on pi's wires");
  assert.deepEqual(gateway.requests.map((request) => request.path), ["/v1/responses"]);
  assert.equal((await runLearningEnd(store, "run-1"))?.state, "merged");
});
