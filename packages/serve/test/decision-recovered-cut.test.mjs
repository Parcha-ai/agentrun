// A completed run's decision rows are read back from its store (pi durableDecisions), so what the row keeps of a receipt
// is what the graph serves: a decision's error stored cut at 64 KB (error_truncated) must stay marked, or its tail, where
// a held value the cut split sits, is shown.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { decisionRecovery, durableDecisions } from "@parcha/agentrun-pi/durable";
import { servedPart } from "../dist/graph-served.js";

/** A held value of 512 characters, made at runtime: no credential-shaped literal for the source export. */
const HELD = ["not-a-secret", "x".repeat(499)].join("-");
const holdsRun = (text) => {
  for (let i = 0; i + 8 <= HELD.length; i++) if (text.includes(HELD.slice(i, i + 8)) && !"x".repeat(8).includes(HELD.slice(i, i + 8))) return true;
  return false;
};

test("a decision error cut at 64 KB with a held value across the cut, read back from the run's store: marked cut, and served with no part of it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "decision-cut-")), "run.sqlite");
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, ctx);
  // As the DSL stores it: the first 64 KB of a provider's error that repeats the value, the cut inside a copy.
  const error = `refused ${`${HELD} `.repeat(130)}`.slice(0, 65_536);
  const receipt = {
    v: 1, id: "d1", at: "2026-11-05T00:00:00.000Z", node: "check", kind: "judge", item: null, execution_path: "/root/steps/0", request: { index: 0, count: 1 }, status: "failed",
    state_sha256: "f".repeat(64), questions: {}, answers: {}, rule: null, action: null, model: null, usage: null, cost_usd: null, request_sha256: null, latency_ms: 3,
    state: { text: "x" }, state_truncated: false, error, error_truncated: true,
  };
  try {
    await decisionRecovery({ key: "run-1", runtime: { commit: (change, context) => harness.commit(change, context), snapshot: (...args) => harness.snapshot(...args) }, context: ctx }).recordDecision(receipt, { request: { state: { text: "x" }, questions: {} } });
  } finally {
    await harness.close(ctx);
  }
  const [row] = durableDecisions(file);
  assert.equal(row.error, error);
  assert.equal(row.error_truncated, true, "the row keeps the receipt's mark");
  assert.equal(row.state_truncated, false);
  // As graph-view.ts passes a row on: its error_truncated as error_cut.
  const shown = servedPart("decision", { id: row.decision_id, status: row.status, error: row.error, ...(row.error_truncated === true ? { error_cut: true } : {}) }, [HELD]);
  assert.ok(!holdsRun(JSON.stringify(shown)), JSON.stringify(shown.error.slice(-80)));
});
