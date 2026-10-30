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

test("harness and learning sit side by side on a definition: both are kept, and an edit without either keeps both", async (t) => {
  const { api, data } = await serve(t);
  const made = await api("POST", "/agents", agent("both", { harness: "claude-agent", learning: "approve" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.definition.harness, made.body.definition.learning], ["claude-agent", "approve"]);
  assert.deepEqual([storeRevision(data, made.body.revision).body.harness, storeRevision(data, made.body.revision).body.learning], ["claude-agent", "approve"]);
  const edited = await api("PUT", "/agents/both/definition", { definition: { instructions: "Answer briefly.", skills: [], tools: [] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.definition.harness, edited.body.definition.learning], ["claude-agent", "approve"]);
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
  await writeFile(recordFile, JSON.stringify({ ...record, holder: { ...(record.holder ?? {}), pid: holder.pid } }));
  const bare = bareOf(data, "calc");
  git(bare, "update-ref", "-d", `refs/heads/runs/${run.run_id}`);
  const store = openStoreReader(data);
  t.after(() => store.close());
  await assert.rejects(harvestFor(data, { store, request: async (act) => act() }, run.run_id), /still live/);
  assert.equal(branches(bare).includes(`runs/${run.run_id}`), false, "nothing was harvested");
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  const after = await harvestFor(data, { store, request: async (act) => act() }, run.run_id);
  assert.equal(after.sha, sha, "once it has ended, the same commit as before");
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
  assert.deepEqual([plain.outcomes[0].isError, plain.outcomes[0].text], [true, "read is the learning copy's only here: .agents/skills/cite/SKILL.md is outside .agent/repo"]);
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
