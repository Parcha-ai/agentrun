// A call a person is asked about is named by its settings key, as main names a pending approval (tool-gate.ts enter: the
// request's tool is settingsKeyOf's key, a shell tool its own name), never by the name the tool has on the wire
// (monid_discover, mcp__door__lookup). Pinned at the one writer, the ask entry the adapter loop writes, so every reader
// of it (the run's pending approval and its card, which an "always" answer pins by, its approval row) has that one
// name. Through the runner with the gate the dispatch builds (adapterRunGate, RunGate.decide), on pi through the adapter
// and on a CLI harness (codex, a scripted stand-in that calls the session's gate).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { settingsKeyOf } = await import("../dist/tool-gate.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A CLI stand-in whose one turn calls `tool` through the session's gate (as a CLI harness's own tools do), then waits. */
function askingCli(tool) {
  return {
    id: "codex",
    capabilities: () => ({}),
    check: () => [],
    async open(_spec, io) {
      let turn;
      return {
        get state() { return "new"; },
        async send() {
          turn = (async () => {
            await io.gate({ callId: "call-1", tool, args: { q: "acme" } }, BACKGROUND_CONTEXT);
            return await new Promise(() => {});
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

/** One run whose call of `tool` (its wire name) is set to ask by its settings key; parked on it: the ask entry and what
 *  the run's view serves as its pending approval. `harness`: the revision's harness ("pi", or "codex" for the CLI). */
async function askedRun(t, tool, harness) {
  const key = settingsKeyOf(harness, tool);
  const opened = await stores({ runners: 1 });
  await opened.server.settings.put("tool-settings", { [key]: { permission: "ask" } });
  await queue(opened.server, "run-1");
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-ask-key-"));
  const revision = { kind: "agentic", body: { approvals: "ask", harness } };
  const tools = { [tool]: { name: tool, replaySafe: false, ask: false, run: async () => "done" } };
  const base = harness === "pi" ? piAdapterSpec({ script: [{ call: tool, args: { q: "acme" } }, { say: "done" }], tools, hooks: quiet }) : undefined;
  const loop = createAdapterLoop(async (claim, run) => {
    const gate = await adapterRunGate(opened.runners[0], claim, revision, root);
    if (base) return { ...(await base(claim, run)), gate };
    return { adapter: askingCli(tool), session: { key: "root", label: "root", system: [], tools: [], context: "fresh" }, input: "Look it up.", record: "loop", hooks: quiet, gate };
  });
  const runner = startRunner({ store: opened.runners[0], createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === "parked" && now.runner === null && now;
  }, "the run parked on the ask", 30_000);
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const ask = entries.find((entry) => entry.kind === "agentrun.ask")?.data;
  return { key, ask };
}

for (const [harness, label] of [["pi", "pi through the adapter"], ["codex", "a CLI harness (codex)"]]) {
  for (const tool of ["monid_discover", "mcp__door__lookup"]) {
    test(`${label}: a ${tool} call asked about is named by its settings key on the ask entry, the one name its readers serve`, async (t) => {
      const { key, ask } = await askedRun(t, tool, harness);
      assert.notEqual(key, tool, "the case's tool has a settings key apart from its wire name");
      assert.equal(ask?.tool, key, `the ask entry names the settings key: ${JSON.stringify(ask)}`);
    });
  }
}
