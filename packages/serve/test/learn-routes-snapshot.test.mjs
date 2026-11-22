// The learning routes read main's snapshot (`.agentrun/snapshot.json`) and the bodies it names at main's commit, and a
// merge's diff from the store, through the learning store's reads alone (head, read, log, diff): no route read saves
// anything. A person's write is ONE save. A file changed by hand in the folder's working tree changes nothing read.
import assert from "node:assert/strict";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { forgetBodies } from "../dist/learn/folder.js";
import { localStoreHooks } from "../dist/learn/store-local.js";
import { ended, LEARN, learner, made, repoOf, started } from "./learn-support.mjs";
import { serve } from "./support.mjs";

const FLOW = "workflows/answer/workflow.json";
const README = "workflows/answer/README.md";
const READS = ["head", "read", "log", "diff"];

test("no learning route read saves: the view, its log, a file, the corrections, a run's learning and its diff, and the agents' pending counts are store reads alone; a person's write is one save", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("reader", { learning: { compile_after: 1 } }));
  const run = await ended(api, await started(api, "reader"));
  assert.equal(run.view.learning?.state, "merged", JSON.stringify(run.view.learning));
  const runId = run.view.run_id;
  const files = "/agents/reader/learning/files";
  const path = (file) => `${files}/${encodeURIComponent(file)}`;

  const ops = [];
  localStoreHooks.exec = (argv) => void ops.push(argv[2]);
  t.after(() => void (localStoreHooks.exec = undefined));
  forgetBodies();

  const view = (await api("GET", "/agents/reader/learning")).body;
  assert.deepEqual(view.workflows.map((flow) => flow.file), [FLOW]);
  assert.equal((await api("GET", "/agents/reader/learning/log")).body.items[0].by.run, runId);
  const readme = await api("GET", path(README));
  assert.equal(readme.status, 200);
  assert.equal((await api("GET", path(FLOW))).status, 200);
  assert.equal((await api("GET", "/agents/reader/learning/corrections")).status, 200);
  assert.equal((await api("GET", `/runs/${runId}/learning`)).status, 200);
  const diff = (await api("GET", `/runs/${runId}/learning/diff`)).body;
  assert.deepEqual(diff.files.map((f) => [f.path, f.status]), [[README, "added"], [FLOW, "added"]]);
  assert.equal((await api("GET", "/agents")).status, 200);
  assert.equal((await api("GET", "/agents/reader")).status, 200);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 200);
  assert.ok(ops.length > 0, "the routes read the store");
  assert.deepEqual(ops.filter((op) => !READS.includes(op)), [], "every route read is a store read: no save");

  // A person's corrections edit and a retire: each one save.
  const corrections = await api("GET", "/agents/reader/learning/corrections");
  ops.length = 0;
  const edit = await api("PUT", "/agents/reader/learning/corrections", { text: "- Answer in one line.\n" }, { "if-match": corrections.headers.get("etag") });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(ops.filter((op) => !READS.includes(op)), ["commit"], "an edit is one save");
  const current = await api("GET", path(README));
  ops.length = 0;
  assert.equal((await api("POST", `${path(README)}/retire`, undefined, { "if-match": current.headers.get("etag") })).status, 200);
  assert.deepEqual(ops.filter((op) => !READS.includes(op)), ["commit"], "a retire is one save");

  // A file changed by hand in the working tree (no commit): every read is at main's commit, so it reads as before.
  const retired = await api("GET", path(README));
  const repo = repoOf(data, "reader");
  writeFileSync(join(repo, README), "half a README");
  forgetBodies();
  const again = await api("GET", path(README));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, retired.body);
  assert.equal((await api("GET", "/agents/reader/learning")).status, 200);

  // A link found in the folder later (its .git replaced by one): reads fail closed, in words that name it.
  forgetBodies();
  renameSync(join(repo, ".git"), join(repo, "git-moved"));
  symlinkSync(join(repo, "git-moved"), join(repo, ".git"));
  const linked = await api("GET", path(README));
  assert.deepEqual([linked.status, linked.body?.error?.code], [500, "internal"], JSON.stringify(linked.body));
  assert.match(linked.body.error.message, /^a link in the learning folder at disk\/agents\/[^/]+\/learning\/\.git can't be followed, so nothing learned is read or written; remove the link$/);
  const view2 = await api("GET", "/agents/reader/learning");
  assert.match(view2.body?.error?.message ?? "", /^a link in the learning folder at .*\.git can't be followed/);
});
