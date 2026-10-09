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

// Greptile on #110, round two: every piece of what the page remembers about a take resets together, and notes are added through the memory so a
// note for the new take is never wiped by a reset that was already due.
const note = (at: number, text: string) => ({ at, kind: "home" as const, text });

test("everything the page remembers about a take resets with it: the brain it asked the tab to load, whether the agent went, what each install was", () => {
  const m = new TakeMemory();
  m.sync(1);
  m.policyRequested = "rehearsal";
  m.wasAway = true;
  m.installKind.set(3, "checkpoint");
  m.lastInstallKind = "final";
  m.bandOfInstall.set(3, "shuffle");
  m.add(1, note(1, "first take"));
  assert.equal(m.sync(2), true);
  assert.equal(m.policyRequested, "", "the next return asks the tab for a trained brain again");
  assert.equal(m.wasAway, false);
  assert.equal(m.installKind.size, 0);
  assert.equal(m.lastInstallKind, undefined);
  assert.equal(m.bandOfInstall.size, 0);
  assert.deepEqual(m.notes, []);
});

test("a note added for the new take is kept even when it arrives before anything else noticed the take started over", () => {
  const m = new TakeMemory();
  m.add(1, note(1, "old take"));
  const restarted = m.add(2, note(2, "Learning started 6 s after the agent began."));
  assert.equal(restarted, true, "the add noticed the restart");
  assert.deepEqual(m.notes.map((n) => n.text), ["Learning started 6 s after the agent began."], "the old take's note went, the new one stayed");
  assert.equal(m.sync(2), false, "a later frame finds nothing left to clear");
  assert.deepEqual(m.notes.map((n) => n.text), ["Learning started 6 s after the agent began."]);
});

test("notes within one take accumulate in order and are capped", () => {
  const m = new TakeMemory();
  for (let i = 0; i < 70; i++) m.add(1, note(i, `n${i}`));
  assert.equal(m.notes.length, 60);
  assert.equal(m.notes[0]!.text, "n10");
  assert.equal(m.notes.at(-1)!.text, "n69");
});
