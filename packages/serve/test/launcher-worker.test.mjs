// The server its launcher starts can start a worker thread from a file, as a codemode script's QuickJS sandbox does
// (@earendil-works/pi-codemode's CodemodeSandbox, which passes the worker no flags of its own). A worker inherits its
// process's flags, and Node refuses one from a file that inherits --input-type ("--input-type can only be used with
// string input via --eval, --print, or STDIN"), so the launcher starts the server without it. Run here on a package of
// the launcher's layout (launcher/agentrun-serve beside dist/cli.js), reached through a link as a package manager's bin
// is, whose cli.js starts such a worker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;

test("the launcher's server starts a worker thread from a file, and is the cli.js beside the launcher with its arguments", (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "launcher-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "pkg");
  mkdirSync(join(pkg, "launcher"), { recursive: true });
  mkdirSync(join(pkg, "dist"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "tmp"));
  copyFileSync(LAUNCHER, join(pkg, "launcher", "agentrun-serve"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(pkg, "dist", "worker.js"), `import { parentPort } from "node:worker_threads"; parentPort.postMessage("worker ran");\n`);
  writeFileSync(join(pkg, "dist", "cli.js"), [
    `import { Worker } from "node:worker_threads";`,
    `const worker = new Worker(new URL("./worker.js", import.meta.url));`,
    `const said = await new Promise((resolve) => { worker.once("message", resolve); worker.once("error", (error) => resolve("refused: " + error.message)); });`,
    `await worker.terminate();`,
    `console.log(JSON.stringify({ said, main: process.argv[1], args: process.argv.slice(2) }));`,
  ].join("\n"));
  symlinkSync(join(pkg, "launcher", "agentrun-serve"), join(dir, "bin", "agentrun-serve"));
  const env = { ...process.env, PATH: `${join(process.execPath, "..")}:${process.env.PATH}`, TMPDIR: join(dir, "tmp") };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const ran = spawnSync(join(dir, "bin", "agentrun-serve"), ["--data", "x", "--port", "0"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr.slice(0, 600));
  const out = JSON.parse(ran.stdout.trim().split("\n").at(-1));
  assert.equal(out.said, "worker ran", "the worker started from its file");
  assert.equal(out.main, join(pkg, "dist", "cli.js"), "the server is the cli.js beside the launcher's real path");
  assert.deepEqual(out.args, ["--data", "x", "--port", "0"], "with the launcher's arguments");
});
