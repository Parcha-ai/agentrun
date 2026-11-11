// A workflow's judges on their vendors' keys through the runner's real dispatch (harness-loops.ts resolveRunnerLoop, as
// main.ts runs it), the keys sealed in the store as Settings → keys saves them (claim-secrets.ts) and in no environment:
//   - a Jev judge answers on the TypeSafe key, and a Parallel judge on Parallel's, in one workflow;
//   - with OPENROUTER_API_KEY the only decision key, the Jev judge answers on it through OpenRouter.
// The vendors are the tests' fakes under the faux switches (fixtures/faux-jev.mjs, faux-parallel.mjs): each counts only its
// canary key as authorized and files one line per call. The run's process (this one, the runner is in it) holds neither key:
// they come from the store at the claim, never an environment. runner-wf-dispatch-decisions covers Parallel alone, and the
// environment-wins rule.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY as JEV_CANARY } from "./fixtures/faux-jev.mjs";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { FAUX_JEV_ENV, FAUX_PARALLEL_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_ROUTE = new URL("./fixtures/faux-route.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 9);
const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const KEY_NAMES = ["TYPESAFE_API_KEY", "PARALLEL_API_KEY", "OPENROUTER_API_KEY"];

const schemas = {
  In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
  Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
};
/** A workflow of judges, one for each of `providers` (undefined: Jev, the default). */
const flowOf = (providers) => ({
  v: 2, name: "asked", schemas, input: { schemaId: "In" }, output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "chain", steps: providers.map((provider, i) => ({ node: "judge", label: `ask-${i}`, ...(provider ? { provider } : {}), state: { doc: "{doc}" }, out: "Verdict", as: i === providers.length - 1 ? "verdict" : `v${i}` })) },
});

/** run-1, a workflow of judges, through the runner's real dispatch with `sealed` (name → value) sealed in the store and none
 *  in the environment. Its row once it ends, and the lines each vendor filed. */
async function judgesThroughDispatch(t, { providers, sealed }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-judge-keys-"));
  const jevCalls = join(dir, "jev-calls.jsonl");
  const parallelCalls = join(dir, "parallel-calls.jsonl");
  const saved = Object.fromEntries(["AGENTRUN_TEST_FAUX_JEV_CALLS", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS", ...KEY_NAMES].map((name) => [name, process.env[name]]));
  process.env.AGENTRUN_TEST_FAUX_JEV_CALLS = jevCalls;
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS = parallelCalls;
  // The decision keys are in no environment of this process (a developer's own would otherwise win over the store's).
  for (const name of KEY_NAMES) delete process.env[name];
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(sealed)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Judge" }, { id: "rev-1", kind: "workflow", body: { workflow: flowOf(providers) } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { doc: "Certificate of incorporation of Acme, Inc." }, title: "t", place: { mode: "runner" } } });
  const env = { [FAUX_ENV]: FAUX_ROUTE, [FAUX_JEV_ENV]: FAUX_JEV, [FAUX_PARALLEL_ENV]: FAUX_PARALLEL };
  const deps = {
    env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY,
    routeOf: async () => assert.fail("a judge-only workflow resolves no pi route"),
    computerForClaim: async () => ({ release: async () => {} }),
  };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps) }) });
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 45_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { row, jev: lines(jevCalls), parallel: lines(parallelCalls), env };
}

test("a workflow's Jev judge decides on the TypeSafe key and its Parallel judge on Parallel's, both sealed in Settings and in no environment", { timeout: 60_000 }, async (t) => {
  const { row, jev, parallel, env } = await judgesThroughDispatch(t, { providers: ["parallel", undefined], sealed: { TYPESAFE_API_KEY: JEV_CANARY, PARALLEL_API_KEY: PARALLEL_CANARY } });
  assert.equal(row.state, "ended", `both judges decided: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.deepEqual(jev.map((call) => call.authorized), [true], "Jev answered on the TypeSafe key the store holds");
  assert.deepEqual(parallel.map((call) => call.authorized), [true], "and Parallel on its own");
  for (const key of [JEV_CANARY, PARALLEL_CANARY]) {
    assert.ok(!JSON.stringify(process.env).includes(key), "neither key is in the runner's environment");
    assert.ok(!JSON.stringify(env).includes(key), "nor in the environment the run was given");
  }
});

test("with OPENROUTER_API_KEY its only decision key, sealed in Settings, a workflow's Jev judge answers on that key through OpenRouter", { timeout: 60_000 }, async (t) => {
  const { row, jev } = await judgesThroughDispatch(t, { providers: [undefined], sealed: { OPENROUTER_API_KEY: JEV_CANARY } });
  assert.equal(row.state, "ended", `the judge decided: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.deepEqual(jev.map((call) => [call.path, call.authorized]), [["/api/v1/systemone", true]], "one System One request to OpenRouter, on the key the store holds");
});

test("with no decision key sealed, no judge is asked: the keys above are what make a workflow decide", { timeout: 60_000 }, async (t) => {
  const { row, jev, parallel } = await judgesThroughDispatch(t, { providers: ["parallel", undefined], sealed: {} });
  assert.notEqual(row.state, "ended", "a workflow of judges with no key does not decide");
  assert.deepEqual([jev.length, parallel.length], [0, 0], "and nothing is sent to either vendor");
});
