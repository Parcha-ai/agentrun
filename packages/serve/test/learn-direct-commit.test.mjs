// The end of a learning run, through a real runner (runner/learning-end.ts learningEndOfRun), with no look-back turn,
// no learning run and no grader:
//   - a compile draft that passes its checks (the workflow checks, the DSL dry run, the secret and hidden-character
//     refusals) reaches the learning folder's main directly, committed by the run (its Run-Id), and no learning run is
//     queued; its compiled record is on its run's learning;
//   - a draft holding a value the host keeps secret, or a character a reader does not see, is refused on every attempt:
//     nothing reaches main, and the compile's failure is on its promotion record;
//   - the owner's feedback (a message after the answer) appends one line to corrections.md on main, with no model turn;
//     a line holding a value the host keeps secret is refused, and one that would take the file past its cap is refused
//     with the cap's words.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { git, repoOf } from "./learn-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { sendCommand } = await import("../dist/runner/commands.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);

/** A value the run was handed (its claim's keys): never learned, in no shape a scanner would call a secret. */
const HANDED = "plain-handed-value-for-tests";
/** A character a reader does not see, built here so no fixture holds it raw. */
const HIDDEN = String.fromCodePoint(0x200b);

/** A compile answer whose draft the checks and the dry run pass; `description`, its README's line. */
const compiledBlock = (description = "Answers a question as a number; use when asked") => `\`\`\`\`workflow answer\n---\ndescription: ${description}\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
})}\n\`\`\`\``;

