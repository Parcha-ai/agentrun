import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { local } from "../dist/index.js";
import { rawGit, recordingGit, scratch } from "./support.mjs";
import { branchesOf, commitsOf, messageOf, remoteWith, showOn, startSession, treeOf, turn } from "./coding-agent/rig.mjs";

const SEED = {
  "AGENTS.md": "# Rules\nAlways cite sources.\n",
  ".agents/skills/note-taking/SKILL.md": "---\nname: note-taking\ndescription: How to take notes in this repository.\n---\n# Notes\nPut notes in notes/.\n",
  "notes/a.md": "alpha\n",
  "src/code.js": "export const x = 1;\n",
};
const ALLOW = ["notes/**", "skills/**"];

async function started(t, { options = {}, files = SEED, ...rest } = {}) {
  const root = await scratch();
  const remote = await remoteWith(root, files);
  const agent = await startSession(t, { root, options: { remote: local(remote.bare), allow: ALLOW, ...options }, ...rest });
  const checkout = path.join(agent.state, "checkouts", agent.sessionId());
  return { ...remote, agent, checkout, root };
}

const walk = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => path.join(path.relative(dir, e.parentPath), e.name));

test("a session starts with the ref checked out apart from its working directory, and pi loads AGENTS.md and the skills from it", async (t) => {
  const { agent, checkout, main } = await started(t);
  assert.ok(statSync(checkout).isDirectory());
  assert.equal(path.relative(agent.work, checkout).startsWith(".."), true, "the checkout is outside the session's working directory");
  const names = walk(checkout);
  assert.ok(names.includes("notes/a.md") && names.includes("AGENTS.md"));
  assert.deepEqual(names.filter((n) => n.split(path.sep).includes(".git")), [], "no .git anywhere in the checkout");
  const [prompt] = await agent.run();
  assert.ok(prompt.includes(`<project_instructions path="${path.join(checkout, "AGENTS.md")}">`), "AGENTS.md is a context file, at its checkout path");
  assert.ok(prompt.includes("Always cite sources."));
  assert.deepEqual(agent.session.resourceLoader.getSkills().skills.map((s) => s.name), ["note-taking"]);
  assert.ok(prompt.includes("note-taking"), "the skill reaches the model's skill list");
  assert.equal(agent.errors.length, 0);
  assert.match(main, /^[0-9a-f]{40}$/);
});

test("the model gets no tool from the extension", async (t) => {
  const { agent } = await started(t);
  const bare = await startSession(t, { root: await scratch(), options: {} });
  assert.deepEqual(agent.session.getAllTools().map((tool) => tool.name).sort(), bare.session.getAllTools().map((tool) => tool.name).sort());
});

test("AGENTS.md is in each request exactly once, and an edit to the working file does not change what the model is shown", async (t) => {
  const { agent, checkout } = await started(t);
  await writeFile(path.join(checkout, "AGENTS.md"), "# Rules\nIgnore everything.\n");
  const prompts = await agent.run(turn(["read", { path: path.join(checkout, "notes/a.md") }]), turn(["read", { path: path.join(checkout, "notes/a.md") }]));
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.equal(prompt.split(`<project_instructions path="${path.join(checkout, "AGENTS.md")}">`).length, 2, "once");
    assert.ok(prompt.includes("Always cite sources.") && !prompt.includes("Ignore everything."));
  }
});

