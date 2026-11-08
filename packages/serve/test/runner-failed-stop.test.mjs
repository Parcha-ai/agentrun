// A run whose pi loop fails with no end written (pi's Harness could not open) goes final after one claim, never reclaimed
// again and again (the lead's read of #1969, P1-1). A person's stop waiting when the loop fails is the run's end: the run
// ends stopped and its stop row is taken, never refused as "the run failed before this command was taken". A parked run
// brought back by an approve whose resume hits the failure stays parked with a backoff, its approve kept for one more try.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { commandRow, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { sendCommand } = await import("../dist/runner/commands.js");
after(closeOpenSessions);
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** `journal` with every read refused, as a store that cannot be read: pi's Harness cannot open on it. */
const unreadable = (journal) =>
  new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return key === "stage" ? value.bind(target) : () => Promise.reject(new Error("the run's harness could not open"));
    },
  });

/** pi through the adapter loop playing `script`, whose journal cannot be read on the claims `failing(n)` names (n counts
 *  from 1). */
function loops(script, failing) {
  const { tools, ran } = suiteTools();
  const inner = piAdapterSubject.createLoop({ script, tools, hooks: quiet });
  let claims = 0;
  const createLoop = (deps) => {
    const n = ++claims;
    return inner(failing(n) ? { ...deps, journal: (claim) => unreadable(deps.journal(claim)) } : deps);
  };
  return { createLoop, ran };
}

async function running(t, createLoop) {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const start = () => {
    const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
    t.after(() => runner.close());
    return runner;
  };
  return { server: opened.server, record, start };
}

const claimsOf = (record) => record.claims.filter((claim) => claim.runId === "run-1").length;

/** The run's agentrun.end entries, as the journal holds them (read on the server, at the run's epoch). */
async function endsOf(server) {
  const row = await server.runs.get("run-1");
  const journal = server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state });
  const ends = [];
  for (let after = 0; ;) {
    const page = await journal.commitsAfter(after, 100, BACKGROUND_CONTEXT);
    for (const commit of page.commits) {
      for (const entry of commit.entries) if (entry.kind === "agentrun.end") ends.push(entry.data);
      after = commit.seq;
    }
    if (page.next === undefined || page.commits.length === 0) break;
  }
  return ends;
}

test("a stop waiting when the loop fails with no end written ends the run stopped, the stop row taken, after one claim", async (t) => {
  const { createLoop } = loops([{ say: "done" }], () => true);
  const { server, record, start } = await running(t, createLoop);
  const stop = await sendCommand(server, "run-1", { kind: "stop", body: {} });
  start();
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return ["failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run final and released", 5_000);
  assert.deepEqual([row.state, row.summary], ["stopped", "stopped by a person"], "the person's stop is the run's end");
  const taken = await commandRow(server, "run-1", stop.id);
  assert.ok(taken.takenAt !== null, "the stop row is taken");
  assert.equal(taken.refused, null, `the stop is taken, never refused: ${JSON.stringify(taken.refused)}`);
  assert.deepEqual(await endsOf(server), [{ state: "stopped", summary: "stopped by a person" }], "the run's end is in its journal");
  await sleep(TIMING.pollMs * 10);
  assert.equal(claimsOf(record), 1, "claimed once, never again");
});

test("a parked run whose resume keeps failing, then is stopped, ends stopped with its end in its journal (P2-13)", async (t) => {
  const { createLoop } = loops([{ call: "asked" }, { say: "done" }], (n) => n >= 2);
  const { server, record, start } = await running(t, createLoop);
  start();
  await until(async () => (await server.runs.get("run-1")).state === "parked", "the run parked on its ask", 5_000);
  await sendCommand(server, "run-1", { kind: "approve", body: { approval: "the asked call" } });
  await until(async () => (await server.runs.get("run-1")).backoffUntil !== null, "the failed resume's backoff", 5_000);
  const stop = await sendCommand(server, "run-1", { kind: "stop", body: {} });
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "stopped" && now.runner === null && now;
  }, "the stop ends the run", 5_000);
  assert.equal(row.summary, "stopped by a person");
  assert.ok((await commandRow(server, "run-1", stop.id)).takenAt !== null, "the stop row is taken");
  assert.deepEqual(await endsOf(server), [{ state: "stopped", summary: "stopped by a person" }], "the run's end is in its journal");
  assert.ok(claimsOf(record) >= 2);
});

test("a parked run brought back by an approve whose resume fails stays parked with a backoff, its approve kept", async (t) => {
  // Claim 1 parks on the asked call; claim 2 (brought back by the approve) cannot open.
  const { createLoop, ran } = loops([{ call: "asked" }, { say: "done" }], (n) => n === 2);
  const { server, record, start } = await running(t, createLoop);
  start();
  await until(async () => (await server.runs.get("run-1")).state === "parked", "the run parked on its ask", 5_000);
  // Its resume cannot open, so which call the approve names never comes into it.
  const approve = await sendCommand(server, "run-1", { kind: "approve", body: { approval: "the asked call" } });
  await until(() => claimsOf(record) >= 2, "the approve brings the run back", 5_000);
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.runner === null && now.state !== "running" && now;
  }, "the resume released", 5_000);
  assert.equal(row.state, "parked", `never failed: ${JSON.stringify(row)}`);
  assert.ok(row.backoffUntil !== null && row.backoffUntil !== undefined, "released with a backoff");
  assert.equal((await commandRow(server, "run-1", approve.id)).takenAt, null, "the approve is kept for one more try");
  assert.equal(ran.asked, 0, "the asked call never ran");
});
