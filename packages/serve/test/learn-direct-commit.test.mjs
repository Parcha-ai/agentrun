// The end of a learning run, through a real runner (runner/learning-end.ts learningEndOfRun), with no look-back turn,
// no learning run and no grader:
//   - a compile draft that passes its checks (the workflow checks, the DSL dry run, the secret and hidden-character
//     refusals) reaches the agent's learning directly, saved by the run, and no learning run is
//     queued; its compiled record is on its run's learning;
//   - a draft holding a value the host keeps secret, or a character a reader does not see, is refused on every attempt:
//     nothing is saved, and the compile's failure is on its promotion record;
//   - the owner's feedback (a message after the answer) appends one line to corrections.md, with no model turn;
//     a line holding a value the host keeps secret is refused, and one that would take the file past its cap drops the
//     file's oldest lines to fit (the newest correction wins), the run's learning saying how many; a file another write
//     filled during the compile turn does the same, beside the passing draft.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { learningAt, mergesOf } from "./learn-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { promotionsOf } = await import("../dist/learn/promote.js");
const { seedOf } = await import("../dist/learning.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { learningOf } = await import("../dist/learn/rows.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { said } = await import("../dist/learning-words.js");

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

/** A store in a directory of its own, agent-1 of `body` and run-1 launched from its learning's newest save now. */
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
  const launchOf = async () => ({ input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, learning: { seed: (await seedOf(dir, server, "agent-1")).sha, section: "" } });
  let launch;
  const create = async () => {
    launch = await launchOf();
    await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  };
  const logs = [];
  const requests = [];
  /** Starts the runner on run-1, its model following `script`; `feedback`, a person's message taken after the job's
   *  first; `beforeAnswer`, called with each request's body before the model answers it. Any other run it claims is
   *  held, never run here. */
  const start = async ({ script, feedback, beforeAnswer } = {}) => {
    await create();
    if (feedback !== undefined) await sendCommand(server, "run-1", { kind: "steer", body: { text: feedback } });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const origin = scriptedOrigin(script, requests);
    const fetch = beforeAnswer ? async (url, init = {}) => (await beforeAnswer(JSON.parse(String(init.body ?? "{}"))), origin(url, init)) : origin;
    const spec = piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch });
    const endOfRun = learningEndOfRun(launch, { store, data: dir, env: {}, handed: [HANDED], log: (line) => logs.push(line) });
    const createLoop = (deps) => {
      const job = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", ...(endOfRun ? { endOfRun } : {}) }))(deps);
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
  /** `path`'s text at agent-1's newest save; undefined when it holds none. */
  const onMain = async (path) => (await learningAt(server, "agent-1")).text(path);
  /** Whether the newest save is run-1's merge. */
  const byRun = async () => {
    const { main } = (await learningAt(server, "agent-1")).view;
    return (await mergesOf(server, "agent-1", "run-1")).some((save) => save.id === main);
  };
  return { dir, server, start, logs, requests, onMain, byRun };
}

test("a compile draft that passes its checks is saved directly: by its run, no learning run, no grade", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } });
  await w.start({ script: [{ say: "The job's answer." }, { say: compiledBlock() }] });
  const text = await w.onMain("workflows/answer/workflow.json");
  assert.ok(text, "the draft is saved");
  assert.match((await w.onMain("workflows/answer/README.md")) ?? "", /description: Answers a question as a number/);
  assert.ok(await w.byRun(), "saved by the run");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.equal(kept.learningRunId, undefined, "no learning run queued");
  assert.equal(await w.server.runs.get("run-1-learning"), undefined, "no learning run exists");
  assert.equal(kept.proposal.compiled?.workflow, "answer");
  assert.deepEqual(kept.proposal.compiled.attempts.map(({ ok }) => ok), [true]);
  assert.equal(kept.proposal.verdict, undefined, "no grade");
});

test("a draft holding a value the host keeps secret, or a hidden character, is refused on every attempt: nothing is saved, the failure is recorded", async (t) => {
  for (const description of [`Answers as ${HANDED} says; use when asked`, `Answers a question${HIDDEN} as a number; use when asked`]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } });
    const bad = compiledBlock(description);
    await w.start({ script: [{ say: "The job's answer." }, { say: bad }, { say: bad }, { say: bad }, { say: bad }] });
    assert.equal(await w.onMain("workflows/answer/workflow.json"), undefined, "nothing saved");
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.state, "dropped", JSON.stringify(kept?.proposal));
    assert.ok(!JSON.stringify(kept).includes(HANDED), "the value is kept nowhere");
    assert.match((kept.proposal.draft_errors ?? []).join("; "), /secret|a character a reader does not see/, JSON.stringify(kept.proposal));
    const records = await promotionsOf(w.server.learning, "agent-1");
    assert.deepEqual(records.map(({ decided, check }) => [decided, check?.attempt, check?.n]), [["hold", 1, 0]], JSON.stringify(records));
    assert.ok(!JSON.stringify(records).includes(HANDED), "nor on the record");
  }
});

test("the owner's feedback appends one line to corrections.md, with no model turn", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true });
  await w.start({ feedback: "Answer  in\ttables from now on.", script: [{ say: "The job's answer." }, { say: "Noted." }] });
  assert.equal(await w.onMain("corrections.md"), "- Answer in tables from now on.\n");
  assert.ok(await w.byRun(), "saved by the run");
  assert.equal(w.requests.length, 2, "the job's two answers, no learning turn");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.equal(kept.learningRunId, undefined);
});

