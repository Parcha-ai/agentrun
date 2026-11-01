// Each agent has a learning repository, `<data>/homes/<agent id>/learning/`, and an agentic run starts from what its main
// holds: main's commit pinned in the run's directory, its index in the run's instructions and its skills beside the
// revision's, on pi and on another harness alike. The server is the repository's only writer, and no hook runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { learningTestHooks } from "../dist/learning.js";
import { agent, follow, scratch, serve, storeRun, withEnv } from "./support.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;
const NOTE = "- L-0123456789ab: Shopify stores keep their policies at /policies/; try that path first.";
const SKILL = "---\nname: find-policies\ndescription: Finds a store's policies.\n---\nOpen /policies/ before searching the site.\n";

/** git in the test's own hands: no hook, and no system or global config. */
function git(cwd, args) {
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "person", GIT_AUTHOR_EMAIL: "person@example.invalid", GIT_COMMITTER_NAME: "person", GIT_COMMITTER_EMAIL: "person@example.invalid" };
  const out = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

const repoOf = (data, id) => join(data, "homes", id, "learning");
const pinOf = (data, runId) => JSON.parse(readFileSync(join(data, "runs", runId, "learning.json"), "utf8"));
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";
/** The `<learned>` section of a prompt, or undefined. */
const learnedIn = (prompt) => /<learned>\n([\s\S]*?)\n<\/learned>/.exec(prompt)?.[1];
/** Each `<skill>` of a prompt, by name. */
const skillsIn = (prompt) => [...prompt.matchAll(/<skill name="([^"]+)">\n([\s\S]*?)\n<\/skill>/g)].map(([, name, text]) => [name, text]);

/** Commits `files` on main, in the repository's working tree, as a merge into main would leave it. Its commit. */
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

/** Agent `id`, created, and its learning repository made by a first run, with `files` then committed on main. */
async function learned(api, data, id, extra = {}, skills, files = { "learnings/INDEX.md": `# Learnings\n${NOTE}\n`, "learnings/L-0123456789ab.md": "---\nid: L-0123456789ab\ntype: lesson\nstatus: active\nruns: [r1]\nsupersedes: []\n---\nShopify stores keep their policies at /policies/.\n", ".agents/skills/find-policies/SKILL.md": SKILL }) {
  assert.equal((await api("POST", "/agents", { ...agent(id, extra), ...(skills ? { skills } : {}) })).status, 201);
  await ran(api, id);
  return commitToMain(repoOf(data, id), files);
}

test("a new agent's first run makes its learning repository: main checked out, one host commit holding learnings/INDEX.md alone, and no learned section in the run's prompt", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("fresh", { instructions: "Answer the question." }))).status, 201);
  const { runId, prompt } = await ran(api, "fresh");
  const repo = repoOf(data, "fresh");
  assert.equal(git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
  assert.equal(git(repo, ["log", "-1", "--format=%an <%ae>", "main"]), "agentrun-serve <serve@agentrun.invalid>");
  assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["learnings/INDEX.md"]);
  assert.equal(git(repo, ["show", "main:learnings/INDEX.md"]), "# Learnings");
  // Any reader sees main's files: the working tree and the index are main's.
  assert.equal(readFileSync(join(repo, "learnings", "INDEX.md"), "utf8"), "# Learnings\n");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.deepEqual(readdirSync(join(data, "homes", "fresh")), ["learning"]);
  assert.deepEqual(pinOf(data, runId), { seed: git(repo, ["rev-parse", "main"]), skills: [] });
  assert.ok(prompt.includes("Answer the question."), prompt);
  assert.equal(learnedIn(prompt), undefined, "an index with no note line adds no section");
  assert.ok(!prompt.includes("<learned>") && !prompt.includes("# Learnings"), prompt);
});

