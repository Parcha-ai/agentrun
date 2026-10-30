// Learning: an agent with `learning` on has one bare git repository beside the store, whose main the host keeps in step
// with the agent's current revision. Each run starts from main's notes at one commit, journaled in its own store, and
// leaves `runs/<run id>` with the host's memo. Real repositories in temp dirs; the faux model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { renderLearning } from "@parcha/pi-agent-learn";
import { local, openRepo } from "@parcha/pi-git-remote";
import { startServe } from "../dist/index.js";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { catchUp, externalUsed, isExternal, openAgentRepo, outcomeOf, readRunState, withAgentRepo } from "../dist/learning.js";
// Imported per call, so a module without them fails each test that uses them by name.
const learningModule = () => import("../dist/learning.js");
import { agent as offAgent, client, FAUX, flowAgent, follow, scratch, serve, storeRun, withEnv } from "./support.mjs";

/** An agentic agent `id` whose definition leaves learning out, as a new agent's usually does, unless `extra` sets it. */
const agent = (id, extra = {}) => {
  const made = offAgent(id, extra);
  if (!("learning" in extra)) delete made.definition.learning;
  return made;
};

const RATE_LIMIT = "The state registry rate-limits at 1 request a second.";
/** Where the faux model writes its note on it, in the run's working copy and so on the run's branch. */
const RATE_NOTE = "learnings/L-5ca1ab1e0001.md";
// Imported per call, so a module without it fails each test that uses it by name.
const harvestFor = async (...args) => (await import("../dist/learning.js")).harvestFor(...args);
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
function storeRevision(data, id) {
  const reader = openStoreReader(data);
  try {
    return reader.readRevision(id);
  } finally {
    reader.close();
  }
}
/** The run's learning state once the server has proposed it after the carry back. */
async function stateOf(data, agentId, runId, deadlineMs = 20_000) {
  for (const end = Date.now() + deadlineMs; ; await sleep(50)) {
    const state = await readRunState(data, agentId, runId);
    if (state) return state;
    assert.ok(Date.now() < end, `the run ${runId} was proposed`);
  }
}

test("a new agentic agent learns (auto, stored), an edit without the field keeps it, null turns it off, and only an agentic agent learns", async (t) => {
  const { api, data } = await serve(t);
  const a = await api("POST", "/agents", agent("a"));
  assert.equal(a.body.definition.learning, "auto", "a new agent learns by default");
  assert.equal(storeRevision(data, a.body.revision).body.learning, "auto", "and the revision stores it");
  assert.equal((await api("POST", "/agents", agent("b", { learning: null }))).body.definition.learning, undefined, "off is the field's absence, as for model");
  assert.equal((await api("POST", "/agents", agent("c", { learning: "approve" }))).body.definition.learning, "approve");
  const edited = await api("PUT", "/agents/c/definition", { definition: { instructions: "Answer briefly.", skills: [], tools: [] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.definition.learning, "approve", "an edit that leaves learning out keeps the current revision's");
  const off = await api("PUT", "/agents/c/definition", { definition: { instructions: "Answer briefly.", skills: [], tools: [], learning: null } });
  assert.equal(off.body.definition.learning, undefined, "learning: null turns it off");
  assert.equal("learning" in storeRevision(data, off.body.revision).body, false);
  const kept = await api("PUT", "/agents/c/definition", { definition: { instructions: "Answer.", skills: [], tools: [] } });
  assert.equal(kept.body.definition.learning, undefined, "and an edit after that keeps it off");
  const wrong = await api("POST", "/agents", agent("d", { learning: "always" }));
  assert.deepEqual([wrong.status, wrong.body.error.fields[0].field, wrong.body.error.fields[0].reason], [422, "definition.learning", "not_an_option"]);
  const flow = await api("POST", "/agents", flowAgent("e", undefined, { learning: "auto" }));
  assert.deepEqual([flow.status, flow.body.error.fields[0].field, flow.body.error.fields[0].reason], [422, "definition.learning", "not_an_option"], "a workflow agent does not learn");
  const plain = await api("POST", "/agents", flowAgent("f"));
  assert.equal(plain.status, 201);
  assert.equal(plain.body.definition.learning, undefined, "a workflow definition has no learning field");
  assert.equal(existsSync(bareOf(data, "f")), false);
});

test("learn is no tool: on a learning revision it is an accepted name that binds nothing, off one it is refused; a learning run has the file tools and writes its notes with them", async (t) => {
  const { api, data } = await serve(t);
  const refused = await api("POST", "/agents", agent("named-off", { learning: null, tools: ["read", "learn"] }));
  assert.deepEqual([refused.status, refused.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.tools[1]", "not_an_option"]]]);
  // A learning revision that names learn, as one could before: it saves, runs, and gets read, write and edit.
  const named = await api("POST", "/agents", agent("calc", { tools: ["read", "learn"] }));
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.deepEqual(named.body.warnings, []);
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  assert.equal((await stateOf(data, "calc", run.run_id)).state, "proposed");
  assert.match(show(bareOf(data, "calc"), `runs/${run.run_id}`, RATE_NOTE), /rate-limits/, "written with the write tool learning gives it");
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
  await api("POST", "/agents", agent("quiet", { learning: null }));
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
  // Its working copy of the repository is main at that commit; the host's own git directory stays out of its reach.
  assert.equal(await readFile(join(work, ".agent", "repo", "learnings", "L-0123456789ab.md"), "utf8"), renderLearning(lesson("L-0123456789ab", "Search both forms of the legal name.")));
  assert.equal(await readFile(join(work, ".agent", "repo", "AGENTS.md"), "utf8"), "Answer.\n");
  assert.equal(existsSync(join(work, ".agent", "repo", ".git")), false);
  const bare = bareOf(data, "calc");
  const branch = `runs/${run.run_id}`;
  const state = await stateOf(data, "calc", run.run_id);
  assert.deepEqual(state, { state: "proposed", branch, base, sha: tip(bare, branch) }, "the server records what it proposed");
  assert.ok(branches(bare).includes(branch), `the run leaves ${branch}`);
  assert.equal(git(bare, "merge-base", branch, "main"), base, "the branch starts from the commit the run was seeded from");
  const memo = front(show(bare, branch, `memos/${run.run_id}.md`));
  assert.deepEqual({ ...memo, cost_usd: undefined }, { run: run.run_id, base, harness: "pi", outcome: "completed", untrusted: "false", cost_usd: undefined });
  assert.ok(Number.isFinite(Number(memo.cost_usd)), "the memo says what the run cost");
  assert.match(show(bare, branch, RATE_NOTE), /rate-limits at 1 request a second/, "the note the run wrote with its own write tool");
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
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !/AGENTRUN_API_KEY=/.test(out); i++) {
    assert.ok(i < 200, `the server did not start: ${out}`);
    await sleep(50);
  }
  const value = (name) => new RegExp(`${name}=(\\S+)`).exec(out)[1];
  return { child, api: client(value("AGENTRUN_BASE_URL"), value("AGENTRUN_API_KEY")), stderr: () => err };
}
// A process that has exited is not alive though it is a zombie, as one stays under a PID 1 that does not reap.
const alive = (pid) => processAlive(pid);
/** A process's start ticks, as pi-durable-disk records its holder's (field 22 of /proc/<pid>/stat). */
const startTicks = (pid) => {
  const stat = execFileSync("cat", [`/proc/${pid}/stat`], { encoding: "utf8" });
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
};

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
  for (let i = 0; !(await first.api("GET", `/runs/${run.run_id}/timeline`)).body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "write"); i++) {
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
  await stateOf(data, "calc", run.run_id);
  assert.equal(front(show(bare, `runs/${run.run_id}`, `memos/${run.run_id}.md`)).base, base, "the base is the commit the run was first seeded from");
  assert.equal(git(bare, "merge-base", `runs/${run.run_id}`, "main"), base);
  assert.equal(existsSync(join(data, "runs", run.run_id, "work", ".agent", "learnings", "L-ba9876543210.md")), false, "a note main gained later is not the run's");
});

test("a run that called a tool reaching outside it is untrusted on its memo", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Fetch the page, then learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  await stateOf(data, "calc", run.run_id);
  assert.equal(front(show(bareOf(data, "calc"), `runs/${run.run_id}`, `memos/${run.run_id}.md`)).untrusted, "true");
});

test("a run whose end its server never carried back is proposed once by the next server: one branch, one commit, no error", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const first = await serverProcess(data);
  t.after(() => first.child.kill("SIGKILL"));
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  const gate = join(dir, "go");
  const { body: run } = await first.api("POST", "/agents/calc/runs", { input: { content: `Learn the rate limit, then answer once ${gate} exists.` } });
  for (let i = 0; !(await first.api("GET", `/runs/${run.run_id}/timeline`)).body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "write"); i++) {
    assert.ok(i < 400, "the run notes its lesson");
    await sleep(50);
  }
  // The server dies; the run answers with no server to let it go, then its process is stopped the way a server stops it.
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { pid } = JSON.parse(await readFile(join(data, "runs", run.run_id, "run.json"), "utf8")).holder;
  t.after(() => alive(pid) && process.kill(pid, "SIGKILL"));
  await writeFile(gate, "");
  // The faux model says it saw the gate; SIGTERM then drains the turn, so the answer lands before the process lets go.
  for (let i = 0; !existsSync(`${gate}.seen`); i++) {
    assert.ok(i < 400, "the run sees its gate");
    await sleep(50);
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, "the run's process exits on SIGTERM");
    await sleep(50);
  }
  assert.equal(storeRun(data, run.run_id).state, "running", "nobody carried it back yet");
  assert.equal(await readRunState(data, "calc", run.run_id), undefined, "nor proposed it");
  // The next server carries it back (and so proposes it) while its start-time catch-up walks the runs.
  const next = await serverProcess(data);
  t.after(() => next.child.kill("SIGKILL"));
  const state = await stateOf(data, "calc", run.run_id);
  assert.equal(storeRun(data, run.run_id).state, "completed");
  // A server stopped by SIGTERM closes: it waits for its start-time catch-up and for what runs after each carry back.
  next.child.kill("SIGTERM");
  await new Promise((resolve) => next.child.once("exit", resolve));
  const bare = bareOf(data, "calc");
  assert.deepEqual(branches(bare).filter((b) => b.startsWith("runs/")), [`runs/${run.run_id}`]);
  assert.equal(git(bare, "log", "--format=%H", `main..runs/${run.run_id}`), state.sha, "one commit on the run's branch");
  assert.deepEqual({ ...(await readRunState(data, "calc", run.run_id)) }, { state: "proposed", branch: `runs/${run.run_id}`, base: state.base, sha: state.sha });
  assert.doesNotMatch(next.stderr(), /not proposed|after its carry back|catch-up/, "no error line");
});

