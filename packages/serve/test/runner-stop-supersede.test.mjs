// A stop overrides an approved call that has not finished (main's supersede, with its gate's cut): the call is aborted
// (its tool's signal fires, its work never finishes, nothing of it is written after the run's end), and the run's end
// writes a withdrawn answer for it that keeps the allow it overrode, so the call reads withdrawn and a repeat allow is
// refused in main's words. A call that finished before the stop keeps its allow and its result. On both ends a stop
// can take: the loop's own (adapter-loop writeEnd) and the runner's, when the loop's is refused (runner.ts endRun). pi
// through the adapter loop, with a spec gate that asks about its one tool.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { approve } = await import("../dist/runs-over-store.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const END = "agentrun.end";
after(closeOpenSessions);

/** `store` with each journal commit that carries the run's end passed through `onEnd` first (a refusal). */
function watched(store, onEnd) {
  const journalOf = (journal) =>
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
      if (prop === "journal") return (...args) => journalOf(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A fetch that answers as `scripted` does, except a request after the call's result, which waits until it is aborted
 *  (the run's stop): the run is held after its call finished, before the model reads the result. */
const heldAfterResult = (scripted) => (url, init = {}) => {
  const body = JSON.parse(String(init.body ?? "{}"));
  const afterResult = (body.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result"));
  if (!afterResult) return scripted(url, init);
  return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true }));
};

/** One pi run whose model calls `add`, which its gate asks about, parked on that call. `add` finishes at once when
 *  `slow` is false (the run then held before the model reads its result), else runs until aborted. The runner's end
 *  commits are refused while `refusing()` says so. */
async function parkedRun(t, { slow, refusing = () => false }) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const work = [];
  const requests = [];
  const run = slow
    ? (_args, signal) => new Promise((resolve) => {
        work.push("started");
        const timer = setTimeout(() => (work.push("finished"), resolve("5")), 60_000);
        signal?.addEventListener("abort", () => (clearTimeout(timer), work.push("aborted"), resolve("cut")), { once: true });
      })
    : async () => (work.push("started", "finished"), "5");
  const tools = { add: { name: "add", replaySafe: false, ask: true, run } };
  const script = [{ call: "add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const scripted = scriptedOrigin(script, requests);
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: slow ? scripted : heldAfterResult(scripted) });
  const gate = Object.assign(() => "ask", { askedAs: (tool) => tool });
  const loop = createAdapterLoop(async (claim, spec) => ({ ...(await base(claim, spec)), gate }));
  const store = watched(opened.runners[0], async () => {
    if (refusing()) throw new Error("the journal refused the end (a test's refusal)");
  });
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).state === "parked", "the run parked on the call", 30_000);
  const callId = (await entriesOf(opened.server)).find((entry) => entry.kind === "agentrun.ask").data.callId;
  return { server: opened.server, work, callId };
}

async function entriesOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
}

const stopped = (server) =>
  until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "stopped" && row;
  }, "the run ended stopped", 30_000);

/** The call's answers in the journal, in order. */
const answersOf = (entries, callId) => entries.filter((entry) => entry.kind === "agentrun.answer" && entry.data.callId === callId).map((entry) => entry.data);

/** The refusal a repeat allow gets for an answer already given (runs-over-store approve, main's words from runs.ts approve:
 *  "The tool call <id> was already withdrawn when its run was stopped."), read against the call's effective answer: the
 *  journal's last for it, a superseding withdrawal over the allow it overrode. */
async function repeatAllow(server, callId, answers) {
  const effective = answers.at(-1);
  return approve(server, { id: "run-1", answeredApprovals: { [callId]: { decision: effective.decision } } }, callId, "allow");
}

for (const [how, refused] of [["the loop's own end", false], ["the runner's end, the loop's refused", true]]) {
  test(`a stop while an approved call runs aborts the call and withdraws it over its allow, by ${how}: nothing of it after the end, and a repeat allow is refused in main's words`, { timeout: 60_000 }, async (t) => {
    let refusingOnce = refused;
    const { server, work, callId } = await parkedRun(t, { slow: true, refusing: () => refusingOnce && !(refusingOnce = false) });
    await server.command("run-1", { kind: "approve", body: { approval: callId } });
    await until(() => work.includes("started"), "the approved call runs", 30_000);
    await server.command("run-1", { kind: "stop" });
    await stopped(server);
    const entries = await entriesOf(server);
    // The call was cut, not left to finish.
    assert.deepEqual(work, ["started", "aborted"], "the tool's signal fired and its work never finished");
    const end = entries.findIndex((entry) => entry.kind === END);
    const aboutTheCall = (entry) => (entry.kind === "pi.tool-result" && entry.model?.[0]?.toolCallId === callId) || (entry.kind === "agentrun.call.end" && entry.data.callId === callId);
    assert.ok(!entries.slice(end + 1).some(aboutTheCall), "nothing of the call is written after the end");
    assert.ok(!entries.some((entry) => aboutTheCall(entry) && !(entry.data?.diagnostics ?? []).some((d) => d.code === "aborted") && entry.kind === "pi.tool-result"), "no finished result of the call");
    // The stop's withdrawal over the allow, in the end's own commit (before the end), keeping the allow it overrode.
    const answers = answersOf(entries, callId);
    assert.deepEqual(answers.map((answer) => [answer.decision, answer.superseded?.decision ?? null]), [["allow", null], ["withdrawn", "allow"]], JSON.stringify(answers));
    assert.equal(answers[1].superseded.answeredAt, answers[0].answeredAt, "the allow kept as it was given");
    const withdrawal = entries.findIndex((entry) => entry.kind === "agentrun.answer" && entry.data.superseded);
    assert.ok(withdrawal >= 0 && withdrawal < end, "the withdrawal lands with the end, before it");
    await assert.rejects(repeatAllow(server, callId, answers), { message: `The tool call ${callId} was already withdrawn when its run was stopped.` });
    await assert.rejects(server.command("run-1", { kind: "approve", body: { approval: callId } }), { name: "RunFinal" });
  });
}

test("a stop after an approved call finished keeps its allow and its result: nothing is withdrawn", { timeout: 60_000 }, async (t) => {
  const { server, work, callId } = await parkedRun(t, { slow: false });
  await server.command("run-1", { kind: "approve", body: { approval: callId } });
  await until(async () => (await entriesOf(server)).some((entry) => entry.kind === "pi.tool-result" && entry.model?.[0]?.toolCallId === callId), "the call's result is in", 30_000);
  await server.command("run-1", { kind: "stop" });
  await stopped(server);
  const entries = await entriesOf(server);
  assert.deepEqual(work, ["started", "finished"]);
  assert.deepEqual(answersOf(entries, callId).map((answer) => answer.decision), ["allow"], "the allow stands");
  const result = entries.find((entry) => entry.kind === "pi.tool-result" && entry.model?.[0]?.toolCallId === callId);
  assert.match(JSON.stringify(result.model[0].content), /5/, "its result kept");
});
