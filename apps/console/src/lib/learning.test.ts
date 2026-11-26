import { describe, expect, it } from "vitest";
import { approval, bytesOf, change, changeWords, correctionLines, corrections, dropKind, dropWords, fileChanges, fileWords, impactWords, learningHash, learningLabel, learningSteps, type LearningDiff, lookedBack, type RunLearning, shownImpact, took, tookChange, underWay, waitingWords, workflowsBy } from "./learning";
import { recorded } from "@/fixtures";
import type { LastChange } from "./learning";
import type { TimelineRow } from "./v2";

// What the console reads of a run's and an agent's learning, and the words it says it in.

describe("corrections.md", () => {
  it("counts the lines that say something: a heading or a blank line is none", () => {
    expect(correctionLines("# Learned\n\n- Open the policies page first.\n  - Keep it short.  \n\n")).toEqual(["- Open the policies page first.", "- Keep it short."]);
    expect(correctionLines("")).toEqual([]);
    expect([corrections(1), corrections(2)]).toEqual(["1 correction", "2 corrections"]);
  });
  it("counts its bytes as the server does, in UTF-8", () => {
    expect([bytesOf("abc"), bytesOf("café"), bytesOf("€")]).toEqual([3, 5, 3]);
  });
});

describe("a run's learning, read tolerantly", () => {
  it("the workflows a run kept: none when it names none, or did not merge, or names one out of shape", () => {
    expect(workflowsBy({ state: "merged", reason: null, detail: null })).toEqual([]);
    expect(workflowsBy(null)).toEqual([]);
    expect(workflowsBy(undefined)).toEqual([]);
    const l = { state: "merged" as const, reason: null, detail: null, workflows: [{ file: "workflows/a/workflow.json", name: "a" }, { file: 3 } as never, { file: "workflows/b/workflow.json", name: "b", pending: true as const }] };
    expect(workflowsBy(l)).toEqual([{ file: "workflows/a/workflow.json", name: "a" }, { file: "workflows/b/workflow.json", name: "b", pending: true }]);
    expect(workflowsBy({ ...l, state: "dropped" })).toEqual([]);
  });
  it("is under way until it is kept or not", () => {
    expect(["seeded", "reflecting"].map((state) => underWay({ state: state as never, reason: null, detail: null }))).toEqual([true, true]);
    expect(underWay({ state: "merged", reason: null, detail: null })).toBe(false);
    expect(underWay(null)).toBe(false);
  });
  it("why it kept nothing: the server's own sentence when it sends one, else plain words for the reason", () => {
    expect(dropWords({ state: "dropped", reason: "checker", detail: "Not kept: the draft did not pass the checks." })).toBe("Not kept: the draft did not pass the checks.");
    // The server's own words for each (learning-words.ts), so a row with no detail reads as one that has it.
    expect(dropWords({ state: "dropped", reason: "empty", detail: null })).toBe("Nothing new to keep from this run.");
    expect(dropWords({ state: "dropped", reason: "no_budget", detail: null })).toBe("Skipped: no budget left in this run to write what it learned.");
    expect(dropWords({ state: "dropped", reason: "unknown_cost", detail: null })).toBe("Skipped: this run's spend is unknown, so its budget can't cover writing what it learned.");
    expect(dropWords({ state: "dropped", reason: "a_new_reason", detail: null })).toBe("Not kept: learning stopped.");
    expect(["checker", "empty", "use", "no_budget", "unknown_cost", "crashed", null].map(dropKind)).toEqual(["refused", "nothing", "nothing", "skipped", "skipped", "stopped", "stopped"]);
  });
  it("no reason's words use git's or the loop's own names", () => {
    const words = ["empty", "use", "checker", "no_budget", "unknown_cost", "seed_failed", "cancelled", "crashed", "reflect_failed", "purged_since_seed"].map((reason) => dropWords({ state: "dropped", reason, detail: null })).join(" ");
    expect(words).not.toMatch(/\b(main|merge|merged|commit|grader|verdict|proposal|end-of-run|reflect|seed|checker)\b/i);
  });
});

