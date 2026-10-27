import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBranch } from "../dist/index.js";
import { BRANCH, NOTE_ID, OLD_NOTE, RUN, cleanFiles, index, memo, note, workflow } from "./support.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

async function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    if (text === null) { await rm(file, { force: true }); continue; }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** A repository whose main holds the rules and one note, with the run's branch checked out holding `files`. Returns the
 *  directory and main's commit. */
async function repo(t, files = cleanFiles(), { branch = BRANCH } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agentrun-learn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  await write(dir, { "AGENTS.md": "# Rules\n", "agent.json": "{}\n", "learnings/INDEX.md": index([OLD_NOTE]), [`learnings/${OLD_NOTE}.md`]: note({ id: OLD_NOTE, runs: "[2026-10-20-0100-ffff]" }) });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main");
  const main = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", branch);
  const withBase = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, path === `memos/${RUN}.md` && text !== null ? text.replace(/^base: \S+/m, `base: ${main.slice(0, 7)}`) : text]));
  await write(dir, { ...withBase, "learnings/INDEX.md": index([OLD_NOTE, NOTE_ID]) });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "run");
  return { dir, main };
}

const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...GIT_ENV, ...env }, encoding: "utf8" });

test("agentrun-learn check passes a clean run's branch, reading the run from HEAD", async (t) => {
  const { dir } = await repo(t);
  const out = cli(dir, ["check", "--base", "main"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`${BRANCH}: ok`));
});

test("agentrun-learn check refuses a branch that changes AGENTS.md, naming the rule and the file", async (t) => {
  const { dir } = await repo(t, { ...cleanFiles(), "AGENTS.md": "# New rules\n" });
  const out = cli(dir, ["check", "--base", "main"]);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /untouched\s+AGENTS\.md/);
});

test("agentrun-learn check refuses a Codex-only and a Pi-only tool in a draft, and passes a clean one", async (t) => {
  for (const [tool, status] of [["exec_command", 1], ["bash", 1], ["fetch_page", 0]]) {
    const { dir } = await repo(t, { ...cleanFiles(), "workflows/find-policies/workflow.json": workflow({ tools: [tool] }) });
    const out = cli(dir, ["check", "--base", "main"]);
    assert.equal(out.status, status, `${tool}: ${out.stdout}${out.stderr}`);
    if (status) assert.match(out.stdout, new RegExp(`harness_tool\\s+workflows/find-policies/workflow\\.json.*${tool}`));
  }
});

test("--refuse-values-from-env refuses a file that holds the variable's value, and never prints it", async (t) => {
  const value = "s3cret-store-pass-7731";
  const { dir } = await repo(t, { ...cleanFiles(), [`learnings/${NOTE_ID}.md`]: note({ body: `The admin password is ${value}.` }) });
  const out = cli(dir, ["check", "--base", "main", "--refuse-values-from-env", "STORE_PASS,UNSET_NAME", "--json"], { STORE_PASS: value });
  assert.equal(out.status, 1);
  assert.ok(!out.stdout.includes(value) && !out.stderr.includes(value));
  const report = JSON.parse(out.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.problems.map((p) => [p.rule, p.path]), [["secret_value", `learnings/${NOTE_ID}.md`]]);
  assert.match(out.stderr, /UNSET_NAME is not set/);
  assert.equal(cli(dir, ["check", "--base", "main", "--refuse-values-from-env", "STORE_PASS"], { STORE_PASS: "other-value-123456" }).status, 0);
});

test("a pre-push hook checks a commit by sha with the branch it is pushed to", async (t) => {
  const { dir } = await repo(t);
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "--detach");
  assert.equal(cli(dir, ["check", "--base", "main", "--head", head, "--branch", BRANCH]).status, 0);
  const unnamed = cli(dir, ["check", "--base", "main", "--head", head]);
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stdout, /branch/);
  const wrong = cli(dir, ["check", "--base", "main", "--head", head, "--branch", "main"]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /branch/);
});

test("the memo's base must be the commit the branch starts from", async (t) => {
  const { dir } = await repo(t);
  await write(dir, { [`memos/${RUN}.md`]: memo({ base: "0000000" }) });
  git(dir, "commit", "-q", "-am", "wrong base");
  const out = cli(dir, ["check", "--base", "main"]);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /memo_base/);
});

test("a symlink on the branch is refused as a file mode, never followed", async (t) => {
  const { dir } = await repo(t);
  await symlink("/etc/hostname", join(dir, ".agents/skills/find-policies/extra"));
  await rm(join(dir, ".agents/skills/find-policies/SKILL.md"));
  await symlink("/etc/hostname", join(dir, ".agents/skills/find-policies/SKILL.md"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "links");
  const report = await checkBranch({ cwd: dir, base: "main" });
  assert.deepEqual(report.problems.map((p) => [p.rule, p.path]).sort(), [["file_mode", ".agents/skills/find-policies/SKILL.md"], ["outside_layout", ".agents/skills/find-policies/extra"]]);
});

test("checkBranch reports the run, the branch and the fork point", async (t) => {
  const { dir, main } = await repo(t);
  const report = await checkBranch({ cwd: dir, base: "main" });
  assert.deepEqual({ ...report, problems: report.problems }, { run: RUN, branch: BRANCH, forkPoint: main, problems: [] });
});

test("agentrun-learn prints its usage on a bad command line and exits 2", async (t) => {
  const { dir } = await repo(t);
  for (const args of [[], ["check"], ["check", "--base"], ["check", "--base", "main", "--nope"], ["other"]]) {
    const out = cli(dir, args);
    assert.equal(out.status, 2, args.join(" "));
    assert.match(out.stderr, /usage: agentrun-learn check --base <ref>/);
  }
  assert.equal(cli(dir, ["check", "--base", "no-such-ref"]).status, 2);
  assert.equal(cli(dir, ["--help"]).status, 0);
});
