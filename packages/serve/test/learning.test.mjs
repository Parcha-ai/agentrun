// Learning: an agent with `learning` on has one bare git repository beside the store, whose main the host keeps in step
// with the agent's current revision. Each run starts from main's notes at one commit, journaled in its own store, and
// leaves `runs/<run id>` with the host's memo. Real repositories in temp dirs; the faux model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { learningId, renderLearning } from "@parcha/pi-agent-learn";
import { local, openRepo } from "@parcha/pi-git-remote";
import { startServe } from "../dist/index.js";
import { outcomeOf, proposeRun, untrustedOf } from "../dist/learning.js";
import { agent, client, FAUX, flowAgent, follow, scratch, serve, storeRun } from "./support.mjs";

const RATE_LIMIT = "The state registry rate-limits at 1 request a second.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bareOf = (data, id) => join(data, "agents", id, "learning.git");
const git = (dir, ...args) => execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" }).trim();
const tip = (dir, ref) => git(dir, "rev-parse", "--verify", "-q", `${ref}^{commit}`);
const show = (dir, ref, path) => git(dir, "show", `${ref}:${path}`);
const count = (dir, ref) => Number(git(dir, "rev-list", "--count", ref));
const branches = (dir) => git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean).sort();
/** The memo's front matter, as `key: value` lines. */
const front = (memo) => Object.fromEntries(/^---\n([\s\S]*?)\n---/.exec(memo)[1].split("\n").map((line) => /^([a-z_]+): (.*)$/.exec(line).slice(1)));
const lesson = (id, text) => ({ id, type: "lesson", scope: "all", status: "active", provenance: { runs: ["r0"], sha: "0".repeat(40), untrusted: false }, uses: 0, supersedes: [], text });

/** Commits `files` on main of agent `id`'s repository, as a curator would, and returns the new main. */
async function onMain(t, data, id, files) {
  assert.ok(existsSync(bareOf(data, id)), `the agent ${id} has a learning repository`);
  const repo = await openRepo({ dir: join(await scratch(t), "curator"), remote: local(bareOf(data, id)) });
  const made = await repo.commitTo("main", { files, message: "curator: test notes" });
  await repo.push(made.sha, "main");
  return made.sha;
}
const note = (l) => ({ [`learnings/${l.id}.md`]: renderLearning(l) });

test("a new agentic agent learns (auto) unless its definition says otherwise, an edit keeps its switch, and only an agentic agent learns", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("a"))).body.definition.learning, "auto", "a new agent learns by default");
  assert.equal((await api("POST", "/agents", agent("b", { learning: "off" }))).body.definition.learning, "off");
  assert.equal((await api("POST", "/agents", agent("c", { learning: "approve" }))).body.definition.learning, "approve");
  const edited = await api("PUT", "/agents/c/definition", { definition: { instructions: "Answer briefly.", skills: [], tools: [] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.definition.learning, "approve", "an edit that leaves learning out keeps the current revision's");
  assert.equal((await api("PUT", "/agents/c/definition", { definition: { instructions: "Answer briefly.", skills: [], tools: [], learning: "off" } })).body.definition.learning, "off");
  const wrong = await api("POST", "/agents", agent("d", { learning: "always" }));
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.fields[0].field, "definition.learning");
  const flow = await api("POST", "/agents", flowAgent("e", undefined, { learning: "auto" }));
  assert.equal(flow.status, 422, "a workflow agent does not learn");
  assert.equal(flow.body.error.fields[0].field, "definition.learning");
  const plain = await api("POST", "/agents", flowAgent("f"));
  assert.equal(plain.status, 201);
  assert.equal(plain.body.definition.learning, undefined, "a workflow definition has no learning field");
  assert.equal(existsSync(bareOf(data, "f")), false);
});

