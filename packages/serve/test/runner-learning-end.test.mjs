// The end-of-run step of a run that learns, through a real runner (runner/learning-end.ts learningEndOfRun): the spec's
// endOfRun is the reflect hook (reflect-hook.ts createReflectHook) over the run's store, driven by the learning start
// its launch records (run-launch.ts learningStartOf). A learning agent's run is asked no turn of its own at its end: its
// owner's words are one line of corrections.md, and a compile turn is asked only when the job is due (its definition's
// compile_after); a draft is checked against the seed it started from (checkDraftOf), and what passes is committed by
// the run (commitDirect) and kept beside its end (learning_proposals). A run that does not learn is asked nothing and
// keeps nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { mergesOf, repoOf } from "./learn-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { runReflect } = await import("../dist/store-reads/journal.js");
const { runLearningEnd, runLearningOverStore } = await import("../dist/store-reads/learning.js");
const { recordPromotion } = await import("../dist/learn/promote.js");
const { textsAt } = await import("../dist/learn/folder.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { secretsShown, seedOf } = await import("../dist/learning.js");
const { learningStoreOf } = await import("../dist/learn/store-of.js");
const { said } = await import("../dist/learning-words.js");
const { saveToolSettings } = await import("../dist/tool-plane.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { learningEndOfRun, ownerWords } = await import("../dist/runner/learning-end.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
// One runner, never meant to lose its claim: a lease no stall outlasts.
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);

/** The owner's feedback on a run (`start`'s `feedback`): a person's message after the job's first. */
const FEEDBACK = "Retry more slowly next time.";

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
   *  `tools` (each model request pushed on `requests`). */
  const start = async (endOfRunOf, { script = [{ say: "The job's answer." }], tools = {}, requests = [], feedback } = {}) => {
    // `feedback`: a person's message queued before the runner claims the run, taken after the job's first: the owner's
    // words its end keeps as a correction (learning-end.ts ownerWords).
    if (feedback !== undefined) await sendCommand(server, "run-1", { kind: "steer", body: { text: feedback } });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const spec = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
    // Mode 1: the agent's learning folder is the local one under the data directory.
    const endOfRun = endOfRunOf({ store, data: dir, env: {}, learningStore: (agentId) => learningStoreOf(dir, agentId) });
    const createLoop = (deps) => createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1" }))({ ...deps, ...(endOfRun ? { endOfRun } : {}) });
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
  /** The texts of `paths` on agent-1's learning folder at `commit`. */
  const textsOn = async (commit, paths) => {
    const folder = learningStoreOf(dir, "agent-1");
    return await textsAt(folder, commit, paths);
  };
  return { dir, server, launch, start, ended, turnOf, textsOn };
}

const runner = (learning) => (dir) => ({ input: { content: "Follow the script." }, title: "t", place: { mode: "runner" }, ...(learning ? { learning: learning(dir) } : {}) });
/** A learning start over agent-1's folder as it is now (its definition's compile_after says when it is asked to compile). */
const learnsFrom = (dir) => seedOf(dir, "agent-1").then((seed) => runner(() => ({ seed: seed.sha, section: "" }))(dir));
/** The compile turn's first ask among a run's user messages. */
const compileAskIn = (users) => users.find((text) => text.startsWith("One more turn: write this agent's job as a learned workflow.")) ?? "";
const againIn = (users) => users.filter((text) => text.startsWith("Your workflow draft did not pass the checks"));

test("a learning agent's run with its owner's feedback, through a real runner, is asked no turn of its own: the words are one line of corrections.md, committed by the run and kept beside its end", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, learnsFrom);
  await w.start((deps) => learningEndOfRun(w.launch, deps), { feedback: FEEDBACK, script: [{ say: "The job's answer." }, { say: "Noted." }] });
  const row = await w.ended();
  const turn = await w.turnOf(row);
  assert.equal(turn.reflect, undefined, "no end-of-run turn: the job is not due to compile");
  assert.deepEqual(turn.users, ["Follow the script.", FEEDBACK], "the job's message, then the owner's feedback");
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.corrections, kept?.proposal?.workflows], ["merged", 1, undefined], JSON.stringify(kept?.proposal));
  assert.equal(kept.proposal.detail, said.merged([], 1, []));
  assert.equal(kept.proposal.look_back_usd, 0, "nothing asked, nothing spent");
  assert.deepEqual(mergesOf(repoOf(w.dir, "agent-1"), "run-1"), [`${kept.proposal.merged} run-1`], "one merge on main, by the run");
  const texts = await w.textsOn(kept.proposal.merged, ["corrections.md"]);
  assert.ok(texts["corrections.md"].includes(FEEDBACK), texts["corrections.md"]);
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual({ state: end?.state, reason: end?.reason, detail: end?.detail }, { state: "merged", reason: null, detail: said.merged([], 1, []) }, "the run's learning end reads it");
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
  const w = await world(t, { instructions: "Answer.", tools: ["read", "web_search"], learning: { compile_after: 1 } }, learnsFrom, async (server) => {
    await saveToolSettings(server, { web_search: { permission: "deny" } });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = compileAskIn((await w.turnOf(row)).users);
  assert.ok(prompt, "the run was asked its compile turn");
  assert.match(prompt, /There is no tool for a call node to run\./, prompt.slice(prompt.indexOf("## This job"), prompt.indexOf("## This job") + 300));
  assert.ok(!prompt.includes("web_search"), "the store's deny keeps it out");
});

