// An agent with learning on remembers, on pi, Claude and Codex: run 1 answers, then its end-of-run turn adds a note to
// its copy of the folder; the note is checked, graded on the agent's own model and merged into the folder's main, whose
// MEMORY.md lists it; and run 2 starts from it, the note's line in its instructions under `# Learned` and the file in
// its `.learning/`. The turn never changes the job's answer. The data directory's path holds a space, and the turn's
// message names the folder relative to the run's work, never by a host path.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, LEARN, learner, learningRows, made, mergesOf, reflectRows, repoOf, savedOf, settled, started, turnCopyOf } from "./learn-support.mjs";
import { scratch, serve } from "./support.mjs";

const FILE = "check-units.md";
const NOTE = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const LINE = "- [Check units](check-units.md) — Convert every amount to one unit before comparing";
/** The index under `# Learned` in a prompt, or undefined. */
const learnedIn = (prompt) => /\n# Learned\n\n[^\n]*\n\n([\s\S]*?)(?:\n\n|\n<\/instructions>|\n?$)/.exec(prompt)?.[1];

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`on ${harness}, run 1 learns and run 2 knows, on a data directory whose path holds a space: the end-of-run turn, which names .learning/ relative to the run's work, adds a note that is checked, graded and merged, MEMORY.md on main lists it, and run 2 reads it under # Learned and finds it in .learning/`, { timeout: 180_000 }, async (t) => {
    const data = join(await scratch(t), "learning data", "agents");
    const { api } = await serve(t, { learning: "on", faux: LEARN, fauxHarness: LEARN, data });
    const id = `loop-${harness}`;
    await made(api, learner(id, { harness, instructions: "Say your prompt.", plan: [[FILE, NOTE]], once: true }));

    // Run 1: the job answers with its prompt, then the end-of-run turn writes the note, and it lands on main.
    const one = await started(api, id);
    const first = await ended(api, one);
    assert.equal(first.view.status, "completed");
    const answer = first.view.result.final_answer;
    assert.ok(answer.includes("Say your prompt.") && !answer.includes("Reflected."), `the answer is the job's, never the turn's: ${answer}`);
    assert.equal(learnedIn(answer), undefined, "run 1 had nothing learned");
    settled(first.view, first.rows, "merged");
    assert.equal(first.view.learning.detail, "What the run learned is merged into main.");
    for (const path of ["/runs", `/agents/${id}/runs`]) assert.deepEqual((await api("GET", path)).body.runs.find((run) => run.run_id === one).learning, { state: "merged", reason: null }, path);
    // The turn's rows are labelled learning: its message, the agent's write, and its last line, which is no answer.
    const turn = reflectRows(first.rows);
    assert.equal(turn.filter((row) => row.kind === "user_message").length, 1, "one end-of-run turn");
    const asked = turn.find((row) => row.kind === "user_message");
    assert.match(asked.summary, /^Learning: The task is done\./);
    assert.match(asked.text, /Your notes from earlier runs are in `\.learning\/`, in your working directory/);
    assert.doesNotMatch(asked.text, /(?:^|[\s`'"(\[])\/[^\s/]/m, "the message holds no absolute path");
    assert.ok(!asked.text.includes(data) && !asked.text.includes("learning data"), "nor the data directory");
    assert.ok(turn.some((row) => row.tool_name === "write"), "it wrote with the agent's own tool");
    assert.equal(first.rows.filter((row) => row.kind === "final_answer").length, 1, "the job's answer is the run's only answer row");

    // What the merge left: one host commit on main naming the run, with the note, and MEMORY.md built from it.
    const repo = repoOf(data, id);
    const { learning } = await savedOf(data, one);
    assert.deepEqual(learning.verdict, { merge: true, reason: "Each note is general and new.", items: [{ file: FILE, keep: true, why: "It holds as a general rule." }] });
    const main = git(repo, ["rev-parse", "main"]);
    assert.equal(learning.merged, main);
    assert.deepEqual(mergesOf(repo, one).map((entry) => entry.split(" ")[0]), [main], "one commit names the run");
    assert.deepEqual(git(repo, ["log", "-1", "--format=%an%n%s%n%b", main]).split("\n").filter(Boolean), ["agentrun-serve", `learning: ${one}: merged`, "Each note is general and new.", `Run-Id: ${one}`]);
    assert.equal(git(repo, ["rev-list", "--count", "main"]), "2", "the folder's first commit, then the merge");
    assert.equal(`${git(repo, ["show", `main:${FILE}`])}\n`, NOTE);
    assert.equal(git(repo, ["show", "main:MEMORY.md"]), LINE);
    assert.equal(readFileSync(join(repo, "MEMORY.md"), "utf8"), `${LINE}\n`, "the checked-out files are main's");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    // The grade ran on the agent's own model, outside the run: its cost is the learning block's, and /v2/usage's.
    assert.ok(learning.cost_usd.grade > 0, JSON.stringify(learning.cost_usd));
    assert.ok(learning.tokens.grade.input > 0 && learning.tokens.grade.output > 0, JSON.stringify(learning.tokens));
    const usage = (await api("GET", "/usage?group_by=meter")).body;
    assert.ok(usage.lines.some((line) => line.meter === "learning" && line.usd > 0), JSON.stringify(usage.lines));

    // Run 2, the same revision: it starts from the merge.
    const two = await started(api, id);
    const second = await ended(api, two);
    assert.equal(learnedIn(second.view.result.final_answer), LINE, second.view.result.final_answer);
    // Its .learning/, as its end-of-run turn left it, was set aside out of its work as it ended.
    assert.equal(readFileSync(join(turnCopyOf(data, two), FILE), "utf8"), NOTE, "the note was in run 2's .learning/");
    assert.equal(existsSync(copyOf(data, two)), false, "and is no longer in its work");
    assert.equal(JSON.parse(readFileSync(join(data, "runs", two, "learning.json"), "utf8")).seed, main);
    // It learned nothing new: its turn added nothing, and main did not move.
    settled(second.view, second.rows, "dropped", "empty");
    assert.equal(git(repo, ["rev-parse", "main"]), main);
    assert.equal(learningRows(second.rows).length, 1);
    assert.equal(existsSync(join(data, "runs", two, "learning-proposal.json")), false, "nothing was proposed");
  });
}
