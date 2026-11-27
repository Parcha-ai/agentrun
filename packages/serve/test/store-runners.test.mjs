// Each runner's word that it is there (store `runners`, runner/presence.ts) and the runs no runner here can take
// (Runs.failUnclaimed), on either store: a row is kept per runner and fenced by its incarnation, a row no runner renewed
// for a day goes at the next put, the server reads a refusal only while every runner still there refused, and the runs
// still queued fail in its words while a run a runner claimed is left to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepPresence, refusedEnd, refusedEndMessage, runnersRefused } from "../dist/runner/presence.js";
import { RUNNER_ROWS_KEPT_MS, RUNNER_STALE_MS } from "../dist/store/store.js";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const WORDS = "AGENTRUN_RUN_USER=bogus is not a setting this runner knows: set AGENTRUN_RUN_USER=same.";

test("a runner's row is its incarnation's: renewed and removed only by it, put again by a new one, gone a day after its last word", async (t) => {
  const clock = { now: T0 };
  const { store } = await storeOn(t, { clock });
  assert.equal(await store.runners.put({ runner: "r1", incarnation: "a", refused: null }), true);
  assert.deepEqual(await store.runners.list(), [{ runner: "r1", incarnation: "a", refused: null, host: null, port: null, seenAt: T0, version: null, slots: null, knows: null }], "a runner with no relay answers nowhere");
  clock.now = T0 + 5_000;
  assert.equal(await store.runners.renew("r1", "a", null), true);
  assert.equal(await store.runners.renew("r1", "b", { host: "x", port: 2 }), false, "another incarnation's renewal is not this one's");
  assert.deepEqual((await store.runners.list()).map((row) => [row.seenAt, row.host]), [[T0 + 5_000, null]]);
  // A new start of the same name takes the row over, with its relay; the earlier one's remove leaves it.
  await store.runners.put({ runner: "r1", incarnation: "b", refused: WORDS, host: "r1.example", port: 40_000 });
  await store.runners.remove("r1", "a");
  assert.deepEqual(await store.runners.list(), [{ runner: "r1", incarnation: "b", refused: WORDS, host: "r1.example", port: 40_000, seenAt: T0 + 5_000, version: null, slots: null, knows: null }]);
  // A put with no relay clears where it answered.
  await store.runners.put({ runner: "r1", incarnation: "b", refused: WORDS });
  assert.deepEqual((await store.runners.list()).map((row) => [row.host, row.port]), [[null, null]]);
  await store.runners.remove("r1", "b");
  assert.deepEqual(await store.runners.list(), []);
  // A runner that died without its close: its row goes at a put past RUNNER_ROWS_KEPT_MS, never before.
  await store.runners.put({ runner: "dead", incarnation: "x", refused: WORDS });
  clock.now = T0 + 5_000 + RUNNER_ROWS_KEPT_MS;
  await store.runners.put({ runner: "r2", incarnation: "y", refused: null });
  assert.deepEqual((await store.runners.list()).map((row) => row.runner), ["dead", "r2"]);
  clock.now += 1;
  await store.runners.put({ runner: "r2", incarnation: "y", refused: null });
  assert.deepEqual((await store.runners.list()).map((row) => row.runner), ["r2"]);
});

test("no runner can take a run only while every runner still there refused, and one at least is there", async (t) => {
  const clock = { now: T0 };
  const { store } = await storeOn(t, { clock });
  // Every time here is the store's clock (T0, years from this process's): rows are stamped and judged by it alone, so a
  // runner on another host whose clock is behind the server's still counts.
  const at = (ms) => T0 + ms;
  assert.equal(await runnersRefused(store.runners), undefined, "no runner yet: runs queue for one to come");
  await store.runners.put({ runner: "refuses", incarnation: "1", refused: WORDS });
  assert.equal(await runnersRefused(store.runners), `No runner of this server can take a run: ${WORDS}`, "judged on the store's clock, not this process's");
  await store.runners.put({ runner: "refuses-too", incarnation: "1", refused: WORDS });
  assert.equal(await runnersRefused(store.runners), `No runner of this server can take a run: ${WORDS}`, "the same words once");
  await store.runners.put({ runner: "claims", incarnation: "1", refused: null });
  assert.equal(await runnersRefused(store.runners), undefined, "one runner that claims is enough");
  // The runner that claims stops saying it is there (it died): past RUNNER_STALE_MS it no longer counts.
  clock.now = at(RUNNER_STALE_MS);
  await store.runners.renew("refuses", "1", null);
  await store.runners.renew("refuses-too", "1", null);
  clock.now = at(RUNNER_STALE_MS + 1);
  assert.equal(await runnersRefused(store.runners), `No runner of this server can take a run: ${WORDS}`);
  // And refusing runners that died count for nothing either: no runner is there.
  clock.now = at(2 * RUNNER_STALE_MS + 1);
  assert.equal(await runnersRefused(store.runners), undefined);
});

