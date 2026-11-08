// A run's tools bound to its Workspace (serve/src/workspace/run-tools.ts runHands): with no computer the shell is the
// run's folder ("local"), named by its own path, 600 s at most (295 s on Archil's exec, Mode 2); with a computer it is
// "computer", the folder at /workspace, the Workspace attached through the mount check given. bash's TMPDIR and its
// full outputs are in the run's folder, readable with read, and the run's end sweeps them; nothing of this server's
// environment reaches a command.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { localWorkspace } from "../dist/workspace/index.js";
import { answerText } from "../dist/workspace/executors.js";
import { runHands, TMP_DIR } from "../dist/workspace/run-tools.js";
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

test("no computer: the shell is the run's folder, named by its own path; TMPDIR and full outputs are in it, read opens one, the end sweeps both", async () => {
  const root = scratch();
  writeFileSync(join(root, "a.txt"), "hello\n");
  process.env.AGENTRUN_RUN_TOOLS_SENTINEL = "a server secret";
  try {
    const run = await runHands(localWorkspace(root), undefined, { mode: 1, context: ctx });
    assert.deepEqual([run.shell, run.maxExecS, run.cwd, run.hands.maxExecS], ["local", 600, root, 600]);
    const env = answerText(await run.executors.bash({ command: "echo \"[$AGENTRUN_RUN_TOOLS_SENTINEL]\" \"$TMPDIR\" \"$HOME\"; mktemp" }, {}));
    const [line, made] = env.split("\n");
    assert.equal(line, `[] ${root}/${TMP_DIR} ${root}`);
    assert.ok(made.startsWith(`${root}/${TMP_DIR}/`), `mktemp makes its file in the run's TMPDIR: ${made}`);
    assert.equal(answerText(await run.executors.read({ path: "a.txt" }, {})), "hello\n");
    assert.equal(answerText(await run.executors.read({ path: join(root, "a.txt") }, {})), "hello\n");
    const long = answerText(await run.executors.bash({ command: "seq 1 5000" }, {}));
    const full = long.match(/Full output: (\S+)$/)?.[1];
    assert.ok(full?.startsWith(`${root}/.agentrun/output/`), long.slice(-200));
    assert.match(answerText(await run.executors.read({ path: full, offset: 5000 }, {})), /^5000\n/, "read opens a full output");
    await run.sweep();
    assert.deepEqual(readdirSync(join(root, ".agentrun")), [], "the end swept the outputs and TMPDIR");
    assert.ok(existsSync(join(root, "a.txt")));
  } finally {
    delete process.env.AGENTRUN_RUN_TOOLS_SENTINEL;
  }
});

test("Mode 2 with no computer: a command runs 295 s at most (Archil's exec)", async () => {
  const run = await runHands(localWorkspace(scratch()), undefined, { mode: 2, context: ctx });
  assert.deepEqual([run.shell, run.maxExecS, run.hands.maxExecS], ["local", 295, 295]);
});

test("a computer: the Workspace attached through the mount check given; the folder is /workspace (its path here an alias); bash and read go through the computer", async () => {
  const root = scratch();
  writeFileSync(join(root, "a.txt"), "hello\n");
  const computer = realProcesses(fakeComputer(root), root);
  const checks = [];
  const check = { readBackOf: (spec) => (checks.push(spec), readBackOf(spec)) };
  const run = await runHands(localWorkspace(root), { computer, check }, { mode: 1, context: ctx });
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
  await run.sweep();
  assert.deepEqual(readdirSync(join(root, ".agentrun")), []);
});
