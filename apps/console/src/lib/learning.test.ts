import { describe, expect, it } from "vitest";
import { approval, bodyOf, change, dropKind, dropWords, fileFor, impactWords, isPending, learnedBy, learningHash, learningLabel, learningSteps, lookedBack, money, noteParts, noteText, originOf, pendingBy, provenance, type RunLearning, shortTitle, shownImpact, took, typeLabel, underWay, usedBy, waitsForOk, waitWords } from "./learning";
import type { TimelineRow } from "./v2";

// What the console reads of a run's and an agent's learning, and the words it says it in.
const NOTE = "---\nname: Try /policies/refund-policy first\ndescription: Open it before any other page\ntype: feedback\nsupersedes: [shopify-refund-policy-path.md]\n---\nOpen `/policies/refund-policy` first.\n";

describe("a note's parts", () => {
  it("reads the name, description and type as fields and keeps every other front-matter line as it was", () => {
    const p = noteParts(NOTE);
    expect(p).toEqual({ name: "Try /policies/refund-policy first", description: "Open it before any other page", type: "feedback", body: "Open `/policies/refund-policy` first.\n", rest: ["supersedes: [shopify-refund-policy-path.md]"] });
    expect(noteText(p)).toBe(NOTE.replace("---\nOpen", "---\n\nOpen"));
    expect(noteParts(noteText(p))).toEqual({ ...p, body: `\n${p.body}` });
  });
  it("an edit changes only what it edits: a new body, the front matter's other lines kept", () => {
    const text = noteText({ ...noteParts(NOTE), body: "Always open /policies/refund-policy.\n" });
    expect(text).toContain("supersedes: [shopify-refund-policy-path.md]\n---\n");
    expect(bodyOf(text)).toBe("Always open /policies/refund-policy.\n");
  });
  it("a value never spans two lines, and one wrapped in quotes keeps them", () => {
    const text = noteText({ name: 'Say "refund"', description: "two\nlines", type: "project", body: "x", rest: [] });
    expect(text).toContain('name: Say "refund"\n');
    expect(text).toContain("description: two lines\n");
    expect(noteParts(noteText({ name: '"quoted"', description: "d", type: "user", body: "", rest: [] })).name).toBe('"quoted"');
  });
  it("a text with no front matter is all body, for the server to refuse, never lost", () => {
    expect(noteParts("just words")).toMatchObject({ name: "", body: "just words" });
  });
  it("a new note's file comes from its name, never one already taken", () => {
    expect(fileFor("Try /policies/refund-policy first!")).toBe("try-policies-refund-policy-first.md");
    expect(fileFor("Café prices", ["cafe-prices.md"])).toBe("cafe-prices-2.md");
    expect(fileFor("!!!")).toBe("note.md");
  });
});

describe("a run's learning, read tolerantly", () => {
  it("what it read and kept come from a newer server; an older one's short form shows nothing", () => {
    expect(usedBy({ state: "merged", reason: null })).toEqual([]);
    expect(learnedBy({ state: "merged", reason: null })).toEqual([]);
    expect(usedBy(null)).toEqual([]);
    expect(usedBy(undefined)).toEqual([]);
    const l = { state: "merged" as const, reason: null, used: [{ file: "a.md", name: "A" }, { file: 3 } as never], learned: [{ file: "b.md", name: "B", supersedes: ["a.md"] }] };
    expect(usedBy(l)).toEqual([{ file: "a.md", name: "A" }]);
    expect(learnedBy(l)).toEqual([{ file: "b.md", name: "B", supersedes: ["a.md"] }]);
  });
  it("only a run whose learning was kept has learned anything", () => {
    expect(learnedBy({ state: "dropped", reason: "grader", learned: [{ file: "b.md", name: "B" }] })).toEqual([]);
  });
  it("is under way until it is kept or not", () => {
    expect(["seeded", "reflecting", "proposed"].map((state) => underWay({ state: state as never, reason: null }))).toEqual([true, true, true]);
    expect(underWay({ state: "merged", reason: null })).toBe(false);
    expect(underWay(null)).toBe(false);
  });
  it("why it kept nothing: the server's own sentence when it sends one, else plain words for the reason", () => {
    expect(dropWords({ state: "dropped", reason: "grader", detail: "Not kept: too specific to one shop." })).toBe("Not kept: too specific to one shop.");
    expect(dropWords({ state: "dropped", reason: "empty" })).toBe("Nothing new to remember from this run.");
    expect(dropWords({ state: "dropped", reason: "no_budget" })).toBe("Skipped: no budget left in this run to look back.");
    expect(dropWords({ state: "dropped", reason: "a_new_reason" })).toBe("Not kept: learning stopped.");
    expect(["grader", "checker", "empty", "no_budget", "crashed", null].map(dropKind)).toEqual(["refused", "refused", "nothing", "skipped", "stopped", "stopped"]);
  });
  it("notes given out of format were turned away, in plain words", () => {
    expect(dropWords({ state: "dropped", reason: "unparsed" })).toBe("Not kept: its notes weren't in the expected format.");
    expect(dropKind("unparsed")).toBe("refused");
  });
  it("no reason's words use git's or the loop's own names", () => {
    const words = ["empty", "unparsed", "grader", "checker", "screen", "screen_down", "no_write_tool", "tool_denied", "no_budget", "unknown_cost", "seed_failed", "cancelled", "crashed", "reflect_timeout", "reflect_failed", "propose_failed", "grade_failed"].map((reason) => dropWords({ state: "dropped", reason })).join(" ");
    expect(words).not.toMatch(/\b(main|merge|merged|commit|grader|verdict|proposal|end-of-run|reflect|seed|checker)\b/i);
  });
});

