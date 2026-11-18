// The learning routes read the folder's snapshot (`.agentrun/snapshot.json`), the working-tree bodies it names and a
// merge's diff file, through the folder's Workspace file API alone: no route read runs git or execs anything, and no
// read writes. A person's write is ONE exec of the learning script. A body that is not the snapshot's blob, twice, is 503.
import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { folderTestHooks, forgetBodies, SCRIPT_FILE } from "../dist/learn/folder.js";
import { ended, LEARN, learner, made, repoOf, spiedWorkspace, started } from "./learn-support.mjs";
import { serve } from "./support.mjs";

const FLOW = "workflows/answer/workflow.json";
const README = "workflows/answer/README.md";

test("no learning route read execs, runs git or writes: the view, its log, a file, the corrections, a run's learning and its diff, and the agents' pending counts read the snapshot and its bodies alone; a person's write is one exec of the script", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("reader", { learning: { compile_after: 1 } }));
  const run = await ended(api, await started(api, "reader"));
  assert.equal(run.view.learning?.state, "merged", JSON.stringify(run.view.learning));
  const runId = run.view.run_id;
  const files = "/agents/reader/learning/files";
  const path = (file) => `${files}/${encodeURIComponent(file)}`;

  const calls = [];
  folderTestHooks.workspace = spiedWorkspace(calls);
  t.after(() => void (folderTestHooks.workspace = undefined));
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
  assert.deepEqual(calls.filter(([method]) => method !== "read"), [], "every route read is a file read: no exec, no write");
  assert.deepEqual([...new Set(calls.map(([, at]) => at))].sort(), [`.agentrun/diffs/${runId}.json`, ".agentrun/snapshot.json", FLOW, README].sort());
  assert.ok(calls.opened > 0 && calls.opened === calls.ended, `every folder opened is ended: ${calls.opened} opened, ${calls.ended} ended`);

  // A person's corrections edit and a retire: each one exec, the script's commit, and no git on this side.
  calls.length = 0;
  const corrections = await api("GET", "/agents/reader/learning/corrections");
  calls.length = 0;
  const edit = await api("PUT", "/agents/reader/learning/corrections", { text: "- Answer in one line.\n" }, { "if-match": corrections.headers.get("etag") });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(calls.filter(([method]) => method === "exec").map(([, argv]) => argv), [`sh ${SCRIPT_FILE} commit ${view.main}`], "an edit is one exec");
  calls.length = 0;
  const current = await api("GET", path(README));
  assert.equal((await api("POST", `${path(README)}/retire`, undefined, { "if-match": current.headers.get("etag") })).status, 200);
  assert.deepEqual(calls.filter(([method]) => method === "exec").map(([, argv]) => argv.split(" ")[2]), ["commit"], "a retire is one exec");

  // A body that is not the snapshot's blob (a write in flight elsewhere), as it is read twice: 503, and no exec. The view
  // reads a retired draft's README.md (is it unreadable?), so it is 503 too.
  forgetBodies();
  calls.length = 0;
  writeFileSync(join(repoOf(data, "reader"), README), "half a README");
  const busy = await api("GET", path(README));
  assert.deepEqual([busy.status, busy.body?.error?.code], [503, "unavailable"], JSON.stringify(busy.body));
  assert.equal((await api("GET", "/agents/reader/learning")).status, 503);
  assert.equal((await api("GET", path(FLOW))).status, 200, "a body that is the snapshot's still reads");
  assert.deepEqual(calls.filter(([method]) => method !== "read"), [], "no read repairs anything: it reads");
  assert.equal(calls.opened, calls.ended, "every folder opened is ended, a failing read's too");

  // A link found in the folder later (the retired draft's README.md, which the view reads, replaced by one): reads fail
  // closed, in words that name it.
  folderTestHooks.workspace = undefined;
  forgetBodies();
  const repo = repoOf(data, "reader");
  rmSync(join(repo, README));
  symlinkSync("/etc/hostname", join(repo, README));
  const linked = await api("GET", path(README));
  assert.deepEqual([linked.status, linked.body?.error?.code], [500, "internal"], JSON.stringify(linked.body));
  assert.equal(linked.body.error.message, `a link in the learning folder at ${README} can't be followed, so nothing learned is read or written; remove the link`);
  const view2 = await api("GET", "/agents/reader/learning");
  assert.match(view2.body?.error?.message ?? "", new RegExp(`^a link in the learning folder at ${README.replaceAll(".", "\\.")} can't be followed`));
});
