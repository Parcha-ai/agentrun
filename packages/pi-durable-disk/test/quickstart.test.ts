// The README's first quickstart is examples/01-durable-chat/on-a-directory.mjs, verbatim (scripts/stranger.mjs runs the
// README's copy in an empty directory), and it runs: a durable chat on a directory of this machine, killed after its third
// answer and resumed by a second process, every message answered once.
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scratchRoot } from "./_run-support.ts";

const example = new URL("../examples/01-durable-chat/on-a-directory.mjs", import.meta.url);
const HEADING = "## Quickstart on one machine: no disk, no key";

/**
 * SIGKILL what is left of the process group `leader` led (the supervisor, and the instances it started) and wait until the
 * group is empty. Only a real pid: `kill(-0)` would be this process's own group.
 */
async function reapGroup(leader: number): Promise<void> {
  if (!(leader > 0)) return;
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-leader, name);
      return true;
    } catch {
      return false; // ESRCH: nothing left in the group
    }
  };
  signal("SIGKILL");
  for (let i = 0; i < 500 && signal(0); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

it("the README's first quickstart carries the example file verbatim", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const at = readme.indexOf(`${HEADING}\n`);
  assert.ok(at >= 0, `the README has "${HEADING}"`);
  const block = /```js\n([\s\S]*?)```/.exec(readme.slice(at))?.[1];
  assert.equal(block, readFileSync(example, "utf8"));
});

it("runs on a directory of this machine: killed after its third answer, resumed by a second process, every message answered once", { timeout: 120_000 }, async () => {
  const dir = scratchRoot("quickstart");
  let supervisor = 0;
  try {
    // detached: the supervisor leads a group of its own, so the instances it starts go with it whatever ends the test (the
    // timeout stops only the supervisor).
    const result = spawnSync(process.execPath, [fileURLToPath(example)], { cwd: dir.root, encoding: "utf8", timeout: 110_000, detached: true } as never) as SpawnSyncReturns<string>;
    supervisor = result.pid;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^generation 1 answered message 3$/m);
    assert.match(result.stdout, /^generation 2 opened the run in .* \(\d answered before\)$/m);
    assert.match(result.stdout, /^ok: 6 messages answered once each, by generations 1 and 2, from the store in /m);
  } finally {
    await reapGroup(supervisor);
    dir.remove();
  }
});
