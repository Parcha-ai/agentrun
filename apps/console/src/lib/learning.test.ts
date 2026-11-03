import { describe, expect, it } from "vitest";
import { bodyOf, change, dropKind, dropWords, fileFor, impactWords, learnedBy, learningHash, learningLabel, money, noteParts, noteText, provenance, shortTitle, shownImpact, took, typeLabel, underWay, usedBy } from "./learning";

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
  it("no reason's words use git's or the loop's own names", () => {
    const words = ["empty", "grader", "checker", "screen", "screen_down", "no_write_tool", "tool_denied", "no_budget", "unknown_cost", "seed_failed", "cancelled", "crashed", "reflect_timeout", "reflect_failed", "propose_failed", "grade_failed"].map((reason) => dropWords({ state: "dropped", reason })).join(" ");
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
  it("the timeline's learning rows: Learning, and the server's look-back message as Looking back, each without its chip", () => {
    const row = { id: "1", seq: 1, summary: "", text: null, timestamp: "2026-11-03T16:00:00Z", tool_name: null };
    expect(learningLabel({ ...row, kind: "learning", agent_label: "learning", summary: "Learned: Try it first" })).toMatchObject({ kind: "Learning", agent_label: null, summary: "Learned: Try it first" });
    expect(learningLabel({ ...row, kind: "user_message", agent_label: "learning", summary: "Learning: The task is done." })).toMatchObject({ kind: "Looking back", agent_label: null, summary: "The task is done." });
    const other = { ...row, kind: "tool_use", agent_label: "learning", summary: "Wrote .learning/a.md" };
    expect(learningLabel(other)).toBe(other);
  });
});
