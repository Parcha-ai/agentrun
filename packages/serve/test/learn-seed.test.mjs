// An agent whose definition says `learning: true` keeps what it learned in its home's `learning/` (homeOf), in Claude
// Code's auto-memory format (MEMORY.md, the index, and a file per note), and every run of it starts from main there: the
// index in its instructions under `# Learned`, and the index and active notes in `work/.learning/`, on pi, claude-agent
// and codex alike. Learning is off unless the agent says so, and the server's switch turns it off for all. A learning
// fault never refuses a run. The server is the folder's only writer, no hook runs, and it never follows a symbolic link
// into it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { homeKey, homeOf } from "../dist/files.js";
import { learningTestHooks } from "../dist/learning.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;
const note = (name, description, type, extra = "", body = `${description}.\n`) => `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n${extra}---\n${body}`;
const REFUND = note("Refund policy path", "Shopify stores keep their policies at /policies/", "reference");
const TABLES = note("Prefers tables", "The user reads results as tables", "user");
const OLD = note("Old refunds", "Refunds were under /help/", "reference", "status: superseded\nsuperseded_by: refund-policy-path.md\n");
const INDEX = "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Refund policy path](refund-policy-path.md) — Shopify stores keep their policies at /policies/\n";
/** main as a merge would leave it: two active notes, one superseded, and the index of the active ones. */
const MAIN = { "MEMORY.md": INDEX, "refund-policy-path.md": REFUND, "prefers-tables.md": TABLES, "old-refunds.md": OLD };

/** git in the test's own hands: no hook, and no system or global config. */
function git(cwd, args) {
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "person", GIT_AUTHOR_EMAIL: "person@example.invalid", GIT_COMMITTER_NAME: "person", GIT_COMMITTER_EMAIL: "person@example.invalid" };
  const out = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

const repoOf = (data, id) => join(homeOf(data, id), "learning");
const pinOf = (data, runId) => JSON.parse(readFileSync(join(data, "runs", runId, "learning.json"), "utf8"));
const learnedDir = (data, runId) => join(data, "runs", runId, "work", ".learning");
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
/** The index a prompt holds under `# Learned`, after its one line of intro, or undefined. pi's system prompt closes the
 *  instructions with `</instructions>`. */
const learnedIn = (prompt) => /\n# Learned\n\n[^\n]*\n\n([\s\S]*?)(?:\n\n|\n<\/instructions>|\n?$)/.exec(prompt)?.[1];

/** Commits `files` on main, in the folder's working tree, as a merge into main would leave it. Its commit. */
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
  return { runId: run.body.run_id, prompt: await answer(api, run.body.run_id) };
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

/** That run `runId` of agent `id` learned nothing and has no learning: no folder, no section, no copy, `learning: null`. */
async function learnsNothing(api, data, id, runId, prompt) {
  assert.equal(existsSync(repoOf(data, id)), false, "no learning folder is made");
  assert.equal(existsSync(join(data, "runs", runId, "learning.json")), false, "no pin");
  assert.equal(existsSync(learnedDir(data, runId)), false, "no .learning in the run's work");
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned"), prompt);
  assert.deepEqual(await learningOf(api, id, runId), { whole: null, short: null });
}

test("a new agent with learning on: its first run makes its folder, main checked out with one host commit holding an empty MEMORY.md, and starts seeded with no # Learned section, as a restarted server reads it too", { timeout: 90_000 }, async (t) => {
  const first = await serve(t, { faux: SYSTEM });
  const { api, data } = first;
  assert.equal((await api("POST", "/agents", agent("fresh", { learning: true, instructions: "Answer the question." }))).status, 201);
  const { runId, prompt } = await ran(api, "fresh");
  const repo = repoOf(data, "fresh");
  assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.equal(git(repo, ["log", "-1", "--format=%an <%ae>", "main"]), "agentrun-serve <serve@agentrun.invalid>");
  assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["MEMORY.md"]);
  assert.equal(git(repo, ["cat-file", "-s", "main:MEMORY.md"]), "0");
  // Any reader sees main's files: the working tree and the index are main's.
  assert.equal(readFileSync(join(repo, "MEMORY.md"), "utf8"), "");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.deepEqual(readdirSync(homeOf(data, "fresh")), ["learning"]);
  assert.deepEqual(pinOf(data, runId), { seed: git(repo, ["rev-parse", "main"]) });
  assert.deepEqual(readdirSync(learnedDir(data, runId)), ["MEMORY.md"]);
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned"), `an empty index adds no section: ${prompt}`);
  // Seeded, then, as its agent has no write tool, asked no end-of-run turn (learn-reflect.test.mjs).
  const { whole, short } = await learningOf(api, "fresh", runId);
  assert.deepEqual({ ...whole, at: typeof whole.at }, { state: "dropped", reason: "no_write_tool", detail: "Not kept: this agent can't write notes (give it the write tool).", at: "string" });
  assert.deepEqual(short, { state: "dropped", reason: "no_write_tool", detail: "Not kept: this agent can't write notes (give it the write tool)." }, "a list says it in the same words");
  // A server started again reads the run's learning back from its serve.json, whole and in a list.
  await first.close();
  const again = await serve(t, { data, faux: SYSTEM });
  assert.deepEqual(await learningOf(again.api, "fresh", runId), { whole, short });
});

