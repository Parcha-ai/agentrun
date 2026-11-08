// A run that ends while the runner is still talking to its loop or the store about it: nothing of the claim is written
// after the release, and nothing in flight at the end reads as a lost claim.
// (a) a command whose loop.command() is still pending when start() resolves: finish waits for it, so its refusal is
//     written (with the loop's own reason) before the release, never after, and no claim-lost is emitted;
// (b) a renew in flight when the run ends and answered after the release: no claim-lost is emitted;
// (c) a command() that answers only after finish's wait ran out and the release: no store call and no event follow it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
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

test("(a) a command still with the loop when the run ends: its refusal is written before the release, never after, and no claim is lost", async (t) => {
  const { server, record, events, control } = await running(t);
  const steer = await sendCommand(server, "run-1", { kind: "steer", body: { text: "one more thing" } });
  await until(() => control.commands.length === 1, "the steer reaches the loop");

  control.end();
  await sleep(150);
  control.answer({ refused: "the loop's own reason" });
  await until(() => releasedAt(record) !== undefined, "the release");
  await sleep(150);

  const release = releasedAt(record);
  const takes = record.calls.filter((call) => call.op === "take");
  assert.ok(takes.length > 0, "the refusal is written");
  assert.deepEqual(takes.filter((call) => call.order > release), [], `no take after the release: ${JSON.stringify(record.calls)}`);
  assert.equal((await commandRow(server, "run-1", steer.id)).refused, "the loop's own reason", "the loop's own refusal, not the end's sweep's");
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
  await sendCommand(server, "run-1", { kind: "steer", body: { text: "too late" } });
  await until(() => control.commands.length === 1, "the steer reaches the loop");

  control.end();
  await until(() => releasedAt(record) !== undefined, "the release, once the wait ran out", 5_000);
  await sleep(50);
  const calls = record.calls.length;
  const said = events.length;
  control.answer({ refused: "an answer after the release" });
  await sleep(200);
  assert.deepEqual(record.calls.slice(calls), [], "no store call after the late answer");
  assert.deepEqual(events.slice(said), [], "no event after the late answer");
});
