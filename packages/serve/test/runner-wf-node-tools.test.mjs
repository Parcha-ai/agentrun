// A workflow's model node takes the tools it names on the runner, as main's per-run process binds them (app.ts:301-306):
// each through the run's gate (RunGate's extension, which parks no workflow call: tool-gate.ts), so a tool set to deny is
// refused in deniedText's words and one set to ask in the model-node words (a model node cannot wait for a person),
// neither run nor booked; one allowed is offered, called once and booked once on the run's one ledger, on the run's own
// keys (its claim's secrets and its tool plane). Main's NODE_TOOLS beyond the web tools (read, write, edit, browser) need
// the run's Workspace and computer, which the workflow loop does not claim yet: a node naming one is refused at the claim
// in words that name it, never offered or dropped silently.
//
// Through the real loop (startRunner over createWorkflowLoop and workflowSpecOf) on a real store; the shared scripted
// origin calls a tool only when the request offers it (conformance-pi-adapter.mjs), and Parallel's search is the faux
// module under the faux switch.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const spec = await import("../dist/runner/workflow-spec.js");
const { deniedText, modelNodeAskText } = await import("../dist/refusal-words.js");
const { parallelSearchFee } = await import("../dist/paid-calls.js");
const { FAUX_PARALLEL_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { paidRequestsOf } = await import("./fixtures/paid-requests.mjs");

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel-search.mjs", import.meta.url).pathname;
// A steady lease: these cases are about the node's tools, never a claim lapsing mid-request (a lapsed request books at its
// hold, which would read as a wrong cost here); the lapse has its own pinned case (runner-call-claim-lapse).
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
/** The scripted origin reports 10 output tokens each request: $0.001 a request at $100 a million. */
const PER_REQUEST = (10 * 100) / 1e6;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** One agent node naming `tools`, that searches and then submits its answer. */
const searchingFlow = (tools) => ({
  v: 2, name: "searching",
  schemas: { In: { type: "object", additionalProperties: true }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "agent", label: "look", instructions: "Search, then answer.", tools, out: "Answer", as: "answer" },
});
const SCRIPT = [{ call: "web_search", args: { query: "agentrun", n: 3 } }, { call: "submit", args: { answer: 42 } }];

/** run-1, a workflow run of `workflow` (its revision with `toolSettings`), the model on the scripted origin and
 *  Parallel's search on the faux module; its row once it leaves running, with the store's files' text. */
async function runOn(t, { workflow, toolSettings, specDeps }) {
  globalThis.fauxParallelSearches = 0;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-node-tools-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow, ...(toolSettings ? { toolSettings } : {}) } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: 100, plane: { web_search: "parallel" } } });
  const requests = [];
  const fetch = scriptedOrigin(SCRIPT, requests);
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"m"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch,
  });
  const env = { [FAUX_ENV]: "1", [FAUX_PARALLEL_ENV]: FAUX_PARALLEL, PARALLEL_API_KEY: `not-a-secret-${"p"}` };
  runner = startRunner({ store, createLoop: createWorkflowLoop(spec.workflowSpecOf({ store, providerOf, env, ...specDeps })), name: "runner-a", ...TIMING });
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) {
      const text = ["store.sqlite", "store.sqlite-wal"].map((name) => join(dir, name)).filter(existsSync).map((file) => readFileSync(file).toString("utf8")).join("\n");
      return { row, requests, text, paidRequests: () => paidRequestsOf(store) };
    }
    if (Date.now() - from > 30_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const offered = (request) => (request?.tools ?? []).map((tool) => tool.name).sort();
/** The servers listening in this process: a claim's model proxies are each one, until the claim lets them go. */
const listening = () => process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length;

test("a model node's web_search, allowed: offered with submit, called once, booked once on the run's ledger at Parallel's fee", async (t) => {
  const { row, requests, paidRequests } = await runOn(t, { workflow: searchingFlow(["web_search"]) });
  assert.deepEqual(offered(requests[0]), ["submit", "web_search"], "the node's request offers its tool and submit");
  // Offered exactly once in every request (its binding's extension and its booked, gated wrapper are one tool, never two).
  for (const [index, request] of requests.entries()) {
    assert.equal(offered(request).filter((name) => name === "web_search").length, 1, `request ${index} offers web_search once: ${JSON.stringify(offered(request))}`);
  }
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(globalThis.fauxParallelSearches, 1, "one search sent");
  assert.equal(eight(row.costUsd), eight(2 * PER_REQUEST + parallelSearchFee(3).usd), `two model requests and the search, once each: ${row.costUsd}`);
  // Its request's record names who charges for it (main's charge row: charged_by parallel), beside the call it booked under.
  const paid = await paidRequests();
  assert.ok(paid.length > 0, "the search's paid request is in the run's records");
  for (const request of paid) assert.equal(request.charged_by, "parallel", `charged by Parallel: ${JSON.stringify(request)}`);
});

test("a model node's web_search set to deny: refused in deniedText's words, never run, nothing of it booked", async (t) => {
  const { row, text } = await runOn(t, { workflow: searchingFlow(["web_search"]), toolSettings: { web_search: { permission: "deny" } } });
  assert.equal(row.state, "ended", `the node reads the refusal and submits: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.ok(text.includes(deniedText("web_search", undefined, "agent")), "the call's answer is the gate's deny, in main's words");
  assert.equal(globalThis.fauxParallelSearches, 0, "never run");
  assert.equal(eight(row.costUsd), eight(2 * PER_REQUEST), `only the model's requests booked: ${row.costUsd}`);
});

test("a model node's web_search set to ask: refused in the model-node words (it cannot wait for a person), never run, nothing booked", async (t) => {
  const { row, text } = await runOn(t, { workflow: searchingFlow(["web_search"]), toolSettings: { web_search: { permission: "ask" } } });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.ok(text.includes(modelNodeAskText("web_search")), "the call's answer is main's model-node ask refusal");
  assert.equal(globalThis.fauxParallelSearches, 0, "never run");
  assert.equal(eight(row.costUsd), eight(2 * PER_REQUEST));
});

test("a model node naming a tool the runner does not bind for model nodes yet (read) is refused at the claim, in words naming it", async (t) => {
  const words = typeof spec.nodeToolUnboundText === "function" ? spec.nodeToolUnboundText("read") : assert.fail("workflow-spec.ts nodeToolUnboundText is not there");
  const before = listening();
  const { row, requests, text } = await runOn(t, { workflow: searchingFlow(["read"]) });
  assert.equal(row.state, "failed", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.ok(`${row.summary ?? ""}\n${text}`.includes(words), `refused in words naming read: ${row.summary}`);
  assert.equal(requests.length, 0, "no model request sent");
  assert.equal(listening(), before, "the refused claim leaves no model proxy listening");
});

test("a claim that fails after its model proxies started lets them go: the run fails in the failure's words, no proxy left listening", async (t) => {
  const words = "the decision providers could not be built here";
  const before = listening();
  const { row, requests } = await runOn(t, { workflow: searchingFlow(["web_search"]), specDeps: { decisionProvidersOf: async () => { throw new Error(words); } } });
  assert.equal(row.state, "failed", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.ok(`${row.summary ?? ""}`.includes(words), `failed in the failure's words: ${row.summary}`);
  assert.equal(requests.length, 0, "no model request sent");
  assert.equal(listening(), before, "the failed claim closed the proxies it started");
});
