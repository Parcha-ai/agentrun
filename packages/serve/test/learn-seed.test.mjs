// An agent whose definition says `learning: true` keeps what it learned in its folder's `learning/` on the disk
// (agentFolderOf): its owner's corrections (corrections.md) and its compiled workflows (workflows/<name>/). Every run of it
// starts from main there: its corrections whole in its instructions under `# Learned`, cut of the server's secrets, on pi,
// claude-agent and codex alike. Learning is off unless the agent says so, and the server's switch turns it off for all. A
// learning fault never refuses a run. The server is the folder's only writer, no hook runs, and it never follows a
// symbolic link into it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf, homeKey } from "../dist/files.js";
import { said } from "../dist/learning-words.js";
import { CORRECTIONS_INTRO, NOTHING_YET, pinOf } from "./learn-support.mjs";
import { agent, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;
const CORRECTIONS = "- Answer in tables.\n- Quote the page each figure came from.\n";
/** main as a run's merge would leave it: two of the owner's corrections. */
const MAIN = { "corrections.md": CORRECTIONS };
/** What `# Learned` holds for MAIN. */
const SECTION = `${CORRECTIONS_INTRO}\n\n- Answer in tables.\n- Quote the page each figure came from.`;

/** git in the test's own hands: no hook, and no system or global config. */
function git(cwd, args) {
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "person", GIT_AUTHOR_EMAIL: "person@example.invalid", GIT_COMMITTER_NAME: "person", GIT_COMMITTER_EMAIL: "person@example.invalid" };
  const out = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

const repoOf = (data, id) => join(agentFolderOf(data, id), "learning");
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
/** What a prompt holds under `# Learned`, to the end of the run's instructions (pi's closes them with
 *  `</instructions>`); undefined with no `# Learned`. */
const learnedIn = (prompt) => {
  const head = "\n# Learned\n\n";
  const at = prompt.indexOf(head);
  return at < 0 ? undefined : /^([\s\S]*?)(?:\n<\/instructions>|$)/.exec(prompt.slice(at + head.length))[1];
};

/** Commits `files` on main by hand, in the folder's working tree, as a merge into main would leave it (its snapshot is
 *  then the earlier commit's, which the server reads past and rebuilds). Its commit. */
function commitToMain(repo, files, message = "learned") {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "main"]);
}

/** Starts a run of agent `id` and waits for it to complete: its id and its answer, the prompt the faux model saw. */
async function ran(api, id) {
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  await learningEnded(api, run.body.run_id);
  return { runId: run.body.run_id, prompt: await answer(api, run.body.run_id) };
}

/** Once the run's learning has ended (it does not learn, or it merged or dropped). */
async function learningEnded(api, runId) {
  for (let i = 0; ["seeded", "reflecting"].includes((await api("GET", `/runs/${runId}`)).body.learning?.state); i++) {
    assert.ok(i < 600, "the run's learning ends");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Agent `id` with learning on, created, and its folder made by a first run, with `files` then committed on main. */
async function learned(api, data, id, extra = {}, files = MAIN) {
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, ...extra }))).status, 201);
  await ran(api, id);
  return commitToMain(repoOf(data, id), files);
}

/** The run's learning, on its own read and in its agent's run list. */
async function learningOf(api, agentId, runId) {
  const listed = (await api("GET", `/agents/${agentId}/runs`)).body.runs.find((run) => run.run_id === runId);
  return { whole: (await api("GET", `/runs/${runId}`)).body.learning, short: listed.learning };
}

/** That run `runId` of agent `id` learned nothing and has no learning: no folder, no section, no pin, `learning: null`. */
async function learnsNothing(api, data, id, runId, prompt) {
  assert.equal(existsSync(repoOf(data, id)), false, "no learning folder is made");
  assert.equal(await pinOf({ data }, runId), undefined, "no pin");
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned"), prompt);
  assert.deepEqual(await learningOf(api, id, runId), { whole: null, short: null });
}