test("a proposal and the start-time catch-up of the same run at once make one commit and no error", async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closing;
  const close = () => (closing ??= server.close());
  t.after(close);
  const api = client(server.baseUrl, server.token);
  await api("POST", "/agents", agent("calc"));
  const bare = bareOf(data, "calc");
  // A run whose proposal failed: it ended, and nothing is recorded for it.
  await chmod(join(bare, "refs", "heads"), 0o555);
  t.after(() => chmod(join(bare, "refs", "heads"), 0o755).catch(() => undefined));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  // Closing waits for the failed proposal; the race below needs no server.
  await close();
  await chmod(join(bare, "refs", "heads"), 0o755);
  assert.equal(await readRunState(data, "calc", run.run_id), undefined);
  const store = openStoreReader(data);
  t.after(() => store.close());
  const reader = { store, request: async (act) => act() };
  const errors = [];
  const [direct, caught] = await Promise.all([harvestFor(data, reader, run.run_id), catchUp(data, reader, (line) => errors.push(line))]);
  assert.deepEqual(errors, []);
  assert.deepEqual(caught, [run.run_id], "the catch-up read no record either, and proposed it too");
  const state = await readRunState(data, "calc", run.run_id);
  assert.equal(state.state, "proposed");
  // The queue ran the two one after the other: whichever came second found the Run-Id and answered already.
  assert.ok(["proposed", "already"].includes(direct.status), direct.status);
  assert.equal(direct.sha, state.sha);
  assert.equal(git(bare, "log", "--format=%H", `main..runs/${run.run_id}`), state.sha, "one commit on the run's branch");
});

test("a writer holding the agent store makes the start-time catch-up and a proposal wait, and neither fails", async (t) => {
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closing;
  const close = () => (closing ??= server.close());
  t.after(close);
  const api = client(server.baseUrl, server.token);
  await api("POST", "/agents", agent("calc"));
  const bare = bareOf(data, "calc");
  // A run whose proposal failed: it ended, and nothing is recorded for it.
  await chmod(join(bare, "refs", "heads"), 0o555);
  t.after(() => chmod(join(bare, "refs", "heads"), 0o755).catch(() => undefined));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  await close();
  await chmod(join(bare, "refs", "heads"), 0o755);
  const [{ Agents, whenFree }, { DatabaseSync }] = await Promise.all([import("../dist/agents.js"), import("node:sqlite")]);
  const agents = new Agents(data);
  t.after(() => agents.close());
  /** Another writer takes the store's write lock; `release` lets it go once. */
  const hold = () => {
    const lock = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
    lock.exec("BEGIN EXCLUSIVE");
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      lock.exec("COMMIT");
      lock.close();
    };
    t.after(release);
    return release;
  };
  // The catch-up meets the held store, says it is busy, and goes on once the writer lets go: here, when it says so.
  let release = hold();
  const lines = [];
  const caught = await catchUp(data, agents, (line) => (lines.push(line), /busy/.test(line) && release()));
  assert.deepEqual(caught, [run.run_id], "the catch-up proposed the run once the store was free");
  assert.ok(lines.some((line) => /busy/.test(line)), `it waited for the writer: ${JSON.stringify(lines)}`);
  assert.deepEqual(lines.filter((line) => !/busy/.test(line)), [], "and logged nothing else");
  const state = await readRunState(data, "calc", run.run_id);
  assert.equal(state.state, "proposed");
  // A proposal reads the store through its caller's request, which waits for the writer the same way.
  release = hold();
  const waited = { request: (act) => whenFree(act, [10, 10, 10, 10, 10], () => release()) };
  const again = await harvestFor(data, { store: agents.store, request: waited.request }, run.run_id);
  assert.deepEqual([again.status, again.sha], ["already", state.sha]);
  assert.equal(git(bare, "log", "--format=%H", `main..runs/${run.run_id}`), state.sha, "one commit on the run's branch");
});

/** What the server process writes to stderr during test `t`: its warnings, the after-carry-back hook's among them. */
function stderrOf(t) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => (process.stderr.write = write));
  return lines;
}

/** Another connection holding store.sqlite with `BEGIN IMMEDIATE`: no other writer, readers still read. */
async function holdWrites(t, data) {
  const { DatabaseSync } = await import("node:sqlite");
  const lock = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  lock.exec("BEGIN IMMEDIATE");
  const release = () => lock.isOpen && (lock.isTransaction && lock.exec("ROLLBACK"), lock.close());
  t.after(release);
  return release;
}

/** A learning run that notes its lesson, then answers once its gate exists; its end is due when the gate is made. */
async function gatedLearner(t, api) {
  await api("POST", "/agents", agent("calc"));
  const gate = join(await scratch(t), "go");
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: `Learn the rate limit, then answer once ${gate} exists.` } });
  for (let i = 0; !(await api("GET", `/runs/${run.run_id}/timeline`)).body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "write"); i++) {
    assert.ok(i < 400, "the run notes its lesson");
    await sleep(50);
  }
  return { runId: run.run_id, open: () => writeFile(gate, "") };
}

test("a run whose end the store refuses at first is proposed once the end lands later, exactly once, and not before", async (t) => {
  const said = stderrOf(t);
  let refused;
  const endRefused = new Promise((resolve) => (refused = resolve));
  // One retry, then the end waits for the server's later settle.
  const { api, data } = await serve(t, { carryBackRetry: { delaysMs: [20], onBusy: (_id, attempt) => attempt === 1 && refused() }, settleRetryMs: 300 });
  const { runId, open } = await gatedLearner(t, api);
  const release = await holdWrites(t, data);
  await open();
  await endRefused;
  const bare = bareOf(data, "calc");
  assert.equal(storeRun(data, runId).state, "running", "the store has not got the run's end");
  assert.equal(await readRunState(data, "calc", runId), undefined, "nothing is proposed before the end lands");
  assert.equal(branches(bare).includes(`runs/${runId}`), false);
  release();
  const state = await stateOf(data, "calc", runId);
  assert.equal(storeRun(data, runId).state, "completed");
  assert.equal(state.state, "proposed");
  assert.equal(git(bare, "log", "--format=%H", `main..runs/${runId}`), state.sha, "one commit on the run's branch");
  assert.deepEqual(said.filter((line) => line.includes(runId) && /after its carry back|not proposed/.test(line)), [], "the hook ran once, after the end was written");
});

