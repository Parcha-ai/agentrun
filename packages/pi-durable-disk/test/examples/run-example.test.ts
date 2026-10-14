// runExample and assertExampleOk, on examples written here: one that exits cleanly, and one that exits 0 while a process
// it started still holds its output.
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, scratchRoot } from "../_run-support.ts";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("a clean example passes, with its output and exit", async () => {
  const dir = scratchRoot("run-example-clean");
  try {
    writeFileSync(join(dir.root, "main.mjs"), 'console.log("ok: it ran in", process.cwd());\n');
    const run = await runExample("clean", { entry: join(dir.root, "main.mjs") });
    assert.deepEqual([run.status, run.signal, run.timedOut], [0, null, false]);
    assertExampleOk(run, /^ok: it ran in /m);
    assert.ok(run.stdout.includes(run.cwd), "it ran in its scratch directory");
    assert.equal(existsSync(run.cwd), false, "which is removed");
  } finally {
    dir.remove();
  }
});

it("an example that exits 0 while a process it started holds its output fails, and that process is gone after", async () => {
  const dir = scratchRoot("run-example-leftover");
  try {
    const pidFile = join(dir.root, "leftover.pid");
    writeFileSync(join(dir.root, "main.mjs"), [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'console.log("ok: exited, leaving a child on the pipes");',
      "process.exit(0);",
    ].join("\n"));
    const run = await runExample("leftover", { entry: join(dir.root, "main.mjs"), timeoutMs: 2_000 });
    assert.deepEqual([run.status, run.timedOut], [0, true], "close reports the example's own exit 0 once the timeout ended the child");
    assert.throws(() => assertExampleOk(run, /^ok: /m), /still running at the timeout/);
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "the group was reaped");
    assert.equal(existsSync(run.cwd), false, "and the scratch directory removed");
  } finally {
    dir.remove();
  }
});

it("a process outside the example's group that holds its output never keeps the run waiting past the timeout", async () => {
  const dir = scratchRoot("run-example-outside");
  try {
    const pidFile = join(dir.root, "outside.pid");
    writeFileSync(join(dir.root, "main.mjs"), [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'console.log("ok: exited, leaving a process of another group on the pipes");',
      "process.exit(0);",
    ].join("\n"));
    const started = Date.now();
    const run = await runExample("outside", { entry: join(dir.root, "main.mjs"), timeoutMs: 1_000 });
    const outside = Number(readFileSync(pidFile, "utf8"));
    try {
      assert.ok(Date.now() - started < 10_000, `resolved ${Date.now() - started} ms after it started`);
      assert.deepEqual([run.status, run.timedOut], [0, true]);
      assert.match(run.stderr, /outside the example's process group still held its output/);
      assert.throws(() => assertExampleOk(run, /^ok: /m), /still running at the timeout/);
    } finally {
      if (outside > 0) process.kill(outside, "SIGKILL");
    }
  } finally {
    dir.remove();
  }
});


it("an example still running at the timeout is killed with its group, reported timed out, and its directory removed", async () => {
  const dir = scratchRoot("run-example-running");
  try {
    writeFileSync(join(dir.root, "main.mjs"), 'console.log("started");\nsetInterval(() => {}, 1_000);\n');
    const started = Date.now();
    const run = await runExample("running", { entry: join(dir.root, "main.mjs"), timeoutMs: 1_000 });
    assert.ok(Date.now() - started < 10_000, `resolved ${Date.now() - started} ms after it started`);
    assert.deepEqual([run.status, run.signal, run.timedOut], [null, "SIGKILL", true]);
    assert.match(run.stdout, /^started$/m);
    assert.equal(existsSync(run.cwd), false, "its scratch directory is removed");
    assert.throws(() => assertExampleOk(run, /^ok: /m), /still running at the timeout/);
  } finally {
    dir.remove();
  }
});
