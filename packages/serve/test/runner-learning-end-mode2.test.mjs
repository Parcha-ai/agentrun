// A Mode 2 learning run's end-of-run step (runner/learning-end.ts learningEndOfRun) reads and writes the agent's learning
// folder where Mode 2 keeps it, through the learningFolder its deps give (on the claim's disk), never the runner's local
// data directory: its compile turn is asked from that folder's main, its draft checked against the seed in that folder,
// and its merge lands there, though a decoy folder is at the local path with a learned workflow (which, read, would make
// the compile not due). The folder stands in for the disk as the real learning Workspace (learningWorkspace) on a
// directory of its own, every call to it recorded: the draft's check reads the seed from the snapshot when main is the
// seed (no read exec), else with one read-only exec of the learning script at the seed, at the folder's root.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { readmeOf } from "./learned-workflow-seed-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { seedOf } = await import("../dist/learning.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { SCRIPT_FILE, textsAt } = await import("../dist/learn/folder.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));

/** Workflow `name` (one model step answering the question as a number). */
const flow = (name) => ({
  v: 2, name,
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
});
const DESCRIPTION = "Answers a question as a number; use when asked";
const DRAFT = `\`\`\`\`workflow answer\n---\ndescription: ${DESCRIPTION}\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify(flow("answer"))}\n\`\`\`\``;
const CHECK = "Read the whole input once before the first call.";

/** A commit on the folder's main by a person, through its learning Workspace. */
async function land(data, change) {
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const made = await learningCommit(folder.workspace, { runId: `person-${Math.random().toString(36).slice(2)}`, reason: "A person's edit", files: [], ...change });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await folder.end();
  }
}

/** A Mode 2 learning run end to end through a real runner, its agent due to compile at every run: the disk's folder is
 *  the run's seed, and the local path holds a decoy (a learned workflow, another commit). `moveOn`: main moves past the
 *  seed before the run ends, with a correction landed. The compile turn answers DRAFT. */
