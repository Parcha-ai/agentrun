// An agent with learning on learns from its owner, on pi, Claude and Codex: run 1 answers, told under `# Learned` that
// nothing is learned yet, and asks no end-of-run turn (no compile is due); its owner's grade with words appends them to
// the folder's corrections.md on main as one line, committed by the run, with no model turn; and run 2 starts from that
// commit, the line whole in its instructions under `# Learned`. The data directory's path holds a space.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { CORRECTIONS_INTRO, ended, git, keptProposal, LEARN, learner, learningRows, made, NOTHING_YET, pinOf, reflectRows, repoOf, settled, started } from "./learn-support.mjs";
import { scratch, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const WORDS = "Convert every amount to one unit before comparing.";

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`on ${harness}, on a data directory whose path holds a space, run 1 is corrected and run 2 knows: the grade's words are one line of corrections.md on main, committed by the run, and run 2 reads it whole under # Learned`, { timeout: 180_000 }, async (t) => {
    const data = join(await scratch(t), "learning data", "agents");
    const server = await serve(t, { learning: "on", faux: LEARN, harnessTable: fauxTable(LEARN), data });
    const { api } = server;
    const id = `loop-${harness}`;
    await made(api, learner(id, { harness, instructions: "Say your prompt." }));

    // Run 1: the job answers with its prompt, which says nothing is learned yet; no turn is asked after it.
    const one = await started(api, id);
    const first = await ended(api, one);
    assert.equal(first.view.status, "completed");
    const answer = first.view.result.final_answer;
    assert.ok(answer.includes(`\n# Learned\n\n${NOTHING_YET}`), `run 1 is told nothing is learned yet: ${answer}`);
    assert.ok(!answer.includes(CORRECTIONS_INTRO), answer);
    settled(first.view, first.rows, "dropped", "empty");
    assert.equal(reflectRows(first.rows).length, 0, "no end-of-run turn");
    assert.equal(first.rows.filter((row) => row.kind === "final_answer").length, 1, "the job's answer is the run's only answer row");

    // The owner's grade with words: a correction round, which appends them to corrections.md and commits it by the run.
    const repo = repoOf(data, id);
    const graded = await api("PUT", `/runs/${one}/grade`, { correct: false, label: WORDS });
    assert.deepEqual([graded.status, graded.body.feedback], [200, "correction"], JSON.stringify(graded.body));
    const corrected = await ended(api, one);
    assert.equal(corrected.view.learning?.state, "merged", JSON.stringify(corrected.view.learning));
    assert.equal(reflectRows(corrected.rows).filter((row) => row.kind === "user_message").length, 0, "a correction takes no model turn");
    assert.deepEqual([(await keptProposal(server, one)).proposal.corrections, (await keptProposal(server, one)).round], [1, 2]);
    assert.equal(git(repo, ["show", "main:corrections.md"]), `- ${WORDS}`);
    assert.match(git(repo, ["log", "-1", "--format=%B", "main"]), new RegExp(`Run-Id: ${one}`), "committed by the run");
    const main = git(repo, ["rev-parse", "main"]);
    assert.equal(git(repo, ["status", "--porcelain"]), "");

    // Run 2, the same revision: it starts from that commit, the correction whole under # Learned.
    const two = await started(api, id);
    const second = await ended(api, two);
    assert.ok(second.view.result.final_answer.includes(`\n# Learned\n\n${CORRECTIONS_INTRO}\n\n- ${WORDS}`), second.view.result.final_answer);
    assert.equal((await pinOf(server, two)).seed, main, "its launch's learning start is the correction's commit");
    // It learned nothing new: main did not move.
    settled(second.view, second.rows, "dropped", "empty");
    assert.equal(git(repo, ["rev-parse", "main"]), main);
    assert.equal(learningRows(second.rows).length, 1);
  });
}
