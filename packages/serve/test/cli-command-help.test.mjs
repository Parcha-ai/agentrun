// Every agentrun-serve command answers --help (and -h) with its own usage on stdout and exit 0, before it reads anything
// else it was given: no store opened, no password cleared, no harness downloaded. `agentrun native --help` and
// `agentrun import --help` reach these through the launcher (packages/agentrun), so the flags the docs name for them can
// be read where they are run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

/** The CLI run with `args` on a fresh, empty data folder, which it must leave empty. */
function help(t, args) {
  const data = mkdtempSync(join(tmpdir(), "agentrun-command-help-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [CLI, ...args, "--data", data], { encoding: "utf8", timeout: 60_000, env: { ...process.env, AGENTRUN_TELEMETRY: "0" } });
  assert.deepEqual(readdirSync(data), [], `${args.join(" ")} touched nothing in its data folder`);
  return run;
}

for (const command of ["native", "import", "reset-password", "runner", "install-harness", "validate-template", "eval-template"]) {
  test(`agentrun-serve ${command} --help and -h print its usage on stdout and exit 0`, (t) => {
    for (const flag of ["--help", "-h"]) {
      const run = help(t, [command, flag]);
      assert.equal(run.status, 0, `${command} ${flag}: ${run.stderr}`);
      assert.match(run.stdout, new RegExp(`^usage: agentrun-serve ${command} `), `${command} ${flag}: ${run.stdout}`);
      assert.equal(run.stderr, "", `${command} ${flag}`);
    }
  });
}

test("import --help says what the command does, with the flags the docs name for it", (t) => {
  const run = help(t, ["import", "--help"]);
  assert.match(run.stdout, /^`agentrun-serve import` reads the Claude Code, Codex, pi and OpenCode sessions in your own home/m, run.stdout);
  assert.match(run.stdout, /--dry-run lists what it would\s+import/, run.stdout);
});

test("native, called wrong, answers with the usage line its --help prints, and refuses a flag that line does not name", (t) => {
  const usage = help(t, ["native", "--help"]).stdout.split("\n")[0];
  const wrong = help(t, ["native", "discover"]);
  assert.equal(wrong.status, 2, wrong.stderr);
  assert.equal(wrong.stderr.trim(), `agentrun native: ${usage}`);
  const unnamed = help(t, ["native", "connect", "--project", "/nowhere", "--runtime", "codex", "--base-url", "https://agentrun.example.test"]);
  assert.equal(unnamed.status, 2, unnamed.stderr);
  assert.match(unnamed.stderr, /Unknown option '--base-url'/);
});

test("the server's own --help lists native too, and its flags' words start in one column", () => {
  const run = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ {7}agentrun-serve native discover\|connect --project PATH /m, run.stdout);
  const column = (flag) => run.stdout.match(new RegExp(`^  ${flag} +`, "m"))?.[0].length;
  assert.deepEqual(["--data DIR", "--listen ADDR", "--port N"].map(column), [20, 20, 20], run.stdout);
});
