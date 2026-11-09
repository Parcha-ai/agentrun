// pi through the adapter: a call the gate refuses reaches the model in main's words, byte for byte, as the call's result
// (an error), never in pi's own framing of a blocked call. Main's words come from serve's tool-gate (deniedText for a
// tool set to deny, refusedText for a call a person denied), read from there, never retyped here.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { deniedText, refusedText } = await import("../dist/tool-gate.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A run of `script` whose gate answers `gate(call)`; the request bodies the provider got. */
async function gatedRun(t, script, gate) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const { tools } = suiteTools();
  const requests = [];
  const spec = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), gate }));
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const settled = (state) =>
    until(async () => {
      const now = await server.runs.get("run-1");
      return now.state === state && now.runner === null && now;
    }, `the run ${state}`, 30_000);
  return { server, requests, settled };
}

/** The newest tool result the provider got: its blocks and whether it says it is an error. */
function lastToolResult(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const result = results.at(-1);
  assert.ok(result, `a tool result reached the provider: ${JSON.stringify(requests.map((body) => body.messages))}`);
  const blocks = typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content ?? [];
  return { text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""), isError: result.is_error === true, blocks };
}

test("a call of a tool set to deny reaches the model in main's words, byte for byte, as an error result", async (t) => {
  const w = await gatedRun(t, [{ call: "read" }, { say: "done" }], (call) => (call.tool === "read" ? "deny" : "allow"));
  await w.settled("ended");
  const result = lastToolResult(w.requests);
  assert.equal(result.text, deniedText("read"), `main's words for a tool set to deny: ${JSON.stringify(result.blocks)}`);
  assert.equal(result.isError, true, "an error result");
});

test("a call a person denied reaches the model in main's words with their reason, byte for byte, as an error result", async (t) => {
  const w = await gatedRun(t, [{ call: "asked" }, { say: "done" }], (call) => (call.tool === "asked" ? "ask" : "allow"));
  const parked = await w.settled("parked");
  const { entries } = await journalRecords(w.server.journal({ runId: "run-1", runner: "reader", epoch: parked.epoch, until: 0, from: parked.state }), BACKGROUND_CONTEXT);
  const callId = String(entries.find((entry) => entry.kind === "agentrun.ask")?.data?.callId);
  await sendCommand(w.server, "run-1", { kind: "deny", body: { approval: callId, note: "not on a Friday" } });
  await w.settled("ended");
  const result = lastToolResult(w.requests);
  assert.equal(result.text, refusedText("asked", "not on a Friday"), `main's words for a call a person denied: ${JSON.stringify(result.blocks)}`);
  assert.equal(result.isError, true, "an error result");
});
