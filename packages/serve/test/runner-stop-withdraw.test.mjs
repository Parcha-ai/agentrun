// A stop withdraws the call that waits for approval in the same write that ends the run: from the first read where the
// run reads cancelled, nothing is pending and every call it asked about is answered withdrawn in its journal. Nothing
// reopens the withdrawn call: a later message or approval of the stopped run is refused, and the call is never sent. Held
// at the end's commit (not slept), so reads land between the stop and its end; and with the end's journal commit refused,
// so the runner's own end, when the journal will not take it, is held to the same rule. pi through the adapter loop, with
// a spec gate that asks about its one tool.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { viewOverStore } = await import("../dist/store-view.js");
const STEADY = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
// A lease short enough that a claim left unreleased lapses within the test, renewed well inside it.
const SHORT = { leaseMs: 1_500, renewEveryMs: 300, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const DEPS = { origin: "", serverSecrets: () => [] };
const END = "agentrun.end";
after(closeOpenSessions);

/** `store` with each journal's commit that carries the run's end passed through `onEnd` first (a hold, or a refusal). */
function endWatched(store, onEnd) {
  const watched = (journal) =>
    new Proxy(journal, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
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
      if (prop === "journal") return (...args) => watched(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** One pi run whose model calls `add`, which its gate asks about, parked on that call; its runner's store's end commits
 *  passed through `onEnd`, on `timing`. */
async function parkedRun(t, onEnd, timing = STEADY) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const sent = [];
  const tools = { add: { name: "add", replaySafe: false, ask: false, run: async () => (sent.push("add"), "5") } };
  const script = [{ call: "add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, []) });
  const gate = Object.assign(() => "ask", { askedAs: (tool) => tool });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await base(claim, run)), gate }));
  const runner = startRunner({ store: endWatched(opened.runners[0], onEnd), createLoop: loop, name: "runner-a", ...timing });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).state === "parked", "the run parked on the call", 30_000);
  return { server: opened.server, sent };
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
  return { status: view.status, pending: view.pending, asked };
}

/** The rule at one read: a run that reads cancelled waits on nothing, and every call it asked about is withdrawn. */
function holds(seen) {
  if (seen.status !== "cancelled") return;
  assert.equal(seen.pending, null, `cancelled, yet pending: ${JSON.stringify(seen)}`);
  assert.ok(seen.asked.length > 0, JSON.stringify(seen));
  for (const [callId, decision] of seen.asked) assert.equal(decision, "withdrawn", `cancelled, yet ${callId} reads ${decision ?? "waiting"}: ${JSON.stringify(seen)}`);
}

/** Reads until the run reads cancelled, the rule held at every read. */
const cancelled = (server, ms) =>
  until(async () => {
    const seen = await read(server);
    holds(seen);
    return seen.status === "cancelled" && seen;
  }, "the run reads cancelled", ms);

/** After the stop: one withdrawn answer in the journal, and nothing reopens, answers or sends the call. */
async function staysWithdrawn(server, sent) {
  assert.equal((await server.runs.get("run-1")).state, "stopped");
  const entries = await entriesOf(server);
  const ask = entries.find((entry) => entry.kind === "agentrun.ask")?.data;
  const answers = entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => [entry.data.callId, entry.data.decision]);
  assert.deepEqual(answers, [[ask.callId, "withdrawn"]], "the journal carries the one withdrawal");
  await assert.rejects(server.command("run-1", { kind: "steer", body: { text: "go on" } }), { name: "RunFinal" });
  await assert.rejects(server.command("run-1", { kind: "approve", body: { approval: ask.callId } }), { name: "RunFinal" });
  holds(await read(server));
  assert.deepEqual(sent, [], "the withdrawn call was never sent");
}

test("a stop of a run parked on a call ends it withdrawn in one write: every read that says cancelled reads nothing pending and the call withdrawn", { timeout: 60_000 }, async (t) => {
  let reached;
  const atEnd = new Promise((resolve) => (reached = resolve));
  let go;
  const held = new Promise((resolve) => (go = resolve));
  const { server, sent } = await parkedRun(t, async () => (reached(), held));
  await server.command("run-1", { kind: "stop" });
  await atEnd;
  // Held at the end's commit: the run has taken the stop and not ended yet. Every read here keeps the rule.
  for (let i = 0; i < 5; i++) holds(await read(server));
  go();
  await cancelled(server, 30_000);
  await staysWithdrawn(server, sent);
});

test("a stop whose end the journal refuses never leaves the run cancelled with its call waiting: the next claim ends it withdrawn", { timeout: 60_000 }, async (t) => {
  // The loop's end and then the runner's own end are refused; the next end the journal is asked for is taken.
  let refusals = 0;
  let refusing = false;
  const { server, sent } = await parkedRun(t, async () => {
    if (refusing && refusals < 2) throw new Error(`the journal refused end ${++refusals} (a test's refusal)`);
  }, SHORT);
  refusing = true;
  await server.command("run-1", { kind: "stop" });
  await cancelled(server, 30_000);
  assert.equal(refusals, 2, "both ends were refused before the run ended");
  await staysWithdrawn(server, sent);
});
