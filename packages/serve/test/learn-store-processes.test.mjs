// An agent's local learning store written by several processes at once: the server and each runner beside it on one
// data directory each write the one folder, and nothing but learning.sh's compare and swap orders them (update-ref
// from the head a save read: a lost race writes nothing). No lock: the snapshot is a file of each commit and main is
// always the store's head, so no write lands a snapshot older than main. Each writer is a process of its own
// (fixtures/learning-store-writer.mjs), all started on one line of stdin: three inits of an empty store racing, ten
// times, and three processes merging eight runs each from its first commit. Nothing a writer was told landed is lost,
// nothing lands twice, and the read at the head is the head's.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { forgetBodies, readSnapshot, runMergeOf, snapshotAt } from "../dist/learn/folder.js";
import { localLearningStore } from "../dist/learn/store-local.js";
import { agentLearningFolder } from "../dist/workspace/index.js";

const WRITER = fileURLToPath(new URL("./fixtures/learning-store-writer.mjs", import.meta.url));
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function dataDir() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-learning-processes-"));
  dirs.push(dir);
  return dir;
}
const git = (root, args) => {
  const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};

/** Writers started together: each `[name, op, count]` a process on `data`, all given their start line once every one
 *  is ready. Each writer's stdout lines, parsed, past its "ready". */
async function together(data, writers) {
  const children = writers.map(([name, op, count]) => {
    const child = spawn(process.execPath, [WRITER, data, name, op, String(count ?? 1)], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AGENTRUN_TELEMETRY: "0" } });
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

/** The store agrees with itself: git finds nothing wrong, the snapshot read at the head is the head's (its main the
 *  head, the same as a rebuild from the head's tree and history), and no ref but main is left. The snapshot. */
async function whole(data) {
  const root = agentLearningFolder(data, "agent-one");
  git(root, ["fsck", "--strict", "--no-dangling"]);
  const store = localLearningStore(data, "agent-one");
  const head = await store.head();
  assert.equal(head, git(root, ["rev-parse", "refs/heads/main"]));
  forgetBodies();
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.main, head, "the snapshot read is the head's");
  forgetBodies();
  assert.deepEqual(await snapshotAt(store, head), snapshot, "and the same at the head by commit");
  assert.equal(git(root, ["for-each-ref", "--format=%(refname)"]), "refs/heads/main", "no ref but main is left");
  return { store, snapshot, root };
}

test("local: three processes making one agent's learning store at once, ten times: one first commit, each told it, and the store whole", async () => {
  for (let round = 0; round < 10; round++) {
    const data = dataDir();
    const made = (await together(data, [["a", "init"], ["b", "init"], ["c", "init"]])).map(([one]) => one);
    for (const [i, one] of made.entries()) assert.equal(one.error, undefined, `round ${round}: writer ${i}: ${one.error}`);
    assert.equal(new Set(made.map(({ main }) => main)).size, 1, `round ${round}: each names the one first commit`);
    const { snapshot, root } = await whole(data);
    assert.equal(git(root, ["rev-list", "--count", "refs/heads/main"]), "1", `round ${round}: one commit on main`);
    assert.equal(snapshot.main, made[0].main);
  }
});

test("local: three processes merging eight runs each on one agent's learning store at once, from its first commit: every run lands once, by its marker in its own merge, and the read at the head matches the head", async () => {
  const data = dataDir();
  await together(data, [["first", "init"]]);
  const COUNT = 8;
  const outputs = await together(data, [["a", "commit", COUNT], ["b", "commit", COUNT], ["c", "commit", COUNT]]);
  const writes = outputs.flat();
  assert.equal(writes.length, 3 * COUNT);
  for (const { run, result, failures } of writes) assert.equal(result.ok, true, `${run}: ${JSON.stringify({ result, failures })}`);
  const { store, snapshot, root } = await whole(data);
  const runs = writes.map(({ run }) => run).sort();
  assert.deepEqual(snapshot.workflows.map(({ name }) => name).sort(), runs, "every run's draft is on main");
  assert.equal(git(root, ["rev-list", "--count", "--first-parent", "refs/heads/main"]), String(runs.length + 1), "the first commit and one merge per run");
  for (const { run, result } of writes) {
    const merge = await runMergeOf(store, run);
    assert.equal(merge?.merge, result.commit, `${run}: its marker is in the merge it was told`);
    git(root, ["merge-base", "--is-ancestor", result.commit, "refs/heads/main"]);
    assert.equal(git(root, ["log", "--format=%H", "--diff-filter=A", "refs/heads/main", "--", `.agentrun/runs/${run}`]), result.commit, `${run}: its marker was added once, by its merge`);
  }
});