describe("the before and after", () => {
  const impact = { before: { runs: 2, median_duration_s: 18.4 }, after: { runs: 4, median_duration_s: 12 } };
  it("says it in a line: the time to the answer, each side's median, on the after side's runs, and what learning booked a run", () => {
    expect(impactWords(impact)).toBe("Since it learned (medians of 4 runs started from what it learned): answers in 12s instead of 18s");
    expect(impactWords(impact, 0.0193)).toBe("Since it learned (medians of 4 runs started from what it learned): answers in 12s instead of 18s · learning itself $0.0193 a run, booked");
  });
  it("says no cost of a run of its own: the tab's one is the cost card's all-in before and after, learning included", () => {
    // A median of the job's own cost left learning out and read -86% beside the cost card's 2.0x cheaper.
    expect(impactWords(impact, 0.0193)).not.toMatch(/est\.|instead of \$/);
  });
  it("learning itself is the bill's (compile turns, audit shadows, replays over its runs), never a median of mostly-zero rows", () => {
    // The impact carries no learning figure of its own (a median of mostly-zero rows read $0): only the bill's is said.
    expect(impact.after).not.toHaveProperty("median_learning_usd");
    expect(impactWords(impact, null)).not.toMatch(/learning itself/);
    expect(impactWords(impact, 0.0193)).toMatch(/learning itself \$0\.0193 a run, booked$/);
  });
  it("a short time to the answer to a tenth of a second, the change from the times shown: never 2s instead of 1s at +7%", () => {
    const quick = { before: { ...impact.before, median_duration_s: 1.38 }, after: { ...impact.after, median_duration_s: 1.46 } };
    expect(impactWords(quick, null)).toMatch(/^Since it learned \(medians of 4 runs started from what it learned\): answers in 1\.5s instead of 1\.4s/);
    expect(tookChange(1.38, 1.46)).toBe(7);
    expect(tookChange(1.44, 1.46)).toBe(7);
    expect(tookChange(18.4, 12)).toBe(-33);
  });
  it("says a slower after as it is", () => {
    expect(impactWords({ before: { runs: 2, median_duration_s: 14 }, after: { runs: 4, median_duration_s: 21 } })).toBe("Since it learned (medians of 4 runs started from what it learned): answers in 21s instead of 14s");
  });
  it("is shown only when the server sends both sides with two runs each", () => {
    expect(shownImpact(impact)).toBe(true);
    expect(shownImpact(null)).toBe(false);
    expect(shownImpact({ ...impact, before: { ...impact.before, runs: 1 } })).toBe(false);
  });
  it("formats with the console's own: a run's time as elapsed() writes it, the change as a whole percent", () => {
    expect([took(65), took(12.4), took(9.96), took(3.8), took(0)]).toEqual(["1m 05s", "12s", "10s", "3.8s", "0.0s"]);
    expect([change(18, 12), change(0.11, 0.03), change(0, 1)]).toEqual([-33, -73, null]);
  });
});

describe("plain words for the machine's", () => {
  it("a link names the agent's Learning tab", () => {
    expect(learningHash("refund finder")).toBe("#/agents/refund%20finder/learning");
  });
  it("the timeline's learning rows: the end and the server's look-back message both read Learning, each without its chip", () => {
    const row = { id: "1", seq: 1, summary: "", text: null, timestamp: "2026-11-03T16:00:00Z", tool_name: null, created_at: "2026-10-28T19:33:16.118Z", agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null };
    expect(learningLabel({ ...row, kind: "learning", agent_label: "learning", summary: "Learned 1 workflow: sort-invoice" })).toMatchObject({ kind: "learning", agent_label: null, summary: "Learned 1 workflow: sort-invoice" });
    expect(learningLabel({ ...row, kind: "user_message", agent_label: "learning", summary: "Looking back on this run." })).toMatchObject({ kind: "learning", agent_label: null, summary: "Looking back on this run." });
    const other = { ...row, kind: "tool_use" as const, agent_label: "learning", summary: "Wrote workflows/sort-invoice/workflow.json" };
    expect(learningLabel(other)).toBe(other);
  });
});

