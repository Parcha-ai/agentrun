// An approved call and a lost claim, through the adapter loop. The contract (tool-gate.ts, answerApproval): allow runs
// the call once; a read the runner lost mid-call may run again on its next claim; a call with a side effect never does.
// Each case: the person allows a call set to ask, and while it runs, the runner's renews fail and its claim runs out at
// its deadline (not-renewed, on the clock the test moves, so no stall of a loaded machine decides it). The run is claimed
// again at the next epoch. A call with a side effect (replay never) ran once, on pi and on a CLI harness, and the next
// claim answers it interrupted. A read (replay safe) runs again on pi, by design: the server's own web_fetch is dialled
// twice and its result recorded once. Either way the lapse is recorded: run_attempts cuts the lost claim's attempt
// lease_lapse, and the claim that took over names it as its cause.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { hostToolsOf } from "./host-tools-of.mjs";
import { fakeClock, observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { callsOf, journalRecords } = await import("../dist/runner/journal-reader.js");
const { replayOf } = await import("../dist/tool-list.js");
const { webFetchTool } = await import("../dist/web-fetch.js");
const { FAUX_WEB_ENV } = await import("../dist/web-fetch-direct.js");
const { FAUX_ENV } = await import("../dist/model.js");

// A lease no stall of a loaded machine runs out: the claim is lost only where the case loses it, at the deadline on the
// runner's clock the case moves. The renew tick is short; only the lease is long.
const TIMING = { ...STEADY_LEASE, renewEveryMs: 100, pollMs: 20, commandPollMs: 20 };
const WAIT_MS = 15_000;
const PAGE = "http://public.example/";
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);
// The web_fetch case's log and hold files.
const WEB_DIR = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "approved-call-lapse-"));
after(() => rmSync(WEB_DIR, { recursive: true, force: true }));

/** A pi run whose suite tool `name` (set to ask) holds its approved call until `letGo()` or its signal ends it.
 *  `ran()` counts its runs; `requests` keeps what the model was sent. */
