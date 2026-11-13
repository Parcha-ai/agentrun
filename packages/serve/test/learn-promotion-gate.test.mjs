// A serving digest's check (runner/promotion.ts promotionGate), over a store of graded runs: once per 20 graded runs it
// served, its thresholds refit (a new revision, promoted on the rows it was fit on, when they move within the bar) and it
// is held when its graded runs fall more than 2 points under the agent's by hand. Escalation never holds it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { promotionGate } = await import("../dist/runner/promotion.js");
const { putGrade, promotionsOf, recordPromotion, REFIT_EVERY } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");

const flowOf = (guard) => JSON.stringify({ v: 2, name: "answer", schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } }, input: { schemaId: "In" }, output: { schemaId: "In", path: "question" },
  root: { node: "agent", label: "answer", instructions: "Answer.", out: "In", as: "answer", tools: [], ...(guard ? { guard } : {}) } });

/** A store of `served` graded runs at the workflow's digest (each `[correct, p]`, path workflow, or handed_back when p
 *  is under the guard's threshold) and `byHand` graded agent runs, all right; the workflow promoted at its digest. */
async function storeOf({ text, served, byHand = 10, threshold = 0.5 }) {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  const digest = workflowDigest({ workflow: text });
  const rows = new Map();
  let at = 0;
  for (let i = 0; i < byHand; i++) await putGrade(settings, "a", { run: `hand-${i}`, correct: true, source: "eval", at: `t${at++}`, path: "agent" });
  for (const [i, [correct, p]] of served.entries()) {
    const path = p < threshold ? "handed_back" : "workflow";
    rows.set(`served-${i}`, { id: `served-${i}`, state: "ended", metrics: { path, workflow: "answer", workflow_digest: digest, guards: [{ node: "answer", signal: "self", self: p, p, threshold, escalated: p < threshold }] } });
    await putGrade(settings, "a", { run: `served-${i}`, correct, source: "eval", at: `t${at++}`, path, workflow: "answer", digest });
  }
  await recordPromotion(settings, "a", { workflow: "answer", digest, at: new Date(0).toISOString(), decided: "promote", source: "dry_run", reason: "no graded input it fits: promoted on its passing dry run" }, (was) => was === undefined);
  const store = { settings, runs: { get: async (id) => rows.get(id) } };
  const commits = [];
  const logs = [];
  const gate = promotionGate({ store, agentId: "a", runId: "now", revisionId: "rev", launch: { input: {}, title: "", place: { mode: "runner" } }, context: ctx, log: (line) => logs.push(line), commit: async (files, reason, id) => (commits.push({ files, reason, id }), `commit-${commits.length}`) });
  // The gate answers the workflow that serves: this one, or none (the agent takes the run).
  const serves = async (workflow, at) => { const got = await gate(workflow, at); assert.ok(got === undefined || got === workflow, "no champion here: the laid workflow or none"); return got === workflow; };
  return { gate: serves, settings, digest, commits, logs };
}

test("a serving digest under REFIT_EVERY graded runs is not checked: it serves", async () => {
  const text = flowOf({ signal: "self", threshold: 0.5 });
  const { gate, settings, commits } = await storeOf({ text, served: Array.from({ length: REFIT_EVERY - 1 }, () => [false, 0.9]) });
  assert.equal(await gate({ name: "answer", workflow: text }, workflowDigest({ workflow: text })), true);
  assert.deepEqual(commits, []);
  assert.equal((await promotionsOf(settings, "a")).length, 1);
});

test("20 graded runs it served: its guard refit to the cheapest threshold within the bar lands as a new revision, once", async () => {
  const text = flowOf({ signal: "self", threshold: 0.5 });
  // Wrong exactly when its own confidence is under 0.7: a threshold of 0.5 lets some serve wrong.
  const served = Array.from({ length: REFIT_EVERY }, (_, i) => { const p = 0.5 + (i % 5) * 0.1; return [p >= 0.7, p]; });
  const { gate, settings, digest, commits, logs } = await storeOf({ text, served });
  assert.equal(await gate({ name: "answer", workflow: text }, digest), true, "it still serves this run; the refit serves from the next");
  assert.equal(commits.length, 1, logs.join("\n"));
  const written = JSON.parse(commits[0].files[0].text);
  assert.equal(commits[0].files[0].path, "workflows/answer/workflow.json");
  assert.equal(written.root.guard.threshold, 0.7);
  const records = await promotionsOf(settings, "a");
  const refit = records.at(-1);
  assert.deepEqual({ decided: refit.decided, source: refit.source, digest: refit.digest, from: refit.refit.from, guards: refit.refit.guards, commit: refit.commit }, { decided: "promote", source: "refit", digest: workflowDigest({ workflow: commits[0].files[0].text }), from: digest, guards: [{ node: "answer", was: 0.5, threshold: 0.7 }], commit: "commit-1" }, "the refit's record names the learning commit its text landed as");
  assert.equal(records.filter((one) => one.digest === digest).at(-1).checked, REFIT_EVERY, "checked at 20");
  // The same 20 again: not checked twice.
  assert.equal(await gate({ name: "answer", workflow: text }, digest), true);
  assert.equal(commits.length, 1);
});

test("graded runs it served more than 2 points under the agent by hand, nothing to refit: held; hand-backs graded right never hold it", async () => {
  const text = flowOf(undefined);
  const wrong = await storeOf({ text, served: Array.from({ length: REFIT_EVERY }, (_, i) => [i % 4 !== 0, 0.9]) });
  assert.equal(await wrong.gate({ name: "answer", workflow: text }, wrong.digest), false);
  const held = (await promotionsOf(wrong.settings, "a")).at(-1);
  assert.deepEqual({ decided: held.decided, source: held.source }, { decided: "hold", source: "graded" });
  assert.match(held.reason, /20 graded runs it served were right 75\.0% of the time, more than 2 pts under the agent's 100\.0% by hand/);
  // Every one handed back (its guard under threshold) and graded right: the agent's answers, all right. It serves on.
  const guarded = flowOf({ signal: "self", threshold: 0.5 });
  const handed = await storeOf({ text: guarded, served: Array.from({ length: REFIT_EVERY }, () => [true, 0.2]) });
  assert.equal(await handed.gate({ name: "answer", workflow: guarded }, handed.digest), true);
  assert.equal((await promotionsOf(handed.settings, "a")).at(-1).decided, "promote");
});
