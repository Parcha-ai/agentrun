// A run's tools bound to its Workspace (serve/src/workspace/run-tools.ts runHands): with no computer in Mode 1 there is
// no shell ("none": the run's folder is one of this server's own, so no bash executor at all), the folder named by its
// own path and the file tools confined to it; in Mode 2 with none the shell is Archil's exec ("local", 295 s at most);
// with a computer it is "computer", the folder at /workspace, the Workspace attached through the mount check given.
// bash's TMPDIR and its full outputs are in the run's folder, readable with read, and the run's end sweeps them; nothing
// of this server's environment reaches a command. The claim-time shell agrees with runShellOf's, read off the setting.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { localWorkspace } from "../dist/workspace/index.js";
import { answerText } from "../dist/workspace/executors.js";
import { runHands } from "../dist/workspace/run-tools.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { realProcesses } from "./workspace-fake-processes.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-run-tools-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

test("no computer in Mode 1: no shell, so no bash executor; the folder goes by its own path; read opens a file in it and refuses one of the server's outside it", async () => {
  const root = scratch();
  writeFileSync(join(root, "a.txt"), "hello\n");
  // A file of the server's data beside the run's folder: what a host shell, or an unconfined file tool, would read.
  const token = join(root, "..", ".token");
  writeFileSync(token, "fake-test-key");
  const run = await runHands(localWorkspace(root), undefined, { mode: 1, context: ctx });
  assert.deepEqual([run.shell, run.maxExecS, run.cwd], ["none", 600, root]);
  assert.equal(run.executors.bash, undefined, "no bash executor: nothing can run a command on this server");
  assert.equal(answerText(await run.executors.read({ path: "a.txt" }, {})), "hello\n");
  assert.equal(answerText(await run.executors.read({ path: join(root, "a.txt") }, {})), "hello\n");
  for (const path of [token, "../.token"]) {
    const refused = await run.executors.read({ path }, {});
    assert.ok(refused.isError === true || refused.error !== undefined, `${path} is refused: ${JSON.stringify(refused)}`);
    assert.ok(!answerText(refused).includes("fake-test-key"), "and nothing of it is read");
  }
  await run.sweep();
  assert.deepEqual(readdirSync(join(root, ".agentrun")), [], "the end swept TMPDIR");
  assert.ok(existsSync(join(root, "a.txt")));
});

test("Mode 2 with no computer: a command runs 295 s at most (Archil's exec)", async () => {
  const run = await runHands(localWorkspace(scratch()), undefined, { mode: 2, context: ctx });
  assert.deepEqual([run.shell, run.maxExecS, run.hands.maxExecS], ["local", 295, 295]);
});

