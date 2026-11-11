// A paid tool call its runner lost mid-call is booked at the next claim's open as a charge of an unknown amount, never
// read as free (#2300): the call may have run and been charged before the claim was lost. Its paid-tools session opens
// only for a paid call of the claim that makes one, and a call that is not rerun (one not replay-safe ends interrupted;
// one the gate refuses on its rerun) makes none, so the next claim opens that session for the cut alone: its hold
// counted for the cap, its cost unknown, a "charged an unknown amount" row. pi through the adapter loop on the runner,
// the claim lost by killing its runner while the paid request is out; no clock but the lease's.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { paidRequest, parallelSearchFee } = await import("../dist/paid-calls.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const EVENT_WAIT_MS = 30_000;
after(closeOpenSessions);

test("a paid call its runner lost mid-call, never rerun, is booked at the next claim as a charge of an unknown amount: the run's cost reads unknown, never $0", { timeout: 120_000 }, async (t) => {
  const { server, runners: [one, two], clock } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const work = [];
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  // A paid search that is not replay-safe: its hold is booked before it is sent, then it hangs until the claim is lost,
  // so the next claim ends it interrupted and never runs it again.
  const tools = {
    search: {
      name: "search", replaySafe: false, ask: false,
      run: async () => {
        work.push("started");
        // Sent once its hold is booked and flushed (paidOn admits it first): the claim is lost from here.
        const answer = await paidRequest(parallelSearchFee(1), async () => (work.push("sent"), await held, new Response("{}", { status: 200 })));
        return answer.status;
      },
    },
  };
  const script = [{ call: "search", args: { q: "agentrun" } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, []) });
  const loop = createAdapterLoop(base);
  const runners = [startRunner({ store: one, createLoop: loop, name: "runner-a", ...TIMING })];
  t.after(async () => {
    release();
    await Promise.all(runners.map((runner) => runner.close()));
  });
  await until(() => work.includes("sent"), "the paid call is sent, its hold booked", EVENT_WAIT_MS);
  runners[0].kill();
  clock.skewMs = TIMING.leaseMs * 2;
  runners.push(startRunner({ store: two, createLoop: createAdapterLoop(base), name: "runner-b", ...TIMING }));
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end", EVENT_WAIT_MS);
  assert.deepEqual(work, ["started", "sent"], "the call ran once, on the lost claim");

  // The paid-tools session's one request is booked cut, at no known figure.
  const entries = (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
  const key = entries.find((entry) => entry.kind === "agentrun.session.key" && entry.data?.key === "paid-tools");
  assert.ok(key, "the paid call opened the paid-tools session");
  const conv = Number(key.data.conversation);
  const turns = entries.filter((entry) => Number(entry.conversationId) === conv && entry.kind === "runner.turn").map((entry) => entry.data);
  assert.deepEqual(turns.map((turn) => [turn.cut === true, turn.usd ?? null]), [[true, null]], `booked once, cut, its charge unknown: ${JSON.stringify(turns)}`);

  // Its run's cost is unknown, the call counted as one charge not priced, and its row says an unknown amount.
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.equal(view.cost.usd, null, `the run's cost is unknown, never $0: ${JSON.stringify(view.cost)}`);
  assert.ok(view.cost.unpriced >= 1, `the cut call is a charge not priced: ${JSON.stringify(view.cost)}`);
  const charge = (await runTimeline(server, "run-1", BACKGROUND_CONTEXT, { settled: true })).filter((one) => one.kind === "phase" && /^Tool cost:/.test(one.summary ?? ""));
  // The test's tool books under its fee's own name (paid:Parallel's search), as a paid request names it.
  assert.deepEqual(charge.map((one) => one.summary), ["Tool cost: parallel charged an unknown amount for Parallel's search"], "its row: an unknown amount");
});