test("an agent with compile_after 1 and no learned workflow gets a compile turn on its first completed run, with the DSL's own reference; with compile_after 2 and no earlier runs, none", async (t) => {
  for (const after of [1, 2]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: after } }, learnsFrom);
    await w.start((deps) => learningEndOfRun(w.launch, deps), { feedback: FEEDBACK, script: [{ say: "The job's answer." }, { say: "Noted." }] });
    const row = await w.ended();
    const { users } = await w.turnOf(row);
    const prompt = compileAskIn(users);
    if (after === 2) {
      assert.equal(prompt, "", "not due: no compile turn");
      assert.deepEqual(users, ["Follow the script.", FEEDBACK], "the job's message and the owner's feedback, nothing more");
      continue;
    }
    assert.ok(prompt.includes("## The workflow language") && prompt.includes("## A worked example"), prompt.slice(0, 300));
    assert.match(prompt, /This run's input has these fields: `content` \(string\)\./);
  }
});

test("the compile ask describes each tool a call node may run, by the server's own words for what it takes and gives", async (t) => {
  const { toolOf } = await import("../dist/tools.js");
  const w = await world(t, { instructions: "Answer.", tools: ["read", "web_fetch"], learning: { compile_after: 1 } }, learnsFrom);
  await w.start((deps) => learningEndOfRun(w.launch, deps));
  const row = await w.ended();
  const prompt = compileAskIn((await w.turnOf(row)).users);
  assert.ok(prompt.includes("What each tool a call node may run takes and gives:"), prompt.slice(prompt.indexOf("## This job"), prompt.indexOf("## Your answer")));
  assert.ok(prompt.includes(`- \`web_fetch\`: ${toolOf("web_fetch").summary.slice(0, 120)}`), "web_fetch in the server's own words");
  assert.ok(!prompt.includes("- `read`:"), "read is no call node's tool");
});

