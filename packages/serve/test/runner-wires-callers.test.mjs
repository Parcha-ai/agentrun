// The runner's other model callers speak the route's wire, as pi does (runner/adapters/pi.ts policyFor, port-models.ts
// sessionModel): an SDK run's end-of-run ask (sdk-ask.ts bookedAsk) and a workflow's model nodes (workflow-spec.ts
// providerFromRoute). Each takes the policy of its route's API (claude-agent's on Messages, codex's on Responses, no
// fork) and points pi-ai's client of that API at its session proxy, so an OpenAI-family model is reached on its own
// Responses wire, never through the Messages translation (model-route.ts messagesFetch). The workflow's route is asked on
// both of pi's wires (PI_WIRES, routeProviderOf).
//
// Table-driven over WIRES, through the loopback gateway stand-in: on each wire the ask and a model node land on that
// wire's path and are booked on the run's own ledger; a model node past the cap is refused before it is sent.
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
const { bookedAsk } = await import("../dist/runner/sdk-ask.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");
const { WIRES } = await import("../dist/wires.js");

const KEY = `not-a-secret-${"w"}`;
const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
/** The ask's answer: a compile draft's opening, as any text. */
const ANSWER = "No workflow this time.";
/** The gateway env serve's operator sets: its own Responses route, priced $1 a million each way. */
const GATEWAY_ENV = (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: "team-model", AGENT_MODEL_PRICE: "1,1" });

/** On each wire, a source whose route speaks it straight to the gateway (no translation), and where its requests land. */
const SOURCES = {
  "anthropic-messages": { model: "anthropic/claude-sonnet-5-5", env: (url) => ({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: url }), path: "/v1/messages" },
  "openai-responses": { model: undefined, env: GATEWAY_ENV, path: "/v1/responses" },
};

/** A source pi-ai speaks neither wire to: OpenRouter's openai/* models are openai-completions in pi-ai, not a wire of
 *  WIRES, so their route stays the Messages translation (model-route.ts messagesFetch, the runner's redactor on it), and
 *  their requests land on Chat Completions. */
const TRANSLATED = { model: "openrouter/openai/gpt-6.1-sol", env: () => ({ OPENROUTER_API_KEY: KEY }), path: "/v1/chat/completions" };
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

/** run-1 claimed, and one SDK end-of-run ask on `route` (its proxy's upstream the gateway) answered in its records. */
async function askOn(t, route) {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const answer = await bookedAsk(route)({ prompt: "Write the job as a workflow.", maxTokens: 16_000 }, new AbortController().signal, { journal: () => store.journal(claim), flush: () => store.flush() });
  return { answer, store };
}

for (const wire of Object.keys(SOURCES)) {
  test(`${wire}: an SDK run's end-of-run ask lands on its wire's path and is booked in the run's own records`, async (t) => {
    const gateway = await startFauxGateway({ text: ANSWER, usage: { input: 1_000, output: 40 } });
    t.after(() => gateway.close());
    const route = await routeFor(wire, gateway);
    const { answer, store } = await askOn(t, route);
    assert.equal(answer.text, ANSWER);
    assert.deepEqual(gateway.requests.map((request) => request.path), [SOURCES[wire].path], `one ask, on ${wire}'s path`);
    assert.ok(answer.usd > 0, `the ask's dollars: ${answer.usd}`);
    assert.ok(Math.abs((await spentIn(store, "run-1")) - answer.usd) < 1e-12, "booked in the run's own records");
  });
}

test("a model on neither wire (OpenRouter's openai-completions) keeps the translated route: its ask still lands, on Chat Completions, and is booked", async (t) => {
  const gateway = await startFauxGateway({ text: ANSWER, usage: { input: 1_000, output: 40 } });
  t.after(() => gateway.close());
  const route = await routeOf(TRANSLATED.model, TRANSLATED.env(), "default", PI_WIRES, toGateway(gateway.url));
  assert.equal(route.provider.api, "anthropic-messages", "the translation's own Messages face");
  assert.equal(typeof route.fetch, "function", "translated, through the route's fetch");
  const { answer, store } = await askOn(t, route);
  assert.equal(answer.text, ANSWER);
  assert.equal(gateway.requests.length, 1, "one ask");
  assert.ok(gateway.requests[0].path.endsWith(TRANSLATED.path), `on Chat Completions (OpenRouter's base holds /api): ${gateway.requests[0].path}`);
  assert.ok(answer.usd > 0, `the ask's dollars: ${answer.usd}`);
  assert.ok(Math.abs((await spentIn(store, "run-1")) - answer.usd) < 1e-12, "booked in the run's own records");
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

test("a workflow model node whose route tells a refused credential (a ChatGPT plan's) tells it the credential the provider answered 401 to", async (t) => {
  const gateway = await startFauxGateway({ call: () => ({ name: "submit", input: { answer: 42 } }) });
  t.after(() => gateway.close());
  const route = await routeFor("openai-responses", gateway);
  const told = [];
  let sent = 0;
  const unauthorized = async () => (sent += 1, Response.json({ error: { message: "bad token" } }, { status: 401 }));
  const refusing = { ...route, provider: { ...route.provider, refused: async (credential) => void told.push(credential) }, fetch: unauthorized };
  const { row } = await workflowOn(t, async () => providerFromRoute(refusing), 100);
  assert.notEqual(row.state, "ended", JSON.stringify(row));
  assert.ok(sent >= 1, "the node's request reached the provider");
  assert.ok(told.length >= 1 && told.every((credential) => credential === KEY), `told the refused credential: ${told.length}`);
});

test("the table names every wire", () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), Object.keys(WIRES).sort());
});

test("a workflow's model route is asked on both of pi's wires: on serve's gateway its model node gets the gateway's own Responses route, not the Messages translation", async () => {
  const provider = await routeProviderOf(GATEWAY_ENV("http://127.0.0.1:9"))("default");
  assert.deepEqual([provider.api, provider.modelId, provider.fetch], ["openai-responses", "team-model", undefined]);
});
