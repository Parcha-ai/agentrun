// DELETE /v2/runs/{run_id} on the learning kept from before learning moved to the store's rows
// (changes/learning-store-rows.md, learn/legacy/scrub.ts). Nothing reads that learning any more and nothing removes it
// at the upgrade, but a run's purge still takes the run's text off it, as the purge did before (and an agent's purge
// removes it whole, as before):
//   - the agent's old learning folder (a git folder under the data directory, written by its script the way a run's
//     look-back merged its feedback line): the run's corrections.md line leaves main's working tree and main's tip, in a
//     host commit, and its diff file leaves the folder; another run's line and diff stay;
//   - the old settings keys: learning.grades.<agent> drops the run's grade, learning.promotions.<agent> blanks the
//     disagreement it copied; another run's stay.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { correctionLine } from "../dist/learn/corrections.js";
import { writeLearning } from "../dist/learn/legacy/folder.js";
import { learningWorkspace, legacyLearningFolder } from "../dist/learn/legacy/place.js";
import { follow, serve, startRun } from "./support.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Run `runId`'s look-back merge of one feedback line on agent `agentId`'s old learning folder, as the old
 *  learn/commit.ts appendCorrection wrote it (its line by corrections.ts correctionLine): one exec of the folder's script, corrections.md with the line appended,
 *  the merge's diff file beside it. */
async function oldMerge(data, agentId, runId, text) {
  const { workspace, end } = learningWorkspace({ mode: "local", agentId, data });
  try {
    await writeLearning(workspace, async ({ snapshot, body }) => {
      const before = snapshot?.corrections ? await body("corrections.md", snapshot.corrections.oid) : "";
      const line = correctionLine(text);
      const after = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${line}`;
      return { result: true, change: { by: { run: runId, reason: "the owner's correction" }, writes: [{ path: "corrections.md", text: after }] } };
    });
  } finally {
    await end();
  }
}

/** A promotion record holding one check disagreement copied from each of `runs`. */
const recordOf = (runs) => ({
  workflow: "sum", digest: "d1", at: new Date().toISOString(), decided: "hold", reason: "it held",
  check: { disagreements: runs.map((run) => ({ run, input: `INPUT-OF-${run}`, agent: `ANSWER-OF-${run}`, draft: `DRAFT-OF-${run}` })) },
});

test("a run's DELETE takes its text off the agent's old learning folder (its corrections line off the working tree and main, its diff file) and off the old settings keys (its grade, its promotion copy); the other run's stay; a DELETE again commits nothing", { timeout: 120_000 }, async (t) => {
  const { api, data, store } = await serve(t);
  const first = await startRun(api, "calc", "What is six times seven?");
  await follow(api, first.run_id, ["completed"]);
  const next = await api("POST", "/agents/calc/runs", { input: { content: "And six times eight?" } });
  assert.equal(next.status, 202, JSON.stringify(next.body));
  await follow(api, next.body.run_id, ["completed"]);
  const [gone, kept] = [first.run_id, next.body.run_id];

  // The learning the agent had before the upgrade: two merges on its folder, and the two settings keys naming both runs.
  const goneText = `GONE-LINE-${gone}`;
  const keptText = `KEPT-LINE-${kept}`;
  await oldMerge(data, "calc", gone, goneText);
  await oldMerge(data, "calc", kept, keptText);
  await store.settings.put("learning.grades.calc", { v: 1, items: [gone, kept].map((run, seq) => ({ run, correct: false, label: `LABEL-OF-${run}`, source: "feedback", at: new Date().toISOString(), path: "agent", seq: seq + 1 })) });
  await store.settings.put("learning.promotions.calc", { v: 1, items: [recordOf([gone, kept])] });
  const folder = legacyLearningFolder(data, "calc");
  const diffOf = (run) => join(folder, ".agentrun", "diffs", `${run}.json`);
  assert.ok(existsSync(diffOf(gone)) && existsSync(diffOf(kept)), "each merge wrote its diff file");
  assert.match(git(folder, ["show", "main:corrections.md"]), new RegExp(goneText));
  const commits = Number(git(folder, ["rev-list", "--count", "main"]));

  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);

  // The folder: the run's line off the working tree and main's tip in one host commit, its diff file gone.
  const tree = await readFile(join(folder, "corrections.md"), "utf8");
  assert.ok(!tree.includes(goneText), `its line leaves the working tree: ${tree}`);
  assert.ok(tree.includes(keptText), "the other run's line stays");
  assert.equal(git(folder, ["show", "main:corrections.md"]), `- ${keptText}`, "main holds the other run's line alone");
  assert.equal(Number(git(folder, ["rev-list", "--count", "main"])), commits + 1, "in one commit");
  assert.equal(git(folder, ["log", "-1", "--format=%s", "main"]), "host: a purged run's corrections removed");
  assert.equal(existsSync(diffOf(gone)), false, "its diff file leaves the folder");
  assert.ok(existsSync(diffOf(kept)), "the other run's diff file stays");
  const later = await readFile(diffOf(kept), "utf8");
  assert.ok(!later.includes(goneText), `the other merge's diff no longer shows its line as context: ${later}`);

  // The settings keys: its grade dropped, its promotion copy blanked; the other run's kept as they were.
  const grades = (await store.settings.get("learning.grades.calc")).items;
  assert.deepEqual(grades.map((one) => one.run), [kept], "its grade leaves learning.grades");
  const record = (await store.settings.get("learning.promotions.calc")).items[0];
  const text = JSON.stringify(record);
  for (const piece of ["INPUT-OF-", "ANSWER-OF-", "DRAFT-OF-"]) {
    assert.ok(!text.includes(`${piece}${gone}`), `its ${piece} copy leaves learning.promotions: ${text}`);
    assert.ok(text.includes(`${piece}${kept}`), `the other run's ${piece} copy stays`);
  }
  assert.deepEqual([record.decided, record.workflow, record.digest], ["hold", "sum", "d1"], "the record's decision stays");

  // A DELETE again finds nothing left: no commit, the keys as they are.
  assert.equal((await api("DELETE", `/runs/${gone}`)).status, 204);
  assert.equal(Number(git(folder, ["rev-list", "--count", "main"])), commits + 1, "a DELETE again commits nothing");

  // The agent's purge removes the folder and both keys whole, as it did before.
  assert.equal((await api("POST", "/agents/calc/archive")).status, 200);
  assert.equal((await api("DELETE", "/agents/calc")).status, 204);
  assert.equal(existsSync(folder), false, "the agent's purge removes its old learning folder");
  assert.equal(await store.settings.get("learning.grades.calc"), undefined, "and learning.grades");
  assert.equal(await store.settings.get("learning.promotions.calc"), undefined, "and learning.promotions");
});

test("a run's DELETE on an agent with no old learning makes no folder and no key", { timeout: 120_000 }, async (t) => {
  const { api, data, store } = await serve(t);
  const run = await startRun(api, "calc", "What is six times seven?");
  await follow(api, run.run_id, ["completed"]);
  assert.equal((await api("DELETE", `/runs/${run.run_id}`)).status, 204);
  assert.equal(existsSync(legacyLearningFolder(data, "calc")), false, "no learning folder is made");
  assert.equal(await store.settings.get("learning.grades.calc"), undefined);
  assert.equal(await store.settings.get("learning.promotions.calc"), undefined);
});
