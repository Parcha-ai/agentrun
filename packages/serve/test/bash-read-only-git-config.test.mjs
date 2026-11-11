// git's config under the read-only bash policy (bash-read-only.ts policyEnv): a shell under a bash policy runs git with
// no system or global config and command-line config (GIT_CONFIG_COUNT, which outranks a repository's own) turning off
// what config could run on a plain read: core.fsmonitor, core.pager, hooks, a textconv or filter driver an attribute
// attaches, a signature program, a transport; and a bare repository planted in a checkout is never found by itself.
// A run whose agent sets no policy keeps the plain shell environment.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { localWorkspace } from "../dist/workspace/index.js";
import { answerText } from "../dist/workspace/executors.js";
import { runHands } from "../dist/workspace/run-tools.js";
import { bashPolicyOf, POLICY_GIT_CONFIG, policyEnv, readOnlyReason } from "../dist/bash-read-only.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { realProcesses } from "./workspace-fake-processes.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-git-config-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return { dir, root };
}

/** A run's hands in a computer (real processes over the fake computer), under `bashPolicy` when given. */
async function hands(root, bashPolicy) {
  const computer = realProcesses(fakeComputer(root), root);
  const check = { readBackOf };
  return runHands(localWorkspace(root), { kind: "sandbox", computer, check }, { mode: 1, context: ctx, ...(bashPolicy === undefined ? {} : { bashPolicy }) });
}
const bash = async (run, command) => answerText(await run.executors.bash({ command }, {}));
const gitVars = (text) => text.split("\n").filter((line) => /^(GIT_|PAGER=)/.test(line)).sort();

test("bashPolicyOf reads the agent's own tool_settings.bash.policy; policyEnv adds git's lock-down under a policy and nothing without one", () => {
  assert.equal(bashPolicyOf(undefined), undefined);
  assert.equal(bashPolicyOf({ bash: { permission: "allow" } }), undefined);
  assert.equal(bashPolicyOf({ bash: { policy: "read-only" } }), "read-only");
  assert.equal(bashPolicyOf({ bash: { policy: "made-up" } }), "made-up", "a policy the server does not know still locks the shell down");
  assert.deepEqual(policyEnv(undefined), {});
  const env = policyEnv("read-only");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.GIT_CONFIG_COUNT, String(POLICY_GIT_CONFIG.length));
  const given = Object.fromEntries(POLICY_GIT_CONFIG.map((_, n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]));
  for (const [key, value] of [["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"], ["core.pager", "cat"], ["safe.bareRepository", "explicit"], ["protocol.allow", "never"], ["core.attributesFile", "/dev/null"]]) {
    assert.equal(given[key], value, key);
  }
});

test("a read-only bash call's environment carries git's lock-down; a run with no policy's does not", async () => {
  const { root } = scratch();
  const locked = gitVars(await bash(await hands(root, "read-only"), "env"));
  assert.ok(locked.includes("GIT_CONFIG_NOSYSTEM=1"), locked.join("\n"));
  assert.ok(locked.includes("GIT_CONFIG_GLOBAL=/dev/null"));
  assert.ok(locked.includes("GIT_TERMINAL_PROMPT=0"));
  assert.ok(locked.includes("GIT_PAGER=cat"));
  assert.ok(locked.includes(`GIT_CONFIG_COUNT=${POLICY_GIT_CONFIG.length}`));
  assert.ok(locked.includes("GIT_CONFIG_KEY_0=core.fsmonitor") && locked.includes("GIT_CONFIG_VALUE_0=false"));
  const plain = gitVars(await bash(await hands(root), "env"));
  assert.deepEqual(plain, [], "no policy: the plain shell environment, no git variable");
});

test("a hostile repository config (core.fsmonitor, core.pager, a textconv driver) and a planted bare repository run nothing under the read-only policy; the same reads run them with no policy", async (t) => {
  const git = spawnSync("git", ["version"], { encoding: "utf8" });
  const [major, minor] = (git.stdout.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  if (git.status !== 0 || major < 2 || (major === 2 && minor < 43)) return t.skip(`git 2.43 or later (attr.tree) is needed: ${git.stdout || git.error}`);
  const { dir, root } = scratch();
  // The program the hostile config names, outside the run's folder: each run appends a line to its mark.
  const evil = join(dir, "evil.sh");
  const mark = join(dir, "MARK");
  writeFileSync(evil, `#!/bin/sh\necho ran >> '${mark}'\ncat "$1" 2>/dev/null\n`);
  chmodSync(evil, 0o755);
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.invalid" };
  const setup = (cwd, ...args) => assert.equal(spawnSync("git", args, { cwd, env, encoding: "utf8" }).status, 0, args.join(" "));
  const repo = join(root, "repo");
  mkdirSync(repo);
  setup(repo, "init", "-q");
  writeFileSync(join(repo, "f.txt"), "one\n");
  // The checkout's attributes attach a diff driver to every path, whose textconv the hostile config names.
  writeFileSync(join(repo, ".gitattributes"), "* diff=evil\n");
  setup(repo, "add", ".");
  setup(repo, "commit", "-q", "-m", "one");
  writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
  for (const [key, value] of [["core.fsmonitor", evil], ["core.pager", evil], ["diff.evil.textconv", evil]]) setup(repo, "config", key, value);
  // A bare repository planted in the tree, its own config naming the program: found when a command runs inside it.
  setup(repo, "init", "-q", "--bare", "planted");
  setup(join(repo, "planted"), "config", "core.fsmonitor", evil);

  const reads = ["cd repo && git status --short", "cd repo && git diff", "cd repo && git show", "cd repo && git log -p -1", "cd repo/planted && git log -1"];
  for (const command of reads) assert.equal(readOnlyReason("bash", { command }, [root]), undefined, `the policy lets ${command} through`);

  const locked = await hands(root, "read-only");
  const said = [];
  for (const command of reads) said.push(await bash(locked, command));
  assert.equal(existsSync(mark), false, `nothing the config names ran under the policy:\n${said.join("\n---\n")}`);
  assert.match(said[1], /\+two/, "git diff still reads the change");
  assert.match(said[4], /cannot use bare repository/, "the planted bare repository is refused");
  assert.equal((await bash(locked, "cd repo && git var GIT_PAGER")).trim(), "cat", "the pager git would use is cat");

  // The control: the same reads with no policy run the hostile config's program, so the test reads a real hole.
  const plain = await hands(root);
  for (const command of reads) await bash(plain, command);
  assert.ok(existsSync(mark) && readFileSync(mark, "utf8").includes("ran"), "with no policy the hostile config's program runs");
  assert.equal((await bash(plain, "cd repo && git var GIT_PAGER")).trim(), evil, "with no policy the hostile pager is git's");
});
