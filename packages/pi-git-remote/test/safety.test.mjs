import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createGitRunner, GitRemoteError, local, MAIN, openRepo } from "../dist/index.js";
import { bareRepo, HOST_HOOKS, plantHooks, rawGit, refsOf, REMOTE_HOOKS, scratch, seededRemote } from "./support.mjs";

const NOTES = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n";

async function markersDir(root) {
  const dir = path.join(root, "markers");
  await mkdir(dir);
  return dir;
}

/** Every write path this package has, in order: fetch, checkout, commitTo, push, a true merge, revert, push. */
async function everyOperation(repo, other, root) {
  await repo.fetch();
  await repo.checkout(MAIN, { into: path.join(root, `work-${Date.now()}`) });
  const feature = await repo.commitTo("feature", { files: { "notes.txt": NOTES.replace("line 1", "line 1 (feature)") }, message: "feature", trailers: { "Run-Id": "f1" } });
  await repo.push(feature.sha, "feature");
  const moved = await other.commitTo(MAIN, { files: { "notes.txt": NOTES.replace("line 6", "line 6 (main)") }, message: "main moves" });
  await other.push(moved.sha, MAIN);
  const merged = await repo.merge("feature", MAIN);
  assert.equal(merged.fastForward, false, "a real three-way merge");
  await repo.push(merged.sha, MAIN);
  const reverted = await repo.revert(feature.sha, MAIN);
  await repo.push(reverted.sha, MAIN);
  assert.equal(await repo.read("notes.txt", reverted.sha), NOTES.replace("line 6", "line 6 (main)"));
  return { feature, merged, reverted };
}

test("hooks planted in the host repository never fire through fetch, checkout, commitTo, merge, revert and push", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const { remote, seeder } = await seededRemote(root, { "notes.txt": NOTES });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  await plantHooks(path.join(repo.dir, "hooks"), HOST_HOOKS, markers, "host");
  await everyOperation(repo, seeder, root);
  assert.deepEqual(await readdir(markers), []);
});

test("hooks planted in a local remote never fire on push or fetch", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const { dir, remote, seeder } = await seededRemote(root, { "notes.txt": NOTES });
  await plantHooks(path.join(dir, "hooks"), REMOTE_HOOKS, markers, "remote");
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  await everyOperation(repo, seeder, root);
  assert.deepEqual(await readdir(markers), []);
});

test("control: the same hooks fire under plain git, so an empty marker directory means something", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const { dir, remote } = await seededRemote(root, { "notes.txt": NOTES });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  await plantHooks(path.join(repo.dir, "hooks"), HOST_HOOKS, markers, "host");
  await plantHooks(path.join(dir, "hooks"), REMOTE_HOOKS, markers, "remote");
  const { sha } = await repo.commitTo("control", { files: { "c.md": "c\n" }, message: "control" });
  await rawGit(["update-ref", "refs/heads/plain", sha], { gitDir: repo.dir });
  await rawGit(["push", "-q", dir, "refs/heads/plain:refs/heads/plain"], { gitDir: repo.dir });
  const ran = await readdir(markers);
  for (const name of ["host-reference-transaction", "host-pre-push", "remote-pre-receive", "remote-update", "remote-post-receive", "remote-post-update", "remote-reference-transaction"]) {
    assert.ok(ran.includes(name), `${name} fired under plain git (${ran.join(", ")})`);
  }
});