test("a new agent with learning on: its first run makes its folder, main checked out with one host commit holding nothing yet, and starts seeded, told under # Learned that nothing is learned yet, as a restarted server reads it too", { timeout: 90_000 }, async (t) => {
  const first = await serve(t, { faux: SYSTEM });
  const { api, data } = first;
  assert.equal((await api("POST", "/agents", agent("fresh", { learning: true, instructions: "Answer the question." }))).status, 201);
  const { runId, prompt } = await ran(api, "fresh");
  const repo = repoOf(data, "fresh");
  assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.equal(git(repo, ["log", "-1", "--format=%an <%ae>", "main"]), "agentrun-serve <serve@agentrun.invalid>");
  assert.equal(git(repo, ["ls-tree", "-r", "--name-only", "main"]), ".agentrun/snapshot.json", "nothing learned yet");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.deepEqual(readdirSync(agentFolderOf(data, "fresh")).sort(), ["learning", "runs"], "its learning folder beside its runs");
  assert.deepEqual(await pinOf({ data }, runId), { seed: git(repo, ["rev-parse", "main"]) });
  assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${NOTHING_YET}`), prompt);
  assert.ok(!prompt.includes(CORRECTIONS_INTRO), "no intro to corrections it has none of");
  // Seeded; nothing to keep from it.
  const { whole, short } = await learningOf(api, "fresh", runId);
  assert.deepEqual({ ...whole, at: typeof whole.at }, { state: "dropped", reason: "empty", detail: said.empty, at: "string" });
  assert.deepEqual(short, { state: "dropped", reason: "empty", detail: said.empty }, "a list says it in the same words");
  // A server started again reads the run's learning back, whole and in a list.
  await first.close();
  const again = await serve(t, { data, faux: SYSTEM });
  assert.deepEqual(await learningOf(again.api, "fresh", runId), { whole, short });
});

// A home made before the agent's first run that learns may already hold an empty `learning/` (mode 0700, no .git), as a
// home's first making leaves it: the seed takes it as it is, git init in place, and the run starts from its one commit.
test("an empty learning/ in the agent's home before its first run, with no .git, is taken as it is: the folder is made a repository in place with one commit, and the run is seeded from it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("premade", { learning: true, instructions: "Answer the question." }))).status, 201);
  const repo = repoOf(data, "premade");
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  chmodSync(repo, 0o700);
  assert.deepEqual(readdirSync(repo), []);
  const { runId } = await ran(api, "premade");
  const { whole } = await learningOf(api, "premade", runId);
  assert.deepEqual([whole.state, whole.reason], ["dropped", "empty"], "seeded, and nothing to keep");
  assert.ok(existsSync(join(repo, ".git")), "a repository, made in place");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.deepEqual(await pinOf({ data }, runId), { seed: git(repo, ["rev-parse", "main"]) });
  assert.equal(statSync(repo).mode & 0o777, 0o700, "its mode as it was");
});

// The faux harness stands in for claude-agent's and codex's: it says the system prompt the run gives it.
for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`a fresh agent's first ${harness} run that learns is told nothing is learned yet, under one # Learned after its instructions`, { timeout: 90_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `first-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: "Answer the question." }))).status, 201);
    const { runId, prompt } = await ran(api, id);
    assert.deepEqual(await pinOf({ data }, runId), { seed: git(repoOf(data, id), ["rev-parse", "main"]) }, "a first run has a pin, with nothing learned");
    assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${NOTHING_YET}`), prompt);
    assert.equal(prompt.split("# Learned").length, 2, "one section");
  });
}

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`a ${harness} run starts from main's commit: its owner's corrections whole under # Learned`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `seeded-${harness}`;
    const sha = await learned(api, data, id, { harness, instructions: "Answer the question." });
    const { runId, prompt } = await ran(api, id);
    assert.equal(learnedIn(prompt), SECTION, `${prompt}\n${JSON.stringify((await learningOf(api, id, runId)).whole)}`);
    assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n${SECTION}`), `the section follows the instructions: ${prompt}`);
    assert.equal(prompt.split(CORRECTIONS_INTRO).length, 2, "said once");
    assert.ok(!prompt.includes(NOTHING_YET), prompt);
    assert.deepEqual(await pinOf({ data }, runId), { seed: sha, section: SECTION.slice(CORRECTIONS_INTRO.length + 2) });
    const { whole } = await learningOf(api, id, runId);
    assert.deepEqual([whole.state, whole.reason], ["dropped", "empty"], "seeded, and nothing to keep");
  });
}

test("a run starts from main's commit, never the working tree: an uncommitted edit to corrections.md never reaches it, and main keeps its own text", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "dirty", { instructions: "Answer the question." });
  const repo = repoOf(data, "dirty");
  writeFileSync(join(repo, "corrections.md"), `${CORRECTIONS}- An uncommitted rule.\n`);
  const { runId, prompt } = await ran(api, "dirty");
  assert.ok(!prompt.includes("uncommitted"), prompt);
  assert.equal(learnedIn(prompt), SECTION, prompt);
  assert.deepEqual(await pinOf({ data }, runId), { seed: sha, section: SECTION.slice(CORRECTIONS_INTRO.length + 2) });
  assert.equal(git(repo, ["show", "main:corrections.md"]), CORRECTIONS.trimEnd(), "main keeps its own text (git() trims)");
});

test("learning is off unless the agent says so: an agent that leaves it out, or says false, gets no folder, no # Learned, and learning: null", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  for (const [id, extra] of [["unset", {}], ["off", { learning: false }]]) {
    assert.equal((await api("POST", "/agents", agent(id, { instructions: "Answer the question.", ...extra }))).status, 201);
    const { runId, prompt } = await ran(api, id);
    await learnsNothing(api, data, id, runId, prompt);
  }
});

test("the server's switch off: an agent that says learning: true learns nothing, as one that is off, and capabilities say off; a value that is not on or off refuses the start", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM, learning: "off" });
  assert.equal((await api("GET", "/capabilities")).body.features.learning, "off");
  assert.equal((await api("POST", "/agents", agent("muted", { learning: true, instructions: "Answer the question." }))).status, 201);
  const { runId, prompt } = await ran(api, "muted");
  await learnsNothing(api, data, "muted", runId, prompt);
  const dir = await scratch(t);
  await assert.rejects(serve(t, { data: join(dir, "a"), learning: "maybe" }), /learning is on or off/);
  withEnv(t, { AGENTRUN_SERVE_LEARNING: "no" });
  await assert.rejects(serve(t, { data: join(dir, "b") }), /learning is on or off \(--learning, AGENTRUN_SERVE_LEARNING\), not no/);
  process.env.AGENTRUN_SERVE_LEARNING = "off";
  assert.equal((await (await serve(t, { data: join(dir, "c") })).api("GET", "/capabilities")).body.features.learning, "off", "the environment's switch, when no option names one");
});

test("a correction holding a value made one of the server's secrets after it was written: the run's instructions and its pin read it [redacted], though main holds it", { timeout: 120_000 }, async (t) => {
  // Built at the run: a value no file of this repository holds.
  const value = ["shop", "key", process.pid, Date.now().toString(36), "0123456789"].join("-");
  withEnv(t, { SHOP_API_KEY: value });
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "leaky", { instructions: "Answer the question." }, { "corrections.md": `- Sign in with ${value}.\n` });
  assert.ok(git(repoOf(data, "leaky"), ["show", "main:corrections.md"]).includes(value), "main holds it");
  const { runId, prompt } = await ran(api, "leaky");
  assert.ok(!prompt.includes(value), prompt);
  assert.equal(learnedIn(prompt), `${CORRECTIONS_INTRO}\n\n- Sign in with [redacted].`, prompt);
  assert.ok(!JSON.stringify(await pinOf({ data }, runId)).includes(value), "nor the pin");
});

// Waits on the switch (tl-untangle): a message to a run that ended on the runner answers 409, so the run is never
// continued here.
const CONTINUE_TODO = "the switch (tl-untangle): a run that ended on the runner is continued by a message";
test("the pin: a run keeps the commit it was made from when main moves on, through a continue in a new process", { timeout: 120_000, skip: CONTINUE_TODO }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "pinned", { instructions: "Answer the question." });
  const { runId, prompt } = await ran(api, "pinned");
  const pin = JSON.stringify(await pinOf({ data }, runId));
  assert.equal(JSON.parse(pin).seed, sha);
  const later = commitToMain(repoOf(data, "pinned"), { "corrections.md": `${CORRECTIONS}- A rule main learned after the run was made.\n` });
  assert.notEqual(later, sha);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again?" })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const again = await answer(api, runId);
  assert.equal(JSON.stringify(await pinOf({ data }, runId)), pin, "the pin is never written again");
  assert.equal(learnedIn(again), learnedIn(prompt));
  assert.ok(!again.includes("main learned after"), again);
  // A run made now starts from the new main.
  const next = await ran(api, "pinned");
  assert.equal((await pinOf({ data }, next.runId)).seed, later);
  assert.match(learnedIn(next.prompt), /A rule main learned after the run was made\./, next.prompt);
});

test("two runs of a new agent made at once: one folder made, one commit on main, and both runs seeded from it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("twice", { learning: true }))).status, 201);
  const made = await Promise.all([1, 2].map(() => api("POST", "/agents/twice/runs", { input: { content: "hi" } })));
  for (const run of made) assert.equal(run.status, 202, JSON.stringify(run.body));
  for (const run of made) await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  for (const run of made) await learningEnded(api, run.body.run_id);
  const repo = repoOf(data, "twice");
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal(git(repo, ["rev-list", "--count", "--all"]), "1");
  assert.equal(git(repo, ["reflog", "show", "--format=%H", "refs/heads/main"]), main, "main was set once");
  assert.deepEqual(await Promise.all(made.map(async (run) => (await pinOf({ data }, run.body.run_id)).seed)), [main, main]);
  assert.deepEqual(readdirSync(agentFolderOf(data, "twice")).sort(), ["learning", "runs"], "its learning folder beside its runs");
  for (const run of made) assert.equal((await api("GET", `/runs/${run.body.run_id}`)).body.learning.reason, "empty", "seeded, and nothing to keep");
});

test("two agents whose ids differ only in case: each has its own learning folder, in agent folders whose names differ in any case, and what one learned never seeds the other's run", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "Twin", { instructions: "Answer the question." });
  assert.equal((await api("POST", "/agents", agent("twin", { learning: true, instructions: "Answer the question." }))).status, 201);
  const other = await ran(api, "twin");
  // The agents' folders as the server made them: named as homeKey names, so apart even on a disk that folds case.
  const homes = readdirSync(join(data, "disk", "agents")).sort();
  assert.deepEqual(homes, [homeKey("Twin"), homeKey("twin")].sort());
  assert.equal(new Set(homes.map((name) => name.toLowerCase())).size, 2, "the names differ in any case");
  // The other's folder is a new one: one host commit holding nothing, and its run learned nothing of Twin's.
  const repo = repoOf(data, "twin");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.equal(git(repo, ["ls-tree", "-r", "--name-only", "main"]), ".agentrun/snapshot.json");
  assert.equal(learnedIn(other.prompt), NOTHING_YET, other.prompt);
  assert.ok(!other.prompt.includes("Answer in tables"), other.prompt);
  assert.notEqual((await pinOf({ data }, other.runId)).seed, sha);
  // The one that learned still starts from its own.
  const own = await ran(api, "Twin");
  assert.equal(learnedIn(own.prompt), SECTION, own.prompt);
  assert.equal((await pinOf({ data }, own.runId)).seed, sha);
});

test("no hook runs on the host's git calls: neither the folder's own (its hooks folder, core.hooksPath, an fsmonitor) nor a template, hooks folder or config the environment names", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const marker = join(dir, "ran");
  const hook = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho "$0" >> '${marker}'\n`);
    chmodSync(path, 0o755);
  };
  const NAMES = ["pre-commit", "commit-msg", "post-commit", "post-checkout", "post-index-change", "reference-transaction"];
  // What the environment names: a template with hooks, and a global and a system config naming a hooks folder, a
  // template and an fsmonitor.
  for (const name of NAMES) hook(join(dir, "template", "hooks", name)), hook(join(dir, "hooks", name));
  hook(join(dir, "fsmonitor"));
  const config = `[core]\n\thooksPath = ${join(dir, "hooks")}\n\tfsmonitor = ${join(dir, "fsmonitor")}\n[init]\n\ttemplateDir = ${join(dir, "template")}\n`;
  writeFileSync(join(dir, "gitconfig"), config);
  withEnv(t, { GIT_TEMPLATE_DIR: join(dir, "template"), GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_SYSTEM: join(dir, "gitconfig") });
  const { api, data } = await serve(t);
  // A folder whose making stopped before main, with hooks of its own: the host finishes it there.
  const planted = repoOf(data, "planted");
  mkdirSync(planted, { recursive: true });
  git(planted, ["init", "-q", "--template=", "--initial-branch=main"]);
  for (const name of NAMES) hook(join(planted, ".git", "hooks", name)), hook(join(dir, "own-hooks", name));
  git(planted, ["config", "core.hooksPath", join(dir, "own-hooks")]);
  git(planted, ["config", "core.fsmonitor", join(dir, "fsmonitor")]);
  for (const id of ["planted", "fresh"]) {
    assert.equal((await api("POST", "/agents", agent(id, { learning: true }))).status, 201);
    // The first run makes main; the second reads it.
    for (const _ of [1, 2]) await ran(api, id);
    const repo = repoOf(data, id);
    assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
    assert.equal(git(repo, ["status", "--porcelain"]), "", "the checkout shows main, finished");
  }
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  assert.equal(existsSync(join(repoOf(data, "fresh"), ".git", "hooks")), false, "no template was copied");
});

