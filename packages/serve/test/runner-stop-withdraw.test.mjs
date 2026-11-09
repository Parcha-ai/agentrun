// A stop withdraws the call that waits for approval in the same write that ends the run: from the first read where the
// run reads cancelled, nothing is pending and every call it asked about is answered withdrawn in its journal. Nothing
// reopens the withdrawn call: a later message or approval of the stopped run is refused, and the call is never sent.
// - Held at the end's commit (not slept), so reads land between the stop and its end.
// - A stopped end that withdraws a call and that the journal refuses (or that the journal cannot be read for) is never
//   written without the withdrawal: the runner says so by the run's name and releases the run, not final, with a backoff
//   that doubles from 5 s to a 5 min cap; the next claim only ends it (no model request, no tool), with the end and the
//   withdrawal in one commit. After 11 tries at the cap (the 18th refusal, about an hour in all) the run ends stopped on
//   its row alone, said as an error by its name.
// - A stopped end with nothing to withdraw keeps the row-only end when the journal refuses it, and a lost claim (Fenced)
//   writes nothing, as before.
// pi through the adapter loop, with a spec gate that asks about its one tool. Backoffs are read on the store's clock,
// which the test moves (no wall-clock waits).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const runnerModule = await import("../dist/runner/runner.js");
const { startRunner } = runnerModule;
// The retry's stated defaults (runner.ts endRefused): 5 s doubling to a 5 min cap, 11 tries at the cap.
const BACKOFF_MS = 5_000;
const CAP_MS = 300_000;
const AT_CAP = 11;
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { momentOverStore, viewOverStore } = await import("../dist/store-view.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { Fenced } = await import("../dist/store/index.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const DEPS = { origin: "", serverSecrets: () => [] };
const END = "agentrun.end";
const REFUSED = /^run run-1: its end with a withdrawal was refused \(try (\d+)\); retrying in (\d+) ms: /;
after(closeOpenSessions);

/** `store` with each journal's commit that carries the run's end passed through `onEnd` first (a hold, or a refusal),
 *  and each scan of its conversations through `onRead` (a read that throws). */
function watched(store, { onEnd = async () => {}, onRead = () => {} }) {
  const journalOf = (journal) =>
    new Proxy(journal, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "scanConversations") return (...args) => (onRead(), value.apply(target, args));
        if (prop !== "commit") return typeof value === "function" ? value.bind(target) : value;
        return async (...args) => {
          if (JSON.stringify(args[0] ?? null)?.includes(`"${END}"`)) await onEnd();
          return value.apply(target, args);
        };
      },
    });
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "journal") return (...args) => journalOf(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** One pi run whose model calls `add`, which its gate asks about (or, `permission` "allow", runs), on a runner whose
 *  store is `watched` with `hooks`, on the store's clock. Parked on the call unless `parks` is false; `before` is done
 *  to the queued run before its runner starts. */
async function runOf(t, hooks = {}, { permission = "ask", parks = true, before } = {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  if (before) await before(opened.server);
  const sent = [];
  const requests = [];
  const tools = { add: { name: "add", replaySafe: false, ask: false, run: async () => (sent.push("add"), "5") } };
  const script = [{ call: "add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, requests) });
  const gate = Object.assign(() => permission, { askedAs: (tool) => tool });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await base(claim, run)), gate }));
  const events = [];
  const now = () => Date.now() + opened.clock.skewMs;
  // Each claim whose loop started: a claim that only ends the run starts none.
  const starts = [];
  // The runners' polls for claimable runs (and renewals) so far: a test waits on them, never on the wall clock.
  const beats = { count: 0 };
  const counted = (deps) => {
    const made = loop(deps);
    const start = made.start.bind(made);
    made.start = (claim) => (starts.push(claim.runner), start(claim));
    return made;
  };
  /** A runner on the run's store, its loop the run's own (its model requests and its tool's runs counted as one). */
  const spawn = (name) => {
    const runner = startRunner({ store: watched(opened.runners[0], hooks), createLoop: counted, name, now, onEvent: (event) => events.push(event), onBeat: () => beats.count++, ...TIMING });
    t.after(() => runner.close());
    return runner;
  };
  const runner = spawn("runner-a");
  if (parks) await until(async () => (await opened.server.runs.get("run-1")).state === "parked", "the run parked on the call", 30_000);
  return { server: opened.server, runnerStore: opened.runners[0], runner, spawn, clock: opened.clock, now, sent, requests, events, starts, beats };
}

/** The run's journal entries as they stand. */
async function entriesOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
}

