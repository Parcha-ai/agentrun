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
// A lease no stall of a loaded machine outlasts: a claim lost and retaken gives the run a second claim's signal, which
// these tests do not read. The runs end themselves, so nothing here waits on the lease.
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

/** `journal` whose commit of the run's end returns `ms` after it landed: a loaded machine, where the loop's teardown
 *  runs late after the end commit, which is the run's release (the row reads released before the loop has settled). */
const endReturnsLate = (journal, ms) =>
  new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "commit") return typeof value === "function" ? value.bind(target) : value;
      return async (batches, ...rest) => {
        const result = await value.call(target, batches, ...rest);
        if (batches.flat().some((write) => write.type === "entry" && write.value?.kind === "agentrun.end")) await new Promise((resolve) => setTimeout(resolve, ms));
        return result;
      };
    },
  });

async function runOnce(t, script, endState, { endLateMs } = {}) {
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
  const journalOf = (deps) => (endLateMs ? { ...deps, journal: (claim) => endReturnsLate(deps.journal(claim), endLateMs) } : deps);
  runner = startRunner({ store, createLoop: (deps) => (signals.push(deps.signal), inner(journalOf(deps))), name: "runner-a", ...TIMING });
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

test("a pi loop that ended leaves no abort listener on its claim's signal, its teardown late (a loaded machine)", async (t) => {
  const signal = await runOnce(t, [{ call: "read" }, { say: "done" }], "ended", { endLateMs: 1_500 });
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("a pi loop that parked on an ask leaves no abort listener on its claim's signal", async (t) => {
  const signal = await runOnce(t, [{ call: "asked" }, { say: "done" }], "parked");
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
