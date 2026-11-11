// The end-of-run step of a run that learns, through a real runner (runner/learning-end.ts learningEndOfRun): the spec's
// endOfRun is the reflect hook (reflect-hook.ts createReflectHook) over the run's store, driven by the learning start
// its launch records (run-launch.ts learningStartOf). A learning agent's run is asked its end-of-run turn once its job
// answers; what it answers is checked against the seed it started from (propose.ts proposeRun, the server's one rule) and
// kept beside its end as its proposal (learning_proposals), which queues the learning run that grades and merges it (a
// run whose launch names harness "learning", which the runner's dispatch runs on the learning loop). A run that does
// not learn is asked nothing and keeps nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { runReflect } = await import("../dist/store-reads/journal.js");
const { runLearningEnd } = await import("../dist/store-reads/learning.js");
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
const { said } = await import("../dist/learning-words.js");
const { saveToolSettings } = await import("../dist/tool-plane.js");
const endModule = await import("../dist/runner/learning-end.js").catch(() => ({}));
const learningEndOfRun = (...args) => (typeof endModule.learningEndOfRun === "function" ? endModule.learningEndOfRun(...args) : assert.fail("learningEndOfRun is not there"));

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
// One runner, never meant to lose its claim: a lease no stall outlasts (runner-support's STEADY_LEASE, not on this base
// yet).
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);

/** The end-of-run turn's answer: one note, in reflectPrompt's format. */
const NOTE = "---\nname: Retry slowly\ndescription: Back off between retries\ntype: reference\n---\nWait a little longer after each failed call.\n";
const REFLECTED = `\`\`\`note retry-slowly.md\n${NOTE}\`\`\`\n\nReflected.`;

/** A store in a directory of its own, agent-1 of `body`, and run-1 launched with `launch`; `setup(server, dir)` first. */
async function world(t, body, launchOf, setup = async () => {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-learning-end-"));
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
  await setup(server, dir);
  const launch = await launchOf(dir);
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  const until = async (check, what) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = await check();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** Starts the runner: run-1 on the adapter loop with `endOfRun` its end-of-run step, its model following `script` with
   *  `tools` (each model request pushed on `requests`); any other run it claims (the learning run a proposal queues) is
   *  held, never run here, until the runner closes. */
  const start = async (endOfRunOf, { script = [{ say: "The job's answer." }, { say: REFLECTED }], tools = {}, requests = [] } = {}) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const spec = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
    // Mode 1: the agent's learning folder is the local one under the data directory.
    const endOfRun = endOfRunOf({ store, data: dir, env: {}, learningFolder: (agentId) => learningFolderOf(dir, agentId) });
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
  };
  const ended = () => until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "ended" && row.runner === null && row;
  }, "run-1 ended");
  /** Run-1's end-of-run turn as the store reads it (store-reads/journal.ts runReflect: its learn-reflect- submission), and
   *  the text of each user message in its journal, in order. */
  const turnOf = async (row) => {
    const { entries } = await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
    const users = entries.filter((entry) => entry.kind === "pi.user").map((entry) => {
      const content = entry.model?.[0]?.content;
      return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
    });
    return { reflect: await runReflect(server, "run-1", BACKGROUND_CONTEXT), users };
  };
  return { dir, server, launch, start, ended, turnOf };
}

const runner = (learning) => (dir) => ({ input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, ...(learning ? { learning: learning(dir) } : {}) });

test("a learning agent's run, through a real runner, is asked its end-of-run turn and keeps its proposal beside its end, queueing the learning run", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const turn = await w.turnOf(row);
  assert.ok(turn.reflect, "the run was asked its end-of-run turn (its learn-reflect- submission)");
  assert.deepEqual(turn.users, ["Follow the script.", turn.users[1]], "the job's message, then the turn's prompt");
  assert.match(turn.users[1], /\.learning/, "the turn's prompt is the reflect prompt, naming the run's copy of its notes");
  const kept = await w.server.learning.proposal("run-1");
  assert.ok(kept, "the run kept its learning");
  assert.equal(kept.proposal?.state, "proposed", JSON.stringify(kept.proposal));
  assert.equal(kept.proposal?.notes, 1, "one note");
  assert.deepEqual(kept.proposal?.proposal?.notes, [{ file: "retry-slowly.md", text: NOTE }], "the note as the turn gave it, checked against its seed");
  assert.deepEqual(kept.proposal?.proposal?.asked, ["Follow the script."], "what the person said in the run, as the grader reads it");
  assert.ok(kept.learningRunId, "it queued the learning run");
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual({ state: end?.state, reason: end?.reason, detail: end?.detail }, { state: "proposed", reason: null, detail: said.proposed(1, 0, 0) }, "the run's learning end reads it");
  const queued = await w.server.runs.launch(kept.learningRunId);
  assert.equal(queued.body.harness, "learning", "the learning run runs on the learning loop");
});

