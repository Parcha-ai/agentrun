// The kernel's rule on a pi run through the adapter (runner/side-effects.ts, on the host-tool path): a call that is not replay-safe runs only after a flush made its
// intent durable (pi committed it, at synchronous=NORMAL not yet on disk); a replay-safe call runs without one. Read from
// the order the loop's flush and the tool itself happen in, on a real store and runner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { after } from "node:test";
import { closeOpenSessions, piAdapterSpec, piAdapterSubject, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { STEADY_LEASE } from "./runner-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");

after(closeOpenSessions);
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
// A lease no stall of a loaded machine outlasts: a claim lost mid-call is retaken and the call's flush runs again, which
// these tests do not read. The runs end themselves, so nothing here waits on the lease.
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };

/** `fetch` (the provider's, behind pi's session proxy) whose first model request blocks the process for `ms` before it
 *  goes, as a starved machine does: no renew runs meanwhile, so a lease shorter than the stall runs out with the request
 *  out. */
const stalledOnce = (fetch, ms, once) => (...args) => {
  if (!once.stalled) {
    once.stalled = true;
    const until = Date.now() + ms;
    while (Date.now() < until);
  }
  return fetch(...args);
};

async function order(t, tool, { stallMs = 0 } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-loop-flush-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flush" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const seen = [];
  const run = async () => (seen.push(tool), `${tool} ran`);
  const tools = {
    effect: { name: "effect", replaySafe: false, ask: false, run },
    read: { name: "read", replaySafe: true, ask: false, run },
  };
  const script = [{ call: tool }, { say: "done" }];
  // One stall for the whole run, whichever claim's session makes the first request.
  const once = { stalled: false };
  const inner = stallMs
    ? createAdapterLoop(piAdapterSpec({ script, tools, hooks: quiet }, { fetch: stalledOnce(scriptedOrigin(script), stallMs, once) }))
    : piAdapterSubject.createLoop({ script, tools, hooks: quiet });
  const createLoop = (deps) => inner({ ...deps, flush: async () => (seen.push("flush"), deps.flush()) });
  runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return seen;
}

// Both runs make the same model requests, each after a flush of its own (runner-loop-model-flush), so the call's own
// flush is the difference between them: one more for the effect, right before it; none for the read.
test("a call that is not replay-safe runs after a flush; a replay-safe one runs without", async (t) => {
  const effect = await order(t, "effect");
  const read = await order(t, "read");
  const flushes = (seen) => seen.filter((what) => what === "flush").length;
  assert.equal(effect[effect.indexOf("effect") - 1], "flush", `the effect waited for its intent to be durable: ${JSON.stringify(effect)}`);
  assert.equal(flushes(effect), flushes(read) + 1, `the replay-safe read needed no flush of its own: ${JSON.stringify({ effect, read })}`);
});

// The same rule read on a machine that stalls while the first model request is out (CI's 4-for-3: a claim lost to the
// stall, the run retaken, and the unanswered request asked again after a flush of its own). The runs hold a lease no
// such stall outlasts, so the order read is the rule's, not the stall's.
test("the call's flush rule reads the same when the machine stalls 1.5 s while the effect run's first model request is out", async (t) => {
  const effect = await order(t, "effect", { stallMs: 1_500 });
  const read = await order(t, "read");
  const flushes = (seen) => seen.filter((what) => what === "flush").length;
  assert.equal(effect[effect.indexOf("effect") - 1], "flush", `the effect waited for its intent to be durable: ${JSON.stringify(effect)}`);
  assert.equal(flushes(effect), flushes(read) + 1, `the replay-safe read needed no flush of its own: ${JSON.stringify({ effect, read })}`);
});
