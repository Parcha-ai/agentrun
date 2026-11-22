// The learning folder over the local store (learn/store-local.ts, learning.sh): the shared suite (learn-folder-suite.mjs),
// and what only a folder of this machine shows: git's own view of it, and a link planted in it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitChange, forgetBodies, learningInit, readSnapshot } from "../dist/learn/folder.js";
import { localLearningStore } from "../dist/learn/store-local.js";
import { agentLearningFolder } from "../dist/workspace/index.js";
import { folderSuite } from "./learn-folder-suite.mjs";

/** A fresh data directory's local store of one agent: the store and its folder. */
function local(t) {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-learning-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  return { data, store: localLearningStore(data, "agent-one"), root: agentLearningFolder(data, "agent-one") };
}
const git = (root, args) => {
  const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};
const README = "---\nname: weekly-report\ndescription: Lays out the weekly report; use when asked for it\n---\n";

folderSuite("local", async (t) => local(t).store);

test("local: git sees what the snapshot says: main, each blob, the commit's author, message and trailers, a clean working tree, no ref left behind, and the folder's own repository (no path of this machine's in its config)", async (t) => {
  const { store, root } = local(t);
  const init = await learningInit(store);
  assert.equal(git(root, ["rev-parse", "main"]), init);
  assert.equal(git(root, ["log", "-1", "--format=%an <%ae>%n%s", "main"]), "agentrun-serve <serve@agentrun.invalid>\nhost: the agent's learning folder");
  const merged = await commitChange(store, await readSnapshot(store), { by: { run: "run-1", reason: "Compiled the job." }, writes: [{ path: "corrections.md", text: "- Be brief.\n" }, { path: "workflows/weekly-report/README.md", text: README }, { path: "workflows/weekly-report/workflow.json", text: "{\"v\":2}\n" }] });
  const snapshot = await readSnapshot(store);
  assert.equal(git(root, ["rev-parse", "main"]), merged.main);
  assert.equal(git(root, ["rev-parse", "main:corrections.md"]), snapshot.corrections.oid);
  assert.equal(git(root, ["rev-parse", "main:workflows/weekly-report/README.md"]), snapshot.workflows[0].oid);
  assert.equal(git(root, ["log", "-1", "--format=%B", "main"]), "learning: run-1: merged\n\nCompiled the job.\n\nRun-Id: run-1");
  assert.equal(git(root, ["log", "-1", "--format=%(trailers:key=Run-Id,valueonly)", "main"]), "run-1");
  assert.equal(git(root, ["show", "main:.agentrun/runs/run-1"]), "", "the run's marker is a file of the same commit");
  assert.equal(git(root, ["status", "--porcelain"]), "", "the working tree is main's");
  assert.equal(git(root, ["for-each-ref"]), `${merged.main} commit\trefs/heads/main`, "main alone: no temporary ref is left");
  assert.equal(spawnSync("git", ["-C", root, "config", "--local", "core.worktree"], { encoding: "utf8" }).stdout, "", "no work tree path recorded");
  assert.equal(git(root, ["cat-file", "-p", "main"]).split("\n").find((line) => line.startsWith("parent ")), `parent ${init}`);
});

