// A run queued through a store in this process is claimed at once (store.watchCommands' "queued" wake), not at the
// runner's next poll: a runner beside its server (the CLI start, the template eval) used to leave every new run waiting
// up to a whole poll (1 s), most of what came before the vendor's create on a desktop run. The poll still finds what the
// wake cannot reach (a run another process queued). Each runner here polls once a minute, so only a wake claims within
// the test's bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, release, sleep, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 60_000, commandPollMs: 20 };

/** `store` (observed: the runner's part of it) with its claimMany counted, and each of its returns held until `gate` (when
 *  set) resolves: the store is asked first, so a held return is a poll that has read the runs and not yet ended. */
function counted(store) {
  const seen = { claimMany: 0, gate: undefined };
  const port = observed(store, recorder());
  const claimMany = async (...args) => {
    const claims = await port.runs.claimMany(...args);
    seen.claimMany += 1;
    if (seen.gate) await seen.gate;
    return claims;
  };
  return { store: { ...port, runs: { ...port.runs, claimMany } }, seen };
}

test("a run queued on the server's store is claimed at once, not at the runner's next poll", { timeout: 30_000 }, async () => {
  const faux = fauxLoops({ turns: 1, turnMs: 5 });
  const opened = await stores();
  const { store, seen } = counted(opened.runners[0]);
  const claimed = [];
  const runner = startRunner({ store, createLoop: faux.createLoop, name: "runner-a", onEvent: (event) => event.type === "claimed" && claimed.push(event.claim), ...TIMING });
  try {
    // Its start's poll found nothing; the next is a minute away.
    await until(() => seen.claimMany === 1, "the start's poll");
    await queue(opened.server, "run-1");
    await until(() => claimed.length === 1, "the queued run claimed by the wake", 5_000);
    assert.deepEqual(claimed.map(({ runId, epoch }) => [runId, epoch]), [["run-1", 1]]);
  } finally {
    await runner.close();
    await release(opened);
  }
});

test("a run queued while the runner's poll is in flight is claimed as that poll ends, not a poll later", { timeout: 30_000 }, async () => {
  const faux = fauxLoops({ turns: 1, turnMs: 5 });
  const opened = await stores();
  const { store, seen } = counted(opened.runners[0]);
  let open = () => {};
  seen.gate = new Promise((resolve) => (open = resolve));
  const claimed = [];
  const runner = startRunner({ store, createLoop: faux.createLoop, name: "runner-a", onEvent: (event) => event.type === "claimed" && claimed.push(event.claim), ...TIMING });
  try {
    // The start's poll has read the runs (none) and is still in flight when the run is queued: its wake finds a poll going.
    await until(() => seen.claimMany === 1, "the start's poll reading the runs");
    await queue(opened.server, "run-1");
    await sleep(20);
    seen.gate = undefined;
    open();
    await until(() => claimed.length === 1, "the run queued mid-poll claimed once that poll ended", 5_000);
    assert.equal(seen.claimMany, 2, "one more poll, at once");
  } finally {
    await runner.close();
    await release(opened);
  }
});

test("a closed runner claims nothing on a wake", { timeout: 30_000 }, async () => {
  const faux = fauxLoops({ turns: 1, turnMs: 5 });
  const opened = await stores();
  const { store, seen } = counted(opened.runners[0]);
  const runner = startRunner({ store, createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  try {
    await until(() => seen.claimMany === 1, "the start's poll");
    await runner.close();
    await queue(opened.server, "run-1");
    await sleep(50);
    assert.equal(seen.claimMany, 1, "no poll after the close");
    assert.equal((await opened.server.runs.get("run-1")).state, "queued");
  } finally {
    await release(opened);
  }
});
