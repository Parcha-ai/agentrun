// A learned workflow's node of a tier whose model is on another provider than the run's, with that provider's key saved
// in Settings → Model keys alone (none where the runner starts), runs on it: the runner opens the key the tier's model
// needs (claim-secrets.ts tierModelKeys), for the tier's route alone, and the node's request carries it. pi and
// claude-agent, through the runner's adapter loop: the run's model Anthropic's (its key where the runner starts, at a faux
// gateway on loopback), the fast tier OpenAI's (its key saved), its requests sent to the same gateway. And the key is
// never put on a tool's environment: the run's tools get claimSecrets' keys, which hold the run's own model's alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { claimSecrets, tierModelKeys, withModelKeys } = await import("../dist/runner/claim-secrets.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const ASK = "Use the learned workflow answer on What is six times seven.";
const ENV_KEY = `not-a-secret-${"anthropic-env"}`;
const SAVED_KEY = `not-a-secret-${"openai-saved"}`;
const OPENAI = "https://api.openai.com";

/** A one model node (`extract`) workflow, its node of the fast tier. */
const fastFlow = {
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", tier: "fast" }] },
};

/** pi's turn calls the learned workflow once; the node's request submits its answer; anything else says done. */
const script = ({ body }) => {
  const tools = (body?.tools ?? []).map((tool) => tool?.name);
  const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
  if (answered) return undefined;
  if (tools.includes("submit")) return { name: "submit", input: { value: { answer: 42 } } };
  if (tools.includes(LEARNED_WORKFLOW_TOOL)) return { name: LEARNED_WORKFLOW_TOOL, input: { name: "answer", input: { question: "What is six times seven?" } } };
  return undefined;
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

/** The runner's env and store for a run of `harness` whose fast tier is OpenAI's with its key saved alone. */
async function world(t, harness) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-tier-keys-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: script, text: "done" });
  t.after(async () => {
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: ASK, harness, tools: ["read"], learning: true } });
  await putSealedKey(server, SEAL_KEY, "OPENAI_API_KEY", SAVED_KEY);
  const env = {
    ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_API_KEY: ENV_KEY, AGENT_MODEL: "anthropic/claude-sonnet-4-5", AGENT_MODEL_FAST: "openai/gpt-5-mini",
    AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1",
  };
  return { dir, server, store, gw, env };
}

for (const harness of ["pi", "claude-agent"]) {
  test(`${harness}: a learned fast node on another provider's model whose key is saved alone runs on it, the saved key on its request`, { timeout: 60_000 }, async (t) => {
    const { dir, server, store, gw, env } = await world(t, harness);
    const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: fastFlow }]);
    const launch = { input: { content: ASK }, title: "t", place: { mode: "runner" }, harness, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, learning: startAt(seed) };
    await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
    await server.flush?.();
    // The run's routes as the runner resolves them, OpenAI's origin sent to the gateway on loopback (the proxy's fetch).
    const routed = async (...args) => {
      const route = await routeOf(...args);
      return route.provider.origin === OPENAI ? { ...route, fetch: (url, init) => fetch(String(url).replace(OPENAI, gw.url), init) } : route;
    };
    const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: routed, computerForClaim: async () => ({ release: async () => {} }) };
    const specOf = harness === "pi" ? adapterRunSpecFromLaunch : cliRunSpecFromLaunch;
    const runner = startRunner({
      store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
      createLoop: createDispatchLoop({
        launchOf: (runId) => store.runs.launch(runId),
        resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => specOf(given, run, deps, claim)) : undefined),
      }),
    });
    t.after(() => runner.close().catch(() => {}));
    const row = await until(async () => {
      const now = await server.runs.get(RUN);
      return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
    }, "the run's end");
    assert.equal(row.state, "ended", JSON.stringify(row));
    const node = gw.requests.filter((request) => (request.body?.tools ?? []).some((tool) => tool?.name === "submit"));
    assert.deepEqual(node.map((request) => [request.path, request.body?.model, request.headers.authorization]), [["/v1/responses", "gpt-5-mini", `Bearer ${SAVED_KEY}`]], `the node's one request is OpenAI's, on the saved key: ${JSON.stringify(gw.requests.map((r) => [r.path, r.body?.model]))}`);
    assert.ok(gw.requests.filter((request) => request.path === "/v1/messages").every((request) => request.headers["x-api-key"] === ENV_KEY), "the run's own model keeps its own key");
  });
}

test("the saved key a learned tier needs is opened for its route alone: readable by name, never enumerable, and never on the run's tool environment", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-tier-keys-unit-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: ASK, tools: ["read"], learning: true } });
  await putSealedKey(store, SEAL_KEY, "OPENAI_API_KEY", SAVED_KEY);
  const env = { ANTHROPIC_API_KEY: ENV_KEY, AGENT_MODEL: "anthropic/claude-sonnet-4-5", AGENT_MODEL_FAST: "openai/gpt-5-mini" };
  const deps = { store, sealKey: SEAL_KEY, env };
  assert.deepEqual(await tierModelKeys(deps, ["fast"]), { OPENAI_API_KEY: SAVED_KEY });
  assert.deepEqual(await tierModelKeys(deps, []), {}, "no tier, nothing opened");
  const routeEnv = withModelKeys(env, await tierModelKeys(deps, ["fast"]));
  assert.equal(routeEnv.OPENAI_API_KEY, SAVED_KEY, "the tier's route reads it by name");
  assert.equal(Object.keys(routeEnv).includes("OPENAI_API_KEY"), false, "never enumerable: a spread or a spawn carries none");
  const tools = await claimSecrets(deps, await store.agents.revision("rev-1"), { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
  assert.equal(tools.OPENAI_API_KEY, undefined, "the run's tool environment holds the run's own model's key alone");
});
