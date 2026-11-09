// The learning routes read the folder's snapshot (`.agentrun/snapshot.json`), the working-tree bodies it names and a
// merge's diff file, through the folder's Workspace file API alone: no route read runs git or execs anything, and no
// read writes. A person's write is ONE exec of the learning script (a restore reads its retire first, one more). A
// body that is not the snapshot's blob, twice, is 503.
import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { folderTestHooks, forgetBodies, SCRIPT_FILE } from "../dist/learn/folder.js";
import { learningTestHooks } from "../dist/learning.js";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learnedOnMain, learner, made, proposedOf, repoOf, SWITCH_TODO, settled, spiedWorkspace, started } from "./learn-support.mjs";
import { serve } from "./support.mjs";

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const SOURCES = note("Quote sources", "Name the page each figure came from");
const ASK = note("Ask first", "Ask which currency when the question names none");

test("no learning route read execs, runs git or writes: the view, its pages, a file, a run's learning and its diff, and the agents' pending counts read the snapshot and its bodies alone; a person's write is one exec of the script", { timeout: 180_000, skip: SWITCH_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("reader", { plan: [["check-units.md", UNITS], ["quote-sources.md", SOURCES]], once: true }));
  const run = await ended(api, await started(api, "reader"));
  proposedOf(run.view);
  assert.equal((await learnedOnMain({ api, data }, "reader", run.view.run_id)).result?.ok, true);
  const runId = run.view.run_id;
  const files = "/agents/reader/learning/files";

  const calls = [];
  const gitCalls = [];
  folderTestHooks.workspace = spiedWorkspace(calls);
  learningTestHooks.git = (args) => gitCalls.push(args);
  t.after(() => void (folderTestHooks.workspace = undefined, learningTestHooks.git = undefined));
  forgetBodies();

  const view = (await api("GET", "/agents/reader/learning")).body;
  assert.deepEqual(view.notes.items.map((n) => n.file), ["check-units.md", "quote-sources.md"]);
  const page = (await api("GET", "/agents/reader/learning/notes?limit=1")).body;
  assert.equal((await api("GET", `/agents/reader/learning/notes?limit=1&cursor=${page.next_cursor}`)).status, 200);
  assert.equal((await api("GET", "/agents/reader/learning/log")).body.items[0].by.run, runId);
  const file = await api("GET", `${files}/check-units.md`);
  assert.equal(file.status, 200);
  assert.equal((await api("GET", `${files}/MEMORY.md`)).status, 200);
  assert.equal((await api("GET", `/runs/${runId}/learning`)).status, 200);
  const diff = (await api("GET", `/runs/${runId}/learning/diff`)).body;
  assert.deepEqual(diff.files.map((f) => [f.path, f.status]), [["MEMORY.md", "modified"], ["check-units.md", "added"], ["quote-sources.md", "added"]]);
  assert.equal((await api("GET", "/agents")).status, 200);
  assert.equal((await api("GET", "/agents/reader")).status, 200);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 200);
  assert.deepEqual(calls.filter(([method]) => method !== "read"), [], "every route read is a file read: no exec, no write");
  assert.deepEqual([...new Set(calls.map(([, path]) => path))].sort(), [".agentrun/diffs/" + `${runId}.json`, ".agentrun/snapshot.json", "MEMORY.md", "check-units.md", "quote-sources.md"].sort());
  assert.deepEqual(gitCalls, [], "no route read runs git");
  assert.ok(calls.opened > 0 && calls.opened === calls.ended, `every folder opened is ended: ${calls.opened} opened, ${calls.ended} ended`);

  // A person's edit, create and retire: each one exec, the script's commit, and no git on this side.
  calls.length = 0;
  const edit = await api("PUT", `${files}/check-units.md`, { text: UNITS.replace("one unit", "the answer's unit") }, { "if-match": file.headers.get("etag") });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(calls.filter(([method]) => method === "exec").map(([, argv]) => argv), [`sh ${SCRIPT_FILE} commit ${view.main}`], "an edit is one exec");
  calls.length = 0;
  assert.equal((await api("PUT", `${files}/ask-first.md`, { text: ASK }, { "if-none-match": "*" })).status, 201);
  assert.deepEqual(calls.filter(([method]) => method === "exec").map(([, argv]) => argv.split(" ")[2]), ["commit"], "a create is one exec");
  calls.length = 0;
  const sources = await api("GET", `${files}/quote-sources.md`);
  assert.equal((await api("POST", `${files}/quote-sources.md/retire`, undefined, { "if-match": sources.headers.get("etag") })).status, 200);
  assert.deepEqual(calls.filter(([method]) => method === "exec").map(([, argv]) => argv.split(" ")[2]), ["commit"], "a retire is one exec");
  assert.deepEqual(gitCalls, [], "no write runs git on this side");

  // A body that is not the snapshot's blob (a write in flight elsewhere), as it is read twice: 503, and no exec.
  forgetBodies();
  calls.length = 0;
  writeFileSync(join(repoOf(data, "reader"), "ask-first.md"), "half a note");
  const busy = await api("GET", `${files}/ask-first.md`);
  assert.deepEqual([busy.status, busy.body?.error?.code], [503, "unavailable"], JSON.stringify(busy.body));
  assert.equal((await api("GET", "/agents/reader/learning")).status, 503);
  assert.equal((await api("GET", `${files}/check-units.md`)).status, 200, "a body that is the snapshot's still reads");
  assert.deepEqual(calls.filter(([method]) => method !== "read"), [], "no read repairs anything: it reads");
  assert.equal(calls.opened, calls.ended, "every folder opened is ended, a failing read's too");

  // A link found in the folder later (a note's file replaced by one): reads fail closed, in words that name it.
  folderTestHooks.workspace = undefined;
  forgetBodies();
  const repo = repoOf(data, "reader");
  writeFileSync(join(repo, "ask-first.md"), ASK);
  rmSync(join(repo, "check-units.md"));
  symlinkSync("/etc/hostname", join(repo, "check-units.md"));
  const linked = await api("GET", `${files}/check-units.md`);
  assert.deepEqual([linked.status, linked.body?.error?.code], [500, "internal"], JSON.stringify(linked.body));
  assert.equal(linked.body.error.message, "a link in the learning folder at check-units.md can't be followed, so nothing learned is read or written; remove the link");
  const view2 = await api("GET", "/agents/reader/learning");
  assert.match(view2.body?.error?.message ?? "", /^a link in the learning folder at check-units\.md can't be followed/);
});
