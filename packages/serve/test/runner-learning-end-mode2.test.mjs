// A Mode 2 learning run's end-of-run step (runner/learning-end.ts learningEndOfRun) reads the agent's learning folder
// where Mode 2 keeps it, through the learningFolder its deps give (on the claim's disk), never the runner's local data
// directory: its proposal is checked against the seed in that folder, and nothing reads the local learning path, though
// a decoy folder is there with other content. The folder stands in for the disk as the real learning Workspace
// (learningWorkspace) on a directory of its own, every call to it recorded: the seed is read as the reflect hook's check
// reads it (learn/seed-check.ts), from the snapshot when main is the seed (no exec), else with one read-only exec of the
// learning script at the seed, at the folder's root.
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
const { SCRIPT_FILE, SNAPSHOT_FILE } = await import("../dist/learn/folder.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);
const note = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\ntype: reference\n---\n${body}\n`;
const RETRY = note("Retry slowly", "Back off between retries", "Wait a little longer after each failed call.");
const RETRY_DECOY = note("Retry slowly", "Retry at once", "Call again straight away after a failure.");
const CHECK = note("Check first", "Read the input before acting", "Read the whole input once before the first call.");
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));

/** A note created on the folder's main by a person, through its learning Workspace. */
async function landNote(data, agentId, file, text) {
  const folder = learningWorkspace({ mode: "local", data, agentId });
  try {
    const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await folder.end();
  }
}

/** A Mode 2 learning run end to end through a real runner: the disk's folder holds retry-slowly.md at the run's seed,
 *  and the decoy at the local path another retry-slowly.md (another commit, other content). `moveOn`: main moves past
 *  the seed before the run ends, with check-first.md landed. The run's answer gives the disk's retry-slowly.md with its
 *  very text, and check-first.md. */
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
  await landNote(disk, "agent-1", "retry-slowly.md", RETRY);
  await landNote(local, "agent-1", "retry-slowly.md", RETRY_DECOY);
  const seed = await seedOf(disk, "agent-1");
  const decoy = await seedOf(local, "agent-1");
  const held = seed.notes["retry-slowly.md"];
  assert.ok(held?.includes("Wait a little longer"), "the disk's main holds its note");
  assert.notEqual(decoy.sha, seed.sha, "the decoy is another commit");
  assert.notEqual(decoy.notes["retry-slowly.md"], held, "with other content");
  if (moveOn) await landNote(disk, "agent-1", "check-first.md", CHECK);

  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const launch = { input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: seed.sha, section: "", seedNotes: 1 } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  const reflected = `\`\`\`note retry-slowly.md\n${held}\`\`\`\n\n\`\`\`note check-first.md\n${CHECK}\`\`\`\n\nReflected.`;

  // Every git call learning.ts makes itself, on this machine, from here on.

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
  const spec = piAdapterSpec({ script: [{ say: "The job's answer." }, { say: reflected }], tools: {}, hooks: quiet });
  const createLoop = (deps) => {
    const job = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1" }))({ ...deps, endOfRun });
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
  return { kept: await server.learning.proposal("run-1"), seed, opened, calls, ended };
}

/** What every case asserts: the proposal is the disk's seed's (its retry-slowly.md, given again with its very text, is no
 *  change), the folder was opened once and ended, and nothing read the local learning path. */
function checkedOnDisk(end) {
  assert.equal(end.kept?.proposal?.state, "proposed", JSON.stringify(end.kept?.proposal));
  assert.deepEqual(end.kept.proposal.proposal?.notes, [{ file: "check-first.md", text: CHECK }], "checked against the disk's seed: the note it holds is no change");
  assert.deepEqual(end.opened, ["agent-1"], "the run's learning folder was opened for the check");
  assert.equal(end.ended, 1, "and ended after it");
  // Every read through the folder's Workspace is a path from its root.
  for (const { read } of end.calls.filter((call) => "read" in call)) assert.ok(!read.startsWith("/") && !read.split("/").includes(".."), `a path from the folder's root: ${read}`);
  // Nothing under the local learning path was read: no learning code in this process runs git, and a read of the decoy
  // would show up as the wrong content: its main is another commit, and its retry-slowly.md another text, so the
  // proposal above would hold that note too, or the check would fail.
}

test("a Mode 2 learning end checks its proposal against the learning folder on the run's Workspace, never the local data directory", async (t) => {
  const end = await mode2End(t, { moveOn: false });
  checkedOnDisk(end);
  // Main is the seed: the snapshot and the held note's body, read through the folder's Workspace, and no exec.
  const reads = end.calls.filter((call) => "read" in call).map(({ read }) => read);
  assert.ok(reads.includes(SNAPSHOT_FILE) && reads.includes("retry-slowly.md"), `the snapshot and the note's body read through the folder: ${reads.join(", ")}`);
  assert.deepEqual(end.calls.filter((call) => "exec" in call), [], "main is the seed: no exec");
});

test("a Mode 2 learning end whose folder's main moved past the seed reads the seed with one exec of the learning script at the folder's root", async (t) => {
  const end = await mode2End(t, { moveOn: true });
  // check-first.md is on main now, not at the seed: read at main, the answer's check-first.md would be no change either.
  checkedOnDisk(end);
  const execs = end.calls.filter((call) => "exec" in call);
  assert.deepEqual(execs, [{ exec: ["sh", SCRIPT_FILE, "read", end.seed.sha], cwd: undefined }], "one read-only exec of the learning script at the seed, at the folder's root");
});