describe("the before and after", () => {
  const impact = { before: { runs: 2, median_duration_s: 18.4, median_cost_usd: 0.1146 }, after: { runs: 4, median_duration_s: 12, median_cost_usd: 0.0311 } };
  it("says it in a line: the time to the answer and a run's cost, each side's median, on the after side's runs", () => {
    expect(impactWords(impact)).toBe("Since it learned (on 4 runs): answers in 12s instead of 18s · $0.03 est. instead of $0.11 est. a run");
    expect(impactWords({ ...impact, after: { ...impact.after, median_cost_usd: null } })).toBe("Since it learned (on 4 runs): answers in 12s instead of 18s");
    expect(impactWords({ ...impact, after: { ...impact.after, median_learning_usd: 0.008 } })).toBe("Since it learned (on 4 runs): answers in 12s instead of 18s · $0.03 est. instead of $0.11 est. a run · learning itself $0.0080 est. a run");
  });
  it("says a slower or costlier after as it is", () => {
    expect(impactWords({ before: { runs: 2, median_duration_s: 14, median_cost_usd: 0.0214 }, after: { runs: 4, median_duration_s: 21, median_cost_usd: 0.0377 } })).toBe("Since it learned (on 4 runs): answers in 21s instead of 14s · $0.04 est. instead of $0.02 est. a run");
  });
  it("is shown only when the server sends both sides with two runs each", () => {
    expect(shownImpact(impact)).toBe(true);
    expect(shownImpact(null)).toBe(false);
    expect(shownImpact(undefined)).toBe(false);
    expect(shownImpact({ ...impact, before: { ...impact.before, runs: 1 } })).toBe(false);
  });
  it("formats with the console's own: a run's time as elapsed() writes it, a cost as cost() writes an estimate, the change as a whole percent", () => {
    expect([took(65), took(12.4), took(3.8), took(0)]).toEqual(["1m 05s", "12s", "4s", "0s"]);
    expect([money(1.234), money(0.1146), money(0.000814)]).toEqual(["$1.23 est.", "$0.11 est.", "$0.0008 est."]);
    expect([change(18, 12), change(0.11, 0.03), change(0, 1)]).toEqual([-33, -73, null]);
  });
});

describe("where a note came from", () => {
  it("the run that first kept it, and the latest change a person made, from the changes newest first", () => {
    const log = [
      { by: { user: true as const }, commit: "c3", at: "2026-11-03T16:55:00Z", reason: "edited by a person", files: ["b.md", "MEMORY.md"] },
      { by: { run: "r2" }, commit: "c2", at: "2026-11-03T16:52:30Z", reason: "General and new.", files: ["a.md", "b.md", "MEMORY.md"] },
      { by: { run: "r1" }, commit: "c1", at: "2026-11-03T16:52:00Z", reason: "Holds for other shops.", files: ["a.md", "MEMORY.md"] },
    ];
    const from = provenance(log);
    expect(from.get("a.md")).toEqual({ run: { id: "r1", at: "2026-11-03T16:52:00Z", reason: "Holds for other shops." } });
    expect(from.get("b.md")).toEqual({ run: { id: "r2", at: "2026-11-03T16:52:30Z", reason: "General and new." }, edited: "2026-11-03T16:55:00Z" });
  });
  it("a link names the agent's Learning tab and each note to point at", () => {
    expect(learningHash("refund finder", ["a.md", "b.md"])).toBe("#/agents/refund%20finder/learning?note=a.md&note=b.md");
    expect(learningHash("x")).toBe("#/agents/x/learning");
  });
});