/** That run `runId` of agent `id` completed with nothing learned, dropped for seed_failed. */
async function seedFailed(api, data, id, runId, prompt) {
  assert.equal((await pinOf({ data }, runId))?.section, undefined, "nothing laid");
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned"), `a run that keeps nothing is not given a # Learned: ${prompt}`);
  const { whole, short } = await learningOf(api, id, runId);
  assert.deepEqual([whole.state, whole.reason, short], ["dropped", "seed_failed", { state: "dropped", reason: "seed_failed", detail: whole.detail }]);
  assert.match(whole.detail, /^Not kept: learning stopped \(.*the run started without (it|what the agent learned)\)\.$/);
}

test("a folder the server cannot read: the run still completes, with nothing learned, and its learning is dropped for seed_failed", { timeout: 120_000, skip: process.getuid?.() === 0 && "root reads any folder" }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "locked", { instructions: "Answer the question." });
  const repo = repoOf(data, "locked");
  chmodSync(repo, 0o000);
  let run;
  try {
    run = await ran(api, "locked");
  } finally {
    chmodSync(repo, 0o700);
  }
  await seedFailed(api, data, "locked", run.runId, run.prompt);
  // Once it can be read again, the next run starts from it.
  assert.equal(learnedIn((await ran(api, "locked")).prompt), SECTION);
});

