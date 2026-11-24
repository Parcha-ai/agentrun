// The direct commit a run's compile turn makes (runner/learning-end.ts commitDirect): a checked workflow draft written
// onto the agent's learning folder as a merge by the run, from the run's seed. It lands as the learning commit it names, a
// file changed on main since the seed is a conflict (the reason logged once), and the folder is always released.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { commitDirect } = await import("../dist/runner/learning-end.js");
const { learningFolderOf } = await import("../dist/learning.js");
const { git, repoOf, resnap } = await import("./learn-support.mjs");

const README = "---\nname: retry-slowly\ndescription: Back off between retries\n---\n";
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
const draft = (name, json) => [{ path: `workflows/${name}/workflow.json`, text: json }, { path: `workflows/${name}/README.md`, text: README.replace("retry-slowly", name) }];

test("a direct commit lands as a merge by the run, and the folder is released", async (t) => {
  const dir = world(t);
  const port = portOf(dir);
  const done = await commitDirect(port.deps, { runId: "run-9", reason: "Compiled it.", files: draft("retry-slowly", "{\"v\":1}") });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(port.seen, { opened: 1, ended: 1 });
  assert.equal(port.log.length, 0);
  const repo = repoOf(dir, "agent-1");
  assert.equal(git(repo, ["rev-parse", "main"]), done.commit);
  assert.match(git(repo, ["log", "-1", "--format=%B", "main"]), /Run-Id: run-9/);
  assert.equal(git(repo, ["show", "main:workflows/retry-slowly/workflow.json"]), "{\"v\":1}");
});

test("a file changed on main since the seed is a conflict: said once, folder released, main as it was", async (t) => {
  const dir = world(t);
  const at = (json) => draft("answer", json);
  const first = await commitDirect(portOf(dir).deps, { runId: "run-8", reason: "Compiled it.", files: at("{\"v\":1}") });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await commitDirect(portOf(dir).deps, { runId: "run-9", reason: "Revised it.", files: at("{\"v\":2}"), seed: first.commit });
  assert.equal(second.ok, true, JSON.stringify(second));
  await resnap(dir, "agent-1");
  const port = portOf(dir);
  // A run that started from the first commit finds the file changed since.
  const done = await commitDirect(port.deps, { runId: "run-10", reason: "Compiled it.", files: at("{\"v\":3}"), seed: first.commit });
  assert.equal(done.ok, false);
  assert.equal(done.reason, "conflict", JSON.stringify(done));
  assert.equal(port.log.length, 1);
  assert.match(port.log[0], /run-10.*conflict/);
  assert.deepEqual(port.seen, { opened: 1, ended: 1 });
  assert.equal(git(repoOf(dir, "agent-1"), ["rev-parse", "main"]), second.commit);
});
