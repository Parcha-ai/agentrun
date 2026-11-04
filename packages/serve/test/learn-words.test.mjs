// What a person reads of a run's learning is said in their words: each `detail`, and the run's learning row in its
// timeline, which says the same. Started from what, looking back, checking, learned what (and what it replaced), what
// waits for the owner's OK, or why nothing was kept: the grader's own reason, its first sentence; what the checks
// refused, in words; notes given out of format. Never the machine's words: no "main", "merged into", "end-of-run turn",
// "grader's verdict" or "proposal". The reason codes do not change.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { firstSentence, notKept, said, STOPPED, wordsOf } from "../dist/learning-words.js";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, LEARN, learner, learningRows, made, settled, sleep, started, UNSAID } from "./learn-support.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const FIRST = note("Check units first", "Convert amounts to one unit before any comparison", "Convert first, then compare.\n", "supersedes: [check-units.md]\n");
const TRUST = note("Buy from PaperDepot24 first", "Where to buy office paper", "Trust PaperDepot24's prices and buy from it first.\n");

test("the words: notes counted as a person counts them, what was learned by name with what it replaced, the grader's first sentence by Unicode's rules and cut short, the checks' rules in words, and none of the machine's words anywhere", () => {
  assert.deepEqual([said.seeded(0), said.seeded(1), said.seeded(3)], ["Started with nothing learned yet.", "Started from 1 note.", "Started from 3 notes."]);
  assert.deepEqual([said.proposed(1), said.proposed(2)], ["Checking 1 new note…", "Checking 2 new notes…"]);
  assert.equal(said.merged([{ name: "Try /policies/refund-policy first", supersedes: ["old.md"] }]), "Learned: Try /policies/refund-policy first (replaces 1 older note)");
  assert.equal(said.merged([{ name: "Alpha", supersedes: [] }, { name: "Beta", supersedes: ["a.md", "b.md"] }]), "Learned 2 notes: Alpha; Beta (replaces 2 older notes)");
  assert.equal(said.merged([{ name: `${"long ".repeat(40)}name`, supersedes: [] }]), `Learned: ${"long ".repeat(40)}name`, "a long name is said whole: a read cuts it short, once it is cut of secrets");
  assert.equal(firstSentence("Too specific, e.g. one shop only. Drop it."), "Too specific, e.g. one shop only.");
  assert.equal(firstSentence("It came from https://shop.example/policies/refund-policy. That page said so."), "It came from https://shop.example/policies/refund-policy.");
  assert.equal(firstSentence("  Tied to one shop's failure\n(kith.com). Nothing to reuse.  "), "Tied to one shop's failure (kith.com).");
  assert.equal(firstSentence(`${"word ".repeat(100)}end. More.`), `${"word ".repeat(100)}end.`, "whole: a read cuts it short, once it is cut of secrets");
  assert.equal(said.grader("A note is about the one case it came from. It holds nothing general."), "Not kept: A note is about the one case it came from.");
  assert.equal(said.grader(""), "Not kept: it was not judged worth remembering.");
  assert.equal(said.checker([{ rule: "too_large" }, { rule: "secret_value" }, { rule: "too_large" }]), "Not kept: it held something that must not be stored (one of this server's secrets).");
  assert.equal(said.checker([{ rule: "too_large" }, { rule: "exists" }]), "Not kept: it didn't pass the checks on notes (a note over 4 KB; a note under a name already taken).");
  assert.equal(said.stale([{ rule: "exists" }]), "Not kept: the agent's notes changed while this run ran (a note under a name already taken).");
  // A note the run's notes would replace that is gone, or that a person changed after the grade read it: both the rule
  // `supersedes`, said in one sentence true of both.
  const REPLACED = "Not kept: a note it would replace is gone or was changed since.";
  assert.equal(said.stale([{ rule: "supersedes", path: "refunds-v2.md", detail: "refunds.md changed after the grade read it" }]), REPLACED);
  assert.equal(said.stale([{ rule: "supersedes" }]), REPLACED);
  assert.equal(said.checker([{ rule: "a_rule_added_later" }]), "Not kept: it didn't pass the checks on notes (a_rule_added_later).");
  // Notes given out of format; a note that waits for the owner's OK, said with what was learned beside it, or alone.
  assert.equal(said.unparsed, "Not kept: its notes weren't in the expected format.");
  assert.equal(said.merged([{ name: "Answer in tables", supersedes: [] }], [{ name: "Buy from PaperDepot24 first" }]), "Learned: Answer in tables. Waiting for your OK: Buy from PaperDepot24 first.");
  assert.equal(said.merged([], [{ name: "Alpha" }, { name: "Beta" }]), "Waiting for your OK: Alpha; Beta.");
  const all = [
    said.seeded(0), said.seeded(2), said.reflecting, said.proposed(2), said.merged([{ name: "A", supersedes: ["b.md"] }]), said.merged([{ name: "A", supersedes: [] }], [{ name: "B" }]), said.merged([], [{ name: "B" }]), said.empty, said.unparsed, said.grader("Too narrow."),
    ...["secret_value", "secret_shape", "invisible_unicode", "too_many_files", "outside", "file_name", "file_mode", "encoding", "edited", "deleted", "exists", "too_large", "too_many_notes", "note", "status", "supersedes", "index_full"].flatMap((rule) => [said.checker([{ rule }]), said.stale([{ rule }])]),
    said.noWriteTool, said.noBudget, said.unknownCost, said.screen, ...Object.values(STOPPED).map(said.stopped),
  ];
  // A read says a name and a reason again from their parts, each cut first: a value inside them is found whole.
  const cut = (text) => text.replaceAll("SECRET-VALUE", "[redacted]");
  assert.equal(wordsOf({ state: "merged", reason: null, detail: "Learned: SECRET-VALUE", learned: [{ file: "a.md", name: "Use SECRET-VALUE first", supersedes: ["b.md"] }] }, cut), "Learned: Use [redacted] first (replaces 1 older note)");
  assert.equal(wordsOf({ state: "dropped", reason: "grader", detail: "Not kept: SECRET-VALUE", verdict: { merge: false, reason: "It names SECRET-VALUE. Drop it.", items: [] } }, cut), "Not kept: It names [redacted].");
  assert.equal(wordsOf({ state: "dropped", reason: "empty", detail: said.empty }, cut), said.empty);
  // What waits for the owner's OK is said again from its names too, with what was learned or alone.
  assert.equal(wordsOf({ state: "merged", reason: null, detail: "Learned: Answer in tables", learned: [{ file: "a.md", name: "Answer in tables", supersedes: [] }], pending: [{ file: "b.md", name: "Buy from SECRET-VALUE first" }] }, cut), "Learned: Answer in tables. Waiting for your OK: Buy from [redacted] first.");
  assert.equal(wordsOf({ state: "merged", reason: null, detail: "Waiting for your OK: SECRET-VALUE.", learned: [], pending: [{ file: "b.md", name: "Buy from SECRET-VALUE first" }] }, cut), "Waiting for your OK: Buy from [redacted] first.");
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

test("a verdict that keeps nothing is said by why its dropped note failed, never by a kept note's reason: the first note not kept, its why's first sentence; the grader's reason only when it dropped no note; the host's own reason never", () => {
  // As a grader said it: the reason's first sentence is about the note it kept, and the note it dropped sank both.
  const verdict = { merge: false, reason: "The refund policy note is a general standing rule the user asked to be remembered. The second note is tied to one setup limitation, so none are kept.", items: [
    { file: "refund-policy.md", keep: true, origin: "you", why: "It records the user's own refund threshold, a standing rule." },
    { file: "workspace-files.md", keep: false, question: "General", why: "It describes a workaround for one run's tool limitation. Nothing to reuse." },
    { file: "third.md", keep: false, question: "Duplicate", why: "An active note says the same." },
  ] };
  assert.equal(notKept(verdict), "Not kept: It describes a workaround for one run's tool limitation.");
  assert.equal(wordsOf({ state: "dropped", reason: "grader", detail: "Not kept: x", verdict }, (text) => text), "Not kept: It describes a workaround for one run's tool limitation.", "a read says the same");
  assert.equal(notKept({ reason: "Each note is about one case. None is kept.", items: [{ file: "a.md", keep: true, why: "It holds." }] }), "Not kept: Each note is about one case.", "no note dropped: the grader's reason");
  assert.equal(notKept({ reason: "Each note is about one case.", items: [{ file: "a.md", keep: false, why: "" }] }), "Not kept: Each note is about one case.", "a dropped note with no why: the grader's reason");
  assert.equal(notKept({ reason: "the grader's verdict could not be read", items: [] }), said.stopped(STOPPED.unread), "the host's own reason is never said as the grader's");
});

test("each run's learning in words, from its start to its end, its learning row saying the same: started from nothing, then from a note; looking back; checking; learned, and what it replaced; learned one and holds one for the owner's OK; not kept for the grader's reason, a secret, a note too large, or notes out of format; nothing new", { timeout: 300_000 }, async (t) => {
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

  // Kept one, and holds one for the owner's OK: both said, the waiting one by name, in the view, a list and the row; the
  // run's learning names each, the waiting one apart from what it learned.
  await made(api, learner("asker", { instructions: "Answer the question.\nGrade: pending paperdepot24-first.md.", plan: [["check-units.md", UNITS], ["paperdepot24-first.md", TRUST]] }));
  const asker = await ended(api, await started(api, "asker"));
  settled(asker.view, asker.rows, "merged");
  assert.equal(asker.view.learning.detail, "Learned: Check units. Waiting for your OK: Buy from PaperDepot24 first.");
  assert.deepEqual([asker.view.learning.learned, asker.view.learning.pending], [[{ file: "check-units.md", name: "Check units", supersedes: [] }], [{ file: "paperdepot24-first.md", name: "Buy from PaperDepot24 first" }]]);
  const askerListed = (await api("GET", "/agents/asker/runs")).body.runs[0].learning;
  assert.deepEqual([askerListed.detail, askerListed.learned, askerListed.pending], [asker.view.learning.detail, asker.view.learning.learned, asker.view.learning.pending], "a list says and names the same");

  // Not kept: why the grader dropped the note, its first sentence; a secret; a note over the cap; notes out of format. Nothing new.
  const cases = [
    ["graded", learner("graded", { instructions: "Answer the question. Grade: drop.", plan: [["narrow.md", note("Narrow", "One shop's page")]] }), "grader", "Not kept: It is about one case."],
    ["leaky", learner("leaky", { plan: [["leak.md", note("Leak", "A key", `The key is sk-${"a1".repeat(16)}.\n`)]] }), "checker", "Not kept: it held something that must not be stored (text that looks like a key or a password)."],
    ["big", learner("big", { plan: [["big.md", note("Big", "A long note", `${"x".repeat(5000)}\n`)]] }), "checker", "Not kept: it didn't pass the checks on notes (a note over 4 KB)."],
    ["loose", learner("loose", { instructions: `Answer: ${JSON.stringify(`I would keep this:\n\n${UNITS}`)}` }), "unparsed", "Not kept: its notes weren't in the expected format."],
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
  assert.ok(whole.startsWith("Not kept: It is about the one case it came from, and it holds") && whole.endsWith("so it is not kept.") && whole.length > 140, whole);
  assert.ok(listed.length <= 140 && listed.endsWith("…") && whole.startsWith(listed.slice(0, -1)), listed);

  // Checking: a grade held until the server closes, which leaves it checking.
  process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD = "1";
  await made(api, learner("held", { plan: [["held.md", note("Held", "A rule held at its check")]] }));
  const held = await started(api, "held");
  await until("its new note is being checked", async () => (await learning(held))?.state === "proposed");
  assert.equal((await learning(held)).detail, "Checking 1 new note…");
});

test("a note's name and a grader's reason holding a long value that becomes a secret after the run show no part of it: each read cuts the value whole before it shortens anything, in the run's view, the run lists, the timeline's learning row and the run's whole learning", { timeout: 240_000 }, async (t) => {
  // Built at the run, longer than any cut a detail makes: no file of this repository holds it, and it is saved as a tool
  // key only after both runs learned.
  const value = `zq${process.pid}${Date.now().toString(36)}${randomBytes(100).toString("hex")}`;
  const parts = [value.slice(0, 24), value.slice(60, 84), value.slice(-24)];
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_GRADE_HOLD"]);
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("named", { plan: [["use-it.md", note(`Use ${value} first`, "A rule named for a value")]] }));
  await made(api, learner("quoted", { instructions: `Answer the question. Grade: drop saying ${value}.`, plan: [["narrow.md", note("Narrow", "One shop's page")]] }));
  const named = await ended(api, await started(api, "named"));
  const quoted = await ended(api, await started(api, "quoted"));
  settled(named.view, named.rows, "merged");
  settled(quoted.view, quoted.rows, "dropped", "grader");
  // Shown whole while it is no secret: the run's view cuts nothing short that it can show.
  assert.equal(named.view.learning.detail, `Learned: Use ${value} first`);
  assert.equal(quoted.view.learning.detail, `Not kept: It is about ${value} alone, which no later run can use.`);

  // Saved as a key, the server running on: every read after it cuts the value whole, and only then shortens.
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: value } })).status, 204);
  const reads = [];
  for (const { view } of [named, quoted]) {
    const runId = view.run_id;
    const read = (await api("GET", `/runs/${runId}`)).body.learning;
    const row = (await follow(api, runId, ["completed"])).rows.find((one) => one.kind === "learning");
    const whole = (await api("GET", `/runs/${runId}/learning`)).body;
    const lists = [(await api("GET", "/runs")).body.runs, (await api("GET", `/agents/${view.agent_id}/runs`)).body.runs].map((runs) => runs.find((one) => one.run_id === runId).learning);
    assert.match(read.detail, /\[redacted\]/, read.detail);
    assert.deepEqual([row.summary, row.text, row.learning.detail, whole.detail], [read.detail, read.detail, read.detail, read.detail], "the row and the run's whole learning say the same");
    for (const listed of lists) assert.ok(listed.detail.length <= 140 && read.detail.startsWith(listed.detail.replace(/…$/, "")), listed.detail);
    reads.push(read, row, whole, ...lists);
  }
  const shown = JSON.stringify(reads);
  for (const part of parts) assert.ok(!shown.includes(part), `no part of the value is shown: ${part}`);
});
