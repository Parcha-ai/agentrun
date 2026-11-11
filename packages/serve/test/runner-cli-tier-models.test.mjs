// A CLI run's learned workflow node of a tier (claude-agent's wire and codex's) runs on the host's model of that tier
// (AGENT_MODEL_FAST, AGENT_MODEL_STRONG) through the runner's adapter loop: on a proxy of its own beside the CLI session's,
// on the session's booking, so it is the run's request, held under the run's cap and booked at that model's own price,
// while the harness's own requests stay on the run's model at its price. A tier the host has no model of runs on the
// session's model. The faux CLI harness (the harness table's, keeping each harness's wire) on a faux gateway on loopback,
// each model with its own price.
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
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const fake = (name) => `not-a-secret-${name}`;
/** Each gateway model's price, USD per million input, output, cache-read and cache-write tokens. */
const PRICES = { "gpt-run": [1, 2, 0.5], "gpt-fast": [10, 20, 5], "gpt-strong": [100, 200, 50] };
const price = (model) => PRICES[model].join(",");
const near = (a, b) => Math.abs(a - b) < 1e-12;
/** Each harness's models, on the faux gateway at `url`: codex's on the gateway itself (AGENT_MODEL_BASE_URL), each at its
 *  own price; claude-agent's Anthropic's (its own provider, at ANTHROPIC_BASE_URL), each at its catalog price. The run's
 *  model, its launch's, and the env naming each tier's (`tiers`: which tiers the host has a model of). */
const MODELS = {
  codex: {
    launch: { provider: "openai", modelId: "gpt-run" },
    env: (url, tiers) => ({
      AGENT_MODEL_BASE_URL: url, AGENT_MODEL: "gpt-run", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: price("gpt-run"),
      ...(tiers.includes("fast") ? { AGENT_MODEL_FAST: "gpt-fast", AGENT_MODEL_FAST_PRICE: price("gpt-fast") } : {}),
      // The run's own model's id as the fast tier's, at the fast price: one id two routes price apart.
      ...(tiers.includes("fast-shared") ? { AGENT_MODEL_FAST: "gpt-run", AGENT_MODEL_FAST_PRICE: price("gpt-fast") } : {}),
      ...(tiers.includes("strong") ? { AGENT_MODEL_STRONG: "gpt-strong", AGENT_MODEL_STRONG_PRICE: price("gpt-strong") } : {}),
    }),
  },
  "claude-agent": {
    launch: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    env: (url, tiers) => ({
      ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: fake("anthropic"), AGENT_MODEL: "anthropic/claude-sonnet-4-5",
      ...(tiers.includes("fast") ? { AGENT_MODEL_FAST: "anthropic/claude-haiku-4-5" } : {}),
      ...(tiers.includes("strong") ? { AGENT_MODEL_STRONG: "anthropic/claude-opus-4-5" } : {}),
    }),
  },
};
/** The gateway's usage on every answer: 10 tokens in, 2 out. */
const USAGE = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
/** The model `env` routes `tier` to (model-route.ts routeOf, as the runner routes it), one answer's price on it, and its
 *  output price (USD per token). */
const pricedOf = async (env, tier) => {
  const route = await routeOf(undefined, env, tier, ["anthropic-messages", "openai-responses"]);
  return { model: route.model, usd: route.price(route.model, USAGE), input: route.cost.input / 1e6, output: route.cost.output / 1e6 };
};

/** A one model node (`extract`) workflow, its node of `tier` (none: the default). */
const flowOf = (tier) => ({
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", ...(tier ? { tier } : {}) }] },
});

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

/** A capped CLI run of `harness` (the faux harness on that harness's wire) whose learned workflow's node names `tier`, on a
 *  gateway serving the run's model and `tierEnv`'s: its end, its booked requests (each with its turn's cost) and what the
 *  gateway was asked for. */
async function tieredRun(t, harness, tier, tiers) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-tiers-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: submitsAnswer });
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
  // The faux harness reads the turn from the system prompt: the instruction names the learned workflow to run.
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Use the learned workflow answer on What is six times seven.", harness, tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: flowOf(tier) }]);
  // Capped: every request is admitted under the run's one cap, held at its model's price before it leaves.
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness, model: MODELS[harness].launch, max_cost_usd: 50, learning: startAt(seed) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const models = MODELS[harness].env(gw.url, tiers);
  const env = { ...models, AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf, computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
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
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  const booked = all.filter((record) => record.kind === "runner.request").map(({ data }) => ({ host: data.host, held: data.heldUsd, usd: turns.find((turn) => turn.turn === data.turn)?.usd }));
  const sent = gw.requests.map((request) => ({ model: request.body?.model, node: (request.body?.tools ?? []).some((tool) => tool?.name === "submit"), asked: request.body?.max_tokens ?? request.body?.max_output_tokens }));
  return { row, booked, sent, own: await pricedOf(models, "default"), tierPriced: await pricedOf(models, tier) };
}

