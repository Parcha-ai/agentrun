// pi through the adapter loop: a loop that fails before its journal is sealed (pi's Harness could not open) ends the run
// failed, with why, after one claim. The adapter loop's twin of runner-loop-failed: the runner stores a failure it is
// told by a throw, so a loop that returned "failed" without writing the run's end left it running, claimed over and over.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** `journal` with every read refused, as a store that cannot be read: pi's Harness cannot open on it. */
const unreadable = (journal) =>
  new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return key === "stage" ? value.bind(target) : () => Promise.reject(new Error("the run's harness could not open"));
    },
  });

test("pi through the adapter: a loop that cannot open ends the run failed, with why, after one claim", async (t) => {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const { tools } = suiteTools();
  const inner = piAdapterSubject.createLoop({ script: [{ say: "done" }], tools, hooks: quiet });
  const createLoop = (deps) => inner({ ...deps, journal: (claim) => unreadable(deps.journal(claim)) });
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "failed" && now.runner === null && now;
  }, "the run failed and released", 5_000).catch(async (error) => {
    throw new Error(`${error.message}: the run is ${JSON.stringify(await opened.server.runs.get("run-1"))}, claimed ${record.claims.length} times`);
  });
  assert.match(row.summary ?? "", /the run's harness could not open/, "the run says why");
  await sleep(TIMING.pollMs * 10);
  assert.equal(record.claims.filter((claim) => claim.runId === "run-1").length, 1, "claimed once, never again");
});