test("a server that stops while a run's end waits to be written proposes nothing; the next start writes the end and proposes it once", async (t) => {
  const data = join(await scratch(t), "agents");
  let refused;
  const endRefused = new Promise((resolve) => (refused = resolve));
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", carryBackRetry: { delaysMs: [20], onBusy: (_id, attempt) => attempt === 1 && refused() }, settleRetryMs: 300 });
  let closing;
  const close = () => (closing ??= first.close());
  t.after(close);
  const { runId, open } = await gatedLearner(t, client(first.baseUrl, first.token));
  const release = await holdWrites(t, data);
  await open();
  await endRefused;
  await close();
  release();
  assert.equal(storeRun(data, runId).state, "running", "the stopped server never wrote the end");
  assert.equal(await readRunState(data, "calc", runId), undefined, "nor proposed the run");
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closingNext;
  const closeNext = () => (closingNext ??= next.close());
  t.after(closeNext);
  const state = await stateOf(data, "calc", runId);
  await closeNext();
  assert.equal(storeRun(data, runId).state, "completed");
  assert.equal(state.state, "proposed");
  assert.equal(git(bareOf(data, "calc"), "log", "--format=%H", `main..runs/${runId}`), state.sha, "one commit on the run's branch");
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const offThere = (harness) => `learning runs on pi; this agent runs on ${harness}`;

test("learning runs on pi only: a definition that asks for learning on another harness is refused at save by name, on a new agent and an edit; the same on pi saves", async (t) => {
  const { api } = await serve(t);
  for (const [harness, learning] of [["claude-agent", "approve"], ["claude-agent", "auto"], ["codex", "auto"]]) {
    const refused = await api("POST", "/agents", agent(`both-${harness}-${learning}`, { harness, learning }));
    assert.deepEqual([refused.status, refused.body.error?.fields?.map((f) => [f.field, f.reason, f.message])], [422, [["definition.learning", "not_an_option", `learning runs on pi; ${harness} runs without it. Set definition.learning to null, or use pi.`]]], `${harness} ${learning}`);
  }
  assert.equal((await api("POST", "/agents", agent("claude", { harness: "claude-agent" }))).status, 201);
  const asked = await api("PUT", "/agents/claude/definition", { definition: { instructions: "Answer.", skills: [], tools: [], learning: "approve" } });
  assert.deepEqual([asked.status, asked.body.error?.fields?.map((f) => f.field)], [422, ["definition.learning"]], "an edit that asks for learning on the agent's harness is refused");
  const pi = await api("POST", "/agents", agent("both-pi", { learning: "approve" }));
  assert.deepEqual([pi.status, pi.body.definition.learning, pi.body.learning_effective, pi.body.learning_reason], [201, "approve", "approve", null]);
});

test("another harness with learning left out saves, keeps the stated value, and reads off with why; it runs, without learning", async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const made = await api("POST", "/agents", agent("coder", { harness: "codex" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.definition.learning, made.body.learning_effective, made.body.learning_reason], ["auto", "off", offThere("codex")]);
  assert.equal(storeRevision(data, made.body.revision).body.learning, "auto", "the stored value is the default, never a written off");
  assert.equal(existsSync(bareOf(data, "coder")), false, "no learning repository");
  const edited = await api("PUT", "/agents/coder/definition", { definition: { instructions: "Answer briefly.", skills: [], tools: [] } });
  assert.deepEqual([edited.status, edited.body.definition.learning, edited.body.learning_effective], [200, "auto", "off"], "an edit that leaves it out is never refused");
  // A revision stored with learning on another harness runs as it did, without learning.
  const run = await api("POST", "/agents/coder/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
  await sleep(200);
  assert.equal(await readRunState(data, "coder", run.body.run_id), undefined, "nothing harvested");
  assert.equal(existsSync(bareOf(data, "coder")), false);
  const { learningOf } = await learningModule();
  assert.equal(learningOf(storeRevision(data, edited.body.revision)), "off");
});

test("an agent made on another harness with learning left out, then edited to pi without restating it, learns: the kept value runs there", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("mover", { harness: "codex" }))).status, 201);
  const moved = await api("PUT", "/agents/mover/definition", { definition: { instructions: "Answer.", skills: [], tools: [], harness: "pi" } });
  assert.deepEqual([moved.status, moved.body.definition.harness, moved.body.definition.learning, moved.body.learning_effective, moved.body.learning_reason], [200, "pi", "auto", "auto", null]);
  const { body: run } = await api("POST", "/agents/mover/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  assert.equal((await stateOf(data, "mover", run.run_id)).state, "proposed", "a learning run: its note is proposed");
  assert.match(show(bareOf(data, "mover"), `runs/${run.run_id}`, RATE_NOTE), /rate-limits/);
});

test("learning_effective and learning_reason are read only: the agent and revision views show them and meet the served document, and a request that carries them is refused by field", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const { schemaProblems } = await import("./schema-support.mjs");
  const agentSchema = { $ref: "#/components/schemas/Agent" };
  // The document adds exactly the two, response side only, marked learning/2; the definition takes neither.
  assert.deepEqual(doc.info["x-agentrun-serve"].fields.filter((field) => field.includes("learning_")).sort(), ["Agent.learning_effective", "Agent.learning_reason"]);
  for (const field of ["learning_effective", "learning_reason"]) {
    assert.equal(doc.components.schemas.Agent.properties[field]["x-agentrun-serve"], "learning/2");
    assert.equal(doc.components.schemas.DefinitionInput.properties[field], undefined);
  }
  const revisionsSchema = doc.paths["/agents/{agent_id}/revisions"].get.responses["200"].content["application/json"].schema;
  for (const [id, extra, view] of [["on-codex", { harness: "codex" }, ["auto", "off", offThere("codex")]], ["on-pi", {}, ["auto", "auto", null]]]) {
    const made = (await api("POST", "/agents", agent(id, extra))).body;
    const { warnings: _, ...read } = (await api("GET", `/agents/${id}`)).body;
    assert.deepEqual([read.definition.learning, read.learning_effective, read.learning_reason], view, id);
    assert.deepEqual(schemaProblems(doc, agentSchema, read), [], JSON.stringify(read));
    const revisions = (await api("GET", `/agents/${id}/revisions`)).body;
    assert.deepEqual([revisions.revisions[0].learning_effective, revisions.revisions[0].learning_reason], view.slice(1), id);
    assert.deepEqual(schemaProblems(doc, revisionsSchema, revisions), [], JSON.stringify(revisions));
    assert.equal(made.learning_effective, view[1]);
  }
  // The positive control: the same check sees a value the document does not hold.
  assert.notDeepEqual(schemaProblems(doc, agentSchema, { ...(await api("GET", "/agents/on-pi")).body, learning_effective: "sometimes" }), []);
  const top = await api("POST", "/agents", { ...agent("given"), learning_effective: "off", learning_reason: "chosen" });
  assert.deepEqual([top.status, top.body.error.fields.map((f) => [f.field, f.reason])], [422, [["learning_effective", "not_allowed"], ["learning_reason", "not_allowed"]]]);
  const inside = await api("PUT", "/agents/on-pi/definition", { definition: { instructions: "Answer.", skills: [], tools: [], learning_effective: "off" } });
  assert.deepEqual([inside.status, inside.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.learning_effective", "not_allowed"]]]);
});

test("a cancelled run's memo says it stopped", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const gate = join(await scratch(t), "never");
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: `Learn the rate limit, then answer once ${gate} exists.` } });
  const bare = bareOf(data, "calc");
  for (let i = 0; !(await api("GET", `/runs/${run.run_id}/timeline`)).body.rows.some((r) => r.kind === "tool_result" && r.tool_name === "write"); i++) {
    assert.ok(i < 400, "the run notes its lesson");
    await sleep(50);
  }
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  await follow(api, run.run_id, ["cancelled"]);
  await stateOf(data, "calc", run.run_id);
  assert.ok(existsSync(bare) && branches(bare).includes(`runs/${run.run_id}`), "the cancelled run left its branch");
  assert.equal(front(show(bare, `runs/${run.run_id}`, `memos/${run.run_id}.md`)).outcome, "stopped");
  assert.equal(storeRun(data, run.run_id).state, "stopped");
});

