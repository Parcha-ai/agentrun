// A Mode 2 run's per-run Archil mount credential is removed on EVERY outcome of its claim, through a real runner on the
// adapter loop: the loop's every pass ends in its `finally` (closeSession), which calls the spec's release, and the spec
// builders' release revokes the run's Archil claim (adapter-run-spec.ts and cli-run-spec.ts: archil?.revoke()). Here the
// spec's release revokes a real archilClaim, minted at the spec's build against the no-port control fake
// (archilControlFetch: a fetch function, so nothing on this machine can reach it), as the builders mint theirs:
//   ended, failed, stopped (a person's stop), parked at the cap, parked at an ask, a lost claim (its renews fail) — each
//   leaves the control plane with no token; a park removes it (nothing lives across a park: the resume's claim mints its
//   own, under its epoch);
//   a crash (the runner killed, nothing let go) leaves its token, and the next claim removes it before it mints its own,
//   which the run's end then removes.
// The real builders' release revoking their claim is runner-mode2-root-reads ("... removed at the run's end").
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { archilClaim } from "../dist/workspace/index.js";
import { cap, SONNET } from "./adapter-pi-cap-support.mjs";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { suiteTools, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

after(closeOpenSessions);
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const STEADY = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** The runner a case kills, or whose renews it fails: its lease outlasts a loaded machine's stalls (renewed every 150 ms,
 *  so a living runner never loses it), and runs out a few seconds after the kill or the first failed renew. */
const DIES = { leaseMs: 5_000, renewEveryMs: 150, stopMarginMs: 1_000, pollMs: 20, commandPollMs: 30 };
const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `promise`, or a failure named `what` if it has not settled by `ms`: a bound that names the hang, not a wait. */
function within(promise, what, ms = 20_000) {
  let timer;
  const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/** Polls `check` until it answers truthy, or fails saying `what` with `context()`. */
async function until(check, what, context = () => "", ms = 20_000) {
  const from = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - from > ms) throw new Error(`not within ${ms} ms: ${what}: ${await context()}`);
    await sleep(20);
  }
}

/** Run-1 on the adapter loop through real runners, its spec minting a real Archil mount credential at each build (one per
 *  claim) and revoking it at its release. `script`, `extra(claim)`: the run's model script and its spec's own (a cap, a
 *  failing adapter). `start(store)` starts a runner on the store (the case's own timing and store wrapper). */
async function revokeRun(t, { script, extra = () => ({}), holdRelease = () => undefined }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-revoke-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Mounts" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const control = archilControlFetch();
  const { tools, slowStarted, letSlowGo } = suiteTools();
  const spec = piAdapterSpec({ script, tools, hooks: quiet });
  /** The epoch of each claim whose spec minted a credential. */
  const minted = [];
  /** Each claim epoch's release, settled once its revoke (its own remove, then the run's earlier epochs) has. */
  const releases = new Map();
  const releaseOf = (epoch) => {
    if (!releases.has(epoch)) {
      let resolve;
      releases.set(epoch, { done: new Promise((done) => (resolve = done)), resolve });
    }
    return releases.get(epoch);
  };
  const loop = createAdapterLoop(async (claim, run) => {
    const base = await spec(claim, run);
    // As the builders make it: the server's settings, the account key, a mount credential for this run and claim epoch.
    const archil = await archilClaim({
      settings: SETTINGS, keys: store.sealedKeys, sealKey: undefined, env: { ARCHIL_API_KEY: "fake-test-key" },
      run: { agentId: "agent-1", launch: { diskId: SETTINGS.diskId, kind: "agent" } },
      signal: new AbortController().signal, makeDisk: () => new FakeArchilDisk(),
      mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: 60_000, baseUrl: control.baseUrl, fetch: control.fetch },
    });
    await archil.token();
    minted.push(claim.epoch);
    return {
      ...base, agentId: "agent-1", ...extra(claim, base),
      release: async () => {
        try {
          // `holdRelease(epoch)`: a promise the run's end waits on before its revoke (a loaded machine's slow end), or none.
          await holdRelease(claim.epoch);
          await archil.revoke();
        } finally {
          releaseOf(claim.epoch).resolve();
        }
      },
    };
  }, { restartLimit: MAX_RESTARTS });
  const start = (timing, wrap = (s) => s, onEvent) => {
    const runner = startRunner({ store: wrap(store), createLoop: loop, name: `runner-${runners.length}`, ...timing, ...(onEvent ? { onEvent } : {}) });
    runners.push(runner);
    return runner;
  };
  const row = () => server.runs.get("run-1");
  const settled = (state) => until(async () => {
    const now = await row();
    return now.state === state && now.runner === null && now;
  }, `run-1 ${state} and released`, async () => JSON.stringify({ row: await row(), users: control.users.size, minted }));
  const tokensGone = () => until(() => control.users.size === 0, "no token left with the control plane", () => JSON.stringify({ users: [...control.users.keys()], requests: control.requests.map((one) => `${one.method} ${one.path}`) }));
  /** Claim `epoch`'s release has settled, its revoke with it; or a failure named `what`. */
  const released = (epoch, what) => within(releaseOf(epoch).done, `${what}: ${JSON.stringify({ requests: control.requests.map((one) => `${one.method} ${one.query?.identifier ?? one.path}`) })}`);
  return { server, control, minted, start, row, settled, released, tokensGone, slowStarted, letSlowGo };
}