test("an agent that learns has a repository beside the store whose main holds AGENTS.md and agent.json for its current revision, one host commit per change", async (t) => {
  const { api, data } = await serve(t);
  const created = await api("POST", "/agents", agent("calc", { instructions: "Add the numbers." }));
  const bare = bareOf(data, "calc");
  assert.ok(existsSync(bare), "the agent has a learning repository");
  assert.equal(show(bare, "main", "AGENTS.md"), "Add the numbers.");
  assert.deepEqual(JSON.parse(show(bare, "main", "agent.json")), created.body.definition);
  assert.equal(git(bare, "log", "-1", "--format=%(trailers:key=Revision,valueonly)", "main"), created.body.revision);
  assert.equal(count(bare, "main"), 1);
  const edited = await api("PUT", "/agents/calc/definition", { definition: { instructions: "Add the numbers; show your work.", skills: [], tools: [] } });
  assert.equal(show(bare, "main", "AGENTS.md"), "Add the numbers; show your work.");
  assert.equal(JSON.parse(show(bare, "main", "agent.json")).version, 2);
  assert.equal(count(bare, "main"), 2);
  await api("PUT", "/agents/calc/definition", { definition: { instructions: "Add the numbers; show your work.", skills: [], tools: [] } });
  assert.equal(count(bare, "main"), 2, "an edit that writes no revision makes no commit");
  const moved = await api("POST", "/agents/calc/current", { revision: created.body.revision });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(show(bare, "main", "AGENTS.md"), "Add the numbers.", "making an older revision current writes it on main");
  assert.equal(count(bare, "main"), 3);
  assert.notEqual(edited.body.revision, created.body.revision);
  // What a curator wrote on main stays: the host commit changes the two locked files only.
  const curated = await onMain(t, data, "calc", note(lesson("L-0123456789ab", "Search both forms of the legal name.")));
  await api("PUT", "/agents/calc/definition", { definition: { instructions: "Add.", skills: [], tools: [] } });
  assert.equal(git(bare, "rev-parse", "main~1"), curated);
  assert.match(show(bare, "main", "learnings/L-0123456789ab.md"), /Search both forms/);
});

test("an agent that does not learn has no repository, and its runs leave none", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("quiet", { learning: "off" }));
  const { body: run } = await api("POST", "/agents/quiet/runs", { input: { content: "What have you learned?" } });
  const { last } = await follow(api, run.run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.match((await api("GET", `/runs/${run.run_id}`)).body.result.final_answer, /^Learned: nothing$/);
  assert.equal(existsSync(join(data, "agents", "quiet")), false);
  assert.equal(existsSync(join(data, "runs", run.run_id, "work", ".agent")), false);
});

test("a run starts from main's notes at one commit: they are in its workspace and its prompt, and its branch names that commit as its base", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const base = await onMain(t, data, "calc", note(lesson("L-0123456789ab", "Search both forms of the legal name.")));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  const { last } = await follow(api, run.run_id, ["completed"]);
  assert.equal(last.final, true);
  const answer = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(answer.status, "completed");
  const work = join(data, "runs", run.run_id, "work");
  assert.equal(await readFile(join(work, ".agent", "learnings", "L-0123456789ab.md"), "utf8"), renderLearning(lesson("L-0123456789ab", "Search both forms of the legal name.")));
  const bare = bareOf(data, "calc");
  const branch = `runs/${run.run_id}`;
  assert.ok(branches(bare).includes(branch), `the run leaves ${branch}`);
  assert.equal(git(bare, "merge-base", branch, "main"), base, "the branch starts from the commit the run was seeded from");
  const memo = front(show(bare, branch, `memos/${run.run_id}.md`));
  assert.deepEqual({ ...memo, cost_usd: undefined }, { run: run.run_id, base, harness: "pi", outcome: "completed", untrusted: "false", cost_usd: undefined });
  assert.ok(Number.isFinite(Number(memo.cost_usd)), "the memo says what the run cost");
  assert.match(show(bare, branch, `learnings/${learningId(run.run_id, RATE_LIMIT)}.md`), /rate-limits at 1 request a second/);
});

test("the notes are in the prompt the model sees", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  await onMain(t, data, "calc", note(lesson("L-0123456789ab", "Search both forms of the legal name.")));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What have you learned?" } });
  await follow(api, run.run_id, ["completed"]);
  assert.match((await api("GET", `/runs/${run.run_id}`)).body.result.final_answer, /L-0123456789ab lesson: Search both forms of the legal name\./);
});

test("skills the agent wrote come from main at the run's commit, and a revision skill of the same name wins", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", { ...agent("calc", { skills: ["cite"] }), skills: { "cite/SKILL.md": "Cite the person's way." } })).status, 201);
  await onMain(t, data, "calc", { ".agents/skills/cite/SKILL.md": "Cite the agent's way.", ".agents/skills/tally/SKILL.md": "Tally twice." });
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Which skills do you have?" } });
  await follow(api, run.run_id, ["completed"]);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.result.final_answer, "Skills: cite=Cite the person's way., tally=Tally twice.");
  assert.equal(await readFile(join(data, "runs", run.run_id, "work", ".agents", "skills", "tally", "SKILL.md"), "utf8"), "Tally twice.");
});

