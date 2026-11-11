// LS-07, learning's half: a learned workflow may hold decision nodes (judge, pick, sift, a route by question, an ask
// predicate, a verify), under the run's cap. Each decision is admitted on the run's ONE cap (the adapter loop's
// ledger.decisions, DECISION_SESSION) before it is sent, priced as a workflow agent's decision is, and settled at what
// it charged; one the cap has no room for is never sent, and the run pauses on the cap's refusal (ledger.pause). A
// decision node's provider (the one it names, else the run's default) is held to the run's gate under its id, as a call
// node's tool is: one set to ask or deny is refused before any node runs, and so is one the run has no key for.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { scratch, withEnv } from "./support.mjs";

const { runLearned } = await import("../dist/learned-workflow.js");
const { draftProblems } = await import("../dist/learn/index.js");
const { decisionProvidersIn } = await import("../dist/decisions.js");
const { CapRefused } = await import("../../run-adapters/dist/kernel/cap/index.js");
const dsl = await import("@parcha/agentrun-dsl");

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;

/** A learned workflow of one judge node (asked of `provider`, else the run's default): is the claim right? */
const judgeFlow = (provider) => ({
  v: 2, name: "check",
  schemas: {
    In: { type: "object", required: ["claim"], properties: { claim: { type: "string" } } },
    Check: { type: "object", required: ["right"], properties: { right: { type: "boolean", description: "Is the claim right?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Check", path: "check" },
  root: { node: "chain", steps: [{ node: "judge", label: "check", state: { claim: "{claim}" }, out: "Check", as: "check", ...(provider ? { provider } : {}) }] },
});

/** The run's decision providers on the faux Jev (its calls filed in `calls`), as decisionProvidersIn builds a claim's. */
async function providers(t) {
  const calls = join(await scratch(t), "jev.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_JEV_CALLS: calls, AGENTRUN_TEST_FAUX_JEV_COST: "0.00002" });
  const registry = await decisionProvidersIn({ TYPESAFE_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV });
  assert.ok(registry?.providers.jev, "setup: the faux Jev");
  return { registry, sent: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0) };
}

/** The run's decisions as the adapter loop hands them (RunLedger.decisions), recording each admission and settle;
 *  `refuse`: the cap has no room, so every admission is refused for room (CapRefused, not for good). */
function booking(refuse = false) {
  const admitted = [];
  const settled = [];
  return {
    admitted, settled,
    async admit(request) {
      admitted.push(request);
      if (refuse) throw new CapRefused("The run's spend cap of $0.01 has no room for this decision.", { forGood: false, spentUsd: 0.01, figures: { spentUsd: 0.01, needsUsd: 0.001, leastCapUsd: 0.011 } });
      return { holdUsd: 0.001 };
    },
    async settle(id, how) { settled.push([id, how]); return how.usd ?? null; },
    spentUsd: () => settled.reduce((sum, [, how]) => sum + (how.usd ?? 0), 0),
    heldUsd: () => 0,
  };
}

/** A run of `flow` with `decisions`, its gate allowing everything but what `policy` says. */
const runOf = (flow, decisions, policy = () => "allow", denyFrom = () => "agent") => ({
  workflows: [flow], granted: [], env: {}, work: "/nonexistent",
  models: { getModel: () => undefined, getModels: () => [] }, modelOf: () => undefined,
  policy, denyFrom, ...(decisions ? { decisions } : {}),
});
const learned = (doc) => ({ name: doc.name, description: "Checks a claim", workflow: JSON.stringify(doc) });

test("a learned draft with a judge node passes the learn-time check when the run has decision providers, and is refused with none", async (t) => {
  const { registry } = await providers(t);
  const text = JSON.stringify(judgeFlow());
  assert.deepEqual(draftProblems(dsl, text, [], {}, {}, { providers: registry.providers, default: registry.default }), [], "proposed");
  assert.match(draftProblems(dsl, text, []).map((p) => p.detail).join("; "), /judge node "check" requires runJudge/, "no decision providers: refused as before");
});

test("a learned draft whose decision node's provider the run's gate holds to deny or ask is refused at learn time, in the gate's words; one it has no key for too", async (t) => {
  const { registry } = await providers(t);
  const decisions = { providers: registry.providers, default: registry.default };
  const denied = draftProblems(dsl, JSON.stringify(judgeFlow()), [], {}, {}, { ...decisions, gated: { jev: "deny" }, deniedBy: { jev: "agent" } });
  assert.match(denied.map((p) => p.detail).join("; "), /This workflow's decision node asks jev, which is set to deny for this agent\. \(the judge node at \/root\/steps\/0\)/);
  const asks = draftProblems(dsl, JSON.stringify(judgeFlow()), [], {}, {}, { ...decisions, gated: { jev: "ask" } });
  assert.match(asks.map((p) => p.detail).join("; "), /This workflow's decision node asks jev, which is set to ask, and a decision node can't wait for an approval/);
  const keyless = draftProblems(dsl, JSON.stringify(judgeFlow("parallel")), [], {}, {}, decisions);
  assert.match(keyless.map((p) => p.detail).join("; "), /names the decision provider parallel, which this host does not have/);
});

test("a learned workflow's judge node runs on faux with its spend on the run: admitted on the run's decisions before it is sent, settled at what it charged", async (t) => {
  const { registry, sent } = await providers(t);
  const book = booking();
  const flow = learned(judgeFlow());
  const out = await runLearned(runOf(flow, { providers: registry, book, pause: async () => assert.fail("no pause") }), flow, { claim: "Six times seven is 42." });
  assert.equal(out.isError, false, out.text);
  assert.deepEqual(JSON.parse(out.text), { right: true });
  assert.equal(sent(), 1, "one decision sent");
  assert.equal(book.admitted.length, 1, "admitted before it was sent");
  assert.equal(book.admitted[0].kind, "decision");
  assert.deepEqual(book.settled.map(([id, how]) => [id, how.end]), [[book.admitted[0].id, "charged"]], "settled once it answered");
  assert.ok(book.spentUsd() > 0, `its spend is the run's: ${book.spentUsd()}`);
});

test("a learned workflow's decision past the run's cap is never sent: the cap's refusal pauses the run, and the call answers why", async (t) => {
  const { registry, sent } = await providers(t);
  const book = booking(true);
  const paused = [];
  const flow = learned(judgeFlow());
  const out = await runLearned(runOf(flow, { providers: registry, book, pause: async (refusal) => void paused.push(refusal) }), flow, { claim: "Six times seven is 42." });
  assert.equal(out.isError, true, out.text);
  assert.match(out.text, /spend cap/);
  assert.equal(sent(), 0, "never sent");
  assert.deepEqual(book.settled, [], "nothing to settle");
  assert.equal(paused.length, 1, "the run pauses on the refusal");
  assert.equal(paused[0].code, "spend_cap_reached");
  assert.match(paused[0].refuse, /no room for this decision/);
});

test("a learned workflow whose decision node's provider is set to deny since it was learned is refused before any decision is sent", async (t) => {
  const { registry, sent } = await providers(t);
  const book = booking();
  const flow = learned(judgeFlow());
  const out = await runLearned(runOf(flow, { providers: registry, book }, (name) => (name === "jev" ? "deny" : "allow")), flow, { claim: "x" });
  assert.equal(out.isError, true);
  assert.ok(out.text.includes("This workflow's decision node asks jev, which is set to deny for this agent."), out.text);
  assert.equal(sent(), 0);
  assert.deepEqual(book.admitted, []);
});

test("a learned workflow with a decision node, on a run handed no decisions, is refused before any node runs", async () => {
  const flow = learned(judgeFlow());
  const out = await runLearned(runOf(flow), flow, { claim: "x" });
  assert.equal(out.isError, true);
  assert.match(out.text, /judge node "check" requires runJudge/);
});