describe("workflows that wait for the owner's OK", () => {
  it("a run that kept one and holds one for the OK looks back on both; one that only holds one says it waits", () => {
    const both: RunLearning = { state: "merged", reason: null, detail: null, workflows: [{ file: "workflows/sort-invoice/workflow.json", name: "sort-invoice" }, { file: "workflows/pay-vendor/workflow.json", name: "pay-vendor", pending: true }] };
    expect(lookedBack(both)).toBe("Looked back: kept 1 workflow (sort-invoice); 1 workflow waits for your OK (pay-vendor)");
    expect(lookedBack({ ...both, workflows: [both.workflows![1]!] })).toBe("Looked back: 1 workflow waits for your OK (pay-vendor)");
    expect([waitingWords(1), waitingWords(2)]).toEqual(["1 learned workflow waits for your OK", "2 learned workflows wait for your OK"]);
  });
  it("a run that merged only a correction says the server's words", () => {
    expect(lookedBack({ state: "merged", reason: null, detail: "Added 1 correction to corrections.md." })).toBe("Looked back. Added 1 correction to corrections.md.");
  });
  it("the console approves only where the capabilities say this caller does; anywhere else approving needs the password sign-in", () => {
    expect(approval({ learning: { approve: true } })).toBe("yes");
    expect(approval({ learning: { pending: true, approve: false, approve_needs: "password" } })).toBe("password");
    expect([approval({ learning: { approve: false } }), approval({}), approval(null), approval({ learning: "on" })]).toEqual(["password", "password", "password", "password"]);
  });
});