test("the server proposes once the run's end is written, so the memo carries the carried-back cost; proposing again makes no second commit", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  const { sha } = await stateOf(data, "calc", run.run_id);
  const bare = bareOf(data, "calc");
  const branch = `runs/${run.run_id}`;
  const ended = storeRun(data, run.run_id);
  assert.equal(ended.state, "completed");
  assert.equal(Number(front(show(bare, branch, `memos/${run.run_id}.md`)).cost_usd), ended.costUsd, "the cost the carry back wrote");
  const store = openStoreReader(data);
  t.after(() => store.close());
  const again = await harvestFor(data, { store, request: async (act) => act() }, run.run_id);
  assert.deepEqual([again.status, again.sha], ["already", sha]);
  assert.equal(tip(bare, branch), sha);
  assert.equal(git(bare, "log", "--format=%H", `main..${branch}`), sha, "one commit for the run");
});

test("a push that fails ends the run as it would have; the next start proposes it, once, and a start after that proposes nothing", async (t) => {
  const data = join(await scratch(t), "agents");
  const once = (server) => {
    let closing;
    const close = () => (closing ??= server.close());
    t.after(close);
    return close;
  };
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const closeFirst = once(first);
  let api = client(first.baseUrl, first.token);
  await api("POST", "/agents", agent("calc"));
  const bare = bareOf(data, "calc");
  // No new ref can be written in the repository: the run's push fails.
  await chmod(join(bare, "refs", "heads"), 0o555);
  t.after(() => chmod(join(bare, "refs", "heads"), 0o755).catch(() => undefined));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  const { last } = await follow(api, run.run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.equal(storeRun(data, run.run_id).state, "completed", "the run ends completed");
  // Closing waits for what runs after the carry back: the failed proposal is over once it returns.
  await closeFirst();
  assert.equal(await readRunState(data, "calc", run.run_id), undefined, "nothing was proposed");
  assert.equal(branches(bare).includes(`runs/${run.run_id}`), false);
  await chmod(join(bare, "refs", "heads"), 0o755);
  const stateFile = join(bare, "..", "learning", "runs", `${run.run_id}.json`);
  let written;
  for (let start = 0; start < 2; start++) {
    const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
    const closeNext = once(next);
    api = client(next.baseUrl, next.token);
    const state = await stateOf(data, "calc", run.run_id);
    assert.equal(state.state, "proposed");
    await closeNext();
    const at = (await stat(stateFile)).mtimeMs;
    if (start === 1) assert.equal(at, written, "a run with a recorded proposal is not proposed again");
    written = at;
    assert.equal(git(bare, "log", "--format=%H", `main..runs/${run.run_id}`), state.sha, `one commit for the run after start ${start + 1}`);
    assert.equal(git(bare, "log", "--format=%(trailers:key=Run-Id,valueonly)", `runs/${run.run_id}`, "-1"), run.run_id);
  }
});

test("every write to an agent's repository waits its turn: host commits and a curator's commits at once all land on main", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const curator = join(await scratch(t), "curator");
  const notes = [0, 1, 2].map((i) => lesson(`L-00000000000${i}`, `Note ${i}.`));
  const curate = (l) => withAgentRepo(data, "calc", async () => {
    const repo = await openAgentRepo(data, "calc", curator);
    const made = await repo.commitTo("main", { files: note(l), message: `curator: ${l.id}` });
    await repo.push(made.sha, "main");
  });
  const edits = ["One.", "Two.", "Three.", "Four."].map((instructions) => api("PUT", "/agents/calc/definition", { definition: { instructions, skills: [], tools: [] } }));
  const results = await Promise.allSettled([...edits, ...notes.map(curate)]);
  assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message), [], "no writer failed");
  const bare = bareOf(data, "calc");
  for (const l of notes) assert.match(show(bare, "main", `learnings/${l.id}.md`), new RegExp(`Note ${l.id.at(-1)}`), `${l.id} is on main`);
  const current = (await api("GET", "/agents/calc")).body;
  assert.equal(show(bare, "main", "AGENTS.md"), current.definition.instructions, "main holds the current revision");
  assert.equal(git(bare, "rev-list", "--merges", "--count", "main"), "0");
});

test("on a host without git 2.40 a new agent does not learn, one that asks to saves with a warning, and its run is refused", async (t) => {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\necho 'git version 2.39.5'\n");
  await chmod(join(bin, "git"), 0o755);
  withEnv(t, { PATH: `${bin}:${process.env.PATH}` });
  const { api, data } = await serve(t);
  const plain = await api("POST", "/agents", agent("plain"));
  assert.equal(plain.status, 201);
  assert.equal(plain.body.definition.learning, undefined, "a new agent learns only where it can");
  assert.deepEqual(plain.body.warnings, []);
  const asked = await api("POST", "/agents", agent("asked", { learning: "auto" }));
  assert.equal(asked.status, 201);
  assert.deepEqual(asked.body.warnings.map((w) => [w.field, w.reason]), [["definition.learning", "not_set_up_here"]]);
  assert.match(asked.body.warnings[0].message, /git 2\.40/);
  const run = await api("POST", "/agents/asked/runs", { input: { content: "Hello." } });
  assert.equal(run.status, 409);
  assert.equal(run.body.error.code, "agent_not_runnable");
  assert.equal(existsSync(join(data, "agents", "asked")), false);
  const ran = await api("POST", "/agents/plain/runs", { input: { content: "Hello." } });
  assert.equal(ran.status, 202, "an agent that does not learn runs as before");
});

test("a run is untrusted when any message of any entry in its store calls an external tool", async (t) => {
  const file = join(await scratch(t), "run.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
  const put = (record) => db.prepare("INSERT INTO entries (record) VALUES (?)").run(JSON.stringify(record));
  const call = (name) => ({ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "toolCall", id: `c-${name}`, name, arguments: {} }] });
  put({ kind: "pi.user", model: [{ role: "user", content: "Go." }] });
  put({ kind: "pi.assistant", model: [call("read"), call("write")] });
  db.close();
  assert.equal(externalUsed(file), false, "the file tools bring nothing in");
  const planted = new DatabaseSync(file);
  // An external call in the entry's second message, not its first.
  planted.prepare("INSERT INTO entries (record) VALUES (?)").run(JSON.stringify({ kind: "pi.assistant", model: [call("read"), call("fetch_page")] }));
  planted.close();
  assert.equal(externalUsed(file), true, "a call in any message of the entry counts");
});

test("a run's outcome on its memo, and which tools bring outside content in", () => {
  assert.deepEqual(["completed", "failed", "escalated", "stopped"].map(outcomeOf), ["completed", "failed", "failed", "stopped"]);
  assert.deepEqual(["read", "write", "edit", "ask_person"].map(isExternal), [false, false, false, false]);
  assert.equal(isExternal("learn"), true, "learn is no tool here: a call by that name is unknown, so external");
  assert.equal(isExternal("fetch_page"), true, "a page from the web");
  assert.equal(isExternal("snapshot"), true, "a tool this host does not know is counted as external, never as safe");
});

test("a run whose process is still live is never harvested: its working copy is read only after the process has ended", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  const { sha } = await stateOf(data, "calc", run.run_id);
  // The run's record names a holder that is alive: a process (or, later, a box) still serving it.
  const { spawn } = await import("node:child_process");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  const recordFile = join(data, "runs", run.run_id, "run.json");
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  await writeFile(recordFile, JSON.stringify({ ...record, holder: { ...(record.holder ?? {}), pid: holder.pid, startTicks: startTicks(holder.pid) } }));
  const bare = bareOf(data, "calc");
  git(bare, "update-ref", "-d", `refs/heads/runs/${run.run_id}`);
  const store = openStoreReader(data);
  t.after(() => store.close());
  await assert.rejects(harvestFor(data, { store, request: async (act) => act() }, run.run_id), /still live/);
  assert.equal(branches(bare).includes(`runs/${run.run_id}`), false, "nothing was harvested");
  assert.deepEqual(await readRunState(data, "calc", run.run_id), { state: "waiting", reason: `the run ${run.run_id}'s process is still live, so its working copy is not harvested yet` }, "the run's learning says it waits, by name");
  const log = [];
  assert.deepEqual(await catchUp(data, { store, request: async (act) => act() }, (line) => log.push(line)), [], "a catch-up while it lives harvests nothing");
  assert.equal((await readRunState(data, "calc", run.run_id)).state, "waiting");
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  assert.deepEqual(await catchUp(data, { store, request: async (act) => act() }, (line) => log.push(line)), [run.run_id], "a waiting run is retried, never skipped as recorded");
  assert.deepEqual(await readRunState(data, "calc", run.run_id), { state: "proposed", branch: `runs/${run.run_id}`, base: (await stateOf(data, "calc", run.run_id)).base, sha }, "once it has ended, the same commit as before");
});

