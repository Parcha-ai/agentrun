import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyStory, plainSwitch, simulationNote, storyNotes, visibleTag } from "../page/story-notes.ts";
import { emptyState } from "../reduce.ts";
import type { Place } from "../types.ts";

const at = (place: Place) => ({ ...emptyState(), place });
const here: Place = { where: "tab", host: "your browser" };
const moving: Place = { where: "moving", to: "H100 GPU", host: "your browser" };
const away: Place = { where: "cloud", host: "H100 GPU" };
const home: Place = { where: "home", host: "your browser" };


test("coming back claims training succeeded only when a trained brain has arrived, and says it once", () => {
  const story = emptyStory();
  storyNotes(at(moving), story, 1);
  storyNotes(at(away), story, 2);
  assert.deepEqual(storyNotes(at(moving), story, 3), [], "still on the way: not home yet");
  assert.deepEqual(storyNotes(at(home), story, 4), [], "back, but nothing trained has arrived: no claim that training is done");
  assert.deepEqual(storyNotes(at(home), story, 5), []);
  story.trained = true;
  assert.deepEqual(storyNotes(at(home), story, 6).map((n) => n.text), ["Done training. The agent came back to your browser, and so did what it learned."]);
  assert.deepEqual(storyNotes(at(home), story, 7), [], "said once");
});

test("an early return does not use up the success line: a trained brain that arrives later still gets it", () => {
  const story = emptyStory();
  storyNotes(at(away), story, 1);
  storyNotes(at(home), story, 2);
  story.trained = true;
  assert.equal(storyNotes(at(home), story, 3).length, 1);
});

test("a trained brain that arrives before the run is home waits for it, and one with no trip says nothing", () => {
  const story = emptyStory();
  storyNotes(at(away), story, 1);
  story.trained = true;
  assert.deepEqual(storyNotes(at(moving), story, 2), []);
  assert.equal(storyNotes(at(home), story, 3).length, 1);
  const never = emptyStory();
  never.trained = true;
  assert.deepEqual(storyNotes(at(home), never, 1), [], "it never went anywhere: nothing came back");
});

test("a run that never left says nothing about coming back, and these lines are plain notes with no number to tag", () => {
  const story = emptyStory();
  assert.deepEqual(storyNotes(at(home), story, 1), []);
  const all = [...storyNotes(at(moving), emptyStory(), 1), ...(() => { const s = emptyStory(); storyNotes(at(away), s, 1); s.trained = true; return storyNotes(at(home), s, 2); })()];
  assert.ok(all.every((n) => n.measured === undefined && n.basis === undefined && !/\d/.test(n.text)));
});

test("the creature is said to be a physics simulation in your browser, once, at the start", () => {
  const n = simulationNote(5);
  assert.equal(n.text, "The creature is a physics simulation running in your browser.");
  assert.equal(n.at, 5);
});

test("the clean view draws no tag pill at all (the viewer read MEASURED as a staged label); ?debug=1 keeps every one", () => {
  const all = ["measured", "reported", "scripted", "unmeasured", "agent", "simulated"] as const;
  for (const t of all) assert.equal(visibleTag(t, false), null, t);
  for (const t of all) assert.equal(visibleTag(t, true), t, t);
  assert.equal(visibleTag(null, false), null);
});

test("the stage's own captions outrank the tab's chatter when they arrive together", () => {
  const story = emptyStory();
  storyNotes(at(away), story, 2);
  story.trained = true;
  assert.equal(storyNotes(at(home), story, 3)[0]!.rank, 2);
  assert.equal(simulationNote(4).rank, 1);
});

test("a page that opens after the agent has come back knows it went away from the run's own record of where it stayed", () => {
  const stay = (host: string, hostKind: "tab" | "gpu") => ({ id: host, lane: "run", host, hostKind, from: 0, to: null });
  const back = { ...at(home), stays: [stay("your browser", "tab"), stay("H100 GPU", "gpu"), stay("your browser", "tab")] };
  const story = emptyStory();
  assert.deepEqual(storyNotes(back, story, 1), [], "no trained brain yet");
  story.trained = true;
  assert.equal(storyNotes(back, story, 2).length, 1);
  const stayedHome = { ...at(home), stays: [stay("your browser", "tab")] };
  const other = emptyStory();
  other.trained = true;
  assert.deepEqual(storyNotes(stayedHome, other, 1), [], "it never left");
});

import { wentAway } from "../page/story-notes.ts";

test("whether the agent went away is read from where it is and from the run's own record of where it stayed", () => {
  const stay = (host: string, hostKind: "tab" | "gpu") => ({ id: host, lane: "run", host, hostKind, from: 0, to: null });
  assert.equal(wentAway(at(moving)), true);
  assert.equal(wentAway(at(away)), true);
  assert.equal(wentAway({ ...at(home), stays: [stay("your browser", "tab"), stay("H100 GPU", "gpu"), stay("your browser", "tab")] }), true, "home again, and the record shows a machine");
  assert.equal(wentAway({ ...at(home), stays: [stay("your browser", "tab")] }), false, "it never left");
  assert.equal(wentAway(at(home)), false);
});

// Cold view 6: "Switched to This tab in 1138 ms (timed by the server)" read as a contradiction beside "offline". In the clean view it is said as what happened.
test("the pipe's switch line is said in plain words in the clean view: seconds, and home is your browser", () => {
  const n = (text: string) => ({ at: 1, kind: "switch" as const, text, measured: true });
  assert.equal(plainSwitch(n("Switched to This tab in 1138 ms (timed by the server).")).text, "Came home to your browser in 1.1 s");
  assert.equal(plainSwitch(n("Switched to your browser in 900 ms (timed by the server).")).text, "Came home to your browser in 0.9 s");
  assert.equal(plainSwitch(n("Switched to H100 GPU in 822 ms (timed by the server).")).text, "Moved to the H100 GPU in 0.8 s");
  assert.equal(plainSwitch(n("Switched to This tab in 1138 ms (timed by the server).")).measured, true, "it is still the server's measurement");
  const other = { at: 1, kind: "home" as const, text: "Back in your browser in 0.9 s." };
  assert.equal(plainSwitch(other), other, "any other note is left alone");
  const refused = n("Switch to H100 GPU refused: no.");
  assert.equal(plainSwitch(refused), refused);
});
