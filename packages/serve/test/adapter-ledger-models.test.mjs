// A tool host takes the run's proxied models when its spec is built (AdapterRun.ledger.models(label), as main's process
// takes portModels(() => sessionPort?.(LEARNED_WORKFLOW_TOOL)) before any drive): lazy, so a learned workflow's model node
// holds them from the spec's build, before the session opens, and its model call, made once the session is open, goes
// through the session's proxy under its side key and books on the run's ledger, labelled, as the harness's own requests
// do. The CLI harness here is claude-agent's stand-in, through the runner, its proxy forwarding to a scripted upstream.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { fakeSdk } from "@parcha/agentrun-harness-claude/testing";
import { closeOpenSessions, MODEL } from "./conformance-claude-agent.mjs";
import { scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { resolveHarness } = await import("../dist/runner/adapters/index.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const LABEL = "learned_workflow";
const INPUT = "Follow the script.";
after(closeOpenSessions);
process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = "1";

test("a learned workflow's models taken at its spec's build, before the session opens, book its model call on the run's ledger under its label", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-ledger-models-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learned" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });

  /** What the spec's build took (the models' promise, before the session opened), and what the node's call answered. */
  let atBuild;
  const said = [];
  const upstream = [];
  const node = {
    name: "node",
    description: "A learned workflow's model node.",
    inputSchema: { type: "object", properties: {} },
    replay: "never",
    call: async () => {
      const models = await atBuild;
      if (!models) return (said.push("no models at the spec's build"), { text: "no models" });
      const model = models.getModels()[0];
      const answer = await models.completeSimple(model, { messages: [{ role: "user", content: "The node's question.", timestamp: Date.now() }] });
      said.push(answer.stopReason);
      return { text: "the node answered" };
    },
  };
  const harness = resolveHarness("claude-agent");
  const loop = createAdapterLoop(async (_claim, run) => {
    atBuild = run.ledger?.models(LABEL);
    return {
      adapter: await harness.adapter(
        { run, model: MODEL, provider: { origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, price: () => 0, sessionsDir: dir, fetch: scriptedOrigin([{ say: "the side answer" }], upstream) },
        { standIn: { command: process.execPath }, sdk: fakeSdk({ mirrorLagMs: 10, script: (text) => (text === INPUT || text.endsWith(`\n\n${INPUT}`) ? "call node {}" : undefined), reply: () => "done" }) },
      ),
      record: harness.record,
      session: { key: "root", label: "root", system: ["Follow the script."], tools: [node], context: "fresh" },
      input: INPUT,
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      hooks: quiet,
      gate: () => "allow",
    };
  }, { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state !== "queued" && row.state !== "running" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}; ${JSON.stringify(said)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(typeof atBuild?.then, "function", `its models taken at the spec's build: ${String(atBuild)}`);
  assert.deepEqual(said, ["stop"], `the node's call was answered through the session's proxy: ${JSON.stringify(said)}`);

  // The run's root session, read under a reader's claim: the node's request is booked there under its label.
  const row = await store.runs.get("run-1");
  const reader = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const records = await journalSessions(reader, ctx, store).read("root");
    const requests = records.filter((r) => r.kind === "runner.request" && r.data.host === LABEL);
    assert.equal(requests.length, 1, `one request under its label: ${JSON.stringify(records.map((r) => [r.kind, r.data]))}`);
    const turn = records.find((r) => r.kind === "runner.turn" && r.data.turn === requests[0].data.turn);
    assert.ok(turn, `and booked: ${JSON.stringify(records.map((r) => [r.kind, r.data]))}`);
  } finally {
    await reader.close(ctx);
  }
});