function heldOnPi(name, replaySafe) {
  let letGo = () => {};
  const gate = new Promise((resolve) => (letGo = resolve));
  const tool = {
    name,
    replaySafe,
    ask: true,
    ran: 0,
    run: async (_args, signal) => {
      tool.ran += 1;
      await Promise.race([gate, new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      return `${name} done`;
    },
  };
  const requests = [];
  const spec = piAdapterSpec({ script: [{ call: name }, { say: "done" }], tools: { [name]: tool }, hooks: quiet }, { requests });
  return { name, spec, requests, ran: () => tool.ran, running: () => tool.ran === 1, letGo: () => letGo() };
}

/** A pi run whose model calls the server's own web_fetch (set to ask) on the tool gate's fake network: each page it
 *  dials is appended to a log, and a fetch of `<PAGE>?hold` waits until the hold file exists, then answers as PAGE does.
 *  Each claim gets its own web_fetch, on its own environment, as each claim's run does (so no page cache spans them). */
function webFetchOnPi(t) {
  const dir = mkdtempSync(join(WEB_DIR, "case-"));
  const log = join(dir, "dialled.txt");
  const hold = join(dir, "hold");
  // The fake network's module reads its log and hold from this process's environment.
  process.env.FAUX_WEB_LOG = log;
  process.env.FAUX_WEB_HOLD = hold;
  // A held fetch waits on the hold file whatever its signal says: the file is written before the case ends, and its
  // directory goes once every run is closed (WEB_DIR).
  t.after(() => {
    writeFileSync(hold, "");
    delete process.env.FAUX_WEB_LOG;
    delete process.env.FAUX_WEB_HOLD;
  });
  const requests = [];
  const base = piAdapterSpec({ script: [{ call: "web_fetch", args: { url: `${PAGE}?hold` } }, { say: "done" }], tools: {}, hooks: quiet }, { requests });
  const fauxWeb = new URL("./fixtures/faux-gate-web.mjs", import.meta.url).pathname;
  const spec = async (claim, run) => {
    const given = await base(claim, run);
    const env = { [FAUX_ENV]: "1", [FAUX_WEB_ENV]: fauxWeb };
    const tools = hostToolsOf({}, ["web_fetch"], BACKGROUND_CONTEXT, new Map(), [webFetchTool(env)]);
    assert.equal(tools.length, 1, "the run offers web_fetch");
    return { ...given, session: { ...given.session, tools }, gate: (call) => (call.tool === "web_fetch" ? "ask" : "allow") };
  };
  const dials = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { name: "web_fetch", spec, requests, dials, running: () => existsSync(`${hold}.waiting`), letGo: () => writeFileSync(hold, "") };
}

/** A CLI harness's run: a stand-in that calls its tool through the host's gate, as every CLI adapter's tool bridge does.
 *  Its host tool `name` (replay never, set to ask) holds its approved call until `letGo()` or its signal ends it. Like a
 *  CLI it keeps a resume log: a session opened after its turn was sent and never answered finds the turn open, and its
 *  recover() issues the same call again under the same id. `answers` keeps what each issue was answered. */
function heldOnCli(name) {
  let letGo = () => {};
  const gate = new Promise((resolve) => (letGo = resolve));
  let ran = 0;
  const answers = [];
  const host = {
    name,
    description: "Send it.",
    inputSchema: { type: "object" },
    replay: "never",
    call: async (_args, { signal }) => {
      ran += 1;
      await Promise.race([gate, new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      return { text: "sent" };
    },
  };
  const adapter = {
    id: "stand-in-cli",
    check: () => [],
    async open(spec, io) {
      const kept = await io.writer.read();
      const sentBefore = kept.some((record) => record.kind === "stand-in.sent");
      let state = !sentBefore ? "new" : !kept.some((record) => record.kind === "stand-in.done") ? "open_turn" : "idle";
      let turn;
      const closing = new AbortController();
      const callTurn = async () => {
        const call = { callId: "toolu_cli_1", tool: name, args: { to: "ops@example.com" } };
        const answer = await io.gate(call);
        if (answer !== "allow" && !("deny" in answer)) {
          await new Promise((resolve) => closing.signal.addEventListener("abort", resolve, { once: true }));
          return { status: "aborted" };
        }
        const result = answer === "allow" ? await spec.tools.find((tool) => tool.name === name).call(call.args, { callId: call.callId, signal: io.signal }) : { text: answer.deny, isError: true };
        answers.push(result);
        await io.writer.append([{ kind: "stand-in.done", data: null }]);
        io.onEvent({ type: "text", delta: `It said ${result.text}.` });
        io.onEvent({ type: "turn_end", status: "completed" });
        return { status: "completed" };
      };
      return {
        get state() { return state; },
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          state = "idle";
          turn = callTurn();
        },
        async recover() {
          state = "idle";
          turn = callTurn();
        },
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() {
          closing.abort();
          await turn?.catch(() => undefined);
        },
      };
    },
  };
  const spec = async () => ({
    adapter,
    session: { key: "root", label: "root", system: [], tools: [host], context: "fresh" },
    input: "Send it.",
    record: "loop",
    hooks: quiet,
    gate: (call) => (call.tool === name ? "ask" : "allow"),
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
  });
  return { name, spec, answers, ran: () => ran, running: () => ran === 1, letGo: () => letGo() };
}

/** The text of each tool result the model was handed in `body` (an Anthropic Messages request). */
const toolResultsIn = (body) =>
  (body?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "tool_result")
    .map((part) => (typeof part.content === "string" ? part.content : (part.content ?? []).map((each) => each.text ?? "").join("")));

/** run-1 on `held.spec` calls `held.name` (set to ask), parks, and is allowed; the call runs (`held.running()`), and
 *  while it runs the runner's claim runs out unrenewed. Then the call is let go (its end refused by the fence), and the
 *  run is claimed again (the store's clock past the lost claim's until) and ends. Returns the ask, the lost epoch, the
 *  run's attempts, and its calls and answers as its journal keeps them. */
async function lapsedWhileItRuns(t, held) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const record = recorder();
  const clock = fakeClock();
  const events = [];
  const createLoop = createAdapterLoop(held.spec, { restartLimit: MAX_RESTARTS });
  // The runner's store, recording (observed: its renews refused while the case says so), with its run_attempts' word for
  // a lapse (runner.ts loseClaim), as the server's runner has it.
  const store = { ...observed(opened.runners[0], record), runAttempts: opened.runners[0].runAttempts };
  const runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING, clock, onEvent: (event) => events.push(event) });
  t.after(async () => {
    held.letGo();
    await runner.close();
  });
  const settled = (state) => until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === state && row.runner === null && row;
  }, `the run ${state} and released`, WAIT_MS);
  const read = async () => {
    const row = await opened.server.runs.get("run-1");
    return journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  };
  const answersIn = (records) => records.entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => [entry.data.callId, entry.data.decision]);

  await settled("parked");
  const [ask] = (await read()).entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.equal(ask?.tool, held.name, "the call waits for its person");
  assert.equal(held.running(), false, "nothing ran while it waits");
  await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: ask.callId } });
  await until(() => held.running(), "the approved call runs", WAIT_MS);
  const lost = events.filter((event) => event.type === "claimed").at(-1).claim.epoch;
  assert.deepEqual(answersIn(await read()), [[ask.callId, "allow"]], "the person's allow is on the record before the call's end is");

  // Every renew fails from here (the store busy), and the runner's deadline passes: its claim is lost while the call runs,
  // its end not yet recorded.
  record.blockRenew.add("runner-a");
  clock.advance(TIMING.leaseMs);
  const loss = await until(() => events.find((event) => event.type === "claim-lost" && event.epoch === lost), "the runner loses its claim at its deadline", WAIT_MS);
  assert.equal(loss.why, "not-renewed", "lost unrenewed, at its deadline");
  await until(async () => (await opened.server.runAttempts.forRun("run-1")).find((attempt) => attempt.epoch === lost && attempt.cut === "lease_lapse"), "the lost claim's attempt is cut lease_lapse", WAIT_MS);

  // The first run of the call may go on (a lost claim's work in flight is not recalled): let it end now, its end refused
  // by the fence. Renews work again, and the store's clock passes the lost claim's until: the run is claimed again.
  held.letGo();
  record.blockRenew.delete("runner-a");
  opened.clock.skewMs = TIMING.leaseMs * 2;
  await settled("ended");
  const records = await read();
  return { ask, lost, attempts: await opened.server.runAttempts.forRun("run-1"), calls: callsOf(records), answers: answersIn(records) };
}