test("the compile ask describes each MCP tool a call node may run by its server's listing, the schema it takes and the one it gives, granted by name; one its gate denies is not offered (one set to ask is: its learned_workflow call asks once), and the run is asked its turn (LS-07)", async (t) => {
  const takes = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const gives = { type: "object", properties: { id: { type: "string" } } };
  // create_issue allowed, delete_issue denied, github's unset (ask: its learned_workflow call asks once, #2424).
  const settings = { "mcp:linear/create_issue": { permission: "allow" }, "mcp:linear/delete_issue": { permission: "deny" } };
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue", "mcp:linear/delete_issue", "mcp:github/create_pull_request"], toolSettings: settings, learning: { compile_after: 1 } }, learnsFrom, async (server) => {
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
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue", "mcp:github/create_pull_request"], toolSettings: { "mcp:linear/create_issue": { permission: "allow" } }, learning: { compile_after: 1 } }, learnsFrom, async (server) => {
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

/** A compile answer: workflow `name` with `flow` as its JSON (or `json` as written), described `description`. */
const flowBlock = (name, flow, description, json = JSON.stringify(flow)) => `\`\`\`\`workflow ${name}\n---\ndescription: ${description}\n---\n${json}\n\`\`\`\``;
const ticketFlow = {
  v: 2, name: "file-ticket",
  schemas: { Q: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, R: { type: "object" } },
  input: { schemaId: "Q" }, output: { schemaId: "R", path: "r" },
  root: { node: "call", label: "File the ticket", via: "tool", tool: "mcp:linear/create_issue", args: { title: "{title}" }, out: "R", as: "r", deadline_s: 30 },
};

// The card's bound on the runner path: a learned call's card names the ask-set MCP actions its preview shows whole, and
// each one past it asks on its own as it runs, so a draft calling more of them than one card names is kept, never left out
// for its card's size.
test("a run's workflow draft whose ask-set MCP tools would not all fit on its learned call's approval card is kept: those past the card ask as they run (LS-07)", async (t) => {
  const names = Array.from({ length: 40 }, (_, i) => `create_issue_with_a_rather_long_descriptive_name_${String(i).padStart(2, "0")}`);
  const flow = {
    v: 2, name: "file-issues",
    schemas: { Q: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, R: { type: "object" } },
    input: { schemaId: "Q" }, output: { schemaId: "R", path: "r0" },
    root: { node: "chain", steps: names.map((name, i) => ({ node: "call", label: `Call ${i}`, via: "tool", tool: `mcp:linear/${name}`, args: { title: "{title}" }, out: "R", as: `r${i}`, deadline_s: 30 })) },
  };
  const answer = flowBlock("file-issues", flow, "Files the week's issues; use when asked to file them");
  const w = await world(t, { instructions: "Answer.", tools: ["read", ...names.map((name) => `mcp:linear/${name}`)], learning: { compile_after: 1 } }, learnsFrom, async (server) => {
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: names.map((name) => ({ name, description: "Create an issue", input_schema: { type: "object" } })) });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }, { say: answer }] });
  await w.ended();
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.workflows?.map(({ name }) => name), ["file-issues"], JSON.stringify(kept.proposal));
  assert.doesNotMatch(JSON.stringify(kept.proposal), /approval card/);
});

test("a run's workflow draft calling an MCP tool with no declared price is committed held, waiting for its owner's OK; one calling a priced tool is not (LS-07)", async (t) => {
  for (const prices of [undefined, { create_issue: 0.01 }]) {
    const answer = flowBlock("file-ticket", ticketFlow, "Files a ticket; use when asked to file one");
    const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue"], toolSettings: { "mcp:linear/create_issue": { permission: "allow" } }, learning: { compile_after: 1 } }, learnsFrom, async (server) => {
      await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue", input_schema: { type: "object" } }], ...(prices ? { prices } : {}) });
    });
    await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }] });
    await w.ended();
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
    const want = { file: "workflows/file-ticket/workflow.json", name: "file-ticket", ...(prices ? {} : { pending: true }) };
    assert.deepEqual(kept.proposal.workflows, [want], prices ? "priced: no hold" : "unpriced: held");
  }
});

// #2479 review (PRRT_kwDOUmdVMs62Q9R7): a draft's MCP tools are read from its JSON as JSON.parse reads it, so an address
// spelled with an escaped slash ("mcp:linear\/create_issue", which the checks pass as mcp:linear/create_issue) finds its
// declared price, and a priced tool's draft is not held.
test("a draft naming a priced MCP tool with an escaped slash in its address is not held as unpriced (LS-07)", async (t) => {
  const json = JSON.stringify(ticketFlow).replace("mcp:linear/create_issue", "mcp:linear\\/create_issue");
  assert.ok(json.includes("mcp:linear\\/create_issue"));
  const answer = flowBlock("file-ticket", ticketFlow, "Files a ticket; use when asked to file one", json);
  const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue"], toolSettings: { "mcp:linear/create_issue": { permission: "allow" } }, learning: { compile_after: 1 } }, learnsFrom, async (server) => {
    await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue", input_schema: { type: "object" } }], prices: { create_issue: 0.01 } });
  });
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }] });
  await w.ended();
  const kept = await w.server.learning.proposal("run-1");
  assert.equal(kept?.proposal?.state, "merged", JSON.stringify(kept?.proposal));
  assert.deepEqual(kept.proposal.workflows, [{ file: "workflows/file-ticket/workflow.json", name: "file-ticket" }], "priced, though its address is escaped: not held");
});

