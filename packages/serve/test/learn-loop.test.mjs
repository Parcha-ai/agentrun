// An agent with learning on remembers, on pi, Claude and Codex, with no write tool (its job only reads): run 1 answers,
// then its end-of-run turn answers with a note, in a ```note block; the server reads it from the answer, and the note is
// checked, graded on the agent's own model and merged into the folder's main, whose MEMORY.md lists it; and run 2 starts
// from it, the note whole in its instructions under `# Learned` and the file in its `.learning/`. The turn never
// changes the job's answer. The data directory's path holds a space, and the turn's message names the folder relative
// to the run's work, never by a host path. What each run read and learned is on its learning block, in its view and in
// every list: run 1 learned the note (its read of it failed: it was not there yet), and run 2 used it (its read of
// MEMORY.md is no note's).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answerWith, note } from "./fixtures/faux-learn.mjs";
import { copyOf, ended, git, KEEPS, LEARN, learnedIn, learner, NOTHING_YET, onMain, learningRows, made, mergesOf, reflectRows, repoOf, savedOf, settled, started, turnOf, wholeIn } from "./learn-support.mjs";
import { scratch, serve } from "./support.mjs";

const FILE = "check-units.md";
const NOTE = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const LINE = "- [Check units](check-units.md) — Convert every amount to one unit before comparing";
/** What each run's job reads first: the note, then the index, each as a model might name it. */
const READS = [`.learning/${FILE}`, "./.learning/MEMORY.md"];
/** The read rows of `rows` for `path`, as [kind, status]. */
const readsOf = (rows, path) => {
  const calls = new Set(rows.filter((row) => row.kind === "tool_use" && row.tool_name === "read" && row.tool_input_preview === path).map((row) => row.tool_use_id));
  return rows.filter((row) => calls.has(row.tool_use_id) && row.kind === "tool_result").map((row) => row.tool_status);
};

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`on ${harness}, with no write tool, run 1 learns and run 2 knows, on a data directory whose path holds a space: the end-of-run turn, which names .learning/ relative to the run's work, answers with a note that is checked, graded and merged, MEMORY.md on main lists it, and run 2 reads it whole under # Learned and finds it in .learning/`, { timeout: 180_000 }, async (t) => {
    const data = join(await scratch(t), "learning data", "agents");
    const { api } = await serve(t, { learning: "on", faux: LEARN, fauxHarness: LEARN, data });
    const id = `loop-${harness}`;
    await made(api, learner(id, { harness, tools: ["read"], instructions: `Say your prompt.\nRead: ${JSON.stringify(READS)}`, plan: [[FILE, NOTE]], once: true }));

    // Run 1: the job answers with its prompt, then the end-of-run turn writes the note, and it lands on main.
    const one = await started(api, id);
    const first = await ended(api, one);
    assert.equal(first.view.status, "completed");
    const answer = first.view.result.final_answer;
    assert.ok(answer.includes("Say your prompt.") && !answer.includes("Reflected."), `the answer is the job's, never the turn's: ${answer}`);
    assert.equal(learnedIn(answer), undefined, "run 1 had nothing learned");
    assert.ok(answer.includes(`\n# Learned\n\n${KEEPS}\n\n${NOTHING_YET}`), `run 1 is told it learns, and that nothing is learned yet: ${answer}`);
    settled(first.view, first.rows, "merged");
    assert.equal(first.view.learning.detail, "Learned: Check units");
    // What it learned is on its learning block, in its view and in every list; it used no note: the one it tried to read
    // was not there yet.
    const learned = [{ file: FILE, name: "Check units", supersedes: [] }];
    assert.deepEqual(readsOf(first.rows, READS[0]), ["failed"], "run 1's read of the note failed");
    assert.deepEqual(first.view.learning.learned, learned);
    assert.equal("used" in first.view.learning, false, "run 1 used no note");
    const whole1 = (await api("GET", `/runs/${one}/learning`)).body;
    assert.deepEqual([whole1.learned, "used" in whole1, whole1.detail], [learned, false, "Learned: Check units"], "the run's learning whole says the same");
    for (const path of ["/runs", `/agents/${id}/runs`]) assert.deepEqual((await api("GET", path)).body.runs.find((run) => run.run_id === one).learning, { state: "merged", reason: null, detail: "Learned: Check units", learned }, path);
    // The turn's rows are labelled learning: its message, and its answer, with the note, which is no answer of the run's.
    const turn = reflectRows(first.rows);
    assert.equal(turn.filter((row) => row.kind === "user_message").length, 1, "one end-of-run turn");
    const asked = turn.find((row) => row.kind === "user_message");
    // A person reads that the run looks back, never the server's prompt, which stays in the run's store (what it says to
    // the model is checked where the model reads it: learn-claude).
    assert.deepEqual([asked.summary, asked.text], ["Looking back on this run.", "Looking back on this run."]);
    assert.ok(!first.rows.some((row) => /The task is done|Your notes from earlier runs/.test(`${row.summary ?? ""}\n${row.text ?? ""}`)), "no row shows the prompt");
    assert.ok(!turn.some((row) => row.kind === "tool_use"), "it used no tool");
    assert.ok(turn.some((row) => row.kind === "text_block" && row.text.startsWith(`\`\`\`note ${FILE}\n`)), "it answered with the note");
    assert.equal(turnOf(data, one).answer, answerWith([[FILE, NOTE]]), "the answer whole, kept as the run settled");
    assert.equal(first.rows.filter((row) => row.kind === "final_answer").length, 1, "the job's answer is the run's only answer row");

    // What the merge left: one host commit on main naming the run, with the note, and MEMORY.md built from it.
    const repo = repoOf(data, id);
    const { learning } = await savedOf(data, one);
    assert.deepEqual(learning.verdict, { merge: true, reason: "Each note is general and new.", items: [{ file: FILE, keep: true, origin: "run", why: "It holds as a general rule." }] });
    const main = git(repo, ["rev-parse", "main"]);
    assert.equal(learning.merged, main);
    assert.deepEqual(mergesOf(repo, one).map((entry) => entry.split(" ")[0]), [main], "one commit names the run");
    assert.deepEqual(git(repo, ["log", "-1", "--format=%an%n%s%n%b", main]).split("\n").filter(Boolean), ["agentrun-serve", `learning: ${one}: merged`, "Each note is general and new.", `Run-Id: ${one}`]);
    assert.equal(git(repo, ["rev-list", "--count", "main"]), "2", "the folder's first commit, then the merge");
    assert.equal(`${git(repo, ["show", `main:${FILE}`])}\n`, onMain(NOTE), "the note, with the host's origin line");
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
    const section = learnedIn(second.view.result.final_answer);
    assert.deepEqual(wholeIn(section), [FILE], second.view.result.final_answer);
    assert.ok(section.includes("## Check units (check-units.md)\n\nConvert every amount to one unit before comparing\n\nAmounts in one answer came in cents and in dollars."), section);
    assert.ok(!section.includes(LINE), "every note is whole, so the index adds nothing");
    assert.equal(readFileSync(join(copyOf(data, two), FILE), "utf8"), onMain(NOTE), "the note was in run 2's .learning/");
    assert.equal(JSON.parse(readFileSync(join(data, "runs", two, "learning.json"), "utf8")).seed, main);
    // It used the note, read as the job's first call: the note by its name, MEMORY.md (read too) no note at all. In its
    // view, and in every list, as serve.json keeps it.
    assert.deepEqual([readsOf(second.rows, READS[0]), readsOf(second.rows, READS[1])], [["success"], ["success"]], "run 2 read both");
    const used = [{ file: FILE, name: "Check units" }];
    assert.deepEqual(second.view.learning.used, used);
    const whole2 = (await api("GET", `/runs/${two}/learning`)).body;
    assert.deepEqual([whole2.used, "learned" in whole2], [used, false], "the run's learning whole says the same");
    for (const path of ["/runs", `/agents/${id}/runs`]) assert.deepEqual((await api("GET", path)).body.runs.find((run) => run.run_id === two).learning, { state: "dropped", reason: "empty", detail: "Nothing new to remember from this run.", used }, path);
    assert.deepEqual((await savedOf(data, two)).learning.used, used, "kept in serve.json as the run settled");
    // It learned nothing new: its turn added nothing, and main did not move.
    settled(second.view, second.rows, "dropped", "empty");
    assert.equal("learned" in second.view.learning, false, "run 2 learned nothing");
    assert.equal(git(repo, ["rev-parse", "main"]), main);
    assert.equal(learningRows(second.rows).length, 1);
    assert.equal(existsSync(join(data, "runs", two, "learning-proposal.json")), false, "nothing was proposed");
  });
}
