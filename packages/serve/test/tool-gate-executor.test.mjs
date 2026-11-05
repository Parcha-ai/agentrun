// An approved MCP call runs through the executor its gateway registers (tool-gate.ts RunGate.executor), by its prefix,
// exactly once on the gate's journaled path: its intent is in the run's store before it runs, a call a crash cut off is
// answered interrupted and never run again, and the run resumes with its answer through the gate's one resume. An
// approval whose prefix has no executor fails closed, in words; a deny never calls it. The gate here runs on a real
// pi-durable store in memory, with a fake executor in place of the MCP gateway.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";
import { boundResult } from "@parcha/agentrun-kernel/process";
import { APPROVAL_ENTRY, RunGate } from "../dist/tool-gate.js";
import { scratch } from "./support.mjs";

const TOOL = "mcp:srv/echo";
const ARGS = { text: "hello", nested: { n: 1 } };

/** A run's gate on `storage` (a fresh one: the run's first process; the same one: its next, after a crash), with the
 *  fake `executor` registered for mcp: when given, its resumes recorded. */
async function runOn(t, { storage = new MemoryStorage(), where, executor } = {}) {
  const harness = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  await harness.root(ctx);
  const dirs = where ?? { root: await scratch(t), work: await scratch(t), data: await scratch(t) };
  const gate = new RunGate({ ...dirs, runId: "r1", harness: "claude-agent" });
  if (executor) gate.executor?.("mcp:", executor);
  await gate.load({ harness }, ctx);
  const resumed = [];
  const park = { commit: (change) => harness.commit(change, ctx), parked: () => undefined };
  const start = () => gate.start(async (id, content, mark) => {
    resumed.push({ id, content });
    await harness.commit(mark, ctx);
  });
  return { gate, harness, storage, where: dirs, resumed, park, start };
}

/** The approval id the run's store holds for its one parked call. */
async function approvalId(harness) {
  const root = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
  const page = await root.entries({ order: "ascending" }, 100, undefined, ctx);
  return page.items.find((entry) => entry.kind === APPROVAL_ENTRY && entry.data?.phase === "requested")?.data?.id;
}

/** The owner's answer, as the server keeps it in the run's serve.json. */
const answer = (where, id, decision) => writeFile(join(where.root, "serve.json"), JSON.stringify({ approvals: { [id]: { decision, answered_at: new Date().toISOString(), args_shown: JSON.stringify(ARGS) } } }));

const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (check()) return;
  throw new Error("timed out");
};

/** A fake executor: its calls, and what it answers. */
function fakeExecutor(answer = { text: "echoed hello", isError: false }, wait = async () => undefined) {
  const calls = [];
  const run = async (tool, args, callId, signal) => {
    calls.push({ tool, args, callId, aborted: signal?.aborted });
    await wait();
    return answer;
  };
  return { calls, run };
}

test("an allowed MCP call runs once through the executor its prefix names, with the call's stored arguments, and the run resumes with its answer", async (t) => {
  const executor = fakeExecutor();
  const run = await runOn(t, { executor: executor.run });
  assert.equal((await run.gate.enter(TOOL, ARGS, "c1", run.park)).parked, true);
  await answer(run.where, await approvalId(run.harness), "allow");
  run.start();
  await until(() => run.resumed.length === 1);
  assert.deepEqual(executor.calls.map(({ tool, args, callId }) => ({ tool, args, callId })), [{ tool: TOOL, args: ARGS, callId: "c1" }]);
  assert.match(run.resumed[0].content, /They allowed it, and it ran\. Its result:\necho/);
  await sleep(600);
  assert.equal(executor.calls.length, 1, "once");
});

test("an executor's error answer is carried into the resume as a failure", async (t) => {
  const executor = fakeExecutor({ text: "the server said no", isError: true });
  const run = await runOn(t, { executor: executor.run });
  await run.gate.enter(TOOL, ARGS, "c1", run.park);
  await answer(run.where, await approvalId(run.harness), "allow");
  run.start();
  await until(() => run.resumed.length === 1);
  assert.match(run.resumed[0].content, /They allowed it, and it ran and failed\. Its result:\nthe server said no/);
});

test("a run's process that dies after the call's intent and before its answer: the next one answers it interrupted and never calls the executor again", async (t) => {
  let release;
  const first = fakeExecutor(undefined, () => new Promise((resolve) => (release = resolve)));
  const run = await runOn(t, { executor: first.run });
  await run.gate.enter(TOOL, ARGS, "c1", run.park);
  await answer(run.where, await approvalId(run.harness), "allow");
  run.start();
  await until(() => first.calls.length === 1);
  // The process dies here: its call never answers. The next process opens the same store.
  const second = fakeExecutor();
  const next = await runOn(t, { storage: run.storage, where: run.where, executor: second.run });
  next.start();
  await until(() => next.resumed.length === 1);
  assert.match(next.resumed[0].content, /interrupted/);
  assert.equal(second.calls.length, 0, "never run again");
  release?.();
});

test("an answer acted on by settles that overlap runs the call once", async (t) => {
  const executor = fakeExecutor(undefined, () => sleep(700));
  const run = await runOn(t, { executor: executor.run });
  await run.gate.enter(TOOL, ARGS, "c1", run.park);
  await answer(run.where, await approvalId(run.harness), "allow");
  run.start();
  run.start();
  await until(() => run.resumed.length === 1);
  await sleep(600);
  assert.deepEqual([executor.calls.length, run.resumed.length], [1, 1]);
});

