// The learning folder's script over a local folder (the Local Workspace): the shared suite (learn-folder-suite.mjs),
// and what only a folder of this machine shows, git's own view of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { commitChange, learningInit, readSnapshot } from "../dist/learn/folder.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { folderSuite } from "./learn-folder-suite.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-learning-"));
  dirs.push(dir);
  const root = join(dir, "learning");
  mkdirSync(root);
  return root;
}
const git = (root, args) => {
  const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};

folderSuite("local", async () => ({ ws: localWorkspace(folder()) }));

test("local: git sees what the snapshot says: main, each blob, the commit's author, message and trailers, a clean working tree, and the folder's own repository (no path of this machine's in its config)", async () => {
  const root = folder();
  const ws = localWorkspace(root);
  const init = await learningInit(ws);
  assert.equal(git(root, ["rev-parse", "main"]), init);
  assert.equal(git(root, ["log", "-1", "--format=%an <%ae>%n%s", "main"]), "agentrun-serve <serve@agentrun.invalid>\nhost: the agent's learning folder");
  const text = "---\nname: Check units\ndescription: Convert every amount\n---\nBody.\n";
  const merged = await commitChange(ws, await readSnapshot(ws), { by: { run: "run-1", reason: "Each note is general." }, writes: [{ path: "check-units.md", text }, { path: "MEMORY.md", text: "- [Check units](check-units.md) — Convert every amount\n" }] });
  const snapshot = await readSnapshot(ws);
  assert.equal(git(root, ["rev-parse", "main"]), merged.main);
  assert.equal(git(root, ["rev-parse", "main:check-units.md"]), snapshot.notes[0].oid);
  assert.equal(git(root, ["rev-parse", "main:MEMORY.md"]), snapshot.index.oid);
  assert.equal(git(root, ["log", "-1", "--format=%B", "main"]), "learning: run-1: merged\n\nEach note is general.\n\nRun-Id: run-1");
  assert.equal(git(root, ["log", "-1", "--format=%(trailers:key=Run-Id,valueonly)", "main"]), "run-1");
  assert.equal(git(root, ["status", "--porcelain"]), "", "the working tree is main's, and .agentrun/ is the host's (excluded)");
  assert.equal(git(root, ["for-each-ref", "refs/agentrun/"]), "", "no temporary ref is left");
  assert.equal(spawnSync("git", ["-C", root, "config", "--local", "core.worktree"], { encoding: "utf8" }).stdout, "", "no work tree path recorded");
  assert.equal(git(root, ["cat-file", "-p", "main"]).split("\n").find((line) => line.startsWith("parent ")), `parent ${init}`);
});

test("local: a symbolic link where the script would write is refused before main moves: a MEMORY.md planted as one before the first commit, or a folder on a note's way; nothing is written where it points", async () => {
  const outside = folder();
  writeFileSync(join(outside, "kept"), "kept\n");
  const root = folder();
  symlinkSync(join(outside, "kept"), join(root, "MEMORY.md"));
  const ws = localWorkspace(root);
  await assert.rejects(learningInit(ws), /a link in the learning folder at MEMORY\.md can't be followed/);
  assert.equal(readFileSync(join(outside, "kept"), "utf8"), "kept\n", "nothing written through the link");
  assert.equal(spawnSync("git", ["-C", root, "rev-parse", "-q", "--verify", "refs/heads/main"], { encoding: "utf8" }).stdout, "", "no main");
  assert.equal(await readSnapshot(ws), undefined, "no snapshot");
  // A skill's folder planted as a link: a merge writing into it is refused, main and the snapshot as they were.
  rmSync(join(root, "MEMORY.md"));
  await learningInit(ws);
  const before = await readSnapshot(ws);
  mkdirSync(join(root, "skills"));
  symlinkSync(outside, join(root, "skills", "weekly-report"));
  await assert.rejects(commitChange(ws, before, { by: { run: "run-l", reason: "A skill." }, writes: [{ path: "skills/weekly-report/SKILL.md", text: "---\nname: weekly-report\ndescription: d\n---\n" }] }), /a link in the learning folder at skills\/weekly-report can't be followed/);
  assert.deepEqual(await readSnapshot(ws), before);
  assert.equal(git(root, ["rev-parse", "main"]), before.main);
  assert.deepEqual(readdirSync(outside), ["kept"]);
});
