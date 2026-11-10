// A run's host phase rows from its spec (AdapterRun.phase): a step of the host's own that the run's timeline shows as one
// `phase` row (pi-durable-agent's HOST_PHASE, "such as a box waiting for its image"). A spec says a phase while it is
// built, before the adapter loop makes the run's root conversation (the claim's computer waiting on its image): the row is
// queued and written once the root is made, exactly once. One said after the root exists is written at once.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { HOST_PHASE } from "@parcha/pi-durable-agent/timeline";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
after(closeOpenSessions);
const BEFORE = "Preparing the computer's image: building it (python, git, curl, node, npm, rg)…";
const AFTER = "A step of the host's, said once the root exists.";

/** The HOST_PHASE rows on run-1's root, in order (none when it has no root). Read without making anything. */
async function phaseRows(store) {
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    if (!root) return [];
    const out = [];
    for (let cursor; ; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) if (entry.kind === HOST_PHASE) out.push(entry.data);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return out;
  } finally {
    await harness.close(BACKGROUND_CONTEXT).catch(() => {});
  }
}

test("a phase the spec says while it is built (before the root) is one phase row on the root, written once it is made; one said after is written at once", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-loop-phase-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Phases" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  // A host tool that says a phase while the run runs: the root exists by then.
  const said = { name: "said", replaySafe: true, ask: false, run: async () => "said" };
  const spec = piAdapterSpec({ script: [{ call: "said" }, { say: "done" }], tools: { said }, hooks: quiet });
  const before = [];
  const loop = createAdapterLoop(async (claim, run) => {
    before.push(typeof run.phase);
    // Said while the spec is built: no root yet.
    run.phase?.(BEFORE);
    const base = await spec(claim, run);
    const tools = base.session.tools.map((tool) => (tool.name === "said" ? { ...tool, call: async () => (run.phase?.(AFTER), { text: "said" }) } : tool));
    return { ...base, agentId: "agent-1", session: { ...base.session, tools } };
  });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`run-1 did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(before, ["function"], "the loop hands the spec a phase");
  const rows = await phaseRows(server);
  assert.deepEqual(rows.map((one) => one.summary), [BEFORE, AFTER], `one row each, the one said before the root first: ${JSON.stringify(rows)}`);
  for (const one of rows) assert.equal(typeof one.at, "number", "each at the time it was said");
  assert.ok(rows[0].at <= rows[1].at);
});