test("a crash between the harvest's commit and its push: the next harvest pushes the same commit once, read as already, and a fresh clone makes the same commit", async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closing;
  const close = () => (closing ??= first.close());
  t.after(close);
  const api = client(first.baseUrl, first.token);
  await api("POST", "/agents", agent("calc"));
  const bare = bareOf(data, "calc");
  // The push is refused: the commit is made in the host's clone and never reaches the repository, as a crash leaves it.
  await chmod(join(bare, "refs", "heads"), 0o555);
  t.after(() => chmod(join(bare, "refs", "heads"), 0o755).catch(() => undefined));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  await close();
  await chmod(join(bare, "refs", "heads"), 0o755);
  const hostClone = join(data, "agents", "calc", "host.git");
  const made = git(hostClone, "rev-parse", "--verify", "-q", `refs/heads/runs/${run.run_id}`);
  assert.ok(made, "the host's clone holds the commit");
  assert.equal(branches(bare).includes(`runs/${run.run_id}`), false, "and the repository does not");
  const store = openStoreReader(data);
  t.after(() => store.close());
  const reader = { store, request: async (act) => act() };
  const again = await harvestFor(data, reader, run.run_id);
  assert.deepEqual([again.status, again.sha], ["already", made], "the clone's commit is found by its Run-Id and pushed");
  assert.equal(git(bare, "log", "--format=%H", `main..runs/${run.run_id}`), made, "one commit on the run's branch");
  // A host with none of that (a fresh clone): the same files, the same date, the same commit.
  const { rm } = await import("node:fs/promises");
  await rm(hostClone, { recursive: true, force: true });
  git(bare, "update-ref", "-d", `refs/heads/runs/${run.run_id}`);
  const fresh = await harvestFor(data, reader, run.run_id);
  assert.deepEqual([fresh.status, fresh.sha], ["proposed", made]);
});

test("a run that reached its seed and has no working copy is an error, never an empty run: nothing is recorded, so a later harvest still can", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  await stateOf(data, "calc", run.run_id);
  const { rm } = await import("node:fs/promises");
  await rm(join(data, "runs", run.run_id, "work", ".agent", "repo"), { recursive: true, force: true });
  await rm(join(data, "agents", "calc", "learning", "runs", `${run.run_id}.json`));
  git(bareOf(data, "calc"), "update-ref", "-d", `refs/heads/runs/${run.run_id}`);
  const store = openStoreReader(data);
  t.after(() => store.close());
  await assert.rejects(harvestFor(data, { store, request: async (act) => act() }, run.run_id), /no working copy/);
  assert.equal(await readRunState(data, "calc", run.run_id), undefined);
});

test("a run that ended before working copies existed is recorded once, as empty with its reason, and the next catch-up skips it", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  await stateOf(data, "calc", run.run_id);
  // As a run from before this change left it: seeded, with no working copy and no mark that one was laid out.
  const { rm } = await import("node:fs/promises");
  await rm(join(data, "runs", run.run_id, "work", ".agent", "repo"), { recursive: true, force: true });
  await rm(join(data, "runs", run.run_id, "learning.copy"), { force: true });
  await rm(join(data, "agents", "calc", "learning", "runs", `${run.run_id}.json`));
  const store = openStoreReader(data);
  t.after(() => store.close());
  const reader = { store, request: async (act) => act() };
  const lines = [];
  assert.deepEqual(await catchUp(data, reader, (line) => lines.push(line)), [run.run_id]);
  assert.deepEqual(await readRunState(data, "calc", run.run_id), { state: "empty", reason: "the run ended before working copies" });
  assert.deepEqual(lines, []);
  assert.deepEqual(await catchUp(data, reader, (line) => lines.push(line)), [], "the next catch-up skips it");
  assert.deepEqual(lines, []);
});

test("an ended run with no recorded end time is harvested once, dated its start, never retried for ever", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  await stateOf(data, "calc", run.run_id);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(data, "store.sqlite"));
  db.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(run.run_id);
  const started = db.prepare("SELECT started_at FROM runs WHERE id = ?").get(run.run_id).started_at;
  db.close();
  const { rm } = await import("node:fs/promises");
  await rm(join(data, "agents", "calc", "learning", "runs", `${run.run_id}.json`));
  const bare = bareOf(data, "calc");
  git(bare, "update-ref", "-d", `refs/heads/runs/${run.run_id}`);
  await rm(join(data, "agents", "calc", "host.git"), { recursive: true, force: true });
  const store = openStoreReader(data);
  t.after(() => store.close());
  const lines = [];
  assert.deepEqual(await catchUp(data, { store, request: async (act) => act() }, (line) => lines.push(line)), [run.run_id]);
  assert.deepEqual(lines, []);
  assert.equal((await readRunState(data, "calc", run.run_id)).state, "proposed");
  assert.equal(new Date(git(bare, "log", "-1", "--format=%cI", `runs/${run.run_id}`)).getTime(), Math.floor(Date.parse(started) / 1000) * 1000);
});

/** The faux model's answer to "Make these calls: ...": what each call returned. */
async function calls(api, agentId, list) {
  const { body: run } = await api("POST", `/agents/${agentId}/runs`, { input: { content: `Make these calls: ${JSON.stringify(list)}` } });
  await follow(api, run.run_id, ["completed"]);
  return { runId: run.run_id, outcomes: JSON.parse((await api("GET", `/runs/${run.run_id}`)).body.result.final_answer) };
}

test("learning never widens a revision's tools: a tool learning adds works on the working copy only, and is refused by name anywhere else", async (t) => {
  const { api, data } = await serve(t);
  const skill = { "cite/SKILL.md": "Cite the source." };
  assert.equal((await api("POST", "/agents", { ...agent("reader", { tools: ["read"], skills: ["cite"] }), skills: skill })).status, 201);
  const note = ".agent/repo/learnings/L-5ca1ab1e0002.md";
  const { runId, outcomes } = await calls(api, "reader", [
    ["write", { path: note, content: "---\nid: L-5ca1ab1e0002\ntype: lesson\nstatus: active\nruns: []\nsupersedes: []\n---\nCite twice.\n" }],
    ["write", { path: "input.txt", content: "changed" }],
    ["read", { path: ".agents/skills/cite/SKILL.md" }],
  ]);
  assert.equal(outcomes[0].isError, false, JSON.stringify(outcomes[0]));
  assert.deepEqual([outcomes[1].isError, outcomes[1].text], [true, "write is the learning copy's only here: input.txt is outside .agent/repo"]);
  assert.equal(existsSync(join(data, "runs", runId, "work", "input.txt")), false, "nothing was written");
  assert.deepEqual([outcomes[2].isError, outcomes[2].text.includes("Cite the source.")], [false, true], "read was named: it keeps its scope");
  await stateOf(data, "reader", runId);
  assert.match(show(bareOf(data, "reader"), `runs/${runId}`, "learnings/L-5ca1ab1e0002.md"), /Cite twice/);
  // A revision that names no tool: even read is the learning copy's only.
  assert.equal((await api("POST", "/agents", { ...agent("plain", { skills: ["cite"] }), skills: skill })).status, 201);
  const plain = await calls(api, "plain", [["read", { path: ".agents/skills/cite/SKILL.md" }], ["read", { path: ".agent/repo/AGENTS.md" }]]);
  assert.deepEqual([plain.outcomes[0].isError, plain.outcomes[0].text], [true, "read is the learning copy's only here: .agents/skills/cite/SKILL.md is outside .agent/repo and .agent/learnings"]);
  assert.deepEqual([plain.outcomes[1].isError, plain.outcomes[1].text.includes("Answer.")], [false, true]);
});

test("a tool learning adds never follows a link out of the working copy", async (t) => {
  const { copyRefusal } = await learningModule();
  const { symlink } = await import("node:fs/promises");
  const work = await scratch(t);
  await mkdir(join(work, ".agent", "repo", "learnings"), { recursive: true });
  await symlink(work, join(work, ".agent", "repo", "out"));
  assert.equal(await copyRefusal(work, "write", ".agent/repo/learnings/L-x.md"), undefined);
  assert.equal(await copyRefusal(work, "write", join(work, ".agent/repo/learnings/new/L-x.md")), undefined, "a path not made yet, inside the copy");
  assert.equal(await copyRefusal(work, "write", ".agent/repo/out/input.txt"), "write is the learning copy's only here: .agent/repo/out/input.txt is outside .agent/repo");
  assert.equal(await copyRefusal(work, "edit", ".agent/repo/../input.txt"), "edit is the learning copy's only here: .agent/repo/../input.txt is outside .agent/repo");
});

