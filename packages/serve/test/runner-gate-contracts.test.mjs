// The gate's contracts on the runner's path (pi through the adapter loop, a spec gate that asks about its one tool), each
// read at the point it names, never by a clock: an approved call that is not replay-safe, its runner lost between its
// intent and its result, ends interrupted on the next claim, ran once and never asked again; and a stop that lands after
// the call's answer was read, before the call is acted on, wins: the call never runs.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { saveToolSettings } = await import("../dist/tool-plane.js");
const { deniedText, NOT_RUN, RAN_UNKNOWN, refusedText } = await import("../dist/refusal-words.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** The bound on a wait for the run's own event: it caps the wait, it never orders anything. */
const EVENT_WAIT_MS = 30_000;
after(closeOpenSessions);

/** `store` whose journal commits are told to `onCommit(written)` once they return, before their caller goes on. */
function watched(store, onCommit) {
  const journalOf = (journal) =>
    new Proxy(journal, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "commit") return typeof value === "function" ? value.bind(target) : value;
        return async (...args) => {
          const result = await value.apply(target, args);
          await onCommit(JSON.stringify(args[0] ?? null) ?? "");
          return result;
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

async function entriesOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
}

/** The run's row once it is `state`, failing at once, naming the state it waited for, if the run goes final otherwise. */
const settled = (server, state) =>
  until(async () => {
    const row = await server.runs.get("run-1");
    if (row.state !== state && ["ended", "failed", "stopped"].includes(row.state)) throw new Error(`the run went ${row.state} where it should have gone ${state} (${row.summary ?? "no summary"})`);
    return row.state === state && row.runner === null && row;
  }, `the run ${state}`, EVENT_WAIT_MS);

/** A pi run's adapter loop whose model calls `add`, which its gate asks about, then says the call's result. */
function askingLoop(run, requests) {
  const tools = { add: { name: "add", replaySafe: false, ask: true, run } };
  const script = [{ call: "add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, requests) });
  const gate = Object.assign(() => "ask", { askedAs: (tool) => tool });
  return createAdapterLoop(async (claim, spec) => ({ ...(await base(claim, spec)), gate }));
}

test("a replay-safe call its runner lost mid-call, its tool set to deny on this server before the next claim reruns it, is refused there in the deny's words saying it may have been sent, never 'nothing was sent', and never run again", { timeout: 120_000 }, async (t) => {
  const { server, runners: [one, two], clock } = await stores({ runners: 2 });
  await saveToolSettings(server, { web_fetch: { permission: "allow" } });
  await queue(server, "run-1");
  const work = [];
  const requests = [];
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  // web_fetch as the run has it: replay-safe (pi reruns it after a crash), and paid, so a rerun would be charged again.
  const tools = { web_fetch: { name: "web_fetch", replaySafe: true, ask: false, run: async () => (work.push("started"), await held, "the page") } };
  const script = [{ call: "web_fetch", args: { url: "https://example.com/a" } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, requests) });
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-contracts-"));
  // The gate as the dispatch builds it at the claim, over the claiming runner's store.
  const loopOn = (store) => createAdapterLoop(async (claim, spec) => ({ ...(await base(claim, spec)), gate: await adapterRunGate(store, claim, { kind: "agentic", body: { approvals: "ask" } }, root) }));
  const runners = [startRunner({ store: one, createLoop: loopOn(one), name: "runner-a", ...TIMING })];
  t.after(async () => {
    release();
    await Promise.all(runners.map((runner) => runner.close()));
  });
  await until(() => work.length > 0, "the call runs", EVENT_WAIT_MS);
  runners[0].kill();
  await saveToolSettings(server, { web_fetch: { permission: "deny" } });
  clock.skewMs = TIMING.leaseMs * 2;
  runners.push(startRunner({ store: two, createLoop: loopOn(two), name: "runner-b", ...TIMING }));
  await settled(server, "ended");
  assert.deepEqual(work, ["started"], "the denied rerun never ran: once, the lost runner's attempt");
  const said = lastResult(requests);
  assert.equal(said, deniedText("web_fetch", "web_fetch", "server", "unknown"), `the deny's words, saying the call may have taken effect: ${said}`);
  assert.ok(said.includes(RAN_UNKNOWN) && !said.includes(NOT_RUN), said);
});

test("a replay-safe call its runner lost mid-call, its tool set to ask before the next claim reruns it, is asked anew: the run parks on it unrun, and the owner's deny refuses it in words saying it may have taken effect", { timeout: 120_000 }, async (t) => {
  const { server, runners: [one, two], clock } = await stores({ runners: 2 });
  await saveToolSettings(server, { web_fetch: { permission: "allow" } });
  await queue(server, "run-1");
  const work = [];
  const requests = [];
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  const tools = { web_fetch: { name: "web_fetch", replaySafe: true, ask: false, run: async () => (work.push("started"), await held, "the page") } };
  const script = [{ call: "web_fetch", args: { url: "https://example.com/a" } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, requests) });
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-contracts-"));
  const loopOn = (store) => createAdapterLoop(async (claim, spec) => ({ ...(await base(claim, spec)), gate: await adapterRunGate(store, claim, { kind: "agentic", body: { approvals: "ask" } }, root) }));
  const runners = [startRunner({ store: one, createLoop: loopOn(one), name: "runner-a", ...TIMING })];
  t.after(async () => {
    release();
    await Promise.all(runners.map((runner) => runner.close()));
  });
  await until(() => work.length > 0, "the call runs", EVENT_WAIT_MS);
  runners[0].kill();
  await saveToolSettings(server, { web_fetch: { permission: "ask" } });
  clock.skewMs = TIMING.leaseMs * 2;
  runners.push(startRunner({ store: two, createLoop: loopOn(two), name: "runner-b", ...TIMING }));
  await settled(server, "parked");
  assert.deepEqual(work, ["started"], "parked on it, never run again while it waits");
  const asks = (await entriesOf(server)).filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.deepEqual(asks.map((ask) => ask.tool), ["web_fetch"], `asked anew, once: ${JSON.stringify(asks)}`);
  await server.command("run-1", { kind: "deny", body: { approval: asks[0].callId } });
  await settled(server, "ended");
  assert.deepEqual(work, ["started"], "the denied rerun never ran");
  assert.equal(lastResult(requests), refusedText("web_fetch", undefined, "unknown"), "the owner's deny, saying the earlier attempt may have taken effect");
});

test("two ask calls entered at once, as pi runs a turn's calls in parallel: exactly one parks, and the other is refused in the usual words", { timeout: 120_000 }, async (t) => {
  const { server, runners: [one] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const work = [];
  const requests = [];
  const tools = { write: { name: "write", replaySafe: false, ask: true, run: async (args) => (work.push(args.path), `wrote ${args.path}`) } };
  const script = [{ calls: [{ call: "write", args: { path: "a.md" } }, { call: "write", args: { path: "b.md" } }] }, { say: "done" }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, requests) });
  const gate = Object.assign(() => "ask", { askedAs: (tool) => tool });
  const runner = startRunner({ store: one, createLoop: createAdapterLoop(async (claim, spec) => ({ ...(await base(claim, spec)), gate })), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await settled(server, "parked");
  const asks = (await entriesOf(server)).filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.equal(asks.length, 1, `one request in the run's store: ${JSON.stringify(asks)}`);
  const [first] = asks;
  await server.command("run-1", { kind: "approve", body: { approval: first.callId } });
  await settled(server, "ended");
  assert.equal(work.length, 1, `only the call that parked ran: ${JSON.stringify(work)}`);
  const results = toolResults(requests.at(-1));
  assert.equal(results.length, 2, JSON.stringify(results));
  const [parkedOne, refused] = results[0].id === first.callId ? results : [results[1], results[0]];
  assert.equal(parkedOne.text, `wrote ${work[0]}`, "the first parks, and runs once allowed");
  // Main's words, byte for byte (tool-gate.ts RunGate.enter's refusal of a second ask).
  assert.equal(refused.text, `This write call was not run: the write call ${first.callId} already waits for a person's approval. Call it again once that one is answered.`, "the second does not: it is refused in the usual words");
  assert.match(refused.text, new RegExp(`^This write call was not run: the write call ${first.callId} already waits for a person's approval\\.`));
});

test("the run's gate asked about a replayed call (one a CLI's bridge or pi reruns) refuses a deny and a pin saying whether it took effect is not known; a first attempt's refusal says nothing was sent", async () => {
  const { server } = await stores({ runners: 0 });
  await saveToolSettings(server, { web_fetch: { permission: "deny" }, "mcp:fake/send": { permission: "allow", pin: { channel: "C1" } } });
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-contracts-"));
  const gate = await adapterRunGate(server, { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask" } }, root);
  const fetch = { callId: "c1", tool: "web_fetch", args: { url: "https://example.com/a" } };
  const outside = { callId: "c2", tool: "mcp:fake/send", args: { channel: "C9" } };
  for (const call of [fetch, outside]) {
    const first = await gate(call);
    const replayed = await gate(call, { replayed: true });
    assert.ok(first.deny?.includes(NOT_RUN) && !first.deny.includes(RAN_UNKNOWN), `${call.tool}, first attempt: ${JSON.stringify(first)}`);
    assert.ok(replayed.deny?.includes(RAN_UNKNOWN) && !replayed.deny.includes(NOT_RUN), `${call.tool}, replayed: ${JSON.stringify(replayed)}`);
  }
});

/** Each tool result in one request the model was sent: its call id and text. */
function toolResults(body) {
  return (body?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part?.type === "tool_result").map((part) => ({ id: part.tool_use_id, text: Array.isArray(part.content) ? part.content.map((each) => each.text ?? "").join("") : String(part.content ?? "") }));
}

/** The text of the last tool result the model was sent. */
function lastResult(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part?.type === "tool_result"));
  const last = results.at(-1);
  return last === undefined ? undefined : Array.isArray(last.content) ? last.content.map((part) => part.text ?? "").join("") : String(last.content ?? "");
}

const ofCall = (entries, kind, callId) => entries.filter((entry) => entry.kind === kind && entry.data?.callId === callId).map((entry) => entry.data);

test("an approved call that is not replay-safe, its runner lost between its intent and its result, ends interrupted on the next claim: run once, never asked again", { timeout: 120_000 }, async (t) => {
  const { server, runners: [one, two], clock } = await stores({ runners: 2 });
  await queue(server, "run-1");
  const work = [];
  const requests = [];
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  // Its first run holds until the test's end: the runner is lost with it in flight, past its flushed intent.
  const loop = askingLoop(async () => (work.push("started"), await held, "5"), requests);
  const runners = [startRunner({ store: one, createLoop: loop, name: "runner-a", ...TIMING })];
  t.after(async () => {
    release();
    await Promise.all(runners.map((runner) => runner.close()));
  });
  await settled(server, "parked");
  const callId = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask").data.callId;
  await server.command("run-1", { kind: "approve", body: { approval: callId } });
  await until(() => work.length > 0, "the approved call runs", EVENT_WAIT_MS);
  runners[0].kill();
  // The lost runner's claim run out on the store's clock, so the next claim takes the run with nothing waited out.
  clock.skewMs = TIMING.leaseMs * 2;
  runners.push(startRunner({ store: two, createLoop: loop, name: "runner-b", ...TIMING }));
  const row = await settled(server, "ended");
  const entries = await entriesOf(server);
  assert.deepEqual(work, ["started"], "the call ran once, never again on the next claim");
  assert.equal(ofCall(entries, "agentrun.ask", callId).length, 1, "asked once: the next claim never asked it again");
  assert.deepEqual(ofCall(entries, "agentrun.answer", callId).map((answer) => answer.decision), ["allow"], "one answer, the approval");
  const results = entries.filter((entry) => entry.kind === "pi.tool-result" && entry.model?.[0]?.toolCallId === callId);
  assert.equal(results.length, 1, `one result for the call: ${JSON.stringify(results)}`);
  assert.match(JSON.stringify(results[0]), /interrupted/, `its result says it was interrupted: ${JSON.stringify(results[0])}`);
  assert.match(JSON.stringify(requests.at(-1)?.messages ?? []), /interrupted/, "the model read that it was interrupted");
  assert.equal(row.summary, null, `the run ended with no words: ${JSON.stringify(row)}`);
});

test("a stop that lands after an approved call's answer was read, before the call is acted on, wins: the call never runs, and the run ends stopped", { timeout: 120_000 }, async (t) => {
  const { server, runners: [one] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const work = [];
  const requests = [];
  const loop = askingLoop(async () => (work.push("started"), "5"), requests);
  let loopStopped = false;
  const createLoop = (deps) => {
    const inner = loop(deps);
    return { ...inner, stop: (reason) => ((loopStopped = true), inner.stop(reason)) };
  };
  // Once the answer's commit has returned (the call's answer read and recorded) and before the loop goes on with it: the
  // stop is sent, and the commit's caller goes on only once the loop has been told to stop.
  let armed = false;
  const store = watched(one, async (written) => {
    if (!armed || !written.includes('"agentrun.answer"')) return;
    armed = false;
    await server.command("run-1", { kind: "stop" });
    await until(() => loopStopped, "the loop is told to stop", EVENT_WAIT_MS);
  });
  const runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await settled(server, "parked");
  const callId = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask").data.callId;
  armed = true;
  await server.command("run-1", { kind: "approve", body: { approval: callId } });
  await settled(server, "stopped");
  assert.equal(armed, false, "the answer's commit was held for the stop");
  assert.deepEqual(work, [], "the call never ran: the stop that landed after its answer was read won");
  const entries = await entriesOf(server);
  assert.ok(!entries.some((entry) => entry.kind === "pi.tool-result" && entry.model?.[0]?.toolCallId === callId && !/abort|interrupt|stop/i.test(JSON.stringify(entry))), "no finished result of the call");
  // As main's gate resolved it (tool-gate.ts settle: read again before acting, then resolveSilently): withdrawn with the
  // run, over the allow it was given, and nothing said to the model after the allow.
  assert.deepEqual(ofCall(entries, "agentrun.answer", callId).map((answer) => [answer.decision, answer.superseded?.decision ?? null]), [["allow", null], ["withdrawn", "allow"]], "the allow, then its withdrawal by the stop");
  assert.equal(requests.length, 1, `no model request after the stop: ${requests.length}`);
});
