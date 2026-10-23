import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { durableDoc, readJournal } from "@parcha/agentrun-pi/durable";
import { AgentHomeError } from "../dist/index.js";
import { readWorkflowRun, runWorkflowRevision } from "../dist/workflow.js";
import { bodyOf, ctx, hostFor, mapDoc, parallelDoc, runOf, TOOLS, workflowDoc } from "./workflow-support.mjs";

const INPUT = { sku: "sku-1", amount: 10 };
const runOn = (run, host, options = {}) => runWorkflowRevision({ harness: host.harness, workflows: host.workflows, context: ctx, run, input: INPUT, tools: TOOLS, ...options });
/** A promise and the function that resolves it. */
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("a workflow revision runs to complete on a fresh run store; the summary names the nodes that ran, in graph order", async () => {
  const run = await runOf();
  const host = await hostFor(run);
  try {
    const { outcome, carry } = await runOn(run, host);
    assert.equal(outcome.status, "complete");
    assert.deepEqual(outcome.output, { price: 21 });
    assert.deepEqual(carry, { state: "completed", summary: "stock, by tier, quote fast" });
    assert.deepEqual(host.calls, { "stock.check": 1, "prices.quote": 1 });
    // readWorkflowRun shows the same statuses the summary came from, how the run ended, and the output.
    const view = await readWorkflowRun(run);
    assert.deepEqual(view.status, { "/root": "done", "/root/steps/0": "done", "/root/steps/1": "done", "/root/steps/1/branches/fast/body": "done", "/root/steps/1/branches/slow/body": "not-run" });
    assert.equal(view.outcome, "completed");
    assert.deepEqual(view.output, outcome.output);
    assert.equal(view.escalatedAt, undefined);
    assert.deepEqual(view.graph.nodes.map((node) => node.label), ["chain", "stock", "by tier", "quote fast", "quote slow"]);
  } finally {
    await host.close();
  }
});

test("a run paused after its first effect committed resumes on a reopened Harness: the journal answers the first call", async () => {
  const run = await runOf();
  const pause = deferred();
  const first = await hostFor(run, { onCall: (tool) => { if (tool === "stock.check") pause.resolve(first.workflows.stop(first.harness, run.runId, "pause", ctx)); } });
  const paused = runOn(run, first);
  paused.catch(() => {});
  assert.equal(await (await pause.promise), "paused");
  await first.close();
  const second = await hostFor(run);
  try {
    const { outcome, carry } = await runOn(run, second);
    assert.equal(outcome.status, "complete");
    assert.deepEqual(outcome.output, { price: 21 });
    assert.deepEqual(carry, { state: "completed", summary: "stock, by tier, quote fast" });
    assert.deepEqual(first.calls, { "stock.check": 1 });
    assert.deepEqual(second.calls, { "prices.quote": 1 }, "the stock call is answered from the journal");
  } finally {
    await second.close();
  }
});

test("the same run reopened under another revision is refused (RUN_STORE_BINDING_MISMATCH), and nothing runs", async () => {
  const run = await runOf();
  const host = await hostFor(run);
  try {
    await runOn(run, host);
    const before = { ...host.calls };
    await assert.rejects(runOn({ ...run, revision: { ...run.revision, id: "rev-b" } }, host), (error) => error.code === "RUN_STORE_BINDING_MISMATCH");
    assert.deepEqual(host.calls, before);
  } finally {
    await host.close();
  }
});

test("a tool the host does not register, or an input the workflow does not take, is refused with no task and no journal", async () => {
  for (const [options, code] of [[{ tools: ["stock.check", "prices.quote"] }, "TOOL_NOT_REGISTERED"], [{ input: { sku: "sku-1" } }, "INPUT_NOT_TAKEN"]]) {
    const run = await runOf();
    const host = await hostFor(run);
    try {
      const { outcome, carry } = await runOn(run, host, options);
      assert.equal(outcome.status, "refused");
      assert.equal(outcome.code, code);
      assert.equal(carry.state, "failed");
      assert.match(carry.summary, /^refused: /);
      assert.equal(durableDoc(run.storePath, "agentrun.task", run.runId), undefined);
      assert.equal(readJournal(run.storePath, run.runId), undefined);
      assert.deepEqual(host.calls, {});
    } finally {
      await host.close();
    }
  }
});

test("a gate that fires at a named node ends the run escalated: carry and summary say where, and there is no output", async () => {
  const run = await runOf({ body: bodyOf(workflowDoc({ gate: true })) });
  const host = await hostFor(run);
  try {
    const { outcome, carry } = await runOn(run, host, { input: { sku: "sku-1", amount: 600 } });
    assert.equal(outcome.status, "escalated");
    assert.deepEqual(carry, { state: "escalated", summary: "stock; escalated at too big" });
    assert.deepEqual(host.calls, { "stock.check": 1 });
    const view = await readWorkflowRun(run);
    assert.equal(view.outcome, "escalated");
    assert.deepEqual(view.escalatedAt, { path: "/root/steps/1", label: "too big" });
    assert.equal(view.status["/root/steps/1"], "escalated");
    assert.equal(view.status["/root/steps/2"], "not-run");
    assert.equal("output" in view, false);
  } finally {
    await host.close();
  }
});

