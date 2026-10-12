import assert from "node:assert/strict";
import { test } from "node:test";
import { teachResultCard } from "../tab/teach-result.ts";

// teach_skills answers with typed details ({teach, threads: ThreadResult[], home?}); the page draws a compact card from them. The model-facing text stays the model's.
const thread = (over: Record<string, unknown>) => ({ skill: "walk", gpu: 1, conversationId: 16, boxId: "sb-1", status: "passed", checkpoint: 5, seconds: 93, summary: "I trained walk.", metric: { name: "speed", value: 0.51, unit: "m/s", target: ">= 0.4" }, ...over });

test("one row per thread, in GPU order: a pass with its measurement, checkpoint and time; the rest in their own words; then what came home", () => {
  const card = teachResultCard({ teach: 14, threads: [thread({ skill: "wave", gpu: 3, status: "never-passed", checkpoint: undefined, metric: undefined, seconds: 120, reason: "the paw never rose" }), thread({}), thread({ skill: "spin", gpu: 2, metric: { name: "spin rate", value: 1.234, unit: "rad/s", target: ">= 1.0" }, checkpoint: 6, seconds: 70 })], home: { skills: ["spin", "walk"] } })!;
  assert.deepEqual(card.rows, [
    { passed: true, text: "walk · speed 0.51 m/s ≥ 0.4 · checkpoint 5 · 93 s" },
    { passed: true, text: "spin · spin rate 1.23 rad/s ≥ 1.0 · checkpoint 6 · 70 s" },
    { passed: false, text: "wave · never passed · 120 s · the paw never rose" },
  ]);
  assert.equal(card.home, "Home: spin, walk");
});

test("a pass without a measurement still reads, other outcomes are named plainly, and a failed homecoming says so", () => {
  const card = teachResultCard({ threads: [thread({ metric: undefined, checkpoint: undefined, seconds: undefined }), thread({ skill: "spin", gpu: 2, status: "timed-out", seconds: undefined, summary: "" }), thread({ skill: "wave", gpu: 3, status: "bad-body", seconds: undefined, summary: "" })], home: { error: "no skill is done" } })!;
  assert.deepEqual(card.rows.map((r) => r.text), ["walk", "spin · timed out", "wave · bad body"]);
  assert.equal(card.rows[0]!.passed, true);
  assert.equal(card.home, "Bringing the skills home failed: no skill is done");
  assert.equal(teachResultCard({ threads: [thread({})] })!.home, null, "no home result: nothing said about it");
});

test("details that are not a teach result give no card, so the page shows the result's own text", () => {
  assert.equal(teachResultCard(undefined), null);
  assert.equal(teachResultCard({ threads: [] }), null);
  assert.equal(teachResultCard({ threads: [{ gpu: 1 }] }), null, "a thread with no skill or status is not a result");
  assert.equal(teachResultCard("text"), null);
});

import { briefsFromArgs } from "../tab/teach-result.ts";
test("the briefs the parent gave each thread, from teach_skills' own typed arguments: by name, nothing for anything else", () => {
  const briefs = briefsFromArgs(JSON.stringify({ skills: [{ name: "walk", brief: "Walk forward on four legs while keeping the torso steady." }, { name: "spin", brief: "Spin in place." }, { name: "bad" }, 7] }));
  assert.equal(briefs.get("walk"), "Walk forward on four legs while keeping the torso steady.");
  assert.equal(briefs.get("spin"), "Spin in place.");
  assert.equal(briefs.size, 2, "an entry without a brief, or not an object, is skipped");
  assert.equal(briefsFromArgs("not json").size, 0);
  assert.equal(briefsFromArgs(JSON.stringify({})).size, 0);
  assert.equal(briefsFromArgs(JSON.stringify({ skills: "walk" })).size, 0);
});

test("an unsuccessful row says why: the first typed explanation present (the trainer's reason, then what could not be read about its outcome, then the first line of the thread's own words), clipped", () => {
  const card = teachResultCard({ threads: [
    thread({ skill: "a", gpu: 1, status: "error", metric: undefined, checkpoint: undefined, seconds: undefined, reason: undefined, summary: "CUDA out of memory in the reward module\nTraceback follows" }),
    thread({ skill: "b", gpu: 2, status: "reported", metric: undefined, checkpoint: undefined, seconds: undefined, reason: undefined, summary: "I think it works.", outcomeError: "the status hook threw" }),
    thread({ skill: "c", gpu: 3, status: "never-passed", metric: undefined, checkpoint: undefined, seconds: undefined, reason: "the paw never rose", summary: "ignored when the trainer's reason is there" }),
  ] })!;
  assert.deepEqual(card.rows.map((r) => r.text), ["a · error · CUDA out of memory in the reward module", "b · reported · its outcome could not be read: the status hook threw", "c · never passed · the paw never rose"]);
});
