// A run that ends while the runner is still talking to its loop or the store about it: nothing of the claim is written
// after the release, and nothing in flight at the end reads as a lost claim.
// (a) a command whose loop.command() is still pending when start() resolves: finish waits for it, so no take of it is
//     written after the release, and no claim-lost is emitted. The row itself is settled by the end's commit, in the
//     end's words: no final run keeps an untaken row (the store refuses the leftovers in the write that makes it final),
//     and holding every loop's end for its in-flight commands would move endWaitMs into every loop;
// (b) a renew in flight when the run ends and answered after the release: no claim-lost is emitted;
// (c) a command() that answers only after finish's wait ran out and the release: no store call and no event follow it;
// (d) a person's message that reopens the run after its end commit (the store's release) and before the runner's own
//     release: the runner claims it once and holds that claim, starts its loop only once the first claim settled, and
//     its first claim's end still says released.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { startRunner } from "../dist/runner/runner.js";
import { endedReason, sendCommand } from "../dist/runner/commands.js";
import { commandRow, nextOrder, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 2_000, renewEveryMs: 500, stopMarginMs: 500, pollMs: 20, commandPollMs: 20 };

/** A loop that runs until `control.end()` (which commits the run's end, so it is not claimed again), and whose command()
 *  answers only when `control.answer(outcome)` is called. */
function heldLoop() {
  const control = { started: false, commands: [] };
  const createLoop = (deps) => ({
    start: (claim) =>
      new Promise((resolve) => {
        control.started = true;
        control.end = async () => {
          const journal = deps.journal(claim);
          const end = await journal.mintId();
          journal.stage({ run: { state: "ended" }, effect: end });
          await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: { id: end, conversationId: 1, kind: "message" } }], BACKGROUND_CONTEXT);
          resolve({ state: "ended" });
        };
      }),
    command: (command) =>
      new Promise((resolve) => {
        control.commands.push(command);
        control.answer = (outcome) => resolve(outcome);
      }),
    stop: async () => {},
  });
  return { control, createLoop };
}

async function running(t, timing = {}) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const events = [];
  const { control, createLoop } = heldLoop();
  const runner = startRunner({
    store: observed(store, record),
    createLoop,
    name: "runner-a",
    ...TIMING,
    ...timing,
    onEvent: (event) => events.push({ ...event, order: nextOrder() }),
  });
  t.after(() => runner.close());
  await queue(server, "run-1");
  await until(() => control.started, "the loop runs");
  return { server, record, events, control };
}

/** When the run's release was asked of the store, in the order things happened. */
const releasedAt = (record) => record.calls.find((call) => call.op === "release")?.order;

test("(a) a command still with the loop when the run ends: settled by the end in the end's words, nothing taken after the release, and no claim is lost", async (t) => {
  const { server, record, events, control } = await running(t);
  // A raise as the command still with the loop: a person's message (a steer) waiting at a completed run's end opens the run
  // again instead of being settled by it (store-run-reopen.test.mjs, runner-message-while-working.test.mjs).
  const steer = await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 5 } });
  await until(() => control.commands.length === 1, "the raise reaches the loop");

  control.end();
  await sleep(150);
  control.answer({ refused: "the loop's own reason" });
  await until(() => releasedAt(record) !== undefined, "the release");
  await sleep(150);

  const release = releasedAt(record);
  const takes = record.calls.filter((call) => call.op === "take");
  assert.ok(takes.length > 0, "the refusal is written");
  assert.deepEqual(takes.filter((call) => call.order > release), [], `no take after the release: ${JSON.stringify(record.calls)}`);
  // The end's commit settled it (it was never taken): the loop's later answer writes nothing over it.
  assert.equal((await commandRow(server, "run-1", steer.id)).refused, endedReason("ended"), "settled by the end, in the end's words");
  assert.deepEqual(events.filter((event) => event.type === "claim-lost"), []);
});

test("(b) a renew in flight when the run ends, answered after the release: no claim-lost", async (t) => {
  const { record, events, control } = await running(t, { renewEveryMs: 100 });
  // The next renew waits until it is let go: it is in flight while the run ends.
  let letRenewGo;
  record.holdRenew = new Promise((resolve) => (letRenewGo = resolve));
  await until(() => record.renewsHeld > 0, "a renew in flight");
  control.end();
  await until(() => releasedAt(record) !== undefined, "the release");
  letRenewGo();
  await sleep(200);
  assert.deepEqual(events.filter((event) => event.type === "claim-lost"), [], `events: ${JSON.stringify(events)}`);
});

test("(c) a command() that answers only after finish's wait ran out and the release: no store call and no event follow it", async (t) => {
  const { server, record, events, control } = await running(t, { endWaitMs: 200 });
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 5 } });
  await until(() => control.commands.length === 1, "the raise reaches the loop");

  // The store answers the release only once the test lets it (a loaded Postgres's slow release): the runner says
  // released after that answer, so the late answer below is let go only once the run's release is said.
  let letRelease;
  record.holdRelease = new Promise((resolve) => (letRelease = resolve));
  control.end();
  await until(() => releasedAt(record) !== undefined, "the release asked, once the wait ran out", 5_000);
  letRelease();
  await until(() => events.some((event) => event.type === "released"), "the release said", 5_000);
  const calls = record.calls.length;
  const said = events.length;
  control.answer({ refused: "an answer after the release" });
  await sleep(200);
  assert.deepEqual(record.calls.slice(calls), [], "no store call after the late answer");
  assert.deepEqual(events.slice(said), [], "no event after the late answer");
});

test("(d) a run reopened between its end commit and the runner's release is claimed once and held, its loop started only once the first claim settled, and the first claim's end still says released", async (t) => {
  const { server, record, events, control } = await running(t);
  let letRelease;
  record.holdRelease = new Promise((resolve) => (letRelease = resolve));
  t.after(() => letRelease());
  control.started = false;
  await control.end();
  await until(() => releasedAt(record) !== undefined, "the first claim's release asked");
  assert.equal((await server.runs.get("run-1")).state, "ended", "the end commit landed");

  await server.runs.reopen("run-1", { kind: "steer", body: { text: "go on" } });
  await until(() => record.claims.length === 2, "the reopened run claimed");
  const second = record.claims[1].epoch;
  await until(() => events.some((event) => (event.type === "claimed" && event.claim.epoch === second) || event.type === "error"), "the reopen's claim held or given back");
  assert.deepEqual(events.filter((event) => event.type === "error" || event.type === "handed-back"), [], "the reopen's claim is not given back");
  // Held and renewed, its loop not started while the first claim is still letting go: a run's process cleaning up its
  // folders (a slot's reap, its scratch swept) never runs under the next one's.
  await sleep(300);
  assert.equal(control.started, false, "the reopened run's loop waits for the first claim to settle");

  letRelease();
  const first = record.claims[0].epoch;
  await until(() => events.some((event) => (event.type === "released" && event.epoch === first) || event.type === "error"), "the first claim's end settles");
  assert.deepEqual(events.filter((event) => event.type === "error"), [], "the first claim's release is no fenced write");
  await until(() => control.started, "the reopened run's loop runs once the first claim settled");
  assert.equal(record.claims.length, 2, `one claim for the reopen: ${JSON.stringify(record.claims)}`);
});
