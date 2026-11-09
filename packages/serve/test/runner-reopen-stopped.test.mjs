// A person's stop of an agentic run ends its turn, never the run, as main's does: main's statusOf reads a stopped run
// input_required and idle (runs.ts: `if (stopped(run)) return { status: "input_required", state: "idle" }`), writes no end
// for it, and a message to it is the run's next turn (message(): run.followUpOpen, then a follow-up). Here the runner
// ends the stopped turn with an end that says a person stopped it (outcome 'stopped'), the run reads as main's does, and a
// person's message reopens it (runs.reopen) and runs as a new turn of the same conversation. A cancel ends the run for
// good: it reads cancelled and takes no message. A drain or a shutdown is no person's stop: it writes no end, and the run
// goes on through its next claim, never through a reopen.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore, RunFinal } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore, momentOverStore } = await import("../dist/store-view.js");
const { message } = await import("../dist/runs-over-store.js");
const { emptyState, STOPPED_BY_YOU, translate } = await import("../dist/live/translate.js");
const { timelineReducer } = await import("@parcha/pi-durable-agent/timeline");
after(closeOpenSessions);

/** The run's live timeline rows, as the live stream folds its journal's commits (the conformance suite's liveRows). */
async function liveRows(server) {
  const row = await server.runs.get(RUN);
  const journal = server.journal({ runId: RUN, runner: "test-reader", epoch: row.epoch, until: 0, from: row.state });
  const state = emptyState();
  const reducer = timelineReducer();
  for (let after_ = 0; ; ) {
    const page = await journal.commitsAfter(after_, 500, context);
    for (const commit of page.commits) reducer.apply(translate(state, commit));
    if (page.next === undefined) break;
    after_ = page.next;
  }
  return reducer.rows();
}

const RUN = "run-1";
const VIEW_DEPS = { origin: "", serverSecrets: () => [] };
/** The model's price on the route: an unpriced model is never sent under a cap. */
const COST = { input: 0, output: 50, cacheRead: 0, cacheWrite: 0 };

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A route whose requests numbered in `stallAt` (1 for the first) stay open until aborted, and whose every other request
 *  answers with the next of `answers`. `sent(n)` resolves once request n is sent (`inFlight`: the first one held);
 *  `requests`: the bodies asked. */
function stalling(stallAt = [1], answers = ["Second answer.", "Third answer.", "Fourth answer."]) {
  const requests = [];
  const said = [];
  const waiting = new Map();
  const sent = (n) => {
    if (requests.length >= n) return Promise.resolve();
    if (!waiting.has(n)) waiting.set(n, Promise.withResolvers());
    return waiting.get(n).promise;
  };
  const fetch = async (url, init = {}) => {
    requests.push(JSON.parse(String(init.body ?? "{}")));
    const n = requests.length;
    waiting.get(n)?.resolve();
    if (!stallAt.includes(n)) {
      const text = answers[said.length] ?? answers.at(-1);
      said.push(text);
      return scriptedOrigin([{ say: text }])(url, { ...init, body: JSON.stringify({ ...JSON.parse(String(init.body ?? "{}")), messages: [] }) });
    }
    return await new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  return { fetch, requests, said, sent, inFlight: sent(stallAt[0] ?? 1) };
}

/** A pi run through a runner, its requests in `stallAt` held open; the server's store, the runner and the route. */
async function runner(t, stallAt = [1], answers) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-reopen-stopped-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly." } });
  const launch = { input: { content: "First question." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, max_cost_usd: 5 };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const origin = stalling(stallAt, answers);
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `routecredential${"r".repeat(12)}` }, fetch: origin.fetch, price: () => 0.1, cost: COST, outputCeiling: 1_000 };
  const start = async (name) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
    const running = startRunner({
      store, name, ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
      createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (harness, given) => (harness === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
    });
    t.after(() => running.close().catch(() => {}));
    return running;
  };
  const first = await start("runner-a");
  return { server, origin, first, start };
}

/** The run's row once no runner holds it and it has left running (or `state` when named). */
const settled = (server, state) => until(async () => {
  const row = await server.runs.get(RUN);
  return (state ? row.state === state : ["ended", "failed", "stopped", "parked"].includes(row.state)) && row.runner === null && row;
}, `the run settles${state ? ` ${state}` : ""}`);

