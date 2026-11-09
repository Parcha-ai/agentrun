// An approved call is checked again before it runs, through the runner (a real runner, adapter loop and pi adapter, the
// gate built at each claim as runner/adapter-run-spec.ts builds it: RunGate over the one store's tool settings, answered by
// RunGate.decide). A parked run holds no runner, and its approve brings it back on a new claim, so the settings the call
// meets are the store's at that claim. What the server set while the call waited holds over the approval, as main's
// RunGate.settle re-checks an approved call:
//   (a) a deny set on the server meanwhile: refused with the gate's deny words ("on this server"), never run;
//   (b) a pin set on the server meanwhile that the call's arguments do not hold: refused with the pin's words, never run;
//   (c) nothing changed: the approved call runs once.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { runGate } = await import("../dist/tool-gate.js");
const { loadToolSettings } = await import("../dist/tool-plane.js");
const TIMING = { leaseMs: 30_000, renewEveryMs: 150, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** One run whose first step calls `tool` with `args`, held to the server's stored settings `before`; once it parks on
 *  the call, the server's settings become `meanwhile` (when given) and the owner approves. Answers what the tool ran and
 *  the result the model was given for the call. */
async function approvedAfter(t, { tool, args, before, meanwhile }) {
  const opened = await stores({ runners: 1 });
  await opened.server.settings.put("tool-settings", before);
  await queue(opened.server, "run-1");
  const ran = { count: 0 };
  const tools = { [tool]: { name: tool, replaySafe: false, ask: false, run: async () => { ran.count += 1; return "done it"; } } };
  const script = [{ call: tool, args }, { say: "finished" }];
  const requests = [];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, requests) });
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-approved-"));
  const runnerStore = opened.runners[0];
  // The gate as the dispatch builds it at each claim: the store's settings read at the claim, answered by decide().
  const loop = createAdapterLoop(async (claim, run) => {
    const settings = await loadToolSettings(runnerStore);
    const gate = runGate({ root, work: root }, claim.runId, { kind: "agentic", body: { approvals: "ask" } }, () => settings);
    return { ...(await base(claim, run)), gate: (call) => gate.decide(call.tool, call.args) };
  }, { restartLimit: MAX_RESTARTS });
  const runner = startRunner({ store: runnerStore, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const settled = (state) => until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === state && row.runner === null && row;
  }, `the run ${state} and released`, 20_000);
  await settled("parked");
  assert.equal(ran.count, 0, "nothing runs while the call waits");
  if (meanwhile !== undefined) await opened.server.settings.put("tool-settings", meanwhile);
  await opened.server.flush?.();
  // The ask's call id is the scripted call's: the approve names it (the journal's ask entry).
  const callId = await until(async () => {
    const { journalRecords } = await import("../dist/runner/journal-reader.js");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const row = await opened.server.runs.get("run-1");
    const entries = (await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
    return entries.find((entry) => entry.kind === "agentrun.ask")?.data?.callId;
  }, "the call's ask", 10_000);
  await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: callId } });
  await settled("ended");
  // What the model read for the call: the tool result in the request after it.
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part?.type === "tool_result"));
  const said = results.map((part) => (Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join("") : String(part.content ?? ""))).join("\n");
  return { ran: ran.count, said };
}

test("(a) a deny the server set while the call waited holds over the approval: refused with the deny's words, never run", async (t) => {
  const { ran, said } = await approvedAfter(t, {
    tool: "web_fetch",
    args: { url: "https://example.com/" },
    before: { web_fetch: { permission: "ask" } },
    meanwhile: { web_fetch: { permission: "deny" } },
  });
  assert.equal(ran, 0, "the approved call is not run: the server denied it meanwhile");
  assert.match(said, /on this server/, `the model reads the server's deny: ${said}`);
  assert.match(said, /nothing was sent and nothing was charged/, `and that nothing was sent: ${said}`);
});

test("(b) a pin the server set while the call waited, which the call's arguments do not hold, holds over the approval: refused with the pin's words, never run", async (t) => {
  const { ran, said } = await approvedAfter(t, {
    tool: "mcp__fake__send_message",
    args: { channel_id: "C0999", text: "hi" },
    before: { "mcp:fake/send_message": { permission: "ask" } },
    meanwhile: { "mcp:fake/send_message": { permission: "ask", pin: { channel_id: "C0123" } } },
  });
  assert.equal(ran, 0, "the approved call is not run: the server pinned it meanwhile");
  assert.match(said, /C0123/, `the model reads the pin's words: ${said}`);
});

test("(c) approved with nothing changed, the call runs once", async (t) => {
  const { ran } = await approvedAfter(t, {
    tool: "web_fetch",
    args: { url: "https://example.com/" },
    before: { web_fetch: { permission: "ask" } },
  });
  assert.equal(ran, 1, "approved, it ran once");
});
