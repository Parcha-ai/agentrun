// An adapter's notice (run-adapters AdapterEvent "notice": the ACP mirror past its budget, in its words) is a step of the
// run on its record, a phase row (HOST_PHASE) after what the model said before it, never the model's text. Here the CLI
// is a scripted stand-in that says something, gives a notice, says more and ends its turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { HOST_PHASE } = await import("../dist/timeline/index.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const WORDS = "The agent's session state passed 8 MiB, so a resume starts it fresh with the conversation so far.";

function standInCli() {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(_spec, io) {
      const state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "idle" : "new";
      let turn;
      return {
        get state() { return state; },
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          turn = (async () => {
            io.onEvent({ type: "text", delta: "Working on it." });
            io.onEvent({ type: "notice", text: WORDS });
            io.onEvent({ type: "text", delta: "Done." });
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() {},
        turnEnd: () => turn,
        async interrupt() {},
        async close() {},
      };
    },
  };
}

test("an adapter's notice is a phase row on the run's record, in its words, after what the model said before it", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const createLoop = createAdapterLoop(() => ({
    adapter: standInCli(),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: "Answer.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    hooks: quiet,
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return ["ended", "failed"].includes(now.state) && now.runner === null && now;
  }, "the run settled and released", 5_000);
  assert.equal(row.state, "ended", row.summary);
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const steps = records.entries
    .filter((entry) => entry.kind === HOST_PHASE || (entry.kind === "agentrun.message" && entry.data?.role === "model"))
    .map((entry) => (entry.kind === HOST_PHASE ? ["phase", entry.data.summary] : ["model", entry.data.text]));
  assert.deepEqual(steps, [["model", "Working on it."], ["phase", WORDS], ["model", "Done."]]);
  const phase = records.entries.find((entry) => entry.kind === HOST_PHASE);
  assert.equal(typeof phase.data.at, "number", "stamped when written");
});
