// A CLI run whose turn ends on its own error (a codex run whose MCP door could not be reached) fails in the CLI's own
// words: the run's summary carries the error the adapter's turn ended with, never only the loop's generic "the run gave
// no answer". Here the CLI is a scripted stand-in whose one turn ends failed with an error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { viewOverStore, summaryOverStore } = await import("../dist/store-view.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");
const { secretRedactor } = await import("../dist/runner/redact.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
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

async function runOnce(t, status, error, { opened: given, redact } = {}) {
  const opened = given ?? (await stores({ runners: 1 }));
  await queue(opened.server, "run-1");
  const createLoop = createAdapterLoop(() => ({
    adapter: failingCli(status, error),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: "Answer.",
    record: "loop",
    hooks: quiet,
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...TIMING, ...(redact ? { redact } : {}) });
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

test("a CLI turn that ends on a provider error journals main's error row: pi's error answer in the end's commit, an error row on the timeline, served cut of the held key, the CLI's words kept", async (t) => {
  // The key the runner holds (as it holds the run's model key), made here so no key-shaped literal sits in the source.
  const held = ["planted", "model", "key", "Wd52Pq7Ks"].join("-");
  const words = `claude-agent: Failed to authenticate. API Error: 401 the key ${held} was not found.`;
  const opened = await stores({ runners: 1 });
  const row = await runOnce(t, "failed", words, { opened, redact: secretRedactor([held]) });
  assert.equal(row.state, "failed", JSON.stringify(row));
  // The end's commit carries pi's own error answer right before the end (main's harness writes a CLI turn's error so).
  const entries = (await journalEntries(opened.server.readJournal("run-1"), BACKGROUND_CONTEXT)).slice().sort((a, b) => Number(a.id) - Number(b.id));
  const end = entries.findIndex((entry) => entry.kind === "agentrun.end");
  const answer = entries[end - 1];
  assert.equal(answer?.kind, "pi.assistant", `the entry before the end is pi's error answer: ${JSON.stringify(entries.map((entry) => entry.kind))}`);
  assert.equal(answer.model?.[0]?.stopReason, "error", JSON.stringify(answer.model));
  assert.ok(!JSON.stringify(answer).includes(held), `the error answer is journaled cut of the held key: ${JSON.stringify(answer.model?.[0]?.errorMessage)}`);
  // The timeline reads it as an error row, served cut: the held key absent, the CLI's words present.
  const errors = (await runTimeline(opened.server, "run-1", BACKGROUND_CONTEXT)).filter((r) => r.kind === "error");
  assert.equal(errors.length, 1, `one error row: ${JSON.stringify(errors)}`);
  for (const text of [errors[0].summary, errors[0].text]) {
    assert.ok(!String(text).includes(held), `the row never shows the held key: ${JSON.stringify(text)}`);
    assert.ok(String(text).includes("Failed to authenticate. API Error: 401"), `the row keeps the CLI's words: ${JSON.stringify(text)}`);
  }
  const served = await viewOverStore(opened.server, "run-1", { origin: "https://run.test", serverSecrets: () => [held] });
  assert.ok(!JSON.stringify(served).includes(held), "the run's view never serves the held key");
  assert.ok(String(served?.error?.message ?? "").includes("Failed to authenticate. API Error: 401"), JSON.stringify(served?.error));
});

test("a CLI turn that fails with no words of its own still ends the run failed in the loop's words", async (t) => {
  const row = await runOnce(t, "failed", undefined);
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.match(row.summary ?? "", /gave no answer/);
});
