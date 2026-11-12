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

test("the draft ask describes each MCP tool a call node may run by its server's listing, the schema it takes and the one it gives, granted by name or under its server's wildcard; one its gate denies is not offered (one set to ask is: its learned_workflow call asks once), and the run is asked its turn (LS-07)", async (t) => {
  const offered = (seed) => ({ given: [], seed, section: "", seedNotes: 0, skills: ["weekly-report"] });
  const takes = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const gives = { type: "object", properties: { id: { type: "string" } } };
  // create_issue allowed, delete_issue denied, github's unset (ask: its learned_workflow call asks once, #2424).
  const settings = { "mcp:linear/create_issue": { permission: "allow" }, "mcp:linear/delete_issue": { permission: "deny" } };
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue", "mcp:linear/delete_issue", "mcp:github/*"], toolSettings: settings, learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => offered(seed.sha))(dir);
  }, async (server) => {
    for (const id of ["run-0a", "run-0b", "run-0c"]) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: runner(() => offered(null))() });
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [
      { name: "create_issue", description: "Create an issue in a team", input_schema: takes, output_schema: gives },
      { name: "delete_issue", description: "Delete an issue", input_schema: { type: "object" } },
    ] });
    await server.mcp.put({ name: "github", url: "https://mcp.github.example/mcp", auth: "none", tools: [{ name: "create_pull_request", description: "Open a pull request", input_schema: { type: "object", properties: { repo: { type: "string" } } } }] });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = (await w.turnOf(row)).users[1] ?? "";
  assert.ok(prompt, "the run was asked its end-of-run turn");
  const listed = prompt.slice(prompt.indexOf("What each tool a call node may run takes and gives:"), prompt.indexOf("A skill is how"));
  assert.ok(listed.includes(`- \`mcp:linear/create_issue\`: Create an issue in a team. Takes ${JSON.stringify(takes)}. Gives ${JSON.stringify(gives)}.`), listed || prompt.slice(0, 200));
  assert.ok(listed.includes('- `mcp:github/create_pull_request`: Open a pull request. Takes {"type":"object","properties":{"repo":{"type":"string"}}}.'), listed);
  // Granted but denied by its gate: no call node may run it, so it is not offered.
  assert.ok(!prompt.includes("mcp:linear/delete_issue"), "delete_issue is denied: not offered");
});

test("with no one to answer an ask (the store's approvers row: the server's accounts off), the draft ask offers no MCP tool set to ask: its learned call would be refused at once (#2424); one set to allow is still offered (LS-07)", async (t) => {
  const { writeApprovers } = await import("../dist/server-approvers.js");
  const offered = (seed) => ({ given: [], seed, section: "", seedNotes: 0, skills: ["weekly-report"] });
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue", "mcp:github/*"], toolSettings: { "mcp:linear/create_issue": { permission: "allow" } }, learning: true }, async (dir) => {
    const seed = await seedOf(dir, "agent-1");
    return runner(() => offered(seed.sha))(dir);
  }, async (server) => {
    await writeApprovers(server.settings, false);
    for (const id of ["run-0a", "run-0b", "run-0c"]) await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: runner(() => offered(null))() });
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue in a team", input_schema: { type: "object" } }] });
    await server.mcp.put({ name: "github", url: "https://mcp.github.example/mcp", auth: "none", tools: [{ name: "create_pull_request", description: "Open a pull request", input_schema: { type: "object" } }] });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = (await w.turnOf(row)).users[1] ?? "";
  assert.ok(prompt, "the run was asked its end-of-run turn");
  assert.ok(prompt.includes("- `mcp:linear/create_issue`: Create an issue in a team."), prompt.slice(prompt.indexOf("What each tool"), prompt.indexOf("A skill is how")));
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
  root: { node: "chain", steps: [{ node: "judge", label: "check", state: { claim: "{claim}" }, out: "Check", as: "check" }] },
})}\n\`\`\`\``;

test("on a run with decision providers the end-of-run prompt allows judge nodes and a drafted judge workflow is kept; with none the prompt bans them and the draft is left out", async (t) => {
  for (const decided of [true, false]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, async (dir) => {
      const seed = await seedOf(dir, "agent-1");
      return runner(() => ({ given: [], seed: seed.sha, section: "", seedNotes: 0 }))(dir);
    });
    const providers = await decisionProvidersIn({ TYPESAFE_API_KEY: "faux-key", AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV });
    assert.ok(providers?.providers.jev, "setup: the faux Jev");
    await w.start((deps) => learningEndOfRun(w.launch, { ...deps, ...(decided ? { decisionProviders: async () => providers } : {}) }), { script: [{ say: "The job's answer." }, { say: `${REFLECTED}\n\n${judgeDraft}` }, { say: REFLECTED }] });
    const row = await w.ended();
    const turn = await w.turnOf(row);
    const prompt = turn.users[1].replace(/\s+/g, " ");
    assert.equal(prompt.includes("no judge, pick or sift node"), !decided, `the ban follows the run's decisions: ${prompt.slice(prompt.indexOf("A workflow draft does"), prompt.indexOf("A workflow draft does") + 400)}`);
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.state, "proposed", JSON.stringify(kept?.proposal));
    assert.equal(kept.proposal.workflows, decided ? 1 : 0, `the judge draft is ${decided ? "kept" : "left out"}: ${JSON.stringify(kept.proposal).slice(0, 400)}`);
  }
});
