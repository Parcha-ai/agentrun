// The test helpers that signal processes never signal a process group. A test whose child failed to start still holds
// `pid = 0` in its `finally`, and `process.kill(0, ...)` signals the caller's own process group: the test runner and
// every test file running beside it. Checked in a child process that leads its own group, so a regression kills only it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUPPORT = fileURLToPath(new URL("./_run-support.ts", import.meta.url));

test("killQuietly and alive refuse pid 0 and below, so a test that never learned its child's pid kills nothing", () => {
  const script = `import { alive, killQuietly } from ${JSON.stringify(SUPPORT)};
if (alive(0) || alive(-process.pid)) throw new Error("alive() answered for a process group");
killQuietly(0);
killQuietly(-process.pid);
process.stdout.write("still here");`;
  // detached: the child leads its own process group, so a kill(0) or kill(-pid) reaches only it.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000, detached: true } as never);
  assert.equal(child.signal, null, `the helper killed its own process group (${child.signal})`);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "still here");
});