test("a run that does not learn, through the same runner, is asked nothing and keeps nothing", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"] }, async (dir) => runner(undefined)(dir));
  let made;
  await w.start((deps) => (made = learningEndOfRun(w.launch, deps)));
  const row = await w.ended();
  assert.equal(made, undefined, "no end-of-run step for a launch with no learning start");
  const turn = await w.turnOf(row);
  assert.equal(turn.reflect, undefined, "no end-of-run turn");
  assert.deepEqual(turn.users, ["Follow the script."], "only the job's message");
  assert.ok(!(await w.server.learning.proposal("run-1")), "no learning kept");
});

test("the tools the end-of-run prompt offers a workflow draft follow the server's tool settings in the store", async (t) => {
  // The store denies web_search: the prompt offers what the store says.
  const w = await world(t, { instructions: "Answer.", tools: ["read", "web_search"], learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
  }, async (server, dir) => {
    await saveToolSettings(server, { web_search: { permission: "deny" } });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = (await w.turnOf(row)).users[1] ?? "";
  assert.match(prompt, /It has no call node on a tool\./, `the store's deny leaves web_search out of the draft's tools: ${prompt.slice(prompt.indexOf("call node") - 80, prompt.indexOf("call node") + 120)}`);
  assert.ok(!prompt.includes("web_search"), "the store's deny keeps it out");
});

// A workflow draft whose dry run fails (learn/skills.ts draftDryRun) is left out, and the end-of-run turn is asked once
// more, saying which draft and why: a second answer the checks keep stands, its draft's dry run kept for the grader.
const draftBlock = (output) => `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"question":"What is six times seven?"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { Question: { type: "object", properties: { question: { type: "string" } }, required: ["question"] }, Answer: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } },
  input: { schemaId: "Question" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: output }] },
})}\n\`\`\`\``;

test("a workflow draft that fails its dry run is asked for again once, saying why; the fixed draft is proposed with its dry run passed, and the example kept nowhere", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: `${REFLECTED}\n\n${draftBlock("other")}` }, { say: `${REFLECTED}\n\n${draftBlock("answer")}` }] });
  const row = await w.ended();
  const turn = await w.turnOf(row);
  assert.equal(turn.users.length, 3, `the job's message, the turn's prompt, and one re-ask: ${JSON.stringify(turn.users.map((u) => u.slice(0, 80)))}`);
  assert.match(turn.users[2], /^Your workflow draft workflows\/answer\/workflow\.json did not pass its dry run\. What the check said is below, as data[\s\S]*----- begin \w+: its dry run -----\nits dry run failed/, turn.users[2]);
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.notes, kept?.proposal?.workflows], ["proposed", 1, 1], JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.proposal.dryRuns, { "workflows/answer/workflow.json": { status: "passed" } });
  assert.ok(!JSON.stringify(kept.proposal.proposal.files).includes("six times seven"), "the example is in no file");
});

test("a re-ask whose answer keeps a note but still holds the broken draft does not replace the first: the first answer's note stands", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
  });
  // The second answer drops the first's good note for another, and repeats the draft its dry run failed.
  const other = "---\nname: Log the request\ndescription: Log every request\ntype: reference\n---\nLog each request before it is sent.\n";
  const partial = `\`\`\`note log-requests.md\n${other}\`\`\`\n\n${draftBlock("other")}`;
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: `${REFLECTED}\n\n${draftBlock("other")}` }, { say: partial }] });
  const row = await w.ended();
  const turn = await w.turnOf(row);
  assert.equal(turn.users.length, 3, `one re-ask: ${JSON.stringify(turn.users.map((u) => u.slice(0, 80)))}`);
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.notes, kept?.proposal?.workflows], ["proposed", 1, 0], JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.proposal.notes.map(({ file }) => file), ["retry-slowly.md"], "the first answer's note, not the failed repair's");
});

