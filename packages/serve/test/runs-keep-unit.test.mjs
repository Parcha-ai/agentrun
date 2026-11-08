// The live path's keep (runs.ts keepCommitted): a row a committed entry made stays served though a later snapshot no
// longer holds it (the timeline only grows), but a row only the served view makes is never kept: each is tagged where
// show() makes it (served-only.ts: a pause's waiting row, the harness's install row, the learning row), and goes once
// show() stops making it. By its tag, never its name: a row made the same way under any id is refused too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withLearning } from "../dist/learning-run.js";
import { installRow, keepCommitted, withPaused } from "../dist/runs.js";
import { servedOnly, servedOnlyIds } from "../dist/served-only.js";

const AT = "2026-11-07T05:00:00.000Z";
const ROW = { timestamp: AT, created_at: AT, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null };
const SHOWN = { text: (text) => text, name: (name) => name, holds: () => false };

test("the live path's keep holds a committed row, never one show() made: a pause's waiting row, the install row, the learning row, and one under an id no rule names", () => {
  const refusal = { ...ROW, id: "1:12:note", kind: "phase", summary: "Paused at the run's cap", text: "Paused at the run's cap", paused: true };
  const made = [
    ...withPaused([refusal]).filter((row) => row.id !== refusal.id),
    installRow({ at: AT, words: "Installing Claude Code (first use)…" }),
    ...withLearning([], { state: "dropped", reason: "no_budget", detail: null, at: AT }, SHOWN),
    servedOnly({ ...ROW, id: "a-row-of-tomorrow", kind: "phase", summary: "Made by the view" }),
  ];
  // Every id the view made comes from its maker, not typed here.
  assert.deepEqual(made.map((row) => row.id).sort(), ["1:12:paused", "a-row-of-tomorrow", "harness:installing", "learning"]);
  const keep = keepCommitted(new Set(), [], () => false, servedOnlyIds([refusal, ...made]));
  assert.deepEqual(
    ["1:12", refusal.id, ...made.map((row) => row.id)].map((id) => [id, keep(id)]),
    [["1:12", true], [refusal.id, true], ...made.map((row) => [row.id, false])],
  );
});
