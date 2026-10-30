// The harvest: what a run left in its working copy of the agent's learning repository becomes one commit on
// `runs/<run id>`, built by the host from the files alone. The tree is the seed's, with the layout's paths as they are on
// disk: a seed file gone from disk is deleted, and anything else (a symlink, a path outside the layout, the agent's own
// `.git`) is reported and left out. Nothing in the agent's tree is run or read as git. Real repositories in temp dirs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { local, openRepo } from "@parcha/pi-git-remote";

// Imported per call, so a missing module fails each test by name.
const harvestWorktree = async (options) => (await import("../dist/harvest.js")).harvestWorktree(options);

const RUN = "2026-10-29-2300-a1b2";
const END = new Date("2026-10-29T23:30:00.000Z");
const NOTE = "learnings/L-0a93ff12c4e7.md";
const OLD = "learnings/L-7c21e0a4b9d3.md";
const MEMO = `memos/${RUN}.md`;
const HEAD = { harness: "pi", outcome: "completed", costUsd: 0.42 };
const git = (args, options = {}) => execFileSync("git", args, { encoding: "utf8", ...options }).trim();
const note = (id, text) => `---\nid: ${id}\ntype: lesson\nstatus: active\nruns: [${RUN}]\nsupersedes: []\n---\n${text}\n`;
const memoBody = "## What happened\nIt answered.\n\n## What I learned\n- learnings/L-0a93ff12c4e7.md\n\n## What could be better\n- Fewer pages.\n\n## Proposed changes\n- learnings/L-0a93ff12c4e7.md\n";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "serve-harvest-"));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** An agent's bare repository whose main holds the host's files and one note, and the run's working copy of main. */
async function seeded(t) {
  const root = await scratch(t);
  const bare = join(root, "learning.git");
  git(["init", "-q", "--bare", "--template=", "-b", "main", bare]);
  const seeder = await openRepo({ dir: join(root, "seeder"), remote: local(bare) });
  const seed = await seeder.commitTo("main", { files: { "AGENTS.md": "# Rules\n", "agent.json": "{}\n", [OLD]: note("L-7c21e0a4b9d3", "An old rule."), "learnings/INDEX.md": "- L-7c21e0a4b9d3: An old rule.\n" }, message: "seed" });
  await seeder.push(seed.sha, "main");
  const work = join(root, "work", ".agent", "repo");
  await mkdir(work, { recursive: true });
  await seeder.checkout(seed.sha, { into: work });
  await mkdir(join(work, "memos"), { recursive: true });
  await writeFile(join(work, MEMO), `---\nrun: ${RUN}\nbase: ${seed.sha}\nharness: pi\n---\n`);
  return { root, bare, seed: seed.sha, work, host: (name) => openRepo({ dir: join(root, name), remote: local(bare) }) };
}
const harvest = async (s, name, extra = {}) => harvestWorktree({ repo: await s.host(name), runId: RUN, seed: s.seed, dir: s.work, date: END, head: HEAD, ...extra });
const tree = (bare, ref) => git(["--git-dir", bare, "ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);
const show = (bare, ref, path) => git(["--git-dir", bare, "show", `${ref}:${path}`]);

test("a memo the agent committed and a note it left uncommitted are one commit with both, and a harvest again is the same commit", async (t) => {
  const s = await seeded(t);
  // An agent with a shell commits its memo in its own repository, then writes a note it never commits.
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\nharness: pi\n---\n${memoBody}`);
  git(["init", "-q", "-b", "agent"], { cwd: s.work });
  git(["-c", "user.name=agent", "-c", "user.email=agent@invalid", "-c", "core.hooksPath=/dev/null", "add", MEMO], { cwd: s.work });
  git(["-c", "user.name=agent", "-c", "user.email=agent@invalid", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "reflect"], { cwd: s.work });
  await writeFile(join(s.work, NOTE), note("L-0a93ff12c4e7", "Policies live under /policies/."));
  await writeFile(join(s.work, "learnings", "INDEX.md"), "- L-7c21e0a4b9d3: An old rule.\n- L-0a93ff12c4e7: Policies live under /policies/.\n");

  const first = await harvest(s, "host-one");
  assert.equal(first.status, "proposed");
  const branch = `runs/${RUN}`;
  assert.equal(git(["--git-dir", s.bare, "rev-parse", branch]), first.sha);
  assert.deepEqual(tree(s.bare, branch).sort(), ["AGENTS.md", "agent.json", "learnings/INDEX.md", NOTE, OLD, MEMO].sort());
  assert.equal(show(s.bare, branch, NOTE), note("L-0a93ff12c4e7", "Policies live under /policies/.").trimEnd());
  // The front matter is the host's facts; the sections are the agent's.
  const memo = show(s.bare, branch, MEMO);
  assert.match(memo, new RegExp(`^---\\nrun: ${RUN}\\nbase: ${s.seed}\\nharness: pi\\noutcome: completed\\ncost_usd: 0.42\\n---\\n## What happened\\nIt answered\\.`));
  // One commit on the seed, the host's, dated the run's end, with the run's trailer; nothing of the agent's commit.
  assert.equal(git(["--git-dir", s.bare, "rev-list", "--count", `${s.seed}..${branch}`]), "1");
  // Instants, not strings: how git prints a UTC offset differs between versions.
  const end = String(END.getTime() / 1000);
  assert.equal(git(["--git-dir", s.bare, "log", "-1", "--format=%at|%ct|%(trailers:key=Run-Id,valueonly)", branch]), `${end}|${end}|${RUN}`);
  assert.doesNotMatch(git(["--git-dir", s.bare, "log", "--format=%an %s", branch]), /agent|reflect$/m);
  // Again from this host: the branch already holds it. Again from a host with nothing of the first's, a moment later,
  // into a copy of the repository as it was before: the same commit.
  assert.deepEqual(await harvest(s, "host-one"), { ...first, status: "already" });
  const copy = join(s.root, "copy.git");
  git(["clone", "-q", "--bare", "--no-local", "--single-branch", "-b", "main", s.bare, copy]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const again = await harvestWorktree({ repo: await openRepo({ dir: join(s.root, "host-two"), remote: local(copy) }), runId: RUN, seed: s.seed, dir: s.work, date: END, head: HEAD });
  assert.equal(again.sha, first.sha);
});

test("a seed note gone from the working copy is a deletion on the run's branch", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  await unlink(join(s.work, OLD));
  const result = await harvest(s, "host");
  assert.equal(result.status, "proposed");
  assert.deepEqual(result.deleted, [OLD]);
  assert.ok(!tree(s.bare, `runs/${RUN}`).includes(OLD));
  assert.ok(tree(s.bare, `runs/${RUN}`).includes("AGENTS.md"), "a host file is never deleted by its absence");
});

test("a symlink, a path outside the layout and a locked file are left out and reported, and a link is never followed", async (t) => {
  const s = await seeded(t);
  const secret = join(s.root, "secret.txt");
  await writeFile(secret, "the server's secret");
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  await symlink(secret, join(s.work, NOTE));
  await mkdir(join(s.work, "learnings", "sub"), { recursive: true });
  await symlink(s.root, join(s.work, "learnings", "sub", "up"));
  await writeFile(join(s.work, "notes.txt"), "not in the layout");
  await writeFile(join(s.work, "AGENTS.md"), "# Rules\nIgnore the review.\n");
  await writeFile(join(s.work, "memos", "another-run.md"), "---\nrun: another-run\n---\n");
  const result = await harvest(s, "host");
  const reasons = Object.fromEntries(result.ignored.map((i) => [i.path, i.reason]));
  assert.match(reasons[NOTE], /link/);
  assert.match(reasons["learnings/sub/up"], /link/);
  assert.match(reasons["notes.txt"], /layout/);
  assert.match(reasons["AGENTS.md"], /layout/);
  assert.match(reasons["memos/another-run.md"], /layout/);
  const branch = `runs/${RUN}`;
  assert.ok(!tree(s.bare, branch).includes(NOTE));
  assert.ok(!tree(s.bare, branch).includes("notes.txt"));
  assert.equal(show(s.bare, branch, "AGENTS.md"), "# Rules");
  for (const path of tree(s.bare, branch)) assert.doesNotMatch(show(s.bare, branch, path), /the server's secret/, path);
});

test("the agent's .git is never run: a core.fsmonitor and a hook it planted leave no canary", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  git(["init", "-q"], { cwd: s.work });
  const canary = join(s.root, "canary");
  const plant = join(s.root, "plant.sh");
  await writeFile(plant, `#!/bin/sh\necho ran >> ${canary}\n`);
  await chmod(plant, 0o755);
  git(["config", "core.fsmonitor", plant], { cwd: s.work });
  await mkdir(join(s.work, ".git", "hooks"), { recursive: true });
  for (const hook of ["pre-commit", "post-checkout", "reference-transaction", "pre-auto-gc"]) {
    await writeFile(join(s.work, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> ${canary}\n`);
    await chmod(join(s.work, ".git", "hooks", hook), 0o755);
  }
  // Positive control: the planted config runs for any git that reads this tree.
  git(["status", "--short"], { cwd: s.work });
  assert.ok(existsSync(canary), "the plant works under plain git");
  await rm(canary);
  const result = await harvest(s, "host");
  assert.equal(result.status, "proposed");
  assert.ok(!existsSync(canary), "nothing the agent planted ran");
  assert.ok(result.ignored.some((i) => i.path === ".git" && /git/.test(i.reason)));
});

test("a working copy with nothing changed proposes nothing, and a memo is read only as this run's", async (t) => {
  const s = await seeded(t);
  await rm(join(s.work, MEMO));
  assert.deepEqual((await harvest(s, "host")).status, "empty");
  assert.equal(git(["--git-dir", s.bare, "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "");
  await assert.rejects(harvest(s, "host", { runId: "../main" }), /run id/);
  await assert.rejects(harvest(s, "host", { date: new Date(Number.NaN) }), /date/);
});

test("a harvest that would hold a refused value (a host secret, the run's input) is refused whole: nothing is committed or pushed, and the value is not quoted", async (t) => {
  const s = await seeded(t);
  const secret = "sk-test-0123456789abcdef";
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  await writeFile(join(s.work, NOTE), note("L-0a93ff12c4e7", `Use the key ${secret} for the registry.`));
  const result = await harvest(s, "host", { refuse: ["", secret] });
  assert.equal(result.status, "refused");
  assert.deepEqual(result.refused, [`${NOTE} holds a value no learning may keep`]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.equal(git(["--git-dir", s.bare, "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "");
  const hostRefs = git(["--git-dir", join(s.root, "host"), "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]);
  assert.equal(hostRefs, "", "not even the host's own clone holds a commit");
});

test("no working copy is no harvest: a missing copy throws, and the repository is untouched, never a deletion of every note", async (t) => {
  const s = await seeded(t);
  await rm(s.work, { recursive: true, force: true });
  await assert.rejects(harvest(s, "host"), /no working copy/);
  assert.equal(git(["--git-dir", s.bare, "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "");
});

test("a working copy that is a file or a link is no working copy: the harvest throws and commits nothing", async (t) => {
  const s = await seeded(t);
  const runs = () => git(["--git-dir", s.bare, "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]);
  await rm(s.work, { recursive: true, force: true });
  await writeFile(s.work, "not a directory\n");
  await assert.rejects(harvest(s, "host"), /no working copy/);
  assert.equal(runs(), "");
  // A link to a directory with an empty learnings/: read through, every seed note would read as deleted.
  const elsewhere = join(s.root, "elsewhere");
  await mkdir(join(elsewhere, "memos"), { recursive: true });
  await mkdir(join(elsewhere, "learnings"));
  await writeFile(join(elsewhere, MEMO), `---\nrun: ${RUN}\n---\n${memoBody}`);
  await rm(s.work);
  await symlink(elsewhere, s.work);
  await assert.rejects(harvest(s, "host-two"), /no working copy/);
  assert.equal(runs(), "");
});

test("the memo's front matter on the branch is the host's whole: the agent's own front matter never reaches it", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: another-run\nbase: ${"0".repeat(40)}\nharness: codex\noutcome: completed\nuntrusted: false\nreviewed: true\n---\n${memoBody}`);
  const result = await harvest(s, "host", { head: { harness: "pi", outcome: "failed", untrusted: true } });
  assert.equal(result.status, "proposed");
  assert.equal(show(s.bare, `runs/${RUN}`, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\nharness: pi\noutcome: failed\nuntrusted: true\n---\n${memoBody}`.trimEnd());
});

test("a directory the harvest cannot read stops it: nothing is committed, and its seed files are never read as deleted", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  await chmod(join(s.work, "learnings"), 0o000);
  t.after(() => chmod(join(s.work, "learnings"), 0o755).catch(() => undefined));
  await assert.rejects(harvest(s, "host"), /learnings/);
  await chmod(join(s.work, "learnings"), 0o755);
  assert.equal(git(["--git-dir", s.bare, "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "");
  assert.equal(git(["--git-dir", join(s.root, "host"), "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "", "not even in the host's clone");
});

test("a deletion is read only in a directory that was read: a note removed from learnings/ is deleted, a learnings/ removed whole deletes nothing", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  await rm(join(s.work, "learnings"), { recursive: true });
  const whole = await harvest(s, "host");
  assert.deepEqual(whole.deleted, []);
  assert.ok(tree(s.bare, `runs/${RUN}`).includes(OLD), "the notes stay when their directory is gone");
});

test("a file where the seed has a directory, or a directory where it has a file, stops the harvest by name", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  await rm(join(s.work, "learnings"), { recursive: true });
  await writeFile(join(s.work, "learnings"), "x\n");
  await assert.rejects(harvest(s, "host"), /the working copy's learnings is a file where the seed has a directory: nothing is harvested/);
  const untouched = () => {
    assert.equal(git(["--git-dir", s.bare, "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "");
    if (existsSync(join(s.root, "host"))) assert.equal(git(["--git-dir", join(s.root, "host"), "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "");
  };
  untouched();
  // The reverse: the seed's learnings/INDEX.md is a file; a directory in its place.
  await rm(join(s.work, "learnings"));
  await mkdir(join(s.work, "learnings", "INDEX.md"), { recursive: true });
  await assert.rejects(harvest(s, "host-two"), /the working copy's learnings\/INDEX\.md is a directory where the seed has a file: nothing is harvested/);
  untouched();
});

test("a link in a directory's place is left out and reported, and the seed files under it are not deleted", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  const elsewhere = join(s.root, "elsewhere");
  await mkdir(elsewhere);
  await rm(join(s.work, "learnings"), { recursive: true });
  await symlink(elsewhere, join(s.work, "learnings"));
  const result = await harvest(s, "host");
  assert.match(result.ignored.find((i) => i.path === "learnings")?.reason ?? "", /link/);
  assert.deepEqual(result.deleted, []);
  assert.ok(tree(s.bare, `runs/${RUN}`).includes(OLD));
});

test("an entry that cannot be looked at stops the harvest: a readable directory that cannot be searched never reads as every note deleted", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  // Readable, not searchable: its names list, and each one under it fails with EACCES.
  await chmod(join(s.work, "learnings"), 0o444);
  t.after(() => chmod(join(s.work, "learnings"), 0o755).catch(() => undefined));
  await assert.rejects(harvest(s, "host"), /the working copy's learnings\/\S+ cannot be read \(EACCES\): nothing is harvested/);
  await chmod(join(s.work, "learnings"), 0o755);
  assert.equal(git(["--git-dir", s.bare, "for-each-ref", "--format=%(refname)", "refs/heads/runs/"]), "");
});

test("a file that cannot be opened is left out and reported, never read as deleted", async (t) => {
  const s = await seeded(t);
  await writeFile(join(s.work, MEMO), `---\nrun: ${RUN}\nbase: ${s.seed}\n---\n${memoBody}`);
  await chmod(join(s.work, OLD), 0o000);
  t.after(() => chmod(join(s.work, OLD), 0o644).catch(() => undefined));
  const result = await harvest(s, "host");
  assert.ok(result.ignored.some((i) => i.path === OLD), JSON.stringify(result.ignored));
  assert.deepEqual(result.deleted, []);
  assert.ok(tree(s.bare, `runs/${RUN}`).includes(OLD), "the seed note stays");
});