// A run whose only work is its learned workflows, each answering, with nothing said after its first message, gives
// nothing new: its learning is dropped `empty` in said.onlyWorkflow's words, at no cost. Any other tool, or a learned
// workflow that fails, is something new: an end with nothing to keep says so in said.empty's words. The suite's
// learned_workflow stands in for the run's (the hook reads the run's timeline, by the tool's name).
const workflow = (run) => ({ name: "learned_workflow", run });
const read = { name: "read", run: async () => "the file's text" };

test("a run whose only work is one learned workflow that answers is asked nothing: no model request, its learning reads nothing new, at no cost", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, learnsFrom);
  const requests = [];
  await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ call: "learned_workflow" }, { say: "It is 42." }], tools: { learned_workflow: workflow(async () => "{\"answer\":42}") }, requests });
  const row = await w.ended();
  const turn = await w.turnOf(row);
  assert.equal(turn.reflect, undefined, "no end-of-run turn was placed");
  assert.deepEqual(turn.users, ["Follow the script."], "only the job's message");
  assert.equal(requests.length, 2, `the job's two requests and no third: ${requests.length}`);
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual({ state: kept?.proposal?.state, reason: kept?.proposal?.reason, detail: kept?.proposal?.detail, look_back_usd: kept?.proposal?.look_back_usd }, { state: "dropped", reason: "empty", detail: said.onlyWorkflow, look_back_usd: 0 });
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual({ state: end?.state, reason: end?.reason, detail: end?.detail }, { state: "dropped", reason: "empty", detail: said.onlyWorkflow });
});

for (const [what, script, tools] of [
  ["a learned workflow and one other tool", [{ calls: [{ call: "learned_workflow" }, { call: "read" }] }, { say: "It is 42." }], { learned_workflow: workflow(async () => "{\"answer\":42}"), read }],
  ["a learned workflow that fails", [{ call: "learned_workflow" }, { say: "It failed." }], { learned_workflow: workflow(async () => { throw new Error("the workflow's node failed"); }) }],
]) {
  test(`a run with ${what} is no learned workflow's run alone: its end with nothing to keep reads said.empty, never said.onlyWorkflow`, async (t) => {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: true }, learnsFrom);
    await w.start((deps) => learningEndOfRun(w.launch, deps), { script, tools });
    await w.ended();
    const kept = await w.server.learning.proposal("run-1");
    assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason, kept?.proposal?.detail], ["dropped", "empty", said.empty], JSON.stringify(kept?.proposal));
  });
}

// Walk 6 on #2479: a draft calling an MCP tool a deny holds is refused in words that name where the deny was set: the
// agent's own tool settings ("for this agent"), or the server's ("on this server"), never the server for both.
test("a run's workflow draft calling an MCP tool set to deny is refused naming where the deny was set: the agent's tool settings, or the server's (LS-07)", async (t) => {
  const answer = flowBlock("file-ticket", ticketFlow, "Files a ticket; use when asked to file one");
  const DENY = { "mcp:linear/create_issue": { permission: "deny" } };
  for (const [where, place] of [["agent", "for this agent"], ["server", "on this server"]]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read", "mcp:linear/create_issue"], ...(where === "agent" ? { toolSettings: DENY } : {}), learning: { compile_after: 1 } }, learnsFrom, async (server) => {
      await server.mcp.put({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none", tools: [{ name: "create_issue", description: "Create an issue", input_schema: { type: "object" } }], prices: { create_issue: 0.01 } });
      if (where === "server") await saveToolSettings(server, DENY);
    });
    await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: answer }, { say: answer }, { say: answer }, { say: answer }] });
    await w.ended();
    const kept = await w.server.learning.proposal("run-1");
    assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason, kept?.proposal?.workflows], ["dropped", "checker", undefined], JSON.stringify(kept?.proposal));
    const errors = (kept.proposal.draft_errors ?? []).join("\n");
    assert.ok(errors.includes(`This workflow's call node calls mcp:linear/create_issue, which is set to deny ${place}.`), `${where}: ${errors}`);
  }
});