for (const harness of ["pi", "claude-agent"]) {
  test(`a ${harness} run is seeded from main's commit, never the working tree: its index in a <learned> section and its skill beside the revision's`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, fauxHarness: SYSTEM });
    const id = `seeded-${harness}`;
    const sha = await learned(api, data, id, { harness, instructions: "Answer the question." });
    // Uncommitted edits in the working tree: what a run reads is main's commit, never these.
    const repo = repoOf(data, id);
    writeFileSync(join(repo, "learnings", "INDEX.md"), `# Learnings\n${NOTE}\n- L-ffffffffffff: an uncommitted rule.\n`);
    writeFileSync(join(repo, ".agents", "skills", "find-policies", "SKILL.md"), "an uncommitted skill\n");
    mkdirSync(join(repo, ".agents", "skills", "loose"), { recursive: true });
    writeFileSync(join(repo, ".agents", "skills", "loose", "SKILL.md"), "---\nname: loose\ndescription: Never committed.\n---\nLoose.\n");
    const { runId, prompt } = await ran(api, id);
    assert.deepEqual(pinOf(data, runId), { seed: sha, skills: ["find-policies"], learned: `# Learnings\n${NOTE}\n` });
    assert.equal(learnedIn(prompt), `# Learnings\n${NOTE}`, prompt);
    assert.deepEqual(skillsIn(prompt), [["find-policies", SKILL.trim()]]);
    assert.ok(!prompt.includes("uncommitted") && !prompt.includes("Loose."), prompt);
    assert.equal(readFileSync(join(data, "runs", runId, "work", ".agents", "skills", "find-policies", "SKILL.md"), "utf8"), SKILL);
  });
}

test("the pin: a run keeps the commit it was made from when main moves on, through a continue in a new process", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const sha = await learned(api, data, "pinned");
  const { runId, prompt } = await ran(api, "pinned");
  const pin = readFileSync(join(data, "runs", runId, "learning.json"), "utf8");
  assert.equal(JSON.parse(pin).seed, sha);
  const later = commitToMain(repoOf(data, "pinned"), { "learnings/INDEX.md": `# Learnings\n${NOTE}\n- L-abcdefabcdef: a rule main learned after the run was made.\n`, ".agents/skills/find-policies/SKILL.md": `${SKILL}A line main learned later.\n` });
  assert.notEqual(later, sha);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again?" })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const again = await answer(api, runId);
  assert.equal(readFileSync(join(data, "runs", runId, "learning.json"), "utf8"), pin, "the pin is never written again");
  assert.equal(learnedIn(again), learnedIn(prompt));
  assert.ok(!again.includes("abcdefabcdef") && !again.includes("learned later"), again);
  // A run made now starts from the new main.
  const next = await ran(api, "pinned");
  assert.equal(pinOf(data, next.runId).seed, later);
  assert.ok(learnedIn(next.prompt).includes("L-abcdefabcdef"), next.prompt);
});

test("a revision's skill and a learned skill of the same name: the revision's text wins, and the learned one is skipped; so is one a revision's file is named as", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const own = "---\nname: find-policies\ndescription: The revision's own.\n---\nAsk the store's support desk.\n";
  const checklist = "---\nname: checklist\ndescription: Learned.\n---\nA learned checklist.\n";
  const files = { "learnings/INDEX.md": `# Learnings\n${NOTE}\n`, ".agents/skills/find-policies/SKILL.md": SKILL, ".agents/skills/checklist/SKILL.md": checklist };
  await learned(api, data, "clash", { skills: ["find-policies"] }, { "find-policies/SKILL.md": own, checklist: "the revision's own file\n" }, files);
  const { runId, prompt } = await ran(api, "clash");
  assert.deepEqual(skillsIn(prompt), [["find-policies", own.trim()]]);
  assert.ok(!prompt.includes("Open /policies/ before searching") && !prompt.includes("A learned checklist."), prompt);
  assert.deepEqual(pinOf(data, runId).skills, []);
  const skills = join(data, "runs", runId, "work", ".agents", "skills");
  assert.equal(readFileSync(join(skills, "find-policies", "SKILL.md"), "utf8"), own);
  assert.equal(readFileSync(join(skills, "checklist"), "utf8"), "the revision's own file\n");
});

test("a commit main holds that git cannot read refuses the run, with nothing made", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  await learned(api, data, "broken");
  const repo = repoOf(data, "broken");
  const blob = git(repo, ["rev-parse", "main:.agents/skills/find-policies/SKILL.md"]);
  rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const before = (await api("GET", "/agents/broken/runs")).body.runs.length;
  const refused = await api("POST", "/agents/broken/runs", { input: { content: "hi" } });
  assert.equal(refused.status, 500, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "internal");
  assert.match(refused.body.error.message, /learning repository could not be read/);
  assert.equal((await api("GET", "/agents/broken/runs")).body.runs.length, before, "no run was made");
});