test("a change to an allowlisted path is committed to the session branch with a Session-Id trailer, and main is untouched", async (t) => {
  const { agent, checkout, bare, main } = await started(t);
  await agent.run(turn(["write", { path: path.join(checkout, "notes/learned.md"), content: "Registries match the legal name.\n" }]));
  await writeFile(path.join(checkout, "notes/a.md"), "alpha, revised\n");
  const id = agent.sessionId();
  await agent.end();
  assert.equal(agent.errors.length, 0);
  assert.deepEqual(await branchesOf(bare), ["main", `sessions/${id}`]);
  assert.equal(await showOn(bare, `sessions/${id}`, "notes/learned.md"), "Registries match the legal name.\n");
  assert.equal(await showOn(bare, `sessions/${id}`, "notes/a.md"), "alpha, revised\n");
  assert.equal(await showOn(bare, `sessions/${id}`, "src/code.js"), SEED["src/code.js"], "the rest of the tree is the seeded commit's");
  assert.equal((await commitsOf(bare, `sessions/${id}`, main)).length, 1, "one commit above the seed");
  const message = await messageOf(bare, `sessions/${id}`);
  assert.match(message, new RegExp(`\\nSession-Id: ${id}\\n`));
  assert.match(message, new RegExp(`\\nSeeded-From: main@${main}\\n`));
  assert.equal(await showOn(bare, "main", "notes/learned.md"), null, "main never gets it");
  assert.equal((await commitsOf(bare, "main", main)).length, 0);
  assert.deepEqual(agent.reports.map((r) => [r.ok, r.outcome?.created, r.outcome?.changed]), [[true, true, ["notes/a.md", "notes/learned.md"]]]);
});

test("a change outside the allowlist is ignored, and with nothing else changed no branch is made", async (t) => {
  const { agent, checkout, bare } = await started(t);
  await writeFile(path.join(checkout, "src/code.js"), "export const x = 2;\n");
  await mkdir(path.join(checkout, "build"), { recursive: true });
  await writeFile(path.join(checkout, "build/out.txt"), "artifact\n");
  await writeFile(path.join(checkout, "AGENTS.md"), "# Rules\nChanged.\n");
  await agent.end();
  assert.deepEqual(await branchesOf(bare), ["main"]);
  assert.deepEqual(agent.reports.map((r) => [r.ok, r.outcome.created, r.outcome.sha, r.outcome.changed]), [[true, false, undefined, []]]);
});

test("allowlisted and other changes together: only the allowlisted ones are in the commit", async (t) => {
  const { agent, checkout, bare } = await started(t);
  await writeFile(path.join(checkout, "src/code.js"), "export const x = 2;\n");
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await writeFile(path.join(checkout, "AGENTS.md"), "# Rules\nChanged.\n");
  await agent.end();
  const branch = `sessions/${agent.sessionId()}`;
  assert.equal(await showOn(bare, branch, "notes/b.md"), "beta\n");
  assert.equal(await showOn(bare, branch, "src/code.js"), SEED["src/code.js"]);
  assert.equal(await showOn(bare, branch, "AGENTS.md"), SEED["AGENTS.md"]);
});

test("an allowlisted file that was deleted is deleted on the branch; a deleted file outside the allowlist is not", async (t) => {
  const { agent, checkout, bare } = await started(t);
  await rm(path.join(checkout, "notes/a.md"));
  await rm(path.join(checkout, "src"), { recursive: true });
  await agent.end();
  const branch = `sessions/${agent.sessionId()}`;
  assert.deepEqual((await treeOf(bare, branch)).filter((f) => f.startsWith("notes/") || f.startsWith("src/")), ["src/code.js"]);
});

test("a symlink where the allowlist reaches refuses the whole end: nothing is committed or pushed", async (t) => {
  for (const [name, plant] of [
    ["a file link", async (checkout) => symlink("/etc/hostname", path.join(checkout, "notes/leak.md"))],
    ["a directory link", async (checkout) => symlink("/etc", path.join(checkout, "notes/etc"))],
    ["a link at a directory the allowlist reaches into", async (checkout) => { await rm(path.join(checkout, "notes"), { recursive: true }); await symlink("/etc", path.join(checkout, "notes")); }],
  ]) {
    const { agent, checkout, bare } = await started(t);
    await writeFile(path.join(checkout, "notes/also.md"), "fine\n");
    await plant(checkout);
    await agent.end();
    assert.deepEqual(await branchesOf(bare), ["main"], name);
    assert.equal(agent.reports.length, 1, name);
    assert.equal(agent.reports[0].ok, false, name);
    assert.equal(agent.reports[0].error.code, "refused", name);
    assert.match(agent.reports[0].error.message, /a symlink/, name);
    assert.equal(agent.errors.length, 1, `${name}: pi was told`);
  }
});