test("an approved call whose prefix has no executor is not run, and the resume says so in words", async (t) => {
  const run = await runOn(t);
  await run.gate.enter(TOOL, ARGS, "c1", run.park);
  await answer(run.where, await approvalId(run.harness), "allow");
  run.start();
  await until(() => run.resumed.length === 1);
  assert.match(run.resumed[0].content, /The approved mcp:srv\/echo call was not run: nothing in this run runs mcp: calls\./);
});

test("a denied MCP call never reaches the executor, and the resume carries the refusal", async (t) => {
  const executor = fakeExecutor();
  const run = await runOn(t, { executor: executor.run });
  await run.gate.enter(TOOL, ARGS, "c1", run.park);
  await answer(run.where, await approvalId(run.harness), "deny");
  run.start();
  await until(() => run.resumed.length === 1);
  assert.match(run.resumed[0].content, /The user denied this mcp:srv\/echo call\./);
  await sleep(300);
  assert.equal(executor.calls.length, 0);
});

test("an approved MCP call whose answer a stop overrides after the live gate read it never reaches the executor: the gate reads the answer again before it writes the call's intent", async (t) => {
  const executor = fakeExecutor();
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: {} }, ctx);
  await harness.root(ctx);
  const requested = (id, tool, call) => ({ kind: APPROVAL_ENTRY, data: { phase: "requested", id, tool, call_id: call, args: ARGS, args_preview: "{}", requested_at: new Date().toISOString() } });
  await harness.commit(async (tx) => {
    await tx.appendEntry(ROOT_CONVERSATION_ID, requested("ap_first", TOOL, "c1"));
    await tx.appendEntry(ROOT_CONVERSATION_ID, requested("ap_second", TOOL, "c2"));
  }, ctx);
  const where = { root: await scratch(t), work: await scratch(t), data: await scratch(t) };
  const meta = join(where.root, "serve.json");
  const given = (decision) => ({ decision, answered_at: new Date().toISOString(), args_shown: JSON.stringify(ARGS) });
  await writeFile(meta, JSON.stringify({ approvals: { ap_first: given("deny"), ap_second: given("allow") } }));
  const gate = new RunGate({ ...where, runId: "r1", harness: "claude-agent" });
  gate.executor?.("mcp:", executor.run);
  await gate.load({ harness }, ctx);
  const resumed = [];
  gate.start(async (id, _content, mark) => {
    resumed.push(id);
    // While the gate acts on the first, a stop overrides the second's allow, which the gate has read.
    if (id === "ap_first") {
      const now = JSON.parse(await readFile(meta, "utf8"));
      now.approvals.ap_second = { decision: "withdrawn", answered_at: new Date().toISOString(), superseded: given("allow") };
      await writeFile(meta, JSON.stringify(now));
    }
    await harness.commit(mark, ctx);
  });
  await until(() => !gate.waiting());
  await sleep(300);
  assert.deepEqual([resumed, executor.calls.length], [["ap_first"], 0], "the overridden allow ran nothing and resumed nothing");
});

test("a stop of the run while an approved MCP call is in flight aborts the executor's signal, and its result never resumes the model", async (t) => {
  let aborted = false;
  const executor = fakeExecutor(undefined, () => undefined);
  const holding = async (tool, args, callId, signal) => {
    executor.calls.push({ tool, args, callId });
    await new Promise((resolve) => signal.addEventListener("abort", () => ((aborted = true), resolve()), { once: true }));
    return { text: "late answer", isError: false };
  };
  const run = await runOn(t, { executor: holding });
  await run.gate.enter(TOOL, ARGS, "c1", run.park);
  const id = await approvalId(run.harness);
  await answer(run.where, id, "allow");
  run.start();
  await until(() => executor.calls.length === 1);
  // A stop overrides the answer the gate is acting on (runs.ts supersede): the gate cuts the call in flight.
  await writeFile(join(run.where.root, "serve.json"), JSON.stringify({ approvals: { [id]: { decision: "withdrawn", answered_at: new Date().toISOString(), superseded: { decision: "allow", answered_at: new Date().toISOString() } } } }));
  await until(() => aborted && !run.gate.waiting());
  await sleep(300);
  assert.deepEqual([aborted, run.resumed.length], [true, 0], "the executor saw the abort, and nothing resumed");
});

test("an approved MCP call's oversized answer reaches the model cut as a host tool's is: within HOST_RESULT_MAX_CHARS, its last line saying it was cut", async (t) => {
  const whole = "x".repeat(5 * HOST_RESULT_MAX_CHARS);
  const executor = fakeExecutor({ text: whole, isError: false });
  const run = await runOn(t, { executor: executor.run });
  assert.equal((await run.gate.enter(TOOL, ARGS, "c1", run.park)).parked, true);
  await answer(run.where, await approvalId(run.harness), "allow");
  run.start();
  await until(() => run.resumed.length === 1);
  const content = run.resumed[0].content;
  const result = content.slice(content.indexOf("Its result:\n") + "Its result:\n".length);
  assert.ok(result.length <= HOST_RESULT_MAX_CHARS, `the result the model reads is ${result.length} characters`);
  assert.equal(result, boundResult(whole).text, "cut by the host's one bound, in its words");
  assert.match(result, new RegExp(`\\n\\[cut at \\d+ of ${whole.length} characters\\]$`));
});
