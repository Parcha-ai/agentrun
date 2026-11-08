// A runner claims a queued run, keeps the claim while it lives and loses it when it dies (design: "Runners carry many
// loops"; the claim epoch is the one fence). Two runners on one store, one queued run: exactly one claims it. The holder
// renews, so the other never takes it while it lives. Killed (frozen: no renew, no release), its claim runs out and the
// other reclaims it with epoch + 1, and the dead runner's late journal commit is refused (Fenced).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, sleep, storeDouble, until } from "./runner-support.mjs";

const LEASE_MS = 400;
const TIMING = { leaseMs: LEASE_MS, renewEveryMs: 100, stopMarginMs: 150, pollMs: 20, commandPollMs: 20 };

function runners(t, store, createLoop) {
  const started = ["runner-a", "runner-b"].map((name) => startRunner({ store, createLoop, name, ...TIMING }));
  t.after(() => Promise.all(started.map((runner) => runner.close())));
  return started;
}

test("two runners, one queued run: exactly one claims it, and keeps it while it renews", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  await store.runs.create("run-1");
  runners(t, store, faux.createLoop);

  await until(() => store.claims.length > 0, "a claim");
  // Three leases long: a holder that renews is never reclaimed.
  await sleep(LEASE_MS * 3);
  assert.equal(store.claims.length, 1, JSON.stringify(store.claims));
  assert.equal(store.claims[0].epoch, 1);
  assert.equal(faux.loops.length, 1, "one loop runs the run");
  const run = await store.runs.get("run-1");
  assert.deepEqual([run.state, run.epoch, run.runner], ["running", 1, store.claims[0].runner]);
  assert.ok(run.claimedUntil > Date.now(), "the claim is live: renewed past its first until");
});

test("the holder is killed: the other reclaims after claimed_until with epoch 2, and the dead one's late commit is Fenced", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  await store.runs.create("run-1");
  const [a, b] = runners(t, store, faux.createLoop);

  const first = await until(() => store.claims[0], "a claim");
  const holder = first.runner === a.name ? a : b;
  const other = holder === a ? b : a;
  await until(() => store.commits.some((commit) => commit.epoch === 1), "the holder's loop commits");
  holder.kill();
  const killedAt = Date.now();
  const lastUntil = (await store.runs.get("run-1")).claimedUntil;

  const second = await until(() => store.claims[1], "the reclaim", LEASE_MS * 10);
  assert.deepEqual([second.runner, second.epoch], [other.name, 2]);
  assert.ok(second.at > lastUntil, `reclaimed at ${second.at - killedAt} ms after the kill, before claimed_until (${lastUntil - killedAt} ms)`);

  const dead = faux.loops.find((loop) => loop.claim.epoch === 1);
  await assert.rejects(dead.commitNow(), { name: "Fenced" }, "the dead runner's late commit");
  assert.equal(store.commits.filter((commit) => commit.epoch === 1 && commit.at > second.at).length, 0, "nothing of epoch 1 lands after the reclaim");
  await until(() => store.commits.some((commit) => commit.epoch === 2), "the new holder's loop commits");
  dead.halted = true;
});

test("a run that ends is flushed and released, and never claimed again", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ turns: 2, turnMs: 10 });
  await store.runs.create("run-1");
  const both = runners(t, store, faux.createLoop);

  await until(async () => (await store.runs.get("run-1")).state === "ended", "the run ends");
  await until(async () => (await store.runs.get("run-1")).runner === null, "the release");
  const ops = store.ops.join(" | ");
  assert.match(ops, /ended run-1 \| flush \| release run-1/, "the end commit, then a flush, then the release");
  await sleep(LEASE_MS);
  assert.equal(store.claims.length, 1, "an ended run is final");
  assert.deepEqual(both.flatMap((runner) => runner.held()), [], "no runner holds it");
  assert.deepEqual(await store.runs.claimable({ limit: 10 }), []);
});
