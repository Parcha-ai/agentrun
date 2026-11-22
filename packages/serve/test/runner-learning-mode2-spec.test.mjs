// The runner's own spec builder supplies a run's end-of-run step (adapter-run-spec.ts adapterRunSpecFromLaunch endOfRun).
// A Mode 2 run's learning goes through the agent's learning store (learn/store-of.ts learningStoreOf), the one the server
// reads, never the run's Archil disk: a Mode 2 learning run through the real adapter loop and this spec builder, over an
// Archil fake whose exec is refused ("Exec is not enabled", as a disk on a plan without serverless exec answers), still
// compiles and merges; the server's Learning reads (learning-routes.ts) see the commits the runner made; the next run is
// laid the workflow it learned; and nothing of the learning is put on the disk or run there.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { seedOf } = await import("../dist/learning.js");
const { learningStoreOf } = await import("../dist/learn/store-of.js");
const { agentLearning, learningLog } = await import("../dist/learning-routes.js");
const { learningKey } = await import("../dist/workspace/index.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk, FakeDiskError } = await import("./fixtures/archil-fake.mjs");
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

/** An Archil disk whose exec is refused, as a plan without serverless exec refuses it: nothing run. */
class ExecOffDisk extends FakeArchilDisk {
  execs = 0;
  async exec() {
    this.execs += 1;
    throw new FakeDiskError(403, "Forbidden", "Exec is not enabled for this disk");
  }
}
const noShown = { text: (text) => text, name: (name) => name, holds: () => false };

test("Mode 2 with exec refused on the Archil disk: the run learns through the agent's learning store, the server's Learning reads see the runner's commits, and the next run is laid what it learned", async (t) => {
  const local = scratch("agentrun-learning-local-");
  const server = await openSqliteStore({ dataDir: local, role: "server" });
  const store = await openSqliteStore({ dataDir: local, role: "runner" });
  const disk = new ExecOffDisk();
  let runner;
  const control = archilControlFetch();
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(local, { recursive: true, force: true });
  });

  // The agent's learning store is the run's seed, with no workflow yet.
  const seed = await seedOf(local, "agent-1");
  // A job due to compile at every run.
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  const launchOf = (sha) => ({ input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, learning: { seed: sha, section: "" } });
  const launch = launchOf(seed.sha);
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  // The agent's own disk, made by an earlier run (run-disk.ts): the run's folder is there.
  await storeAgentDisk(server, "agent-1", { diskId: ARCHIL_SETTINGS.diskId });
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  // The run answers the job, then its compile turn drafts the job as workflow `answer`.
  const provider = { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"x"}` };
  const routeOf = async () => ({ model: MODEL, provider, price: () => 0, fetch: scriptedOrigin([{ say: "42" }, { say: DRAFT }]) });
  const deps = {
    env: {}, data: local, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf,
    computerForClaim: async () => ({ release: async () => {} }),
    makeArchilDisk: () => disk,
    mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
  };
  const specs = [];
  const loop = createAdapterLoop(async (claim, run) => {
    const spec = await adapterRunSpecFromLaunch(launch, run, deps, claim);
    specs.push(spec);
    return spec;
  });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`run-1 did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await runner.close();
  runner = undefined;

  // It learned: the compile was due and merged on the store's main.
  const kept = await server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  const main = (await seedOf(local, "agent-1")).sha;
  assert.equal(kept.proposal.merged, main, "the merge is the store's main");
  assert.equal(disk.execs, 0, "nothing was run on the disk");
  assert.deepEqual(disk.calls.filter((call) => call.op === "putObject" && call.key.startsWith(learningKey("agent-1"))), [], "nor a learning folder put on it");

  // The server's Learning reads see the runner's commits, as the store logs them.
  const logged = (await learningStoreOf(local, "agent-1").log(main)).map((commit) => commit.sha);
  const view = await agentLearning(local, "agent-1", noShown, { merged: 0, dropped: {} }, {}, () => "pending", async () => new Set());
  assert.equal(view.main, main, "the server's view reads the runner's main");
  assert.deepEqual(view.workflows.map((item) => item.name), ["answer"], "and the workflow it compiled");
  const page = await learningLog(local, "agent-1", new URLSearchParams(), noShown, async () => new Set());
  assert.equal(page.items[0].commit, main, "its log's newest change is the runner's merge");
  for (const { commit } of page.items) assert.ok(logged.includes(commit), `each change the server lists is on the store's main: ${commit}`);

  // The next run is laid what it learned.
  const next = launchOf(main);
  await server.runs.create({ id: "run-2", agentId: "agent-1", revisionId: "rev-1" }, { body: next });
  await server.flush?.();
  const [claim] = await store.runs.claimMany("runner-b", 1, { leaseMs: 60_000 });
  assert.equal(claim?.runId, "run-2");
  const registry = createRegistry();
  const harness = await Harness.open(store.journal(claim), { models: () => createModels(), registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  const spec = await adapterRunSpecFromLaunch(next, { harness, registry, setModels: () => {} }, deps, claim);
  t.after(() => spec.release?.().catch(() => {}));
  assert.deepEqual(spec.learningLaid, { workflows: ["answer"] }, "the next run is laid the learned workflow");
  assert.equal(disk.execs, 0, "and nothing was run on the disk for it");
});

test("a Mode 1 run supplies its end-of-run step from the spec builder only when it learns", async (t) => {
  const learns = await specFor(t, { body: { learning: true }, launch: { learning: { seed: "0".repeat(40), section: "" } } });
  assert.equal(typeof learns.spec.endOfRun, "function", "a run that learns gets the end-of-run step from its spec");
  const plain = await specFor(t, {});
  assert.equal(plain.spec.endOfRun, undefined, "a run that does not learn gets none");
});
