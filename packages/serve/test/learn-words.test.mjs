// What a person reads of a run's learning is said in their words: each `detail`, and the run's learning row in its
// timeline, which says the same. Started from what, looking back, checking, learned what (and what it replaced), or why
// nothing was kept: the grader's own reason, its first sentence; what the checks refused, in words. Never the machine's
// words: no "main", "merged into", "end-of-run turn", "grader's verdict" or "proposal". The reason codes do not change.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { firstSentence, said, STOPPED } from "../dist/learning-words.js";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, learningRows, made, settled, sleep, started, UNSAID } from "./learn-support.mjs";
import { agent, scratch, serve, withEnv } from "./support.mjs";

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const FIRST = note("Check units first", "Convert amounts to one unit before any comparison", "Convert first, then compare.\n", "supersedes: [check-units.md]\n");

test("the words: notes counted as a person counts them, what was learned by name with what it replaced, the grader's first sentence by Unicode's rules and cut short, the checks' rules in words, and none of the machine's words anywhere", () => {
  assert.deepEqual([said.seeded(0), said.seeded(1), said.seeded(3)], ["Started with nothing learned yet.", "Started from 1 note.", "Started from 3 notes."]);
  assert.deepEqual([said.proposed(1), said.proposed(2)], ["Checking 1 new note…", "Checking 2 new notes…"]);
  assert.equal(said.merged([{ name: "Try /policies/refund-policy first", supersedes: ["old.md"] }]), "Learned: Try /policies/refund-policy first (replaces 1 older note)");
  assert.equal(said.merged([{ name: "Alpha", supersedes: [] }, { name: "Beta", supersedes: ["a.md", "b.md"] }]), "Learned 2 notes: Alpha; Beta (replaces 2 older notes)");
  assert.equal(said.merged([{ name: `${"long ".repeat(40)}name`, supersedes: [] }]).length <= "Learned: ".length + 100, true, "a long name is cut");
  assert.equal(firstSentence("Too specific, e.g. one shop only. Drop it."), "Too specific, e.g. one shop only.");
  assert.equal(firstSentence("It came from https://shop.example/policies/refund-policy. That page said so."), "It came from https://shop.example/policies/refund-policy.");
  assert.equal(firstSentence("  Tied to one shop's failure\n(kith.com). Nothing to reuse.  "), "Tied to one shop's failure (kith.com).");
  assert.ok(firstSentence(`${"word ".repeat(100)}end.`).endsWith("…") && firstSentence(`${"word ".repeat(100)}end.`).length <= 200);
  assert.equal(said.grader("A note is about the one case it came from. It holds nothing general."), "Not kept: A note is about the one case it came from.");
  assert.equal(said.grader(""), "Not kept: it was not judged worth remembering.");
  assert.equal(said.checker([{ rule: "too_large" }, { rule: "secret_value" }, { rule: "too_large" }]), "Not kept: it held something that must not be stored (one of this server's secrets).");
  assert.equal(said.checker([{ rule: "too_large" }, { rule: "exists" }]), "Not kept: it didn't pass the checks on notes (a note over 4 KB; a note under a name already taken).");
  assert.equal(said.stale([{ rule: "exists" }]), "Not kept: the agent's notes changed while this run ran (a note under a name already taken).");
  assert.equal(said.checker([{ rule: "a_rule_added_later" }]), "Not kept: it didn't pass the checks on notes (a_rule_added_later).");
  const all = [
    said.seeded(0), said.seeded(2), said.reflecting, said.proposed(2), said.merged([{ name: "A", supersedes: ["b.md"] }]), said.empty, said.grader("Too narrow."),
    ...["secret_value", "secret_shape", "invisible_unicode", "too_many_files", "outside", "file_name", "file_mode", "encoding", "edited", "deleted", "exists", "too_large", "too_many_notes", "note", "status", "supersedes", "index_full"].flatMap((rule) => [said.checker([{ rule }]), said.stale([{ rule }])]),
    said.noWriteTool, said.noBudget, said.unknownCost, said.screen, ...Object.values(STOPPED).map(said.stopped),
  ];
  for (const text of all) {
    assert.doesNotMatch(text, UNSAID, text);
    assert.doesNotMatch(text, /_/, `no rule's code: ${text}`);
  }
});

/** Until `check` holds, every 50 ms, at most 60 s. */
async function until(what, check) {
  for (let i = 0; !(await check()); i++) {
    assert.ok(i < 1200, what);
    await sleep(50);
  }
}