async function mode2End(t, { moveOn }) {
  const local = scratch("agentrun-learning-local-");
  const disk = scratch("agentrun-learning-disk-");
  const server = await openSqliteStore({ dataDir: local, role: "server" });
  const stores = [];
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    for (const dir of [local, disk]) rmSync(dir, { recursive: true, force: true });
  });
  const seed = await seedOf(disk, "agent-1");
  await land(local, { files: [{ path: "workflows/decoy/workflow.json", text: JSON.stringify(flow("decoy")) }, { path: "workflows/decoy/README.md", text: readmeOf("decoy", "A decoy; use never") }] });
  const decoy = await seedOf(local, "agent-1");
  assert.notEqual(decoy.sha, seed.sha, "the decoy is another commit");
  assert.equal(decoy.workflows.length, 1, "with a learned workflow");
  if (moveOn) await land(disk, { correction: CHECK });

  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  const launch = { input: { content: "What is six times seven?" }, title: "t", place: { mode: "runner" }, learning: { seed: seed.sha, section: "" } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });

  const store = await openSqliteStore({ dataDir: local, role: "runner" });
  stores.push(store);
  // The run's learning folder: the real learningWorkspace over the disk's directory (so it is the real Workspace's shape,
  // whole), its reads and execs recorded and then run.
  const opened = [];
  const calls = [];
  let ended = 0;
  const learningFolder = (agentId) => {
    opened.push(agentId);
    const folder = learningWorkspace({ mode: "local", data: disk, agentId });
    const { read, exec } = folder.workspace;
    folder.workspace.read = (path, ...rest) => (calls.push({ read: path }), read(path, ...rest));
    folder.workspace.exec = (argv, options) => (calls.push({ exec: [...argv], cwd: options?.cwd }), exec(argv, options));
    const end = folder.end;
    return { workspace: folder.workspace, end: async () => { ended++; await end(); } };
  };
  const endOfRun = learningEndOfRun(launch, { store, data: local, env: {}, learningFolder });
  const spec = piAdapterSpec({ script: [{ say: "42" }, { say: DRAFT }], tools: {}, hooks: quiet });
  const createLoop = (deps) => {
    const job = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", input: launch.input.content, ...(endOfRun ? { endOfRun } : {}) }))(deps);
    let mine = false;
    let release;
    const parked = new Promise((resolve) => (release = resolve));
    return {
      start: (claim) => (claim.runId === "run-1" ? ((mine = true), job.start(claim)) : parked),
      command: (row) => (mine ? job.command(row) : Promise.resolve({ refused: "not run here" })),
      stop: async (reason) => (mine ? job.stop(reason) : release({ state: "interrupted" })),
    };
  };
  runners.push(startRunner({ store, createLoop, name: "runner-a", ...TIMING }));
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`run-1 did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { kept: await server.learning.proposal("run-1"), seed, decoy, local, disk, opened, calls, ended };
}

/** What every case asserts: the compile turn was asked from the disk's folder (the decoy's workflow would make it not
 *  due) and merged there, every folder opened was ended, every read is a path from the folder's root, and the local
 *  folder is the decoy still. */
async function mergedOnDisk(end) {
  assert.equal(end.kept?.proposal?.state, "merged", JSON.stringify(end.kept?.proposal));
  assert.deepEqual(end.kept.proposal.workflows, [{ file: "workflows/answer/workflow.json", name: "answer" }]);
  const main = await seedOf(end.disk, "agent-1");
  assert.equal(end.kept.proposal.merged, main.sha, "the run's merge is the disk's main");
  const folder = learningWorkspace({ mode: "local", data: end.disk, agentId: "agent-1" });
  let texts;
  try { texts = await textsAt(folder.workspace, main.sha, ["workflows/answer/workflow.json"]); } finally { await folder.end(); }
  assert.deepEqual(JSON.parse(texts["workflows/answer/workflow.json"]), flow("answer"), "the disk's main holds the compiled workflow");
  assert.ok(end.opened.length > 0 && end.opened.every((agentId) => agentId === "agent-1"), `the run's learning folder was opened: ${JSON.stringify(end.opened)}`);
  assert.equal(end.ended, end.opened.length, "and every opening ended");
  for (const { read } of end.calls.filter((call) => "read" in call)) assert.ok(!read.startsWith("/") && !read.split("/").includes(".."), `a path from the folder's root: ${read}`);
  assert.equal((await seedOf(end.local, "agent-1")).sha, end.decoy.sha, "the local folder is untouched");
}

/** The read-only execs of the learning script (`sh SCRIPT_FILE read <commit>`) through the folder. */
const readExecs = (end) => end.calls.filter((call) => "exec" in call && call.exec[2] === "read");

test("a Mode 2 learning end checks its proposal against the learning folder on the run's Workspace, never the local data directory", async (t) => {
  const end = await mode2End(t, { moveOn: false });
  await mergedOnDisk(end);
  assert.equal(end.kept.proposal.merged !== end.seed.sha, true, "a new commit on the seed");
  assert.deepEqual(readExecs(end), [], "main is the seed: the check reads its snapshot, no read exec");
});

test("a Mode 2 learning end whose folder's main moved past the seed reads the seed with one exec of the learning script at the folder's root", async (t) => {
  const end = await mode2End(t, { moveOn: true });
  await mergedOnDisk(end);
  assert.deepEqual(readExecs(end), [{ exec: ["sh", SCRIPT_FILE, "read", end.seed.sha], cwd: undefined }], "one read-only exec of the learning script at the seed, at the folder's root");
  const folder = learningWorkspace({ mode: "local", data: end.disk, agentId: "agent-1" });
  let texts;
  try { texts = await textsAt(folder.workspace, end.kept.proposal.merged, ["corrections.md"]); } finally { await folder.end(); }
  assert.match(texts["corrections.md"] ?? "", /Read the whole input once/, "the moved main's correction is kept under the merge");
});
