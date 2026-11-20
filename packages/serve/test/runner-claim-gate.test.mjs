// A runner's claim gate (RunnerOptions.claimGate, runner/disk-free.ts's for a runner on a disk of its own) and its
// heartbeat through a drain, on the store alone (scripted loops, no model):
//   - while the gate refuses, the runner claims nothing across its polls, says why once ("refusing"), and its presence row
//     carries the words, which the server reads (presence.ts runnersRefused); once it opens, the runner claims the run,
//     says so once, and its row is a claiming runner's again;
//   - a gate that closes between a poll's claim and its loops (asked fresh after the claim) gives the claimed run back at
//     once, untouched, for another runner: no loop starts on it;
//   - its heartbeat (onBeat, which runner/main.ts writes as runner-<name>.alive) goes on through a drain: a platform's
//     liveness check that reads it does not kill a runner while it lets its runs finish their turns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { runnersRefused } from "../dist/runner/presence.js";
import { queue, stores, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 60_000, renewEveryMs: 50, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 20 };
const WORDS = "a test's gate: this runner can't serve these runs";

/** Loops that hold their one turn until `finish(runId)` (or a stop): the runs this runner started, by id. */
function heldLoops() {
  const started = new Map();
  const createLoop = () => {
    let end;
    const ended = new Promise((resolve) => (end = resolve));
    return {
      async start(claim) {
        started.set(claim.runId, () => end({ state: "interrupted" }));
        return ended;
      },
      async command() {
        return { taken: true };
      },
      async stop() {
        end({ state: "interrupted" });
      },
    };
  };
  return { started, createLoop };
}

test("while the claim gate refuses, the runner claims nothing and its presence row says why; once it opens, it claims", async (t) => {
  const { server, runners: [store] } = await stores();
  await queue(server, "run-gated");
  const loops = heldLoops();
  const events = [];
  let beats = 0;
  let refusing = WORDS;
  const runner = startRunner({ store, createLoop: loops.createLoop, name: "runner-gated", claimGate: async () => refusing ?? undefined, onEvent: (event) => events.push(event), onBeat: () => void beats++, ...TIMING });
  t.after(async () => {
    for (const end of loops.started.values()) end();
    await runner.close();
  });
  await until(async () => (await runnersRefused(server.runners)) !== undefined, "the runner's row says it refuses");
  assert.ok((await runnersRefused(server.runners)).includes(WORDS), "in the gate's words");
  const seen = beats;
  await until(async () => beats >= seen + 5, "five more polls");
  assert.equal(loops.started.size, 0, "nothing claimed while the gate refuses");
  assert.deepEqual(events.filter((event) => event.type === "refusing"), [{ type: "refusing", reason: WORDS }], "said once");

  refusing = null;
  await until(async () => loops.started.has("run-gated"), "the run is claimed once the gate opens");
  assert.equal(await runnersRefused(server.runners), undefined, "and its row is a claiming runner's again");
  assert.deepEqual(events.filter((event) => event.type === "refusing").map((event) => event.reason), [WORDS, null]);
});

test("a gate that closes between a poll's claim and its loops gives the claimed run back at once: no loop starts on it", async (t) => {
  const { server, runners: [store] } = await stores();
  await queue(server, "run-raced");
  const loops = heldLoops();
  const asked = [];
  // Open before the claim (cached), closed when asked fresh after it: the change landed between the two.
  const runner = startRunner({ store, createLoop: loops.createLoop, name: "runner-raced", claimGate: async (fresh) => (asked.push(fresh), fresh ? WORDS : undefined), ...TIMING });
  t.after(() => runner.close());
  await until(async () => asked.includes(true), "the gate is asked fresh after a claim");
  await until(async () => (await server.runs.get("run-raced"))?.runner === null, "the claim is released");
  assert.ok((await server.runs.claimable({ limit: 10 })).includes("run-raced"), "the run is claimable again, for a runner that can serve it");
  assert.equal(loops.started.size, 0, "no loop started on it");
});

test("the heartbeat goes on through a drain, until the runner has closed", async (t) => {
  const { server, runners: [store] } = await stores();
  await queue(server, "run-draining");
  const loops = heldLoops();
  let beats = 0;
  const runner = startRunner({ store, createLoop: loops.createLoop, name: "runner-draining", drainMs: 60_000, onBeat: () => void beats++, ...TIMING });
  await until(async () => loops.started.has("run-draining"), "the run is claimed");
  let closed = false;
  const closing = runner.close().then(() => void (closed = true));
  t.after(async () => {
    for (const end of loops.started.values()) end();
    await closing;
  });
  // The drain holds the close while the turn goes on; the runner's renewals keep beating meanwhile.
  const atDrain = beats;
  await until(async () => beats >= atDrain + 5, "five beats during the drain", 10_000);
  assert.equal(closed, false, "still draining");
  loops.started.get("run-draining")();
  await closing;
});
