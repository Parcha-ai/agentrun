// pi through the adapter loop: one answer makes two calls, `slow` (allowed, still running) and `note` (asked). The park on
// note waits, within its bound (AdapterRunSpec parkSiblingsMs), for slow before it seals. A sibling that outlasts the
// bound is cut as before: the claim lets go at the bound, slow's signal aborted, and once note is denied the model reads
// slow interrupted. A cancel while the park waits ends the run at once, in its words, slow cut and nothing more sent.
// (A sibling that ends within the bound keeps its result: mcp-parked-sibling's pi row.)
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { CODEMODE } = await import("../dist/runner/meta-tools.js");
const { fillerTools } = await import("../dist/runner/conformance/harness.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const SLACK = 20;
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

async function entriesOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
}

/** The text of every tool result in a Messages request body, by its tool_use id. */
const resultsOf = (body) => Object.fromEntries((body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "tool_result").map((part) => [part.tool_use_id, typeof part.content === "string" ? part.content : (part.content ?? []).map((one) => one.text ?? "").join("")]));

/** A runner over one queued pi run whose first answer calls slow and note at once, its park's bound `parkSiblingsMs`.
 *  slow runs until the test lets it go or its signal aborts. */
async function siblings(t, parkSiblingsMs, { late = false } = {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  let started = () => {};
  const running = new Promise((resolve) => (started = resolve));
  let letGo = () => {};
  const held = new Promise((resolve) => (letGo = resolve));
  t.after(() => letGo());
  const slow = { starts: 0, cutAt: undefined };
  const tools = {
    slow: {
      name: "slow", replaySafe: false, ask: false,
      run: async (_args, signal) => {
        slow.starts += 1;
        started(Date.now());
        const aborted = new Promise((_, reject) => signal?.addEventListener("abort", () => ((slow.cutAt = Date.now()), reject(new Error("aborted"))), { once: true }));
        await Promise.race([held, aborted]);
        return "slow done";
      },
    },
    note: { name: "note", replaySafe: false, ask: true, run: async () => "noted" },
    // Allowed, its gate answering only once the test says (`allowLate`): after note's park, while it waits for slow.
    late: { name: "late", replaySafe: false, ask: false, run: async () => ((slow.lateRuns += 1), "late done") },
  };
  slow.lateRuns = 0;
  let allowLate = () => {};
  const lateAllowed = new Promise((resolve) => (allowLate = resolve));
  const script = [{ calls: [{ call: "slow" }, { call: "note" }, ...(late ? [{ call: "late" }] : [])] }, { say: "done" }];
  const requests = [];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
  const inner = createAdapterLoop(async (claim, run) => {
    const spec = await base(claim, run);
    return { ...spec, parkSiblingsMs, gate: async (call, how) => (call.tool === "late" ? (await lateAllowed, "allow") : spec.gate(call, how)) };
  });
  // The first claim's signal and its start(), settled: the claim that parks and waits.
  const claims = [];
  const createLoop = (deps) => {
    const loop = inner(deps);
    const start = loop.start.bind(loop);
    loop.start = (claim) => {
      const end = start(claim);
      claims.push({ signal: deps.signal, settled: Promise.resolve(end).then(() => undefined, () => undefined) });
      return end;
    };
    return loop;
  };
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  return { server: opened.server, running, slow, requests, letGo, allowLate, claims };
}

/** The parking claim's start() settles and leaves no abort listener on its signal, whichever way its wait ended. */
async function leavesNoListener(claims, how) {
  assert.ok(claims.length >= 1, "a claim started");
  let timer;
  await Promise.race([claims[0].settled, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the parking claim's start() never settled")), 15_000)))]);
  clearTimeout(timer);
  assert.equal(getEventListeners(claims[0].signal, "abort").length, 0, `no abort listener left on the claim's signal once its wait ${how}`);
}

test("pi: a call beside the parked one that outlasts the park's bound is cut at the bound, and once the parked call is answered the model reads it interrupted", { timeout: 60_000 }, async (t) => {
  const bound = 300;
  const { server, running, slow, requests, claims } = await siblings(t, bound);
  const startedAt = await running;
  const parked = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "parked" && now.runner === null && now;
  }, "the run parked and its claim let go", 15_000);
  const letGoAt = Date.now();
  // A timer reads its own clock, so Date.now() may see it fire a millisecond or so early: SLACK allows for that.
  assert.ok(letGoAt - startedAt >= bound - SLACK, `the claim held for the bound while slow ran: ${letGoAt - startedAt} ms`);
  assert.ok(slow.cutAt !== undefined, "slow's signal was aborted: it was cut");
  assert.ok(slow.cutAt - startedAt >= bound - SLACK, `cut no sooner than the bound: ${slow.cutAt - startedAt} ms`);
  assert.equal(requests.length, 1, `nothing sent while it parks: ${JSON.stringify(parked)}`);
  await leavesNoListener(claims, "passed its bound");
  const callId = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask")?.data.callId;
  assert.ok(callId, "note was asked");
  await server.command("run-1", { kind: "deny", body: { approval: callId } });
  const ended = await until(async () => {
    const now = await server.runs.get("run-1");
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run went on and ended", 30_000);
  assert.equal(ended.state, "ended", JSON.stringify(ended));
  const sent = resultsOf(requests.at(-1));
  assert.match(sent.toolu_0_0 ?? "", /interrupted/, `the model reads slow cut: ${JSON.stringify(sent)}`);
  assert.match(sent.toolu_0_1 ?? "", /den/i, `and note denied: ${JSON.stringify(sent)}`);
  assert.equal(slow.starts, 1, "slow never ran again");
});

test("pi: a cancel while the park waits for the call beside it ends the run at once, in the cancel's words, that call cut and nothing more sent", { timeout: 60_000 }, async (t) => {
  const bound = 20_000;
  const { server, running, slow, requests, claims } = await siblings(t, bound);
  await running;
  await until(async () => (await server.runs.get("run-1")).state === "parked", "note's ask landed", 15_000);
  assert.notEqual((await server.runs.get("run-1")).runner, null, "the claim still holds: the park waits for slow");
  const cancelAt = Date.now();
  const command = await sendCommand(server, "run-1", { kind: "cancel", body: {} });
  const ended = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "stopped" && now.runner === null && now;
  }, "the cancel ended the run", 10_000);
  assert.ok(Date.now() - cancelAt < bound / 4, `at once, not at the park's bound: ${Date.now() - cancelAt} ms`);
  assert.equal(ended.summary, "cancelled", JSON.stringify(ended));
  const taken = (await server.commands("run-1", 0)).find((one) => one.id === command.id);
  assert.ok(taken.takenAt !== null && taken.refused === null, `the cancel row is taken: ${JSON.stringify(taken)}`);
  assert.ok(slow.cutAt !== undefined, "slow was cut");
  assert.equal(slow.starts, 1);
  assert.equal(requests.length, 1, "nothing more sent to the model");
  await leavesNoListener(claims, "was ended by a cancel");
});

test("pi: a call the gate allows while the park waits never starts in that claim: it is asked again on the resume and runs once then", { timeout: 60_000 }, async (t) => {
  const { server, running, slow, requests, letGo, allowLate, claims } = await siblings(t, 20_000, { late: true });
  await running;
  await until(async () => (await server.runs.get("run-1")).state === "parked", "note's ask landed", 15_000);
  assert.notEqual((await server.runs.get("run-1")).runner, null, "the claim still holds: the park waits for slow");
  allowLate();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(slow.lateRuns, 0, "late, allowed while the park waits, did not start");
  letGo();
  await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "parked" && now.runner === null;
  }, "slow ended, and the claim let go", 15_000);
  assert.equal(slow.lateRuns, 0, "late never started in the parking claim");
  await leavesNoListener(claims, "ended with the call beside it settled");
  const callId = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask")?.data.callId;
  await server.command("run-1", { kind: "deny", body: { approval: callId } });
  const ended = await until(async () => {
    const now = await server.runs.get("run-1");
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run went on and ended", 30_000);
  assert.equal(ended.state, "ended", JSON.stringify(ended));
  assert.equal(slow.lateRuns, 1, "late ran once, on the resume");
  const sent = resultsOf(requests.at(-1));
  assert.deepEqual([sent.toolu_0_0, sent.toolu_0_2], ["slow done", "late done"], `slow's result kept, late's from its run on the resume: ${JSON.stringify(sent)}`);
  assert.match(sent.toolu_0_1 ?? "", /den/i);
});

test("pi: a call nested in a running script parks the run, and the claim lets go at once: the script waiting on it is not waited for", { timeout: 60_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const tools = { note: { name: "note", replaySafe: false, ask: true, run: async () => "noted" }, ...fillerTools() };
  const script = [{ call: CODEMODE, args: { script: "return await tools.note({});" } }, { say: "done" }];
  const requests = [];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
  const createLoop = createAdapterLoop(async (claim, run) => ({ ...(await base(claim, run)), parkSiblingsMs: 20_000 }));
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).state === "parked", "the nested call's ask landed", 15_000);
  const askedAt = Date.now();
  await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "parked" && now.runner === null;
  }, "the claim let go", 15_000);
  assert.ok(Date.now() - askedAt < 5_000, `at once, not at the park's bound: ${Date.now() - askedAt} ms`);
  const asked = (await entriesOf(opened.server)).filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data.tool);
  assert.deepEqual(asked, ["note"], "parked on the script's nested call");
});