// LS-07: a learned workflow may run judge nodes on a run with decision providers, so the compile turn allows them there
// (the draft check's own `decisions`, workflow-draft.ts draftDecisionProviders) and keeps its ban on a run with none.
const { decisionProvidersIn } = await import("../dist/decisions.js");
const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const judgeDraft = `\`\`\`\`workflow check\n---\ndescription: Checks a claim; use when asked whether a claim is right\nexample: {"claim":"Six times seven is 42."}\n---\n${JSON.stringify({
  v: 2, name: "check",
  schemas: { In: { type: "object", required: ["claim"], properties: { claim: { type: "string" } } }, Check: { type: "object", required: ["right"], properties: { right: { type: "boolean", description: "Is the claim right?" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Check", path: "check" },
  // No step guard: the compile turn asks for none (learn/compile.ts guardProblems refuses one).
  root: { node: "chain", steps: [{ node: "judge", label: "check", state: { claim: "{claim}" }, out: "Check", as: "check" }] },
})}\n\`\`\`\``;

test("on a run with decision providers the compile turn allows judge nodes and a compiled judge workflow is kept; with none the draft is refused on every attempt and its errors go with the learning", async (t) => {
  for (const decided of [true, false]) {
    const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } }, learnsFrom);
    const providers = await decisionProvidersIn({ TYPESAFE_API_KEY: "fake-test-key", AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV });
    assert.ok(providers?.providers.jev, "setup: the faux Jev");
    await w.start((deps) => learningEndOfRun(w.launch, { ...deps, ...(decided ? { decisionProviders: async () => providers } : {}) }), { script: [{ say: "The job's answer." }, { say: judgeDraft }, { say: judgeDraft }, { say: judgeDraft }, { say: judgeDraft }] });
    const row = await w.ended();
    const turn = await w.turnOf(row);
    assert.ok(compileAskIn(turn.users), "the run was asked its compile turn");
    const kept = await w.server.learning.proposal("run-1");
    assert.equal(kept?.proposal?.state, decided ? "merged" : "dropped", JSON.stringify(kept?.proposal));
    assert.equal(kept.proposal.workflows?.length ?? 0, decided ? 1 : 0, `the judge draft is ${decided ? "kept" : "refused"}: ${JSON.stringify(kept.proposal).slice(0, 400)}`);
    assert.equal(kept.proposal.compiled.attempts.length, decided ? 1 : 4, JSON.stringify(kept.proposal.compiled));
    const end = await runLearningEnd(w.server, "run-1");
    if (decided) assert.deepEqual(end.draft_errors, undefined);
    else assert.match((end.draft_errors ?? []).join("; "), /decision nodes on a run with decision providers/, JSON.stringify(end));
  }
});

// The compile turn authors against the checker (learn/compile.ts): a faux model writes a draft the static checks refuse,
// then one whose dry run fails, then a good one. Each refusal goes back to it in the checks' own words, every attempt is
// recorded, and the draft that passed is committed beside the owner's correction.
const compiledBlock = ({ output = "answer", tools } = {}) => `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: output, ...(tools ? { tools } : {}) }] },
})}\n\`\`\`\``;