test("a round that holds a tool learning adds runs its calls one at a time: the next call starts only once the added one has returned", async (t) => {
  const { onCopyOnly } = await learningModule();
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } = await import("@earendil-works/pi-durable");
  const work = await scratch(t);
  await mkdir(join(work, ".agent", "repo"), { recursive: true });
  const events = [];
  let probeStarted;
  const probing = new Promise((resolve) => (probeStarted = resolve));
  const tool = (name) =>
    defineTool({
      name, description: name, parameters: { type: "object", properties: {}, additionalProperties: true },
      execute: async () => {
        events.push(`${name} started`);
        if (name === "probe") probeStarted();
        // The added write holds until the probe starts, or a second passes: run at once, the probe starts inside it.
        else await Promise.race([probing, sleep(1_000)]);
        events.push(`${name} returned`);
        return { content: [{ type: "text", text: name }] };
      },
    });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "tools", tools: [tool("write"), tool("probe")] }));
  // As the run's process installs it (app.ts): the added tool wrapped where pi resolves it.
  registry.install(defineExtension({ name: "learning-copy", wraps: [{ tool: "write", wrap: (registration) => onCopyOnly(registration, work) }] }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: ".agent/repo/learnings/L-5ca1ab1e0005.md" }, { id: "call-0" }), fauxToolCall("probe", {}, { id: "call-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Done.")], { stopReason: "stop" }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "Answer." } });
  await (await root.submit({ type: "input", content: "Write, then probe." }, ctx)).wait(ctx);
  assert.deepEqual(events, ["write started", "write returned", "probe started", "probe returned"]);
});

test("a case value too short or too plain to be the case's own is not a refused value; a longer one, a JSON number or a nested value included, is", async () => {
  const { caseValuesOf } = await learningModule();
  assert.deepEqual(caseValuesOf({ a: "yes", b: "12", c: "123456789012", d: "True", e: "NO", f: "abcd", g: "false", h: "1234" }), ["123456789012", "abcd", "1234"]);
  // Measured once trimmed, and a finite number as its decimal text.
  assert.deepEqual(caseValuesOf({ a: 123456789012, b: 12, c: "  1 ", d: " yes ", e: true, f: null, g: 1234, h: Number.NaN, i: " abcd " }), ["123456789012", "1234", "abcd"]);
  // An agentic run's input keeps any field beside content, of any shape.
  assert.deepEqual(caseValuesOf({ client: { accounts: ["123456789012", 9876543210], tier: "gold", flags: [true, "no"] } }), ["123456789012", "9876543210", "gold"]);
});

test("a run's input that is a JSON number of 4 or more digits refuses its harvest; a number under 4 digits, or a value under 4 characters once trimmed, does not", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("ledger"))).status, 201);
  const writes = (id, text) => `Make these calls: ${JSON.stringify([["write", { path: `.agent/repo/learnings/${id}.md`, content: `---\nid: ${id}\ntype: lesson\nstatus: active\nruns: []\nsupersedes: []\n---\n${text}\n` }]])}`;
  const runWith = async (input) => {
    const { body: run } = await api("POST", "/agents/ledger/runs", { input });
    await follow(api, run.run_id, ["completed"]);
    return { runId: run.run_id, state: await stateOf(data, "ledger", run.run_id) };
  };
  const numeric = await runWith({ content: writes("L-5ca1ab1e0003", "Account 123456789012 is checked twice."), account: 123456789012 });
  assert.deepEqual([numeric.state.state, numeric.state.reasons], ["refused", ["learnings/L-5ca1ab1e0003.md holds a value no learning may keep"]], JSON.stringify(numeric.state));
  assert.equal(branches(bareOf(data, "ledger")).includes(`runs/${numeric.runId}`), false, "nothing is committed");
  const short = await runWith({ content: writes("L-5ca1ab1e0004", "Step  1 takes 12 seconds."), seconds: 12, step: "  1 " });
  assert.equal(short.state.state, "proposed", JSON.stringify(short.state));
  assert.match(show(bareOf(data, "ledger"), `runs/${short.runId}`, "learnings/L-5ca1ab1e0004.md"), /Step {2}1 takes 12 seconds\./);
});

test("a run whose note holds the value of this host's secret-named variable refuses its harvest by name: nothing is committed, in the repository or the host's clone, and the value is not quoted", async (t) => {
  const secret = "ledger-host-value-5ca1ab1e0005";
  withEnv(t, { LEDGER_TEST_API_KEY: secret });
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("ledger"))).status, 201);
  const id = "L-5ca1ab1e0005";
  const content = `Make these calls: ${JSON.stringify([["write", { path: `.agent/repo/learnings/${id}.md`, content: `---\nid: ${id}\ntype: lesson\nstatus: active\nruns: []\nsupersedes: []\n---\nThe registry takes ${secret} as its key.\n` }]])}`;
  const { body: run } = await api("POST", "/agents/ledger/runs", { input: { content } });
  await follow(api, run.run_id, ["completed"]);
  const state = await stateOf(data, "ledger", run.run_id);
  assert.deepEqual([state.state, state.reasons], ["refused", [`learnings/${id}.md holds a value no learning may keep`]], JSON.stringify(state));
  assert.ok(!JSON.stringify(state).includes(secret), "the refusal does not quote the value");
  const runRefs = (dir) => git(dir, "for-each-ref", "--format=%(refname)", "refs/heads/runs/");
  assert.equal(runRefs(bareOf(data, "ledger")), "", "nothing is committed");
  const clone = join(data, "agents", "ledger", "host.git");
  assert.ok(existsSync(clone), "the harvest opened the host's clone");
  assert.equal(runRefs(clone), "", "not even in the host's clone");
});

test("a holder that exited and was never reaped is not live: a zombie never keeps a run from its harvest", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  const { sha } = await stateOf(data, "calc", run.run_id);
  // A real zombie under any PID 1: the exec'd sleep never reaps the child that finished before it.
  const { spawn } = await import("node:child_process");
  const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 300"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => parent.kill("SIGKILL"));
  const zombie = Number(await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
  for (let i = 0; alive(zombie); i++) {
    assert.ok(i < 200, "the child exits");
    await sleep(25);
  }
  const { readFileSync: read } = await import("node:fs");
  assert.match(read(`/proc/${zombie}/stat`, "utf8"), /\) Z /, "it is a zombie, still in the process table");
  const recordFile = join(data, "runs", run.run_id, "run.json");
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  await writeFile(recordFile, JSON.stringify({ ...record, holder: { ...(record.holder ?? {}), pid: zombie } }));
  git(bareOf(data, "calc"), "update-ref", "-d", `refs/heads/runs/${run.run_id}`);
  const store = openStoreReader(data);
  t.after(() => store.close());
  const again = await harvestFor(data, { store, request: async (act) => act() }, run.run_id);
  assert.equal(again.sha, sha, "harvested, never refused as still live");
});

test("a learning revision that names a tool that runs a process is refused at save, by name; with learning off it is the plain unbound tool", async (t) => {
  const { api } = await serve(t);
  for (const tool of ["bash", "powershell", "code"]) {
    const refused = await api("POST", "/agents", agent(`shell-${tool}`, { tools: ["read", tool] }));
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => [f.field, f.reason, f.message])], [422, [["definition.tools[1]", "not_an_option", `${tool} runs a process, and a learning revision names no tool that does. Remove ${tool}, or set definition.learning to null.`]]], tool);
  }
  const off = await api("POST", "/agents", agent("shell-off", { learning: null, tools: ["read", "bash"] }));
  assert.equal(off.status, 422);
  assert.doesNotMatch(off.body.error.fields[0].message, /learning/, "off learning, bash is refused as a tool this host does not bind");
});

test("a learning run's tools hold none that runs a process: no entry of the table spawns, and the run sees the file tools and what its revision named", async (t) => {
  const { SPAWNING_TOOLS, TOOLS } = await import("../dist/tools.js");
  assert.deepEqual(Object.entries(TOOLS).filter(([, entry]) => entry.spawns !== false).map(([name]) => name), [], "every entry says it spawns nothing");
  assert.deepEqual(SPAWNING_TOOLS, ["bash", "powershell", "code"]);
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("asker", { tools: ["ask_person", "fetch_page"] }))).status, 201);
  const { body: run } = await api("POST", "/agents/asker/runs", { input: { content: "Which tools do you have?" } });
  await follow(api, run.run_id, ["completed"]);
  const seen = (await api("GET", `/runs/${run.run_id}`)).body.result.final_answer;
  assert.equal(seen, "Tools: ask_person, edit, fetch_page, read, write");
  assert.ok(!SPAWNING_TOOLS.some((name) => seen.includes(name)));
  await stateOf(data, "asker", run.run_id);
});

