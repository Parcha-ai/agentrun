// pi's native extensions on the adapter loop (runner/adapters/pi.ts PiAdapterOptions.extensions): the browser's durable
// extension, as a pi DurableRun on main installs it, runs in the claim's Harness on the runner. Its tools are pi's own tool
// tasks: a taskId pi holds, a memo durable under that task across a re-claim (replayed, never recomputed), a child
// conversation it owns that the claim's Harness drives (its model request through the session's proxy and booked), and
// its own task kinds under pi's recovery (a release task a shutdown leaves to the next claim, never aborted). Its tools
// pass the session's gate. A fake extension here plays each shape the browser's has.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const SUB_TASK = "Sub-task: report the page.";
/** Each case's own bound: a case whose run never ends fails by name rather than holding the file. */
const CASE_MS = 90_000;
after(closeOpenSessions);

/** The scripted origin, with a child conversation's request (its input is SUB_TASK) answered "sub done". */
function origin(script, requests) {
  const root = scriptedOrigin(script, requests);
  const child = scriptedOrigin([{ say: "sub done" }], requests);
  return (url, init = {}) => (String(init.body ?? "").includes(SUB_TASK) ? child(url, init) : root(url, init));
}

/** A runner (one per call of `start`) on the adapter loop: pi through the session's proxy to `script`, the run's root
 *  agent carrying `extension`, each paid request the booking admits recorded in `asked`. */
async function nativeRun(t, { script, extension, gate, lifecycle }) {
  const opened = await stores({ runners: 2 });
  await queue(opened.server, "run-1");
  const requests = [];
  const asked = [];
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: origin(script, requests), price: () => 0, extensions: [extension] }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: [], context: "fresh" },
    input: "Follow the script.",
    hooks: quiet,
    gate: gate ?? (() => "allow"),
    // The run's one cap, uncapped: every model request books through it (the adapter loop's only booking path), each
    // one it judged recorded.
    runCap: { capUsd: () => undefined, modelOf: () => undefined, judged: (request) => void asked.push(request) },
    ...(lifecycle ? { lifecycle } : {}),
  }), { restartLimit: MAX_RESTARTS });
  const runners = [];
  t.after(() => Promise.all(runners.map((runner) => runner.close())));
  const start = (index, name) => {
    const runner = startRunner({ store: opened.runners[index], createLoop: loop, name, ...TIMING });
    runners.push(runner);
    return runner;
  };
  const ended = () => until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === "ended" && row.runner === null && row;
  }, "the run ended and was released", 20_000);
  return { opened, requests, asked, start, ended };
}

/** A promise and its resolver. */
const signal = () => {
  let fire = () => {};
  const fired = new Promise((resolve) => (fire = resolve));
  return { fire, fired };
};

/** Waits until `context` is aborted, then rejects: a call held until its claim lets go. */
const heldUntilAborted = (context) => new Promise((_, reject) => {
  const abort = context.abortSignal;
  if (abort?.aborted) return reject(new Error("aborted"));
  abort?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});

test("a native tool is pi's own tool task: its memo survives a re-claim under the same taskId, replayed and never recomputed", { timeout: CASE_MS }, async (t) => {
  const executions = [];
  const started = signal();
  const browse = defineTool({
    name: "browse", description: "Browses.", parameters: { type: "object", properties: {} }, replay: "safe",
    async execute(_args, api, context) {
      const execution = { taskId: String(api.taskId) };
      executions.push(execution);
      execution.tag = await api.memo("tag", `tag-${executions.length}`, context);
      if (executions.length === 1) {
        started.fire();
        await heldUntilAborted(context);
      }
      return { output: [{ type: "text", text: execution.tag }] };
    },
  });
  const w = await nativeRun(t, { script: [{ call: "browse" }, { say: "done" }], extension: defineExtension({ name: "native-browse", tools: [browse] }) });
  const first = w.start(0, "runner-a");
  await started.fired;
  // A shutdown mid-call: the claim lets the run go, still running, with the call's task unsettled in its journal.
  await first.close();
  w.start(1, "runner-b");
  await w.ended();
  assert.equal(executions.length, 2, `run once per claim: ${JSON.stringify(executions)}`);
  assert.ok(executions[0].taskId && executions[0].taskId !== "undefined", "pi gave the call a taskId");
  assert.equal(executions[1].taskId, executions[0].taskId, "the next claim recovered the same task");
  assert.deepEqual(executions.map((each) => each.tag), ["tag-1", "tag-1"], "the memo the first claim wrote is the one the replay reads");
});

