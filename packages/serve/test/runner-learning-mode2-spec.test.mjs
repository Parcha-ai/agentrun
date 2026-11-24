// The runner's own spec builder supplies a run's end-of-run step (adapter-run-spec.ts adapterRunSpecFromLaunch endOfRun),
// moved off the dispatch (harness-loops.ts) so a Mode 2 run's learning folder is the one on the run's own Workspace — the
// claim's Archil disk — never this machine's local data directory. A Mode 2 learning run through the real adapter loop and
// this spec builder compiles from and merges into that folder: the Archil folder stands in for the disk as a local
// directory of its own (folderTestHooks.workspace, every place it is asked for recorded), so the test sees the run asked
// for the folder as { mode: "archil" } and the merge is on the disk's main; the local learning path holds a decoy (a learned
// workflow), and a read of it would make the compile not due.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { readmeOf } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { seedOf } = await import("../dist/learning.js");
const { folderTestHooks } = await import("../dist/learn/folder.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
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

test("a Mode 2 learning run through the pi spec builder checks its proposal against the learning folder on the run's Archil disk, never the local data directory", async (t) => {
  const local = scratch("agentrun-learning-local-");
  const diskFolder = scratch("agentrun-learning-disk-");
  const server = await openSqliteStore({ dataDir: local, role: "server" });
  const store = await openSqliteStore({ dataDir: local, role: "runner" });
  let runner;
  const control = archilControlFetch();
  t.after(async () => {
    delete folderTestHooks.workspace;
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    for (const dir of [local, diskFolder]) rmSync(dir, { recursive: true, force: true });
  });

  // The disk's learning folder is the run's seed, with no workflow yet; the local data directory a decoy with one.
  const seed = await seedOf(diskFolder, "agent-1");
  const decoyFolder = learningWorkspace({ mode: "local", data: local, agentId: "agent-1" });
  try {
    const made = await learningCommit(decoyFolder.workspace, { runId: "person-decoy", reason: "A decoy", files: [{ path: "workflows/decoy/workflow.json", text: JSON.stringify(flow("decoy")) }, { path: "workflows/decoy/README.md", text: readmeOf("decoy", "A decoy; use never") }] });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await decoyFolder.end();
  }
  const decoy = await seedOf(local, "agent-1");
  assert.notEqual(decoy.sha, seed.sha, "the decoy is another commit, with a learned workflow");

  // A job due to compile at every run.
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, learning: { seed: seed.sha, section: "" } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  // The agent's own disk, made by an earlier run (run-disk.ts): this run keeps its folder there.
  await storeAgentDisk(server, "agent-1", { diskId: ARCHIL_SETTINGS.diskId });
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  // The run's Archil learning folder stands in for the disk as a real local Workspace on diskFolder: every place it is
  // asked for is recorded, so the test sees the spec builder asked for it as { mode: "archil" }. Set after the seed and the
  // decoy are written, so those are the real ones.
  const places = [];
  folderTestHooks.workspace = (place) => {
    places.push(place);
    return learningWorkspace({ mode: "local", data: place.mode === "archil" ? diskFolder : place.data, agentId: place.agentId });
  };

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
    if (Date.now() > deadline) throw new Error(`run-1 did not end: ${JSON.stringify(row)}; places ${JSON.stringify(places)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // The spec builder asked for the run's learning folder as the Archil disk's, for this agent (Mode 2).
  assert.ok(places.some((place) => place.mode === "archil" && place.agentId === "agent-1"), `the learning folder was asked for as the run's Archil disk: ${JSON.stringify(places)}`);
  assert.ok(!places.some((place) => place.mode === "local"), `and never as the local data directory: ${JSON.stringify(places)}`);
  // The compile was due on the disk's folder (the local decoy's workflow would make it not due) and merged there.
  const kept = await server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  assert.equal(kept.proposal.merged, (await seedOf(diskFolder, "agent-1")).sha, "the merge is the disk's main");
  assert.equal((await seedOf(local, "agent-1")).sha, decoy.sha, "the local folder is the decoy still");
});

test("a Mode 1 run supplies its end-of-run step from the spec builder only when it learns", async (t) => {
  const learns = await specFor(t, { body: { learning: true }, launch: { learning: { seed: "0".repeat(40), section: "" } } });
  assert.equal(typeof learns.spec.endOfRun, "function", "a run that learns gets the end-of-run step from its spec");
  const plain = await specFor(t, {});
  assert.equal(plain.spec.endOfRun, undefined, "a run that does not learn gets none");
});
