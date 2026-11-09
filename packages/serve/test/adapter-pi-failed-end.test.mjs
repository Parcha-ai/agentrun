// pi through the adapter loop: a loop that fails while its journal still takes a commit writes the run's end with why,
// in that commit (the adapter loop's twin of runner-loop-failed-end). The loop's own read at the turn's end fails (a busy
// store) after the answer was stored: the run ends failed, its agentrun.end entry says the store's words, and it is
// claimed once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { observed, queue, recorder, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
// A lease no missed renew lets lapse within the case: its property is the failed end and no claim after it, and a claim
// lost before the end (a starved box) would hand the run to a second claim for a reason that is not the end's.
const TIMING = { leaseMs: 30_000, renewEveryMs: 150, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** `journal` whose entry scans fail as a busy store's would once the model's answer is stored (a commit wrote a
 *  pi.assistant entry): the session opened and the turn ran, and the loop's own read at the turn's end fails. */
const scansRefused = (journal) => {
  let answered = false;
  return new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "commit") {
        return (batches, ...rest) => {
          if (batches.some((batch) => batch.some((write) => write.type === "entry" && write.value?.kind === "pi.assistant"))) answered = true;
          return value.call(target, batches, ...rest);
        };
      }
      if (key === "scanEntries") {
        return (...args) => (answered ? Promise.reject(new Error("the store stayed locked past its busy timeout")) : value.apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

test("pi through the adapter: a loop that fails while its journal still takes a commit writes the run's end with why", async (t) => {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const { tools } = suiteTools();
  const inner = piAdapterSubject.createLoop({ script: [{ say: "done" }], tools, hooks: quiet });
  const createLoop = (deps) => inner({ ...deps, journal: (claim) => scansRefused(deps.journal(claim)) });
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "failed" && now.runner === null && now;
  }, "the run failed and released", 30_000).catch(async (error) => {
    throw new Error(`${error.message}: the run is ${JSON.stringify(await opened.server.runs.get("run-1"))}, claimed ${record.claims.length} times`);
  });
  assert.match(row.summary ?? "", /busy timeout/, "the run's row says why");
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const end = entries.find((entry) => entry.kind === "agentrun.end");
  assert.ok(end, `the journal holds the run's end: ${JSON.stringify(entries.map((entry) => entry.kind))}`);
  assert.equal(end.data?.state, "failed", "its end says failed");
  assert.match(String(end.data?.summary ?? ""), /busy timeout/, "its end says why");
  // Never claimed again: the failed end made the run final (its end is its release), so it is not claimable; and it was
  // claimed once to get there.
  assert.ok(!(await opened.server.runs.claimable({ limit: 100 })).includes("run-1"), "a final run is not claimable");
  assert.equal(record.claims.filter((claim) => claim.runId === "run-1").length, 1, "claimed once");
});
