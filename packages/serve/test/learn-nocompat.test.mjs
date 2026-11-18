// What an older server wrote is not read: the learning reasons it alone gave, and its run pin.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as learning from "../dist/learning.js";

test("the learning reasons are this server's own: no older server's no_write_tool, tool_denied, screen or screen_down", () => {
  for (const old of ["no_write_tool", "tool_denied", "screen", "screen_down"]) assert.ok(!learning.LEARNING_REASONS.includes(old), old);
  assert.equal(learning.LEGACY_LEARNING_REASONS, undefined, "no list of older reasons is kept");
});

test("no run pin is read: a run's learning comes from its seed alone", () => {
  assert.equal(learning.withLearned, undefined);
  assert.equal(learning.LEARNING_PIN, undefined);
});
