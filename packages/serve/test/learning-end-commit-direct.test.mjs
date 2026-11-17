// The direct commit a runner makes outside a learning run (runner/learning-end.ts commitDirect): a workflow text written
// onto the agent's learning folder as a merge by a run, from the claim's seed. It lands as the learning commit it names, a
// file changed on main since the seed is a conflict (null, the reason logged), and the folder is always released.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { commitDirect } = await import("../dist/runner/learning-end.js");
const { learningFolderOf } = await import("../dist/learning.js");
const { git, repoOf, resnap } = await import("./learn-support.mjs");

const NOTE = "---\nname: Retry slowly\ndescription: Back off between retries\ntype: reference\n---\nWait a little longer after each failed call.\n";
const world = (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-commit-direct-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A port counting how many folders it opened and ended. */
const portOf = (dir, log = []) => {
  const seen = { opened: 0, ended: 0 };
  return { seen, log, deps: { log: (line) => log.push(line), folder: () => { seen.opened += 1; const f = learningFolderOf(dir, "agent-1"); return { ...f, end: async () => { seen.ended += 1; await f.end(); } }; } } };
};

test("a direct commit lands as a merge by the run, and the folder is released", async (t) => {
  const dir = world(t);
  const port = portOf(dir);
  const commit = await commitDirect(port.deps, [{ path: "retry-slowly.md", text: NOTE }], "Compiled it.", "run-9");
  assert.match(commit ?? "", /^[0-9a-f]{40}$/);
  assert.deepEqual(port.seen, { opened: 1, ended: 1 });
  const repo = repoOf(dir, "agent-1");
  assert.equal(git(repo, ["rev-parse", "main"]), commit);
  assert.match(git(repo, ["log", "-1", "--format=%B", "main"]), /Run-Id: run-9/);
  assert.match(git(repo, ["show", "main:retry-slowly.md"]), /Wait a little longer/);
});

test("a file changed on main since the seed is a conflict: null, said once, folder released", async (t) => {
  const dir = world(t);
  const at = (text) => [{ path: "workflows/answer/workflow.json", text }];
  const first = await commitDirect(portOf(dir).deps, at("{\"v\":1}"), "Compiled it.", "run-8");
  assert.match(first ?? "", /^[0-9a-f]{40}$/);
  const second = await commitDirect(portOf(dir).deps, at("{\"v\":2}"), "Revised it.", "run-9");
  assert.match(second ?? "", /^[0-9a-f]{40}$/);
  await resnap(dir, "agent-1");
  const port = portOf(dir);
  // A run that started from the first commit finds the file changed since.
  const commit = await commitDirect(port.deps, at("{\"v\":3}"), "Compiled it.", "run-10", first);
  assert.equal(commit, null);
  assert.equal(port.log.length, 1);
  assert.deepEqual(port.seen, { opened: 1, ended: 1 });
  assert.equal(git(repoOf(dir, "agent-1"), ["rev-parse", "main"]), second);
});