test("local: a link in the working tree is never followed: a corrections.md planted as one, or a folder on a draft's way, is refused before main moves, and nothing is written where it points", async (t) => {
  const outside = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "kept"), "kept\n");
  const { store, root } = local(t);
  await learningInit(store);
  const before = await readSnapshot(store);
  // corrections.md planted as a link: a merge writing it is refused.
  symlinkSync(join(outside, "kept"), join(root, "corrections.md"));
  await assert.rejects(commitChange(store, before, { by: { run: "run-c", reason: "A correction." }, writes: [{ path: "corrections.md", text: "- Be brief.\n" }] }), /a link in the learning folder at corrections\.md can't be followed/);
  assert.equal(readFileSync(join(outside, "kept"), "utf8"), "kept\n", "nothing written through the link");
  assert.equal(git(root, ["rev-parse", "main"]), before.main);
  rmSync(join(root, "corrections.md"));
  // A draft's folder planted as a link: a merge writing into it is refused, main as it was.
  mkdirSync(join(root, "workflows"));
  symlinkSync(outside, join(root, "workflows", "weekly-report"));
  await assert.rejects(commitChange(store, before, { by: { run: "run-l", reason: "A draft." }, writes: [{ path: "workflows/weekly-report/README.md", text: README }, { path: "workflows/weekly-report/workflow.json", text: "{}\n" }] }), /a link in the learning folder at workflows\/weekly-report can't be followed/);
  assert.equal(git(root, ["rev-parse", "main"]), before.main);
  assert.deepEqual(readdirSync(outside), ["kept"]);
});

test("local: a link where the folder or its .git should be fails every read and write closed, in words that name it; nothing is read, made or run where it points", async (t) => {
  const { data, store, root } = local(t);
  await learningInit(store);
  renameSync(join(root, ".git"), join(root, "git-moved"));
  symlinkSync(join(root, "git-moved"), join(root, ".git"));
  forgetBodies();
  await assert.rejects(store.head(), (error) => error.name === "FolderUnreadable" && error.link === true && /a link in the learning folder at disk\/agents\/[^/]+\/learning\/\.git can't be followed/.test(error.message));
  await assert.rejects(store.save({ old: null, message: "x", at: 1, writes: [] }), /can't be followed/);
  // The folder itself a link: remove() leaves what it points at.
  const elsewhere = join(data, "elsewhere");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "kept"), "kept\n");
  symlinkSync(elsewhere, root);
  await assert.rejects(store.head(), /a link in the learning folder at disk\/agents\/[^/]+\/learning can't be followed/);
  await store.remove().catch(() => undefined);
  assert.deepEqual(readdirSync(elsewhere), ["kept"], "nothing removed where it points");
});

test("local: a tracked link in a draft's folder (committed by hand) is named in its links, never one of its files; a later write carries it on", async (t) => {
  const { store, root } = local(t);
  await learningInit(store);
  const draft = (name) => [{ path: `workflows/${name}/README.md`, text: README.replace("weekly-report", name) }, { path: `workflows/${name}/workflow.json`, text: "{}\n" }];
  await commitChange(store, await readSnapshot(store), { by: { run: "run-l", reason: "Two drafts." }, writes: [...draft("alpha"), ...draft("beta")] });
  const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "op", GIT_AUTHOR_EMAIL: "op@example.invalid", GIT_COMMITTER_NAME: "op", GIT_COMMITTER_EMAIL: "op@example.invalid" };
  const hand = spawnSync("sh", ["-c", "ln -s ../beta/workflow.json workflows/alpha/linked.json && git add workflows/alpha/linked.json && git -c core.hooksPath=/dev/null commit -q -m 'a hand link'"], { cwd: root, env, encoding: "utf8" });
  assert.equal(hand.status, 0, hand.stderr);
  forgetBodies();
  const read = await readSnapshot(store);
  const alpha = read.workflows.find((w) => w.name === "alpha");
  assert.deepEqual([alpha.links, alpha.files.map((f) => f.path)], [["workflows/alpha/linked.json"], ["workflows/alpha/README.md", "workflows/alpha/workflow.json"]]);
  assert.equal(read.workflows.find((w) => w.name === "beta").links, undefined);
  const next = await commitChange(store, read, { by: { person: "edited", file: "corrections.md" }, writes: [{ path: "corrections.md", text: "- Be brief.\n" }] });
  assert.deepEqual(next.snapshot.workflows.find((w) => w.name === "alpha").links, ["workflows/alpha/linked.json"]);
  forgetBodies();
  assert.deepEqual((await readSnapshot(store)).workflows.find((w) => w.name === "alpha").links, ["workflows/alpha/linked.json"]);
});
