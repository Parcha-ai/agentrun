// A parked run brought back by a raise whose loop cannot start keeps its place in the queue of things to try: twins of
// cap-raise "a raised run's follow-up that could not be sent is tried again, and the run goes on" and #1944-5's
// workflow-cap-place reds ("a raise whose launch throws once its place is taken … keeps the run paused", "a raise whose
// launch keeps throwing ends its tries still paused at its cap, saying why on a row of its own"). A resume that throws
// leaves the run parked, its raise untaken with one more try counted, and the run claimable again only after a backoff:
// the tries are spaced, never a hot re-claim. After the last try the raise row is refused with why, the run stays
// parked (never failed), and a person's next raise brings it back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { sendCommand } from "../dist/runner/commands.js";
import { commandRow, fauxLoops, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const BACKOFF_MS = 300;
const TRIES = 3;
const TIMING = { leaseMs: 2_000, renewEveryMs: 500, stopMarginMs: 500, pollMs: 20, commandPollMs: 30, resumeTries: TRIES, resumeBackoffMs: BACKOFF_MS };
const RAISE = { kind: "raise", body: { capUsd: 5 } };

/** Faux loops that park on their first start, and whose next `failing` starts throw as a harness that cannot start. */
function failingResumes(failing) {
  const faux = fauxLoops({ park: true, turns: 2, turnMs: 10 });
  let left = failing;
  const createLoop = (deps) => {
    const loop = faux.createLoop(deps);
    const start = loop.start;
    loop.start = async (claim) => {
      if (claim.from === "parked" && left > 0) {
        left -= 1;
        throw new Error("the harness could not start: claude was not found on PATH");
      }
      return start(claim);
    };
    return loop;
  };
  return { ...faux, createLoop };
}

async function parkedRun(t, faux, timing = {}) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  const record = recorder();
  const runner = startRunner({ store: observed(store, record), createLoop: faux.createLoop, name: "runner-a", ...TIMING, ...timing });
  t.after(() => runner.close());
  await queue(server, "run-1");
  await until(async () => {
    const run = await server.runs.get("run-1");
    return run.state === "parked" && run.runner === null;
  }, "the run parks and is released");
  return { server, record };
}

test("a raised run whose resume throws once stays parked, its raise untaken with one try counted, and goes on after the backoff", async (t) => {
  const faux = failingResumes(1);
  const { server, record } = await parkedRun(t, faux);
  const raise = await sendCommand(server, "run-1", RAISE);

  await until(() => record.claims.length >= 2, "the raise brings the run back");
  await until(async () => (await commandRow(server, "run-1", raise.id)).tries === 1, "one try counted on the raise");
  // Released as it was (the try is counted first, then the release): parked, never failed.
  const between = await until(async () => {
    const run = await server.runs.get("run-1");
    return run.runner === null && run;
  }, "the failed try's release");
  assert.equal(between.state, "parked", "still parked, never failed");
  assert.ok(between.backoffUntil > Date.now(), "with a backoff before its next try");
  assert.equal((await commandRow(server, "run-1", raise.id)).takenAt, null, "the raise is still untaken");

  await until(async () => (await server.runs.get("run-1")).state === "ended", "the next try goes on and ends", 10_000);
  const [, failed, went] = record.claims;
  assert.ok(went.at - failed.at >= BACKOFF_MS, `the second try came ${went.at - failed.at} ms after the first (backoff ${BACKOFF_MS} ms)`);
  const row = await commandRow(server, "run-1", raise.id);
  assert.ok(row.takenAt !== null && row.refused === null, `the raise is taken by the loop that went on: ${JSON.stringify(row)}`);
});

test("a stop sent while a raised run waits out its backoff is taken at once, and the run ends stopped though its loop cannot start", async (t) => {
  const faux = failingResumes(100);
  // A long backoff: the stop must not wait it out.
  const { server, record } = await parkedRun(t, faux, { resumeBackoffMs: 30_000 });
  const raise = await sendCommand(server, "run-1", RAISE);
  await until(async () => (await commandRow(server, "run-1", raise.id)).tries === 1, "the first try fails, and the backoff starts");

  const stop = await sendCommand(server, "run-1", { kind: "stop" });
  const sentAt = Date.now();
  await until(async () => (await server.runs.get("run-1")).state === "stopped", "the stop ends the run", 3_000);
  assert.ok(Date.now() - sentAt < 3_000, "well inside the backoff");
  await until(async () => (await commandRow(server, "run-1", stop.id)).takenAt !== null, "the stop is taken", 3_000);
  const raiseRow = await commandRow(server, "run-1", raise.id);
  assert.match(raiseRow.refused ?? "", /stopped/, `the raise waiting on its backoff is refused as a stopped run's: ${JSON.stringify(raiseRow)}`);
  await until(async () => (await server.runs.get("run-1")).runner === null, "released");
  assert.equal(record.claims.length, 3, "claimed for the park, the failed try and the stop");
});

test("a raised run whose resume keeps throwing ends its tries still parked, its raise refused saying why; a new raise brings it back", async (t) => {
  const faux = failingResumes(TRIES);
  const { server, record } = await parkedRun(t, faux);
  const raise = await sendCommand(server, "run-1", RAISE);

  const row = await until(async () => {
    const now = await commandRow(server, "run-1", raise.id);
    return now.takenAt !== null && now;
  }, "the raise is settled after its tries", 15_000);
  assert.match(row.refused ?? "", /claude was not found on PATH/, `the raise row says why: ${JSON.stringify(row)}`);
  assert.match(row.refused ?? "", new RegExp(`${TRIES} tries`), "and that its tries ran out");
  assert.equal(row.tries, TRIES);
  const run = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.runner === null && now;
  }, "the last try's release");
  assert.equal(run.state, "parked", "still parked at its cap: never failed");
  const tries = record.claims.slice(1);
  assert.equal(tries.length, TRIES, "claimed once per try");
  for (let i = 1; i < tries.length; i++) assert.ok(tries[i].at - tries[i - 1].at >= BACKOFF_MS, `try ${i + 1} came ${tries[i].at - tries[i - 1].at} ms after try ${i}`);
  await sleep(BACKOFF_MS * 3);
  assert.equal(record.claims.length, 1 + TRIES, "with nothing untaken, not claimed again");

  const again = await sendCommand(server, "run-1", RAISE);
  await until(async () => (await server.runs.get("run-1")).state === "ended", "a person's new raise brings it back, and it ends");
  assert.ok((await commandRow(server, "run-1", again.id)).takenAt !== null);
});
