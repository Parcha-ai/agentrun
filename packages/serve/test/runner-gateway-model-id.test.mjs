// The model id a runner run sends a gateway (AGENT_MODEL_BASE_URL) is the one main sends for the same revision on the same
// env. The run's start pins its model (runs-over-store StartDeps.modelOf: what chooseModel chose then, the gateway's
// provider and the id it was sent); the runner routes that pin as it is, never the provider and id joined back into a ref,
// which the gateway refuses ("agent-model/gpt-6-luna": 400 "Invalid model name") and which AGENT_MODEL_GATEWAY_IDS=bare
// would cut again. Table-driven over both id modes and both sources of the model (the revision's ref, the host's
// AGENT_MODEL): a pi run and a CLI run through the runner land on the loopback gateway naming main's id, priced as main
// prices it; a workflow's route, which the runner resolves from the host's tiers as main does, is checked beside them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch, PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { providerFromRoute } = await import("../dist/runner/workflow-spec.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { chooseModel, runModels, MODEL_PROVIDER } = await import("../dist/model.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { LEARNING_PIN, LEARNED_WORKFLOWS_FILE } = await import("../dist/learning.js");
const { runFolder } = await import("../dist/workspace/paths.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const fake = (name) => `not-a-secret-${name}`;

/** Each row: the gateway's id mode (`ids`), the revision's own model (`model`, absent for the host's), the host's
 *  AGENT_MODEL, and the id main sends the gateway for it (model.ts chooseModel, as app.ts runModels asks it). */
const ROWS = [
  { name: "whole ids, the revision's openai/gpt-6-luna", ids: undefined, model: "openai/gpt-6-luna", host: "team-default", sent: "openai/gpt-6-luna" },
  { name: "bare ids, the revision's openai/gpt-6-luna", ids: "bare", model: "openai/gpt-6-luna", host: "team-default", sent: "gpt-6-luna" },
  { name: "whole ids, the host's gpt-6-luna", ids: undefined, model: undefined, host: "gpt-6-luna", sent: "gpt-6-luna" },
  { name: "bare ids, the host's openai/gpt-6-luna", ids: "bare", model: undefined, host: "openai/gpt-6-luna", sent: "openai/gpt-6-luna" },
  // No price set: the catalog prices it, as the provider the revision names lists it (OpenAI's entry has tiers past 272k
  // input tokens; the highest of the others has none), so a bare id priced without that provider is priced wrong.
  { name: "bare ids, the revision's openai/gpt-5.5 at the catalog's price", ids: "bare", model: "openai/gpt-5.5", host: "team-default", sent: "gpt-5.5", catalog: true },
];

/** The operator's gateway env for `row`, at the loopback gateway `url`: priced $1 in and $2 out a million, unless the
 *  row is the catalog's to price. */
const gatewayEnv = (url, row) => ({
  AGENT_MODEL_BASE_URL: `${url}/v1`,
  AGENT_MODEL_API_KEY: fake("gateway"),
  AGENT_MODEL: row.host,
  ...(row.catalog ? {} : { AGENT_MODEL_PRICE: "1,2" }),
  ...(row.ids ? { AGENT_MODEL_GATEWAY_IDS: row.ids } : {}),
});

/** One model node (`extract`) workflow: learned_workflow runs it, its node a request on the session's model. */
const answerFlow = {
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};

/** The node's submit, when a request offers the node's submit tool and carries no tool result yet. */
const submitsAnswer = ({ body }) => {
  const offers = (body?.tools ?? []).some((tool) => tool?.name === "submit");
  const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
  return offers && !answered ? { name: "submit", input: { value: { answer: 42 } } } : undefined;
};

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The id main sends the gateway for `row` on `env` (asserted to be the row's), and the model the run's start pins: the
 *  model main's runModels chose (runModelRef), the gateway's provider and that id. */
async function mainOf(env, row, harness) {
  const chosen = await chooseModel(env, row.model, "default", harness);
  assert.ok(!("why" in chosen), `main runs ${row.name}: ${JSON.stringify(chosen)}`);
  assert.equal(chosen.model.modelId, row.sent, `main sends ${row.sent} for ${row.name}`);
  const pin = (await runModels(env, row.model, ["default"], harness)).model;
  assert.deepEqual(pin, { provider: MODEL_PROVIDER, modelId: row.sent }, "the start pins the gateway's provider and the id main sends");
  return pin;
}

/** A store with agent-1's revision (its own model when `model`) and run-1 launched on `pin`, cleaned up after `t`. */
async function storeWith(t, revision, launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gateway-model-id-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Gateway" }, { id: "rev-1", kind: "agentic", body: revision });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  return { dir, server, store };
}

/** Run-1 to its end under a runner whose loop `createLoop` makes; its row. */
async function runToEnd(t, store, server, createLoop) {
  const runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop });
  t.after(() => runner.close().catch(() => {}));
  return until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
}