test("a run cancelled while it runs ends stopped, and one whose tool fails ends failed, the summary naming the call", async () => {
  const stopped = await runOf();
  const cancel = deferred();
  const host = await hostFor(stopped, { onCall: (tool) => { if (tool === "stock.check") cancel.resolve(host.workflows.stop(host.harness, stopped.runId, "cancel", ctx)); } });
  try {
    const { outcome, carry } = await runOn(stopped, host);
    assert.equal(outcome.status, "stopped");
    // No node completed, failed or escalated: the summary still says how the run ended, since the store refuses an empty one.
    assert.deepEqual(carry, { state: "stopped", summary: "stopped before any node completed" });
    assert.equal(await (await cancel.promise), "marked");
    assert.equal((await readWorkflowRun(stopped)).outcome, "stopped");
  } finally {
    await host.close();
  }
  const failing = await runOf();
  const down = await hostFor(failing, { fail: "prices.quote" });
  try {
    const { outcome, carry } = await runOn(failing, down);
    assert.equal(outcome.status, "refused");
    // The failing call ran: the summary names it after the nodes that completed, as an escalation is named.
    assert.deepEqual(carry, { state: "failed", summary: "stock; failed at quote fast" });
    const view = await readWorkflowRun(failing);
    assert.equal(view.outcome, "failed");
    assert.deepEqual(view.status, { "/root": "failed", "/root/steps/0": "done", "/root/steps/1": "failed", "/root/steps/1/branches/fast/body": "failed", "/root/steps/1/branches/slow/body": "not-run" });
    assert.equal("output" in view, false);
  } finally {
    await down.close();
  }
});

test("the known limit: in a failed run, a parallel branch only interrupted by the other's failure is drawn failed too", async () => {
  const run = await runOf({ body: { workflow: parallelDoc(), skills: {}, tools: TOOLS } });
  const inFlight = deferred();
  const host = await hostFor(run, {
    effect: async ({ node, signal }) => {
      if (node.tool === "prices.slow_quote") {
        // In flight until the run stops it, when the other call fails.
        inFlight.resolve();
        return new Promise((_, reject) => {
          const stop = () => reject(signal.reason ?? new Error("stopped"));
          if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
          setTimeout(() => reject(new Error("the run never stopped this call")), 5000).unref();
        });
      }
      await inFlight.promise;
      throw new Error("the tool is down");
    },
  });
  try {
    const { outcome, carry } = await runOn(run, host, { input: { sku: "sku-1" } });
    assert.equal(outcome.status, "refused");
    assert.deepEqual(carry, { state: "failed", summary: "failed at quote fast, quote slow" });
    const view = await readWorkflowRun(run);
    assert.equal(view.outcome, "failed");
    assert.deepEqual(view.status, { "/root": "failed", "/root/steps/0": "failed", "/root/steps/0/branches/0": "failed", "/root/steps/0/branches/1": "failed" });
  } finally {
    await host.close();
  }
});

test("a run in the keyed layout (a host that opts into layout v4) is not read here: readWorkflowRun and the summary refuse as format", async () => {
  const run = await runOf({ body: { workflow: mapDoc(), skills: {}, tools: ["stock.check"] } });
  const host = await hostFor(run, { layout: "v4" });
  const keyed = (error) => error instanceof AgentHomeError && error.code === "format" && /keyed layout/.test(error.message);
  try {
    await assert.rejects(runOn(run, host, { input: { skus: ["a", "b"] }, tools: ["stock.check"] }), keyed);
    assert.deepEqual(host.calls, { "stock.check": 2 }, "the run itself ran");
    await assert.rejects(readWorkflowRun(run), keyed);
  } finally {
    await host.close();
  }
});

test("readWorkflowRun reads a run another process is running, and leaves the store file's bytes as they were", async () => {
  const run = await runOf();
  const proc = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/workflow-live-child.mjs", import.meta.url))], { env: { ...process.env, RUN: JSON.stringify(run) }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  const inCall = deferred();
  proc.stdout.on("data", (chunk) => { out += chunk; if (out.includes("in-call\n")) inCall.resolve(); });
  proc.stderr.on("data", (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => proc.on("close", resolve));
  await Promise.race([inCall.promise, exited]);
  assert.ok(out.includes("in-call\n"), `the child ran to its first call: ${err}`);
  const live = await readWorkflowRun(run);
  assert.equal(live.outcome, undefined, "the run has not ended");
  assert.equal(live.status["/root/steps/0"], "working");
  assert.equal(live.status["/root/steps/1/branches/fast/body"], "not-run");
  proc.stdin.end();
  assert.equal(await exited, 0, err);
  assert.deepEqual(JSON.parse(out.split("\n").filter(Boolean).at(-1)), { state: "completed", summary: "stock, by tier, quote fast" });
  // With no writer: the read leaves the store file's bytes as they were and no file but the WAL's beside it.
  const bytes = () => createHash("sha256").update(readFileSync(run.storePath)).digest("hex");
  const files = () => readdirSync(path.dirname(run.storePath)).filter((name) => !/-(wal|shm)$/.test(name)).sort();
  const [before, listed] = [bytes(), files()];
  assert.equal((await readWorkflowRun(run)).outcome, "completed");
  assert.equal(bytes(), before);
  assert.deepEqual(files(), listed);
});