// The store's runners as keepPresence writes them, each write held until settled() has seen it land: a renewal's tick
// starts a write (and, when its row went, a put after it), and settled() waits for every one, never for a wall-clock time.
function tracked(runners) {
  const open = new Set();
  const track = (write) => (...args) => {
    const landed = write(...args);
    open.add(landed);
    landed.then(() => open.delete(landed), () => open.delete(landed));
    return landed;
  };
  return {
    runners: { ...runners, put: track(runners.put), renew: track(runners.renew), remove: track(runners.remove) },
    // A tick only queues its write behind the one before (writing.then), so each round first lets what is queued start
    // (setImmediate is real here: only setInterval is mocked), then waits for every write started; done when none is.
    async settled() {
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (open.size === 0) return;
        await Promise.allSettled([...open]);
      }
    },
  };
}

const RENEW_MS = 50;

test("keepPresence keeps its row renewed and puts it back when it went; its close removes it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { store } = await storeOn(t, { clock: { now: Date.now() } });
  const writes = tracked(store.runners);
  const presence = keepPresence(writes.runners, "kept", WORDS, { renewMs: RENEW_MS });
  t.after(() => presence.stop());
  await writes.settled();
  const [row] = await store.runners.list();
  assert.deepEqual({ runner: row.runner, refused: row.refused }, { runner: "kept", refused: WORDS });
  // Gone from under it (a row pruned): put again at its next renewal, its own incarnation.
  await store.runners.remove(row.runner, row.incarnation);
  t.mock.timers.tick(RENEW_MS - 1);
  await writes.settled();
  assert.deepEqual(await store.runners.list(), [], "no renewal before renewMs");
  t.mock.timers.tick(1);
  await writes.settled();
  assert.deepEqual((await store.runners.list()).map((kept) => [kept.runner, kept.incarnation]), [["kept", row.incarnation]]);
  await presence.close();
  assert.deepEqual(await store.runners.list(), []);
});

test("keepPresence's incarnation is the one it is given, its relay's: relay() says on its row where the relay answers, a renewal and a re-put keep it, relay(null) clears it, and the close removes the row", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { store } = await storeOn(t, { clock: { now: Date.now() } });
  const writes = tracked(store.runners);
  const presence = keepPresence(writes.runners, "relaying", null, { renewMs: RENEW_MS, incarnation: "inc-given" });
  t.after(() => presence.stop());
  assert.equal(presence.incarnation, "inc-given");
  await presence.relay({ host: "127.0.0.1", port: 40_000 });
  const pick = (rows) => rows.map((row) => [row.runner, row.incarnation, row.host, row.port]);
  assert.deepEqual(pick(await store.runners.list()), [["relaying", "inc-given", "127.0.0.1", 40_000]]);
  // A renewal over its own row: the relay's place stays.
  t.mock.timers.tick(RENEW_MS);
  await writes.settled();
  assert.deepEqual(pick(await store.runners.list()), [["relaying", "inc-given", "127.0.0.1", 40_000]]);
  // Gone from under it: put again at its next renewal, its relay's place with it.
  await store.runners.remove("relaying", "inc-given");
  t.mock.timers.tick(RENEW_MS);
  await writes.settled();
  assert.deepEqual(pick(await store.runners.list()), [["relaying", "inc-given", "127.0.0.1", 40_000]]);
  // Its relay's close: the row stays (the runner is still there), answering nowhere.
  await presence.relay(null);
  assert.deepEqual(pick(await store.runners.list()), [["relaying", "inc-given", null, null]]);
  await presence.close();
  assert.deepEqual(await store.runners.list(), []);
});

test("keepPresence never takes back a row a later process of the same name put: the later one's relay is the one the server reads", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { store } = await storeOn(t, { clock: { now: Date.now() } });
  const earlier = keepPresence(store.runners, "same", null, { renewMs: RENEW_MS, incarnation: "inc-earlier" });
  t.after(() => earlier.stop());
  // relay() resolves once its write landed, after the first put.
  const at = { host: "127.0.0.1", port: 40_000 };
  await earlier.relay(at);
  // The later one renews only after the test's end, so no renewal of its own puts the row back in between.
  const later = keepPresence(store.runners, "same", null, { renewMs: 60_000, incarnation: "inc-later" });
  t.after(() => later.stop());
  await later.relay({ host: "127.0.0.1", port: 40_001 });
  for (let i = 0; i < 10; i += 1) t.mock.timers.tick(RENEW_MS);
  // Its relay's write goes after the ten renewals' writes, so once it landed they all did.
  await earlier.relay(at);
  assert.deepEqual((await store.runners.list()).map((row) => [row.incarnation, row.port]), [["inc-later", 40_001]], "ten renewals of the earlier one later, the row is still the later one's");
});