test("each run's learning in words, from its start to its end, its learning row saying the same: started from nothing, then from a note; looking back; checking; learned, and what it replaced; not kept for the grader's reason, a secret, a note too large, or no write tool; nothing new", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  const learning = async (runId) => (await api("GET", `/runs/${runId}`)).body.learning;
  const gate = (name) => join(dir, name);

  // Seeded with nothing, held at its answer; then it learns a note.
  await made(api, learner("words", { instructions: `Answer once ${gate("one")} exists.`, plan: [["check-units.md", UNITS]], once: true }));
  const one = await started(api, "words");
  await until("run 1 is seeded", async () => (await learning(one))?.state === "seeded");
  assert.equal((await learning(one)).detail, "Started with nothing learned yet.");
  writeFileSync(gate("one"), "");
  const learned = await ended(api, one);
  settled(learned.view, learned.rows, "merged");
  assert.equal(learned.view.learning.detail, "Learned: Check units");

  // Seeded with that note, held; then it learns one that replaces it, held as it looks back.
  const { id: _, version: __, ...next } = learner("words", { instructions: `Answer once ${gate("two")} exists. Reflect once ${gate("look")} exists.`, plan: [["check-units-first.md", FIRST]], once: true }).definition;
  assert.equal((await api("PUT", "/agents/words/definition", { definition: next })).status, 200);
  const two = await started(api, "words");
  await until("run 2 is seeded", async () => (await learning(two))?.state === "seeded");
  assert.equal((await learning(two)).detail, "Started from 1 note.");
  writeFileSync(gate("two"), "");
  await until("run 2 looks back", async () => (await learning(two))?.state === "reflecting");
  assert.equal((await learning(two)).detail, "Looking back on this run…");
  writeFileSync(gate("look"), "");
  const replaced = await ended(api, two);
  settled(replaced.view, replaced.rows, "merged");
  assert.equal(replaced.view.learning.detail, "Learned: Check units first (replaces 1 older note)");
  assert.equal(learningRows(replaced.rows)[0].summary, "Learned: Check units first (replaces 1 older note)");

  // Not kept: the grader's own reason, its first sentence; a secret; a note over the cap; no write tool. Nothing new.
  const cases = [
    ["graded", learner("graded", { instructions: "Answer the question. Grade: drop.", plan: [["narrow.md", note("Narrow", "One shop's page")]] }), "grader", "Not kept: A note is about the one case it came from."],
    ["leaky", learner("leaky", { plan: [["leak.md", note("Leak", "A key", `The key is sk-${"a1".repeat(16)}.\n`)]] }), "checker", "Not kept: it held something that must not be stored (text that looks like a key or a password)."],
    ["big", learner("big", { plan: [["big.md", note("Big", "A long note", `${"x".repeat(5000)}\n`)]] }), "checker", "Not kept: it didn't pass the checks on notes (a note over 4 KB)."],
    ["mute", agent("mute", { learning: true, instructions: "Answer the question." }), "no_write_tool", "Not kept: this agent can't write notes (give it the write tool)."],
    ["quiet", learner("quiet"), "empty", "Nothing new to remember from this run."],
  ];
  for (const [id, definition, reason, detail] of cases) {
    await made(api, definition);
    const { view, rows } = await ended(api, await started(api, id));
    settled(view, rows, "dropped", reason);
    assert.equal(view.learning.detail, detail, id);
    assert.equal((await api("GET", `/agents/${id}/runs`)).body.runs[0].learning.detail, detail, `${id}: a list says the same`);
  }

  // A reason whose first sentence is long: the run's view says it whole, a list's row at most 140 characters of it.
  await made(api, learner("long", { instructions: "Answer the question. Grade: drop at length.", plan: [["narrow.md", note("Narrow", "One shop's page")]] }));
  const long = (await ended(api, await started(api, "long"))).view;
  const whole = long.learning.detail;
  const listed = (await api("GET", "/agents/long/runs")).body.runs[0].learning.detail;
  assert.ok(whole.startsWith("Not kept: A note is about the one case it came from, and it holds") && whole.endsWith("so it is not kept.") && whole.length > 140, whole);
  assert.ok(listed.length <= 140 && listed.endsWith("…") && whole.startsWith(listed.slice(0, -1)), listed);

  // Checking: a grade held until the server closes, which leaves it checking.
  process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD = "1";
  await made(api, learner("held", { plan: [["held.md", note("Held", "A rule held at its check")]] }));
  const held = await started(api, "held");
  await until("its new note is being checked", async () => (await learning(held))?.state === "proposed");
  assert.equal((await learning(held)).detail, "Checking 1 new note…");
});
