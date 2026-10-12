// live's --robot-thread-deadline-s: absent is the default, a number from 30 to 3600 is taken, and a missing value or any other value is refused up front.
import assert from "node:assert/strict";
import { test } from "node:test";
import { threadDeadlineArg } from "../live-args.ts";

test("absent is no setting; a whole number of seconds from 30 to 3600 is taken", () => {
  assert.equal(threadDeadlineArg(["--episode", "robot"]), undefined);
  assert.equal(threadDeadlineArg(["--robot-thread-deadline-s", "300", "--ttl", "40"]), 300);
  assert.equal(threadDeadlineArg(["--robot-thread-deadline-s", "30"]), 30);
  assert.equal(threadDeadlineArg(["--robot-thread-deadline-s", "3600"]), 3600);
});

test("a trailing flag with no value, or one followed by another flag, is an error, not the 20-minute default", () => {
  assert.throws(() => threadDeadlineArg(["--episode", "robot", "--robot-thread-deadline-s"]), /needs a value/);
  assert.throws(() => threadDeadlineArg(["--robot-thread-deadline-s", "--ttl", "40"]), /needs a value/);
});

test("out of range and non-integer values are errors that name the value", () => {
  for (const bad of ["10", "4000", "five", "1.5", ""]) assert.throws(() => threadDeadlineArg(["--robot-thread-deadline-s", bad]), /a whole number of seconds from 30 to 3600/);
});
