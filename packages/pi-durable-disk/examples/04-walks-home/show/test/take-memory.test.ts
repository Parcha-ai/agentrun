import assert from "node:assert/strict";
import { test } from "node:test";
import { TakeMemory } from "../page/take-memory.ts";
import { storyNotes } from "../page/story-notes.ts";
import { emptyState } from "../reduce.ts";

const away = { ...emptyState(), place: { where: "cloud" as const, host: "H100 GPU" } };

test("a take that starts over (a retake with the same run name) says its story captions again", () => {
  const m = new TakeMemory();
  assert.equal(m.sync(1), false, "the first connection is not a restart");
  assert.equal(storyNotes(away, m.story, 1).length, 1, "the first take says it");
  assert.equal(storyNotes(away, m.story, 2).length, 0, "once");
  assert.equal(m.sync(1), false, "the same take");
  assert.equal(m.sync(2), true, "the feed started over");
  assert.equal(storyNotes(away, m.story, 3).length, 1, "the new take says it again");
});

test("a restart forgets which setups were noted and what was trained, so nothing from the old take leaks into the new", () => {
  const m = new TakeMemory();
  m.sync(1);
  m.setupNoted.add("1|20500");
  m.story.trained = true;
  m.sync(2);
  assert.equal(m.setupNoted.size, 0);
  assert.equal(m.story.trained, false);
});