// The faux harness stands in for claude-agent's and codex's: it says the system prompt the run gives it.
for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`a ${harness} run starts from main's commit, never the working tree: MEMORY.md's lines under # Learned, and the index and the active notes in work/.learning, not the superseded one`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, fauxHarness: SYSTEM });
    const id = `seeded-${harness}`;
    const sha = await learned(api, data, id, { harness, instructions: "Answer the question." });
    // Uncommitted edits in the working tree: what a run reads is main's commit, never these.
    const repo = repoOf(data, id);
    writeFileSync(join(repo, "MEMORY.md"), `${INDEX}- [Loose](loose.md) — an uncommitted rule\n`);
    writeFileSync(join(repo, "prefers-tables.md"), note("Prefers tables", "uncommitted", "user"));
    writeFileSync(join(repo, "loose.md"), note("Loose", "never committed", "project"));
    const { runId, prompt } = await ran(api, id);
    assert.equal(learnedIn(prompt), INDEX.trim(), prompt);
    assert.ok(prompt.includes(`Answer the question.\n\n# Learned\n\n`), `the section follows the instructions: ${prompt}`);
    assert.match(prompt, /# Learned\n\n[^\n]*`\.learning\/`[^\n]*open one when it applies/, "the intro says where the notes are");
    assert.ok(!prompt.includes("uncommitted") && !prompt.includes("Loose") && !prompt.includes("Old refunds"), prompt);
    assert.deepEqual(readdirSync(learnedDir(data, runId)).sort(), ["MEMORY.md", "prefers-tables.md", "refund-policy-path.md"]);
    for (const file of ["MEMORY.md", "prefers-tables.md", "refund-policy-path.md"]) assert.equal(readFileSync(join(learnedDir(data, runId), file), "utf8"), MAIN[file], file);
    assert.deepEqual(pinOf(data, runId), { seed: sha, learned: INDEX });
    const skills = join(data, "runs", runId, "work", ".agents", "skills");
    assert.deepEqual(existsSync(skills) ? readdirSync(skills) : [], [], "no learned skill is written");
    const { whole, short } = await learningOf(api, id, runId);
    assert.deepEqual([whole.state, whole.reason, short], ["dropped", "no_write_tool", { state: "dropped", reason: "no_write_tool", detail: whole.detail }], "seeded, and asked no end-of-run turn");
  });
}

