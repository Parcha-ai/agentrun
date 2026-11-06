// Parallel Decisions on one route of two: Parallel's own API on PARALLEL_API_KEY, else OpenRouter's
// parallel/decisions-fast on the OpenRouter key. A node naming `provider: "parallel"` is the same provider either way: the
// same answers, the same evidence shape (its web citations), its cost booked. Here OpenRouter is the faux System One
// (@parcha/agentrun-decisions/testing/faux-system-one), and Parallel the tests' fake: no network, no real key.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { durableDecisions } from "@parcha/agentrun-pi/durable";
import { decisionKeysFor, decisionsOf, providerMissing } from "../dist/decisions.js";
import { flowAgent, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS"];
const ROUTER_KEY = "openrouter-test-placeholder";

const flow = {
  v: 2, name: "asked",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "judge", label: "ask", provider: "parallel", state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
};

/** A faux OpenRouter that files each request's path, model and authorization, then answers as the faux System One. */
async function fauxRouter(t) {
  const dir = await scratch(t);
  const sent = join(dir, "sent.jsonl");
  const module = join(dir, "faux-openrouter.mjs");
  await writeFile(module, [
    `import { appendFileSync } from "node:fs";`,
    `import faux from ${JSON.stringify(new URL("../../decisions/dist/testing/faux-system-one.js", import.meta.url).href)};`,
    `export default async (url, init = {}) => {`,
    `  const body = init.body ? JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)) : {};`,
    `  appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ path: new URL(String(url)).pathname, model: body.model ?? null, auth: new Headers(init.headers).get("authorization") }) + "\\n");`,
    `  return faux(url, init);`,
    `};`,
  ].join("\n"));
  return { module, sent: async () => (await readFile(sent, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

async function runParallel(t, api) {
  const made = await api("POST", "/agents", flowAgent("asked", flow));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", "/agents/asked/runs", { input: { doc: "Certificate of incorporation of Example Widgets, Inc." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  return { runId: started.body.run_id, made };
}

test("parallel's route: Parallel's own key first, else OpenRouter's parallel/decisions-fast, else unavailable naming both", () => {
  const offer = (env) => decisionsOf(env).find((p) => p.id === "parallel");
  assert.deepEqual(offer({ PARALLEL_API_KEY: "p".repeat(20) }), { id: "parallel", available: true, route: "parallel" });
  const routed = offer({ OPENROUTER_API_KEY: "o".repeat(20) });
  assert.deepEqual([routed.available, routed.route], [true, "openrouter"]);
  assert.match(routed.note ?? "", /parallel\/decisions-fast/, routed.note);
  assert.match(routed.note ?? "", /PARALLEL_API_KEY/, "the note says how to use Parallel's API directly");
  assert.equal(offer({ PARALLEL_API_KEY: "p".repeat(20), OPENROUTER_API_KEY: "o".repeat(20) }).route, "parallel", "both keys: Parallel's own");
  const gateway = offer({ AGENT_MODEL_BASE_URL: "https://openrouter.ai/api/v1", AGENT_MODEL_API_KEY: "g".repeat(20) });
  assert.deepEqual([gateway.available, gateway.route], [true, "openrouter"], "an OpenRouter model gateway's key runs it too");
  const none = offer({});
  assert.equal(none.available, false);
  for (const name of ["PARALLEL_API_KEY", "OPENROUTER_API_KEY"]) assert.match(none.reason, new RegExp(name), none.reason);
  assert.equal(providerMissing({ OPENROUTER_API_KEY: "o".repeat(20) }, "parallel"), undefined);
  assert.deepEqual(providerMissing({}, "parallel").needs, ["PARALLEL_API_KEY", "OPENROUTER_API_KEY"]);
});

test("a parallel node on the OpenRouter route is handed the OpenRouter key, never Parallel's", () => {
  const needs = { providers: ["parallel"], parallelWeb: false };
  assert.deepEqual(Object.keys(decisionKeysFor({ OPENROUTER_API_KEY: "o".repeat(20) }, needs)), ["OPENROUTER_API_KEY"]);
  assert.deepEqual(Object.keys(decisionKeysFor({ PARALLEL_API_KEY: "p".repeat(20), OPENROUTER_API_KEY: "o".repeat(20) }, needs)), ["PARALLEL_API_KEY"], "Parallel's own key wins");
});

test("with only an OpenRouter key, a node naming parallel runs on parallel/decisions-fast: its citations are its evidence, in Parallel's shape, and its cost is booked", async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: ROUTER_KEY, AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS: "0" }, KEYS);
  const router = await fauxRouter(t);
  const { api, data } = await serve(t, { fauxOpenrouter: router.module, fauxParallel: FAUX_PARALLEL });
  const caps = (await api("GET", "/capabilities")).body.workflows.decisions.providers.find((p) => p.id === "parallel");
  assert.deepEqual([caps.available, caps.route], [true, "openrouter"]);
  const { runId, made } = await runParallel(t, api);
  assert.deepEqual(made.body.warnings, [], "it saves with no missing-key warning");
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(await router.sent(), [{ path: "/api/v1/systemone", model: "parallel/decisions-fast", auth: `Bearer ${ROUTER_KEY}` }], "one request, to OpenRouter, for Parallel's model, on the handed key");
  const [receipt] = durableDecisions(join(runDir(data, runId), "store", "run.sqlite"));
  assert.equal(receipt.provider, "parallel", "the receipt names the provider the node asked for");
  assert.deepEqual(receipt.evidence, [{ url: "https://registry.example.test/widgets", title: "Example Widgets, Inc.", excerpts: ["Incorporated in Delaware."], scope: "call" }], "the citations are the evidence, as Parallel's are");
  assert.equal(receipt.cost_basis, "reported");
  assert.ok(typeof receipt.cost_usd === "number" && receipt.cost_usd > 0, `OpenRouter's usage.cost is booked: ${receipt.cost_usd}`);
  assert.equal(run.cost.usd, receipt.cost_usd, "the run's cost is the decision's");
});

test("with Parallel's own key, a node naming parallel still goes to Parallel's API, with the same evidence shape", async (t) => {
  const calls = join(await scratch(t), "parallel-calls.jsonl");
  withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, OPENROUTER_API_KEY: ROUTER_KEY, AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS: "0", AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls }, KEYS);
  const router = await fauxRouter(t);
  const { api, data } = await serve(t, { fauxOpenrouter: router.module, fauxParallel: FAUX_PARALLEL });
  const { runId } = await runParallel(t, api);
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  assert.deepEqual(await router.sent(), [], "nothing went to OpenRouter");
  const parallelCalls = (await readFile(calls, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(parallelCalls.map((c) => [c.path, c.authorized]), [["/v1/decisions", true]]);
  const [receipt] = durableDecisions(join(runDir(data, runId), "store", "run.sqlite"));
  assert.deepEqual(Object.keys(receipt.evidence[0]).sort(), ["excerpts", "scope", "title", "url"]);
});

test("with neither key, a node naming parallel saves with a warning naming both, and its run is refused naming both", async (t) => {
  withEnv(t, { TYPESAFE_API_KEY: "t".repeat(20) }, KEYS);
  const { api } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  const made = await api("POST", "/agents", flowAgent("asked", flow));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const warning = made.body.warnings.find((w) => w.field === "definition.workflow");
  for (const name of ["PARALLEL_API_KEY", "OPENROUTER_API_KEY"]) assert.match(warning?.message ?? "", new RegExp(name), JSON.stringify(made.body.warnings));
  const refused = await api("POST", "/agents/asked/runs", { input: { doc: "x" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details.decisions, { parallel: { reason: "not_set_up_here", needs: ["PARALLEL_API_KEY", "OPENROUTER_API_KEY"] } });
});