test("a person's stop ends the turn, not the run: it reads input_required and idle, its timeline says it was stopped and never that it ended, and a message runs as its next turn", { timeout: 120_000 }, async (t) => {
  const { server, origin } = await runner(t);
  await origin.inFlight;
  await sendCommand(server, RUN, { kind: "stop", body: {} });
  const stopped = await settled(server);
  assert.deepEqual([stopped.state, stopped.outcome], ["stopped", "stopped"], `a person's stop, said so in the store: ${JSON.stringify(stopped)}`);

  // GET /runs/{id}: main's status for a stopped run, never cancelled, with nothing of an end.
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.deepEqual(
    { status: view.status, state: view.state, ended_at: view.ended_at, result: view.result, error: view.error, poll_after_ms: view.poll_after_ms },
    { status: "input_required", state: "idle", ended_at: null, result: null, error: null, poll_after_ms: 1000 },
    `the run waits for its person: ${JSON.stringify(view)}`,
  );
  const moment = await momentOverStore(server, RUN);
  assert.deepEqual([moment.cancelled, moment.terminal], [false, false], "its moment is neither cancelled nor over");
  // Its live timeline: one row says the person stopped it (the conformance stop case's row). Neither it nor the served
  // timeline (GET /runs/{id}/timeline's rows) has a row saying the run ended or was cancelled.
  const live = await liveRows(server);
  const liveSaid = live.map((row) => [row.kind, row.summary ?? row.text ?? ""]);
  assert.deepEqual(live.filter((row) => row.summary === STOPPED_BY_YOU).map((row) => row.kind), ["phase"], `one row says the person stopped it: ${JSON.stringify(liveSaid)}`);
  const served = (await runTimeline(server, RUN, context, { settled: false })).map((row) => [row.kind, row.summary ?? row.text ?? ""]);
  for (const [which, said] of [["live", liveSaid], ["served", served]]) {
    assert.deepEqual(said.filter(([kind, text]) => /end|cancel/i.test(kind) || /cancel|run (has )?ended|is over/i.test(text)), [], `no ${which} row says the run is over: ${JSON.stringify(said)}`);
  }

  // A person's message: a follow-up that reopens the run, run as its next turn in the same conversation.
  const sent = await message(server, moment, "Second question.");
  assert.equal(sent.mode, "follow_up");
  const ended = await settled(server, "ended");
  assert.equal(origin.requests.length, 2, `the message was asked of the model as a new turn: ${origin.requests.length} requests`);
  const asked = JSON.stringify(origin.requests[1].messages);
  assert.ok(asked.includes("First question.") && asked.includes("Second question."), `the new turn carries the conversation and the message: ${asked.slice(0, 400)}`);
  assert.equal(ended.outcome, null, "it ended as a run that completed");
  const commands = await server.commands(RUN, 0);
  assert.ok(commands.every((row) => row.takenAt !== null && row.refused === null), `the stop and the message were taken, not refused: ${JSON.stringify(commands)}`);
  const after_ = (await runTimeline(server, RUN, context, { settled: true })).map((row) => row.text ?? row.summary ?? "").join("\n");
  assert.ok(after_.indexOf(STOPPED_BY_YOU) < after_.indexOf("Second question.") && after_.indexOf("Second question.") < after_.indexOf("Second answer."), `in order:\n${after_}`);
});

test("a cancel ends the run for good: it reads cancelled, and a message is refused with nothing written", { timeout: 120_000 }, async (t) => {
  const { server, origin } = await runner(t);
  await origin.inFlight;
  await sendCommand(server, RUN, { kind: "cancel", body: {} });
  const cancelled = await settled(server);
  assert.deepEqual([cancelled.state, cancelled.outcome], ["stopped", "cancelled"], `a cancel, said so in the store: ${JSON.stringify(cancelled)}`);
  const view = await viewOverStore(server, RUN, VIEW_DEPS);
  assert.deepEqual([view.status, view.state], ["cancelled", "idle"]);
  const moment = await momentOverStore(server, RUN);
  assert.deepEqual([moment.cancelled, moment.terminal], [true, true]);
  const rows = (await server.commands(RUN, 0)).length;
  await assert.rejects(message(server, moment, "Go on."), (e) => e.code === "not_continuable" && e.status === 409 && /was cancelled/.test(e.message), "a cancelled run takes no message");
  await assert.rejects(server.runs.reopen(RUN, { kind: "steer", body: { text: "Go on." } }), (e) => e instanceof RunFinal);
  assert.equal((await server.commands(RUN, 0)).length, rows, "nothing written");
  assert.equal(origin.requests.length, 1, "no turn ran");
});

