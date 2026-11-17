// A message's model_key is fail-closed (runner/claim-secrets.ts claimModelKey fresh, adapter-loop.ts command): when the
// runner takes a message, it reads the run's key again from its launch before the message reaches the session. A read
// that fails is tried again within a bound; one that keeps failing throws, so the message's command row stays untaken and
// the runner delivers it again at its next poll. The session never runs the message on the key held before it, nor on
// the server's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { claimModelKey } = await import("../dist/runner/claim-secrets.js");
const { sealRunLaunch } = await import("../dist/store/index.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const GW = "https://gateway.example";
const ENV = { AGENT_MODEL_BASE_URL: GW };
const KEY_ONE = `not-a-secret-${"fresh-key-one"}-1f2e`;
const KEY_TWO = `not-a-secret-${"fresh-key-two"}-3d4c`;
after(closeOpenSessions);

/** A launch store for run `runId` whose sealed key is `current.key`, and whose next `fail.reads` reads throw, as a store
 *  that cannot be reached for a moment does; `events` records each read. `fail.after` and `fail.gate`: the read that comes
 *  after that many failures waits on the gate first, so a test reads the state between two deliveries with nothing
 *  moving. */
function flakyLaunch(sealKey, runId, current, fail, events) {
  let failed = 0;
  return {
    runs: {
      launch: async () => {
        if (fail.gate && failed === fail.after) await fail.gate;
        if (fail.reads > 0) {
          failed += 1;
          fail.reads -= 1;
          events.push("read-failed");
          throw new Error("the store could not be read (injected)");
        }
        events.push("read");
        return { sealed: sealRunLaunch(sealKey, runId, { model: { key: current.key, origin: GW } }) };
      },
    },
  };
}

test("fresh() reads the run's launch again within a bound: a read that fails is tried again; one that keeps failing throws, and the key held is never taken for the message's", async () => {
  const sealKey = randomBytes(32);
  const current = { key: KEY_ONE };
  const fail = { reads: 0 };
  const events = [];
  const held = await claimModelKey({ store: flakyLaunch(sealKey, "run-1", current, fail, events), sealKey, env: ENV }, "run-1");
  assert.equal(held.key(), KEY_ONE);
  current.key = KEY_TWO;
  fail.reads = 2;
  await held.fresh();
  assert.equal(held.key(), KEY_TWO, "two failed reads, then the message's key: within the bound");
  current.key = `${KEY_TWO}-3`;
  fail.reads = 3;
  await assert.rejects(held.fresh(), /could not be read from its launch \(3 tries\).*never sent on another key/);
});

test("a message whose key cannot be read yet is not handed to the session: its row stays untaken, the runner delivers it again, and the steered request goes only once the message's key is read (red before: fresh kept the old key and the message ran on it)", { timeout: 60_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const sealKey = randomBytes(32);
  const current = { key: KEY_ONE };
  const fail = { reads: 0 };
  const events = [];
  const modelKey = await claimModelKey({ store: flakyLaunch(sealKey, "run-1", current, fail, events), sealKey, env: ENV }, "run-1");
  let answering = () => {};
  const midAnswer = new Promise((resolve) => (answering = resolve));
  let letFinish = () => {};
  const finish = new Promise((resolve) => (letFinish = resolve));
  const origin = scriptedOrigin([{ say: "first answer" }, { sayLastSteer: true }]);
  let requests = 0;
  const fetch = async (url, init) => {
    requests += 1;
    events.push(`request ${requests} on ${modelKey.key()}`);
    if (requests === 1) {
      answering();
      await finish;
    }
    return origin(url, init);
  };
  const runCap = { capUsd: () => undefined, modelOf: () => undefined };
  const spec = piAdapterSpec({ script: [], tools: {}, hooks: quiet }, { fetch });
  const createLoop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), runCap, modelKey }));
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await midAnswer;
  // The message's key is written with its row; its first delivery's reads all fail (one delivery's worth, and one more).
  // The second delivery's first read waits on the gate, so the row is read untaken with nothing moving.
  let open = () => {};
  fail.gate = new Promise((resolve) => (open = resolve));
  fail.after = 3;
  t.after(() => open());
  current.key = KEY_TWO;
  fail.reads = 4;
  const steer = await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "and keep it short" } });
  const takenAt = async () => (await opened.server.commands("run-1", steer.id - 1)).find((command) => command.id === steer.id)?.takenAt;
  await until(() => events.filter((event) => event === "read-failed").length === 3, "the first delivery's three reads failed");
  assert.equal(await takenAt(), null, "the message is not taken while its key cannot be read");
  open();
  await until(async () => (await takenAt()) !== null, "delivered again, its key read, the message taken");
  letFinish();
  await until(async () => (await opened.server.runs.get("run-1")).state === "ended", "the run ended", 15_000);
  assert.equal(requests, 2, "the answer finished, then one request carried the steer");
  assert.deepEqual(events.filter((event) => event.startsWith("request") || event === "read" || event === "read-failed"), [
    "read", // the claim's own read (the test's claimModelKey)
    `request 1 on ${KEY_ONE}`,
    "read-failed", "read-failed", "read-failed", // the first delivery: three tries, then the command is left untaken
    "read-failed", "read", // the next delivery: one more failure, then the message's key
    `request 2 on ${KEY_TWO}`,
  ], "the steered request went only after the message's key was read, and on it");
});

