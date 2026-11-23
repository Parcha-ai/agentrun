// A run's end waits for its census (RunnerOptions.census, up to censusMs) before it writes, and its claim is renewed
// while it waits: a census slower than the lease still lands the end, so a failed run reads failed, never unfinished and
// claimed again. Renewal stops once the end write has landed: no renew races the release of a run already ended. A
// claim that only ends its run (endRetried, a run stopped before it started) is renewed the same way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCommand } from "../dist/runner/commands.js";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, queue, sleep, stores } from "./runner-support.mjs";

// A lease of 400 ms renewed every 100 ms, lost 100 ms before it runs out; a census of 1,200 ms is three leases.
const SHORT_LEASE = { leaseMs: 400, renewEveryMs: 100, stopMarginMs: 100, pollMs: 20, commandPollMs: 50 };
const CENSUS_MS = 1_200;
// How long the release after the end is held back, so a renew after the end landed would be seen.
const RELEASE_HELD_MS = 600;

/** A loop that throws at its start: the runner ends the run failed itself (endRun), census first. */
const failingLoop = () => ({
  start: async () => {
    throw new Error("the loop failed");
  },
  command: async () => ({ refused: "not in this test" }),
  stop: async () => {},
});

/** Runs `run-1` to its end under a census that takes CENSUS_MS (it counts nothing), with the runner's store's renewMany
 *  watched (when each renew of run-1 was asked) and its release held back RELEASE_HELD_MS. `landedAt` is the first time
 *  the server's store read the run final (polled every 10 ms, so at or after the end landed). With `stopFirst`, a stop is
 *  sent before the runner starts: its claim only ends the run (endRetried), stopped, with no loop. `createLoop` is the
 *  run's loop: by default one that throws at its start, so the runner ends the run itself. */
async function slowCensusEnd(t, { stopFirst = false, createLoop = failingLoop } = {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  if (stopFirst) await sendCommand(opened.server, "run-1", { kind: "stop" });
  const store = opened.runners[0];
  const renews = [];
  const renewMany = store.renewMany.bind(store);
  store.renewMany = async (claims, options) => {
    if (claims.some((claim) => claim.runId === "run-1")) renews.push(Date.now());
    return renewMany(claims, options);
  };
  const release = store.release.bind(store);
  store.release = async (claim, options) => {
    await sleep(RELEASE_HELD_MS);
    return release(claim, options);
  };
  const events = [];
  const census = () => new Promise((resolve) => setTimeout(() => resolve(undefined), CENSUS_MS));
  const runner = startRunner({ store, createLoop, name: "runner-a", census, censusMs: 5_000, onEvent: (event) => events.push({ ...event, at: Date.now() }), ...SHORT_LEASE });
  t.after(() => runner.close());
  let landedAt;
  const until = Date.now() + 10_000;
  while (Date.now() < until && !events.some((event) => event.runId === "run-1" && (event.type === "released" || (event.type === "error" && /fenced/.test(event.step))))) {
    if (landedAt === undefined && ["failed", "stopped", "ended"].includes((await opened.server.runs.get("run-1"))?.state)) landedAt = Date.now();
    await sleep(10);
  }
  return { opened, events, renews, landedAt };
}

for (const [name, stopFirst, state] of [["a failed run's end", false, "failed"], ["the end of a run stopped before it started (a claim that only ends it)", true, "stopped"]]) {
  test(`a census slower than the lease still lands ${name}: the claim is renewed while the end waits for it`, { timeout: 20_000 }, async (t) => {
    const { opened, events } = await slowCensusEnd(t, { stopFirst });
    const fenced = events.filter((event) => event.runId === "run-1" && event.type === "error" && /fenced/.test(event.step));
    assert.deepEqual(fenced.map((event) => event.step), [], "no write of the end was fenced");
    const run = await opened.server.runs.get("run-1");
    assert.equal(run.state, state, JSON.stringify(run));
  });
}

// The loop's own end (its end commit, which waits for the census beside it while the loop still holds its claim), the
// runner's end of a failed run, and the end of a claim that only ends its run.
const ENDS = [
  ["a run's own end (its loop's end commit)", { createLoop: () => fauxLoops({ turns: 1, turnMs: 10 }).createLoop }],
  ["a failed run's end", {}],
  ["the end of a run stopped before it started", { stopFirst: true }],
];
for (const [name, options] of ENDS) {
  test(`once ${name} lands, its claim is renewed no more`, { timeout: 20_000 }, async (t) => {
    const { events, renews, landedAt } = await slowCensusEnd(t, { ...options, ...(options.createLoop ? { createLoop: options.createLoop() } : {}) });
    assert.ok(landedAt !== undefined, "the run's end landed");
    assert.ok(events.some((event) => event.runId === "run-1" && event.type === "released"), "and the run was released");
    // Any renew timer still armed fires a few more times.
    await sleep(SHORT_LEASE.renewEveryMs * 4);
    assert.ok(renews.some((at) => at < landedAt), `renewed while its end waited (${renews.length} renews)`);
    assert.deepEqual(renews.filter((at) => at > landedAt), [], "no renew of the run after its end landed");
  });
}
