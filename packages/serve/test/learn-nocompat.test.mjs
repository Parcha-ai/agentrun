// What an older server wrote is not read: the learning reasons it alone gave, and a pin's index-only `learned` field.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as learning from "../dist/learning.js";

test("the learning reasons are this server's own: no older server's no_write_tool, tool_denied, screen or screen_down", () => {
  for (const old of ["no_write_tool", "tool_denied", "screen", "screen_down"]) assert.ok(!learning.LEARNING_REASONS.includes(old), old);
  assert.equal(learning.LEGACY_LEARNING_REASONS, undefined, "no list of older reasons is kept");
});

test("a pin with only an older server's index-only `learned` field gives the run no # Learned section", async (t) => {
  const runDir = mkdtempSync(join(tmpdir(), "nocompat-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  mkdirSync(join(runDir, "work"), { recursive: true });
  writeFileSync(join(runDir, learning.LEARNING_PIN ?? "learning.json"), JSON.stringify({ seed: "a".repeat(40), learned: "- check-units.md: Check units" }));
  const { instructions } = await learning.withLearned(runDir, join(runDir, "work"), "Answer.");
  assert.ok(!instructions.includes("# Learned"), instructions);
  assert.ok(!instructions.includes("check-units"), instructions);
});
