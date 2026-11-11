// A CLI run whose final answer its model's output limit cut (the adapter's turn_end says stopReason "length") is
// unfinished: the run ends failed in loop-contract's cutAtLimit words, never ended, as a pi run's does. The CLI record
// keeps the cut on that turn's model message (agentrun.message stopReason, outputTokens), and the loop's cutLast reads
// it there as it reads pi's assistant entry. Here the CLI is a scripted stand-in that says one thing and ends its turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { observed, queue, recorder, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { cutAtLimit } = await import("../dist/runner/loop-contract.js");
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A CLI stand-in whose one turn says `text` (a list: a message boundary, text_end, between pieces) and ends with `end`
 *  (turn_end's own fields beside its status). */
function standInCli(text, end) {
  const pieces = Array.isArray(text) ? text : [text];
  return {
    id: "stand-in-cli",
    capabilities: () => ({}),
    check: () => [],
    async open(_spec, io) {
      const state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "idle" : "new";
      let turn;
      return {
        get state() { return state; },
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          turn = (async () => {
            for (const [index, piece] of pieces.entries()) {
              if (index > 0) io.onEvent({ type: "text_end" });
              io.onEvent({ type: "text", delta: piece });
            }
            io.onEvent({ type: "turn_end", status: "completed", ...end });
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

async function runOnce(t, text, end) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const createLoop = createAdapterLoop(() => ({
    adapter: standInCli(text, end),
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
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  // Each message is stamped when it was written (`at`, the loop's clock): checked here, then left out of what is compared.
  const said = records.entries.filter((entry) => entry.kind === "agentrun.message" && entry.data?.role === "model").map((entry) => entry.data);
  for (const message of said) assert.equal(typeof message.at, "number", `the record's message is stamped: ${JSON.stringify(message)}`);
  return { row, said: said.map(({ at: _at, ...rest }) => rest) };
}

test("a CLI turn whose final answer the output limit cut ends the run failed, saying so, its cut answer kept", async (t) => {
  const { row, said } = await runOnce(t, "The answer is", { stopReason: "length", outputTokens: 7 });
  assert.deepEqual([row.state, row.summary], ["failed", cutAtLimit(7)]);
  assert.deepEqual(said, [{ role: "model", text: "The answer is", stopReason: "length", outputTokens: 7 }]);
});

test("a CLI that resumes a cut answer inside its turn marks the boundary (text_end): two messages, and the run ends as its last says", async (t) => {
  const { row, said } = await runOnce(t, ["Part of it", "done"], {});
  assert.deepEqual([row.state, row.summary], ["ended", null]);
  assert.deepEqual(said, [{ role: "model", text: "Part of it" }, { role: "model", text: "done" }]);
});

test("a CLI turn that ends without a cut ends the run as its answer says", async (t) => {
  const { row, said } = await runOnce(t, "done", {});
  assert.deepEqual([row.state, row.summary], ["ended", null]);
  assert.deepEqual(said, [{ role: "model", text: "done" }]);
});
