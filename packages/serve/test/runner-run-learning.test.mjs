// A run that asked to learn with settings of its own (RunCreate `learning: {settings}`, kept in its launch as
// `learning.settings`), through the runner, on an agent whose definition has no learning: its learning work reads the
// run's settings, never its revision's, and spends only the run's own key inside the run's own cap. Proven here:
//   - its learned workflow's check replays on the run's compile_after inputs (3, where the revision's default reads 20),
//     each replay capped at its share of what the run's cap leaves (keyedCapOf), so the run and its replays book at most
//     its max_cost_usd together;
//   - replays that don't fit drop as no_budget with nothing spent, and the run says why in words: its learning_work's
//     `dropped` and a learning row of its timeline;
//   - its promoted workflow's audit draws at the run's audit_every (1), where the revision's default (10) would not draw
//     it, and the shadow takes only what the cap leaves: the run and its shadow book at most max_cost_usd together.
// The run's start (the 400 learning_needs_cap, the API's settings) is learn-run-learning.test.mjs's.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, putPromotions, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { seedOf } = await import("../dist/learning.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { sealRunLaunch } = await import("../dist/store/seal.js");
const { auditDrawn } = await import("../dist/learn/audit.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { servedTimelineRows } = await import("../dist/run-timeline-served.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const RUN_KEY = `not-a-secret-${"run-learning"}-3b9d40`;
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = JSON.stringify({ answer: 42, sure: true });
const FINAL = ["ended", "failed", "stopped"];

const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};
const FLOWS = [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }];
const DIGEST = workflowDigest({ workflow: JSON.stringify(answerFlow) });

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const keyOf = (request) => request.headers["x-api-key"] ?? request.headers.authorization?.replace(/^Bearer /, "");
const micro = (usd) => Math.round(usd * 1e6);

const until = async (done, what, ms = 90_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** An agent whose definition has no learning, with `prior` earlier runs of its own and `answer` landed in its learning
 *  (`promoted`: as its check promoted it, so it serves first); a runner on a gateway that holds no key of its own, its
 *  route reading the key the claim's model env holds. */
async function world(t, { prior = 0, promoted = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-run-learning-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : AGENT_SAYS),
    usage: { input: 2_000, output: 200 },
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Asked" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [], learning: false } });
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const routeOf = async (_model, env) => ({ model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => env.AGENT_MODEL_API_KEY ?? "not-a-secret-pi" }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch });
  const logs = [];
  const deps = { env: { AGENT_MODEL_BASE_URL: gw.url }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = (question, extra = {}) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, ...extra });
  for (let i = 0; i < prior; i++) {
    await server.runs.create({ id: `prior-${i}`, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(`Question ${i}`) });
    await ended(`prior-${i}`);
  }
  const seed = await landWorkflows(dir, "agent-1", FLOWS);
  if (promoted) await putPromotions(server, "agent-1", [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: seed }]);
  /** Run `id` on `question` as the server's start makes one that asked to learn with `settings`: handed RUN_KEY, capped at
   *  `capUsd`, its learning start at the agent's newest save with the run's settings on it. */
  const asked = async (id, question, capUsd, settings) => server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, {
    body: launchOf(question, { learning: { ...startAt((await seedOf(dir, server, "agent-1")).sha), settings }, max_cost_usd: capUsd }),
    sealed: sealRunLaunch(SEAL_KEY, id, { model: { key: RUN_KEY, origin: new URL(gw.url).origin } }),
  });
  const children = async (field) => {
    const out = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) if (readLaunchBody((await server.runs.launch(row.id)).body)?.[field]) out.push(row);
    return out;
  };
  const view = async (id) => viewOverStore(server, id, { origin: "", serverSecrets: () => [], sealKey: SEAL_KEY });
  const settled = (id) => until(async () => {
    const one = (await view(id)).learning_work;
    return one.state !== "running" && one;
  }, `run ${id}'s learning work settles`);
  return { dir, server, gw, logs, ended, asked, children, view, settled };
}