// The end-of-run look-back as one step: every row labelled `learning` (its message, its writes or whatever else it
// answers with, and the row that says how it ended) folds into one row, said from the run's learning, with the rows
// behind it.
describe("the look-back on a run's timeline", () => {
  const row = (id: string, seq: number, over: Partial<TimelineRow> & { learning?: unknown }): TimelineRow => ({ id, seq, kind: "text_block", summary: "", text: null, timestamp: `2026-11-03T18:50:0${seq}Z`, tool_name: null, ...over }) as TimelineRow;
  const ASKED = row("u1", 1, { kind: "user_message", summary: "You: Sort this invoice" });
  const ANSWER = row("a1", 2, { kind: "final_answer", summary: "Sorted: office supplies." });
  const LOOK = row("l1", 3, { kind: "user_message", agent_label: "learning", summary: "Looking back on this run.", text: "Looking back on this run." });
  const WRITES = [
    row("l2", 4, { kind: "tool_use", tool_name: "write", agent_label: "learning", summary: "Wrote workflows/sort-invoice/workflow.json", tool_input_preview: "workflows/sort-invoice/workflow.json" }),
    row("l3", 5, { kind: "tool_result", tool_name: "write", agent_label: "learning", summary: "Wrote workflows/sort-invoice/workflow.json: ok" }),
    row("l4", 6, { kind: "text_block", agent_label: "learning", summary: "Compiled.", text: "Compiled." }),
  ];
  const USAGE = row("us", 8, { kind: "usage", summary: "Cost so far: $0.0136 over 4 model requests" });
  const ended = (learning: NonNullable<TimelineRow["learning"]> & { detail: string }) => row("learning", 9, { kind: "learning", agent_label: "learning", summary: learning.detail, text: learning.detail, learning });
  const MERGED: RunLearning = { state: "merged", reason: null, detail: null, workflows: [{ file: "workflows/sort-invoice/workflow.json", name: "sort-invoice" }] };
  const KEPT = ended({ state: "merged", reason: null, detail: "Learned 1 workflow: sort-invoice" });

  it("folds into one row where it began, saying what it kept by name, with no file path; the rows are behind it", () => {
    const out = learningSteps([ASKED, ANSWER, LOOK, ...WRITES, USAGE, KEPT], MERGED);
    expect(out.map((r) => r.id)).toEqual(["u1", "a1", "l1", "us"]);
    const one = out[2]!;
    expect(one).toMatchObject({ kind: "learning", agent_label: null, tool_name: null, summary: "Looked back: kept 1 workflow (sort-invoice)", timestamp: LOOK.timestamp });
    expect(one.summary).not.toContain("workflows/");
    expect(one.text!.split("\n")).toEqual(["Looking back on this run.", "Wrote workflows/sort-invoice/workflow.json", "  workflows/sort-invoice/workflow.json", "Wrote workflows/sort-invoice/workflow.json: ok", "Compiled.", "Learned 1 workflow: sort-invoice"]);
    expect(out[0]).toBe(ASKED);
    expect(out[3]).toBe(USAGE);
  });
  it("keeps each folded row's own detail under its line: a whole answer, a call's input, and a failed result, marked failed", () => {
    const said = row("t1", 4, { kind: "text_block", agent_label: "learning", summary: "One job repeats.", text: "One job repeats.\n1. Read the vendor.\n2. Pick the code." });
    const refused = row("c2", 6, { kind: "tool_result", tool_name: "write", agent_label: "learning", summary: "write: not written", tool_status: "failed", tool_result_preview: "EACCES: permission denied\nopen 'workflows/sort-invoice/workflow.json'" });
    const text = learningSteps([ASKED, LOOK, said, refused, KEPT], MERGED)[1]!.text!;
    expect(text.split("\n")).toEqual([
      "Looking back on this run.",
      "One job repeats.",
      "  One job repeats.",
      "  1. Read the vendor.",
      "  2. Pick the code.",
      "write: not written (failed)",
      "  EACCES: permission denied",
      "  open 'workflows/sort-invoice/workflow.json'",
      "Learned 1 workflow: sort-invoice",
    ]);
  });
  it("says when there was nothing new to keep, and why a draft was not kept", () => {
    expect(learningSteps([LOOK, ...WRITES, ended({ state: "dropped", reason: "empty", detail: "Nothing new to remember from this run." })], { state: "dropped", reason: "empty", detail: null })[0]!.summary).toBe("Looked back: nothing new to keep");
    const refused = { state: "dropped" as const, reason: "checker" as const, detail: "Not kept: the draft did not pass the checks." };
    expect(learningSteps([LOOK, ...WRITES, ended(refused)], refused)[0]!.summary).toBe("Looked back: Not kept: the draft did not pass the checks.");
  });
  it("while it looks back, says so, in one row that grows", () => {
    const going = learningSteps([ASKED, LOOK, WRITES[0]!], { state: "reflecting", reason: null, detail: null });
    expect(going.map((r) => [r.id, r.summary])).toEqual([["u1", ASKED.summary], ["l1", "Looking back on this run…"]]);
    expect(going[1]!.text).toContain("Wrote workflows/sort-invoice/workflow.json");
  });
  it("a timeline read after the run says how it ended, though the run read before it does not yet", () => {
    const out = learningSteps([LOOK, ...WRITES, KEPT], { state: "reflecting", reason: null, detail: null });
    expect(out[0]!.summary).toBe("Looked back. Learned 1 workflow: sort-invoice");
  });
  it("with no look-back (a skip), the row that says how learning ended stays alone, labelled Learning", () => {
    const skipped = ended({ state: "dropped", reason: "no_budget", detail: "Skipped: no budget left in this run to look back." });
    const out = learningSteps([ASKED, ANSWER, skipped], { state: "dropped", reason: "no_budget", detail: null });
    expect(out.map((r) => r.id)).toEqual(["u1", "a1", "learning"]);
    expect(out[2]).toMatchObject({ kind: "learning", agent_label: null, summary: "Skipped: no budget left in this run to look back." });
  });
  it("a run with no learning is as it was", () => {
    const rows = [ASKED, ANSWER, USAGE];
    expect(learningSteps(rows, null)).toEqual(rows);
  });
});

