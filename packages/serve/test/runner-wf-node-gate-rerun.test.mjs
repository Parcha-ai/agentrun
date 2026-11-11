// A workflow model node's tool call that the gate let through, cut with its claim (the runner went, the lease lapsed) and
// run again by pi-durable's recovery on the next claim, now with its tool set to deny: the model must read that whether the
// call took effect is not known (RAN_UNKNOWN), never that nothing was sent and nothing was charged (NOT_RUN), which would
// be false of a call that may have reached its host. The gate keeps that it let a call through in the call's own task
// (its memo, committed with the task), so the rerun on the next claim reads it. A call it never let through is refused in
// the plain words. (Ported from tool-gate-replayed-relaunch.test.mjs, which drove a per-run process's death and relaunch;
// the gate's rule is the same on the runner.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";

const { gatedNodeCall, workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { FAUX_PARALLEL_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_SETTINGS_KEY } = await import("../dist/tool-plane.js");
const { NOT_RUN, RAN_UNKNOWN } = await import("../dist/refusal-words.js");

/** A task's api as pi-durable gives a tool call: its memos kept across attempts of the same task (a rerun on the next
 *  claim reads what the first attempt wrote), and nothing else this gate reads. */
function taskApi() {
  const memos = new Map();
  return {
    callId: "call_1",
    memo: async (name, ...rest) => {
      if (rest.length < 2) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  };
}
const textOf = (result) => JSON.stringify(result);

test("a model node's call let through, then run again after its claim was cut with the tool now denied, reads RAN_UNKNOWN, never NOT_RUN", async () => {
  let permission = "allow";
  const policy = async () => ({ permission, denyFrom: "server" });
  let ran = 0;
  const call = gatedNodeCall("web_fetch", policy, async () => ((ran += 1), { output: "the page" }));
  const api = taskApi();
  // The first attempt: let through and sent (its answer then lost with the claim).
  assert.deepEqual(await call({ url: "https://example.com" }, api, {}), { output: "the page" });
  // The next claim: the same task run again by recovery, its tool now set to deny.
  permission = "deny";
  const rerun = textOf(await call({ url: "https://example.com" }, api, {}));
  assert.ok(rerun.includes(RAN_UNKNOWN), `the rerun says whether it took effect is not known: ${rerun}`);
  assert.ok(!rerun.includes(NOT_RUN), "never that nothing was sent and nothing was charged");
  assert.equal(ran, 1, "the denied rerun runs nothing");
});

test("a model node's call let through, then run again after a cut claim with the tool now set to ask, reads RAN_UNKNOWN, never that it was not run", async () => {
  let permission = "allow";
  const policy = async () => ({ permission, denyFrom: "server" });
  const call = gatedNodeCall("web_fetch", policy, async () => ({ output: "the page" }));
  const api = taskApi();
  await call({ url: "https://example.com" }, api, {});
  permission = "ask";
  const rerun = textOf(await call({ url: "https://example.com" }, api, {}));
  assert.ok(rerun.includes(RAN_UNKNOWN), rerun);
  assert.ok(!rerun.includes("it was not run."), "never that it was not run");
  // A call never let through, set to ask, is refused as never run.
  const fresh = textOf(await call({ url: "https://example.com" }, taskApi(), {}));
  assert.ok(fresh.includes("it was not run.") && !fresh.includes(RAN_UNKNOWN), fresh);
});

test("a model node's call the gate never let through, denied, reads NOT_RUN: nothing was sent", async () => {
  const policy = async () => ({ permission: "deny", denyFrom: "server" });
  const call = gatedNodeCall("web_fetch", policy, async () => assert.fail("a denied call never runs"));
  const refused = textOf(await call({ url: "https://example.com" }, taskApi(), {}));
  assert.ok(refused.includes(NOT_RUN), refused);
});

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel-search.mjs", import.meta.url).pathname;
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
const LEASE_MS = 60_000;
/** Runner A never renews within the test (its first renewal is 55 s of real time away); the test moves the store's clock
 *  past its lease. */
const NEVER_RENEWS = { leaseMs: LEASE_MS, renewEveryMs: 55_000, stopMarginMs: 1_000, pollMs: 20, commandPollMs: 30 };
const STEADY = { leaseMs: LEASE_MS, renewEveryMs: 1_000, stopMarginMs: 1_000, pollMs: 20, commandPollMs: 30 };
/** One agent node that searches, then submits its answer. */
const searching = {
  v: 2, name: "searching",
  schemas: { In: { type: "object", additionalProperties: true }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "agent", label: "look", instructions: "Search, then answer.", tools: ["web_search"], out: "Answer", as: "answer" },
};
const SCRIPT = [{ call: "web_search", args: { query: "agentrun", n: 3 } }, { call: "submit", args: { answer: 42 } }];

test("on the runner: a model node's web_search let through on one claim, its claim lapsed while the search was out, run again by the next claim with web_search now denied, reads RAN_UNKNOWN", { timeout: 60_000 }, async (t) => {
  const clock = { now: T0 };
  const { store: server, file } = await storeOn(t, { clock });
  const { store: storeA } = await storeOn(t, { clock, file, role: "runner" });
  const { store: storeB } = await storeOn(t, { clock, file, role: "runner" });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: searching } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: 100, plane: { web_search: "parallel" } } });
  const requests = [];
  const fetch = scriptedOrigin(SCRIPT, requests);
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"m"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch,
  });
  const env = { [FAUX_ENV]: "1", [FAUX_PARALLEL_ENV]: FAUX_PARALLEL, PARALLEL_API_KEY: `not-a-secret-${"p"}` };
  // The first attempt's search: let through by the gate and sent, then held at Parallel while the claim lapses.
  globalThis.fauxParallelSearches = 0;
  let release;
  globalThis.fauxParallelHold = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (globalThis.fauxParallelArrived = resolve));
  const runners = [];
  // The runners stop before the stores close (registered after them, so they run first only if the hooks run last-in
  // first-out; here each is stopped explicitly before the test returns).
  const stopAll = async () => {
    release();
    for (const runner of runners) await runner.close().catch(() => {});
    delete globalThis.fauxParallelHold;
    delete globalThis.fauxParallelArrived;
  };
  t.after(stopAll);
  runners.push(startRunner({ store: storeA, createLoop: createWorkflowLoop(workflowSpecOf({ store: storeA, providerOf, env })), name: "runner-a", ...NEVER_RENEWS }));
  await reached;
  // While the search is out: web_search is set to deny on this server, and runner A's claim lapses.
  await server.settings.put(TOOL_SETTINGS_KEY, { web_search: { permission: "deny" } });
  globalThis.fauxParallelHold = undefined;
  clock.now += LEASE_MS + 1_000;
  runners.push(startRunner({ store: storeB, createLoop: createWorkflowLoop(workflowSpecOf({ store: storeB, providerOf, env })), name: "runner-b", ...STEADY }));
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 30_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, runner: row.runner, epoch: row.epoch })}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await stopAll();
  // What the model read of its search after the next claim ran it again: the gate's refusal, in the unknown words.
  const told = requests.map((body) => JSON.stringify(body.messages ?? [])).join("\n");
  assert.ok(told.includes(RAN_UNKNOWN), `the model is told whether the search took effect is not known: ${told.slice(-1200)}`);
  assert.ok(!told.includes(NOT_RUN), "never that nothing was sent and nothing was charged");
  assert.equal(globalThis.fauxParallelSearches, 1, "the denied rerun sent no second search");
});