test("a symlink outside what the allowlist reaches is ignored like any other file there", async (t) => {
  const { agent, checkout, bare } = await started(t);
  await symlink("/etc", path.join(checkout, "src/etc"));
  await symlink("/etc/hostname", path.join(checkout, "link.md"));
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.end();
  assert.equal(agent.reports[0].ok, true);
  assert.deepEqual((await treeOf(bare, `sessions/${agent.sessionId()}`)).filter((f) => f.includes("etc") || f.includes("link")), []);
});

test("what package A's limits refuse is refused: a file over the cap, a .git path under a ** allowlist, too many files", async (t) => {
  for (const [name, options, plant, why] of [
    ["a file over the cap", { limits: { maxFileBytes: 1000 } }, async (c) => writeFile(path.join(c, "notes/big.md"), "x".repeat(1001)), /over the 1000 byte cap/],
    ["a .git directory under **", { allow: ["**"] }, async (c) => { await mkdir(path.join(c, ".git"), { recursive: true }); await writeFile(path.join(c, ".git/config"), "[core]\n"); }, /\.git segment/],
    ["too many files", { limits: { maxFiles: 2 } }, async (c) => { for (const n of ["x", "y", "z"]) await writeFile(path.join(c, `notes/${n}.md`), n); }, /at most 2 paths/],
  ]) {
    const { agent, checkout, bare } = await started(t, { options });
    await plant(checkout);
    await agent.end();
    assert.deepEqual(await branchesOf(bare), ["main"], name);
    assert.equal(agent.reports[0].ok, false, name);
    assert.equal(agent.reports[0].error.code, "refused", name);
    assert.match(agent.reports[0].error.message, why, name);
  }
});

test("a .git directory the agent made is ignored where the allowlist cannot reach it", async (t) => {
  const { agent, checkout, bare } = await started(t);
  await mkdir(path.join(checkout, ".git/hooks"), { recursive: true });
  await writeFile(path.join(checkout, ".git/hooks/pre-push"), "#!/bin/sh\ntouch /tmp/never\n");
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.end();
  assert.equal(agent.reports[0].ok, true);
  assert.deepEqual((await treeOf(bare, `sessions/${agent.sessionId()}`)).filter((f) => f.includes(".git")), []);
});

test("a second end for the same session commits nothing and leaves the remote as it was", async (t) => {
  const { agent, checkout, bare, main } = await started(t);
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  const branch = `sessions/${agent.sessionId()}`;
  const emit = () => agent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await emit();
  const first = (await commitsOf(bare, branch, main));
  assert.equal(first.length, 1);
  await emit();
  await agent.end();
  assert.deepEqual(agent.reports.map((r) => [r.ok, r.outcome.created]), [[true, true], [true, false], [true, false]]);
  assert.equal(agent.reports[1].outcome.sha, agent.reports[0].outcome.sha);
  assert.deepEqual(await commitsOf(bare, branch, main), first);
});

test("every push a session makes names its own branch by sha, and none names main", async (t) => {
  const root = await scratch();
  const recorder = await recordingGit(path.join(root, "rec"));
  const { bare, main } = await remoteWith(root, SEED);
  const agent = await startSession(t, { root, options: { remote: local(bare), allow: ALLOW, git: recorder.git } });
  const checkout = path.join(agent.state, "checkouts", agent.sessionId());
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  const emit = () => agent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await emit();
  await emit();
  const pushes = (await recorder.calls()).filter((call) => call.verb === "push");
  assert.ok(pushes.length >= 1);
  const sha = (await rawGit(["rev-parse", `sessions/${agent.sessionId()}`], { gitDir: bare })).toString().trim();
  for (const call of pushes) {
    const refspecs = call.argv.filter((a) => /^[0-9a-f]{40}:/.test(a) || a.includes("refs/heads/") || a === "main");
    assert.deepEqual(refspecs, [`${sha}:refs/heads/sessions/${agent.sessionId()}`], call.argv.join(" "));
  }
  assert.equal((await rawGit(["rev-parse", "main"], { gitDir: bare })).toString().trim(), main);
});