test("learning is off unless the agent says so: an agent that leaves it out, or says false, gets no folder, no # Learned, no work/.learning, and learning: null", { timeout: 120_000 }, async (t) => {
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

test("a run reads the first 200 lines of MEMORY.md, as Claude Code loads its own, and gets the whole file in work/.learning", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const lines = Array.from({ length: 250 }, (_, i) => `- [Note ${i + 1}](note-${i + 1}.md) — line ${i + 1}`);
  await learned(api, data, "long", { instructions: "Answer the question." }, { "MEMORY.md": `${lines.join("\n")}\n` });
  const { runId, prompt } = await ran(api, "long");
  assert.equal(learnedIn(prompt), lines.slice(0, 200).join("\n"));
  assert.ok(prompt.includes("line 200") && !prompt.includes("line 201"), prompt.slice(-300));
  assert.equal(readFileSync(join(learnedDir(data, runId), "MEMORY.md"), "utf8"), `${lines.join("\n")}\n`);
});

test("the pin: a run keeps the commit it was made from when main moves on, through a continue in a new process", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "pinned", { instructions: "Answer the question." });
  const { runId, prompt } = await ran(api, "pinned");
  const pin = readFileSync(join(data, "runs", runId, "learning.json"), "utf8");
  assert.equal(JSON.parse(pin).seed, sha);
  const later = commitToMain(repoOf(data, "pinned"), { "MEMORY.md": `${INDEX}- [Later](later.md) — a rule main learned after the run was made\n`, "later.md": note("Later", "a rule main learned after the run was made", "feedback") });
  assert.notEqual(later, sha);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again?" })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const again = await answer(api, runId);
  assert.equal(readFileSync(join(data, "runs", runId, "learning.json"), "utf8"), pin, "the pin is never written again");
  assert.equal(learnedIn(again), learnedIn(prompt));
  assert.ok(!again.includes("main learned after"), again);
  assert.equal(existsSync(join(learnedDir(data, runId), "later.md")), false);
  // A run made now starts from the new main.
  const next = await ran(api, "pinned");
  assert.equal(pinOf(data, next.runId).seed, later);
  assert.ok(learnedIn(next.prompt).includes("[Later](later.md)"), next.prompt);
  assert.ok(existsSync(join(learnedDir(data, next.runId), "later.md")));
});

test("two runs of a new agent made at once: one folder made, one commit on main, and both runs seeded from it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("twice", { learning: true }))).status, 201);
  const made = await Promise.all([1, 2].map(() => api("POST", "/agents/twice/runs", { input: { content: "hi" } })));
  for (const run of made) assert.equal(run.status, 202, JSON.stringify(run.body));
  for (const run of made) await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const repo = repoOf(data, "twice");
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal(git(repo, ["rev-list", "--count", "--all"]), "1");
  assert.equal(git(repo, ["reflog", "show", "--format=%H", "refs/heads/main"]), main, "main was set once");
  assert.deepEqual(made.map((run) => pinOf(data, run.body.run_id).seed), [main, main]);
  assert.deepEqual(readdirSync(homeOf(data, "twice")), ["learning"]);
  for (const run of made) assert.equal((await api("GET", `/runs/${run.body.run_id}`)).body.learning.reason, "no_write_tool", "seeded, and asked no end-of-run turn");
});

test("two agents whose ids differ only in case: each has its own learning folder, in homes whose names differ in any case, and what one learned never seeds the other's run", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "Twin", { instructions: "Answer the question." });
  assert.equal((await api("POST", "/agents", agent("twin", { learning: true, instructions: "Answer the question." }))).status, 201);
  const other = await ran(api, "twin");
  // The homes as the server made them: named by homeKey, so apart even on a disk that folds case.
  const homes = readdirSync(join(data, "homes")).sort();
  assert.deepEqual(homes, [homeKey("Twin"), homeKey("twin")].sort());
  assert.equal(new Set(homes.map((name) => name.toLowerCase())).size, 2, "the names differ in any case");
  // The other's folder is a new one: one host commit holding an empty MEMORY.md, and its run learned nothing of Twin's.
  const repo = repoOf(data, "twin");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["MEMORY.md"]);
  assert.equal(learnedIn(other.prompt), undefined, other.prompt);
  assert.ok(!other.prompt.includes("Refund policy path") && !other.prompt.includes("Prefers tables"), other.prompt);
  assert.deepEqual(readdirSync(learnedDir(data, other.runId)), ["MEMORY.md"]);
  assert.equal(readFileSync(join(learnedDir(data, other.runId), "MEMORY.md"), "utf8"), "");
  assert.notEqual(pinOf(data, other.runId).seed, sha);
  // The one that learned still starts from its own.
  const own = await ran(api, "Twin");
  assert.equal(learnedIn(own.prompt), INDEX.trim(), own.prompt);
  assert.deepEqual(pinOf(data, own.runId), { seed: sha, learned: INDEX });
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
    assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["MEMORY.md"]);
    assert.equal(git(repo, ["status", "--porcelain"]), "", "the checkout shows main, finished");
  }
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  assert.equal(existsSync(join(repoOf(data, "fresh"), ".git", "hooks")), false, "no template was copied");
});

