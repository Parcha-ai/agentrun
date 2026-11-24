// pi through the adapter, end to end: a host tool's call that pi cuts off is answered from its slot, the live output the
// tool streamed (pi-durable 1.5.2 dist/harness/tool.js: endCutOff :166, settleFromSlot :189, fromSlot :792), and the model's
// next request carries that result held to the session model's window. Two paths write it:
// - the restart limit (endCutOff): a call cut off `restartLimit` times in a row is not run again. At the limit pi still
//   runs its afterTool hook on it (live.js salvageable: restarts <= limit), so pi's afterTool bound (boundPiResult) and
//   the live-output bound (boundedProgress) each hold it; past the limit it is written with no hooks.
// - abort's last attempt (tool.js:156): an abort handler at restarts >= restartLimit - 1 writes the slot with no hooks,
//   which with restartLimit 1 is every abort. There the live-output bound alone holds what the model reads.
// A cut-off result ends with pi's own diagnostics (appendToolResult renders them as one `<harness>` text after the
// output), which no host bound sees: pi's words about the cut, never the tool's text. They are asserted apart.
// A restart here is the loop's own: a beforeResult hook that throws is a kernel fault, which seals the journal before the
// result's commit, and the loop opens the session again in-process (adapter-loop.ts hosted), pi counting the restart of
// the call still running (scheduler.js open). The tool outlives pi's progress persist (1 s, agent.js persistWithinMs)
// before its fault or its stop, so the slot holds what it streamed.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
after(closeOpenSessions);

const WINDOW = 16_384;
/** The per-model bound of a 16,384-token window (the kernel's resultMaxChars): a quarter of it at three characters a
 *  token. A number here, not the kernel's export, so on main (no such export) the file fails on the bound, not its import. */
const SMALL_MAX = 12_288;
/** Past pi's progress persist (settings.progress.persistWithinMs, 1 s by default), so the slot is in storage. */
const PERSISTED_MS = 1_200;
/** pi's diagnostics after a cut-off result's output: its words, a line or two. */
const HARNESS_MAX = 512;
const START = "START-OF-OUTPUT";
const PROGRESS_NOTE = /\n\[live output cut at \d+ characters: the rest is not kept, past what this model's context window takes\]$/;
/** Either bound's note: the live output's (boundedProgress) or the result's (boundResult), each naming the window. */
const WINDOW_NOTE = /\n\[(?:live output cut at \d+ characters|kept \d+ of \d+ characters)[^\]]*context window[^\]]*\]$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two megabytes streamed through the call's `output`, in 64 KB chunks, its start marked with `label`. */
function stream(context, label) {
  context.output(`${START} ${label} `);
  for (let i = 0; i < 32; i += 1) context.output("x".repeat(65_536));
}

/** A pi run through the adapter at restart limit `restartLimit`, its session's window WINDOW, whose model calls `tool`
 *  once and then answers. The model requests it sent, and the run's row once it ended or stopped. */
async function piRun(t, { tool, hooks, restartLimit }) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const requests = [];
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: scriptedOrigin([{ call: tool.name }, { say: "done" }], requests), price: () => 0 }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: [tool], context: "fresh", contextWindow: WINDOW },
    input: "Follow the script.",
    hooks,
    gate: () => "allow",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
  }), { restartLimit });
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  // The run's row once in one of `states` and released, ended after `since` (an earlier end's endedAt) when given.
  const settled = (states, what, since) => until(async () => {
    const now = await server.runs.get("run-1");
    return states.includes(now.state) && now.runner === null && (since === undefined || (now.endedAt ?? 0) > since) && now;
  }, what, 30_000);
  return { server, requests, settled };
}

/** The tool_result the model read for its one call, in the last request that carries it: its output (the text before
 *  pi's diagnostics) and pi's diagnostics (`<harness>` on), and the two as the model read them. */
function lastResult(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  assert.ok(results.length > 0, `a tool result reached the model in a later request (${requests.length} requests)`);
  const last = results.at(-1);
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content ?? [];
  const whole = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  const at = whole.indexOf("<harness>");
  const output = (at === -1 ? whole : whole.slice(0, at)).replace(/\n$/, "");
  return { whole, output, harness: at === -1 ? "" : whole.slice(at) };
}

/** What every cut-off result read here holds: its output within the per-model bound, its start kept, one attempt's
 *  output alone, a note naming the window last (nothing after the bound), and pi's diagnostics with none of the tool's text. */