test("checkout skips a symlink, a submodule, .git paths and case collisions from a hostile tree; hook-named files land as data; building on .git is refused", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const remoteDir = await bareRepo(path.join(root, "remote.git"));
  const blob = async (text) => (await rawGit(["hash-object", "-w", "--stdin"], { gitDir: remoteDir, input: text })).toString().trim();
  const mktree = async (lines) => (await rawGit(["mktree"], { gitDir: remoteDir, input: `${lines.join("\n")}\n` })).toString().trim();
  const hook = await blob(`#!/bin/sh\ntouch '${markers}/content-hook'\n`);
  const entries = [
    `100644 blob ${await blob("* filter=evil merge=evil diff=evil\n*.md text eol=crlf ident\n")}\t.gitattributes`,
    `040000 tree ${await mktree([`100755 blob ${hook}\tpost-checkout`, `100644 blob ${hook}\tpost-commit`])}\thooks`,
    `040000 tree ${await mktree([`100755 blob ${hook}\tpre-commit`])}\t.husky`,
    `040000 tree ${await mktree([`100644 blob ${hook}\tpre-commit`])}\t.HUSKY`,
    `040000 tree ${await mktree([`120000 blob ${await blob("/etc/passwd")}\tevil`])}\tlearnings`,
    `160000 commit ${"1".repeat(40)}\tvendored`,
    `100644 blob ${await blob(NOTES)}\tnotes.txt`,
    `100644 blob ${await blob("$Id$\nplain LF\n")}\tREADME.md`,
  ];
  const hostile = (await rawGit(["commit-tree", await mktree(entries), "-m", "hostile"], { gitDir: remoteDir })).toString().trim();
  await rawGit(["update-ref", "refs/heads/main", hostile], { gitDir: remoteDir });
  const dotGit = `040000 tree ${await mktree([`040000 tree ${await mktree([`100755 blob ${hook}\tpost-checkout`])}\thooks`])}\t.git`;
  const dotGitCommit = (await rawGit(["commit-tree", await mktree([...entries, dotGit]), "-p", hostile, "-m", "dotgit"], { gitDir: remoteDir })).toString().trim();
  await rawGit(["update-ref", "refs/heads/dotgit", dotGitCommit], { gitDir: remoteDir });

  const repo = await openRepo({ dir: path.join(root, "host"), remote: local(remoteDir) });
  const into = path.join(root, "checkout");
  const out = await repo.checkout(MAIN, { into });
  assert.equal(out.sha, hostile);
  assert.deepEqual(Object.fromEntries(out.skipped.map((s) => [s.path, s.reason])), {
    ".HUSKY/pre-commit": "a case collision: .HUSKY vs .husky",
    ".husky/pre-commit": "a case collision: .HUSKY vs .husky",
    "learnings/evil": "a symlink",
    vendored: "a submodule",
  });
  assert.deepEqual([...out.files].sort(), [".gitattributes", "README.md", "hooks/post-checkout", "hooks/post-commit", "notes.txt"]);
  assert.equal(await readFile(path.join(into, "README.md"), "utf8"), "$Id$\nplain LF\n", "no ident expansion, no CRLF from eol=crlf");
  assert.equal(statSync(path.join(into, "hooks", "post-checkout")).mode & 0o111, 0, "never executable");
  assert.ok(!existsSync(path.join(into, "learnings")) && !existsSync(path.join(into, "vendored")));

  const dotted = await repo.checkout("dotgit", { into: path.join(root, "checkout-dotgit") });
  assert.ok(dotted.skipped.some((s) => s.path === ".git/hooks/post-checkout" && s.reason === "a .git segment"));
  assert.ok(!existsSync(path.join(root, "checkout-dotgit", ".git")));
  await assert.rejects(repo.commitTo("on-dotgit", { files: { "x.md": "x\n" }, message: "x", parent: "dotgit" }), (e) => e instanceof GitRemoteError && e.code === "refused");
  await assert.rejects(repo.merge("dotgit", MAIN), (e) => e instanceof GitRemoteError && e.code === "refused" && e.paths.includes(".git/hooks/post-checkout"));
  assert.equal((await refsOf(repo.dir))["refs/heads/main"], undefined, "the refused merge moved nothing");
  assert.deepEqual(await readdir(markers), []);
});

test("a merge that would bring in a symlink or a submodule is refused and moves nothing", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root, { "a.md": "a\n" });
  const tree = (await rawGit(["rev-parse", `${main}^{tree}`], { gitDir: dir })).toString().trim();
  for (const [name, entry] of [["link", `120000 blob ${(await rawGit(["hash-object", "-w", "--stdin"], { gitDir: dir, input: "../../outside" })).toString().trim()}\tescape`], ["sub", `160000 commit ${main}\tvendored`]]) {
    const listed = (await rawGit(["ls-tree", tree], { gitDir: dir })).toString().trim();
    const next = (await rawGit(["mktree"], { gitDir: dir, input: `${listed}\n${entry}\n` })).toString().trim();
    const commit = (await rawGit(["commit-tree", next, "-p", main, "-m", name], { gitDir: dir })).toString().trim();
    await rawGit(["update-ref", `refs/heads/${name}`, commit], { gitDir: dir });
  }
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const before = await refsOf(repo.dir);
  await assert.rejects(repo.merge("link", MAIN), (e) => e.code === "refused" && /a symlink/.test(e.message));
  await assert.rejects(repo.merge("sub", MAIN), (e) => e.code === "refused" && /a submodule/.test(e.message));
  assert.deepEqual(await refsOf(repo.dir), before);
});

