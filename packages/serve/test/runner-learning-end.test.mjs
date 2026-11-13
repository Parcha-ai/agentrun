// The end-of-run step of a run that learns, through a real runner (runner/learning-end.ts learningEndOfRun): the spec's
// endOfRun is the reflect hook (reflect-hook.ts createReflectHook) over the run's store, driven by the learning start
// its launch records (run-launch.ts learningStartOf). A learning agent's run is asked its end-of-run turn once its job
// answers; what it answers is checked against the seed it started from (propose.ts proposeRun, the server's one rule) and
// kept beside its end as its proposal (learning_proposals), which queues the learning run that grades and merges it (a
// run whose launch names harness "learning", which the runner's dispatch runs on the learning loop). A run that does
// not learn is asked nothing and keeps nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { git, repoOf, resnap } from "./learn-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { runReflect } = await import("../dist/store-reads/journal.js");
const { runLearningEnd, runLearningOverStore } = await import("../dist/store-reads/learning.js");
const { recordPromotion } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { learningFolderOf, secretsShown, seedOf } = await import("../dist/learning.js");
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

/** Agent-1's folder with `count` active notes on main: a job it has learned enough of to be compiled (learn/compile.ts
 *  compileDue). */
async function noted(dir, count = 3) {
  await seedOf(dir, "agent-1");
  const repo = repoOf(dir, "agent-1");
  const files = [];
  for (let i = 1; i <= count; i++) {
    const file = `rule-${i}.md`;
    writeFileSync(join(repo, file), `---\nname: Rule ${i}\ndescription: Rule ${i} of the job\ntype: feedback\n---\nDo step ${i} before step ${i + 1}.\n`);
    files.push(file);
  }
  git(repo, ["add", "--", ...files]);
  git(repo, ["commit", "-q", "-m", "notes"]);
  await resnap(dir, "agent-1");
}
/** A learning start over agent-1's folder as it is now, with `count` notes kept first (none: compiles nothing yet). */
const compiling = (count = 3) => async (dir) => {
  if (count) await noted(dir, count);
  const seed = await seedOf(dir, "agent-1");
  return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: count }))(dir);
};
/** The compile turn's first ask among a run's user messages. */
const compileAskIn = (users) => users.find((text) => text.startsWith("One more turn: write this agent's job as a learned workflow.")) ?? "";

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

