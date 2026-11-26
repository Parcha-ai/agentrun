// A learning child (a check's replay run, an audit's shadow run) carries its deadline in its launch (its replay's or
// audit's deadline_at): the bound its run's caller was promised (learning_work.deadline_at), past which none of it may
// spend on the run's key. Its runner reads that deadline as it claims the child, before any loop starts on it:
//   - a child claimed at or past its deadline on the runner's learning clock never starts: no loop is made, and it ends
//     cancelled as a person's cancel ends an unstarted run, at spend 0;
//   - a child whose deadline cannot be read is not started either: its claim is given back, said on the runner's events,
//     and a later claim reads it again (and starts it once the read answers and its deadline is ahead);
//   - a child whose deadline is ahead starts as any run does;
//   - a poll's claims read their deadlines in one store read (store.runs.learningDeadlines), never a launch read a claim;
//   - a child at work when its deadline comes is cancelled then, by a timer of its own, never at a later poll;
//   - a child that parks (for an approval) is woken at its deadline and ends there, never left parked past it.
// The runner's loops are faux (runner-support.mjs fauxLoops): a loop made is a loop started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxLoops, queue, release, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { sealRunLaunch } = await import("../dist/store/seal.js");
const { learningWorkOf, noteLearningChild } = await import("../dist/learning-work.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const SEAL_KEY = Buffer.alloc(32, 9);
/** A run's own learning, for a run that learns nothing itself (learning-work.ts OwnLearning): its children alone count. */
const NO_OWN = { learns: false, compiling: false, compiled: false, endedAt: null, compileBy: null };

/** A replay run `id` of a check, its deadline `deadlineAt` (ms), queued on the server's store; `sealed` its launch's
 *  sealed values (a copy of its run's key), when it has one. */
const queueReplay = (server, id, deadlineAt, sealed) => server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, {
  body: { input: { content: "Six times seven?" }, place: { mode: "runner" }, replay: { of: "run-0", workflow: "answer", digest: "d1", deadline_at: new Date(deadlineAt).toISOString() } },
  ...(sealed ? { sealed } : {}),
});

const ended = (server, id) => until(async () => {
  const row = await server.runs.get(id);
  return ["ended", "failed", "stopped"].includes(row?.state) && row.runner === null && row;
}, `run ${id} ended`, 10_000);

test("a learning child claimed at or past its deadline on the runner's learning clock never starts: no loop, it ends cancelled at spend 0; one whose deadline is ahead starts", async (t) => {
  const opened = await stores();
  const faux = fauxLoops();
  const hour = 60 * 60_000;
  const runner = startRunner({ store: opened.runners[0], name: "runner-a", ...TIMING, learningClock: () => Date.now() + hour, createLoop: faux.createLoop });
  t.after(async () => {
    await runner.close();
    await release(opened);
  });
  // Past it: due half an hour ago on the runner's learning clock (an hour ahead of the store's).
  await queueReplay(opened.server, "replay-late", Date.now() + hour / 2);
  const late = await ended(opened.server, "replay-late");
  assert.deepEqual([late.state, late.outcome], ["stopped", "cancelled"], JSON.stringify([late.state, late.outcome, late.summary]));
  assert.equal(late.costUsd ?? 0, 0, `nothing spent: ${late.costUsd}`);
  assert.deepEqual(faux.loops.map((loop) => loop.claim?.runId), [], "no loop started on a child past its deadline");
  // Ahead of it: started as any run is.
  await queueReplay(opened.server, "replay-due", Date.now() + 2 * hour);
  const due = await ended(opened.server, "replay-due");
  assert.equal(due.state, "ended", JSON.stringify(due));
  assert.deepEqual(faux.loops.map((loop) => loop.claim?.runId), ["replay-due"]);
});

