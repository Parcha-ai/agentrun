// A learning child (a check's replay run, an audit's shadow run) carries its deadline in its launch (its replay's or
// audit's deadline_at): the bound its run's caller was promised (learning_work.deadline_at), past which none of it may
// spend on the run's key. Its runner reads that deadline as it claims the child, before any loop starts on it:
//   - a child claimed at or past its deadline on the runner's learning clock never starts: no loop is made, and it ends
//     cancelled as a person's cancel ends an unstarted run, at spend 0;
//   - a child whose deadline cannot be read is not started either: its claim is given back, said on the runner's events,
//     and a later claim reads it again (and starts it once the read answers and its deadline is ahead);
//   - a child whose deadline is ahead starts as any run does;
//   - a poll's claims read their deadlines in one store read (store.runs.learningDeadlines), never a launch read a claim.
// The runner's loops are faux (runner-support.mjs fauxLoops): a loop made is a loop started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxLoops, queue, release, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };

/** A replay run `id` of a check, its deadline `deadlineAt` (ms), queued on the server's store. */
const queueReplay = (server, id, deadlineAt) => server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, {
  body: { input: { content: "Six times seven?" }, place: { mode: "runner" }, replay: { of: "run-0", workflow: "answer", digest: "d1", deadline_at: new Date(deadlineAt).toISOString() } },
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