const OUTSIDE = /^<harness>\n\[error\] .*: outside the workspace /;

test("a learning run's named file tools are held to work/ by pi: a named read of /proc/self/environ, a named write outside work/, and a named read through a link out of work/ are refused with pi's own message", async (t) => {
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("named", { tools: ["read", "write", "edit"] }))).status, 201);
  const outside = await scratch(t);
  await writeFile(join(outside, "canary.txt"), "canary-5ca1ab1e-outside\n");
  const planted = join(outside, "planted");
  const list = [
    ["read", { path: "/proc/self/environ" }],
    ["write", { path: "../escape.txt", content: "out" }],
    ["write", { path: join(outside, "escape.txt"), content: "out" }],
    ["write", { path: ".agent/repo/learnings/L-5ca1ab1e0006.md", content: "---\nid: L-5ca1ab1e0006\ntype: lesson\nstatus: active\nruns: []\nsupersedes: []\n---\nRead twice.\n" }],
    ["read", { path: "out/canary.txt" }, planted],
  ];
  const { body: run } = await api("POST", "/agents/named/runs", { input: { content: `Make these calls: ${JSON.stringify(list)}` } });
  // Once the run has written its note, a link in its work/ to a directory outside, then the last call.
  const work = join(data, "runs", run.run_id, "work");
  for (let i = 0; !existsSync(join(work, ".agent", "repo", "learnings", "L-5ca1ab1e0006.md")); i++) {
    assert.ok(i < 400, "the run wrote its note");
    await sleep(50);
  }
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, join(work, "out"));
  await writeFile(planted, "");
  await follow(api, run.run_id, ["completed"]);
  const outcomes = JSON.parse((await api("GET", `/runs/${run.run_id}`)).body.result.final_answer);
  for (const at of [0, 1, 2, 4]) assert.match(outcomes[at].text, OUTSIDE, `${list[at][0]} ${list[at][1].path}`);
  assert.deepEqual(outcomes.map((o) => o.isError), [true, true, true, false, true]);
  assert.equal(existsSync(join(data, "runs", run.run_id, "escape.txt")), false, "nothing was written");
  assert.equal(existsSync(join(outside, "escape.txt")), false);
  assert.equal((await stateOf(data, "named", run.run_id)).state, "proposed", "a named write in the copy is harvested like the learning tool's");
});

test("a canary a named write plants in the learning copy is refused at harvest, by name, as one the learning tool writes is", async (t) => {
  const secret = "ledger-host-value-5ca1ab1e0008";
  withEnv(t, { LEDGER_TEST_API_KEY: secret });
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("ledger", { tools: ["write"] }))).status, 201);
  const id = "L-5ca1ab1e0008";
  const { runId, outcomes } = await calls(api, "ledger", [["write", { path: `.agent/repo/learnings/${id}.md`, content: `---\nid: ${id}\ntype: lesson\nstatus: active\nruns: []\nsupersedes: []\n---\nThe registry takes ${secret} as its key.\n` }]]);
  assert.equal(outcomes[0].isError, false, "the named write landed in the copy");
  const state = await stateOf(data, "ledger", runId);
  assert.deepEqual([state.state, state.reasons], ["refused", [`learnings/${id}.md holds a value no learning may keep`]], JSON.stringify(state));
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal(branches(bareOf(data, "ledger")).includes(`runs/${runId}`), false, "nothing is committed");
});

test("a learning run is told where and how to save what it learned: its working copy, its memo, a whole note as the learning loop writes one, and the paths a harvest takes", async (t) => {
  const { learningInstructions } = await learningModule();
  const text = learningInstructions("run-1", "---\nthe note\n---\nits rule\n");
  assert.ok(text.includes("<note>\n---\nthe note\n---\nits rule\n</note>"), "the note it is given, whole");
  for (const said of [".agent/repo", ".agent/repo/memos/run-1.md", ".agent/repo/learnings/L-<id>.md", ".agent/repo/learnings/INDEX.md", ".agent/repo/.agents/skills/<name>/SKILL.md", ".agent/repo/workflows/<name>/workflow.json", "runs/run-1", "## Proposed changes"]) {
    assert.ok(text.includes(said), `the instructions name ${said}`);
  }
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const seed = tip(bareOf(data, "calc"), "main");
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "How do you save what you learn?" } });
  await follow(api, run.run_id, ["completed"]);
  const seen = (await api("GET", `/runs/${run.run_id}`)).body.result.final_answer;
  assert.match(seen, /^<saving-learning>\n[\s\S]*<\/saving-learning>$/, "the run's model sees them");
  // The note it shows is one the learning loop reads back: written as shown, it parses, with this run and its seed.
  const { parseLearning } = await import("@parcha/pi-agent-learn");
  const example = /<note>\n([\s\S]*?)<\/note>/.exec(seen)?.[1];
  assert.ok(example, "the instructions show a whole note");
  const rule = "Search both forms of the legal name.";
  const written = example.replace("L-<id>", "L-5ca1ab1e0009").replace("<the rule, in one or two sentences>", rule);
  const parsed = parseLearning(written);
  assert.deepEqual([parsed.id, parsed.type, parsed.scope, parsed.status, parsed.provenance.runs, parsed.provenance.sha, parsed.provenance.untrusted, parsed.uses, parsed.supersedes, parsed.text], ["L-5ca1ab1e0009", "lesson", "all", "active", [run.run_id], seed, false, 0, [], rule]);
  await stateOf(data, "calc", run.run_id);
  // Written that way by a run, proposed, and on main (as a merge would put it), a later run loads it.
  const { body: writer } = await api("POST", "/agents/calc/runs", { input: { content: `Make these calls: ${JSON.stringify([["write", { path: ".agent/repo/learnings/L-5ca1ab1e0009.md", content: written }], ["write", { path: ".agent/repo/learnings/INDEX.md", content: `- L-5ca1ab1e0009: ${rule}\n` }]])}` } });
  await follow(api, writer.run_id, ["completed"]);
  assert.equal((await stateOf(data, "calc", writer.run_id)).state, "proposed");
  const proposed = show(bareOf(data, "calc"), `runs/${writer.run_id}`, "learnings/L-5ca1ab1e0009.md");
  await onMain(t, data, "calc", { "learnings/L-5ca1ab1e0009.md": `${proposed}\n` });
  const { body: reader } = await api("POST", "/agents/calc/runs", { input: { content: "What have you learned?" } });
  await follow(api, reader.run_id, ["completed"]);
  assert.match((await api("GET", `/runs/${reader.run_id}`)).body.result.final_answer, /- L-5ca1ab1e0009 lesson: Search both forms of the legal name\./, "a later run loads it");
  // A run that does not learn is not told.
  await api("POST", "/agents", agent("quiet", { learning: null }));
  const { body: quiet } = await api("POST", "/agents/quiet/runs", { input: { content: "How do you save what you learn?" } });
  await follow(api, quiet.run_id, ["completed"]);
  assert.equal((await api("GET", `/runs/${quiet.run_id}`)).body.result.final_answer, "nobody said");
});

test("a run that changed none of its notes proposes nothing: the memo stub it was seeded with is ignored, and no branch is made", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  await follow(api, run.run_id, ["completed"]);
  assert.deepEqual(await stateOf(data, "calc", run.run_id), { state: "empty" });
  assert.equal(branches(bareOf(data, "calc")).includes(`runs/${run.run_id}`), false);
});

test("a base64-wrapped host secret, or an input value only in a path the run wrote, refuses its harvest by name, never quoted", async (t) => {
  const secret = "ledger-host-value-5ca1ab1e0007";
  withEnv(t, { LEDGER_TEST_API_KEY: secret });
  const { api, data } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("ledger"))).status, 201);
  const encoded = Buffer.from(`key=${secret};`).toString("base64");
  const runWith = async (input) => {
    const { body: run } = await api("POST", "/agents/ledger/runs", { input });
    await follow(api, run.run_id, ["completed"]);
    return { runId: run.run_id, state: await stateOf(data, "ledger", run.run_id) };
  };
  const id = "L-5ca1ab1e0007";
  const b64 = await runWith({ content: `Make these calls: ${JSON.stringify([["write", { path: `.agent/repo/learnings/${id}.md`, content: `---\nid: ${id}\ntype: lesson\nstatus: active\nruns: []\nsupersedes: []\n---\nSend ${encoded} first.\n` }]])}` });
  assert.deepEqual([b64.state.state, b64.state.reasons], ["refused", [`learnings/${id}.md holds a value no learning may keep`]], JSON.stringify(b64.state));
  const path = await runWith({ content: `Make these calls: ${JSON.stringify([["write", { path: ".agent/repo/workflows/123456789012/README.md", content: "Checks an account.\n" }]])}`, account: "123456789012" });
  assert.deepEqual([path.state.state, path.state.reasons], ["refused", ["a path in the harvest holds a value no learning may keep"]], JSON.stringify(path.state));
  assert.ok(![secret, encoded, "123456789012"].some((value) => JSON.stringify([b64.state, path.state]).includes(value)), "no refusal quotes a value");
  assert.deepEqual(branches(bareOf(data, "ledger")).filter((name) => name.startsWith("runs/")), [], "nothing is committed");
});