/** A scratch directory holding one file, `kept`, for a planted link to point at (or at its file). */
async function linkTarget(t) {
  const target = await scratch(t);
  writeFileSync(join(target, "kept"), "kept\n");
  return target;
}

/** What the server writes to its stderr while test `t` runs. */
function stderrOf(t) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => void (process.stderr.write = write));
  return lines;
}

/** That run `runId` of agent `id` was refused the link it met: seed_failed, the link's target as it was, and the
 *  warning naming a link in the data directory, never the target. */
async function refusedLink(api, data, id, runId, prompt, target, lines) {
  await seedFailed(api, data, id, runId, prompt);
  assert.deepEqual(readdirSync(target), ["kept"], "nothing is made where the link points");
  assert.equal(readFileSync(join(target, "kept"), "utf8"), "kept\n", "nothing is written through the link");
  const warning = lines.find((text) => text.includes(`the agent ${id}'s learning folder could not be read`)) ?? "";
  assert.match(warning, /a link in the learning folder at [^ ]+ can't be followed, so nothing learned is read or written; remove the link/, lines.join(""));
  assert.ok(!warning.includes(target), warning);
}

// A link left in an agent's home before its learning was on, by something that could write there: at its learning
// folder, or at the folder's .git. The host refuses it and never follows it, so its git init, writes and commits never
// land where the link points.
const PLANTED = {
  "disk/agents/<key>/learning": (data, id, target) => (mkdirSync(agentFolderOf(data, id), { recursive: true }), symlinkSync(target, repoOf(data, id))),
  "learning/.git": (data, id, target) => (mkdirSync(repoOf(data, id), { recursive: true }), symlinkSync(target, join(repoOf(data, id), ".git"))),
};

// A link at corrections.md in a folder whose making stopped before main: the first commit holds nothing, so main names no
// corrections.md and the link is never read; the run is told nothing is learned yet, and nothing reaches the target.
test("a symbolic link at learning/corrections.md, there before the agent's first run: never followed, the run starts with nothing learned yet, and nothing is read or written where the link points", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const target = await linkTarget(t);
  assert.equal((await api("POST", "/agents", agent("linked", { learning: true, instructions: "Answer the question." }))).status, 201);
  mkdirSync(repoOf(data, "linked"), { recursive: true });
  symlinkSync(join(target, "kept"), join(repoOf(data, "linked"), "corrections.md"));
  const run = await ran(api, "linked");
  assert.equal(learnedIn(run.prompt), NOTHING_YET, run.prompt);
  assert.equal(git(repoOf(data, "linked"), ["ls-tree", "-r", "--name-only", "main"]), ".agentrun/snapshot.json", "main names no corrections.md");
  assert.deepEqual(readdirSync(target), ["kept"], "nothing is made where the link points");
  assert.equal(readFileSync(join(target, "kept"), "utf8"), "kept\n", "nothing is written through the link");
});
for (const [where, plant] of Object.entries(PLANTED)) {
  test(`a symbolic link at ${where}, there before the agent's first run: the run completes with nothing learned, seed_failed, nothing is made or written where the link points, and the warning names the link, not its target`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM });
    const target = await linkTarget(t);
    assert.equal((await api("POST", "/agents", agent("linked", { learning: true, instructions: "Answer the question." }))).status, 201);
    plant(data, "linked", target);
    const lines = stderrOf(t);
    const run = await ran(api, "linked");
    await refusedLink(api, data, "linked", run.runId, run.prompt, target, lines);
  });
}