test("a learning child whose deadline cannot be read as it is claimed is not started: its claim is given back, said, and a later claim starts it once the read answers", async (t) => {
  const opened = await stores();
  const faux = fauxLoops();
  const store = opened.runners[0];
  let unreadable = true;
  let reads = 0;
  // The runner's store, its read of the batch's deadlines failing while it names the child, until the test lets it answer.
  const runs = new Proxy(store.runs, {
    get(target, prop) {
      if (prop === "learningDeadlines") return async (ids, ...rest) => {
        if (ids.includes("replay-1")) reads++;
        if (ids.includes("replay-1") && unreadable) throw new Error("the store did not answer");
        return target.learningDeadlines(ids, ...rest);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const flaky = new Proxy(store, { get: (target, prop) => (prop === "runs" ? runs : (typeof target[prop] === "function" ? target[prop].bind(target) : target[prop])) });
  const events = [];
  const runner = startRunner({ store: flaky, name: "runner-a", ...TIMING, onEvent: (event) => events.push(event), createLoop: faux.createLoop });
  t.after(async () => {
    await runner.close();
    await release(opened);
  });
  await queueReplay(opened.server, "replay-1", Date.now() + 60 * 60_000);
  await until(async () => reads >= 3, "the child's deadline read tried on more than one claim", 10_000);
  assert.deepEqual(faux.loops.map((loop) => loop.claim?.runId), [], "no loop started on a child whose deadline was not read");
  const row = await opened.server.runs.get("replay-1");
  // Given back as the claim gate gives a claim back (store release, no state): never final.
  assert.ok(row.state === "queued" || row.state === "running", `given back for a later claim, never ended: ${JSON.stringify([row.state, row.runner])}`);
  assert.ok(events.some((event) => event.type === "error" && event.runId === "replay-1" && event.step === "learning deadline"), JSON.stringify(events.filter((event) => event.type === "error")));
  unreadable = false;
  const done = await ended(opened.server, "replay-1");
  assert.equal(done.state, "ended", JSON.stringify(done));
  assert.deepEqual(faux.loops.map((loop) => loop.claim?.runId), ["replay-1"]);
});

test("a poll's claims read their learning deadlines in one store read, never a launch read a claim: forty runs claimed, a child past its deadline among them, no launch read, and that child still ends unstarted", async (t) => {
  const opened = await stores();
  // Loops that run well past the claims: forty held at once.
  const faux = fauxLoops({ turns: 1_000, turnMs: 50 });
  const store = opened.runners[0];
  const counts = { launch: 0, deadlines: 0 };
  // A spy on the runner's store: each launch read and each read of a batch's deadlines.
  const runs = new Proxy(store.runs, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "launch") return (...args) => (counts.launch++, value.apply(target, args));
      if (prop === "learningDeadlines") return (...args) => (counts.deadlines++, value.apply(target, args));
      return value.bind(target);
    },
  });
  const spied = new Proxy(store, { get: (target, prop) => (prop === "runs" ? runs : (typeof target[prop] === "function" ? target[prop].bind(target) : target[prop])) });
  for (let i = 0; i < 39; i++) await queue(opened.server, `run-${String(i).padStart(2, "0")}`);
  await queueReplay(opened.server, "replay-late", Date.now() - 60_000);
  const runner = startRunner({ store: spied, name: "runner-a", ...TIMING, loops: 40, createLoop: faux.createLoop });
  t.after(async () => {
    await runner.close();
    await release(opened);
  });
  const late = await ended(opened.server, "replay-late");
  assert.deepEqual([late.state, late.outcome], ["stopped", "cancelled"], JSON.stringify([late.state, late.outcome, late.summary]));
  await until(() => faux.loops.length === 39, "the 39 other runs' loops started", 10_000);
  assert.equal(faux.loops.some((loop) => loop.claim?.runId === "replay-late"), false, "no loop on the child past its deadline");
  assert.equal(counts.launch, 0, `no launch read for a claim: ${counts.launch}`);
  assert.ok(counts.deadlines >= 1 && counts.deadlines <= 4, `one deadline read a poll that claimed, never one a run: ${counts.deadlines}`);
});

test("a learning child at work when its deadline comes is stopped then, never at a later poll: with a poll a minute apart, it ends cancelled within seconds of its deadline", async (t) => {
  const opened = await stores();
  // A loop at work well past the deadline: forty seconds of turns, unless it is stopped.
  const faux = fauxLoops({ turns: 800, turnMs: 50 });
  // A poll (the runner's sweep of held children) a minute apart: a run queued here is still claimed at once (claimNow).
  const runner = startRunner({ store: opened.runners[0], name: "runner-a", ...TIMING, pollMs: 60_000, createLoop: faux.createLoop });
  t.after(async () => {
    await runner.close();
    await release(opened);
  });
  const due = Date.now() + 2_000;
  await queueReplay(opened.server, "replay-busy", due);
  await until(() => faux.loops.length === 1, "the child's loop started before its deadline", 5_000);
  const done = await ended(opened.server, "replay-busy");
  assert.ok(Date.now() - due < 5_000, `stopped within seconds of its deadline, not at the next poll: ${Date.now() - due} ms after it`);
  // A faux loop's stop writes no outcome of its own: what stopped it is the cancel row its runner wrote and handed it.
  assert.equal(done.state, "stopped", JSON.stringify(done));
  const [stop] = faux.loops[0].stopCalls;
  assert.equal(stop?.kind, "command", `stopped by a command: ${JSON.stringify(faux.loops[0].stopCalls)}`);
  const row = (await opened.server.commands("replay-busy", 0)).find((one) => one.id === stop.commandId);
  assert.equal(row?.kind, "cancel", `the runner's cancel: ${JSON.stringify(row)}`);
});

test("a learning child that parks (an approval, a raise) is woken at its deadline and ends there, cancelled: never left parked past it, its copy of its run's key erased and its run's learning work ended with it", async (t) => {
  const opened = await stores();
  // Its first claim parks it, with nothing of its own to wake it; a later claim's loop would run it to its end.
  const faux = fauxLoops({ park: true });
  const runner = startRunner({ store: opened.runners[0], name: "runner-a", ...TIMING, createLoop: faux.createLoop });
  t.after(async () => {
    await runner.close();
    await release(opened);
  });
  // A keyed replay of run-0: its own sealed copy of run-0's key, and run-0's learning_work naming it.
  const sealed = sealRunLaunch(SEAL_KEY, "replay-parks", { model: { key: "not-a-secret-run-key", origin: "https://gateway.invalid" } });
  await queueReplay(opened.server, "replay-parks", Date.now() + 1_500, sealed);
  await noteLearningChild(opened.server.settings, "run-0", { run: "replay-parks", kind: "replay", at: Date.now(), keyed: true });
  await until(async () => (await opened.server.runs.get("replay-parks"))?.state === "parked", "the child parked before its deadline", 10_000);
  assert.equal((await learningWorkOf(opened.server, "run-0", NO_OWN)).state, "running", "run-0's learning work reads running while its child is parked");
  assert.notEqual((await opened.server.runs.launch("replay-parks")).sealed, null, "its copy of the key is kept while it is parked");
  const done = await ended(opened.server, "replay-parks");
  assert.deepEqual([done.state, done.outcome], ["stopped", "cancelled"], `woken at its deadline and cancelled: ${JSON.stringify([done.state, done.outcome, done.summary])}`);
  assert.deepEqual(faux.loops.map((loop) => loop.claim?.runId), ["replay-parks"], "only the claim that parked it ran a loop: the one at its deadline only ended it");
  assert.equal((await opened.server.runs.launch("replay-parks")).sealed, null, "its copy of the run's key erased by the write that ends it");
  const work = await learningWorkOf(opened.server, "run-0", NO_OWN);
  assert.deepEqual([work.state, work.runs, work.deadline_at], ["ended", [], null], `run-0's learning work ends with it: ${JSON.stringify(work)}`);
});
