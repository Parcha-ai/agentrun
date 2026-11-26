// The direct commit a run's compile turn makes (runner/learning-end.ts commitDirect): a checked workflow draft written
// onto the agent's learning as a merge by the run, from the run's seed. It lands as the save it names, and a file changed
// at the newest save since the seed is a conflict (the reason logged once), nothing written.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { commitDirect } = await import("../dist/runner/learning-end.js");
const { learningOf } = await import("../dist/learn/rows.js");
const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { learningAt, mergesOf } = await import("./learn-support.mjs");

const README = "---\nname: retry-slowly\ndescription: Back off between retries\n---\n";
const world = async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-commit-direct-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
};
/** The port a run's end commits through: the agent's learning, and each line it logs in `log`. */
const portOf = (store, log = []) => ({ log, deps: { learning: learningOf(store, "agent-1"), log: (line) => log.push(line) } });
const draft = (name, json) => [{ path: `workflows/${name}/workflow.json`, text: json }, { path: `workflows/${name}/README.md`, text: README.replace("retry-slowly", name) }];

test("a direct commit lands as a merge by the run", async (t) => {
  const store = await world(t);
  const port = portOf(store);
  const done = await commitDirect(port.deps, { runId: "run-9", reason: "Compiled it.", files: draft("retry-slowly", "{\"v\":1}") });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.commit, /^[0-9a-f]{40}$/);
  assert.equal(port.log.length, 0);
  const at = await learningAt(store, "agent-1");
  assert.equal(at.view.main, done.commit);
  const [merge, ...more] = await mergesOf(store, "agent-1", "run-9");
  assert.deepEqual([merge.id, merge.reason, more.length], [done.commit, "Compiled it.", 0]);
  assert.equal(at.text("workflows/retry-slowly/workflow.json"), "{\"v\":1}");
});

test("a file changed since the seed is a conflict: said once, the newest save as it was", async (t) => {
  const store = await world(t);
  const at = (json) => draft("answer", json);
  const first = await commitDirect(portOf(store).deps, { runId: "run-8", reason: "Compiled it.", files: at("{\"v\":1}") });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await commitDirect(portOf(store).deps, { runId: "run-9", reason: "Revised it.", files: at("{\"v\":2}"), seed: first.commit });
  assert.equal(second.ok, true, JSON.stringify(second));
  const port = portOf(store);
  // A run that started from the first save finds the file changed since.
  const done = await commitDirect(port.deps, { runId: "run-10", reason: "Compiled it.", files: at("{\"v\":3}"), seed: first.commit });
  assert.equal(done.ok, false);
  assert.equal(done.reason, "conflict", JSON.stringify(done));
  assert.equal(port.log.length, 1);
  assert.match(port.log[0], /run-10.*conflict/);
  assert.equal((await learningAt(store, "agent-1")).view.main, second.commit);
});
