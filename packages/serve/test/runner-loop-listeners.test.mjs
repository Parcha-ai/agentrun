// A loop leaves nothing on its claim's signal once it ends (from #1933's Greptile thread on pi-durable-disk's live
// events, declined there because the cutover deletes that path): every abort listener pi's loop (the adapter loop and the pi
// adapter) adds on deps.signal is
// removed when start() settles, ended or parked alike, so a runner that holds many loops over its life gains none.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { suiteTools } from "../dist/runner/conformance/harness.js";
import { after } from "node:test";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";

after(closeOpenSessions);
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };

async function runOnce(t, script, endState) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-loop-listeners-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Listeners" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const signals = [];
  const { tools } = suiteTools();
  const inner = piAdapterSubject.createLoop({ script, tools, hooks: quiet });
  runner = startRunner({ store, createLoop: (deps) => (signals.push(deps.signal), inner(deps)), name: "runner-a", ...TIMING });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === endState && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end ${endState}: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(signals.length, 1, "one loop");
  return signals[0];
}

test("a pi loop that ended leaves no abort listener on its claim's signal", async (t) => {
  const signal = await runOnce(t, [{ call: "read" }, { say: "done" }], "ended");
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("a pi loop that parked on an ask leaves no abort listener on its claim's signal", async (t) => {
  const signal = await runOnce(t, [{ call: "asked" }, { say: "done" }], "parked");
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
