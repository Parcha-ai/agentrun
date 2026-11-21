// A Mode 2 server (Archil run disks) keeps every agent's learning folder in its own data directory, as Mode 1 does, and
// runs learning.sh there: never on an Archil disk, never through Archil's serverless exec (which runs only in Archil's
// own regions, so a server elsewhere is refused every exec: "Exec is not enabled"). The Archil fake below refuses every
// exec in those words, as a disk in such a region is refused it. Through a real runner on the pi spec builder, every run
// claimed on the agent's Archil disk:
//   - run-c, the agent's first completed run (compile_after 1), is asked its compile turn and drafts workflow `answer`,
//     which merges into the learning folder in the data directory;
//   - run-1, launched at that main, goes to the agent while the new digest is checked (one replay of run-c's input);
//   - run-2 is served the workflow first.
// Nothing of the learning folder is on the disk, and no exec was asked of it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { seedOf } = await import("../dist/learning.js");
const { saveArchilSettings, storeAgentDisk } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk, FakeDiskError } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const FINAL = ["ended", "failed", "stopped"];
const AGENT_SAYS = JSON.stringify({ answer: 42, sure: true });
const COMPILE_ASK = "One more turn: write this agent's job as a learned workflow.";

const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};
const DIGEST = workflowDigest({ workflow: JSON.stringify(answerFlow) });
const DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"question":"What is six times seven?"}\n---\n${JSON.stringify(answerFlow)}\n\`\`\`\``;

/** An Archil disk in a region with no serverless exec: every exec refused, as Archil refuses it there. */
class NoExecDisk extends FakeArchilDisk {
  execs = 0;
  async exec() {
    this.execs += 1;
    throw new FakeDiskError(400, "ValidationError", "Exec is not enabled");
  }
}

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
/** The text of a request's last user message. */
const lastUser = (body) => {
  const users = (body?.messages ?? []).filter((message) => message.role === "user");
  const content = users.at(-1)?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part?.text ?? "").join("");
};

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("a Mode 2 run on its Archil disk, whose exec is refused, compiles a learned workflow into the server's own data directory, and a later run is served it", { timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mode2-learning-local-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const disk = new NoExecDisk();
  const control = archilControlFetch();
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : lastUser(body).startsWith(COMPILE_ASK) ? DRAFT : AGENT_SAYS),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  await storeAgentDisk(server, "agent-1", { diskId: ARCHIL_SETTINGS.diskId });
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = {
    env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route,
    computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line),
    makeArchilDisk: () => disk,
    mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
  };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });

  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  // Launched as the server launches a run: at the learning folder's main in its data directory now.
  const start = async (id, question) => {
    const at = (await seedOf(dir, "agent-1")).sha;
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt(at) } });
    return { row: await ended(id), at };
  };

  // run-c: the agent answers, then its compile turn drafts `answer`, merged into the data directory's folder.
  const c = await start("run-c", "What is six times seven");
  assert.equal(c.row.state, "ended", JSON.stringify(c.row));
  const kept = await server.learning.proposal("run-c");
  assert.equal(kept?.proposal?.state, "merged", `${JSON.stringify(kept?.proposal)}\n${logs.join("\n")}`);
  assert.deepEqual(kept.proposal.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  const main = await seedOf(dir, "agent-1");
  assert.notEqual(main.sha, c.at, "main moved");
  assert.equal(kept.proposal.merged, main.sha, "the merge is the data directory's main");

  // run-1: the new digest is checked on run-c's input while the agent takes the run.
  const first = await start("run-1", "What is seven times six");
  assert.equal(first.row.metrics?.path, "agent", JSON.stringify(first.row.metrics));
  await until(async () => {
    const replays = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) if ((await server.runs.launch(row.id)).body?.replay) replays.push(row);
    return replays.length > 0 && replays.every((row) => FINAL.includes(row.state) && row.runner === null);
  }, "the check's replay runs ended");

  // run-2: promoted at the bar, served first.
  const second = await start("run-2", "What is eight times five");
  assert.equal(second.row.metrics?.path, "workflow", `${JSON.stringify(second.row.metrics)}\n${logs.join("\n")}`);
  assert.equal(second.row.metrics?.workflow_digest, DIGEST);
  assert.ok((await promotionsOf(server.settings, "agent-1")).some(({ digest, decided }) => digest === DIGEST && decided === "promote"));

  // The disk holds nothing of the learning folder, and no exec was ever asked of it.
  assert.deepEqual([...disk.files.keys()].filter((key) => key.startsWith("agents/agent-1/learning")), [], "no learning key on the disk");
  assert.equal(disk.execs, 0, "no exec was asked of the disk");
});