/** One read of the run, in the order the run's view reads it (its row, then its journal): its status and what it waits
 *  on, and each call it asked about with the answer its journal holds for it (null for none). */
async function read(server) {
  const view = await viewOverStore(server, "run-1", DEPS);
  const entries = await entriesOf(server);
  const answers = new Map(entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => [entry.data.callId, entry.data.decision]));
  const asked = entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => [entry.data.callId, answers.get(entry.data.callId) ?? null]);
  return { status: view.status, state: view.state, pending: view.pending, asked };
}

/** The rule at one read: a run that reads cancelled waits on nothing, and every call it asked about is withdrawn. */
function holds(seen) {
  if (seen.status !== "cancelled") return;
  assert.equal(seen.pending, null, `cancelled, yet pending: ${JSON.stringify(seen)}`);
  assert.ok(seen.asked.length > 0, JSON.stringify(seen));
  for (const [callId, decision] of seen.asked) assert.equal(decision, "withdrawn", `cancelled, yet ${callId} reads ${decision ?? "waiting"}: ${JSON.stringify(seen)}`);
}

/** Reads until the run reads cancelled, the rule held at every read. */
const cancelled = (server) =>
  until(async () => {
    const seen = await read(server);
    holds(seen);
    return seen.status === "cancelled" && seen;
  }, "the run reads cancelled", 30_000);

/** After the stop: its stop row taken, one withdrawn answer in the journal, and nothing reopens, answers or sends the call. */
async function staysWithdrawn(server, sent) {
  assert.equal((await server.runs.get("run-1")).state, "stopped");
  const stop = (await server.commands("run-1", 0)).find((row) => row.kind === "stop");
  assert.ok(stop.takenAt !== null && stop.refused === null, `the stop row was taken: ${JSON.stringify(stop)}`);
  const entries = await entriesOf(server);
  const ask = entries.find((entry) => entry.kind === "agentrun.ask")?.data;
  const answers = entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => [entry.data.callId, entry.data.decision]);
  assert.deepEqual(answers, [[ask.callId, "withdrawn"]], "the journal carries the one withdrawal");
  await assert.rejects(server.command("run-1", { kind: "steer", body: { text: "go on" } }), { name: "RunFinal" });
  await assert.rejects(server.command("run-1", { kind: "approve", body: { approval: ask.callId } }), { name: "RunFinal" });
  holds(await read(server));
  assert.deepEqual(sent, [], "the withdrawn call was never sent");
}

/** The run released after its `tries`-th refused end: not final, no runner, its backoff set; every read keeps the rule. */
async function releasedAfter(server, tries) {
  return until(async () => {
    holds(await read(server));
    const row = await server.runs.get("run-1");
    const stop = (await server.commands("run-1", 0)).find((one) => one.kind === "stop");
    return row.runner === null && row.backoffUntil !== null && stop.tries === tries && row;
  }, `the run released after refused end ${tries}`, 30_000);
}

/** The waits the runner said it retries in, by the run's name, in order. */
const waitsSaid = (events) => events.filter((event) => event.type === "error" && event.runId === "run-1" && REFUSED.test(event.message)).map((event) => Number(REFUSED.exec(event.message)[2]));

test("a stop of a run parked on a call ends it withdrawn in one write: every read that says cancelled reads nothing pending and the call withdrawn", { timeout: 60_000 }, async (t) => {
  let reached;
  const atEnd = new Promise((resolve) => (reached = resolve));
  let go;
  const held = new Promise((resolve) => (go = resolve));
  const { server, sent } = await runOf(t, { onEnd: async () => (reached(), held) });
  await server.command("run-1", { kind: "stop" });
  await atEnd;
  // Held at the end's commit: the run has taken the stop and not ended yet. Every read here keeps the rule.
  for (let i = 0; i < 5; i++) holds(await read(server));
  go();
  await cancelled(server);
  await staysWithdrawn(server, sent);
});