test("the tools the compile turn offers a call node follow the server's tool settings in the store", async (t) => {
  // The store denies web_search: the prompt offers what the store says.
  const w = await world(t, { instructions: "Answer.", tools: ["read", "web_search"], learning: true }, compiling(), async (server) => {
    await saveToolSettings(server, { web_search: { permission: "deny" } });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = compileAskIn((await w.turnOf(row)).users);
  assert.ok(prompt, "the run was asked its compile turn");
  assert.match(prompt, /There is no tool for a call node to run\./, prompt.slice(prompt.indexOf("## This job"), prompt.indexOf("## This job") + 300));
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

test("an agent with 3 kept notes and no learned workflow gets a compile turn after its look-back, with its notes and the DSL's own reference; with 2 notes and no earlier runs, none", async (t) => {
  for (const count of [3, 2]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, compiling(count));
    await w.start((deps) => learningEndOfRun(w.launch, deps));
    const row = await w.ended();
    const { users } = await w.turnOf(row);
    const prompt = compileAskIn(users);
    if (count === 2) {
      assert.equal(prompt, "", "not due: no compile turn");
      assert.equal(users.length, 2, "the job's message and the look-back's prompt");
      continue;
    }
    assert.ok(prompt.includes("## The workflow language") && prompt.includes("## A worked example"), prompt.slice(0, 300));
    for (const file of ["rule-1.md", "rule-2.md", "rule-3.md"]) assert.ok(prompt.includes(file), file);
    assert.match(prompt, /This run's input has these fields: `content` \(string\)\./);
    // The look-back's prompt asks for no workflow draft any more: the 3-offers ask is gone.
    assert.doesNotMatch(users[1], /has now served|workflow draft named/);
  }
});

test("the compile ask describes each tool a call node may run, by the server's own words for what it takes and gives", async (t) => {
  const { toolOf } = await import("../dist/tools.js");
  const w = await world(t, { instructions: "Answer.", tools: ["read", "web_fetch"], learning: true }, compiling(), async (server) => {
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = compileAskIn((await w.turnOf(row)).users);
  assert.ok(prompt.includes("What each tool a call node may run takes and gives:"), prompt.slice(prompt.indexOf("## This job"), prompt.indexOf("## Your answer")));
  assert.ok(prompt.includes(`- \`web_fetch\`: ${toolOf("web_fetch").summary.slice(0, 120)}`), "web_fetch in the server's own words");
  assert.ok(!prompt.includes("- `read`:"), "read is no call node's tool");
});

test("the compile ask describes each MCP tool a call node may run by its server's listing, the schema it takes and the one it gives, granted by name or under its server's wildcard; one its gate denies is not offered (one set to ask is: its learned_workflow call asks once), and the run is asked its turn (LS-07)", async (t) => {
  const takes = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const gives = { type: "object", properties: { id: { type: "string" } } };
  // create_issue allowed, delete_issue denied, github's unset (ask: its learned_workflow call asks once, #2424).
  const settings = { "mcp:linear/create_issue": { permission: "allow" }, "mcp:linear/delete_issue": { permission: "deny" } };
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue", "mcp:linear/delete_issue", "mcp:github/*"], toolSettings: settings, learning: true }, compiling(), async (server) => {
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [
      { name: "create_issue", description: "Create an issue in a team", input_schema: takes, output_schema: gives },
      { name: "delete_issue", description: "Delete an issue", input_schema: { type: "object" } },
    ] });
    await server.mcp.put({ name: "github", url: "https://mcp.github.example/mcp", auth: "none", tools: [{ name: "create_pull_request", description: "Open a pull request", input_schema: { type: "object", properties: { repo: { type: "string" } } } }] });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = compileAskIn((await w.turnOf(row)).users);
  assert.ok(prompt, "the run was asked its compile turn");
  const listed = prompt.slice(prompt.indexOf("What each tool a call node may run takes and gives:"), prompt.indexOf("## Your answer"));
  assert.ok(listed.includes(`- \`mcp:linear/create_issue\`: Create an issue in a team. Takes ${JSON.stringify(takes)}. Gives ${JSON.stringify(gives)}.`), listed || prompt.slice(0, 200));
  assert.ok(listed.includes('- `mcp:github/create_pull_request`: Open a pull request. Takes {"type":"object","properties":{"repo":{"type":"string"}}}.'), listed);
  // Granted but denied by its gate: no call node may run it, so it is not offered.
  assert.ok(!prompt.includes("mcp:linear/delete_issue"), "delete_issue is denied: not offered");
});

test("with no one to answer an ask (the store's approvers row: the server's accounts off), the compile ask offers no MCP tool set to ask: its learned call would be refused at once (#2424); one set to allow is still offered (LS-07)", async (t) => {
  const { writeApprovers } = await import("../dist/server-approvers.js");
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue", "mcp:github/*"], toolSettings: { "mcp:linear/create_issue": { permission: "allow" } }, learning: true }, compiling(), async (server) => {
    await writeApprovers(server.settings, false);
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue in a team", input_schema: { type: "object" } }] });
    await server.mcp.put({ name: "github", url: "https://mcp.github.example/mcp", auth: "none", tools: [{ name: "create_pull_request", description: "Open a pull request", input_schema: { type: "object" } }] });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = compileAskIn((await w.turnOf(row)).users);
  assert.ok(prompt, "the run was asked its compile turn");
  assert.ok(prompt.includes("- `mcp:linear/create_issue`: Create an issue in a team."), prompt.slice(prompt.indexOf("What each tool"), prompt.indexOf("## Your answer")));
  assert.ok(!prompt.includes("mcp:github/create_pull_request"), "github's tool asks, and no one can answer: not offered");
});

// #2424's card rule on the runner path: the learning end hands the draft check the MCP tools set to ask and learnedAskFits,
// so a draft calling more ask-set MCP tools than one approval card can name is left out of what the run keeps.
test("a run's workflow draft whose ask-set MCP tools would not all fit on its learned call's approval card is left out in the gate's words; its note is kept (LS-07, #2424)", async (t) => {
  const names = Array.from({ length: 40 }, (_, i) => `create_issue_with_a_rather_long_descriptive_name_${String(i).padStart(2, "0")}`);
  const flow = {
    v: 2, name: "file-issues",
    schemas: { Q: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, R: { type: "object" } },
    input: { schemaId: "Q" }, output: { schemaId: "R", path: "r0" },
    root: { node: "chain", steps: names.map((name, i) => ({ node: "call", label: `Call ${i}`, via: "tool", tool: `mcp:linear/${name}`, args: { title: "{title}" }, out: "R", as: `r${i}`, deadline_s: 30 })) },
  };
  const answer = `${REFLECTED}\n\n\`\`\`\`workflow file-issues\n---\ndescription: Files the week's issues; use when asked to file them\n---\n${JSON.stringify(flow)}\n\`\`\`\``;
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/*"], learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
  }, async (server) => {
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: names.map((name) => ({ name, description: "Create an issue", input_schema: { type: "object" } })) });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }, { say: answer }] });
  await w.ended();
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.workflows, 0, JSON.stringify(kept?.proposal));
  assert.match(JSON.stringify(kept?.proposal?.left ?? kept?.proposal), /its approval card can't name all 40 MCP tools it would call that are set to ask/);
});

test("a run's workflow draft calling an MCP tool with no declared price is proposed held, saying which step, tool and server; one calling a priced tool is not (LS-07)", async (t) => {
  for (const prices of [undefined, { create_issue: 0.01 }]) {
    const flow = {
      v: 2, name: "file-ticket",
      schemas: { Q: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, R: { type: "object" } },
      input: { schemaId: "Q" }, output: { schemaId: "R", path: "r" },
      root: { node: "call", label: "File the ticket", via: "tool", tool: "mcp:linear/create_issue", args: { title: "{title}" }, out: "R", as: "r", deadline_s: 30 },
    };
    const answer = `${REFLECTED}\n\n\`\`\`\`workflow file-ticket\n---\ndescription: Files a ticket; use when asked to file one\n---\n${JSON.stringify(flow)}\n\`\`\`\``;
    const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue"], toolSettings: { "mcp:linear/create_issue": { permission: "allow" } }, learning: true }, async (dir) => {
      const seed = await seedOf(dir, "agent-1");
      return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
    }, async (server) => {
      await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue", input_schema: { type: "object" } }], ...(prices ? { prices } : {}) });
    });
    await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }] });
    await w.ended();
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.workflows, 1, JSON.stringify(kept?.proposal));
    const want = prices ? undefined : { "workflows/file-ticket/workflow.json": ["its step File the ticket calls create_issue on linear, which has no price here, so it runs outside the run's cost and cap"] };
    assert.deepEqual(kept.proposal.proposal.held, want, prices ? "priced: no hold" : "unpriced: held");
  }
});

// #2479 review (PRRT_kwDOUmdVMs62Q9R7): a draft's MCP tools are read from its JSON as JSON.parse reads it, so an address
// spelled with an escaped slash ("mcp:linear\/create_issue", which the checks pass as mcp:linear/create_issue) finds its
// declared price, and a priced tool's draft is not held.
test("a draft naming a priced MCP tool with an escaped slash in its address is not held as unpriced (LS-07)", async (t) => {
  const flow = {
    v: 2, name: "file-ticket",
    schemas: { Q: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, R: { type: "object" } },
    input: { schemaId: "Q" }, output: { schemaId: "R", path: "r" },
    root: { node: "call", label: "File the ticket", via: "tool", tool: "mcp:linear/create_issue", args: { title: "{title}" }, out: "R", as: "r", deadline_s: 30 },
  };
  const json = JSON.stringify(flow).replace("mcp:linear/create_issue", "mcp:linear\\/create_issue");
  assert.ok(json.includes("mcp:linear\\/create_issue"));
  const answer = `${REFLECTED}\n\n\`\`\`\`workflow file-ticket\n---\ndescription: Files a ticket; use when asked to file one\n---\n${json}\n\`\`\`\``;
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue"], toolSettings: { "mcp:linear/create_issue": { permission: "allow" } }, learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
  }, async (server) => {
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue", input_schema: { type: "object" } }], prices: { create_issue: 0.01 } });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }] });
  await w.ended();
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.workflows, 1, JSON.stringify(kept?.proposal));
  assert.equal(kept.proposal.proposal.held, undefined, "priced, though its address is escaped: not held");
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

// Walk 6 on #2479: a draft calling an MCP tool a deny holds is left out in words that name where the deny was set: the
// agent's own tool settings ("for this agent"), or the server's ("on this server"), never the server for both.
test("a run's workflow draft calling an MCP tool set to deny is left out naming where the deny was set: the agent's tool settings, or the server's (LS-07)", async (t) => {
  const flow = {
    v: 2, name: "file-ticket",
    schemas: { Q: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, R: { type: "object" } },
    input: { schemaId: "Q" }, output: { schemaId: "R", path: "r" },
    root: { node: "call", label: "File the ticket", via: "tool", tool: "mcp:linear/create_issue", args: { title: "{title}" }, out: "R", as: "r", deadline_s: 30 },
  };
  const answer = `${REFLECTED}\n\n\`\`\`\`workflow file-ticket\n---\ndescription: Files a ticket; use when asked to file one\n---\n${JSON.stringify(flow)}\n\`\`\`\``;
  const DENY = { "mcp:linear/create_issue": { permission: "deny" } };
  for (const [where, place] of [["agent", "for this agent"], ["server", "on this server"]]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue"], ...(where === "agent" ? { toolSettings: DENY } : {}), learning: true }, async (dir) => {
      const seed = await seedOf(dir, "agent-1");
      return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
    }, async (server) => {
      await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue", input_schema: { type: "object" } }], prices: { create_issue: 0.01 } });
      if (where === "server") await saveToolSettings(server, DENY);
    });
    await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }] });
    await w.ended();
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.workflows, 0, JSON.stringify(kept?.proposal));
    const details = (kept.proposal.left ?? []).map(({ detail }) => detail);
    assert.ok(details.includes(`This workflow's call node calls mcp:linear/create_issue, which is set to deny ${place}. (the call node at /root)`), `${where}: ${JSON.stringify(details)}`);
  }
});

// LS-07: a learned workflow may run judge nodes on a run with decision providers, so the end-of-run prompt allows them
// there (the draft check's own `decisions`, skills.ts draftDecisionProviders) and keeps its ban on a run with none.
const { decisionProvidersIn } = await import("../dist/decisions.js");
const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const judgeDraft = `\`\`\`\`workflow check\n---\ndescription: Checks a claim; use when asked whether a claim is right\nexample: {"claim":"Six times seven is 42."}\n---\n${JSON.stringify({
  v: 2, name: "check",
  schemas: { In: { type: "object", required: ["claim"], properties: { claim: { type: "string" } } }, Check: { type: "object", required: ["right"], properties: { right: { type: "boolean", description: "Is the claim right?" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Check", path: "check" },
  // The guard the compile turn asks a judgment step for with Jev (learn/compile.ts guardProblems holds the draft to it).
  root: { node: "chain", steps: [{ node: "judge", label: "check", state: { claim: "{claim}" }, out: "Check", as: "check", guard: { signal: "both", threshold: 0.7 } }] },
})}\n\`\`\`\``;

test("on a run with decision providers the compile turn allows judge nodes and a compiled judge workflow is kept; with none it offers none, the draft is refused on every attempt and its errors go with the learning", async (t) => {
  for (const decided of [true, false]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, compiling());
    const providers = await decisionProvidersIn({ TYPESAFE_API_KEY: "fake-test-key", AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV });
    assert.ok(providers?.providers.jev, "setup: the faux Jev");
    await w.start((deps) => learningEndOfRun(w.launch, { ...deps, ...(decided ? { decisionProviders: async () => providers } : {}) }), { script: [{ say: "The job's answer." }, { say: REFLECTED }, { say: judgeDraft }, { say: judgeDraft }, { say: judgeDraft }, { say: judgeDraft }] });
    const row = await w.ended();
    const turn = await w.turnOf(row);
    const prompt = compileAskIn(turn.users).replace(/\s+/g, " ");
    assert.ok(prompt, "the run was asked its compile turn");
    // Jev by default: the faux Jev is a provider, so the judgment steps are asked for a both guard; with none, self.
    assert.equal(prompt.includes('"guard": {"signal": "both"'), decided, "the guard rule follows the run's decisions");
    assert.equal(prompt.includes("This run cannot call Jev"), !decided);
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
    assert.equal(kept.proposal.workflows, decided ? 1 : 0, `the judge draft is ${decided ? "kept" : "left out"}: ${JSON.stringify(kept.proposal).slice(0, 400)}`);
    assert.equal(kept.proposal.compiled.attempts.length, decided ? 1 : 4, JSON.stringify(kept.proposal.compiled));
    const end = await runLearningEnd(w.server, "run-1");
    if (decided) assert.deepEqual(end.draft_errors, undefined);
    else assert.match((end.draft_errors ?? []).join("; "), /decision nodes on a run with decision providers/, JSON.stringify(end));
  }
});

// The compile turn authors against the checker (learn/compile.ts): a faux model writes a draft the static checks refuse,
// then one whose dry run fails, then a good one. Each refusal goes back to it in the checks' own words, every attempt is
// recorded, and the draft that passed is proposed beside the look-back's note, naming the notes it carries out.
const compiledBlock = ({ output = "answer", tools } = {}) => `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"content":"What is six times seven?"}\nfrom_notes: [rule-1.md, rule-2.md, not-given.md]\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: output, tier: "fast", ...(tools ? { tools } : {}) }] },
})}\n\`\`\`\``;

test("compile: a draft the checks refuse goes back with their words, up to 3 times; the fixed draft is proposed beside the note, every attempt recorded", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, compiling());
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: REFLECTED }, { say: compiledBlock({ tools: ["read"] }) }, { say: compiledBlock({ output: "other" }) }, { say: compiledBlock() }] });
  const row = await w.ended();
  const { users } = await w.turnOf(row);
  const again = users.filter((text) => text.startsWith("Your workflow draft did not pass the checks"));
  assert.equal(again.length, 2, JSON.stringify(users.map((text) => text.slice(0, 80))));
  assert.match(again[0], /\(attempt 2 of 4\)[\s\S]*----- begin \w+: the checks -----/, again[0]);
  assert.match(again[0], /tool/, "the static check's words");
  assert.match(again[1], /\(attempt 3 of 4\)[\s\S]*dry run/, again[1]);
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.notes, kept?.proposal?.workflows], ["proposed", 1, 1], JSON.stringify(kept?.proposal));
  const { compiled } = kept.proposal;
  assert.equal(compiled.workflow, "answer");
  assert.deepEqual(compiled.from_notes, ["rule-1.md", "rule-2.md"], "only notes it was given");
  assert.deepEqual(compiled.attempts.map(({ ok }) => ok), [false, false, true]);
  assert.ok(compiled.attempts[0].errors.length && compiled.attempts[1].errors.length && compiled.attempts[2].errors.length === 0, JSON.stringify(compiled.attempts));
  assert.deepEqual(kept.proposal.proposal.compiled, { workflow: "answer", from_notes: ["rule-1.md", "rule-2.md"] }, "the merge marks the notes it absorbed");
  assert.equal(kept.proposal.draft_errors, undefined, "no errors once it passed");
  // Each attempt was its own request (learn-reflect-run-1:compile-<n>), never answered from an earlier one.
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual(end.compiled.attempts.map(({ ok }) => ok), [false, false, true]);
  // Its promotion (learn/promote.ts) is read from the agent's records at the kept draft's digest: undecided, then held,
  // then promoted.
  const text = kept.proposal.proposal.files.find(({ file }) => file === "workflows/answer/workflow.json").text;
  const digest = workflowDigest({ workflow: text });
  assert.equal(compiled.digest, digest, "the digest a run serving it records");
  const read = async () => (await runLearningOverStore(w.server, "run-1", secretsShown([]), [])).compiled;
  assert.deepEqual([(await read()).digest, (await read()).promoted], [digest, null], "undecided");
  const record = { workflow: "answer", digest, at: new Date().toISOString(), source: "replay", reason: "r" };
  await recordPromotion(w.server.settings, "agent-1", { ...record, decided: "hold" }, () => true);
  assert.equal((await read()).promoted, false, "held");
  await recordPromotion(w.server.settings, "agent-1", { ...record, decided: "promote" }, () => true);
  assert.equal((await read()).promoted, true, "promoted");
});

test("compile: a draft that never passes is never silent: its errors go with the learning entry and the look-back's note still goes on", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, compiling());
  const bad = compiledBlock({ tools: ["read"] });
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: REFLECTED }, { say: bad }, { say: bad }, { say: bad }, { say: bad }] });
  const row = await w.ended();
  const { users } = await w.turnOf(row);
  assert.equal(users.filter((text) => text.startsWith("Your workflow draft did not pass the checks")).length, 3, "three retries, no more");
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.notes, kept?.proposal?.workflows], ["proposed", 1, 0], JSON.stringify(kept?.proposal));
  assert.equal(kept.proposal.compiled.attempts.length, 4);
  assert.ok(kept.proposal.draft_errors.length > 0);
  assert.ok((kept.proposal.left ?? []).some((problem) => problem.path === "workflows/answer/workflow.json"), JSON.stringify(kept.proposal.left));
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual(end.draft_errors, kept.proposal.draft_errors);
  assert.ok(end.problems.some((problem) => problem.path === "workflows/answer/workflow.json"), "its end carries the problems too");
});

// The agent's output schema (answer-json.ts answerAsServed): a learned workflow's answer is served shaped to it, else the
// run goes back to the agent, so the compile turn is told the schema, and the dry run holds the draft's answer to it with
// that same function. A one-field draft for a multi-field schema fails its dry run in the schema's words and goes back
// to the model; the retry that answers the whole object is kept. An agent with no output schema is held to none.
const MCC_SCHEMA = {
  type: "object", additionalProperties: false, required: ["mcc", "description", "confidence", "reasoning", "sources"],
  properties: { mcc: { type: "string" }, description: { type: "string" }, confidence: { type: "number" }, reasoning: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
};
const ONE_FIELD = { type: "object", properties: { mcc: { type: "string" } }, required: ["mcc"] };
const shapedBlock = (out) => `\`\`\`\`workflow answer\n---\ndescription: Picks a merchant's category code; use when asked for one\nexample: {"content":"Acme Hardware, Austin"}\nfrom_notes: [rule-1.md]\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Out: out },
  input: { schemaId: "In" }, output: { schemaId: "Out", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "pick", instructions: "Pick the merchant's category code.", out: "Out", as: "answer", tier: "fast" }] },
})}\n\`\`\`\``;

test("compile against the agent's output schema: a one-field draft fails its dry run in the schema's words and the retry that answers the whole object is kept; with no output schema the one-field draft is kept at once", async (t) => {
  for (const schema of [MCC_SCHEMA, undefined]) {
    const w = await world(t, { instructions: "Pick the code.", tools: ["read"], learning: true, ...(schema ? { outputSchema: schema } : {}) }, compiling());
    await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: REFLECTED }, { say: shapedBlock(ONE_FIELD) }, { say: shapedBlock(MCC_SCHEMA) }] });
    const row = await w.ended();
    const { users } = await w.turnOf(row);
    const prompt = compileAskIn(users);
    assert.ok(prompt, "the run was asked its compile turn");
    const again = users.filter((text) => text.startsWith("Your workflow draft did not pass the checks"));
    const kept = await w.server.learning.proposal("run-1");
    const { compiled } = kept.proposal;
    if (!schema) {
      assert.doesNotMatch(prompt, /final output must be this object/, "no schema, none shown");
      assert.deepEqual(again, [], "no schema, nothing to shape");
      assert.deepEqual(compiled.attempts.map(({ ok }) => ok), [true], JSON.stringify(compiled.attempts));
      continue;
    }
    assert.match(prompt, /The workflow's final output must be this object/);
    assert.ok(prompt.includes(JSON.stringify(MCC_SCHEMA, null, 2)), "the schema itself, whole");
    assert.equal(again.length, 1, JSON.stringify(users.map((text) => text.slice(0, 80))));
    assert.match(again[0], /\(attempt 2 of 4\)[\s\S]*dry run[\s\S]*output schema/, again[0]);
    assert.deepEqual(compiled.attempts.map(({ ok }) => ok), [false, true], JSON.stringify(compiled.attempts));
    assert.ok(compiled.attempts[0].errors.some((error) => /does not meet the agent's output schema/.test(error)), JSON.stringify(compiled.attempts));
    assert.deepEqual([kept.proposal.state, kept.proposal.workflows], ["proposed", 1]);
    assert.equal(kept.proposal.draft_errors, undefined, "no errors once it passed");
  }
});