test("compile: a draft the checks refuse goes back with their words, up to 3 times; the fixed draft is committed beside the owner's correction, every attempt recorded", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } }, learnsFrom);
  await w.start((deps) => learningEndOfRun(w.launch, deps), { feedback: FEEDBACK, script: [{ say: "The job's answer." }, { say: "Noted." }, { say: compiledBlock({ tools: ["read"] }) }, { say: compiledBlock({ output: "other" }) }, { say: compiledBlock() }] });
  const row = await w.ended();
  const again = againIn((await w.turnOf(row)).users);
  assert.equal(again.length, 2, JSON.stringify(again.map((text) => text.slice(0, 80))));
  assert.match(again[0], /\(attempt 2 of 4\)[\s\S]*----- begin \w+: the checks -----/, again[0]);
  assert.match(again[0], /tool/, "the static check's words");
  assert.match(again[1], /\(attempt 3 of 4\)[\s\S]*dry run/, again[1]);
  const kept = await w.server.learning.proposal("run-1");
  const json = "workflows/answer/workflow.json";
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.corrections, kept?.proposal?.workflows], ["merged", 1, [{ file: json, name: "answer" }]], JSON.stringify(kept?.proposal));
  assert.equal(kept.proposal.detail, said.merged([{ name: "answer" }], 1, []));
  const { compiled } = kept.proposal;
  assert.equal(compiled.workflow, "answer");
  assert.deepEqual(compiled.attempts.map(({ ok }) => ok), [false, false, true]);
  assert.ok(compiled.attempts[0].errors.length && compiled.attempts[1].errors.length && compiled.attempts[2].errors.length === 0, JSON.stringify(compiled.attempts));
  assert.equal(kept.proposal.draft_errors, undefined, "no errors once it passed");
  // Each attempt was its own request (learn-reflect-run-1:compile-<n>), never answered from an earlier one.
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual(end.compiled.attempts.map(({ ok }) => ok), [false, false, true]);
  // The commit holds the draft and the correction; its promotion (learn/promote.ts) is read from the agent's records at
  // the committed draft's digest: undecided, then held, then promoted.
  const texts = await w.textsOn(kept.proposal.merged, [json, "corrections.md"]);
  assert.ok(texts["corrections.md"].includes(FEEDBACK), texts["corrections.md"]);
  const digest = workflowDigest({ workflow: texts[json] });
  assert.equal(compiled.digest, digest, "the digest a run serving it records");
  const read = async () => (await runLearningOverStore(w.server, "run-1", secretsShown([]), [])).compiled;
  assert.deepEqual([(await read()).digest, (await read()).promoted], [digest, null], "undecided");
  const record = { workflow: "answer", digest, at: new Date().toISOString(), source: "replay", reason: "r" };
  await recordPromotion(w.server.settings, "agent-1", { ...record, decided: "hold" }, () => true);
  assert.equal((await read()).promoted, false, "held");
  await recordPromotion(w.server.settings, "agent-1", { ...record, decided: "promote" }, () => true);
  assert.equal((await read()).promoted, true, "promoted");
});

test("compile: a draft that never passes is never silent: its errors go with the learning entry and the owner's correction still goes on", async (t) => {
  const w = await world(t, { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } }, learnsFrom);
  const bad = compiledBlock({ tools: ["read"] });
  await w.start((deps) => learningEndOfRun(w.launch, deps), { feedback: FEEDBACK, script: [{ say: "The job's answer." }, { say: "Noted." }, { say: bad }, { say: bad }, { say: bad }, { say: bad }] });
  const row = await w.ended();
  assert.equal(againIn((await w.turnOf(row)).users).length, 3, "three retries, no more");
  const kept = await w.server.learning.proposal("run-1");
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.corrections, kept?.proposal?.workflows], ["merged", 1, undefined], JSON.stringify(kept?.proposal));
  assert.equal(kept.proposal.compiled.attempts.length, 4);
  assert.ok(kept.proposal.draft_errors.length > 0);
  assert.ok((kept.proposal.problems ?? []).some((problem) => problem.rule === "workflow" && problem.path === "workflows/answer/workflow.json" && problem.detail.includes("the workflow DSL refuses it")), JSON.stringify(kept.proposal.problems));
  const end = await runLearningEnd(w.server, "run-1");
  assert.deepEqual(end.draft_errors, kept.proposal.draft_errors);
  assert.ok(end.problems.some((problem) => problem.rule === "workflow"), "its end carries the problems too");
});