/** The lapse on the record: the lost claim's attempt cut lease_lapse, and the claim that took over (from running, the
 *  same turn, one attempt more) names it as its cause. */
function lapseRecorded({ attempts, lost }) {
  const shown = JSON.stringify(attempts);
  const cut = attempts.find((attempt) => attempt.epoch === lost);
  assert.equal(cut?.cut, "lease_lapse", `the lost claim's attempt is cut lease_lapse: ${shown}`);
  const next = attempts.find((attempt) => attempt.epoch === lost + 1);
  assert.ok(next, `the run was claimed again at the next epoch: ${shown}`);
  assert.deepEqual([next.from, next.cause, next.turn, next.attempt], ["running", "lease_lapse", cut.turn, cut.attempt + 1], `the next claim took the lost one's turn over, its cause the lapse: ${shown}`);
}

/** The call on the record: one, with `status`, and the person asked and answered once (no claim asked again). */
function oneCall(w, name, status) {
  assert.deepEqual(w.calls.filter((call) => call.tool === name).map((call) => [call.callId, call.status]), [[w.ask.callId, status]], `the call ended ${status}, once, on the record`);
  assert.deepEqual(w.answers, [[w.ask.callId, "allow"]], "the person was asked once and answered once: the next claim never asked again");
}

test("pi: an approved call with a side effect, its claim lost while it runs, ran once, never again on the next claim, which answers it interrupted, to the model too", { timeout: 60_000 }, async (t) => {
  const held = heldOnPi("send", false);
  const w = await lapsedWhileItRuns(t, held);
  assert.equal(held.ran(), 1, "the allowed call with a side effect ran once across the lost claim and the next");
  lapseRecorded(w);
  oneCall(w, "send", "interrupted");
  const told = toolResultsIn(held.requests.at(-1));
  assert.ok(told.length === 1 && /interrupted/.test(told[0]), `the model was told the call was interrupted: ${JSON.stringify(told)}`);
});

test("a CLI harness: an approved call with a side effect, its claim lost while it runs, ran once, and its issue on the next claim is answered interrupted, never sent again", { timeout: 60_000 }, async (t) => {
  const held = heldOnCli("send");
  const w = await lapsedWhileItRuns(t, held);
  assert.equal(held.ran(), 1, "the allowed call with a side effect ran once across the lost claim and the next");
  lapseRecorded(w);
  oneCall(w, "send", "interrupted");
  assert.ok(held.answers.length >= 1 && held.answers.every((answer) => answer.isError && /^interrupted: /.test(answer.text)), `the CLI's issue on the next claim was answered interrupted: ${JSON.stringify(held.answers)}`);
});

test("pi: an approved read, its claim lost while it runs, runs again on the next claim (a read is safe to repeat), its result recorded once", { timeout: 60_000 }, async (t) => {
  const held = heldOnPi("lookup", true);
  const w = await lapsedWhileItRuns(t, held);
  // On purpose: an approved read stays at least once.
  assert.equal(held.ran(), 2, "the allowed read ran on the lost claim and again on the next");
  lapseRecorded(w);
  oneCall(w, "lookup", "done");
  assert.deepEqual(toolResultsIn(held.requests.at(-1)), ["lookup done"], "the model read the read's result once");
});

test("pi: the server's web_fetch, approved, its claim lost while it runs, is dialled again on the next claim, its result recorded once", { timeout: 60_000 }, async (t) => {
  assert.equal(replayOf("web_fetch"), "safe", "web_fetch is a read, replay-safe in the tool list");
  const held = webFetchOnPi(t);
  const w = await lapsedWhileItRuns(t, held);
  assert.deepEqual(held.dials(), [PAGE, PAGE], "dialled on the lost claim and again on the next");
  lapseRecorded(w);
  oneCall(w, "web_fetch", "done");
  const told = toolResultsIn(held.requests.at(-1));
  assert.ok(told.length === 1 && told[0].startsWith('{"ok":true'), `the model read the page once: ${JSON.stringify(told)}`);
});
