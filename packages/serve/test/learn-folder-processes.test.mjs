// An agent's learning folder written by several processes at once: the server and each runner beside it on one data
// directory each write the one folder (learning.ts learningFolderOf), and nothing but the learning script orders them
// (a process's own writes are one at a time, learning.ts withAgentRepo). Each writer here is a process of its own
// (fixtures/learning-writer.mjs), all started on one line of stdin: two inits of an empty folder racing, and three
// processes merging runs on one folder from its first commit. Nothing a writer was told landed is lost, nothing lands
// twice, and git, main, the working tree and snapshot.json agree at the end.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRead, readSnapshot, SCRIPT_FILE, snapshotOfRead } from "../dist/learn/folder.js";
import { localWorkspace } from "../dist/workspace/index.js";

const WRITER = fileURLToPath(new URL("./fixtures/learning-writer.mjs", import.meta.url));
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-learning-processes-"));
  dirs.push(dir);
  const root = join(dir, "learning");
  mkdirSync(root);
  return root;
}
const git = (root, args) => {
  const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};

/** Writers started together: each `[name, op, count]` a process on `root`, all given their start line once every one
 *  is ready. Each writer's stdout lines, parsed, past its "ready". */
async function together(root, writers) {
  const children = writers.map(([name, op, count]) => {
    const child = spawn(process.execPath, [WRITER, root, name, op, String(count ?? 1)], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AGENTRUN_TELEMETRY: "0" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    const ready = new Promise((resolve, reject) => {
      const look = () => { if (out.startsWith("ready\n")) resolve(); };
      child.stdout.on("data", look);
      child.once("exit", (code) => reject(new Error(`writer ${name} exited ${code} before it was ready: ${err}`)));
    });
    const done = new Promise((resolve) => child.once("exit", (code) => resolve({ code, out, err })));
    return { child, ready, done };
  });
  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) child.stdin.end("go\n");
  const ended = await Promise.all(children.map(({ done }) => done));
  return ended.map(({ code, out, err }, i) => {
    assert.equal(code, 0, `writer ${writers[i][0]}: ${err}`);
    return out.split("\n").slice(1).filter(Boolean).map((line) => JSON.parse(line));
  });
}

/** The folder agrees with itself: git finds nothing wrong, the working tree is main's, and snapshot.json is the
 *  snapshot main gives, rebuilt from git. Main's commit. */
async function whole(root) {
  git(root, ["fsck", "--strict", "--no-dangling"]);
  assert.equal(git(root, ["status", "--porcelain", "--untracked-files=all"]), "", "the working tree is main's");
  const ws = localWorkspace(root);
  const read = await ws.exec(["sh", SCRIPT_FILE, "read"], { env: { PATH: process.env.PATH, LC_ALL: "C" }, timeoutMs: 60_000 });
  assert.equal(read.code, 0, read.stderr);
  const snapshot = await readSnapshot(ws);
  assert.deepEqual(snapshot, snapshotOfRead(parseRead(read.stdout)), "snapshot.json is main's");
  assert.equal(snapshot.main, git(root, ["rev-parse", "refs/heads/main"]));
  return snapshot;
}

test("three processes making one agent's learning folder at once: one first commit, each told it, and the folder whole", async () => {
  for (let round = 0; round < 10; round++) {
    const root = folder();
    const made = (await together(root, [["a", "init"], ["b", "init"], ["c", "init"]])).map(([one]) => one);
    for (const [i, one] of made.entries()) assert.equal(one.error, undefined, `round ${round}: writer ${i}: ${one.error}`);
    assert.equal(new Set(made.map(({ main }) => main)).size, 1, `round ${round}: each names the one first commit`);
    assert.equal(git(root, ["rev-list", "--count", "refs/heads/main"]), "1", `round ${round}: one commit on main`);
    assert.equal((await whole(root)).main, made[0].main);
  }
});

test("three processes merging runs on one agent's learning folder at once, from its first commit: every run lands once, a write that did not land says so and lands on a retry, and the folder is whole", async () => {
  const root = folder();
  const COUNT = 8;
  const outputs = await together(root, [["a", "commit", COUNT], ["b", "commit", COUNT], ["c", "commit", COUNT]]);
  const writes = outputs.flat();
  assert.equal(writes.length, 3 * COUNT);
  for (const { run, result, failures } of writes) {
    assert.equal(result.ok, true, `${run}: ${JSON.stringify({ result, failures })}`);
    // A write that lost to another writer each try says the folder is being written, and nothing else.
    for (const failure of failures) assert.match(failure, /being written: try again/, `${run}: ${failure}`);
  }
  const snapshot = await whole(root);
  const runs = writes.map(({ run }) => run).sort();
  assert.deepEqual(snapshot.workflows.map(({ name }) => name).sort(), runs, "every run's draft is on main");
  assert.equal(git(root, ["rev-list", "--count", "--first-parent", "refs/heads/main"]), String(runs.length + 1), "the first commit and one merge per run");
  for (const { run, result } of writes) {
    assert.equal(git(root, ["rev-parse", `refs/agentrun/runs/${run}`]), result.commit, `${run}: its ref is the merge it was told`);
    git(root, ["merge-base", "--is-ancestor", result.commit, "refs/heads/main"]);
    const diff = JSON.parse(readFileSync(join(root, ".agentrun", "diffs", `${run}.json`), "utf8"));
    assert.equal(diff.merge, result.commit, `${run}: its diff file is its merge's`);
  }
});