describe("plain words for the machine's", () => {
  it("each type of note reads as what it is for; one the console does not know reads as sent", () => {
    expect(["user", "feedback", "project", "reference", "other"].map(typeLabel)).toEqual(["About you", "How to work", "About the work", "Where to look", "other"]);
  });
  it("a run's title is cut to about 40 characters at words' edges, its start and its end kept", () => {
    expect(shortTitle("Find this shop's refund policy page: https://www.brooklinen.com")).toBe("Find this shop's…brooklinen.com");
    expect(shortTitle("A short one")).toBe("A short one");
    expect(shortTitle("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });
  it("the timeline's learning rows: the end and the server's look-back message both read Learning, each without its chip", () => {
    const row = { id: "1", seq: 1, summary: "", text: null, timestamp: "2026-11-03T16:00:00Z", tool_name: null };
    expect(learningLabel({ ...row, kind: "learning", agent_label: "learning", summary: "Learned: Try it first" })).toMatchObject({ kind: "Learning", agent_label: null, summary: "Learned: Try it first" });
    expect(learningLabel({ ...row, kind: "user_message", agent_label: "learning", summary: "Looking back on this run." })).toMatchObject({ kind: "Learning", agent_label: null, summary: "Looking back on this run." });
    expect(learningLabel({ ...row, kind: "user_message", agent_label: "learning", summary: "Learning: The task is done." })).toMatchObject({ kind: "Learning", summary: "The task is done." });
    const other = { ...row, kind: "tool_use", agent_label: "learning", summary: "Wrote .learning/a.md" };
    expect(learningLabel(other)).toBe(other);
  });
});

describe("notes that wait for the owner's OK", () => {
  it("a run's waiting notes come from a newer server's `pending`, and a run waiting with none named says so by its state", () => {
    expect(pendingBy({ state: "pending", reason: null, pending: [{ file: "trust-acme.md", name: "Trust acme.com" }, { nope: 1 } as never] })).toEqual([{ file: "trust-acme.md", name: "Trust acme.com" }]);
    expect(waitsForOk({ state: "pending", reason: null })).toBe(true);
    expect(waitsForOk({ state: "merged", reason: null })).toBe(false);
    expect(waitsForOk(null)).toBe(false);
    expect([waitWords(1), waitWords(2), waitWords(0)]).toEqual(["1 note waits for your OK", "2 notes wait for your OK", "A note waits for your OK"]);
  });
  it("a run that kept a note and holds one for the OK looks back on both; one that only holds one says it waits", () => {
    const both = { state: "merged" as const, reason: null, detail: "Learned: Answer in tables. Waiting for your OK: Buy from PaperDepot24 first.", learned: [{ file: "answer-in-tables.md", name: "Answer in tables", supersedes: [] }], pending: [{ file: "paperdepot24-first.md", name: "Buy from PaperDepot24 first" }] };
    expect(waitsForOk(both)).toBe(true);
    expect(lookedBack(both)).toBe("Looked back: kept 1 note (Answer in tables); 1 note waits for your OK (Buy from PaperDepot24 first)");
    expect(lookedBack({ ...both, learned: undefined, detail: "Waiting for your OK: Buy from PaperDepot24 first." })).toBe("Looked back: 1 note waits for your OK (Buy from PaperDepot24 first)");
  });
  it("the console approves only on a server whose capabilities say it does; one that says what approving needs says so", () => {
    expect(approval({ learning: { approve: true } })).toBe("yes");
    expect(approval({ learning: { pending: true, approve: false, approve_needs: "password" } })).toBe("password");
    expect([approval({ learning: { pending: true } }), approval({ learning: { approve: false } }), approval({}), approval(null), approval({ learning: "on" })]).toEqual(["later", "later", "later", "later", "later"]);
  });
  it("a note waits when its status says so", () => {
    expect([isPending({ status: "pending" }), isPending({ status: "active" })]).toEqual([true, false]);
  });
  it("who a note is from: the server's origin, else its front matter's, never a line in its body", () => {
    const text = (front: string, body = "") => `---\nname: N\ndescription: D\ntype: feedback\n${front}---\n${body}`;
    expect(originOf({ origin: "you", text: text("") })).toBe("you");
    expect(originOf({ text: text("origin: you\n") })).toBe("you");
    expect(originOf({ text: text('origin: "run"\n') })).toBe("run");
    expect(originOf({ text: text("", "origin: you\n") })).toBeUndefined();
    expect(originOf({ text: "no front matter" })).toBeUndefined();
  });
});

// The end-of-run look-back as one step: every row labelled `learning` (its message, its writes or whatever else it
// answers with, and the row that says how it ended) folds into one row, said from the run's learning, with the rows
// behind it.
describe("the look-back on a run's timeline", () => {
  const row = (id: string, seq: number, over: Partial<TimelineRow> & { learning?: unknown }): TimelineRow => ({ id, seq, kind: "text_block", summary: "", text: null, timestamp: `2026-11-03T18:50:0${seq}Z`, tool_name: null, ...over }) as TimelineRow;
  const ASKED = row("u1", 1, { kind: "user_message", summary: "You: Find this shop's refund policy page" });
  const ANSWER = row("a1", 2, { kind: "final_answer", summary: "https://www.brooklinen.com/policies/refund-policy" });
  const LOOK = row("l1", 3, { kind: "user_message", agent_label: "learning", summary: "Looking back on this run.", text: "Looking back on this run." });
  const WRITES = [
    row("l2", 4, { kind: "tool_use", tool_name: "write", agent_label: "learning", summary: "Wrote .learning/refund-limit.md", tool_input_preview: ".learning/refund-limit.md" }),
    row("l3", 5, { kind: "tool_result", tool_name: "write", agent_label: "learning", summary: "Wrote .learning/refund-limit.md: ok" }),
    row("l4", 6, { kind: "phase", agent_label: "learning", summary: "Saved .learning/refund-limit.md" }),
    row("l5", 7, { kind: "text_block", agent_label: "learning", summary: "Reflected.", text: "Reflected." }),
  ];
  const USAGE = row("us", 8, { kind: "usage", summary: "Cost so far: $0.0136 over 4 model requests" });
  const ended = (learning: { state: string; reason: string | null; detail: string }) => row("learning", 9, { kind: "learning", agent_label: "learning", summary: learning.detail, text: learning.detail, learning });
  const MERGED: RunLearning = { state: "merged", reason: null, learned: [{ file: "refund-limit.md", name: "Refund limit", supersedes: [] }, { file: "answer-shape.md", name: "Answer shape", supersedes: ["old.md"] }] };
  const KEPT = ended({ state: "merged", reason: null, detail: "Learned 2 notes: Refund limit; Answer shape (replaces 1 older note)" });

  it("folds into one row where it began, saying what it kept by name, with no file path; the rows are behind it", () => {
    const out = learningSteps([ASKED, ANSWER, LOOK, ...WRITES, USAGE, KEPT], MERGED);
    expect(out.map((r) => r.id)).toEqual(["u1", "a1", "l1", "us"]);
    const one = out[2]!;
    expect(one).toMatchObject({ kind: "Learning", agent_label: null, tool_name: null, summary: "Looked back: kept 2 notes (Refund limit, Answer shape)", timestamp: LOOK.timestamp });
    expect(one.summary).not.toContain(".learning/");
    expect(one.text!.split("\n")).toEqual(["Looking back on this run.", "Wrote .learning/refund-limit.md", "  .learning/refund-limit.md", "Wrote .learning/refund-limit.md: ok", "Saved .learning/refund-limit.md", "Reflected.", "Learned 2 notes: Refund limit; Answer shape (replaces 1 older note)"]);
    // Every other row is as it was.
    expect(out[0]).toBe(ASKED);
    expect(out[3]).toBe(USAGE);
  });
  it("keeps each folded row's own detail under its line: a whole answer, a call's input, and a failed result, marked failed", () => {
    const said = row("t1", 4, { kind: "text_block", agent_label: "learning", summary: "Two things are worth keeping.", text: "Two things are worth keeping.\n1. A refund over the limit needs a manager.\n2. Answer with the page's URL alone." });
    const call = row("c1", 5, { kind: "tool_use", tool_name: "write", agent_label: "learning", summary: "Wrote .learning/refund-limit.md", tool_input_preview: "{\"path\":\".learning/refund-limit.md\",\"content\":\"Ask first.\"}" });
    const refused = row("c2", 6, { kind: "tool_result", tool_name: "write", agent_label: "learning", summary: "write: not written", tool_status: "failed", tool_result_preview: "EACCES: permission denied\nopen '.learning/refund-limit.md'" });
    const text = learningSteps([ASKED, LOOK, said, call, refused, KEPT], MERGED)[1]!.text!;
    expect(text.split("\n")).toEqual([
      "Looking back on this run.",
      "Two things are worth keeping.",
      "  Two things are worth keeping.",
      "  1. A refund over the limit needs a manager.",
      "  2. Answer with the page's URL alone.",
      "Wrote .learning/refund-limit.md",
      "  {\"path\":\".learning/refund-limit.md\",\"content\":\"Ask first.\"}",
      "write: not written (failed)",
      "  EACCES: permission denied",
      "  open '.learning/refund-limit.md'",
      "Learned 2 notes: Refund limit; Answer shape (replaces 1 older note)",
    ]);
  });
  it("is keyed on the learning label, not on writes: a look-back that answers with its notes in text folds the same", () => {
    const blocks = row("n1", 4, { kind: "text_block", agent_label: "learning", summary: "<note file=\"refund-limit.md\">…", text: "<note file=\"refund-limit.md\">\n---\nname: Refund limit\n---\nAsk first.\n</note>" });
    const out = learningSteps([ASKED, LOOK, blocks, ended({ state: "merged", reason: null, detail: "Learned: Refund limit" })], { state: "merged", reason: null, learned: [MERGED!.learned![0]!] });
    expect(out.map((r) => [r.id, r.summary])).toEqual([["u1", ASKED.summary], ["l1", "Looked back: kept 1 note (Refund limit)"]]);
  });
  it("says when there was nothing new to keep, and why a note was not kept", () => {
    expect(learningSteps([LOOK, ...WRITES, ended({ state: "dropped", reason: "empty", detail: "Nothing new to remember from this run." })], { state: "dropped", reason: "empty" })[0]!.summary).toBe("Looked back: nothing new to keep");
    const graded = { state: "dropped" as const, reason: "grader", detail: "Not kept: It's about one shop's returns portal, not a rule other shops share." };
    expect(learningSteps([LOOK, ...WRITES, ended(graded)], graded)[0]!.summary).toBe("Looked back: kept nothing. It's about one shop's returns portal, not a rule other shops share.");
  });
  it("while it looks back or checks its notes, says so, in one row that grows", () => {
    const going = learningSteps([ASKED, LOOK, WRITES[0]!], { state: "reflecting", reason: null });
    expect(going.map((r) => [r.id, r.summary])).toEqual([["u1", ASKED.summary], ["l1", "Looking back on this run…"]]);
    expect(going[1]!.text).toContain("Wrote .learning/refund-limit.md");
    const checking = ended({ state: "proposed", reason: null, detail: "Checking 2 new notes…" });
    expect(learningSteps([LOOK, ...WRITES, checking], { state: "proposed", reason: null, detail: "Checking 2 new notes…" })[0]!.summary).toBe("Looking back: checking 2 new notes…");
  });
  it("a timeline read after the run says how it ended, though the run read before it does not yet", () => {
    const out = learningSteps([LOOK, ...WRITES, KEPT], { state: "proposed", reason: null });
    expect(out[0]!.summary).toBe("Looked back. Learned 2 notes: Refund limit; Answer shape (replaces 1 older note)");
  });
  it("with no look-back (a skip), the row that says how learning ended stays alone, labelled Learning", () => {
    const skipped = ended({ state: "dropped", reason: "no_budget", detail: "Skipped: no budget left in this run to look back." });
    const out = learningSteps([ASKED, ANSWER, skipped], { state: "dropped", reason: "no_budget" });
    expect(out.map((r) => r.id)).toEqual(["u1", "a1", "learning"]);
    expect(out[2]).toMatchObject({ kind: "Learning", agent_label: null, summary: "Skipped: no budget left in this run to look back." });
  });
  it("a run with no learning is as it was", () => {
    const rows = [ASKED, ANSWER, USAGE];
    expect(learningSteps(rows, null)).toEqual(rows);
  });
});