test("a main whose commit git cannot read refuses the run, and the repository's working tree and index are left as they were", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  const main = await learned(api, data, "lost");
  const repo = repoOf(data, "lost");
  writeFileSync(join(repo, "learnings", "INDEX.md"), `# Learnings\n${NOTE}\n- L-eeeeeeeeeeee: a person's uncommitted rule.\n`);
  git(repo, ["add", "--", "learnings/INDEX.md"]);
  const staged = git(repo, ["ls-files", "--stage"]);
  rmSync(join(repo, ".git", "objects", main.slice(0, 2), main.slice(2)));
  const refused = await api("POST", "/agents/lost/runs", { input: { content: "hi" } });
  assert.equal(refused.status, 500, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /learning repository could not be read/);
  assert.match(readFileSync(join(repo, "learnings", "INDEX.md"), "utf8"), /a person's uncommitted rule/);
  assert.equal(git(repo, ["ls-files", "--stage"]), staged, "the index is not replaced");
  assert.equal(git(repo, ["for-each-ref", "--format=%(objectname)", "refs/heads/main"]), main);
});

test("a run whose learned files cannot be written ends failed in the store, never left running with no process", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("unwritten"))).status, 201);
  let made;
  learningTestHooks.beforePin = (runDir) => {
    made = runDir.split("/").at(-1);
    throw new Error("the disk is full");
  };
  t.after(() => void (learningTestHooks.beforePin = undefined));
  const refused = await api("POST", "/agents/unwritten/runs", { input: { content: "hi" } });
  learningTestHooks.beforePin = undefined;
  assert.equal(refused.status, 500, JSON.stringify(refused.body));
  const row = storeRun(data, made);
  assert.equal(row.state, "failed");
  assert.match(row.summary, /could not be set up: the disk is full/);
});

test("two runs of a new agent made at once: one repository made, one commit on main, and both runs seeded from it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM });
  assert.equal((await api("POST", "/agents", agent("twice"))).status, 201);
  const made = await Promise.all([1, 2].map(() => api("POST", "/agents/twice/runs", { input: { content: "hi" } })));
  for (const run of made) assert.equal(run.status, 202, JSON.stringify(run.body));
  for (const run of made) await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const repo = repoOf(data, "twice");
  const main = git(repo, ["rev-parse", "main"]);
  assert.equal(git(repo, ["rev-list", "--count", "--all"]), "1");
  assert.equal(git(repo, ["reflog", "show", "--format=%H", "refs/heads/main"]), main, "main was set once");
  assert.deepEqual(made.map((run) => pinOf(data, run.body.run_id).seed), [main, main]);
  assert.deepEqual(readdirSync(join(data, "homes", "twice")), ["learning"]);
});

test("no hook runs on the host's git calls: neither the repository's own (its hooks folder, core.hooksPath, an fsmonitor) nor a template, hooks folder or config the environment names", { timeout: 120_000 }, async (t) => {
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
  // A repository whose making stopped before main, with hooks of its own: the host finishes it there.
  const planted = repoOf(data, "planted");
  mkdirSync(planted, { recursive: true });
  git(planted, ["init", "-q", "--template=", "--initial-branch=main"]);
  for (const name of NAMES) hook(join(planted, ".git", "hooks", name)), hook(join(dir, "own-hooks", name));
  git(planted, ["config", "core.hooksPath", join(dir, "own-hooks")]);
  git(planted, ["config", "core.fsmonitor", join(dir, "fsmonitor")]);
  for (const id of ["planted", "fresh"]) {
    assert.equal((await api("POST", "/agents", agent(id))).status, 201);
    // The first run makes main; the second reads it.
    for (const _ of [1, 2]) await ran(api, id);
    const repo = repoOf(data, id);
    assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
    assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["learnings/INDEX.md"]);
    assert.equal(git(repo, ["status", "--porcelain"]), "", "the checkout shows main, finished");
  }
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  assert.equal(existsSync(join(repoOf(data, "fresh"), ".git", "hooks")), false, "no template was copied");
});