for (const harness of ["claude-agent", "codex"]) {
  for (const tier of ["fast", "strong"]) {
    test(`a ${harness} run's learned ${tier} node runs on the host's ${tier} model, held under the run's cap and booked at that model's own price`, { timeout: 60_000 }, async (t) => {
      const { row, booked, sent, own, tierPriced } = await tieredRun(t, harness, tier, [tier]);
      assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
      assert.notEqual(tierPriced.model, own.model);
      assert.ok(!near(tierPriced.usd, own.usd), "the tier's model has a price of its own");
      assert.deepEqual(sent.filter((one) => one.node).map((one) => one.model), [tierPriced.model], `the node asks for ${tierPriced.model}: ${JSON.stringify(sent)}`);
      assert.ok(sent.filter((one) => !one.node).every((one) => String(one.model).endsWith(own.model)), `the harness's own stay on the run's model: ${JSON.stringify(sent)}`);
      const node = booked.filter((one) => one.host === LEARNED_WORKFLOW_TOOL);
      assert.equal(node.length, 1, JSON.stringify(booked));
      assert.ok(near(node[0].usd, tierPriced.usd), `booked at ${tierPriced.model}'s price: ${node[0].usd} vs ${tierPriced.usd}`);
      // Held under the run's cap at the tier model's own price: the output it asked for at its output price, and its small
      // input (a node's prompt, a few thousand tokens at most) beside it. At the run's model's price it would be another figure.
      const outputHold = sent.find((one) => one.node).asked * tierPriced.output;
      assert.ok(typeof node[0].held === "number" && node[0].held >= outputHold && node[0].held < outputHold + 5_000 * tierPriced.input, `held under the run's cap at ${tierPriced.model}'s price: ${JSON.stringify(node[0])}, its output hold ${outputHold}`);
      const harnessOwn = booked.filter((one) => one.host === undefined);
      assert.ok(harnessOwn.length >= 1 && harnessOwn.every((one) => typeof one.usd === "number" && !near(one.usd, tierPriced.usd)), `the harness's own not at the tier's price: ${JSON.stringify(harnessOwn)}`);
    });
  }

  if (harness === "codex") {
    test("a codex run's learned fast node on the model id the run's own model shares, at a dearer fast price: held under the run's cap at the price its route books it at, and booked there", { timeout: 60_000 }, async (t) => {
      const { row, booked, sent } = await tieredRun(t, harness, "fast", ["fast-shared"]);
      assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
      const nodeSent = sent.find((one) => one.node);
      assert.equal(nodeSent?.model, "gpt-run", JSON.stringify(sent));
      const node = booked.filter((one) => one.host === LEARNED_WORKFLOW_TOOL);
      assert.equal(node.length, 1, JSON.stringify(booked));
      const [inPrice, outPrice] = PRICES["gpt-fast"].map((usd) => usd / 1e6);
      assert.ok(near(node[0].usd, (10 * PRICES["gpt-fast"][0] + 2 * PRICES["gpt-fast"][1]) / 1e6), `booked at the fast route's price: ${node[0].usd}`);
      const outputHold = nodeSent.asked * outPrice;
      assert.ok(node[0].held >= outputHold && node[0].held < outputHold + 5_000 * inPrice, `held at the fast route's price, never the run's: ${JSON.stringify(node[0])}, its output hold ${outputHold}`);
      // And the harness's own requests on the same id, by the session's route, held at the run's price: a tenth of the fast
      // price, never the fast route's.
      const own = booked.filter((one) => one.host === undefined);
      assert.ok(own.length >= 1 && own.every((one) => one.held < node[0].held / 5), `the harness's own held at the run's price: ${JSON.stringify(own)} vs the node's ${node[0].held}`);
    });
  }

  test(`a ${harness} run's learned fast node, where the host has no fast model, runs on the session's model at its price`, { timeout: 60_000 }, async (t) => {
    const { row, booked, sent, own } = await tieredRun(t, harness, "fast", []);
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
    assert.deepEqual(sent.filter((one) => one.node).map((one) => String(one.model).endsWith(own.model)), [true], JSON.stringify(sent));
    const node = booked.filter((one) => one.host === LEARNED_WORKFLOW_TOOL);
    assert.equal(node.length, 1, JSON.stringify(booked));
    assert.ok(typeof node[0].usd === "number" && node[0].usd > 0, `priced by the session: ${JSON.stringify(node[0])}`);
  });
}