test("a drain is no person's stop: the run is let go running, with no end; it is not reopened, and its next claim goes on with it", { timeout: 120_000 }, async (t) => {
  const { server, origin, first, start } = await runner(t);
  await origin.inFlight;
  await first.close();
  const let_ = await server.runs.get(RUN);
  assert.deepEqual([let_.state, let_.outcome, let_.runner], ["running", null, null], `let go running, no end written: ${JSON.stringify(let_)}`);
  await assert.rejects(server.runs.reopen(RUN, { kind: "steer", body: { text: "Go on." } }), (e) => e instanceof RunFinal, "never reopened: it is not over");
  await start("runner-b");
  const ended = await settled(server, "ended");
  assert.equal(ended.outcome, null);
  assert.ok(origin.requests.length >= 2, `its next claim asked the model again: ${origin.requests.length} requests`);
});

/** The run once it has ended again after `previous` (a later ended_at), released. */
const endedAfter = (server, previous) => until(async () => {
  const row = await server.runs.get(RUN);
  return row.state === "ended" && row.runner === null && row.endedAt !== null && (previous === undefined || row.endedAt > previous.endedAt) && row;
}, "the run ends again");

/** The text of the newest person message a request carried. */
const lastAsked = (request) => JSON.stringify(request.messages.filter((m) => m.role === "user").at(-1) ?? null);

test("a run a person stopped takes every later message as a turn of its own: the second message after the first one's turn ended runs too", { timeout: 120_000 }, async (t) => {
  const { server, origin } = await runner(t);
  await origin.inFlight;
  await sendCommand(server, RUN, { kind: "stop", body: {} });
  await settled(server, "stopped");
  await message(server, await momentOverStore(server, RUN), "Second question.");
  const second = await endedAfter(server);
  assert.equal(origin.requests.length, 2);
  await message(server, await momentOverStore(server, RUN), "Third question.");
  const third = await endedAfter(server, second);
  assert.deepEqual([third.state, third.outcome], ["ended", null], `it ended as a completed run, never failed: ${JSON.stringify(third)}`);
  assert.equal(origin.requests.length, 3, `the third question was asked as a turn of its own: ${origin.requests.length} requests`);
  assert.match(lastAsked(origin.requests[2]), /Third question\./);
  const commands = await server.commands(RUN, 0);
  assert.ok(commands.every((row) => row.takenAt !== null && row.refused === null), `every message was taken, none refused: ${JSON.stringify(commands)}`);
});

test("a drain while a reopened stopped run's message is in its turn: the next claim goes on with that turn and answers it", { timeout: 120_000 }, async (t) => {
  const { server, origin, first, start } = await runner(t, [1, 2], ["Second answer."]);
  await origin.inFlight;
  await sendCommand(server, RUN, { kind: "stop", body: {} });
  await settled(server, "stopped");
  await message(server, await momentOverStore(server, RUN), "Second question.");
  await origin.sent(2);
  await first.close();
  const let_ = await server.runs.get(RUN);
  assert.deepEqual([let_.state, let_.runner], ["running", null], `let go with the message's turn open: ${JSON.stringify(let_)}`);
  await start("runner-b");
  const ended = await endedAfter(server);
  assert.deepEqual([ended.state, ended.outcome], ["ended", null], `it ended with the message's answer, never cut: ${JSON.stringify(ended)}`);
  assert.ok(origin.requests.length >= 3, `the next claim asked the model the message again: ${origin.requests.length} requests`);
  assert.match(lastAsked(origin.requests.at(-1)), /Second question\./);
  assert.deepEqual(origin.said, ["Second answer."], "the message's turn was answered once");
  const said = (await runTimeline(server, RUN, context, { settled: true })).map((row) => row.text ?? row.summary ?? "").join("\n");
  assert.ok(said.includes("Second answer."), `the answer is on the timeline:\n${said}`);
});

test("a drain while a reopened completed run's message is in its turn: the next claim goes on with that turn and answers it", { timeout: 120_000 }, async (t) => {
  const { server, origin, first, start } = await runner(t, [2], ["First answer.", "Second answer."]);
  const done = await endedAfter(server);
  assert.equal(origin.requests.length, 1);
  await message(server, await momentOverStore(server, RUN), "Second question.");
  await origin.sent(2);
  await first.close();
  await start("runner-b");
  const ended = await endedAfter(server, done);
  assert.deepEqual([ended.state, ended.outcome], ["ended", null], `it ended with the message's answer, never cut: ${JSON.stringify(ended)}`);
  assert.ok(origin.requests.length >= 3, `the next claim asked the model the message again: ${origin.requests.length} requests`);
  assert.match(lastAsked(origin.requests.at(-1)), /Second question\./);
  assert.deepEqual(origin.said, ["First answer.", "Second answer."], "the message's turn was answered once, on the next claim");
});