test("a run that asked to learn with compile_after 3, on a revision with no learning, has its new workflow checked on 3 inputs at its end, each replay capped at its share of what the run's cap leaves: the run and its replays book at most its max_cost_usd", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { prior: 6 });
  const CAP = 1;
  await w.asked("run-1", "What is six times seven", CAP, { compile_after: 3 });
  const parent = await w.ended("run-1");
  assert.equal(parent.state, "ended", JSON.stringify(parent));
  // The check reserves its replay runs (its record's `runs`, one per input) before it makes any.
  const record = await until(async () => (await promotionsOf(w.server.learning, "agent-1")).findLast((one) => one.digest === DIGEST && one.runs?.length), "the check's reservation");
  assert.equal(record.runs.length, 3, `checked on the run's compile_after (3) inputs, never the revision's default: ${JSON.stringify(record.runs)}`);
  const ids = await until(async () => {
    const rows = await w.children("replay");
    return rows.length === 3 && (await Promise.all(rows.map((row) => w.server.runs.get(row.id)))).every((row) => FINAL.includes(row.state)) && rows.map((row) => row.id);
  }, "the 3 replay runs ended");
  const room = CAP - parent.costUsd;
  for (const id of ids) {
    const cap = readLaunchBody((await w.server.runs.launch(id)).body).maxCostUsd;
    assert.ok(typeof cap === "number" && cap > 0 && micro(cap) <= micro(room / 3) + 1, `each replay capped at its share of what the run's cap left (${room}/3): ${cap}`);
  }
  const booked = [parent, ...(await Promise.all(ids.map((id) => w.server.runs.get(id))))].map((row) => row.costUsd);
  assert.ok(booked.every((usd) => typeof usd === "number"), JSON.stringify(booked));
  assert.ok(booked.reduce((sum, usd) => sum + micro(usd), 0) <= micro(CAP), `the run and its replays book at most its cap: ${booked}`);
  assert.deepEqual([...new Set(w.gw.requests.filter((request) => request.method === "POST").map(keyOf))].filter((key) => key !== "not-a-secret-pi"), [RUN_KEY], "the run's learning work spent the run's own key alone");
});

test("a run that asked to learn whose cap leaves too little for its check drops it (no_budget, nothing spent) and says why in words: its learning_work's dropped, and a learning row of its timeline", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { prior: 6 });
  await w.asked("tight-1", "What is six times seven", 0.03, { compile_after: 3 });
  await w.ended("tight-1");
  const work = await w.settled("tight-1");
  assert.equal(work.state, "ended", JSON.stringify(work));
  assert.deepEqual(await w.children("replay"), [], "no replay run made");
  assert.equal(work.dropped?.length, 1, `the drop is on the run's learning_work: ${JSON.stringify(work)}`);
  const [dropped] = work.dropped;
  assert.deepEqual([dropped.kind, dropped.reason], ["replay", "no_budget"], JSON.stringify(dropped));
  assert.match(dropped.detail, /cap/i, `in words: ${dropped.detail}`);
  const rows = await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, w.server, "tight-1", BACKGROUND_CONTEXT);
  const row = rows.find((one) => one.kind === "learning" && one.learning?.reason === "no_budget");
  assert.ok(row, `a learning row says the check dropped: ${JSON.stringify(rows.filter((one) => one.kind === "learning"))}`);
  assert.equal(row.summary, dropped.detail, "its timeline row says what its learning_work says");
});

test("a run that asked to learn with audit_every 1, on a revision with no learning, has its served answer audited where the revision's default (1 in 10) would not draw it; its shadow takes only what its cap leaves: the run and its shadow book at most its max_cost_usd", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { promoted: true });
  // A run id the default (audit_every 10) does not draw, so only the run's own audit_every 1 audits it.
  const id = Array.from({ length: 200 }, (_, i) => `served-${i}`).find((one) => !auditDrawn(one, 10));
  const CAP = 1;
  await w.asked(id, "What is six times seven", CAP, { audit_every: 1 });
  const served = await w.ended(id);
  assert.deepEqual([served.state, served.metrics?.path], ["ended", "workflow"], JSON.stringify(served.metrics));
  const [shadow] = await until(async () => {
    const rows = await w.children("audit");
    return rows.length === 1 && rows;
  }, "the served run's shadow (audit_every 1)");
  const cap = readLaunchBody((await w.server.runs.launch(shadow.id)).body).maxCostUsd;
  assert.ok(typeof cap === "number" && micro(cap) <= micro(CAP - served.costUsd), `the shadow capped at what the run's cap left: ${cap}`);
  const done = await w.ended(shadow.id);
  assert.ok(micro(served.costUsd) + micro(done.costUsd ?? 0) <= micro(CAP), `the run and its shadow book at most its cap: ${served.costUsd} + ${done.costUsd}`);
});