test("a refused stopped end of a run claimed from parked is not claimed again before its backoff: one claim and one refusal per backoff step, never a burst", { timeout: 60_000 }, async (t) => {
  const { server, clock, events, beats } = await runOf(t, { onEnd: async () => {
    throw new Error("the journal refused the end (a test's refusal)");
  } });
  // A claim and its release each move the run's epoch on by one: claims are counted by it (a retried end's claim starts
  // no loop, so it is no `claimed` event).
  const epoch = async () => (await server.runs.get("run-1")).epoch;
  // Parked under its claim, then released: counted from the release.
  await until(async () => (await server.runs.get("run-1")).runner === null, "the parked run released", 30_000);
  const parkedAt = await epoch();
  await server.command("run-1", { kind: "stop" });
  await releasedAfter(server, 1);
  assert.equal(events.filter((event) => event.type === "claimed" && event.claim.runId === "run-1").at(-1).claim.from, "parked", "the refused end's claim took the run from parked");
  assert.equal((await epoch()) - parkedAt, 2, "one claim (and its release) for the first refusal");
  // Released after its first refusal: it reads running (the branch of claimable that honours backoff_until), and through
  // 20 more polls of the runner on an unmoved clock it is claimed no more.
  assert.equal((await server.runs.get("run-1")).state, "running");
  const [at, said, polled] = [await epoch(), waitsSaid(events).length, beats.count];
  await until(() => beats.count >= polled + 20, "20 more polls", 30_000);
  assert.deepEqual([(await epoch()) - at, waitsSaid(events).length - said], [0, 0], "no claim and no refusal inside the backoff");
  // The clock past the backoff: exactly one more claim and one more refusal, then quiet again until the next step.
  clock.skewMs += BACKOFF_MS;
  await releasedAfter(server, 2);
  const polledAgain = beats.count;
  await until(() => beats.count >= polledAgain + 20, "20 more polls", 30_000);
  assert.deepEqual([(await epoch()) - at, waitsSaid(events).length - said], [2, 1], "one claim (and its release) and one refusal for the step");
});

test("a stop whose end the journal refuses never leaves the run cancelled with its call waiting: it is released with a backoff, said by name, and the next claim only ends it, withdrawn", { timeout: 60_000 }, async (t) => {
  let refusing = false;
  const { server, clock, now, sent, requests, events, starts } = await runOf(t, { onEnd: async () => {
    if (refusing) throw new Error("the journal refused the end (a test's refusal)");
  } });
  refusing = true;
  await server.command("run-1", { kind: "stop" });
  const released = await releasedAfter(server, 1);
  assert.deepEqual(waitsSaid(events), [BACKOFF_MS], "said by the run's name, with its wait");
  assert.ok(released.backoffUntil > now() && released.backoffUntil <= now() + BACKOFF_MS, `backoff ${released.backoffUntil - now()} ms`);
  assert.notEqual(released.state, "stopped", "not final while its end is refused");
  const [asked, loops] = [requests.length, starts.length];
  refusing = false;
  clock.skewMs += BACKOFF_MS;
  await cancelled(server);
  await staysWithdrawn(server, sent);
  assert.equal(requests.length, asked, "the retried claim made no model request");
  assert.equal(starts.length, loops, "the retried claim started no loop");
});

test("a journal that never takes the stopped end: the backoff doubles from 5 s to its 5 min cap, each try said by name, and after 11 tries at the cap the run ends stopped on its row alone with one error naming it", { timeout: 120_000 }, async (t) => {
  assert.deepEqual([runnerModule.END_RETRY_BACKOFF_MS, runnerModule.END_RETRY_CAP_MS, runnerModule.END_RETRY_AT_CAP], [BACKOFF_MS, CAP_MS, AT_CAP], "the stated defaults");
  const { server, clock, sent, requests, events } = await runOf(t, { onEnd: async () => {
    throw new Error("the journal refused the end (a test's refusal)");
  } });
  await server.command("run-1", { kind: "stop" });
  const expected = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, ...Array(AT_CAP).fill(CAP_MS)];
  let asked;
  for (let tries = 1; tries <= expected.length; tries++) {
    await releasedAfter(server, tries);
    asked ??= requests.length;
    assert.deepEqual(waitsSaid(events), expected.slice(0, tries), `the waits said through try ${tries}`);
    clock.skewMs += expected[tries - 1];
  }
  // The 18th refusal gives up: the run ends stopped on its row alone, and one error names it and why.
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "stopped" && now;
  }, "the run ended at the give-up", 30_000);
  assert.equal(row.backoffUntil, null);
  const gaveUp = events.filter((event) => event.type === "error" && event.runId === "run-1" && event.message.startsWith("run run-1 ended without withdrawing: journal unreadable or refusing"));
  assert.equal(gaveUp.length, 1, JSON.stringify(events.filter((event) => event.type === "error").map((event) => event.message).slice(-3)));
  assert.equal((await read(server)).status, "cancelled");
  // No reader of the final run says its call waits: the view has nothing pending, no timeline row reads waiting or
  // asked, and the run's moment (what an answer to an approval is checked against) names no approval waiting.
  const view = await viewOverStore(server, "run-1", DEPS);
  assert.equal(view.pending, null);
  const rows = await runTimeline(server, "run-1", BACKGROUND_CONTEXT);
  const waiting = rows.filter((one) => /Waiting for your approval|Asked your approval|waits for your approval/.test(`${one.summary ?? ""} ${one.text ?? ""}`));
  assert.deepEqual(waiting, [], "no timeline row reads waiting");
  const moment = await momentOverStore(server, "run-1");
  assert.equal(moment.waitingApprovalId, undefined, "no approval waits");
  assert.equal(requests.length, asked, "no claim after the first made a model request");
  assert.deepEqual(sent, [], "the call was never sent");
});