test("a .gitattributes in the remote's tree changes nothing: bytes stay as stored and a conflict stays a conflict", async () => {
  const root = await scratch();
  const { remote, seeder } = await seededRemote(root, {
    ".gitattributes": "* merge=union\n*.md text eol=crlf ident\n",
    "notes.txt": "a\nb\nc\n",
    "README.md": "$Id$\nplain LF\n",
  });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const ours = await repo.commitTo(MAIN, { files: { "notes.txt": "a\nOURS\nc\n", "doc.md": "$Id$\r\nkept as given\r\n" }, message: "ours" });
  assert.equal(await repo.read("doc.md", ours.sha), "$Id$\r\nkept as given\r\n", "no clean filter, no eol normalization");
  const theirs = await seeder.commitTo("theirs", { files: { "notes.txt": "a\nTHEIRS\nc\n" }, message: "theirs" });
  await seeder.push(theirs.sha, "theirs");
  await assert.rejects(repo.merge("theirs", MAIN), (e) => e instanceof GitRemoteError && e.code === "conflict" && e.paths.includes("notes.txt"));
  await repo.checkout(MAIN, { into: path.join(root, "work") });
  assert.equal(await readFile(path.join(root, "work", "README.md"), "utf8"), "$Id$\nplain LF\n");
});

test("a planted info/attributes cannot change the bytes commitTo stores or run a clean filter", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const { remote } = await seededRemote(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  await mkdir(path.join(repo.dir, "info"), { recursive: true });
  await writeFile(path.join(repo.dir, "info", "attributes"), "* text eol=crlf ident filter=evil\n");
  await rawGit(["config", "filter.evil.clean", `touch '${markers}/clean-filter'; cat`], { gitDir: repo.dir });
  const given = "first\r\n$Id: 0123456789 $\r\nlast\r\n";
  const { sha } = await repo.commitTo(MAIN, { files: { "doc.md": given }, message: "bytes as given" });
  assert.equal(await repo.read("doc.md", sha), given);
  assert.deepEqual(await readdir(markers), []);
});

test("repository config cannot turn hooks, fsmonitor, a credential helper or askpass back on", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const { remote, seeder } = await seededRemote(root, { "notes.txt": NOTES });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const elsewhere = path.join(root, "planted-hooks");
  await plantHooks(elsewhere, HOST_HOOKS, markers, "configured");
  const script = path.join(root, "planted.sh");
  await writeFile(script, `#!/bin/sh\ntouch '${markers}/planted-command'\n`);
  await chmod(script, 0o755);
  for (const [key, value] of [["core.hooksPath", elsewhere], ["core.fsmonitor", script], ["credential.helper", `!${script}`], ["core.askPass", script], ["core.sshCommand", script]]) {
    await rawGit(["config", key, value], { gitDir: repo.dir });
  }
  await everyOperation(repo, seeder, root);
  assert.deepEqual(await readdir(markers), []);
});

test("transports other than file and https never run: ext:: fails in git and is refused as a remote", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const gitDir = await bareRepo(path.join(root, "host.git"));
  const home = path.join(root, "home");
  await mkdir(home);
  const run = createGitRunner({ gitDir, home, tmp: home });
  const result = await run(["fetch", `ext::sh -c touch% ${markers}/ext`, "+refs/heads/*:refs/remotes/x/*"], { allowFail: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /transport 'ext' not allowed/);
  for (const remote of [{ kind: "local", url: `ext::sh -c touch% ${markers}/ext` }, { kind: "local", url: "relative/path.git" }, { kind: "https", url: "http://git.example.test/a.git" }, { kind: "ssh", url: "git@example.test:a.git" }]) {
    await assert.rejects(openRepo({ dir: path.join(root, "h"), remote }), (e) => e.code === "refused");
  }
  assert.deepEqual(await readdir(markers), []);
});

test("limit, pinned: a writable host repository runs a merge driver from its own config and info/attributes, whatever the flags", async () => {
  const root = await scratch();
  const markers = await markersDir(root);
  const { remote, seeder } = await seededRemote(root, { "notes.txt": NOTES });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  await repo.commitTo(MAIN, { files: { "notes.txt": NOTES.replace("line 1", "line 1 (ours)") }, message: "ours" });
  const theirs = await seeder.commitTo("theirs", { files: { "notes.txt": NOTES.replace("line 6", "line 6 (theirs)") }, message: "theirs" });
  await seeder.push(theirs.sha, "theirs");
  await mkdir(path.join(repo.dir, "info"), { recursive: true });
  await writeFile(path.join(repo.dir, "info", "attributes"), "* merge=evil\n");
  await rawGit(["config", "merge.evil.driver", `touch '${markers}/merge-driver'; false`], { gitDir: repo.dir });
  await repo.merge("theirs", MAIN).catch(() => undefined);
  assert.deepEqual(await readdir(markers), ["merge-driver"], "the host repository must stay out of an agent's reach");
});