/** That run `runId` of agent `id` completed with nothing learned, dropped for seed_failed. */
async function seedFailed(api, data, id, runId, prompt) {
  assert.equal(existsSync(join(data, "runs", runId, "learning.json")), false, "no pin");
  assert.equal(existsSync(learnedDir(data, runId)), false, "no .learning in the run's work");
  assert.ok(prompt.includes("Answer the question.") && !prompt.includes("# Learned"), prompt);
  const { whole, short } = await learningOf(api, id, runId);
  assert.deepEqual([whole.state, whole.reason, short], ["dropped", "seed_failed", { state: "dropped", reason: "seed_failed", detail: whole.detail }]);
  assert.match(whole.detail, /^Not kept: learning stopped \(.*, so the run started without (them|its notes)\)\.$/);
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
  assert.equal(learnedIn((await ran(api, "locked")).prompt), INDEX.trim());
});

test("a main whose commit git cannot read, and notes that cannot be copied into the run: each run completes with nothing learned, seed_failed, and the folder's working tree and index are left as they were", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const main = await learned(api, data, "lost", { instructions: "Answer the question." });
  const repo = repoOf(data, "lost");
  writeFileSync(join(repo, "MEMORY.md"), `${INDEX}- [Mine](mine.md) — a person's uncommitted rule\n`);
  git(repo, ["add", "--", "MEMORY.md"]);
  const staged = git(repo, ["ls-files", "--stage"]);
  const object = join(repo, ".git", "objects", main.slice(0, 2), main.slice(2));
  const kept = readFileSync(object);
  rmSync(object);
  const lost = await ran(api, "lost");
  await seedFailed(api, data, "lost", lost.runId, lost.prompt);
  assert.match(readFileSync(join(repo, "MEMORY.md"), "utf8"), /a person's uncommitted rule/);
  assert.equal(git(repo, ["ls-files", "--stage"]), staged, "the index is not replaced");
  assert.equal(git(repo, ["for-each-ref", "--format=%(objectname)", "refs/heads/main"]), main);
  // main readable again, and the run's copy that fails.
  writeFileSync(object, kept, { mode: 0o444 });
  learningTestHooks.beforePin = () => {
    throw new Error("the disk is full");
  };
  t.after(() => void (learningTestHooks.beforePin = undefined));
  const full = await ran(api, "lost");
  learningTestHooks.beforePin = undefined;
  await seedFailed(api, data, "lost", full.runId, full.prompt);
});

test("a copy that fails once its pin is in place (the run's directory not synced): the pin goes too, so the run is seed_failed and nothing learned reaches its instructions", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "unsynced", { instructions: "Answer the question." });
  let pinned;
  learningTestHooks.afterPin = (runDir) => {
    pinned = JSON.parse(readFileSync(join(runDir, "learning.json"), "utf8"));
    throw new Error("the run's directory could not be synced");
  };
  t.after(() => void (learningTestHooks.afterPin = undefined));
  const run = await ran(api, "unsynced");
  learningTestHooks.afterPin = undefined;
  assert.equal(pinned?.learned?.trim(), INDEX.trim(), "the pin was in place, with the index, when the copy failed");
  assert.equal(learnedIn(run.prompt), undefined, "no # Learned in the run's instructions");
  await seedFailed(api, data, "unsynced", run.runId, run.prompt);
});

/** A scratch directory holding one file, `kept`, for a planted link to point at (or at its file). */
async function linkTarget(t) {
  const target = await scratch(t);
  writeFileSync(join(target, "kept"), "kept\n");
  return target;
}

/** What the server writes to its stderr while test `t` runs. */
function stderrOf(t) {
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    said.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => void (process.stderr.write = write));
  return said;
}

/** That run `runId` of agent `id` was refused the link it met: seed_failed, the link's target as it was, and the
 *  warning naming a link in the data directory, never the target. */
async function refusedLink(api, data, id, runId, prompt, target, said) {
  await seedFailed(api, data, id, runId, prompt);
  assert.deepEqual(readdirSync(target), ["kept"], "nothing is made where the link points");
  assert.equal(readFileSync(join(target, "kept"), "utf8"), "kept\n", "nothing is written through the link");
  const warning = said.find((text) => text.includes(`the agent ${id}'s learning folder could not be read`)) ?? "";
  assert.match(warning, /is a symbolic link/, said.join(""));
  assert.ok(!warning.includes(target), warning);
}

