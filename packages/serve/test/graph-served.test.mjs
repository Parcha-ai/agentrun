// What the graph serves of each part (graph-served.ts): redacted by the run's answer's rule, then cut, a text stored cut
// with its tail held back.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as served from "../dist/graph-served.js";

const KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
const holdsRun = (text) => {
  for (let i = 0; i + 8 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 8))) return true;
  return false;
};

test("a decision's error stored cut at 2000 (a row from before) with a held key across the cut: served with no part of it", () => {
  assert.equal(typeof served.servedPart, "function", "graph-served.ts serves a part");
  // What the DSL stored before: the error cut at 2000, the key's first 20 characters at its end.
  const stored = `judge provider failed: ${"x".repeat(2000 - 23 - 20)}${KEY} more`.slice(0, 2000);
  const shown = served.servedPart("decision", { id: "dec-1", status: "failed", state: { text: "x" }, state_truncated: false, error: stored }, [KEY]);
  assert.ok(!holdsRun(JSON.stringify(shown)), JSON.stringify(shown.error.slice(-40)));
  assert.equal(shown.error_cut, undefined, "no marker served");
});

test("a decision's error marked error_truncated, and an effect's marked error_cut, the same: no part of the key", () => {
  const long = `refused ${`${KEY} `.repeat(2000)}`.slice(0, 65_536);
  const decision = served.servedPart("decision", { id: "dec-2", status: "failed", error: long, error_truncated: true }, [KEY]);
  const effect = served.servedPart("effect", { tool: "llm", status: "failed", error: long, error_cut: true }, [KEY]);
  for (const part of [decision, effect]) {
    assert.ok(!holdsRun(JSON.stringify(part)), JSON.stringify(part.error.slice(-60)));
    assert.ok(part.error.length <= 2000, String(part.error.length));
  }
});