function heldToWindow({ whole, output, harness }, note) {
  assert.ok(output.length <= SMALL_MAX, `the output is ${output.length} characters, past ${SMALL_MAX}`);
  assert.ok(output.startsWith(`${START} `), `its start kept: ${JSON.stringify(output.slice(0, 60))}`);
  assert.equal(output.split(START).length - 1, 1, "one attempt's output, never two run together");
  assert.match(output, note, `ends with the window's note, nothing after it: ${JSON.stringify(output.slice(-200))}`);
  assert.ok(harness.startsWith("<harness>"), `pi's diagnostics follow the output: ${JSON.stringify(harness.slice(0, 120))}`);
  assert.ok(harness.length <= HARNESS_MAX, `pi's diagnostics are ${harness.length} characters, past ${HARNESS_MAX}: ${JSON.stringify(harness.slice(0, 300))}`);
  assert.ok(!harness.includes("xxxx") && !harness.includes(START), "none of the tool's text in pi's diagnostics");
  assert.ok(whole.length <= SMALL_MAX + HARNESS_MAX, `${whole.length} characters in all`);
}

test("pi, a 16k window: a host tool cut off at pi's restart limit, its live output 2 MB, reaches the model's next request within the per-model bound, one attempt's output alone", async (t) => {
  // Each attempt streams 2 MB and then faults (beforeResult throws every time): attempt 0, then pi's rerun of the
  // replay-safe call (restarts 1, its slot cleared first), then, at restarts 2 = the limit, endCutOff from the slot.
  // Red on main, whose slot keeps up to pi's 360,000 bytes of it. With the fix both pi's afterTool bound and the
  // live-output bound hold it, so it turns red only with both mutated (M3 and M5 together).
  let attempts = 0;
  const tool = {
    name: "host_stream",
    description: "Streams two megabytes, then answers.",
    inputSchema: { type: "object", properties: {} },
    replay: "safe",
    call: async (_args, context) => {
      attempts += 1;
      stream(context, `attempt-${attempts}`);
      await sleep(PERSISTED_MS);
      return { text: "streamed" };
    },
  };
  const hooks = { beforeIntent: async () => {}, beforeResult: async () => { throw new Error("a fault after the tool streamed, every time"); } };
  const { requests, settled } = await piRun(t, { tool, hooks, restartLimit: 2 });
  await settled(["failed", "ended"], "the run's end after the cut-off call");
  assert.equal(attempts, 2, "run twice (attempt 0 and pi's rerun), then cut off at the limit, never run again");
  const read = lastResult(requests);
  heldToWindow(read, WINDOW_NOTE);
  assert.ok(read.output.includes("attempt-2") && !read.output.includes("attempt-1"), "the last attempt's output alone: pi cleared the slot for the rerun");
  assert.match(read.harness, /interrupted 2 times in a row; it is not run again/, "written by pi's restart limit (endCutOff)");
});

test("pi, a 16k window: a host tool's call stopped on abort's last attempt is written from its slot with no hooks, and the model's next request reads its 2 MB of live output within the per-model bound", async (t) => {
  // restartLimit 1: abort's last attempt is every abort (tool.js:156, restarts 0 < 1 - 1 is false), so pi writes the
  // stopped call's result from its slot with no afterTool hook: the live-output bound (boundedProgress, wired by piTool)
  // alone holds it. A person's message opens the run again, and its first request carries the result.
  // MUTATION: boundedProgress passing every chunk on (M5), or piTool handing the tool api.output unbounded (M6), fails here.
  let streamed = () => {};
  const started = new Promise((resolve) => (streamed = resolve));
  let release = () => {};
  const released = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const tool = {
    name: "host_stream_wait",
    description: "Streams two megabytes, then waits until it is stopped.",
    inputSchema: { type: "object", properties: {} },
    replay: "safe",
    call: async (_args, context) => {
      stream(context, "stopped-call");
      await sleep(PERSISTED_MS);
      streamed();
      const signal = context.signal;
      await Promise.race([released, new Promise((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })))]);
      throw new Error("stopped");
    },
  };
  const hooks = { beforeIntent: async () => {}, beforeResult: async () => {} };
  const { server, requests, settled } = await piRun(t, { tool, hooks, restartLimit: 1 });
  await started;
  await sendCommand(server, "run-1", { kind: "stop" });
  const stopped = await settled(["stopped", "failed", "ended"], "the run's end on the stop");
  assert.equal(stopped.state, "stopped", `stopped: ${JSON.stringify(stopped)}`);
  const before = requests.length;
  // A person's message to the run a person stopped opens it again (runs.reopen, as the console's follow-up does).
  await server.runs.reopen("run-1", { kind: "steer", body: { text: "go on" } });
  await server.flush?.();
  await until(() => requests.length > before, "the message's first request", 30_000);
  await settled(["ended", "failed", "stopped"], "the run's end after the message", stopped.endedAt ?? 0);
  const read = lastResult(requests.slice(before));
  heldToWindow(read, PROGRESS_NOTE);
  assert.ok(read.output.includes("stopped-call"));
  assert.match(read.harness, /was aborted/, "written by pi's abort handler from the slot");
});