test("feedback holding a value the host keeps secret is refused: corrections.md is not written, the value kept nowhere", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true });
  await w.start({ feedback: `Use ${HANDED} next time.`, script: [{ say: "The job's answer." }, { say: "Noted." }] });
  assert.equal(await w.onMain("corrections.md"), undefined);
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "dropped", JSON.stringify(kept?.proposal));
  assert.ok(!JSON.stringify(kept).includes(HANDED));
  assert.ok(!w.logs.join("\n").includes(HANDED));
});

/** corrections.md a few bytes under its 8192-byte cap: 174 rules of 47 bytes. */
const FULL = `${Array.from({ length: 174 }, (_, i) => `- Rule ${String(i).padStart(3, "0")}: keep every answer short and plain.`).join("\n")}\n`;
/** FULL with its oldest line dropped and `line` appended: a run's correction kept at the cap (the newest wins). */
const NEWEST = (line) => `${FULL.split("\n").slice(1).join("\n")}${line}`;

/** corrections.md on agent-1's learning replaced with FULL by another run (run-0), as an owner's edit or another run's
 *  correction would fill it. */
async function fillCorrections(store) {
  assert.ok(Buffer.byteLength(FULL) < 8192 && Buffer.byteLength(FULL) > 8150, `setup: ${Buffer.byteLength(FULL)} bytes`);
  await mergeOn(store, { runId: "run-0", reason: "corrections", files: [{ path: "corrections.md", text: FULL }] });
}

/** `change` merged on agent-1's learning, as a run's merge (learningCommit); its result. */
async function mergeOn(store, change) {
  const done = await learningCommit(learningOf(store, "agent-1"), change);
  assert.equal(done.ok, true, JSON.stringify(done));
  return done;
}

test("a run whose correction-only merge landed before a crash (its end never saved) records that merge at its recovered end, even with room left for one copy only: never a second copy, no line dropped", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true });
  await seedOf(w.dir, w.server, "agent-1");
  // 173 rules: room for the correction's line once, never twice (a second copy would drop the oldest rule).
  const rules = `${FULL.split("\n").slice(0, 173).join("\n")}\n`;
  const TEXT = "Name the page each figure came from.";
  const line = `- ${TEXT}`;
  assert.ok(Buffer.byteLength(rules) + Buffer.byteLength(line) <= 8192 && Buffer.byteLength(rules) + 2 * Buffer.byteLength(line) + 1 > 8192, "setup: one copy fits, two do not");
  await mergeOn(w.server, { runId: "run-0", reason: "corrections", files: [{ path: "corrections.md", text: rules }] });
  // The earlier claim's merge: run-1's correction saved, then the claim stopped before the run's end was saved.
  const saved = await mergeOn(w.server, { runId: "run-1", round: 1, reason: "Its owner's correction.", files: [], correction: TEXT });
  await w.start({ feedback: TEXT, script: [{ say: "The job's answer." }, { say: "Noted." }] });
  assert.equal(await w.onMain("corrections.md"), `${rules}${line}\n`, "the line once");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.equal(kept.proposal.merged, saved.commit, "the merge the earlier claim made");
  assert.equal(kept.proposal.corrections, 1);
  assert.equal(kept.proposal.problems, undefined, JSON.stringify(kept.proposal));
  assert.equal(kept.proposal.dropped_lines, undefined, "no line dropped");
});

test("feedback that would take corrections.md past its cap is kept: the file's oldest line is dropped to fit, and the run's learning says so", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true });
  await seedOf(w.dir, w.server, "agent-1");
  await fillCorrections(w.server);
  await w.start({ feedback: "One more rule, the newest.", script: [{ say: "The job's answer." }, { say: "Noted." }] });
  assert.equal(await w.onMain("corrections.md"), NEWEST("- One more rule, the newest.\n"), "the oldest rule out, the newest in");
  assert.ok(Buffer.byteLength(await w.onMain("corrections.md")) <= 8192, "within the cap");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual([kept.proposal.corrections, kept.proposal.dropped_lines, kept.proposal.problems], [1, 1, undefined], JSON.stringify(kept.proposal));
  assert.equal(kept.proposal.detail, "Kept your correction. Dropped the oldest line of corrections.md to make room.");
});

test("corrections.md filled during the compile turn: the correction is kept beside the passing draft, the file's oldest line dropped to fit", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } });
  await seedOf(w.dir, w.server, "agent-1");
  // The correction fits when it is checked, before the compile turn; another write fills the file while the turn runs.
  let filled = false;
  const beforeAnswer = async (body) => {
    if (filled || !JSON.stringify(body.messages?.at(-1) ?? "").includes("One more turn: write this agent")) return;
    filled = true;
    await fillCorrections(w.server);
  };
  await w.start({ feedback: "One more rule, the newest.", script: [{ say: "The job's answer." }, { say: "Noted." }, { say: compiledBlock() }], beforeAnswer });
  assert.ok(filled, "the compile turn was asked");
  assert.ok(await w.onMain("workflows/answer/workflow.json"), "the passing draft is saved");
  assert.equal(await w.onMain("corrections.md"), NEWEST("- One more rule, the newest.\n"), "the other write's oldest rule out, the newest in");
  assert.ok(await w.byRun(), "saved by the run");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual([kept.proposal.corrections, kept.proposal.dropped_lines, kept.proposal.problems], [1, 1, undefined], JSON.stringify(kept.proposal));
  assert.equal(kept.proposal.detail, said.merged([{ name: "answer" }], 1, [], 1));
});
