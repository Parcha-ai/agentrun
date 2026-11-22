// An agent's learning folder written by several processes at once: the server and each runner beside it on one data
// directory each write the one folder (learning.ts learningFolderOf), and nothing but the learning script orders them
// (a process's own writes are one at a time, learning.ts withAgentRepo). Each writer here is a process of its own
// (fixtures/learning-writer.mjs), all started on one line of stdin: two inits of an empty folder racing, and three
// processes merging runs on one folder from its first commit; then a writer stopped inside its write while a newer one
// waits, and one killed there. Nothing a writer was told landed is lost, nothing lands twice, and git, main, the working
// tree and snapshot.json agree at the end.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitChange, folderTestHooks, learningInit, parseRead, readSnapshot, SCRIPT_FILE, snapshotAt, snapshotOfRead, writeLearning } from "../dist/learn/folder.js";
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

const edited = (text) => ({ by: { person: "edited", file: "corrections.md" }, writes: [{ path: "corrections.md", text }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `path` is there (a paused writer's "<gate>.at"). */
async function until(path, what) {
  for (let waited = 0; !existsSync(path); waited += 20) {
    assert.ok(waited < 30_000, what);
    await sleep(20);
  }
}

test("a writer whose commit is older never leaves its tree and snapshot over a newer commit's: the newer writer waits for it, and once both are done the folder is at main", async () => {
  const root = folder();
  const ws = localWorkspace(root);
  await learningInit(ws);
  const first = git(root, ["rev-parse", "refs/heads/main"]);
  // The older writer stops inside its write, its commit landed, before it brings the folder in line (test_pause).
  const gate = join(dirname(root), "gate");
  folderTestHooks.env = { AGENTRUN_LEARNING_PAUSE: gate };
  let older;
  try {
    older = commitChange(ws, await readSnapshot(ws), edited("- One.\n"));
    await until(`${gate}.at`, "the older writer reached its pause");
  } finally {
    folderTestHooks.env = undefined;
  }
  const one = git(root, ["rev-parse", "refs/heads/main"]);
  assert.notEqual(one, first, "the older writer's commit landed");
  // The newer writer commits on the older one's main while the older one is still inside its write.
  const newer = commitChange(ws, await snapshotAt(ws, one), edited("- One.\n- Two.\n"));
  await sleep(500);
  assert.equal(git(root, ["rev-parse", "refs/heads/main"]), one, "the newer writer waits while the older one is inside its write");
  writeFileSync(gate, "");
  const done = await older;
  assert.equal(done.main, one, JSON.stringify(done));
  const two = await newer;
  assert.equal(two.landed, true, JSON.stringify(two));
  const snapshot = await whole(root);
  assert.equal(snapshot.main, two.main, "the snapshot is the newer commit's, which is main");
  assert.equal(readFileSync(join(root, "corrections.md"), "utf8"), "- One.\n- Two.\n", "and so is the working tree");
});

test("a writer killed inside its write, its commit landed: the next writer lands once the killed one's lease is past, its write and the killed one's both on main, and the folder whole", { timeout: 180_000 }, async () => {
  const root = folder();
  const ws = localWorkspace(root);
  await learningInit(ws);
  // The first writer, a process of its own, stops inside its write (test_pause) holding a lease of 3 s, and is killed
  // there with every process it started.
  const gate = join(dirname(root), "gate");
  const child = spawn(process.execPath, [WRITER, root, "killed", "commit", "1"], { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, AGENTRUN_TELEMETRY: "0", AGENTRUN_LEARNING_PAUSE: gate, AGENTRUN_LEARNING_LEASE: "3" } });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end("go\n");
  await until(`${gate}.at`, "the first writer reached its pause");
  process.kill(-child.pid, "SIGKILL");
  await exited;
  assert.match(git(root, ["ls-tree", "-r", "--name-only", "refs/heads/main"]), /^workflows\/killed-0\/workflow\.json$/m, "the killed writer's commit landed");
  // The next writer, on the snapshot as the killed one left it (its main's parent).
  const started = Date.now();
  const { snapshot } = await writeLearning(ws, async () => ({ result: undefined, change: edited("- After the kill.\n") }));
  assert.ok(Date.now() - started < 30_000, `the next writer landed in ${Date.now() - started} ms`);
  const now = await whole(root);
  assert.equal(now.main, snapshot.main);
  assert.ok(now.workflows.some(({ name }) => name === "killed-0"), "the killed writer's draft is on main");
  assert.equal(readFileSync(join(root, "corrections.md"), "utf8"), "- After the kill.\n");
});
