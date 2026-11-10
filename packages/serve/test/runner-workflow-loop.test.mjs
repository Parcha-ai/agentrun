// The workflow loop on the runner (runner/workflow-loop.ts): a run of a workflow revision the runner claims like any run.
// The DSL's durable runner runs the revision's workflow (a faux model node) on the run's journal in the one store; the loop
// writes the end (the run's state, its summary) on the run's row. A cancel ends the run stopped; a claim lost before the end
// commit resumes the workflow from its journal and ends the run. No HTTP server, no per-run process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createWorkflowExtension, nodeRunner, taskScope } from "@parcha/agentrun-pi/durable";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { startWorkflowRevision } from "@parcha/pi-durable-agent/workflow";
import { storeOn } from "./store-helpers.mjs";
import { answerFlow, FAUX } from "./support.mjs";

const { createWorkflowLoop, isWorkflowRevision } = await import("../dist/runner/workflow-loop.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { runModels, FAUX_ENV } = await import("../dist/model.js");

/** The cap refusal the host hands the loop on a hold, and a fake of the kernel cap's rule (parkOf/checkRaise): the loop
 *  never imports the cap, so a test hands its rule in. The real cap's figures are the money-parity red's, not this test's. */
const REFUSAL = { message: "SPEND_CAP_REACHED spend cap reached", forGood: false };
const FAKE_CAP = {
  park: (refusal) => refusal.forGood
    ? { outcome: "failed", error: refusal.message }
    : { outcome: "parked", pending: { kind: "budget", cap_usd: 1, spent_usd: 1, needs_usd: 2, least_cap_usd: 2, suggested_cap_usd: 5 }, words: "spend cap reached" },
  checkRaise: (state, usd) => (usd > (state.capUsd ?? 0) ? { raised: true, resumes: state.pause !== undefined, ...(state.pause ? { pause: state.pause } : {}) } : { refused: "A cap is only raised." }),
  followUpOf: (capUsd) => ({ text: `The cap was raised to ${capUsd}.` }),
};

/** The kinds of a run's root-conversation entries, in order (to see the budget and raise entries the loop wrote). */
async function rootKinds(store, runId) {
  const reads = store.readJournal(runId);
  const kinds = [];
  for (let cursor; ; ) {
    const page = await reads.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
    kinds.push(...page.items.map((entry) => entry.kind));
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return kinds;
}

/** A workflow agent, its revision and one claimed run. */
async function claimedWorkflow(t, workflow = answerFlow()) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  return { store, claim, workflow };
}

/** The workflow run spec the loop runs: the run's models (faux), and a host that runs model nodes on them. The call
 *  tools, decisions and cap a real run brings are not needed to prove the loop's own work. */
async function workflowSpec(workflow, input) {
  const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  return {
    models, workflow, input, tools: inspectWorkflow(workflow).requires.tools, agentId: "agent-1", revisionId: "rev-1",
    build: () => {
      const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
      return {
        extensions: [nodes.extension],
        host: { run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }) },
      };
    },
  };
}

function loopOn(store, workflow, input, signal = new AbortController().signal) {
  const factory = createWorkflowLoop(() => workflowSpec(workflow, input));
  return factory({ journal: (claim) => store.journal(claim), flush: () => store.flush(), signal });
}

/** The DSL's durable runner over the run's journal, to terminal, with the Harness still open (a run that ran but whose
 *  loop has not written the end yet). */
async function runToTerminal(store, claim, { workflow, input }) {
  const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
  const workflows = createWorkflowExtension({ run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }) });
  const registry = createRegistry();
  registry.install(nodes.extension);
  registry.install(workflows.extension);
  const harness = await Harness.open(store.journal(claim), { models, registry, onReport: () => {} }, BACKGROUND_CONTEXT);
  await startWorkflowRevision({ harness, workflows, context: BACKGROUND_CONTEXT, run: { runId: claim.runId, agentId: "agent-1", revision: { id: "rev-1", kind: "workflow", body: { workflow } } }, input, tools: inspectWorkflow(workflow).requires.tools });
  return harness;
}

