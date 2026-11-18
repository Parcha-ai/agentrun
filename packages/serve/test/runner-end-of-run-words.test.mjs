// The runner's end-of-run step reads a turn the cap refused by the cap's own words, and keeps the server's request id for
// its turn (turns.ts REFLECT_REQUEST), so a run's timeline tells its rows apart as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REFLECT_REQUEST } from "../dist/turns.js";
import { reflectRequestId } from "../dist/runner/end-of-run.js";

test("a turn the cap refused is read by the cap's own words", async () => {
  const { CAP_REFUSAL_PREFIX } = await import("../dist/cap.js");
  const { CAP_REFUSAL } = await import("../dist/runner/reflect-hook.js");
  assert.equal(CAP_REFUSAL.source, CAP_REFUSAL_PREFIX.source);
});

test("the turn's request id is the server's", () => {
  assert.equal(reflectRequestId("run-1"), `${REFLECT_REQUEST}run-1`);
});
