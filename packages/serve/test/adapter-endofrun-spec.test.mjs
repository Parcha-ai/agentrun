// The end-of-run step a run's spec supplies (AdapterRunSpec.endOfRun), on the adapter loop through a real runner: the
// spec's step wins over the loop's deps' (LoopDeps.endOfRun), and runs where the deps' one does, in the end turn while
// the claim is held: before a tool host's beforeRelease, before the run's release (AdapterRunSpec.release), and with its
// rows in the end's commit. The spec builders hold the run's per-claim resources (its Archil claim among them), so a
// step built over them is the spec's. With no step on the spec the deps' runs; with neither, none.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
// One runner, never meant to lose its claim: a lease no stall outlasts.
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
/** How long the run's release may take after the row reads ended. */
const RELEASE_MS = 5_000;
after(closeOpenSessions);

/** Run-1 of agent-1 through a real runner on the adapter loop: its spec gets `onSpec` (an endOfRun, a beforeRelease, a
 *  release), the loop's deps `deps`. Resolves with the run's row and learning kept once it ended and, when the spec has
 *  a release, once that release has run. The row reads ended with no runner at the end's commit (an ending patch clears
 *  the runner), and the loop calls the spec's release after it, when it closes the session, so reading the order on the
 *  row alone races the release. */
async function runWith(t, { onSpec = {}, deps = {} }) {
  let released;
  const releaseDone = new Promise((resolve) => (released = resolve));
  if (onSpec.release) {
    const release = onSpec.release;
    onSpec = { ...onSpec, release: async () => { try { await release(); } finally { released(); } } };
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-endofrun-spec-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Ends" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const spec = piAdapterSpec({ script: [{ say: "The job's answer." }], tools: {}, hooks: quiet });
  const createLoop = (loopDeps) => createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", ...onSpec }))({ ...loopDeps, ...deps });
  runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) {
      if (onSpec.release) {
        let bound;
        await Promise.race([releaseDone, new Promise((_, reject) => (bound = setTimeout(() => reject(new Error(`run-1's release (AdapterRunSpec.release) did not run within ${RELEASE_MS} ms of its end`)), RELEASE_MS)))]).finally(() => clearTimeout(bound));
      }
      return { row, kept: await server.learning.proposal("run-1") };
    }
    if (Date.now() > deadline) throw new Error(`run-1 did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** An end-of-run step named `who` that records its call in `order` and keeps a drop beside the end. */
const stepOf = (who, order) => async (input) => {
  order.push(`${who} endOfRun (${input.outcome})`);
  return { also: [{ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason: "empty", detail: who } } }] };
};

test("a spec's end-of-run step runs in the end turn, before the tool host's release and the run's release, its rows in the end; the deps' is not asked", async (t) => {
  const order = [];
  const { row, kept } = await runWith(t, {
    onSpec: {
      endOfRun: stepOf("spec", order),
      lifecycle: { beforeRelease: [async () => order.push("beforeRelease")] },
      release: async () => order.push("release"),
    },
    deps: { endOfRun: stepOf("deps", order) },
  });
  assert.equal(row.state, "ended");
  assert.deepEqual(order, ["spec endOfRun (completed)", "beforeRelease", "release"], "the spec's step, then the host's release, then the run's");
  assert.equal(kept?.proposal?.detail, "spec", "the spec's step's row is kept with the end");
});

test("with no step on the spec, the deps' end-of-run step runs", async (t) => {
  const order = [];
  const { kept } = await runWith(t, { onSpec: { release: async () => order.push("release") }, deps: { endOfRun: stepOf("deps", order) } });
  assert.deepEqual(order, ["deps endOfRun (completed)", "release"]);
  assert.equal(kept?.proposal?.detail, "deps");
});

test("with neither, no end-of-run step runs and nothing is kept", async (t) => {
  const order = [];
  const { row, kept } = await runWith(t, { onSpec: { release: async () => order.push("release") } });
  assert.equal(row.state, "ended");
  assert.deepEqual(order, ["release"]);
  assert.ok(!kept, "no learning kept");
});
