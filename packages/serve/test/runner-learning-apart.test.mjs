// A runner whose data directory is not its server's (runner/disk-free.ts: Mode 2 on Postgres lets one sit on its own)
// can't reach the server's local learning folder (learn/store-of.ts LEARNING_APART). With no code.storage settings, a
// learning agent's run on it still runs, at once and to its end, with no seed laid and nothing written at its end, and
// its words name the settings that would let it learn. With code.storage set on both, the runner and the server use the
// one remote store: the run learns, and the server reads what it learned.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { codeStorageFake } from "./fixtures/code-storage-fake.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { seedOf } = await import("../dist/learning.js");
const { learningApart, learningStoreFromEnv, learningStoreOf, useLearningStore } = await import("../dist/learn/store-of.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { commitChange, learningInit, readSnapshot } = await import("../dist/learn/folder.js");
const { agentLearning } = await import("../dist/learning-routes.js");
const { agentLearningFolder } = await import("../dist/workspace/index.js");

after(closeOpenSessions);

const SEAL_KEY = Buffer.alloc(32, 7);
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));
const noShown = { text: (text) => text, name: (name) => name, holds: () => false };

/** Agent agent-1's run run-1 (it learns: compile due at every run, its launch's section `SECTION`) on a runner whose
 *  data directory is `runnerData`, the server's `serverData`, through the runner's dispatch (runner/dispatch.ts) as
 *  every runner reads a launch; the model answers, then answers its compile turn with DRAFT. The run's row, the spec it
 *  was laid, the model's requests and the run's learning. */
async function runApart(t, { serverData, runnerData }) {
  const server = await openSqliteStore({ dataDir: serverData, role: "server" });
  const store = await openSqliteStore({ dataDir: serverData, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
  });
  const seed = await seedOf(serverData, "agent-1");
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, learning: { seed: seed.sha, section: SECTION } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const provider = { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"x"}` };
  const requests = [];
  const routeOf = async () => ({ model: MODEL, provider, price: () => 0, fetch: scriptedOrigin([{ say: "42" }, { say: DRAFT }], requests) });
  const deps = { env: {}, data: runnerData, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf, computerForClaim: async () => ({ release: async () => {} }) };
  const specs = [];
  const loop = createDispatchLoop({
    launchOf: (runId) => store.runs.launch(runId),
    resolve: (_harness, dispatched) => createAdapterLoop(async (claim, run) => {
      const spec = await adapterRunSpecFromLaunch(dispatched, run, deps, claim);
      specs.push(spec);
      return spec;
    }),
    apart: () => learningApart(runnerData),
  });
  runner = startRunner({ store, createLoop: loop, name: "runner-apart", ...TIMING });
  const started = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() - started > WAIT_MS) throw new Error(`run-1 did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await runner.close();
  runner = undefined;
  return { row, spec: specs[0], requests, proposal: (await server.learning.proposal("run-1"))?.proposal, waitedMs: Date.now() - started };
}

const SECTION = "# Learned\n\n- Be brief.\n";
const flow = (name) => ({
  v: 2, name,
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
});
const DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify(flow("answer"))}\n\`\`\`\``;
const systemOf = (request) => JSON.stringify(request?.system ?? "");

/** Two data directories (the server's, the runner's), and the server's store with one correction on main. */
async function twoDisks(t, settings) {
  const serverData = scratch("agentrun-apart-server-");
  const runnerData = scratch("agentrun-apart-runner-");
  t.after(() => {
    useLearningStore(serverData, undefined);
    useLearningStore(runnerData, undefined);
    rmSync(serverData, { recursive: true, force: true });
    rmSync(runnerData, { recursive: true, force: true });
  });
  if (settings) useLearningStore(serverData, settings);
  const learning = learningStoreOf(serverData, "agent-1");
  await learningInit(learning);
  await commitChange(learning, await readSnapshot(learning), { by: { run: "run-0", reason: "A correction." }, writes: [{ path: "corrections.md", text: "- Be brief.\n" }] });
  return { serverData, runnerData, learning };
}

test("a runner apart from its server's disk with no code.storage set runs a learning agent's run at once with nothing learned: no seed or # Learned section laid, no compile turn, nothing written; its learning names the settings", async (t) => {
  const { serverData, runnerData, learning } = await twoDisks(t);
  const before = await learning.head();
  // The runner's start (learningStoreFromEnv, apart, no code.storage settings): its log names the two settings, once.
  const warned = [];
  learningStoreFromEnv(runnerData, {}, async () => "srv1", { apart: true, key: () => undefined, warn: (line) => warned.push(line) });
  assert.equal(learningApart(runnerData), true);
  assert.equal(warned.length, 1, JSON.stringify(warned));
  assert.match(warned[0], /its runs run with nothing learned: .*AGENTRUN_CODE_STORAGE_NAME and AGENTRUN_CODE_STORAGE_KEY/);
  const out = await runApart(t, { serverData, runnerData });
  assert.equal(out.row.state, "ended");
  assert.ok(out.row.error == null, `the run itself is never refused: ${JSON.stringify(out.row)}`);
  assert.ok(out.waitedMs < WAIT_MS, "it never waits");
  assert.equal(out.requests.length, 1, "the job's turn alone: no compile turn");
  assert.ok(systemOf(out.requests[0]).includes("Answer."), "the agent's instructions are laid");
  assert.ok(!systemOf(out.requests[0]).includes("Be brief"), "the server's # Learned section is not");
  assert.deepEqual(out.spec.learningLaid, { workflows: [] }, "no learned workflow laid");
  assert.equal(await learning.head(), before, "nothing written to the server's store");
  assert.equal(existsSync(agentLearningFolder(runnerData, "agent-1")), false, "nor a learning folder made on the runner's own disk");
  assert.equal(out.proposal?.state, "dropped", JSON.stringify(out.proposal));
  assert.equal(out.proposal.reason, "seed_failed");
  assert.match(out.proposal.detail, /data directory is not the server's/);
  assert.match(out.proposal.detail, /Set code\.storage's name and key on the server and on its runners/, "in a person's words, naming the settings");
});

test("with code.storage set, a runner apart from its server's disk uses the one remote store: its run is laid what the server learned, learns, and the server reads the merge", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const fake = codeStorageFake({ name: "example-org", publicKey });
  const settings = { name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => "srv1" };
  const { serverData, runnerData, learning } = await twoDisks(t, settings);
  // The runner's start: apart, code.storage set on it as on the server.
  useLearningStore(runnerData, settings);
  assert.equal(learningApart(runnerData), false);
  const out = await runApart(t, { serverData, runnerData });
  assert.equal(out.row.state, "ended");
  assert.ok(systemOf(out.requests[0]).includes("Be brief"), "the # Learned section is laid");
  assert.equal(out.requests.length, 2, "and its compile turn asked");
  assert.equal(out.proposal?.state, "merged", JSON.stringify(out.proposal));
  const main = await learning.head();
  assert.equal(out.proposal.merged, main, "the merge is the server's store's main");
  const view = await agentLearning(serverData, "agent-1", noShown, { merged: 0, dropped: {} }, {}, () => "pending");
  assert.equal(view.main, main);
  assert.deepEqual(view.workflows.map((item) => item.name), ["answer"]);
  assert.deepEqual([...new Set(fake.calls.map((call) => call.repo))], ["agentrun-srv1-agent-1"], "one repository, the agent's");
  assert.equal(existsSync(agentLearningFolder(runnerData, "agent-1")), false, "no local learning folder on the runner's disk");
});
