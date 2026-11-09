// A pi run's learned_workflow booking through the runner's adapter loop (the one-ledger ruling, now for pi too, once pi's
// session exposes a model port): a pi run calls learned_workflow, its model node runs on the session's model proxy under
// the learned_workflow side key, and the runner's booking records that request a side call labelled learned_workflow,
// priced by the session as the run's own. A run whose pin names no learned workflow books nothing under that label. pi's
// model goes through the session proxy to a loopback gateway; no sleeps, no port races.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { LEARNING_PIN, LEARNED_WORKFLOWS_FILE } = await import("../dist/learning.js");
const { runFolder } = await import("../dist/workspace/paths.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

/** One model node (`extract`) workflow: learned_workflow runs it, its node a request on the session's model. */
const answerFlow = {
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};

/** The gateway's answer: the run calls learned_workflow (its request offers it, with no result yet), and the workflow's
 *  model node submits its answer (its request offers the node's submit tool). A request that offers neither, or already
 *  carries a tool result, just answers — the run ends. */
const driveLearned = ({ body }) => {
  const toolNames = (body?.tools ?? []).map((tool) => tool?.name);
  const hasResult = (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
  if (toolNames.includes("submit") && !hasResult) return { name: "submit", input: { value: { answer: 42 } } };
  if (toolNames.includes(LEARNED_WORKFLOW_TOOL) && !hasResult) return { name: LEARNED_WORKFLOW_TOOL, input: { name: "answer", input: { question: "What is six times seven" } } };
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

/** A pi run with `tools`, its pin naming the `answer` workflow when `learned`, through the runner's adapter loop on pi's
 *  spec. Its session's booked requests (runner.request) and turns. */
async function piRun(t, { tools, learned }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-pi-booking-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: driveLearned });
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
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools } });
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  if (learned) {
    const root = runFolder(dir, "agent-1", RUN);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, LEARNING_PIN), JSON.stringify({ seed: null, section: "", workflows: ["answer"] }));
    writeFileSync(join(root, LEARNED_WORKFLOWS_FILE), JSON.stringify([{ name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(answerFlow) }]));
  }
  // The run's one model route: pi's model and the node's both go through the session proxy to the loopback gateway, priced
  // at the route's catalog cost.
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
  const route = { model: "claude-sonnet-4-5", provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const all = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
  const requests = all.filter((record) => record.kind === "runner.request").map((record) => record.data);
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  return { row, requests, turns };
}

test("a pi run's learned_workflow model node books on the run's one ledger, a side call labelled learned_workflow", async (t) => {
  const { row, requests, turns } = await piRun(t, { tools: ["read", LEARNED_WORKFLOW_TOOL], learned: true });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  const node = requests.filter((request) => request.host === LEARNED_WORKFLOW_TOOL);
  assert.equal(node.length, 1, `the node's one request is the session's, labelled learned_workflow: ${JSON.stringify(requests)}`);
  assert.equal(node[0].side, true, `the node's request is a side call of the session: ${JSON.stringify(node[0])}`);
  const booked = turns.find((turn) => turn.turn === node[0].turn);
  assert.ok(booked && typeof booked.usd === "number" && booked.usd > 0, `the node's request is priced by the session, not $0: ${JSON.stringify(booked)}`);
  const own = requests.filter((request) => request.host === undefined);
  assert.ok(own.length >= 1 && !own.some((request) => request.turn === node[0].turn), `the run's own requests carry no learned_workflow label: ${JSON.stringify(own)}`);
});

test("a pi run whose pin names no learned workflow books nothing under the learned_workflow label", async (t) => {
  const { row, requests } = await piRun(t, { tools: ["read"], learned: false });
  assert.notEqual(row.state, "failed", `the run did not fail: ${JSON.stringify(row)}`);
  assert.deepEqual(requests.filter((request) => request.host === LEARNED_WORKFLOW_TOOL), [], "no learned workflow, nothing booked under its label");
});