// Waits on the switch's start (tl-untangle): a run is queued before any folder is made, so its start refuses nothing for
// its agent's folder; the runner's claim makes the run's folder.
const RUN_FOLDER_LINK_TODO = "the switch's start (tl-untangle): a run whose agent's folder is a link is refused at its start";
test("a symbolic link at disk/agents/<key>, the agent's folder, there before its first run: the run is refused at its start, since its own folder would be made through the link, and nothing is made where the link points", { timeout: 120_000, skip: RUN_FOLDER_LINK_TODO }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const target = await linkTarget(t);
  assert.equal((await api("POST", "/agents", agent("linked", { learning: true, instructions: "Answer the question." }))).status, 201);
  const before = readdirSync(target).sort();
  mkdirSync(dirname(agentFolderOf(data, "linked")), { recursive: true });
  symlinkSync(target, agentFolderOf(data, "linked"));
  const run = await api("POST", "/agents/linked/runs", { input: { content: "hi" } });
  assert.equal(run.status, 422, JSON.stringify(run.body));
  assert.match(JSON.stringify(run.body), /disk\/agents\/linked-[0-9a-f]{16} is a symbolic link, and a run's folder is never made through one/);
  assert.ok(!JSON.stringify(run.body).includes(target), "the refusal names the link, not its target");
  assert.deepEqual(readdirSync(target).sort(), before, "nothing made where the link points");
});