/** The model ids of the gateway's model requests (its POSTs). */
const sentIds = (gateway) => gateway.requests.filter((request) => request.method === "POST").map((request) => request.body?.model);

for (const row of ROWS) {
  test(`${row.name}: a pi run through the runner sends the gateway main's id (${row.sent}), routed and priced as main routes it`, async (t) => {
    const gateway = await startFauxGateway();
    t.after(() => gateway.close());
    const env = gatewayEnv(gateway.url, row);
    const pin = await mainOf(env, row, "pi");
    const launch = { input: { content: "Say hello." }, title: "t", place: { mode: "runner" }, model: pin };
    const { dir, server, store } = await storeWith(t, { instructions: "Answer.", tools: ["read"], ...(row.model ? { model: row.model } : {}) }, launch);
    let route;
    const deps = {
      env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY,
      routeOf: async (...ask) => (route = await routeOf(...ask)),
      computerForClaim: async () => ({ release: async () => {} }),
    };
    const ended = await runToEnd(t, store, server, createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)));
    const ids = sentIds(gateway);
    assert.ok(ids.length >= 1, `the run's requests reached the gateway: ${JSON.stringify(gateway.requests.map((request) => request.path))}`);
    assert.deepEqual([...new Set(ids)], [row.sent], `every request names main's id ${row.sent}`);
    assert.equal(ended.state, "ended", `the run ended: ${JSON.stringify(ended)}`);
    // Main's route of the same revision on the same env (routeOf from the revision's own ref, as app.ts asks it): the
    // runner's is that route, its model and its catalog price both.
    const main = await routeOf(row.model, env, "default", PI_WIRES);
    if (row.catalog) assert.ok(main.cost?.tiers?.length, `main prices ${row.model} as OpenAI lists it, tiers and all: ${JSON.stringify(main.cost)}`);
    assert.deepEqual([route.model, route.cost, route.provider.api], [main.model, main.cost, main.provider.api], "the runner's route is main's");
  });

  test(`${row.name}: a CLI run through the runner sends the gateway main's id (${row.sent})`, async (t) => {
    // The faux CLI harness's own requests are scripted, never sent; a learned workflow's model node goes through the
    // session's model proxy to the gateway on the session's model, as the CLI's own requests would.
    const gateway = await startFauxGateway({ call: submitsAnswer });
    t.after(() => gateway.close());
    const harness = "codex";
    // The harness table loads a test's module only under a test runner (harness-table.ts): the runner's CLI spec takes the
    // faux harness this test names, never the built-in codex (not installed here).
    const env = { ...gatewayEnv(gateway.url, row), AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
    const pin = await mainOf(env, row, harness);
    const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness, model: pin };
    const revision = { instructions: "Use the learned workflow answer on What is six times seven.", harness, tools: ["read", LEARNED_WORKFLOW_TOOL], ...(row.model ? { model: row.model } : {}) };
    const { dir, server, store } = await storeWith(t, revision, launch);
    const root = runFolder(dir, "agent-1", RUN);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, LEARNING_PIN), JSON.stringify({ seed: null, section: "", workflows: ["answer"] }));
    writeFileSync(join(root, LEARNED_WORKFLOWS_FILE), JSON.stringify([{ name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(answerFlow) }]));
    const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
    const runner = startRunner({
      store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
      createLoop: createDispatchLoop({
        launchOf: (runId) => store.runs.launch(runId),
        resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
      }),
    });
    t.after(() => runner.close().catch(() => {}));
    const ended = await until(async () => {
      const now = await server.runs.get(RUN);
      return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
    }, "the run's end");
    const ids = sentIds(gateway);
    assert.ok(ids.length >= 1, `the run's requests reached the gateway: ${JSON.stringify(ended)}`);
    assert.deepEqual([...new Set(ids)], [row.sent], `every request names main's id ${row.sent}`);
    assert.equal(ended.state, "ended", `the run ended: ${JSON.stringify(ended)}`);
  });
}

test("a workflow's route takes the host's model of each tier, as main's workflow does: on the gateway, the id main sends", async () => {
  for (const row of ROWS.filter((each) => each.model === undefined)) {
    const env = gatewayEnv("http://127.0.0.1:9", row);
    const main = await chooseModel(env, undefined, "default");
    const provider = await providerFromRoute(await routeOf(undefined, env, "default", PI_WIRES));
    assert.deepEqual([main.model.modelId, provider.modelId], [row.sent, row.sent], `${row.name}: the workflow's node sends main's id`);
  }
});
