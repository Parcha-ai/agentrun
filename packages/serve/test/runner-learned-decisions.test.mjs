// LS-07 end to end on the runner: a pi run of an agent that learned a workflow with a judge node. The claim hands the
// run Jev's key because its chosen learned workflow names Jev and its gate does not deny it (claim-secrets.ts
// learnedDecisionKeys, #2338). learned_workflow asks the judge of the faux Jev through the run's decision providers, and
// books it on the run's one cap (DECISION_SESSION): admitted before it is sent, settled at what Jev reported. The run's
// cost counts it. With `jev` denied on the agent, the claim hands no key, the call is refused in the gate's words, and
// nothing reaches Jev. The host holds a fake Jev key; the faux Jev answers every question and files each call it gets.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { withEnv } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { spentOverStore } = await import("../dist/store-reads/cap.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
/** What the faux Jev reports each call cost. */
const JEV_USD = 0.00002;

/** A learned workflow of one judge node, asked of the run's default provider (Jev): is the claim right? */
const checkFlow = {
  v: 2, name: "check",
  schemas: {
    In: { type: "object", required: ["claim"], properties: { claim: { type: "string" } } },
    Check: { type: "object", required: ["right"], properties: { right: { type: "boolean", description: "Is the claim right?" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Check", path: "check" },
  root: { node: "chain", steps: [{ node: "judge", label: "check", state: { claim: "{claim}" }, out: "Check", as: "check" }] },
};

/** The gateway's answer: the run calls learned_workflow once (its request offers it, with no result yet), then ends. */
const driveLearned = ({ body }) => {
  const toolNames = (body?.tools ?? []).map((tool) => tool?.name);
  const hasResult = (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
  if (toolNames.includes(LEARNED_WORKFLOW_TOOL) && !hasResult) return { name: LEARNED_WORKFLOW_TOOL, input: { name: "check", input: { claim: "Six times seven is 42." } } };
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

/** A pi run of an agent that learned `check`, through the runner's adapter loop on pi's spec, the host holding a fake
 *  Jev key (`toolSettings`: the agent's own). Its row, each session's records by key, its timeline and the calls the
 *  faux Jev got. */
async function learnedJudgeRun(t, { toolSettings, noUsage = false, capUsd } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learned-decisions-"));
  const jevCalls = join(dir, "jev.jsonl");
  // `noUsage`: Jev's answer counts no tokens and reports no cost, so the decision's cost is unknown.
  withEnv(t, { AGENTRUN_TEST_FAUX_JEV_CALLS: jevCalls, AGENTRUN_TEST_FAUX_JEV_COST: String(JEV_USD), ...(noUsage ? { AGENTRUN_TEST_FAUX_JEV_NO_USAGE: "1" } : {}) }, noUsage ? [] : ["AGENTRUN_TEST_FAUX_JEV_NO_USAGE"]);
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
  await server.agents.create({ id: "agent-1", name: "Checks" }, { id: "rev-1", kind: "agentic", body: { instructions: "Check the claim.", tools: ["read"], learning: true, ...(toolSettings ? { toolSettings } : {}) } });
  const seed = await landWorkflows(dir, "agent-1", [{ name: "check", description: "Checks whether a claim is right", workflow: checkFlow }]);
  const launch = { input: { content: "Check the claim." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, learning: startAt(seed), ...(capUsd !== undefined ? { maxCostUsd: capUsd } : {}) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
  const route = { model: "claude-sonnet-4-5", provider: { api: "anthropic-messages", origin: gw.url, credential: () => "not-a-secret-pi" }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  // The host's environment: Jev's (fake) key, as where the server starts, and the faux Jev it is sent to.
  const env = { TYPESAFE_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const records = {};
  for (const key of await sessions.keys()) records[key] = await sessions.read(key);
  const timeline = await runTimeline(server, RUN, ctx, { settled: true });
  const sent = existsSync(jevCalls) ? readFileSync(jevCalls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  // What the runs list shows for this run while it is still going or paused (store-reads/runs.ts: spentOverStore over its
  // journal, the end not written yet), read over the same journal.
  const listed = await spentOverStore(server, RUN, ctx);
  return { row, records, timeline, sent, listed };
}

const turnsUsd = (records) => (records ?? []).filter((record) => record.kind === "runner.turn").reduce((sum, record) => sum + (record.data.bookedUsd ?? record.data.usd ?? 0), 0);
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

test("a pi run's learned judge is answered by the faux Jev on the key its claim was handed: booked on the run's decisions, and in the run's cost", { timeout: 120_000 }, async (t) => {
  const { row, records, timeline, sent, listed } = await learnedJudgeRun(t);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const result = timeline.find((one) => one.kind === "tool_result" && one.tool_name === LEARNED_WORKFLOW_TOOL);
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  assert.match(JSON.stringify(result), /right/);
  assert.equal(sent.length, 1, `the judge reached the faux Jev once: ${JSON.stringify(sent)}`);
  assert.equal(sent[0].authorized, true, "on the key the claim handed");
  const decisions = records.decisions ?? [];
  assert.deepEqual(decisions.map((record) => record.kind), ["runner.request", "runner.turn"], `admitted before it was sent, then settled: ${JSON.stringify(decisions)}`);
  near(turnsUsd(decisions), JEV_USD, "booked at what Jev reported");
  const model = Object.entries(records).filter(([key]) => key !== "decisions").reduce((sum, [, list]) => sum + turnsUsd(list), 0);
  near(row.costUsd, model + JEV_USD, "the run's cost counts its decision beside its model requests");
  near(listed, model + JEV_USD, "the cost the runs list shows while it runs or is paused counts it too, from the same records");
});

test("with jev denied on the agent, its claim hands no Jev key, the learned judge is refused in the gate's words, and nothing reaches Jev", { timeout: 120_000 }, async (t) => {
  const { row, records, timeline, sent } = await learnedJudgeRun(t, { toolSettings: { jev: { permission: "deny" } } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  const result = timeline.find((one) => one.kind === "tool_result" && one.tool_name === LEARNED_WORKFLOW_TOOL);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /This workflow's decision node asks jev, which is set to deny for this agent\./, JSON.stringify(result));
  assert.deepEqual(sent, [], "nothing reached Jev");
  assert.deepEqual(records.decisions ?? [], [], "nothing booked on the run's decisions");
});

test("a capped pi run whose learned decision reports no cost saves its cost unknown: the cap's hold is never read as what the decision charged", { timeout: 120_000 }, async (t) => {
  const { row, records, sent, listed } = await learnedJudgeRun(t, { noUsage: true, capUsd: 1 });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(sent.length, 1, "the decision was sent and answered");
  assert.deepEqual((records.decisions ?? []).map((record) => record.kind), ["runner.request", "runner.turn"], JSON.stringify(records.decisions));
  assert.equal(row.costUsd, null, `an unknown charge leaves the run's cost unknown, never its hold: ${JSON.stringify(row)}`);
  assert.equal(listed, null, "and the cost listed while it runs or is paused is unknown too");
});
