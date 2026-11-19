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

const COMMANDS = [
  ["native", /^usage: agentrun-serve native discover\|connect --project PATH \[--runtime claude-code\|codex\] \[--agent NAME\|--profile NAME\] \[--url URL\] \[--data DIR\]$/m],
  ["import", /^usage: agentrun-serve import \[--data DIR\] \[--from claude-code,codex,pi\] \[--dry-run\] /m],
  ["reset-password", /^usage: agentrun-serve reset-password \[--data DIR\]$/m],
  ["runner", /^usage: agentrun-serve runner --data DIR \[--loops N\] [^\n]*\n {7}agentrun-serve runner --check --data DIR/m],
  ["install-harness", /^usage: agentrun-serve install-harness goose\|cursor \[--data DIR\]$/m],
  ["validate-template", /^usage: agentrun-serve validate-template DIR$/m],
  ["eval-template", /^usage: agentrun-serve eval-template DIR \[--case NAME \.\.\.\] /m],
];

for (const [command, usage] of COMMANDS) {
  test(`agentrun-serve ${command} --help and -h print its usage on stdout and exit 0`, (t) => {
    for (const flag of ["--help", "-h"]) {
      const run = help(t, [command, flag]);
      assert.equal(run.status, 0, `${command} ${flag}: ${run.stderr}`);
      assert.match(run.stdout, usage, `${command} ${flag}: ${run.stdout}`);
      assert.equal(run.stderr, "", `${command} ${flag}`);
    }
  });
}

test("import --help says what the command does, with the flags the docs name for it", (t) => {
  const run = help(t, ["import", "--help"]);
  assert.match(run.stdout, /^`agentrun-serve import` reads the Claude Code, Codex and pi sessions in your own home/m, run.stdout);
  assert.match(run.stdout, /--dry-run lists what it would\s+import/, run.stdout);
});

test("the server's own --help lists native too", () => {
  const run = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ {7}agentrun-serve native discover\|connect --project PATH /m, run.stdout);
});

test("reset-password with --help clears nothing", (t) => {
  const run = help(t, ["reset-password", "--help"]);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /The password is cleared/);
});