test("an end whose push failed is retried by the next end, which pushes the same commit", async (t) => {
  const { agent, checkout, bare, main } = await started(t);
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  const emit = () => agent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  // The remote can be read but not written: the commit is made, the push fails.
  await chmod(path.join(bare, "objects"), 0o555);
  for (const entry of await readdir(path.join(bare, "objects"))) await chmod(path.join(bare, "objects", entry), 0o555);
  await emit();
  assert.equal(agent.reports[0].ok, false);
  assert.deepEqual(await branchesOf(bare), ["main"]);
  await chmod(path.join(bare, "objects"), 0o755);
  for (const entry of await readdir(path.join(bare, "objects"))) await chmod(path.join(bare, "objects", entry), 0o755);
  await emit();
  assert.equal(agent.reports[1].ok, true);
  assert.equal(agent.reports[1].outcome.created, false, "the commit was made by the first end");
  assert.equal((await commitsOf(bare, `sessions/${agent.sessionId()}`, main)).length, 1);
});

test("a reload does not end the session: the new runtime keeps the directory and the one end commits everything", async (t) => {
  const { agent, checkout, bare, main } = await started(t);
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.session.reload();
  assert.deepEqual(await branchesOf(bare), ["main"], "nothing committed by a reload");
  assert.ok(existsSync(path.join(checkout, "notes/b.md")), "the directory was kept, not seeded again");
  assert.deepEqual(agent.session.resourceLoader.getSkills().skills.map((s) => s.name), ["note-taking"], "skills are exposed again after a reload");
  await writeFile(path.join(checkout, "notes/c.md"), "gamma\n");
  await agent.end();
  const branch = `sessions/${agent.sessionId()}`;
  assert.equal((await commitsOf(bare, branch, main)).length, 1);
  assert.deepEqual((await treeOf(bare, branch)).filter((f) => f.startsWith("notes/")), ["notes/a.md", "notes/b.md", "notes/c.md"]);
});

test("a session resumed later adds to its branch: the later end never removes what an earlier one committed", async (t) => {
  const { agent, checkout, bare, main, root } = await started(t);
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.run(); // pi writes a session file with its first message
  const file = agent.sessionFile();
  const id = agent.sessionId();
  await agent.end();
  const again = await startSession(t, { root, sessionFile: file, options: { remote: local(bare), allow: ALLOW } });
  assert.equal(again.sessionId(), id);
  assert.ok(existsSync(path.join(checkout, "notes/b.md")), "the directory of the earlier start is kept");
  await writeFile(path.join(checkout, "notes/c.md"), "gamma\n");
  await again.end();
  assert.equal(again.reports[0].ok, true);
  const branch = `sessions/${id}`;
  assert.equal((await commitsOf(bare, branch, main)).length, 2);
  assert.deepEqual((await treeOf(bare, branch)).filter((f) => f.startsWith("notes/")), ["notes/a.md", "notes/b.md", "notes/c.md"]);
});

test("a resumed session whose directory is gone is seeded again and still adds to its branch", async (t) => {
  const { agent, checkout, bare, main, root } = await started(t);
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.run();
  const file = agent.sessionFile();
  await agent.end();
  await rm(checkout, { recursive: true });
  const again = await startSession(t, { root, sessionFile: file, options: { remote: local(bare), allow: ALLOW } });
  await writeFile(path.join(checkout, "notes/c.md"), "gamma\n");
  await again.end();
  const branch = `sessions/${again.sessionId()}`;
  assert.equal((await commitsOf(bare, branch, main)).length, 2);
  assert.deepEqual((await treeOf(bare, branch)).filter((f) => f.startsWith("notes/")), ["notes/a.md", "notes/b.md", "notes/c.md"]);
});

