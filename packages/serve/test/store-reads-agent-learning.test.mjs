// An agent's learning view from the one store (GET /agents/{id}/learning, learning-run.ts ofAgent): what learning changed
// (learningImpact), read from its runs' launches (the corrections and workflows each started from, learningStartOf), their
// journals (the learned workflows each claim laid) and their learning ends (when the job answered, what it and looking
// back cost), never a run's files. The figures are today's rules (learning-run.ts learningImpact, figuresOf): a run that
// looked back answered when its job did, at its job's cost; one that learns counts its look-back as learning's own cost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const reads = await import("../dist/store-reads/learning.js");
const fn = (module, name) => (typeof module[name] === "function" ? module[name] : () => assert.fail(`${name} is not there`));
const agentLearningOverStore = (...args) => fn(reads, "agentLearningOverStore")(...args);

const ROOT = 1;
const iso = (ms) => new Date(ms).toISOString();

/** Run `id` of agent-1, started at `start` (ms), ended `seconds` later at `usd` (with `bound`, stored as the most it can
 *  have cost, a request cut at its hold counted in it). `learning`: its launch's learning start, its claim laying the
 *  learned workflows it names (KINDS.learningLaid); `kept`: its kept learning row's proposal. */
async function run(store, clock, { id, start, seconds, usd, bound = false, learning, kept }) {
  clock.now = start;
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: id, place: { mode: "runner" }, ...(learning ? { learning } : {}) } });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  if (learning?.workflows?.length) {
    const journal = store.journal(claim);
    const laid = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.learning.laid", data: { workflows: learning.workflows } };
    await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: laid }], context);
  }
  const also = kept ? [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] : [];
  await store.runs.update(claim, { state: "ended", costUsd: usd, ...(bound ? { costUpperBound: true } : {}), endedAt: start + seconds * 1000 }, { also });
}

/** A drop with nothing to keep, after a look back: the job answered `seconds` in at `job`, looking back cost `back`. */
const lookedBack = (start, seconds, job, back) => ({ state: "dropped", reason: "empty", detail: "Nothing to keep.", answered_at: iso(start + seconds * 1000), job_cost_usd: job, look_back_usd: back });
/** A learning start from main's commit, laying the learned workflow `answer`. */
const FROM_WORKFLOW = { seed: "a".repeat(40), section: "", workflows: ["answer"] };

test("an agent's impact from the store: before and after its first run started from a learned workflow", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  // Two runs before anything learned (learning not started), then two that started from a learned workflow and looked back.
  await run(store, clock, { id: "r1", start: T0, seconds: 10, usd: 0.1 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20, usd: 0.3 });
  await run(store, clock, { id: "r3", start: T0 + 1_000_000, seconds: 45, usd: 0.25, learning: FROM_WORKFLOW, kept: lookedBack(T0 + 1_000_000, 30, 0.2, 0.05) });
  await run(store, clock, { id: "r4", start: T0 + 2_000_000, seconds: 70, usd: 0.47, learning: FROM_WORKFLOW, kept: lookedBack(T0 + 2_000_000, 50, 0.4, 0.07) });

  const view = await agentLearningOverStore(store, "agent-1");
  assert.deepEqual(view.impact, {
    // Before: their rows' end and cost; no learning of their own.
    before: { runs: 2, median_duration_s: 15, median_cost_usd: 0.2, cost_runs: 2 },
    // After: to their job's answer at their job's cost (what learning cost is the bill's, never a median here).
    after: { runs: 2, median_duration_s: 40, median_cost_usd: 0.3, cost_runs: 2 },
  });
  assert.deepEqual(view.counts, { merged: 0, dropped: { empty: 2 }, in_progress: 0 }, "its counts, as before");
});

test("a run whose stored cost is only the most it can have cost counts in the impact's runs and durations, never in its costs: no median_cost_usd or cost_runs reads a bound as spend", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10, usd: 0.1 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20, usd: 0.3 });
  // A run before anything learned that a crash cut mid-request: its stored $0.9 counts that request at its hold, a ceiling.
  await run(store, clock, { id: "r0", start: T0 + 200_000, seconds: 30, usd: 0.9, bound: true });
  await run(store, clock, { id: "r3", start: T0 + 1_000_000, seconds: 45, usd: 0.25, learning: FROM_WORKFLOW, kept: lookedBack(T0 + 1_000_000, 30, 0.2, 0.05) });
  await run(store, clock, { id: "r4", start: T0 + 2_000_000, seconds: 70, usd: 0.47, learning: FROM_WORKFLOW, kept: lookedBack(T0 + 2_000_000, 50, 0.4, 0.07) });

  const { impact } = await agentLearningOverStore(store, "agent-1");
  assert.deepEqual(impact?.before, { runs: 3, median_duration_s: 20, median_cost_usd: 0.2, cost_runs: 2 }, `the bounded run is a run of unknown cost: ${JSON.stringify(impact)}`);
});

test("a run started from its owner's corrections counts on the after side by its # Learned section, though it laid no workflow", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10, usd: 0.1 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20, usd: 0.3 });
  const corrected = { seed: "a".repeat(40), section: "# Learned\n- Answer in one line.\n" };
  await run(store, clock, { id: "r3", start: T0 + 1_000_000, seconds: 45, usd: 0.25, learning: corrected, kept: lookedBack(T0 + 1_000_000, 30, 0.2, 0.05) });
  await run(store, clock, { id: "r4", start: T0 + 2_000_000, seconds: 70, usd: 0.47, learning: corrected, kept: lookedBack(T0 + 2_000_000, 50, 0.4, 0.07) });

  const { impact } = await agentLearningOverStore(store, "agent-1");
  assert.equal(impact?.after.runs, 2, `both started from the owner's correction: ${JSON.stringify(impact)}`);
  assert.equal(impact?.before.runs, 2);
});

test("runs that only use what the agent learned (learning: use, no proposal) count on the after side, with zero learning spend", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await run(store, clock, { id: "r1", start: T0, seconds: 10, usd: 0.1 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20, usd: 0.3 });
  // Two runs that used the learned workflow; a `use` run keeps no proposal.
  const used = { ...FROM_WORKFLOW, use: true };
  await run(store, clock, { id: "r3", start: T0 + 1_000_000, seconds: 40, usd: 0.2, learning: used });
  await run(store, clock, { id: "r4", start: T0 + 2_000_000, seconds: 60, usd: 0.4, learning: used });

  const { impact } = await agentLearningOverStore(store, "agent-1");
  assert.deepEqual(impact, {
    before: { runs: 2, median_duration_s: 15, median_cost_usd: 0.2, cost_runs: 2 },
    after: { runs: 2, median_duration_s: 50, median_cost_usd: 0.3, cost_runs: 2 },
  });
});
