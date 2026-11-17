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
const README = "---\nname: weekly-report\ndescription: Lays out the weekly report; use when asked for it\n---\n";

folderSuite("local", async () => ({ ws: localWorkspace(folder()) }));

test("local: git sees what the snapshot says: main, each blob, the commit's author, message and trailers, a clean working tree, and the folder's own repository (no path of this machine's in its config)", async () => {
  const root = folder();
  const ws = localWorkspace(root);
  const init = await learningInit(ws);
  assert.equal(git(root, ["rev-parse", "main"]), init);
  assert.equal(git(root, ["log", "-1", "--format=%an <%ae>%n%s", "main"]), "agentrun-serve <serve@agentrun.invalid>\nhost: the agent's learning folder");
  const merged = await commitChange(ws, await readSnapshot(ws), { by: { run: "run-1", reason: "Compiled the job." }, writes: [{ path: "corrections.md", text: "- Be brief.\n" }, { path: "workflows/weekly-report/README.md", text: README }, { path: "workflows/weekly-report/workflow.json", text: "{\"v\":2}\n" }] });
  const snapshot = await readSnapshot(ws);
  assert.equal(git(root, ["rev-parse", "main"]), merged.main);
  assert.equal(git(root, ["rev-parse", "main:corrections.md"]), snapshot.corrections.oid);
  assert.equal(git(root, ["rev-parse", "main:workflows/weekly-report/README.md"]), snapshot.workflows[0].oid);
  assert.equal(git(root, ["log", "-1", "--format=%B", "main"]), "learning: run-1: merged\n\nCompiled the job.\n\nRun-Id: run-1");
  assert.equal(git(root, ["log", "-1", "--format=%(trailers:key=Run-Id,valueonly)", "main"]), "run-1");
  assert.equal(git(root, ["status", "--porcelain"]), "", "the working tree is main's, and .agentrun/ is the host's (excluded)");
  assert.equal(git(root, ["for-each-ref", "refs/agentrun/"]), `${merged.main} commit\trefs/agentrun/runs/run-1`, "no temporary ref is left; the run's merge is kept under its own ref, so it merges once");
  assert.equal(spawnSync("git", ["-C", root, "config", "--local", "core.worktree"], { encoding: "utf8" }).stdout, "", "no work tree path recorded");
  assert.equal(git(root, ["cat-file", "-p", "main"]).split("\n").find((line) => line.startsWith("parent ")), `parent ${init}`);
});

test("local: a symbolic link where the script would write is refused before main moves: a corrections.md planted as one, or a folder on a draft's way; nothing is written where it points", async () => {
  const outside = folder();
  writeFileSync(join(outside, "kept"), "kept\n");
  const root = folder();
  const ws = localWorkspace(root);
  await learningInit(ws);
  const before = await readSnapshot(ws);
  // corrections.md planted as a link: a merge appending to it is refused.
  symlinkSync(join(outside, "kept"), join(root, "corrections.md"));
  await assert.rejects(commitChange(ws, before, { by: { run: "run-c", reason: "A correction." }, writes: [{ path: "corrections.md", text: "- Be brief.\n" }] }), /a link in the learning folder at corrections\.md can't be followed/);
  assert.equal(readFileSync(join(outside, "kept"), "utf8"), "kept\n", "nothing written through the link");
  assert.deepEqual(await readSnapshot(ws), before);
  assert.equal(git(root, ["rev-parse", "main"]), before.main);
  rmSync(join(root, "corrections.md"));
  // A draft's folder planted as a link: a merge writing into it is refused, main and the snapshot as they were.
  mkdirSync(join(root, "workflows"));
  symlinkSync(outside, join(root, "workflows", "weekly-report"));
  await assert.rejects(commitChange(ws, before, { by: { run: "run-l", reason: "A draft." }, writes: [{ path: "workflows/weekly-report/README.md", text: README }, { path: "workflows/weekly-report/workflow.json", text: "{}\n" }] }), /a link in the learning folder at workflows\/weekly-report can't be followed/);
  assert.deepEqual(await readSnapshot(ws), before);
  assert.equal(git(root, ["rev-parse", "main"]), before.main);
  assert.deepEqual(readdirSync(outside), ["kept"]);
});
