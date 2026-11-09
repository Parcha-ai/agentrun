// A CLI run whose turn ends on its own error (a codex run whose MCP door could not be reached) fails in the CLI's own
// words: the run's summary carries the error the adapter's turn ended with, never only the loop's generic "the run gave
// no answer". Here the CLI is a scripted stand-in whose one turn ends failed with an error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { viewOverStore, summaryOverStore } = await import("../dist/store-view.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A CLI stand-in whose one turn ends `status` with `error`, its own words. */
function failingCli(status, error) {
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
            io.onEvent({ type: "turn_end", status, error });
            return { status, error };
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

async function runOnce(t, status, error, { opened: given } = {}) {
  const opened = given ?? (await stores({ runners: 1 }));
  await queue(opened.server, "run-1");
  const createLoop = createAdapterLoop(() => ({
    adapter: failingCli(status, error),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: "Answer.",
    record: "loop",
    hooks: quiet,
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  return until(async () => {
    const now = await opened.server.runs.get("run-1");
    return ["ended", "failed"].includes(now.state) && now.runner === null && now;
  }, "the run settled and released", 30_000);
}

test("a CLI turn that ends on its own error fails the run in the CLI's words, never only 'the run gave no answer'", async (t) => {
  const words = "codex: MCP server 'door' failed to start: connection refused";
  const row = await runOnce(t, "failed", words);
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.ok((row.summary ?? "").includes(words), `the run's summary carries the CLI's own error: ${JSON.stringify(row.summary)}`);
});

test("a CLI error that quotes a held secret is served without it: the run's view and its list row redact it, its other words kept", async (t) => {
  // The value the server holds (as its own secrets are), made here so no key-shaped literal sits in the source.
  const held = ["planted", "value", "Zq81Lm4Tx"].join("-");
  const words = `codex: MCP server 'door' refused the token ${held}: unauthorized`;
  const opened = await stores({ runners: 1 });
  const row = await runOnce(t, "failed", words, { opened });
  assert.ok((row.summary ?? "").includes(held), "the row keeps the CLI's words as they came (at rest, as every summary)");
  const deps = { origin: "https://run.test", serverSecrets: () => [held] };
  for (const [what, served] of [["the run's view", await viewOverStore(opened.server, "run-1", deps)], ["its list row", await summaryOverStore(opened.server, "run-1", deps)]]) {
    const message = String(served?.error?.message ?? "");
    assert.ok(!message.includes(held), `${what} never serves the held value: ${JSON.stringify(served?.error)}`);
    assert.ok(message.includes("MCP server 'door' refused the token"), `${what} keeps the CLI's other words: ${JSON.stringify(served?.error)}`);
  }
});

test("a CLI error cut at its bound never splits a character: an emoji straddling the cut leaves no lone surrogate", async (t) => {
  const row = await runOnce(t, "failed", `${"x".repeat(499)}\u{1F600} and more words past the bound`);
  assert.equal(row.state, "failed", JSON.stringify(row));
  // A lone surrogate is stored as U+FFFD (the store writes UTF-8): the summary keeps whole characters only.
  const summary = row.summary ?? "";
  assert.ok(summary.isWellFormed() && !summary.includes("�"), `the summary keeps whole characters: ends ${JSON.stringify(summary.slice(-3))}`);
  assert.ok(summary.startsWith("x".repeat(499)), "the words before the cut are kept");
});

test("a CLI turn that fails with no words of its own still ends the run failed in the loop's words", async (t) => {
  const row = await runOnce(t, "failed", undefined);
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.match(row.summary ?? "", /gave no answer/);
});
