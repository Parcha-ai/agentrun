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

// The whole served view (servedGraphView): every field cut, its parts once each and the rest once per content, so a poll
// that reads the same graph again with the same held values walks nothing. Counted (graphWalks), never timed.
const HELD = "not-a-secret-graph-walk-0123456789";
/** A graph view as graph-view.ts runGraph answers it, the held value in its workflow, its structure, a part and a field
 *  of its own added later. */
const viewOf = (readAt = "2026-11-09T00:00:00.000Z") => ({
  read_at: readAt,
  run: { id: "run-1", agent: "a1", revision: "r1", status: "completed", paused: false, startedAt: "2026-11-09T00:00:00.000Z", endedAt: null },
  workflow: { v: 2, name: "w", root: { node: "escalate", label: `gate ${HELD}`, summary: `needs ${HELD}` } },
  graph: { nodes: [{ path: "/root", kind: "escalate", label: `gate ${HELD}` }] },
  nodes: { "/root": { status: "done", items: [{ index: 0, status: "done", executionPath: "/root/items/0", label: `item ${HELD}` }] } },
  decisions: [{ id: "d1", state: `state ${HELD}` }],
  effects: [{ tool: "llm", output: { text: `said ${HELD}` } }],
  totals: { cost_usd: 0, decisions: 1, effects: 1, elapsed_ms: 10 },
  later: { words: `added later ${HELD}` },
});

test("the served graph view is cut whole, its parts once each and the rest once per content: a second read with the same held set walks nothing", () => {
  const cache = new served.PartCache(served.GRAPH_CACHE_BYTES);
  served.graphWalks.part = 0;
  served.graphWalks.rest = 0;
  const first = served.servedGraphView(viewOf(), [HELD], cache);
  assert.ok(!JSON.stringify(first).includes(HELD), JSON.stringify(first));
  assert.equal(first.workflow.root.summary, "needs [redacted]");
  assert.equal(first.later.words, "added later [redacted]", "a field added later is cut");
  assert.deepEqual(first.run, viewOf().run, "the run's own facts pass as they are");
  // Each part walked once (its nodes, its one decision, its one call); the rest's fields once each, the parts never again.
  assert.deepEqual({ ...served.graphWalks }, { part: 3, rest: 5 }, "run, workflow, graph, totals and later, once each");
  // The same graph again (a poll), its read time moved: nothing is walked again.
  const again = served.servedGraphView(viewOf("2026-11-09T00:00:05.000Z"), [HELD], cache);
  assert.deepEqual({ ...served.graphWalks }, { part: 3, rest: 5 }, "a second read walks nothing");
  assert.equal(again.read_at, "2026-11-09T00:00:05.000Z");
  assert.deepEqual({ ...again, read_at: first.read_at }, first);
  // A held set that changed (a key saved since) is a new set: walked again, and the new value cut.
  const later = "not-a-secret-saved-later-9876543210";
  const view = viewOf();
  view.graph.nodes[0].label = `gate ${HELD} ${later}`;
  const third = served.servedGraphView(view, [HELD, later], cache);
  assert.ok(!JSON.stringify(third).includes(later) && !JSON.stringify(third).includes(HELD));
  assert.ok(served.graphWalks.part > 3 && served.graphWalks.rest > 5, JSON.stringify(served.graphWalks));
});