/** A loop whose first model node signals when it has started (so a test waits on an event, not a poll) and then holds until
 *  its signal aborts (a cancel), after which — if run again on a resume — it runs for real. `control.started` resolves on
 *  the node's start; `control.held` is shared across claims so a resumed run completes. */
function heldNodeLoop(store, workflow, input, control, signal = new AbortController().signal) {
  const specOf = async () => {
    const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
    return {
      models, workflow, input, tools: inspectWorkflow(workflow).requires.tools, agentId: "agent-1", revisionId: "rev-1",
      build: () => {
        const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
        return {
          extensions: [nodes.extension],
          host: { run: ({ runtime, context }) => {
            const runNode = nodes.on(taskScope(runtime), context).runNode;
            return { durableNodes: true, adapters: { runNode: async (params) => {
              if (!control.held) {
                control.held = true;
                control.started?.();
                await new Promise((_, reject) => {
                  const s = params.signal;
                  if (s?.aborted) return reject(s.reason);
                  s?.addEventListener("abort", () => reject(s.reason), { once: true });
                });
              }
              return runNode(params);
            } } };
          } },
        };
      },
    };
  };
  return createWorkflowLoop(specOf)({ journal: (claim) => store.journal(claim), flush: () => store.flush(), signal });
}

test("the runner picks the workflow loop for a workflow revision, not an agentic one", () => {
  assert.equal(isWorkflowRevision({ kind: "workflow" }), true);
  assert.equal(isWorkflowRevision({ kind: "agentic" }), false);
});

test("a workflow run runs to its end through the loop: the run ends completed, its summary the completed node", async (t) => {
  const { store, claim } = await claimedWorkflow(t);
  const loop = loopOn(store, answerFlow(), { question: "What is six times seven?" });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  const run = await store.runs.get("run-1");
  assert.equal(run.state, "ended");
  assert.equal(run.summary, "answer", "the carry names the completed node");
  assert.equal(run.outcome, null, "a run that did not escalate has no outcome (reads completed)");
});

test("a cancel ends the run stopped (cancelled in words), taking the cancel row in the end commit", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  let nodeStarted;
  const startedP = new Promise((resolve) => (nodeStarted = resolve));
  const loop = heldNodeLoop(store, workflow, { question: "What is six times seven?" }, { started: nodeStarted });
  const started = loop.start(claim);
  await startedP; // the node is running (an event, not a poll)
  const cancel = await store.command("run-1", { kind: "cancel", body: {} });
  await loop.stop({ kind: "command", commandId: cancel.id, cancel: true });
  assert.deepEqual(await started, { state: "stopped" });
  const run = await store.runs.get("run-1");
  assert.equal(run.state, "stopped");
  assert.equal(run.summary, "cancelled", "a cancel's words say which");
  // The cancel row was taken in the end commit, not left untaken.
  const rows = await store.commands("run-1", 0);
  assert.equal(rows.find((row) => row.id === cancel.id).takenAt !== null, true, "the cancel row is taken");
});

test("a plain stop ends the run stopped, in the person's words", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  let nodeStarted;
  const startedP = new Promise((resolve) => (nodeStarted = resolve));
  const loop = heldNodeLoop(store, workflow, { question: "What is six times seven?" }, { started: nodeStarted });
  const started = loop.start(claim);
  await startedP;
  const stop = await store.command("run-1", { kind: "stop", body: {} });
  await loop.stop({ kind: "command", commandId: stop.id });
  assert.deepEqual(await started, { state: "stopped" });
  assert.equal((await store.runs.get("run-1")).summary, "stopped by a person");
  const rows = await store.commands("run-1", 0);
  assert.equal(rows.find((row) => row.id === stop.id).takenAt !== null, true, "the stop row is taken");
});

test("a workflow run takes no messages or answers", async (t) => {
  const { store, claim } = await claimedWorkflow(t);
  const loop = loopOn(store, answerFlow(), { question: "What is six times seven?" });
  const outcome = await loop.command({ id: 1, runId: "run-1", kind: "steer", body: { text: "faster" }, takenAt: null });
  assert.equal("refused" in outcome, true);
  await loop.start(claim);
});

