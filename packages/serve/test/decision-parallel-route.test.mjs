// Parallel Decisions on one route of two: Parallel's own API on PARALLEL_API_KEY, else OpenRouter's
// parallel/decisions-fast on the OpenRouter key. A node naming `provider: "parallel"` is the same provider either way: the
// same answers, the same evidence shape (its web citations), its cost booked. Here OpenRouter is the faux System One
// (@parcha/agentrun-decisions/testing/faux-system-one), and Parallel the tests' fake: no network, no real key.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { durableDecisions } from "../dist/workflow/readers.js";
import { decisionKeysFor, decisionsOf, providerMissing } from "../dist/decisions.js";
import { flowAgent, serve, withEnv } from "./support.mjs";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS"];

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