test("an earlier process's relay close and its presence's close leave a later process's row of the same name as it is: its relay is still read", async (t) => {
  const { store } = await storeOn(t, { clock: { now: Date.now() } });
  const earlier = keepPresence(store.runners, "same", null, { renewMs: 60_000, incarnation: "inc-earlier" });
  t.after(() => earlier.stop());
  await earlier.relay({ host: "127.0.0.1", port: 40_000 });
  const later = keepPresence(store.runners, "same", null, { renewMs: 60_000, incarnation: "inc-later" });
  t.after(() => later.stop());
  await later.relay({ host: "127.0.0.1", port: 40_001 });
  // The earlier process stops as runner/main.ts stops one: its relay says it answers nowhere, then its presence closes.
  await earlier.relay(null);
  await earlier.close();
  assert.deepEqual((await store.runners.list()).map((row) => [row.incarnation, row.host, row.port]), [["inc-later", "127.0.0.1", 40_001]], "the later one's row and relay stand");
});

test("put unlessLiveMs puts a row where none is, or over its own or a stale one, and leaves another incarnation's live row as it is; a put without it takes the row", async (t) => {
  const clock = { now: T0 };
  const { store } = await storeOn(t, { clock });
  const unlessLive = { unlessLiveMs: 30_000 };
  assert.equal(await store.runners.put({ runner: "r", incarnation: "inc-a", refused: null }, unlessLive), true, "no row: put");
  // inc-a's row is older than now, and still within the 30 s.
  clock.now += 29_999;
  assert.equal(await store.runners.put({ runner: "r", incarnation: "inc-b", refused: null, host: "h", port: 1 }, unlessLive), false, "inc-a's live row: left");
  assert.deepEqual((await store.runners.list()).map((row) => [row.incarnation, row.host]), [["inc-a", null]]);
  assert.equal(await store.runners.put({ runner: "r", incarnation: "inc-a", refused: WORDS }, unlessLive), true, "its own: put");
  assert.equal((await store.runners.list())[0].refused, WORDS);
  clock.now += 30_001;
  assert.equal(await store.runners.put({ runner: "r", incarnation: "inc-b", refused: null, host: "h", port: 1 }, unlessLive), true, "inc-a's row went stale: taken");
  assert.equal((await store.runners.list())[0].seenAt, clock.now, "seen at the store's now");
  assert.deepEqual((await store.runners.list()).map((row) => [row.incarnation, row.host, row.port]), [["inc-b", "h", 1]]);
  clock.now += 1;
  assert.equal(await store.runners.renew("r", "inc-a", { host: "x", port: 2 }), false, "a renewal on another incarnation's row writes nothing");
  assert.equal(await store.runners.renew("r", "inc-b", { host: "h2", port: 3 }), true);
  assert.deepEqual((await store.runners.list()).map((row) => [row.incarnation, row.host, row.port, row.seenAt]), [["inc-b", "h2", 3, clock.now]], "a renewal says where the relay answers now, seen now");
  assert.equal(await store.runners.renew("r", "inc-b", null), true);
  assert.deepEqual((await store.runners.list()).map((row) => [row.incarnation, row.host, row.port]), [["inc-b", null, null]]);
  // A first put (no unlessLiveMs) takes the name over from a live row of another incarnation.
  assert.equal(await store.runners.put({ runner: "r", incarnation: "inc-c", refused: null }), true);
  assert.deepEqual((await store.runners.list()).map((row) => row.incarnation), ["inc-c"]);
});

test("failUnclaimed fails every run still queued in the words given, refusing its untaken commands, and leaves a claimed run to its runner", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-queued");
  await queued(store, "run-claimed");
  await store.command("run-queued", { kind: "steer", body: { content: "and this" } });
  const claim = await store.claim("run-claimed", "runner-a", { leaseMs: 60_000 });
  assert.ok(claim);
  const summary = refusedEnd(`No runner of this server can take a run: ${WORDS}`);
  assert.deepEqual(await store.runs.failUnclaimed(summary), ["run-queued"]);
  const failed = await store.runs.get("run-queued");
  assert.equal(failed.state, "failed");
  assert.equal(failed.summary, summary);
  assert.equal(refusedEndMessage(failed.summary), `No runner of this server can take a run: ${WORDS}`);
  assert.equal(failed.endedAt, T0);
  assert.equal(failed.epoch, 1, "its epoch moved on, as an end's does");
  const commands = (await store.commandsOf([{ runId: "run-queued", after: 0 }])).get("run-queued");
  assert.equal(commands.length, 1);
  assert.notEqual(commands[0].refused, null, "its untaken command is refused with its end");
  const held = await store.runs.get("run-claimed");
  assert.equal(held.state, "running", "a run a runner claimed is its runner's");
  assert.equal(held.epoch, claim.epoch);
  assert.deepEqual(await store.runs.failUnclaimed(summary), [], "nothing left to fail");
  assert.equal(refusedEndMessage("run failed"), undefined);
});