/** A learning run of `agentId` that wrote its note and ended, its branch then removed, and its record naming a holder
 *  that sleeps: a process that outlives its run's end. */
async function outlived(t, api, data, agentId, holderFields = (pid) => ({ pid, startTicks: startTicks(pid) })) {
  await api("POST", "/agents", agent(agentId));
  const { body: run } = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Learn the rate limit." } });
  await follow(api, run.run_id, ["completed"]);
  const { sha, base } = await stateOf(data, agentId, run.run_id);
  const { spawn } = await import("node:child_process");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((resolve) => holder.once("spawn", resolve));
  const recordFile = join(data, "runs", run.run_id, "run.json");
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  await writeFile(recordFile, JSON.stringify({ ...record, holder: { ...(record.holder ?? {}), ...holderFields(holder.pid) } }));
  git(bareOf(data, agentId), "update-ref", "-d", `refs/heads/runs/${run.run_id}`);
  await rmState(data, agentId, run.run_id);
  const store = openStoreReader(data);
  t.after(() => store.close());
  const ended = async () => (holder.kill("SIGKILL"), await new Promise((resolve) => (holder.exitCode !== null || holder.signalCode !== null ? resolve() : holder.once("exit", resolve))));
  return { runId: run.run_id, sha, base, holder, ended, agents: { store, request: async (act) => act() } };
}
const rmState = async (data, agentId, runId) => (await import("node:fs/promises")).rm(join(data, "agents", agentId, "learning", "runs", `${runId}.json`), { force: true });

test("a run whose process outlives its end is recorded waiting while it lives, and harvested once when it exits, with no restart", async (t) => {
  const { harvestOnExit } = await learningModule();
  const { api, data } = await serve(t);
  const run = await outlived(t, api, data, "calc");
  const watching = harvestOnExit(data, run.agents, run.runId, new AbortController().signal, 50);
  for (let i = 0; (await readRunState(data, "calc", run.runId))?.state !== "waiting"; i++) {
    assert.ok(i < 200, "the run's learning says it waits");
    await sleep(25);
  }
  assert.deepEqual(await readRunState(data, "calc", run.runId), { state: "waiting", reason: `the run ${run.runId}'s process is still live, so its working copy is not harvested yet` });
  await sleep(300);
  assert.equal(branches(bareOf(data, "calc")).includes(`runs/${run.runId}`), false, "nothing is harvested while it lives");
  await run.ended();
  const result = await watching;
  // The host's clone still holds the commit its first harvest made: harvested again, it is that commit, pushed once.
  assert.deepEqual([result.status, result.sha, tip(bareOf(data, "calc"), `runs/${run.runId}`)], ["already", run.sha, run.sha], "harvested once it exited: the same commit as before");
  assert.equal(count(bareOf(data, "calc"), `runs/${run.runId}`), count(bareOf(data, "calc"), run.base) + 1, "one commit");
  assert.deepEqual(await readRunState(data, "calc", run.runId), { state: "proposed", branch: `runs/${run.runId}`, base: run.base, sha: run.sha });
});

test("a server that closes while a run's process outlives its end stops watching it; the run stays waiting, and the next start's catch-up harvests it once it has exited", async (t) => {
  const { harvestOnExit } = await learningModule();
  const { api, data } = await serve(t);
  const run = await outlived(t, api, data, "calc");
  const closing = new AbortController();
  const watching = harvestOnExit(data, run.agents, run.runId, closing.signal, 50);
  for (let i = 0; (await readRunState(data, "calc", run.runId))?.state !== "waiting"; i++) {
    assert.ok(i < 200);
    await sleep(25);
  }
  closing.abort();
  assert.equal(await watching, undefined, "the watch stops at close");
  await run.ended();
  await sleep(200);
  assert.equal((await readRunState(data, "calc", run.runId)).state, "waiting", "nothing harvested it after the close");
  assert.deepEqual(await catchUp(data, run.agents, () => {}), [run.runId]);
  assert.equal((await readRunState(data, "calc", run.runId)).sha, run.sha);
});

test("a pid handed to a later process is not the run's: a holder whose start ticks differ, or whose boot is another, is not live", async (t) => {
  const { api, data } = await serve(t);
  const recycled = await outlived(t, api, data, "calc", (pid) => ({ pid, startTicks: startTicks(pid) + 1 }));
  assert.equal((await harvestFor(data, recycled.agents, recycled.runId)).sha, recycled.sha, "harvested, never waited on for ever");
  const rebooted = await outlived(t, api, data, "other", (pid) => ({ pid, startTicks: startTicks(pid), bootId: "00000000-0000-0000-0000-000000000000" }));
  assert.equal((await harvestFor(data, rebooted.agents, rebooted.runId)).sha, rebooted.sha);
  const same = await outlived(t, api, data, "third");
  await assert.rejects(harvestFor(data, same.agents, same.runId), /still live/, "its own start ticks: the same process");
});

test("a read learning adds also reaches the seeded notes, and nothing else outside the copy; no write tool learning adds reaches them", async (t) => {
  const { api, data } = await serve(t);
  await api("POST", "/agents", agent("calc"));
  await onMain(t, data, "calc", note(lesson("L-0123456789ab", "Search both forms of the legal name.")));
  const outside = join(data, "outside.txt");
  await writeFile(outside, "outside\n");
  const { runId, outcomes } = await calls(api, "calc", [
    ["read", { path: ".agent/learnings/L-0123456789ab.md" }],
    ["write", { path: ".agent/learnings/L-0123456789ab.md", content: "changed" }],
    ["edit", { path: ".agent/learnings/L-0123456789ab.md", edits: [{ oldText: "Search", newText: "Skip" }] }],
    ["read", { path: "downloads/manifest.json" }],
    ["read", { path: ".agents/skills/x/SKILL.md" }],
    ["read", { path: outside }],
  ]);
  assert.deepEqual([outcomes[0].isError, outcomes[0].text.includes("Search both forms")], [false, true], "read reaches the seeded notes");
  assert.deepEqual(outcomes.slice(1).map((o) => [o.isError, o.text]), [
    [true, "write is the learning copy's only here: .agent/learnings/L-0123456789ab.md is outside .agent/repo"],
    [true, "edit is the learning copy's only here: .agent/learnings/L-0123456789ab.md is outside .agent/repo"],
    [true, "read is the learning copy's only here: downloads/manifest.json is outside .agent/repo and .agent/learnings"],
    [true, "read is the learning copy's only here: .agents/skills/x/SKILL.md is outside .agent/repo and .agent/learnings"],
    [true, `read is the learning copy's only here: ${outside} is outside .agent/repo and .agent/learnings`],
  ]);
  assert.match(await readFile(join(data, "runs", runId, "work", ".agent", "learnings", "L-0123456789ab.md"), "utf8"), /Search both forms/, "the seeded note is unchanged");
  await stateOf(data, "calc", runId);
});

test("a watch on a run whose process outlives its end leaves no listener behind on the server's signal, tick after tick", async (t) => {
  const { harvestOnExit } = await learningModule();
  const { getEventListeners } = await import("node:events");
  const { api, data } = await serve(t);
  const run = await outlived(t, api, data, "calc");
  const closing = new AbortController();
  const watching = harvestOnExit(data, run.agents, run.runId, closing.signal, 10);
  let most = 0;
  for (let i = 0; i < 30; i++) {
    most = Math.max(most, getEventListeners(closing.signal, "abort").length);
    await sleep(10);
  }
  assert.ok(most <= 1, `at most one listener at a time, saw ${most}`);
  await run.ended();
  await watching;
  assert.equal(getEventListeners(closing.signal, "abort").length, 0, "none once it harvested");
});
