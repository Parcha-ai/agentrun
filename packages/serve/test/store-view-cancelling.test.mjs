// A cancel the API accepted reads `cancelled` from its 202 on, while the runner is still cutting the turn. The view stays
// open until the store holds the run's end: its end time is the real one, its poll hint says keep polling, so the timeline
// is not final and a stream stays open for the tool results, withdrawals and charges that land after the 202.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { viewOverStore } = await import("../dist/store-view.js");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const deps = { origin: "", serverSecrets: () => [] };

async function runningRun() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-cancelling-"));
  dirs.push(dir);
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer.", tools: [] } });
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  return { store, claim };
}

test("a cancel not yet taken reads cancelled but unsettled: no end time, keep polling", async () => {
  const { store } = await runningRun();
  await store.command("run-1", { kind: "cancel" });
  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "cancelled");
  assert.equal(view.ended_at, null, "the runner has not ended the run: no end time yet");
  assert.equal(view.poll_after_ms, 1000, "not settled: a poll or stream stays open");
});

test("once the runner's end commits, the cancelled run is settled with its real end time", async () => {
  const { store, claim } = await runningRun();
  const cancel = await store.command("run-1", { kind: "cancel" });
  await store.runs.update(claim, { state: "stopped", summary: "cancelled", outcome: "cancelled" }, { take: [cancel.id] });
  const view = await viewOverStore(store, "run-1", deps);
  const run = await store.runs.get("run-1");
  assert.equal(view.status, "cancelled");
  assert.equal(view.poll_after_ms, 0);
  assert.equal(view.ended_at, new Date(run.endedAt).toISOString());
});