// What a run's learning changed, file by file, from GET /v2/runs/{id}/learning/diff (src/fixtures learning.diff and
// learning.diff-run: Brooklinen's run added a line to corrections.md and compiled a workflow).
describe("what a run's learning changed", () => {
  const diff = recorded<LearningDiff>("learning.diff").body;
  const lines = (side: { text: string; mark: string }[] | null) => side?.map((l) => (l.mark === "gap" ? "…" : `${l.mark === "added" ? "+" : l.mark === "removed" ? "-" : " "}${l.text}`)) ?? null;
  it("says each file by what it is, added first", () => {
    expect(fileChanges(diff).map((c) => [c.said, c.file])).toEqual([
      ["Added: workflow find-refund-policy", "workflows/find-refund-policy/workflow.json"],
      ["Changed: corrections", "corrections.md"],
    ]);
  });
  it("an added file has no before, and all of it after; a changed one shows the lines around what changed, the change marked", () => {
    const [added, changed] = fileChanges(diff);
    expect(added!.before).toBeNull();
    expect(added!.after!.every((l) => l.mark === "added")).toBe(true);
    expect(lines(changed!.before)).toEqual([" # Learned", " ", " - Keep the summary to three lines."]);
    expect(lines(changed!.after)).toEqual([" # Learned", " ", " - Keep the summary to three lines.", "+- Open /policies/refund-policy before any other page; fall back to /pages/returns."]);
  });
  it("a removed file and one whose text is not shown say so", () => {
    const changes = fileChanges({ base: "a", head: "b", files: [
      { path: "workflows/old/README.md", status: "deleted", patch: "@@ -1,2 +0,0 @@\n----\n-name: old\n" },
      { path: "workflows/big/workflow.json", status: "added", withheld: "too_large" },
      { path: "corrections.md", status: "modified", withheld: "secret" },
    ] });
    expect(changes.map((c) => [c.said, c.withheld ?? null])).toEqual([
      ["Added: workflow big", "It's too large to show here."],
      ["Changed: corrections", "Not shown: it holds one of this server's secrets."],
      ["Removed: workflow old (README)", null],
    ]);
    expect(changes[0]!.before).toBeNull();
    expect(changes[0]!.after).toBeNull();
  });
  it("names a file it does not know by its path, and says none of the machine's words", () => {
    expect(fileWords("notes/x.md")).toBe("notes/x.md");
    for (const c of fileChanges(diff)) expect(c.said).not.toMatch(/\b(main|merge|merged|commit|diff|patch|proposal|end-of-run)\b/i);
  });
});

// A drop's sentence is the server's, shown as it is: "Looked back: " before it, nothing taken out of it, so a sentence
// that starts "Not kept, the workflow …" says "Not kept" once, as "Not kept: …" does.
describe("lookedBack, a run that kept nothing for a reason", () => {
  const SHAPES = [
    "Not kept: the draft did not pass the checks.",
    "Not kept, the workflow sort-invoice: it named a value the server keeps secret.",
  ];
  for (const detail of SHAPES) {
    it(`says the server's sentence as it is: ${detail.slice(0, 40)}…`, () => {
      const said = lookedBack({ state: "dropped", reason: "checker", detail });
      expect(said).toBe(`Looked back: ${detail}`);
      expect(said.match(/Not kept/g)).toHaveLength(1);
    });
  }
});

// Every kind the server serves in a draft's last_change (packages/serve/src/openapi.ts, the learning view's
// `last_change.kind` enum) has words of its own: a card never says "undefined by you".
describe("changeWords, for every served last_change kind", () => {
  const SERVED: LastChange["kind"][] = ["approved", "edited", "created", "retired", "restored", "learned"];
  for (const kind of SERVED) {
    it(`${kind} has words, by you and by a run`, () => {
      for (const by of ["person", "run"] as const) {
        const said = changeWords(kind, by);
        expect(said).not.toContain("undefined");
        expect(said).toMatch(by === "person" ? /^[A-Z][a-z]+ by you$/ : /^[A-Z][a-z]+ by a run$/);
      }
    });
  }
});