test("a stop queued behind a message whose key cannot be read still reaches the loop: the turn in flight is cut, and the message never runs (red before: the blocked row held every row behind it, the stop among them, and the turn ran on)", { timeout: 60_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const sealKey = randomBytes(32);
  const current = { key: KEY_ONE };
  const fail = { reads: 0 };
  const events = [];
  const launches = flakyLaunch(sealKey, "run-1", current, fail, events);
  let answering = () => {};
  const midAnswer = new Promise((resolve) => (answering = resolve));
  let cut = () => {};
  const wasCut = new Promise((resolve) => (cut = resolve));
  const origin = scriptedOrigin([{ say: "first answer" }, { sayLastSteer: true }]);
  let requests = 0;
  // The first request never answers on its own: only a stop that reaches the loop ends it (its signal aborts).
  const fetch = async (url, init) => {
    requests += 1;
    if (requests === 1) {
      answering();
      await new Promise((_, reject) => {
        const abort = () => (cut(), reject(init.signal.reason ?? new Error("aborted")));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return origin(url, init);
  };
  const runCap = { capUsd: () => undefined, modelOf: () => undefined };
  const spec = piAdapterSpec({ script: [], tools: {}, hooks: quiet }, { fetch });
  // Each claim opens the run's key as a claim does (claimModelKey over the store), so a claim after the stop reads it again.
  const createLoop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), runCap, modelKey: await claimModelKey({ store: launches, sealKey, env: ENV }, claim.runId) }));
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await midAnswer;
  // The message's key never reads: every delivery of it fails, for as long as the test lasts.
  current.key = KEY_TWO;
  fail.reads = Number.POSITIVE_INFINITY;
  await sendCommand(opened.server, "run-1", { kind: "steer", body: { text: "and keep it short" } });
  await until(() => events.filter((event) => event === "read-failed").length >= 3, "the message's first delivery failed");
  const stop = await sendCommand(opened.server, "run-1", { kind: "stop" });
  let timer;
  await Promise.race([wasCut, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("not within 15000 ms: the stop behind the blocked message reached the loop and cut the turn")), 15_000)))]).finally(() => clearTimeout(timer));
  await until(async () => (await opened.server.commands("run-1", stop.id - 1)).find((command) => command.id === stop.id)?.takenAt !== null, "the stop taken");
  // Time for any claim after the stop to try the message: its key still cannot be read, so it never runs.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(requests, 1, "the blocked message never ran a request");
});

