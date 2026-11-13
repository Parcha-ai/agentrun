// mini-demos.py --movie records only on a demo machine: a CI runner (GITHUB_ACTIONS=true) or a user whose login name
// starts with agentrun-demo. The real script runs under a wrapper that gives it a login name from the user database's
// lookup (pwd.getpwuid) and stops it at its lock file, the first thing a run makes, so a run let through makes nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../daemon-macos/scripts/mini-demos.py", import.meta.url));

const WRAPPER = `
import os, pwd, runpy, sys
login, script = sys.argv[1], sys.argv[2]
class Account:
    pw_name = login
pwd.getpwuid = lambda uid: Account()
class Reached(Exception):
    pass
real_open = os.open
def guarded(path, *rest, **named):
    if path == "/private/tmp/agentrun-demos.lock":
        raise Reached()
    return real_open(path, *rest, **named)
os.open = guarded
sys.argv = [script, "/nonexistent/computerd", "/nonexistent/home", "/nonexistent/out", *sys.argv[3:]]
try:
    runpy.run_path(script, run_name="__main__")
except Reached:
    print("reached the lock")
    sys.exit(0)
`;

/** The script with these options, as this login, on CI or not. */
function run(login, { ci = false, options = ["--movie"] } = {}) {
  const env = { ...process.env, USER: "agentrun-demo-from-env", LOGNAME: "agentrun-demo-from-env" };
  delete env.GITHUB_ACTIONS;
  if (ci) env.GITHUB_ACTIONS = "true";
  return spawnSync("python3", ["-I", "-c", WRAPPER, login, SCRIPT, ...options], { encoding: "utf8", env });
}

// Every run's $USER and $LOGNAME name a demo account: they unlock nothing.
test("--movie refuses as an ordinary user, in words, before anything is made", () => {
  const r = run("someone");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--movie records only on a demo machine/);
  assert.doesNotMatch(r.stdout, /reached the lock/);
});

test("--movie runs on a CI runner", () => {
  const r = run("runner", { ci: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reached the lock/);
});

test("--movie runs as a demo account", () => {
  const r = run("agentrun-demo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reached the lock/);
  assert.equal(run("agentrun-demo-2").status, 0);
});

test("without --movie an ordinary user runs", () => {
  const r = run("someone", { options: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reached the lock/);
});
