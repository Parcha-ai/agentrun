// Serve's Cursor tests on a host Cursor is not pinned for. CURSOR_PIN pins linux-x86_64 alone, so on any other host (a
// Mac among them) Cursor is refused ACP_BINARY_UNPINNED before its install is looked at. harness-cursor.test.mjs runs
// again here, in a process whose process.arch says arm64 (linux-aarch64: no pin, the rest of this host as it is), and
// must pass: each test that looks at an install asserts that refusal by its code there, never by a skip.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** Loaded before the tests: this process says it runs on arm64, so acpPlatform() is linux-aarch64, which no pin names. */
const AS_ARM64 = 'data:text/javascript,Object.defineProperty(process,"arch",{value:"arm64"})';
const FILE = fileURLToPath(new URL("./harness-cursor.test.mjs", import.meta.url));
/** The tests whose install step the platform decides: each must run, by the refusal. */
const BY_PLATFORM = [/^ok \d+ - cursor is one entry of the table/, /^ok \d+ - not installed, a run's adapter is refused/, /^ok \d+ - a server whose data has no Cursor/];

test("on a host Cursor is not pinned for (linux-aarch64, faked), serve's Cursor tests pass, each install refused ACP_BINARY_UNPINNED first", { timeout: 300_000 }, () => {
  const env = { ...process.env };
  for (const name of ["AGENTRUN_TEST_CURSOR", "CURSOR_API_KEY", "NODE_TEST_CONTEXT"]) delete env[name];
  const run = spawnSync(process.execPath, ["--import", AS_ARM64, "--test", "--test-reporter=tap", FILE], { encoding: "utf8", env, cwd: fileURLToPath(new URL("..", import.meta.url)) });
  const lines = run.stdout.split("\n");
  assert.deepEqual(lines.filter((line) => /^\s*not ok/.test(line)), [], run.stdout.slice(-4000));
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  for (const name of BY_PLATFORM) {
    const line = lines.find((each) => name.test(each));
    assert.ok(line && !/# SKIP/.test(line), `${name}: ran, not skipped: ${line}`);
  }
});