/** The control plane's mints so far. */
const mints = (control) => control.requests.filter((one) => one.method === "POST").length;

test("ended: the run's token is removed at its end", async (t) => {
  const w = await revokeRun(t, { script: [{ say: "done" }] });
  w.start(STEADY);
  await w.settled("ended");
  assert.deepEqual(w.minted, [1]);
  assert.equal(mints(w.control), 1);
  await w.tokensGone();
});

test("failed: a run that ends failed (its adapter cannot open) has its token removed", async (t) => {
  const w = await revokeRun(t, { script: [{ say: "never" }], extra: () => ({ adapter: { open: async () => { throw new Error("the adapter could not open"); } } }) });
  w.start(STEADY);
  const failed = await w.settled("failed");
  assert.match(failed.summary ?? "", /could not open/);
  assert.deepEqual(w.minted, [1]);
  await w.tokensGone();
});

test("stopped: a person's stop ends the run stopped, and its token is removed", async (t) => {
  const w = await revokeRun(t, { script: [{ call: "slow" }, { say: "never" }] });
  w.start(STEADY);
  await within(w.slowStarted, "the run's first claim never reached its slow call");
  await sendCommand(w.server, "run-1", { kind: "stop" });
  await w.settled("stopped");
  assert.deepEqual(w.minted, [1]);
  await w.tokensGone();
});

/** The token users minted so far, by their nicknames (agentrun:<run>:<epoch>). */
const mintedNames = (control) => control.requests.filter((one) => one.method === "POST").map((one) => one.body?.nickname);

test("parked at its cap: the parked claim lets its token go; a raise's resume mints a new one under its higher epoch, removed at its end", async (t) => {
  let capUsd = 0.01;
  const w = await revokeRun(t, {
    script: [{ say: "done" }, { say: "done after the raise" }],
    extra: () => ({ cap: { get capUsd() { return capUsd; }, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf }, runCap: { capUsd: () => capUsd, modelOf: () => SONNET } }),
  });
  w.start(STEADY);
  await w.settled("parked");
  assert.deepEqual(w.minted, [1]);
  await w.tokensGone();
  // The resume: the person raises the cap; the next claim (a higher epoch) mints its own, and its end removes it.
  capUsd = 5;
  await sendCommand(w.server, "run-1", { kind: "raise", body: { capUsd } });
  await w.settled("ended");
  assert.equal(w.minted.length, 2, `one mint per claim: ${JSON.stringify(w.minted)}`);
  assert.ok(w.minted[1] > w.minted[0], `the resume's claim is a higher epoch: ${JSON.stringify(w.minted)}`);
  assert.deepEqual(mintedNames(w.control), w.minted.map((epoch) => `agentrun:run-1:${epoch}`));
  await w.tokensGone();
});

test("parked at an ask: the parked claim lets its token go; a steer's resume mints a new one under its higher epoch, removed when it parks again", async (t) => {
  const w = await revokeRun(t, { script: [{ call: "asked" }, { say: "done" }] });
  w.start(STEADY);
  const first = await w.settled("parked");
  assert.deepEqual(w.minted, [1]);
  await w.tokensGone();
  // A steer wakes it with no answer for its asked call: the resume's claim mints its own, then parks again and lets it go.
  await sendCommand(w.server, "run-1", { kind: "steer", body: { text: "any news?" } });
  await until(async () => {
    const now = await w.row();
    return now.state === "parked" && now.runner === null && now.epoch > first.epoch;
  }, "parked again after the steer", async () => JSON.stringify(await w.row()));
  assert.equal(w.minted.length, 2, `one mint per claim: ${JSON.stringify(w.minted)}`);
  assert.ok(w.minted[1] > w.minted[0], `the resume's claim is a higher epoch: ${JSON.stringify(w.minted)}`);
  assert.deepEqual(mintedNames(w.control), w.minted.map((epoch) => `agentrun:run-1:${epoch}`));
  await w.tokensGone();
});