/** A server in a process of its own, so a test can kill it the way a crash does and leave its runs behind. */
async function serverProcess(data) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_API_KEY=/.test(out); i++) {
    assert.ok(i < 200, `the server did not start: ${out}`);
    await sleep(50);
  }
  const value = (name) => new RegExp(`${name}=(\\S+)`).exec(out)[1];
  return { child, api: client(value("AGENTRUN_BASE_URL"), value("AGENTRUN_API_KEY")) };
}

test("a run's base stays where it was seeded when its process dies, main moves, and the next server resumes it", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  const base = await onMain(t, data, "calc", note(lesson("L-0123456789ab", "Search both forms of the legal name.")));
  const gate = join(dir, "go");
  const { body: run } = await first.api("POST", "/agents/calc/runs", { input: { content: `Learn the rate limit, then answer once ${gate} exists.` } });
  // The learn call's result comes after the seed is journaled: the run is past its seed when its server dies.
  for (let i = 0; !(await first.api("GET", `/runs/${run.run_id}/timeline`)).body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "learn"); i++) {
    assert.ok(i < 400, "the run notes its lesson");
    await sleep(50);
  }
  assert.ok(existsSync(join(data, "runs", run.run_id, "work", ".agent", "learnings", "L-0123456789ab.md")), "the run was seeded");
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const record = JSON.parse(await readFile(join(data, "runs", run.run_id, "run.json"), "utf8"));
  if (record.holder?.pid) {
    try {
      process.kill(record.holder.pid, "SIGKILL");
    } catch {}
  }
  const later = await onMain(t, data, "calc", note(lesson("L-ba9876543210", "A note written after the run started.")));
  assert.notEqual(later, base);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  await writeFile(gate, "");
  const { last } = await follow(api, run.run_id, ["completed"]);
  assert.equal(last.final, true);
  const bare = bareOf(data, "calc");
  assert.equal(front(show(bare, `runs/${run.run_id}`, `memos/${run.run_id}.md`)).base, base, "the base is the commit the run was first seeded from");
  assert.equal(git(bare, "merge-base", `runs/${run.run_id}`, "main"), base);
  assert.equal(existsSync(join(data, "runs", run.run_id, "work", ".agent", "learnings", "L-ba9876543210.md")), false, "a note main gained later is not the run's");
});

test("a cancelled run's memo says it stopped", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const gate = join(await scratch(t), "never");
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: `Learn the rate limit, then answer once ${gate} exists.` } });
  const bare = bareOf(data, "calc");
  for (let i = 0; !(await api("GET", `/runs/${run.run_id}/timeline`)).body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "learn"); i++) {
    assert.ok(i < 400, "the run notes its lesson");
    await sleep(50);
  }
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  await follow(api, run.run_id, ["cancelled"]);
  assert.ok(existsSync(bare) && branches(bare).includes(`runs/${run.run_id}`), "the cancelled run left its branch");
  assert.equal(front(show(bare, `runs/${run.run_id}`, `memos/${run.run_id}.md`)).outcome, "stopped");
  assert.equal(storeRun(data, run.run_id).state, "stopped");
});

test("proposing a run again makes no second commit: the branch's Run-Id answers already", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  const bare = bareOf(data, "calc");
  const branch = `runs/${run.run_id}`;
  assert.ok(existsSync(bare) && branches(bare).includes(branch), `the run left ${branch}`);
  const sha = tip(bare, branch);
  const again = await proposeRun({ data, agentId: "calc", runId: run.run_id, storeFile: join(data, "runs", run.run_id, "store", "run.sqlite"), outcome: "completed", costUsd: 0, untrusted: false, caseValues: [], secrets: [] });
  assert.deepEqual(again, { status: "already", sha });
  assert.equal(tip(bare, branch), sha);
  assert.equal(git(bare, "log", "--format=%H", `main..${branch}`), sha, "one commit for the run");
});

test("a run's outcome on its memo, and what makes a run untrusted", () => {
  assert.deepEqual(["completed", "failed", "cancelled"].map(outcomeOf), ["completed", "failed", "stopped"]);
  const call = (tool_name) => ({ kind: "tool_use", tool_name });
  assert.equal(untrustedOf([call("read"), call("write"), call("edit"), call("ask_person"), call("learn"), { kind: "text_block", tool_name: null }]), false);
  assert.equal(untrustedOf([call("read"), call("fetch_page")]), true, "a page from the web");
  assert.equal(untrustedOf([call("snapshot")]), true, "a tool this host does not know is counted as untrusted, never as safe");
});