// The agent's output schema (answer-json.ts answerAsServed): a learned workflow's answer is served shaped to it, else the
// run goes back to the agent, so the compile turn is told the schema, and the dry run holds the draft's answer to it with
// that same function. A draft whose object misses the schema's fields fails its dry run in the schema's words and goes
// back to the model; the retry that answers the whole object is kept. An agent with no output schema is held to none.
const MCC_SCHEMA = {
  type: "object", additionalProperties: false, required: ["mcc", "description", "confidence", "reasoning", "sources"],
  properties: { mcc: { type: "string" }, description: { type: "string" }, confidence: { type: "number" }, reasoning: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
};
const PART = { type: "object", properties: { mcc: { type: "string" }, confidence: { type: "number" } }, required: ["mcc", "confidence"] };
const shapedBlock = (out) => `\`\`\`\`workflow answer\n---\ndescription: Picks a merchant's category code; use when asked for one\nexample: {"content":"Acme Hardware, Austin"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Out: out },
  input: { schemaId: "In" }, output: { schemaId: "Out", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "pick", instructions: "Pick the merchant's category code.", out: "Out", as: "answer" }] },
})}\n\`\`\`\``;

test("compile against the agent's output schema: a draft answering part of the object fails its dry run in the schema's words and the retry that answers the whole object is kept; with no output schema the partial draft is kept at once", async (t) => {
  for (const schema of [MCC_SCHEMA, undefined]) {
    const w = await world(t, { instructions: "Pick the code.", tools: ["read"], learning: { compile_after: 1 }, ...(schema ? { outputSchema: schema } : {}) }, learnsFrom);
    await w.start((deps) => learningEndOfRun(w.launch, deps), { script: [{ say: "The job's answer." }, { say: shapedBlock(PART) }, { say: shapedBlock(MCC_SCHEMA) }] });
    const row = await w.ended();
    const { users } = await w.turnOf(row);
    const prompt = compileAskIn(users);
    assert.ok(prompt, "the run was asked its compile turn");
    const again = againIn(users);
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
    assert.deepEqual([kept.proposal.state, kept.proposal.workflows?.length], ["merged", 1]);
    assert.equal(kept.proposal.draft_errors, undefined, "no errors once it passed");
  }
});

// What counts as the owner's words on a run (ownerWords): a grade's words still pending (a FEEDBACK entry no end came
// after), or a person's message after the job's first. Never the job's own message, the end-of-run turn's own asks, or a
// grade's words a past end already closed.
const row = (id, kind, extra = {}) => ({ id, kind, agent_label: null, parent_tool_use_id: null, text: null, ...extra });

test("ownerWords: a grade's pending words or a person's message after the first are the owner's; the job's message, the end-of-run turn's asks and a closed round's words are not", () => {
  const job = [row("0:1", "user_message", { text: "Question 1" }), row("0:2", "final_answer", { text: "42" })];
  const asked = [row("0:3", "user_message", { text: "One more turn.", agent_label: "learning" }), row("0:4", "final_answer", { text: "A DRAFT", agent_label: "learning" })];
  const words = { kind: "agentrun.feedback", data: { round: "correction", correct: false, text: "Freight goes to 6400." } };
  assert.deepEqual(ownerWords([], job), [], "the job's own message");
  assert.deepEqual(ownerWords([], [...job, ...asked]), [], "the end-of-run turn's asks");
  assert.deepEqual(ownerWords([words], job), ["Freight goes to 6400."], "a grade's words, pending");
  assert.deepEqual(ownerWords([words, { kind: "agentrun.end" }], job), [], "a round a past end closed");
  assert.deepEqual(ownerWords([], [...job, ...asked, row("0:5", "user_message", { text: "Why 42?" })]), ["Why 42?"], "a person's follow-up");
});

test("ownerWords: a subagent's task prompt (a child conversation's user_message) is not the owner's; a root message after the answer still is", () => {
  const job = [row("0:1", "user_message", { text: "Question 1" })];
  const child = row("1:1", "user_message", { text: "Research the freight rates", conversation_id: 1, parent_tool_use_id: "toolu_spawn" });
  const answer = row("0:9", "final_answer", { text: "42" });
  assert.deepEqual(ownerWords([], [...job, child, answer]), [], "a subagent's prompt");
  assert.deepEqual(ownerWords([], [...job, child, answer, row("0:10", "user_message", { text: "Why 42?" })]), ["Why 42?"], "a root follow-up after a subagent ran");
});
