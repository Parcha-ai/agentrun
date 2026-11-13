// A test's scratch directory outlives the processes the test starts in it. node:test runs a test's after-hooks in the
// order they were added, so a directory removed by a hook added as it was made would go before the stop of a server or
// child started in it afterwards, while that process still writes there (ENOTEMPTY, or a process writing into nothing).
// The check is the order alone: the stop looks for the directory, and no timing decides it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

test("a scratch directory is still there when the process that writes into it, started afterwards, is stopped", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const child = spawn(process.execPath, ["-e", 'const fs = require("node:fs"); setInterval(() => fs.writeFileSync(require("node:path").join(process.env.WRITE_INTO, "alive"), String(Date.now())), 10);'], { stdio: "ignore", env: { ...process.env, WRITE_INTO: dir } });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  // The stop, added after the directory was made, as every helper adds a server's or child's stop, and before anything
  // that could fail: a stop never added would leave the child writing while the file's end removes the directory.
  let there;
  t.after(async () => {
    there = existsSync(dir);
    child.kill("SIGKILL");
    await exited;
    assert.ok(there, "the directory was still there when its writer was stopped");
  });
  for (let i = 0; !existsSync(join(dir, "alive")); i++) {
    assert.ok(i < 3000 && child.exitCode === null, "the child writes into the directory");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});
