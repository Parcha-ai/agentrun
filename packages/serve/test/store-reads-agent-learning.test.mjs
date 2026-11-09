// An agent's learning view from the one store (GET /agents/{id}/learning, learning-run.ts ofAgent): each note's runs
// (given it, read it) and what learning changed (learningImpact), read from its runs' launches (the notes each was
// given, learningStartOf), their journals (the notes each job read) and their learning ends (when the job answered,
// what it and looking back cost), never a run's files. The figures are today's rules (learning-run.ts noteRuns,
// learningImpact, figuresOf): a run that looked back answered when its job did, at its job's cost; one that learns
// counts its look-back and its grade as learning's own cost.
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

/** Run `id` of agent-1, started at `start` (ms), ended `seconds` later at `usd`. `learning`: its launch's learning start;
 *  `read`: the files its job read; `kept`: its kept learning row's proposal. */
async function run(store, clock, { id, start, seconds, usd, learning, read = [], kept }) {
  clock.now = start;
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: id, place: { mode: "runner" }, ...(learning ? { learning } : {}) } });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  if (read.length) {
    const journal = store.journal(claim);
    const writes = [{ type: "conversation", value: { id: ROOT } }];
    for (const [i, file] of read.entries()) {
      const call = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `.learning/${file}` } }], timestamp: start + i }] };
      const result = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "the note" }], isError: false, timestamp: start + i }] };
      writes.push({ type: "entry", value: call }, { type: "entry", value: result });
    }
    await commitWrites(journal, writes, context);
  }
  const also = kept ? [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] : [];
  await store.runs.update(claim, { state: "ended", costUsd: usd, endedAt: start + seconds * 1000 }, { also });
}

/** A drop with nothing to keep, after a look back: the job answered `seconds` in at `job`, looking back cost `back`. */
const lookedBack = (start, seconds, job, back) => ({ state: "dropped", reason: "empty", detail: "Nothing to keep.", answered_at: iso(start + seconds * 1000), job_cost_usd: job, look_back_usd: back });

test("an agent's notes' runs and its impact from the store: given and read by note, and before and after its first note", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  // Two runs before any note (learning not started), then two that started from notes and looked back.
  await run(store, clock, { id: "r1", start: T0, seconds: 10, usd: 0.1 });
  await run(store, clock, { id: "r2", start: T0 + 100_000, seconds: 20, usd: 0.3 });
  const both = { given: [{ file: "a.md", name: "Alpha" }, { file: "b.md", name: "Beta" }], seed: "a".repeat(40), section: "# Learned\n" };
  await run(store, clock, { id: "r3", start: T0 + 1_000_000, seconds: 45, usd: 0.25, learning: both, read: ["a.md"], kept: lookedBack(T0 + 1_000_000, 30, 0.2, 0.05) });
  const one = { given: [{ file: "a.md", name: "Alpha" }], seed: "a".repeat(40), section: "# Learned\n" };
  await run(store, clock, { id: "r4", start: T0 + 2_000_000, seconds: 70, usd: 0.47, learning: one, kept: lookedBack(T0 + 2_000_000, 50, 0.4, 0.07) });

  const view = await agentLearningOverStore(store, "agent-1");
  assert.deepEqual(Object.fromEntries(view.notes), { "a.md": { given: 2, read: 1 }, "b.md": { given: 1, read: 0 } }, "each note: the runs given it and the runs that read it");
  assert.deepEqual(view.impact, {
    // Before: their rows' end and cost; no learning of their own.
    before: { runs: 2, median_duration_s: 15, median_cost_usd: 0.2, cost_runs: 2, median_learning_usd: null },
    // After: to their job's answer at their job's cost; learning's own cost their look-back and their grade (none graded: 0).
    after: { runs: 2, median_duration_s: 40, median_cost_usd: 0.3, cost_runs: 2, median_learning_usd: 0.06 },
  });
  assert.deepEqual(view.counts, { merged: 0, dropped: { empty: 2 }, in_progress: 0 }, "its counts, as before");
});