test("Mode 2 with no computer never asks the folder's mount: on Archil that mints the run's mount credential, which only a computer that mounts the folder may ask for", async () => {
  const workspace = localWorkspace(scratch());
  let asked = 0;
  const watched = new Proxy(workspace, {
    get(target, key) {
      if (key === "mountSpec") return async () => { asked += 1; return target.mountSpec(); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const run = await runHands(watched, undefined, { mode: 2, context: ctx });
  assert.equal(asked, 0, "no mount asked, so no credential minted");
  assert.equal(run.cwd, "/workspace", "on Archil the folder has no path of this machine: it goes by the computer's name");
});

test("a computer: the Workspace attached through the mount check given; the folder is /workspace (its path here an alias); bash and read go through the computer, with none of this server's environment; a full output is read back", async (t) => {
  const root = scratch();
  writeFileSync(join(root, "a.txt"), "hello\n");
  const computer = realProcesses(fakeComputer(root), root);
  const checks = [];
  const check = { readBackOf: (spec) => (checks.push(spec), readBackOf(spec)) };
  process.env.AGENTRUN_RUN_TOOLS_SENTINEL = "a server value";
  t.after(() => { delete process.env.AGENTRUN_RUN_TOOLS_SENTINEL; });
  const run = await runHands(localWorkspace(root), { kind: "sandbox", computer, check }, { mode: 1, context: ctx });
  assert.deepEqual([run.shell, run.maxExecS, run.cwd], ["computer", 600, "/workspace"]);
  assert.deepEqual(checks, [{ kind: "bind", path: root }], "attach ran the check given");
  computer.clear();
  assert.equal(answerText(await run.executors.read({ path: "/workspace/a.txt" }, {})), "hello\n");
  assert.equal(answerText(await run.executors.read({ path: join(root, "a.txt") }, {})), "hello\n", "the folder's path here names the same file");
  assert.ok(computer.methods().includes("files.read"), "read went to the computer");
  computer.clear();
  const said = answerText(await run.executors.bash({ command: "echo \"$TMPDIR\"; cat a.txt" }, {}));
  assert.equal(said, "/workspace/.agentrun/tmp\nhello\n");
  assert.ok(computer.methods().includes("process.start"), "bash ran in the computer");
  assert.equal(answerText(await run.executors.bash({ command: "echo \"[$AGENTRUN_RUN_TOOLS_SENTINEL]\"" }, {})), "[]\n", "nothing of this server's environment");
  const long = answerText(await run.executors.bash({ command: "seq 1 5000" }, {}));
  const full = long.match(/Full output: (\S+)$/)?.[1];
  assert.ok(full?.startsWith("/workspace/.agentrun/output/"), long.slice(-200));
  assert.match(answerText(await run.executors.read({ path: full, offset: 5000 }, {})), /^5000\n/, "read opens a full output");
  await run.sweep();
  assert.deepEqual(readdirSync(join(root, ".agentrun")), []);
});

test("a desktop that mounts the run's folder starts its shell's programs in /workspace, as bash does; one that mounts none, where the computer starts them", async () => {
  const hello = { version: "0", os: "linux", kind: "desktop", arch: "amd64", display: ":0", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] };
  const root = scratch();
  const computer = fakeComputer(root);
  const mounted = await runHands(localWorkspace(root), { kind: "desktop", computer, hello, check: { readBackOf } }, { mode: 1, context: ctx });
  assert.equal(mounted.cwd, "/workspace");
  computer.clear();
  await mounted.hands.computer.call("shell.run", { command: "pwd" });
  await mounted.hands.computer.call("processes.start", { command: "mousepad" });
  assert.deepEqual(computer.calls.filter(([method]) => method === "exec.run" || method === "process.start").map(([method, params]) => [method, params.cwd]), [["exec.run", "/workspace"], ["process.start", "/workspace"]]);
  // No check: the desktop mounts no folder, so its programs start where the computer starts them.
  const bare = fakeComputer(scratch());
  const unmounted = await runHands(localWorkspace(scratch()), { kind: "desktop", computer: bare, hello }, { mode: 1, context: ctx });
  await unmounted.hands.computer.call("shell.run", { command: "pwd" });
  assert.equal("cwd" in bare.calls.find(([method]) => method === "exec.run")[1], false);
});

/** `workspace`, each `remove` it is asked recorded in `removes`. */
function watchedRemoves(workspace, removes) {
  return new Proxy(workspace, {
    get(target, key) {
      if (key === "remove") return async (path, options) => { removes.push(path); return target.remove(path, options); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

for (const mode of [1, 2]) {
  test(`a computer that mounts the folder (Mode ${mode}): the sweep removes the scratch through the computer, never through the run's own Workspace (on Archil the disk's file API, which the mount's write delegation refuses)`, async () => {
    const root = scratch();
    const computer = fakeComputer(root);
    const removes = [];
    const run = await runHands(watchedRemoves(localWorkspace(root), removes), { kind: "sandbox", computer, check: { readBackOf } }, { mode, context: ctx });
    computer.plant.file("/workspace/.agentrun/output/call-1", "a long output\n");
    computer.clear();
    await run.sweep();
    assert.deepEqual(readdirSync(join(root, ".agentrun")), [], "the scratch is gone");
    assert.deepEqual(computer.methods().filter((method) => method === "files.remove").length, 2, "both went through the computer");
    assert.deepEqual(removes, [], "the run's own Workspace removed nothing");
  });
}

test("a computer that no longer answers: a Mode 1 sweep removes through the run's own folder instead; a Mode 2 one fails, its scratch left, and never asks the disk's file API", async () => {
  for (const mode of [1, 2]) {
    const root = scratch();
    const computer = fakeComputer(root);
    const removes = [];
    const run = await runHands(watchedRemoves(localWorkspace(root), removes), { kind: "sandbox", computer, check: { readBackOf } }, { mode, context: ctx });
    computer.plant.file("/workspace/.agentrun/output/call-1", "a long output\n");
    computer.overrides["files.remove"] = { result: { ok: false, error: { code: "unavailable", message: "the computer is gone" } } };
    if (mode === 1) {
      await run.sweep();
      assert.deepEqual(readdirSync(join(root, ".agentrun")), [], "Mode 1: the run's own folder was swept");
      assert.deepEqual(removes, [".agentrun/output", ".agentrun/tmp"]);
    } else {
      await assert.rejects(run.sweep(), /gone|unavailable/i, "Mode 2: the sweep fails in words, for the release's log");
      assert.deepEqual(removes, [], "and never removes over the run's own Workspace while the mount may hold it");
      assert.ok(existsSync(join(root, ".agentrun", "tmp")));
    }
  }
});
