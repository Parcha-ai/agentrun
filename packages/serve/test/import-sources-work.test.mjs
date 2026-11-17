import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSession } from "../dist/import-sources.js";

const message = (role, content) => ({ type: "response_item", payload: { type: "message", role, content } });
const context = { type: "turn_context", payload: { model: "fixture-model", effort: "high" } };
async function rollout(t, records) {
  const dir = await mkdtemp(join(tmpdir(), "import-codex-work-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "rollout-fixture.jsonl");
  await writeFile(file, [
    { type: "session_meta", payload: { id: "fixture-session", cwd: "/fixture/project", model_provider: "fixture" } },
    ...records,
  ].map((record, i) => JSON.stringify({ ...record, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() })).join("\n") + "\n");
  return file;
}

test("current Codex keeps adjacent, middle and trailing user turns in order, with the same metadata in a listing", async t => {
  const file = await rollout(t, [
    message("user", "First question."), message("user", "More context."), context,
    message("assistant", "Checking."),
    { type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "read", arguments: '{"file":"fixture"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "Tool result." } },
    message("user", "Follow-up."), context, message("assistant", "Final answer."),
    message("user", "Unanswered question."), message("user", "Last context."),
  ]);
  const full = await readSession(file, "codex");
  assert.deepEqual(full.turns.map(({ role, text }) => [role, text]), [
    ["user", "First question."], ["user", "More context."], ["assistant", "Checking."],
    ["toolResult", "Tool result."], ["user", "Follow-up."], ["assistant", "Final answer."],
    ["user", "Unanswered question."], ["user", "Last context."],
  ]);
  assert.deepEqual([full.id, full.cwd, full.model, full.effort, full.users, full.firstPrompt, full.titleText],
    ["fixture-session", "/fixture/project", "fixture/fixture-model", "high", 5, "First question.", "First question."]);
  assert.deepEqual(full.turns[2].calls, [{ type: "toolCall", id: "call-1", name: "read", arguments: { file: "fixture" } }]);
  const { turns: _turns, effort: _effort, ...metadata } = full;
  assert.deepEqual(await readSession(file, "codex", { turns: false }), { ...metadata, turns: [] });
});

test("legacy Codex user_message events remain authoritative even when first seen after held response messages", async t => {
  const file = await rollout(t, [
    message("user", "Response copy of first question."),
    { type: "event_msg", payload: { type: "user_message", message: "First question." } },
    context, message("assistant", "First answer."),
    message("user", "Response copy of next question."),
    { type: "event_msg", payload: { type: "user_message", message: "Next question." } },
    context, message("assistant", "Next answer."),
  ]);
  const full = await readSession(file, "codex");
  assert.deepEqual(full.turns.map(({ role, text }) => [role, text]), [
    ["user", "First question."], ["assistant", "First answer."], ["user", "Next question."], ["assistant", "Next answer."],
  ]);
  const listing = await readSession(file, "codex", { turns: false });
  assert.equal(full.users, 2);
  assert.equal(listing.users, 2);
  assert.equal(listing.firstPrompt, "First question.");
  assert.equal(listing.titleText, "First question.");
  assert.deepEqual(listing.turns, []);
});

test("a large current Codex transcript does not repeatedly shift its tail when restoring user messages", async t => {
  const count = 4000;
  const records = [], expected = [];
  for (let i = 0; i < count; i++) {
    records.push(context, message("user", `Question ${i}`), message("assistant", `Answer ${i}`));
    expected.push(["user", `Question ${i}`], ["assistant", `Answer ${i}`]);
  }
  const file = await rollout(t, records);
  // Count moved elements instead of elapsed time: this catches quadratic transcript reconstruction without a
  // machine-dependent timing threshold. Other array edits are permitted within a linear work allowance.
  const splice = Array.prototype.splice;
  let shifted = 0, full;
  Array.prototype.splice = function (...args) {
    if (args.length > 2) {
      const start = args[0] < 0 ? Math.max(this.length + args[0], 0) : Math.min(args[0], this.length);
      shifted += Math.max(0, this.length - start - Math.max(0, args[1]));
    }
    return Reflect.apply(splice, this, args);
  };
  try { full = await readSession(file, "codex"); }
  finally { Array.prototype.splice = splice; }
  assert.deepEqual(full.turns.map(({ role, text }) => [role, text]), expected);
  assert.equal(full.users, count);
  assert.ok(shifted <= expected.length * 8, `${shifted} shifted elements exceeds the linear reconstruction allowance`);
});