test("a claim lost before the end commit resumes the workflow from its journal and ends the run", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  // The workflow runs to terminal on the first claim, but its loop never writes the end: a crash before the end commit.
  const harness = await runToTerminal(store, claim, { workflow, input: { question: "What is six times seven?" } });
  await harness.close(BACKGROUND_CONTEXT);
  assert.equal((await store.runs.get("run-1")).state, "running", "no end was written before the crash");

  // The runner loses the claim and re-claims; the loop resumes, reads the terminal workflow from the journal, and ends it.
  await store.release(claim, {});
  const claim2 = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const loop = loopOn(store, workflow, { question: "What is six times seven?" });
  assert.deepEqual(await loop.start(claim2), { state: "ended" });
  const run = await store.runs.get("run-1");
  assert.equal(run.state, "ended");
  assert.equal(run.summary, "answer");
});

/** A loop whose host holds the first model node at the cap once (it parks the run), then runs it for real. `state.held` is
 *  shared across claims, so the resumed run's node completes. */
function cappedLoopOn(store, workflow, input, state, signal = new AbortController().signal, delivered = undefined) {
  const specOf = async () => {
    const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
    return {
      models, workflow, input, tools: inspectWorkflow(workflow).requires.tools, agentId: "agent-1", revisionId: "rev-1", cap: FAKE_CAP,
      build: (hooks) => {
        const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
        return {
          extensions: [nodes.extension],
          host: { run: ({ runtime, context }) => {
            const runNode = nodes.on(taskScope(runtime), context).runNode;
            return { durableNodes: true, adapters: { runNode: async (params) => {
              if (!state.held) {
                state.held = true;
                // The cap holds this step for a raise: hand the loop the refusal and let the node's signal (the loop aborts
                // it) end the wait.
                hooks.park(REFUSAL);
                await new Promise((_, reject) => {
                  const s = params.signal;
                  if (s?.aborted) return reject(s.reason);
                  s?.addEventListener("abort", () => reject(s.reason), { once: true });
                });
              }
              return runNode(params);
            } } };
          } },
        };
      },
    };
  };
  return createWorkflowLoop(specOf)({ journal: (claim) => store.journal(claim), flush: () => store.flush(), signal, ...(delivered ? { delivered } : {}) });
}

test("a step the cap holds parks the run on an agentrun.budget entry; a raise takes an agentrun.raise entry and the resume ends it", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  const state = { held: false };
  const loop1 = cappedLoopOn(store, workflow, { question: "What is six times seven?" }, state);
  assert.deepEqual(await loop1.start(claim), { state: "parked" }, "the held step parks the run");
  const parked = await store.runs.get("run-1");
  assert.equal(parked.state, "parked");
  assert.equal(parked.summary, "spend cap reached", "the run's row is in the cap's words");
  assert.ok((await rootKinds(store, "run-1")).includes(KINDS.budget), "the park wrote an agentrun.budget entry");

  // The runner releases the parked run; a raise makes it claimable again, and the resume reads the raised cap.
  await store.release(claim, {});
  const raise = await store.command("run-1", { kind: "raise", body: { capUsd: 10 } });
  const claim2 = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  // The runner hands the raise row to the loop and, once command() has returned, signals its first delivery done, as the
  // real runner does (it awaits each command() before marking the delivery): so the resume's takeRaises sees the raise.
  let deliver;
  const delivered = new Promise((resolve) => (deliver = resolve));
  const loop2 = cappedLoopOn(store, workflow, { question: "What is six times seven?" }, state, undefined, delivered);
  const started = loop2.start(claim2);
  const raiseOutcome = await loop2.command(raise);
  deliver();
  assert.deepEqual(raiseOutcome, { taken: true }, "the raise is taken");
  assert.deepEqual(await started, { state: "ended" }, "the resume runs the once-held step and ends the run");
  const run = await store.runs.get("run-1");
  assert.equal(run.state, "ended");
  assert.equal(run.summary, "answer");
  assert.ok((await rootKinds(store, "run-1")).includes(KINDS.raise), "the raise wrote an agentrun.raise entry");
  const rows = await store.commands("run-1", 0);
  assert.equal(rows.find((row) => row.id === raise.id).takenAt !== null, true, "the raise row is taken");
});
