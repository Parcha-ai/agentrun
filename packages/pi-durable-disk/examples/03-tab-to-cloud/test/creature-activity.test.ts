import assert from "node:assert/strict";
import { test } from "node:test";
import { creatureActivity } from "../tab/creature-activity.ts";

test("the creature page is paused only while a model really loads, and goes on when loading ends in any way", () => {
  assert.deepEqual(creatureActivity({ brainLoading: true, phase: undefined, localModelAnswering: false }), { paused: true, low: false }, "files coming home");
  assert.deepEqual(creatureActivity({ brainLoading: false, phase: "loading", localModelAnswering: false }), { paused: true, low: false }, "the model is loading");
  assert.deepEqual(creatureActivity({ brainLoading: false, phase: "loaded", localModelAnswering: false }), { paused: true, low: false }, "loaded, answering its first question");
  assert.deepEqual(creatureActivity({ brainLoading: false, phase: "answered", localModelAnswering: false }), { paused: false, low: false }, "ready: the pane goes on");
  assert.deepEqual(creatureActivity({ brainLoading: false, phase: "failed", localModelAnswering: false }), { paused: false, low: false }, "a failed load does not leave the pane frozen");
  assert.deepEqual(creatureActivity({ brainLoading: false, phase: undefined, localModelAnswering: false }), { paused: false, low: false }, "a base finished downloading while the agent trains: a status line, no loading");
});

test("low rate while the local model generates, never on top of a pause", () => {
  assert.deepEqual(creatureActivity({ brainLoading: false, phase: "answered", localModelAnswering: true }), { paused: false, low: true });
  assert.deepEqual(creatureActivity({ brainLoading: true, phase: "loading", localModelAnswering: true }), { paused: true, low: false });
});