test("a native tool's child conversation is owned by its task, driven by the claim's Harness, its model request through the proxy and booked", { timeout: CASE_MS }, async (t) => {
  const seen = {};
  const delegate = defineTool({
    name: "delegate", description: "Delegates.", parameters: { type: "object", properties: {} }, replay: "safe",
    async execute(_args, api, context) {
      seen.taskId = api.taskId;
      const id = await api.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id, context);
      const child = await api.conversation(id, context);
      seen.ownership = await api.commit(async (tx) => (await tx.conversation(id))?.ownership ?? (await tx.conversation(id))?.owner, context);
      await (await child.submit({ type: "input", content: SUB_TASK, requestId: "child:1" }, context)).wait(context);
      const said = await api.commit(async (tx) => {
        for (const entry of (await tx.scanEntries({ conversationId: id, order: "descending" }, 50)).items) {
          for (const message of [...(entry.model ?? [])].reverse()) {
            if (message.role === "assistant") return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
          }
        }
        return "";
      }, context);
      seen.said = said;
      return { output: [{ type: "text", text: said }] };
    },
  });
  const w = await nativeRun(t, { script: [{ call: "delegate" }, { sayLastResult: true }], extension: defineExtension({ name: "native-delegate", tools: [delegate] }) });
  w.start(0, "runner-a");
  await w.ended();
  assert.equal(seen.said, "sub done", "the child's turn ran and answered");
  assert.equal(JSON.stringify(seen.ownership).includes(String(seen.taskId)), true, `the child is owned by the tool's task: ${JSON.stringify(seen.ownership)}`);
  const childRequests = w.requests.filter((body) => JSON.stringify(body.messages ?? []).includes(SUB_TASK));
  assert.equal(childRequests.length, 1, "the child's one model request went through the session's proxy");
  assert.equal(w.asked.length, w.requests.length, `every request, the child's among them, was admitted by the run's booking: ${w.asked.length} of ${w.requests.length}`);
});

test("a native tool passes the session's gate: one the gate denies never runs", { timeout: CASE_MS }, async (t) => {
  let ran = 0;
  const browse = defineTool({ name: "browse", description: "Browses.", parameters: { type: "object", properties: {} }, replay: "safe", async execute() { ran += 1; return { output: [{ type: "text", text: "browsed" }] }; } });
  const w = await nativeRun(t, { script: [{ call: "browse" }, { say: "done" }], extension: defineExtension({ name: "native-browse", tools: [browse] }), gate: (call) => (call.tool === "browse" ? "deny" : "allow") });
  w.start(0, "runner-a");
  await w.ended();
  assert.equal(ran, 0, "the denied native tool did not run");
});

test("a native task kind runs under pi's recovery: a shutdown leaves its release task to the next claim, which completes it, and nothing aborts it", { timeout: CASE_MS }, async (t) => {
  const log = { completed: [], aborted: 0, executions: 0 };
  const go = signal();
  const started = signal();
  const Release = defineTask({
    name: "native.release",
    version: 1,
    initial: () => ({ phase: "release" }),
    phases: {
      release: async (_task, runtime, context) => {
        await go.fired;
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { released: 1 } } }), context);
        log.completed.push(1);
      },
    },
    abort: async (_task, runtime, context) => {
      log.aborted += 1;
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "aborted" } }), context);
    },
  });
  const launch = defineTool({
    name: "launch", description: "Launches.", parameters: { type: "object", properties: {} }, replay: "safe",
    async execute(_args, api, context) {
      log.executions += 1;
      // The release task, made once whatever the replays (its id in the call's memo).
      let taskId = await api.memo("release", context);
      if (taskId === undefined) {
        const made = await api.commit((tx) => tx.createTask(Release, {}, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true }), context);
        taskId = await api.memo("release", String(made), context);
      }
      if (log.executions === 1) {
        started.fire();
        await heldUntilAborted(context);
      }
      await api.waitForTask(taskId, context);
      return { output: [{ type: "text", text: "launched" }] };
    },
  });
  const w = await nativeRun(t, { script: [{ call: "launch" }, { say: "done" }], extension: defineExtension({ name: "native-launch", tools: [launch], tasks: [Release] }) });
  const first = w.start(0, "runner-a");
  await started.fired;
  await first.close();
  assert.equal(log.aborted, 0, "the shutdown aborted no release task");
  assert.deepEqual(log.completed, [], "and none completed under the first claim");
  go.fire();
  w.start(1, "runner-b");
  await w.ended();
  assert.deepEqual(log.completed, [1], "the next claim completed the release task, once");
  assert.equal(log.aborted, 0, "nothing aborted it");
});
