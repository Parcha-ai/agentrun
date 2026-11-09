// A call waiting for approval declined by a person's MESSAGE keeps that it was: the deny row the message route writes
// names it (`by: "message"`), and the answer the runner writes for it carries the same, so the call's approval row can
// read "Declined by your message" (main's declineBy). A deny the owner gives directly carries none. pi through the
// adapter loop, with a spec gate that asks about its one tool.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

async function entriesOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
}

/** One pi run parked on its asked call, then denied with `body` (beside the call's id); the answer the runner wrote. */
async function deniedWith(t, body) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const tools = { add: { name: "add", replaySafe: false, ask: true, run: async () => "5" } };
  const script = [{ call: "add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, []) });
  const gate = Object.assign(() => "ask", { askedAs: (tool) => tool });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await base(claim, run)), gate }));
  const runner = startRunner({ store: opened.runners[0], createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).state === "parked", "the run parked on the call", 30_000);
  const callId = (await entriesOf(opened.server)).find((entry) => entry.kind === "agentrun.ask").data.callId;
  await opened.server.command("run-1", { kind: "deny", body: { approval: callId, ...body } });
  return until(async () => (await entriesOf(opened.server)).find((entry) => entry.kind === "agentrun.answer")?.data, "the deny answered", 30_000);
}

test("a deny a person's message gave is answered as declined by their message, with their words", { timeout: 60_000 }, async (t) => {
  const answer = await deniedWith(t, { note: "use the cached sum instead", by: "message" });
  assert.deepEqual([answer.decision, answer.note, answer.by], ["deny", "use the cached sum instead", "message"]);
});

test("a deny the owner gives directly carries no message mark", { timeout: 60_000 }, async (t) => {
  const answer = await deniedWith(t, { note: "not today" });
  assert.deepEqual([answer.decision, answer.note, answer.by], ["deny", "not today", undefined]);
});
