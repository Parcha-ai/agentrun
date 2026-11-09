// B2c red 1b: pi through the adapter, a tool that is not replay-safe interrupted while it runs (its intent flushed, the
// runner shutting down: the loop's interrupt, not a crash) ends interrupted when another runner resumes the run, and
// never runs twice. The flush before the tool runs is the kernel's rule before a side effect on the shared host-tool
// path (side-effects.ts): without it the intent can still be unstored when the shutdown seals the journal, and the
// resume would run the tool again.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { callsOf, journalRecords } = await import("../dist/runner/journal-reader.js");
// A lease no stall of a loaded machine outlasts: runner-a hands the run over by closing (its release), never by a lease
// that ran out, and a claim lost mid-call would give the run a third claim this test does not read.
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");

const RUN = "run-1";
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

async function until(check, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("pi through the adapter: a tool that is not replay-safe, interrupted after its flushed intent, ends interrupted on the resume and never runs twice", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-pi-interrupt-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [server];
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => undefined);
    for (const store of stores.reverse()) await store.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Interrupt" }, { id: "rev-1", kind: "agentic", body: { instructions: "Follow the script." } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" });

  // The rule's order, seen from the store: every flush notes whether the call's intent (pi's execute checkpoint on its
  // tool task) was stored when it was asked for. The tool notes, when it runs, whether such a flush came before it.
  const intentStored = async () => {
    const row = await server.runs.get(RUN);
    const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
    return records.tasks.some((task) => task.kind === "pi.tool" && task.state?.checkpoint?.phase === "execute");
  };
  let flushedAfterIntent = false;
  let ranAfterFlush;

  // The first run of `once` holds until its call is cut off; a second run (the bug) would answer at once.
  let runs = 0;
  let started = () => {};
  const inFlight = new Promise((resolve) => (started = resolve));
  const tools = {
    once: {
      name: "once",
      replaySafe: false,
      ask: false,
      run: async (_args, signal) => {
        runs += 1;
        if (runs > 1) return "ran again";
        ranAfterFlush = flushedAfterIntent;
        started();
        await new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
        return "cut";
      },
    },
  };
  const script = [{ call: "once" }, { say: "done" }];
  const start = async (name, { spy = false } = {}) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    if (spy) {
      const flush = store.flush.bind(store);
      store.flush = async () => {
        if (!flushedAfterIntent && (await intentStored())) flushedAfterIntent = true;
        return flush();
      };
    }
    const runner = startRunner({ store, createLoop: createAdapterLoop(piAdapterSpec({ script, tools, hooks: quiet })), name, ...STEADY });
    runners.push(runner);
    return runner;
  };

  const first = await start("runner-a", { spy: true });
  await inFlight;
  assert.equal(ranAfterFlush, true, "the store was flushed after the call's intent was stored and before the tool ran");
  await first.close();
  await start("runner-b");
  const row = await until(async () => {
    const current = await server.runs.get(RUN);
    return current.state === "ended" && current.runner === null && current;
  }, "the run ended and released");

  // Claimed (1), released at the first runner's shutdown (2), claimed by the second (3), released at the end (4).
  assert.equal(row.epoch, 4, "the second runner resumed it under its own claim, then released it");
  assert.equal(runs, 1, "the tool ran once: the resume never ran it again");
  const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  assert.deepEqual(callsOf(records).map((call) => [call.tool, call.status]), [["once", "interrupted"]]);
});
