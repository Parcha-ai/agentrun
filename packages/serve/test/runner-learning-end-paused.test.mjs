// A learning folder whose disk can't run its script (an Archil account or region with serverless exec off: every exec
// fails UNAVAILABLE "the Archil exec failed: Exec is not enabled") pauses the agent's learning. A run end that would
// compile asks its compile turn once, and the draft's check, which reads the seed with one exec of the learning script,
// can't run: the run's learning is dropped `paused` in learning's words, no compile attempt is counted on the agent's
// promotion records, nothing stops its compiles, and the loop read (GET /agents/{id}/learning/loop, the console Learning
// tab's) says learning is paused. Once exec works, the next run's compile is the agent's first and lands, with nothing
// to reset. Through a real runner, its learning folder the real learningWorkspace over a directory of its own, its exec
// failing as Archil's does while the disk can't run it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { seedOf } = await import("../dist/learning.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { compileStoppedOf, draftFailedOf, newCompileAttempt } = await import("../dist/learn/compile.js");
const { agentLoopOverStore } = await import("../dist/store-reads/loop.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { WorkspaceError } = await import("../dist/workspace/workspace.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));

/** The words a paused learning says, the lead's ruling's. */
const PAUSED = /learning paused: the disk can't run the folder script/;
/** Archil's answer to an exec on an account or region where serverless exec is off. */
const EXEC_OFF = "the Archil exec failed: Exec is not enabled";

const flow = (name) => ({
  v: 2, name,
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
});
const DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify(flow("answer"))}\n\`\`\`\``;

/** Agent-1, due to compile at every completed run (compile_after 1), on a learning folder of its own whose main moved
 *  past the runs' seed (a correction landed after it), so a draft's check reads the seed with one exec of the learning
 *  script. `exec.off`: every exec of the folder fails as Archil's does with exec off. `run(id)` runs one run to its end
 *  through a real runner and answers its kept learning and its model requests. */
async function world(t) {
  const data = scratch("agentrun-learning-paused-data-");
  const disk = scratch("agentrun-learning-paused-disk-");
  const server = await openSqliteStore({ dataDir: data, role: "server" });
  const closing = [];
  t.after(async () => {
    for (const close of closing.reverse()) await close().catch(() => {});
    await server.close().catch(() => {});
    for (const dir of [data, disk]) rmSync(dir, { recursive: true, force: true });
  });
  const seed = await seedOf(disk, "agent-1");
  const folder = learningWorkspace({ mode: "local", data: disk, agentId: "agent-1" });
  try {
    const moved = await learningCommit(folder.workspace, { runId: "person-1", reason: "A person's edit", files: [], correction: "Read the whole input once." });
    assert.equal(moved.ok, true, JSON.stringify(moved));
  } finally {
    await folder.end();
  }
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  const exec = { off: true, refused: 0 };
  const learningFolder = (agentId) => {
    const opened = learningWorkspace({ mode: "local", data: disk, agentId });
    const run = opened.workspace.exec;
    opened.workspace.exec = (argv, options) => {
      if (!exec.off) return run(argv, options);
      exec.refused += 1;
      return Promise.reject(new WorkspaceError("UNAVAILABLE", EXEC_OFF));
    };
    return opened;
  };
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, learning: { seed: seed.sha, section: "" } };
  const run = async (id, script) => {
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
    const store = await openSqliteStore({ dataDir: data, role: "runner" });
    closing.push(() => store.close());
    const requests = [];
    const endOfRun = learningEndOfRun(launch, { store, data, env: {}, learningFolder });
    const spec = piAdapterSpec({ script, tools: {}, hooks: quiet }, { requests });
    const createLoop = (deps) => {
      const job = createAdapterLoop(async (claim, one) => ({ ...(await spec(claim, one)), agentId: "agent-1", input: launch.input.content }))({ ...deps, endOfRun });
      let mine = false;
      let release;
      const parked = new Promise((resolve) => (release = resolve));
      return {
        start: (claim) => (claim.runId === id ? ((mine = true), job.start(claim)) : parked),
        command: (row) => (mine ? job.command(row) : Promise.resolve({ refused: "not run here" })),
        stop: async (reason) => (mine ? job.stop(reason) : release({ state: "interrupted" })),
      };
    };
    const runner = startRunner({ store, createLoop, name: `runner-${id}`, ...TIMING });
    try {
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const row = await server.runs.get(id);
        if (row.state === "ended" && row.runner === null) break;
        if (Date.now() > deadline) throw new Error(`${id} did not end: ${JSON.stringify(row)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await runner.close();
    }
    return { kept: (await server.learning.proposal(id))?.proposal, requests };
  };
  return { server, exec, run };
}

test("a learning folder whose disk can't run its script pauses learning: no compile attempt is counted, nothing stops, the loop read says paused, and once exec works the next compile is the first and lands", async (t) => {
  const { server, exec, run } = await world(t);
  // Every answer a compile turn could ask for is in the script, so a turn that asked again would be seen in its requests.
  const script = [{ say: "42" }, { say: DRAFT }, { say: DRAFT }, { say: DRAFT }];

  for (const id of ["run-1", "run-2"]) {
    const { kept, requests } = await run(id, script);
    assert.equal(kept?.state, "dropped", `${id}: ${JSON.stringify(kept)}`);
    assert.equal(kept.reason, "paused", `${id} is paused, not a failed compile: ${JSON.stringify(kept)}`);
    assert.match(kept.detail, PAUSED, `${id} says why`);
    assert.equal(kept.compiled, undefined, `${id} keeps no compile: ${JSON.stringify(kept)}`);
    assert.equal(requests.length, 2, `${id}: its job and one compile ask; the turn is not asked again once its check can't run`);
    const records = await promotionsOf(server.settings, "agent-1");
    assert.deepEqual(records, [], `${id}: no compile attempt is counted`);
    assert.equal(compileStoppedOf(records), false, `${id}: nothing stops the agent's compiles`);
    assert.equal(newCompileAttempt(records), 1, `${id}: the next compile is still the agent's first`);
    const loop = await agentLoopOverStore(server, "agent-1");
    assert.match(loop.paused ?? "", PAUSED, `${id}: the loop read says learning is paused: ${JSON.stringify(loop)}`);
    assert.deepEqual(loop.compiles, [], `${id}: no failed compile is listed`);
  }
  assert.ok(exec.refused >= 2, "the disk refused the script's exec on each run");

  // Exec works now: the next run's compile is the agent's first, its draft checked and merged, with nothing reset.
  exec.off = false;
  const { kept } = await run("run-3", script);
  assert.equal(kept?.state, "merged", JSON.stringify(kept));
  assert.deepEqual(kept.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  assert.deepEqual(kept.compiled.attempts, [{ ok: true, errors: [] }], "passed on its first attempt");
  const records = await promotionsOf(server.settings, "agent-1");
  assert.equal(records.some(draftFailedOf), false, `no failed-draft record: ${JSON.stringify(records)}`);
  const loop = await agentLoopOverStore(server, "agent-1");
  assert.equal(loop.paused, null, "learning is no longer paused");
  assert.deepEqual(loop.compiles.map((one) => [one.run_id, one.workflow, one.attempts.length]), [["run-3", "answer", 1]]);
});
