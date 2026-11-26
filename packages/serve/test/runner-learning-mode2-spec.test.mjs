// The runner's own spec builder supplies a run's end-of-run step (adapter-run-spec.ts adapterRunSpecFromLaunch endOfRun),
// moved off the dispatch (harness-loops.ts). A Mode 2 learning run (its folder on the claim's Archil disk) through the
// real adapter loop and this spec builder compiles from and merges into the agent's learning rows in the store, as a
// Mode 1 run does: nothing of its learning is on the disk.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");
const { specFor } = await import("./runner-spec-support.mjs");

after(closeOpenSessions);

const SEAL_KEY = Buffer.alloc(32, 7);
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));
/** Workflow `name` (one model step answering the question as a number). */
const flow = (name) => ({
  v: 2, name,
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
});
const DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify(flow("answer"))}\n\`\`\`\``;

test("a Mode 2 learning run through the pi spec builder compiles from and merges into the agent's learning rows", async (t) => {
  const local = scratch("agentrun-learning-local-");
  const server = await openSqliteStore({ dataDir: local, role: "server" });
  const store = await openSqliteStore({ dataDir: local, role: "runner" });
  let runner;
  const control = archilControlFetch();
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(local, { recursive: true, force: true });
  });

  // The agent's learning, its first save empty: the run's seed.
  const seed = (await server.learning.seed("agent-1")).save.id;

  // A job due to compile at every run.
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, learning: { seed, section: "" } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  // The agent's own disk, made by an earlier run (run-disk.ts): this run keeps its folder there.
  await storeAgentDisk(server, "agent-1", { diskId: ARCHIL_SETTINGS.diskId });
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  // The run answers the job, then its compile turn drafts the job as workflow `answer`.
  const provider = { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"x"}` };
  const routeOf = async () => ({ model: MODEL, provider, price: () => 0, fetch: scriptedOrigin([{ say: "42" }, { say: DRAFT }]) });
  const deps = {
    env: {}, data: local, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf,
    computerForClaim: async () => ({ release: async () => {} }),
    makeArchilDisk: () => new FakeArchilDisk(),
    mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
  };
  const loop = createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim));
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`run-1 did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // The compile was due and merged on the agent's rows: the newest save, the one after the seed.
  const kept = await server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  const newest = await server.learning.newest("agent-1");
  assert.equal(kept.proposal.merged, newest.save.id, "the merge is the agent's newest save");
  assert.deepEqual(newest.save.by, { run: "run-1" });
  assert.deepEqual(newest.items.filter((item) => item.kind === "workflow").map((item) => item.name), ["answer"]);
});

test("a Mode 1 run supplies its end-of-run step from the spec builder only when it learns", async (t) => {
  const learns = await specFor(t, { body: { learning: true }, launch: { learning: { seed: "0".repeat(40), section: "" } } });
  assert.equal(typeof learns.spec.endOfRun, "function", "a run that learns gets the end-of-run step from its spec");
  const plain = await specFor(t, {});
  assert.equal(plain.spec.endOfRun, undefined, "a run that does not learn gets none");
});
