// What the adapter-pi-cap tests share: one pi run through the adapter loop (runner/adapter-loop.ts, pi's model through the
// session's proxy to a scripted origin) under the host's check before each paid request (the spend cap's
// beforeRequestOf), run until the run is no longer running, with every ask and every request that reached the provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
/** The kernel cap, not exported from its package until the cutover: read from its build. */
export const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
export const { beforeRequestOf } = cap;

export const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
/** capRun's one runner: a lease no stall of a loaded machine outlasts. A claim lost mid-request would be retaken and its
 *  request read with no answer (held, not booked), which these money checks do not read; the runs end themselves. The
 *  short TIMING stays for the cases that kill a runner and wait for its lease to run out. */
export const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
export const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** The suite's model as the cap prices it: Sonnet's list price. */
export const SONNET = Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 });
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A store with one queued run, a runner on the adapter loop running `script` on the run's one cap of `runCap` (the kernel
 *  runCap's options), until the run is not running or `ms` passes. `asked`: each request the cap judged, with its answer;
 *  `sent`: each body the provider got. */
export async function capRun(t, { script, runCap, cap: parkCap, specOf, during, journalOf, ms = 20_000 }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-cap-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Cap" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const asked = [];
  const sent = [];
  // `specOf(sent)`: a test's own spec (a priced model, its own origin), else the suite's on the script.
  const spec = specOf ? specOf(sent) : piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch: scriptedOrigin(script, sent) });
  const loop = createAdapterLoop(async (claim, run) => ({
    ...(await spec(claim, run)),
    ...(parkCap ? { cap: parkCap } : {}),
    // The run's one cap, built by the loop from these options: each request it judged is recorded with its answer.
    runCap: { ...runCap, judged: (request, answer) => void asked.push({ request, answer }) },
  }), { restartLimit: MAX_RESTARTS });
  // `journalOf(journal)`: the claim's journal as the loop sees it (a test's commit hook), else the store's own.
  const createLoop = journalOf ? (deps) => loop({ ...deps, journal: (claim) => journalOf(deps.journal(claim)) }) : loop;
  runner = startRunner({ store, createLoop, name: "runner-a", ...STEADY });
  // `during(server)`: what a test does while the run runs (a person's stop once a request is out), awaited before the read.
  const acting = during ? during(server) : undefined;
  acting?.catch(() => undefined);
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.state !== "running" && row.state !== "queued" && row.runner === null) break;
    if (Date.now() - from > ms) break;
    await sleep(20);
  }
  await acting;
  return { row, asked, sent, ms: Date.now() - from, server, store };
}

/** The run's cap as a loop spec carries it (what E2 fills from the run's launch): its figure and the kernel's park. */
export const specCap = (capUsd) => ({ capUsd, park: (refusal) => cap.parkOf(refusal, capUsd) });

/** The data of each root entry of `kind` in run-1's journal, read under a reader's claim at the run's epoch. */
export async function rootEntries(store, kind) {
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const root = await harness.root(ctx);
    const out = [];
    for (let cursor; ; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, ctx);
      for (const entry of page.items) if (entry.kind === kind) out.push(entry.data);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return out;
  } finally {
    await harness.close(ctx);
  }
}