test("a journal that cannot be read when the stop ends the run: the run is released with a backoff, not ended, and once it reads again the next claim ends it withdrawn", { timeout: 60_000 }, async (t) => {
  // The loop's own end is refused too, so the runner ends the run itself (endRun), whose read of the journal throws.
  let unreadable = false;
  const { server, clock, sent, requests, events } = await runOf(t, {
    onRead: () => {
      if (unreadable) throw new Error("the journal could not be read (a test's failure)");
    },
    onEnd: async () => {
      if (unreadable) throw new Error("the journal refused the end (a test's refusal)");
    },
  });
  unreadable = true;
  await server.command("run-1", { kind: "stop" });
  await releasedAfter(server, 1);
  assert.deepEqual(waitsSaid(events), [BACKOFF_MS]);
  const asked = requests.length;
  unreadable = false;
  clock.skewMs += BACKOFF_MS;
  await cancelled(server);
  await staysWithdrawn(server, sent);
  assert.equal(requests.length, asked, "the retried claim made no model request");
});

test("a stop row whose tries a failed resume raised is a stop all the same: the next claim only ends the run, withdrawn, with no model request and no tool run", { timeout: 60_000 }, async (t) => {
  const { server, runnerStore, runner, spawn, clock, now, sent, requests, starts } = await runOf(t);
  await runner.close();
  const stop = await server.command("run-1", { kind: "stop" });
  // As a resume that threw counts its waking row (runner.ts resumeFailed: store.retry, then a parked release with a
  // backoff), here on the stop row.
  const claim = await runnerStore.claim("run-1", "resume-failed", { leaseMs: 60_000 });
  assert.equal(await runnerStore.retry(claim, stop.id), 1);
  await runnerStore.release(claim, { state: "parked", backoffUntil: now() + BACKOFF_MS });
  const asked = requests.length;
  spawn("runner-b");
  clock.skewMs += BACKOFF_MS;
  await cancelled(server);
  await staysWithdrawn(server, sent);
  assert.equal(requests.length, asked, "the claim after the failed resume made no model request");
  assert.ok(!starts.includes("runner-b"), "the claim after the failed resume started no loop: it only ended the run");
});

test("a stopped end with no call to withdraw still ends stopped on the run's row alone when the journal refuses it, with no backoff", { timeout: 60_000 }, async (t) => {
  // Stopped before it is claimed, its one call allowed: nothing waits for an answer when its end is refused.
  const { server, events } = await runOf(t, { onEnd: async () => {
    throw new Error("the journal refused the end (a test's refusal)");
  } }, { permission: "allow", parks: false, before: (server) => server.command("run-1", { kind: "stop" }) });
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "stopped" && now;
  }, "the run ended stopped", 30_000);
  assert.equal(row.backoffUntil, null);
  assert.deepEqual(waitsSaid(events), [], "no retry");
  assert.equal((await read(server)).status, "cancelled");
  assert.deepEqual((await entriesOf(server)).filter((entry) => entry.kind === "agentrun.answer"), []);
});

test("a stopped end whose claim was lost (Fenced) writes nothing and is not retried here, as before", { timeout: 60_000 }, async (t) => {
  let fencing = false;
  const { server, events } = await runOf(t, { onEnd: async () => {
    if (fencing) throw new Fenced("run-1", 0);
  } });
  fencing = true;
  await server.command("run-1", { kind: "stop" });
  await until(() => events.some((event) => event.type === "error" && event.runId === "run-1" && /fenced/.test(event.step)), "the runner said the end was fenced", 30_000);
  const row = await server.runs.get("run-1");
  assert.notEqual(row.state, "stopped", JSON.stringify(row));
  assert.equal(row.backoffUntil, null);
  assert.equal((await server.commands("run-1", 0)).find((one) => one.kind === "stop").tries, 0);
  assert.deepEqual(waitsSaid(events), []);
});