// A link left in an agent's home before its learning was on, by something that could write there: at the home itself,
// at its learning folder, at the folder's .git, or at MEMORY.md in a folder whose making stopped before main. The host
// refuses it and never follows it, so its git init, writes and commits never land where the link points.
const PLANTED = {
  "homes/<key>": (data, id, target) => (mkdirSync(dirname(homeOf(data, id)), { recursive: true }), symlinkSync(target, homeOf(data, id))),
  "homes/<key>/learning": (data, id, target) => (mkdirSync(homeOf(data, id), { recursive: true }), symlinkSync(target, repoOf(data, id))),
  "learning/.git": (data, id, target) => (mkdirSync(repoOf(data, id), { recursive: true }), symlinkSync(target, join(repoOf(data, id), ".git"))),
  "learning/MEMORY.md": (data, id, target) => (mkdirSync(repoOf(data, id), { recursive: true }), symlinkSync(join(target, "kept"), join(repoOf(data, id), "MEMORY.md"))),
};
for (const [where, plant] of Object.entries(PLANTED)) {
  test(`a symbolic link at ${where}, there before the agent's first run: the run completes with nothing learned, seed_failed, nothing is made or written where the link points, and the warning names the link, not its target`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM });
    const target = await linkTarget(t);
    assert.equal((await api("POST", "/agents", agent("linked", { learning: true, instructions: "Answer the question." }))).status, 201);
    plant(data, "linked", target);
    const said = stderrOf(t);
    const run = await ran(api, "linked");
    await refusedLink(api, data, "linked", run.runId, run.prompt, target, said);
  });
}

test("a link swapped in for the learning folder the host has just made is caught by the check after the mkdir, never followed", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const target = await linkTarget(t);
  assert.equal((await api("POST", "/agents", agent("swapped", { learning: true, instructions: "Answer the question." }))).status, 201);
  const repo = repoOf(data, "swapped");
  learningTestHooks.afterMkdir = (dir) => {
    if (dir !== repo) return;
    rmSync(dir, { recursive: true });
    symlinkSync(target, dir);
  };
  t.after(() => void (learningTestHooks.afterMkdir = undefined));
  const said = stderrOf(t);
  const run = await ran(api, "swapped");
  learningTestHooks.afterMkdir = undefined;
  assert.ok(lstatSync(repo).isSymbolicLink(), "the hook swapped the link in");
  await refusedLink(api, data, "swapped", run.runId, run.prompt, target, said);
});

/** A request's system prompt, as text. */
const systemText = (body) => (typeof body?.system === "string" ? body.system : (body?.system ?? []).map((block) => block?.text ?? "").join("\n"));

test("a claude-agent run on its real adapter: the index is in the system prompt after the instructions, under # Learned, with the revision's skill loaded through the Skill tool and no learned one", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, ["AGENT_MODEL_BASE_URL"]);
  const { api, data } = await serve(t, { faux: undefined });
  // The agent's folder, with main already holding two active notes and a superseded one when its first run is made.
  const repo = repoOf(data, "learner");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "--template=", "--initial-branch=main"]);
  const sha = commitToMain(repo, MAIN);
  const cite = "---\nname: cite\ndescription: How this agent cites its sources.\n---\nCite every source you read.\n";
  const created = await api("POST", "/agents", { ...agent("learner", { learning: true, harness: "claude-agent", model: "anthropic/claude-haiku-4-5", instructions: "Answer the question.", skills: ["cite"] }), skills: { "cite/SKILL.md": cite } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", "/agents/learner/runs", { input: { content: "Answer." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.deepEqual(pinOf(data, run.body.run_id), { seed: sha, learned: INDEX });
  const first = fake.messages().find((m) => m.tools.includes("Skill"));
  assert.ok(first, `the Skill tool is offered: ${JSON.stringify(fake.messages().map((m) => m.tools))}`);
  const system = systemText(first.body);
  assert.equal(learnedIn(system), INDEX.trim(), system.slice(-2000));
  assert.ok(system.includes("Answer the question.\n\n# Learned\n\n"), `the index follows the instructions: ${system.slice(-2000)}`);
  assert.ok(!system.includes("Old refunds"), "a superseded note is never shown");
  assert.ok(JSON.stringify(first.body).includes("agentrun:cite"), "the revision's skill goes as it did");
  assert.ok(!system.includes('<skill name="cite">'), "and is not inlined");
  assert.deepEqual(readdirSync(learnedDir(data, run.body.run_id)).sort(), ["MEMORY.md", "prefers-tables.md", "refund-policy-path.md"]);
});
