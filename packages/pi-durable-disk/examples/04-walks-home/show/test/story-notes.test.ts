import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyStory, simulationNote, storyNotes, visibleTag } from "../page/story-notes.ts";
import { emptyState } from "../reduce.ts";
import type { Place } from "../types.ts";

const at = (place: Place) => ({ ...emptyState(), place });
const here: Place = { where: "tab", host: "your browser" };
const moving: Place = { where: "moving", to: "H100 GPU", host: "your browser" };
const away: Place = { where: "cloud", host: "H100 GPU" };
const home: Place = { where: "home", host: "your browser" };

test("the product's point is said once, at the first move: its memory is on a cloud disk, so it can change machines without forgetting", () => {
  const story = emptyStory();
  assert.deepEqual(storyNotes(at(here), story, 100), [], "nothing before it moves");
  const first = storyNotes(at(moving), story, 200);
  assert.deepEqual(first.map((n) => n.text), ["Its memory is on a cloud disk, so it can change machines without forgetting anything."]);
  assert.deepEqual(storyNotes(at(away), story, 300), [], "said once");
  assert.deepEqual(storyNotes(at(moving), story, 400), [], "a second move says nothing more about it");
});

test("coming back says why: the training is done and what it learned came with it, once", () => {
  const story = emptyStory();
  storyNotes(at(moving), story, 1);
  storyNotes(at(away), story, 2);
  assert.deepEqual(storyNotes(at(moving), story, 3), [], "still on the way: not home yet");
  const back = storyNotes(at(home), story, 4);
  assert.deepEqual(back.map((n) => n.text), ["Done training. The agent came back to your browser, and so did what it learned."]);
  assert.deepEqual(storyNotes(at(home), story, 5), []);
});

test("a run that never left says nothing about coming back, and these lines are plain notes with no number to tag", () => {
  const story = emptyStory();
  assert.deepEqual(storyNotes(at(home), story, 1), []);
  const all = [...storyNotes(at(moving), emptyStory(), 1), ...(() => { const s = emptyStory(); storyNotes(at(away), s, 1); return storyNotes(at(home), s, 2); })()];
  assert.ok(all.every((n) => n.measured === undefined && n.basis === undefined && !/\d/.test(n.text)));
});

test("the creature is said to be a physics simulation in your browser, once, at the start", () => {
  const n = simulationNote(5);
  assert.equal(n.text, "The creature is a physics simulation running in your browser.");
  assert.equal(n.at, 5);
});

test("the v2 view drops the SIMULATED pill and keeps MEASURED, REPORTED and the rest; the debug view keeps all", () => {
  assert.equal(visibleTag("simulated", false), null);
  for (const t of ["measured", "reported", "scripted", "unmeasured", "agent"] as const) assert.equal(visibleTag(t, false), t);
  assert.equal(visibleTag("simulated", true), "simulated");
  assert.equal(visibleTag(null, false), null);
});

test("the stage's own captions outrank the tab's chatter when they arrive together", () => {
  const story = emptyStory();
  assert.equal(storyNotes(at(moving), story, 1)[0]!.rank, 2);
  storyNotes(at(away), story, 2);
  assert.equal(storyNotes(at(home), story, 3)[0]!.rank, 2);
  assert.equal(simulationNote(4).rank, 1);
});