test("a lost claim: a runner whose renews fail loses its claim, and its loop lets the token go", async (t) => {
  const w = await revokeRun(t, { script: [{ call: "slow" }, { say: "never" }] });
  let failing = false;
  const busy = () => Promise.reject(Object.assign(new Error("the store stayed locked past its busy timeout"), { name: "StoreBusy" }));
  const failingRenews = (store) => new Proxy(store, {
    get(target, key) {
      if (failing && (key === "renew" || key === "renewMany")) return busy;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const events = [];
  w.start(DIES, failingRenews, (event) => events.push(event));
  await within(w.slowStarted, "the run's first claim never reached its slow call");
  assert.equal(w.control.users.size, 1, "the run holds one token while it runs");
  failing = true;
  await until(() => events.some((event) => event.type === "claim-lost" && event.runId === "run-1"), "the claim was lost", () => JSON.stringify(events.slice(-5)));
  // The lost claim's release, awaited: once its lease runs out the run may be claimed again (a higher epoch, its own
  // token), so the case reads epoch 1's token alone, not the plane's count.
  await w.released(1, "the lost claim's token (tok-1) was never let go");
  assert.equal(w.minted[0], 1);
  assert.equal(w.control.users.has("tok-1"), false, "the lost claim's token is gone");
  assert.deepEqual(w.control.requests.filter((one) => one.method === "DELETE").map((one) => one.query.identifier).slice(0, 1), ["tok-1"], "its token was the first removed");
});

// Once as it runs, and once with the run's end held until its row reads ended (a loaded machine, as round 111's full
// run): the row reads ended and released before the release's revoke has gone through, so the requests are read only
// once that release has settled.
for (const held of [false, true]) {
  test(`a crash: a killed runner leaves its token; the next claim removes it before it mints its own, and the run's end removes that${held ? " (its end landing after the row reads ended)" : ""}`, async (t) => {
    let letGo = () => {};
    const gate = held ? new Promise((resolve) => (letGo = resolve)) : undefined;
    // The dead runner's call holds for good (its process is gone); the next claim's runs at once.
    const quick = { name: "slow", replaySafe: true, ask: false, run: async () => "slow done" };
    const w = await revokeRun(t, {
      script: [{ call: "slow" }, { say: "done" }],
      extra: (claim, base) => (claim.epoch > 1 ? { session: { ...base.session, tools: base.session.tools.map((tool) => (tool.name === "slow" ? { ...tool, call: async () => ({ text: await quick.run() }) } : tool)) } } : {}),
      holdRelease: (epoch) => (epoch > 1 ? gate : undefined),
    });
    const first = w.start(DIES);
    await within(w.slowStarted, "the run's first claim never reached its slow call");
    first.kill();
    assert.equal(w.control.users.size, 1, "the killed runner let nothing go");
    const [left] = [...w.control.users.keys()];
    // The dead runner's short lease runs out; the next runner's is steady, so a loaded machine never costs it its claim.
    w.start(STEADY);
    await w.settled("ended");
    letGo();
    assert.deepEqual(w.minted, [1, 2], "the dead claim's, then the next claim's");
    // The run's end: its claim's release, whose revoke removes tok-2 and then looks for the run's earlier epochs.
    await w.released(w.minted.at(-1), "tok-2 was never removed at the run's end");
    const calls = w.control.requests.map((one) => `${one.method}${one.query?.identifier ? ` ${one.query.identifier}` : ""}${one.body?.nickname ? ` ${one.body.nickname}` : ""}`);
    // The dead claim's token (agentrun:run-1:1), removed by the next claim (epoch 2) before it mints its own; then the
    // run's end removes that one, and its revoke reads the list for an earlier epoch's left.
    assert.deepEqual(calls, ["GET", "POST agentrun:run-1:1", "GET", `DELETE ${left}`, "POST agentrun:run-1:2", "DELETE tok-2", "GET"], "the next claim's removal of the dead one's token comes before its own mint, and the run's end removes its own");
    assert.equal(w.control.users.size, 0, "no token left with the control plane");
  });
}

/** `n` turns of the event loop (setImmediate): a wait that reads no clock. */
async function turns(n) {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The ONE timer of `ms` the next setTimeout(…, ms) arms, held for the case to fire (`fire()`), never by the clock; every
 *  other timer in the process stays real all along. Every other call goes straight to the real setTimeout and
 *  clearTimeout (the same arguments, the same return). setTimeout is patched only until that timer is armed (`armed`
 *  resolves then), clearTimeout only to know that one timer; `restore()` puts both back (idempotent: a case calls it in a
 *  finally and in t.after, so a failing case leaks no patch into the file's other tests). `ms` is a value no other timer
 *  in the case uses. */
function holdTimerOf(ms) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let held;
  let armedNow;
  const armed = new Promise((resolve) => (armedNow = resolve));
  globalThis.setTimeout = function (callback, delay, ...args) {
    if (delay !== ms || held) return realSetTimeout(callback, delay, ...args);
    held = { callback, args, cleared: false, fired: false };
    globalThis.setTimeout = realSetTimeout;
    armedNow();
    return held;
  };
  globalThis.clearTimeout = function (id) {
    if (held !== undefined && id === held) {
      held.cleared = true;
      return undefined;
    }
    return realClearTimeout(id);
  };
  return {
    armed,
    fire: () => {
      if (held.cleared || held.fired) return;
      held.fired = true;
      held.callback(...held.args);
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** The runner's `store` with its claim's release (the end's last store write, runner.ts finish) answered only after
 *  `turns` turns of the event loop, as a loaded machine's store answers late: the order in which the end's own store work
 *  outlasts a waiter that counts turns. Each turn is a setImmediate. */
const lateRelease = (turns) => (store) => new Proxy(store, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== "release" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
    return async (...args) => {
      for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
      return value.apply(target, args);
    };
  },
});

test("a run held when the runner closes keeps its mount credential through the drain and loses it at the abort", async (t) => {
  // The drain's bound is a setTimeout of drainMs in close() (runner.ts takes drainMs, no timer of its own). The case holds
  // that ONE timer (holdTimerOf: a delay no other timer here uses) and fires it itself: the drain lasts exactly as long as
  // the case says, and every other timer (the store's, the loop's, the session's close bound, close()'s own) stays real,
  // never frozen or dropped as a process-wide mock clock would leave the ones armed while it stood still.
  const DRAIN_MS = 31_337;
  const w = await revokeRun(t, { script: [{ call: "slow" }, { say: "never" }] });
  // The end's release answers late (800 turns), as a loaded machine's store did in round 115.
  const runner = w.start({ ...STEADY, drainMs: DRAIN_MS }, lateRelease(800));
  await within(w.slowStarted, "the run's first claim never reached its slow call");
  assert.equal(w.control.users.size, 1, "the run holds its token while it runs");
  const deletes = () => w.control.requests.filter((one) => one.method === "DELETE");
  const calls = () => w.control.requests.map((one) => `${one.method}${one.query?.identifier ? ` ${one.query.identifier}` : ""}${one.body?.nickname ? ` ${one.body.nickname}` : ""}`);
  /** The control plane's calls up to the close: the claim's sweep and its mint. */
  const minting = ["GET", "POST agentrun:run-1:1"];
  assert.deepEqual(calls(), minting);

  const bound = holdTimerOf(DRAIN_MS);
  t.after(() => bound.restore());
  try {
    const closing = runner.close();
    // The drain: close() stops claiming, arms its bound (held here), and lets the held run go on; the token stays. A
    // close() whose bound is no longer a setTimeout of drainMs fails here by name, never passes on with no drain held.
    await within(bound.armed, "the drain's bound was never armed");
    await turns(100);
    assert.deepEqual(deletes(), [], "no DELETE for the run's token while it drains");
    assert.deepEqual(calls(), minting, "nothing reaches the control plane while it drains");
    assert.equal(w.control.users.size, 1, "the token is still the run's");

    // The bound: close() stops the loop for the shutdown and aborts the claim's signal; the loop's release revokes it,
    // and the revoke's sweep then reads the list for an earlier epoch's left. The waits are for those events, each under
    // a named bound on the real clock (a hang guard; the case takes well under a second).
    bound.fire();
    const swept = w.control.seen((one, index, all) => one.method === "GET" && all.slice(0, index).some((before) => before.method === "DELETE"));
    await within(swept, "the run's token was never revoked after the abort");
    assert.deepEqual(calls(), [...minting, "DELETE tok-1", "GET"], "the DELETE right after the abort, then the revoke's sweep");
    assert.equal(w.control.users.size, 0, "no token left with the control plane");
    // close() ends once the run's end has landed (its release written to the store), however long that takes.
    await within(closing, "the runner never closed");
  } finally {
    bound.restore();
  }
  assert.deepEqual(w.minted, [1]);
});