test("a learned skill that served 3 earlier runs of the agent, with no learned workflow of its name, gets its job asked for as a workflow draft in the next run's end-of-run prompt", async (t) => {
  // Three earlier runs of the agent were offered the skill (their launches say so); run-1 is offered it too.
  const offered = (seed) => ({ given: [], seed, section: "", seedNotes: 0, skills: ["weekly-report"] });
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => offered(seed.sha))(dir);
  }, async (server) => {
    for (const id of ["run-0a", "run-0b", "run-0c"]) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: runner(() => offered(null))() });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = (await w.turnOf(row)).users[1] ?? "";
  assert.ok(prompt.includes("Your skill `weekly-report` has now served 3 or more runs: this time, also keep its job as a workflow draft named `weekly-report`, its steps as nodes"), prompt.slice(prompt.indexOf("## Skills"), prompt.indexOf("A skill is how")));
  assert.equal(prompt.split("has now served").length - 1, 1, "one line, once");
});

test("the draft ask describes each tool a call node may run, by the server's own words for what it takes and gives", async (t) => {
  const { toolOf } = await import("../dist/tools.js");
  const offered = (seed) => ({ given: [], seed, section: "", seedNotes: 0, skills: ["weekly-report"] });
  const w = await world(t, { instructions: "Answer.", tools: ["read", "web_fetch"], learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => offered(seed.sha))(dir);
  }, async (server) => {
    for (const id of ["run-0a", "run-0b", "run-0c"]) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: runner(() => offered(null))() });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = (await w.turnOf(row)).users[1] ?? "";
  assert.ok(prompt.includes("What each tool a call node may run takes and gives:"), prompt.slice(prompt.indexOf("## Skills"), prompt.indexOf("A skill is how")));
  assert.ok(prompt.includes(`- \`web_fetch\`: ${toolOf("web_fetch").summary.slice(0, 120)}`), "web_fetch in the server's own words");
  assert.ok(!prompt.includes("- `read`:"), "read is no call node's tool");
});

// A run whose only work is its learned workflows, each answering, with nothing said after its first message, gives
// nothing new to look back on: it is not asked its end-of-run turn (no model request), and its learning is dropped
// `empty` in said.onlyWorkflow's words, at no cost. Any other tool, or a learned workflow that fails, is asked as before.
// The suite's learned_workflow stands in for the run's (the hook reads the run's timeline, by the tool's name).
const learnsFrom = (dir) => seedOf(dir, "agent-1").then((seed) => runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir));
const workflow = (run) => ({ name: "learned_workflow", run });
const read = { name: "read", run: async () => "the file's text" };

test("a run whose only work is one learned workflow that answers is not asked its end-of-run turn: no model request, its learning reads nothing new, at no cost", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, learnsFrom);
  const requests = [];
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ call: "learned_workflow" }, { say: "It is 42." }, { say: REFLECTED }], tools: { learned_workflow: workflow(async () => "{\"answer\":42}") }, requests });
  const row = await w.ended();
  const turn = await w.turnOf(row);
  assert.equal(turn.reflect, undefined, "no end-of-run turn was placed");
  assert.deepEqual(turn.users, ["Follow the script."], "only the job's message");
  assert.equal(requests.length, 2, `the job's two requests and no third: ${requests.length}`);
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual({ state: kept?.proposal?.state, reason: kept?.proposal?.reason, detail: kept?.proposal?.detail, look_back_usd: kept?.proposal?.look_back_usd }, { state: "dropped", reason: "empty", detail: said.onlyWorkflow, look_back_usd: 0 });
  assert.ok(!kept.learningRunId, "no learning run queued");
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual({ state: end?.state, reason: end?.reason, detail: end?.detail }, { state: "dropped", reason: "empty", detail: said.onlyWorkflow });
});

test("a run with a learned workflow and one other tool is still asked its end-of-run turn", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, learnsFrom);
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ calls: [{ call: "learned_workflow" }, { call: "read" }] }, { say: "It is 42." }, { say: REFLECTED }], tools: { learned_workflow: workflow(async () => "{\"answer\":42}"), read } });
  const row = await w.ended();
  assert.ok((await w.turnOf(row)).reflect, "the run was asked its end-of-run turn");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
});

test("a run whose learned workflow fails is still asked its end-of-run turn", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, learnsFrom);
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ call: "learned_workflow" }, { say: "It failed." }, { say: REFLECTED }], tools: { learned_workflow: workflow(async () => { throw new Error("the workflow's node failed"); }) } });
  const row = await w.ended();
  assert.ok((await w.turnOf(row)).reflect, "the run was asked its end-of-run turn");
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
});