test("a stop that keeps the run's computer, behind a message whose key cannot be read: the owner's computer commands still reach the loop, so the computer can be let go; the message is never handed on (red before: only stop and cancel passed the blocked row)", { timeout: 30_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const seen = [];
  let finish = () => {};
  // A loop whose message cannot be taken (its key unreadable: adapter-loop.ts command throws), whose person's stop keeps
  // the computer (keepsComputer), and which takes the owner's computer rows.
  const createLoop = () => {
    const ended = new Promise((resolve) => (finish = resolve));
    return {
      start: () => ended,
      command: async (row) => {
        seen.push(row.kind);
        if (row.kind === "steer") throw new Error("the run's model key could not be read from its launch (injected)");
        return { taken: true };
      },
      stop: async (reason) => {
        seen.push(`stop:${reason.kind}`);
        if (reason.kind !== "command") finish({ state: "failed", error: { code: "stopped", message: "stopped" } });
      },
      keepsComputer: (reason) => reason.kind === "command" && !reason.cancel,
    };
  };
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).runner !== null, "the run claimed");
  await opened.server.command("run-1", { kind: "steer", body: { text: "and then?" } });
  await until(() => seen.includes("steer"), "the message's delivery failed");
  await opened.server.command("run-1", { kind: "stop", body: {} });
  await opened.server.command("run-1", { kind: "computer_release", body: {} });
  await until(() => seen.includes("computer_release"), "the owner's release reached the loop past the blocked message", 10_000);
  assert.ok(seen.indexOf("stop:command") >= 0 && seen.indexOf("stop:command") < seen.indexOf("computer_release"), `the stop, then the release: ${JSON.stringify(seen)}`);
  // Delivered again at each poll, the release is handed on once.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(seen.filter((kind) => kind === "computer_release").length, 1, `the release handed on once: ${JSON.stringify(seen)}`);
  assert.ok(seen.filter((kind) => kind === "steer").length >= 2, "the message is tried again at each delivery, never taken");
  const steer = (await opened.server.commands("run-1", 0)).find((command) => command.kind === "steer");
  assert.equal(steer.takenAt, null, "the message stays untaken");
});

test("a computer command refused past a blocked message whose refusal write fails is asked again at the next delivery, and its refusal is kept once the store answers (red before: it was marked handed on before the write, and its caller never heard)", { timeout: 30_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const seen = [];
  let finish = () => {};
  const createLoop = () => {
    const ended = new Promise((resolve) => (finish = resolve));
    return {
      start: () => ended,
      command: async (row) => {
        seen.push(row.kind);
        if (row.kind === "steer") throw new Error("the run's model key could not be read from its launch (injected)");
        return { refused: "no computer is held for this run (fake)" };
      },
      stop: async (reason) => void (reason.kind !== "command" && finish({ state: "failed", error: { code: "stopped", message: "stopped" } })),
    };
  };
  // The runner's store, whose first refusal write fails, as a store that cannot be reached for a moment does.
  const base = opened.runners[0];
  let takeFails = 1;
  const store = new Proxy(base, {
    get: (target, key) => {
      if (key === "take") {
        return async (...args) => {
          if (args[2] === "refused" && takeFails > 0) {
            takeFails -= 1;
            throw new Error("the store could not be written (injected)");
          }
          return target.take(...args);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).runner !== null, "the run claimed");
  await opened.server.command("run-1", { kind: "steer", body: { text: "and then?" } });
  await until(() => seen.includes("steer"), "the message's delivery failed");
  const call = await opened.server.command("run-1", { kind: "computer_call", body: {} });
  const row = await until(async () => {
    const now = (await opened.server.commands("run-1", call.id - 1)).find((command) => command.id === call.id);
    return now?.refused ? now : undefined;
  }, "the computer call's refusal kept once the store answered", 10_000);
  assert.equal(takeFails, 0, "the first refusal write failed");
  assert.equal(row.refused, "no computer is held for this run (fake)");
  assert.ok(seen.filter((kind) => kind === "computer_call").length >= 2, `asked again after the failed write: ${JSON.stringify(seen)}`);
  const steer = (await opened.server.commands("run-1", 0)).find((command) => command.kind === "steer");
  assert.equal(steer.takenAt, null, "the message stays untaken");
});