test("a branch of that name that is not this session's is never added to", async (t) => {
  const { agent, checkout, bare, main } = await started(t);
  const branch = `sessions/${agent.sessionId()}`;
  await rawGit(["update-ref", `refs/heads/${branch}`, main], { gitDir: bare });
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.end();
  assert.equal(agent.reports[0].ok, false);
  assert.match(agent.reports[0].error.message, /not this session's/);
  assert.equal((await rawGit(["rev-parse", branch], { gitDir: bare })).toString().trim(), main);
});

test("a seeded entry the checkout skipped is not seen as a deletion", async (t) => {
  const { agent, bare } = await started(t, { files: { ...SEED, "notes/link.md": { link: "a.md" } } });
  assert.ok(!existsSync(path.join(agent.state, "checkouts", agent.sessionId(), "notes/link.md")), "the checkout leaves a symlink out");
  await agent.end();
  assert.deepEqual(await branchesOf(bare), ["main"]);
  assert.equal(agent.reports[0].ok, true);
});

test("the branch pattern names the branch; the session's own id lands where {sessionId} is", async (t) => {
  const { agent, checkout, bare } = await started(t, { options: { branch: "learn/agent-a/{sessionId}/notes" } });
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.end();
  assert.deepEqual(await branchesOf(bare), ["learn/agent-a/" + agent.sessionId() + "/notes", "main"]);
});

test("a ref other than main is what the checkout starts from and what the commit builds on", async (t) => {
  const root = await scratch();
  const { bare, main } = await remoteWith(root, SEED);
  const work = path.join(root, "seed-work");
  await writeFile(path.join(work, "notes/on-dev.md"), "dev\n");
  await rawGit(["checkout", "-q", "-b", "dev"], { cwd: work });
  await rawGit(["add", "-A"], { cwd: work });
  await rawGit(["commit", "-q", "-m", "dev"], { cwd: work });
  await rawGit(["push", "-q", bare, "dev"], { cwd: work });
  const dev = (await rawGit(["rev-parse", "dev"], { gitDir: bare })).toString().trim();
  const agent = await startSession(t, { root, options: { remote: local(bare), allow: ALLOW, ref: "dev" } });
  const checkout = path.join(agent.state, "checkouts", agent.sessionId());
  assert.ok(existsSync(path.join(checkout, "notes/on-dev.md")));
  await writeFile(path.join(checkout, "notes/b.md"), "beta\n");
  await agent.end();
  const branch = `sessions/${agent.sessionId()}`;
  assert.equal((await commitsOf(bare, branch, dev)).length, 1);
  assert.equal((await rawGit(["rev-parse", `${branch}~1`], { gitDir: bare })).toString().trim(), dev, "built on dev, not main");
  assert.equal(await showOn(bare, "main", "notes/b.md"), null);
  assert.notEqual(dev, main);
});

test("configuration: flags and the gitRemote setting configure the extension; options win over flags, flags over settings", async (t) => {
  const root = await scratch();
  const { bare } = await remoteWith(root, SEED);
  const other = path.join(root, "other.git");
  await rawGit(["init", "-q", "--bare", "--template=", "-b", "main", other]);
  const fromFlags = await startSession(t, { root: path.join(root, "a"), flags: { "git-remote": bare, "git-allow": "notes/**, skills/**", "git-branch": "flag/{sessionId}" } });
  assert.deepEqual(readdirSync(path.join(fromFlags.state, "checkouts", fromFlags.sessionId())).sort(), [".agents", "AGENTS.md", "notes", "src"]);
  await writeFile(path.join(fromFlags.state, "checkouts", fromFlags.sessionId(), "notes/f.md"), "f\n");
  await fromFlags.end();
  assert.deepEqual(await branchesOf(bare), [`flag/${fromFlags.sessionId()}`, "main"]);

  const fromSettings = await startSession(t, { root: path.join(root, "b"), settings: { gitRemote: { remote: bare, allow: ["notes/**"], branch: "set/{sessionId}", ref: "main" } } });
  await writeFile(path.join(fromSettings.state, "checkouts", fromSettings.sessionId(), "notes/s.md"), "s\n");
  await fromSettings.end();
  assert.ok((await branchesOf(bare)).includes(`set/${fromSettings.sessionId()}`));

  const winner = await startSession(t, { root: path.join(root, "c"), settings: { gitRemote: { remote: other, allow: ["notes/**"], branch: "set/{sessionId}" } }, flags: { "git-remote": other, "git-branch": "flag/{sessionId}" }, options: { remote: local(bare), branch: "opt/{sessionId}" } });
  await writeFile(path.join(winner.state, "checkouts", winner.sessionId(), "notes/w.md"), "w\n");
  await winner.end();
  assert.ok((await branchesOf(bare)).includes(`opt/${winner.sessionId()}`));
  assert.deepEqual(await branchesOf(other), [], "the lower-precedence remote was never used");
});

test("with no remote configured the extension does nothing: no state directory, no context file, no end", async (t) => {
  const root = await scratch();
  const agent = await startSession(t, { root, options: {} });
  const [prompt] = await agent.run();
  assert.ok(!prompt.includes("project_instructions"));
  assert.ok(!existsSync(agent.state));
  await agent.end();
  assert.deepEqual(agent.reports, []);
  assert.deepEqual(agent.errors, []);
});

test("a remote without an allowlist, a bad pattern, or a branch pattern that cannot name one session is refused at start, and nothing is checked out", async (t) => {
  const root = await scratch();
  const { bare } = await remoteWith(root, SEED);
  for (const [name, options, why] of [
    ["no allowlist", { remote: local(bare) }, /no allowlist/],
    ["an empty allowlist", { remote: local(bare), allow: [] }, /no allowlist/],
    ["a trailing slash", { remote: local(bare), allow: ["notes/"] }, /trailing slash/],
    ["no placeholder", { remote: local(bare), allow: ALLOW, branch: "sessions/shared" }, /\{sessionId\}/],
    ["two placeholders", { remote: local(bare), allow: ALLOW, branch: "{sessionId}/{sessionId}" }, /exactly once/],
    ["a remote string that is not a path or https", { remote: "ssh://host/repo.git", allow: ALLOW }, /local path or an https URL/],
  ]) {
    const agent = await startSession(t, { root: path.join(root, name.replaceAll(" ", "-")), options });
    assert.equal(agent.errors.length, 1, name);
    assert.match(agent.errors[0].error, why, name);
    assert.ok(!existsSync(path.join(agent.state, "checkouts")) || readdirSync(path.join(agent.state, "checkouts")).length === 0, name);
    await agent.end();
    assert.deepEqual(agent.reports, [], `${name}: nothing to end`);
  }
  assert.deepEqual(await branchesOf(bare), ["main"]);
});

test("a checkout directory inside the working directory, or a working directory inside the checkout, is refused", async (t) => {
  const root = await scratch();
  const { bare } = await remoteWith(root, SEED);
  const work = path.join(root, "w", "work");
  await mkdir(work, { recursive: true });
  for (const [name, checkoutDir] of [["inside", path.join(work, "repo")], ["around", root], ["the same", work]]) {
    const agent = await startSession(t, { root: path.join(root, "w"), work, options: { remote: local(bare), allow: ALLOW, checkoutDir, stateDir: path.join(root, `s-${name.replaceAll(" ", "-")}`) } });
    assert.match(agent.errors[0]?.error ?? "", /must be apart/, name);
    await agent.end();
  }
  assert.deepEqual(await readdir(path.join(root, "w", "work")), []);
});

test("a state directory that others can read or that is not ours is refused", async (t) => {
  const root = await scratch();
  const { bare } = await remoteWith(root, SEED);
  const open = path.join(root, "open-state");
  await mkdir(open, { mode: 0o755 });
  await chmod(open, 0o755);
  const agent = await startSession(t, { root: path.join(root, "x"), options: { remote: local(bare), allow: ALLOW, stateDir: open } });
  assert.match(agent.errors[0]?.error ?? "", /readable or writable by others/);
});

test("an explicit checkout directory is used, with {sessionId} replaced", async (t) => {
  const root = await scratch();
  const { bare } = await remoteWith(root, SEED);
  const agent = await startSession(t, { root: path.join(root, "x"), options: { remote: local(bare), allow: ALLOW, checkoutDir: path.join(root, "repos", "{sessionId}") } });
  assert.ok(existsSync(path.join(root, "repos", agent.sessionId(), "notes/a.md")));
});
