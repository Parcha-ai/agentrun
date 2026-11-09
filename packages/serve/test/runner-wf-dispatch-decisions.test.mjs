// A workflow's decision node through the runner's real dispatch (harness-loops.ts resolveRunnerLoop, as main.ts runs it):
// the workflow spec is handed the runner's seal key, so the run's decision providers are built from the run's own keys
// sealed in the store (claim-secrets.ts over Settings → keys), and a judge on Parallel decides and records its receipt.
// Without the seal key no provider is built and every judge, pick or sift node fails before it is asked.
//
// Through the real loop: startRunner over createDispatchLoop over resolveRunnerLoop, on a real store with Parallel's key
// sealed as Settings saves it; Parallel is the faux module under the faux switch (it counts only its canary key as
// authorized, and files one line per call).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY } from "./fixtures/faux-parallel.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { FAUX_PARALLEL_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_ROUTE = new URL("./fixtures/faux-route.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 9);
const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

/** One judge on Parallel: is `doc` a certificate of incorporation? */
const judgeFlow = {
  v: 2, name: "asked",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "judge", label: "ask", provider: "parallel", state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
};

/** run-1, a judge-only workflow, through the runner's real dispatch: Parallel's key `sealed` in the store (Settings →
 *  keys), and/or in the runner's own environment (`envKey`, as the launcher hands it). Its row once it ends, and the
 *  questions Parallel was sent. */
async function judgeThroughDispatch(t, { sealed, envKey }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-dispatch-"));
  const calls = join(dir, "parallel-calls.jsonl");
  const before = process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS;
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS = calls;
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    if (before === undefined) delete process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS;
    else process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS = before;
    rmSync(dir, { recursive: true, force: true });
  });
  // The run's Parallel key as Settings → keys saves it: sealed in the store.
  if (sealed) await putSealedKey(server, SEAL_KEY, "PARALLEL_API_KEY", sealed);
  await server.agents.create({ id: "agent-1", name: "Judge" }, { id: "rev-1", kind: "workflow", body: { workflow: judgeFlow } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { doc: "Certificate of incorporation of Acme, Inc." }, title: "t", place: { mode: "runner" } } });
  const env = { [FAUX_ENV]: FAUX_ROUTE, [FAUX_PARALLEL_ENV]: FAUX_PARALLEL, ...(envKey ? { PARALLEL_API_KEY: envKey } : {}) };
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
  const sent = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
  return { row, sent };
}

test("a judge-only workflow through the runner's real dispatch decides on the run's own Parallel key, sealed in Settings", { timeout: 60_000 }, async (t) => {
  const { row, sent } = await judgeThroughDispatch(t, { sealed: CANARY });
  assert.equal(row.state, "ended", `the judge decided: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(sent.length, 1, `one question sent to Parallel: ${sent.length}`);
});

test("a judge-only workflow through the runner's real dispatch decides on a Parallel key set in the runner's environment (none sealed)", { timeout: 60_000 }, async (t) => {
  const { row, sent } = await judgeThroughDispatch(t, { envKey: CANARY });
  assert.equal(row.state, "ended", `the judge decided: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(sent.length, 1, `one question sent to Parallel: ${sent.length}`);
});

test("the environment's key wins over the one sealed in Settings by the same name (rule 4)", { timeout: 60_000 }, async (t) => {
  // The sealed value is not the canary, so only the environment's is authorized: the judge decides only if it is used.
  const { row, sent } = await judgeThroughDispatch(t, { sealed: `not-a-secret-${"stale-parallel"}`, envKey: CANARY });
  assert.equal(row.state, "ended", `decided on the environment's key: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(sent.length, 1);
});