/** A store in a directory of its own, agent-1 of `body` and run-1 launched from its learning folder's main now. */
async function world(t, body) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-direct-commit-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [];
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body });
  const launchOf = async () => ({ input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, learning: { seed: (await seedOf(dir, "agent-1")).sha, section: "" } });
  let launch;
  const create = async () => {
    launch = await launchOf();
    await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  };
  const logs = [];
  const requests = [];
  /** Starts the runner on run-1, its model following `script`; `feedback`, a person's message taken after the job's
   *  first. Any other run it claims is held, never run here. */
  const start = async ({ script, feedback } = {}) => {
    await create();
    if (feedback !== undefined) await sendCommand(server, "run-1", { kind: "steer", body: { text: feedback } });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const spec = piAdapterSpec({ script, tools: {}, hooks: quiet }, { requests });
    const endOfRun = learningEndOfRun(launch, { store, data: dir, env: {}, handed: [HANDED], log: (line) => logs.push(line), learningFolder: (agentId) => learningFolderOf(dir, agentId) });
    const createLoop = (deps) => {
      const job = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1" }))({ ...deps, ...(endOfRun ? { endOfRun } : {}) });
      let mine = false;
      let release;
      const held = new Promise((resolve) => (release = resolve));
      return {
        start: (claim) => (claim.runId === "run-1" ? ((mine = true), job.start(claim)) : held),
        command: (row) => (mine ? job.command(row) : Promise.resolve({ refused: "not run here" })),
        stop: async (reason) => (mine ? job.stop(reason) : release({ state: "interrupted" })),
      };
    };
    runners.push(startRunner({ store, createLoop, name: "runner-a", ...TIMING }));
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const row = await server.runs.get("run-1");
      if (row.state === "ended" && row.runner === null) return row;
      if (Date.now() > deadline) throw new Error(`run-1 did not end within ${WAIT_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const repo = () => repoOf(dir, "agent-1");
  const onMain = (path) => {
    try {
      return git(repo(), ["show", `main:${path}`]);
    } catch {
      return undefined;
    }
  };
  return { dir, server, start, logs, requests, repo, onMain };
}

test("a compile draft that passes its checks reaches main directly: committed by its run, no learning run, no grade", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } });
  await w.start({ script: [{ say: "The job's answer." }, { say: compiledBlock() }] });
  const text = w.onMain("workflows/answer/workflow.json");
  assert.ok(text, "the draft is on main");
  assert.match(w.onMain("workflows/answer/README.md") ?? "", /description: Answers a question as a number/);
  assert.match(git(w.repo(), ["log", "-1", "--format=%B", "main"]), /Run-Id: run-1/, "committed by the run");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.equal(kept.learningRunId, undefined, "no learning run queued");
  assert.equal(await w.server.runs.get("run-1-learning"), undefined, "no learning run exists");
  assert.equal(kept.proposal.compiled?.workflow, "answer");
  assert.deepEqual(kept.proposal.compiled.attempts.map(({ ok }) => ok), [true]);
  assert.equal(kept.proposal.verdict, undefined, "no grade");
});

test("a draft holding a value the host keeps secret, or a hidden character, is refused on every attempt: nothing reaches main, the failure is recorded", async (t) => {
  for (const description of [`Answers as ${HANDED} says; use when asked`, `Answers a question${HIDDEN} as a number; use when asked`]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } });
    const bad = compiledBlock(description);
    await w.start({ script: [{ say: "The job's answer." }, { say: bad }, { say: bad }, { say: bad }, { say: bad }] });
    assert.equal(w.onMain("workflows/answer/workflow.json"), undefined, "nothing reached main");
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.state, "dropped", JSON.stringify(kept?.proposal));
    assert.ok(!JSON.stringify(kept).includes(HANDED), "the value is kept nowhere");
    assert.match((kept.proposal.draft_errors ?? []).join("; "), /secret|a character a reader does not see/, JSON.stringify(kept.proposal));
    const records = await promotionsOf(w.server.settings, "agent-1");
    assert.deepEqual(records.map(({ decided, check }) => [decided, check?.attempt, check?.n]), [["hold", 1, 0]], JSON.stringify(records));
    assert.ok(!JSON.stringify(records).includes(HANDED), "nor on the record");
  }
});

test("the owner's feedback appends one line to corrections.md on main, with no model turn", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true });
  await w.start({ feedback: "Answer  in\ttables from now on.", script: [{ say: "The job's answer." }, { say: "Noted." }] });
  // git() gives its output trimmed: the file is this one line.
  assert.equal(w.onMain("corrections.md"), "- Answer in tables from now on.");
  assert.match(git(w.repo(), ["log", "-1", "--format=%B", "main"]), /Run-Id: run-1/);
  assert.equal(w.requests.length, 2, "the job's two answers, no learning turn");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.equal(kept.learningRunId, undefined);
});

test("feedback holding a value the host keeps secret is refused: corrections.md is not written, the value kept nowhere", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true });
  await w.start({ feedback: `Use ${HANDED} next time.`, script: [{ say: "The job's answer." }, { say: "Noted." }] });
  assert.equal(w.onMain("corrections.md"), undefined);
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "dropped", JSON.stringify(kept?.proposal));
  assert.ok(!JSON.stringify(kept).includes(HANDED));
  assert.ok(!w.logs.join("\n").includes(HANDED));
});

test("feedback that would take corrections.md past its cap is refused with the cap's words; the file stays as it was", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true });
  await seedOf(w.dir, "agent-1");
  const full = `${Array.from({ length: 44 }, (_, i) => `- Rule ${String(i).padStart(2, "0")}: keep every answer short and plain.`).join("\n")}\n`;
  const folder = learningFolderOf(w.dir, "agent-1");
  try {
    const done = await learningCommit(folder.workspace, { kind: "merge", runId: "run-0", reason: "corrections", files: [{ path: "corrections.md", text: full }] });
    assert.equal(done.ok, true, JSON.stringify(done));
  } finally {
    await folder.end();
  }
  assert.ok(Buffer.byteLength(full) < 2048 && Buffer.byteLength(full) > 2000, `setup: ${Buffer.byteLength(full)} bytes`);
  await w.start({ feedback: "One more rule that does not fit.", script: [{ say: "The job's answer." }, { say: "Noted." }] });
  assert.equal(w.onMain("corrections.md"), full.trimEnd(), "unchanged (git() trims its output)");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "dropped", JSON.stringify(kept?.proposal));
  assert.match(kept.proposal.detail, /corrections\.md .*2048 bytes/, kept.proposal.detail);
});
