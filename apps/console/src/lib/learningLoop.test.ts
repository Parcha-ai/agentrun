import { describe, expect, it } from "vitest";
import { compileAfterOf, compiledInto, kindOf, markersOf, proofOf, proven, replayLine, standingOf, stoppedOf, storyOf, withheldWords } from "./learningLoop";
import type { CostRun, LearningCost, LearningLoop, Promotion } from "./v2";

// The loop's arithmetic for the Learning tab, on an invented invoice-sorter agent: promotion records on the run axis,
// standings, the check line, notes' compiled_into, and the story.

const at = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * 3_600_000).toISOString();
const run = (n: number, path: CostRun["path"]): CostRun => ({ n, run_id: `r${n}`, started_at: at(n), path, workflow: path === "agent" ? null : "sort-invoice", learned_revision: null, cost_usd: 0.1, cost_upper_bound: false, learning_usd: 0, total_usd: 0.1 });
const record = (over: Partial<Promotion>): Promotion => ({ workflow: "sort-invoice", digest: "a".repeat(16), at: at(3), decided: "promote", check: CHECK, reason: "as good as the agent", ...over } as Promotion);
// The one check a promotion record keeps: n inputs of the agent's own runs, how many it answered alone and how many of those
// said what the agent said, against the bar (agree_min, alone_min).
const outcomes = (handedBack: number) => ({ answered: 20 - handedBack, handed_back: handedBack, failed: 0, skipped_write: 0 });
const CHECK = { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1 as const, n: 20, agreed: 17, alone: 18, of: [] as string[], outcomes: outcomes(2) };

describe("markers on the run axis", () => {
  const runs = [1, 2, 3, 4, 5, 6].map((n) => run(n, n < 4 ? "agent" : "workflow"));
  it("puts each record on the first run started at or after it, by its kind", () => {
    const records = [
      record({ decided: "replaying", at: at(1.5) }),
      record({ decided: "promote", at: at(3) }),
      record({ decided: "hold", at: at(5.5) }),
      record({ decided: "hold", at: at(9) }),
    ];
    expect(markersOf(runs, records).map((m) => [m.kind, m.n])).toEqual([["revision", 2], ["promote", 3], ["hold", 6]]);
  });
  it("keeps two records of one kind on one run, each its own marker", () => {
    const records = [
      record({ decided: "promote", workflow: "sort-invoice", at: at(2.2) }),
      record({ decided: "promote", workflow: "tag-vendor", digest: "c".repeat(16), at: at(2.6) }),
    ];
    expect(markersOf(runs, records).map((m) => [m.kind, m.n, m.workflow])).toEqual([["promote", 3, "sort-invoice"], ["promote", 3, "tag-vendor"]]);
  });
  it("leaves out a record older than the runs read, and draws nothing without runs", () => {
    expect(markersOf(runs, [record({ at: at(-5) })])).toEqual([]);
    expect(markersOf([], [record({})])).toEqual([]);
  });
  it("names a kind from its record", () => {
    expect([kindOf(record({ decided: "replaying" })), kindOf(record({ decided: "promote" })), kindOf(record({ decided: "hold" }))]).toEqual(["revision", "promote", "hold"]);
  });
});

describe("a revision's standing and numbers", () => {
  it("says serving, held, replaying or not decided", () => {
    expect([standingOf(record({}), { serving: "a".repeat(16) }).word, standingOf(record({})).word, standingOf(record({ decided: "hold" })).word, standingOf(record({ decided: "replaying" })).word, standingOf(undefined).word]).toEqual(["Serving", "Served", "Held", "Replaying", "Not decided"]);
  });
  // Review on #2654: the money rule (serve learning-cost.ts) stops a serving revision from running first without a
  // promotion record; the cost read says so (`needs_revision`), and the standing follows it.
  it("says Stopped for the champion the money rule stopped, from the cost read's needs_revision", () => {
    const cost = { workflows: [{ workflow: "sort-invoice", digest: "a".repeat(16), state: "needs_revision" }, { workflow: "file-invoice", digest: "c".repeat(16), state: "serving" }] } as unknown as LearningCost;
    expect(stoppedOf(cost, "sort-invoice")).toBe("a".repeat(16));
    expect([stoppedOf(cost, "file-invoice"), stoppedOf(null, "sort-invoice")]).toEqual([null, null]);
    expect(standingOf(record({}), { serving: "a".repeat(16), stopped: "a".repeat(16) })).toEqual({ word: "Stopped", tone: "warning", proof: "checked on 20 inputs · 18 alone", text: "Stopped · checked on 20 inputs · 18 alone" });
    expect(standingOf(record({ digest: "b".repeat(16) }), { serving: "b".repeat(16), stopped: "a".repeat(16) }).word).toBe("Serving");
  });
  it("puts the check's numbers in one line, or the reason when no input was checked", () => {
    expect(replayLine(record({}))).toBe("Checked on 20 inputs of the agent's own runs: 18 answered alone (90%, 70% needed), 17 of those said what the agent said (94%, 80% needed), 2 handed back");
    expect(replayLine(record({ decided: "hold", check: { ...CHECK, n: 0, agreed: 0, alone: 0, outcomes: undefined, stopped: true }, reason: "nothing to check it on: it stops" }))).toBe("nothing to check it on: it stops");
    expect(replayLine(record({ check: undefined, reason: "held on its served runs" }))).toBe("held on its served runs");
  });
  it("says what a promotion was decided on: checked on n inputs and how many alone, nothing for a check that ran on none; only a checked one is proven", () => {
    const checked = record({ check: { ...CHECK, n: 18, alone: 9 } });
    const none = record({ decided: "hold", check: { ...CHECK, n: 0, agreed: 0, alone: 0, stopped: true }, reason: "nothing to check it on: it stops" });
    const unchecked = record({ check: undefined, reason: "approved by its owner" });
    expect([checked, none, record({ decided: "replaying", check: undefined }), record({ decided: "hold", check: undefined })].map(proofOf)).toEqual(["checked on 18 inputs · 9 alone", null, null, null]);
    expect(proofOf(record({ check: { ...CHECK, n: 1, alone: 1 } }))).toBe("checked on 1 input · 1 alone");
    // One that handed back every input it checked (held: it would never answer alone) says so beside its count.
    expect(standingOf(record({ decided: "hold", check: { ...CHECK, alone: 0, agreed: 0 } }))).toEqual({ word: "Held", tone: "warning", proof: "checked on 20 inputs · 0 alone", text: "Held · checked on 20 inputs · 0 alone" });
    expect([checked, none, unchecked].map(proven)).toEqual([true, false, false]);
    expect(standingOf(checked, { serving: "a".repeat(16) })).toEqual({ word: "Serving", tone: "success", proof: "checked on 18 inputs · 9 alone", text: "Serving · checked on 18 inputs · 9 alone" });
    expect(standingOf(none)).toEqual({ word: "Held", tone: "warning", text: "Held" });
    expect(standingOf(unchecked, { serving: "a".repeat(16) })).toEqual({ word: "Serving", tone: "plain", text: "Serving" });
  });
});

describe("notes and the story", () => {
  it("reads a note's compiled_into from its front matter only", () => {
    expect(compiledInto("---\nname: x\ncompiled_into: sort-invoice\n---\nbody")).toBe("sort-invoice");
    expect(compiledInto("---\nname: x\n---\ncompiled_into: sort-invoice")).toBeNull();
    expect(compiledInto("no front matter")).toBeNull();
  });
  const cost = (over: Partial<LearningCost["summary"]>, runs: CostRun[] = []): LearningCost => ({ agent: "a", runs, total_runs: runs.length, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, after_state: over.after ? "priced" : "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null, ...over }, workflows: [] });
  const base = { notes: 0, compiledNotes: 0, runs: 0, workflows: [], cost: null, promotions: [], serving: [], loop: null };
  it("champion/challenger: while a revision replays, or after its replay held it, the one promoted before keeps serving and the story says both", () => {
    const champion = record({});
    const replaying = record({ digest: "b".repeat(16), at: at(5), decided: "replaying", check: undefined, reason: "replaying" });
    const held = record({ digest: "b".repeat(16), at: at(6), decided: "hold", check: { ...CHECK, alone: 10, agreed: 7 } });
    const took = { notes: 3, compiledNotes: 3, runs: 4, workflows: [{ name: "sort-invoice", status: "active" }], cost: cost({ takeover: { n: 2, run_id: "r2" } }) };
    const one = storyOf({ ...base, ...took, promotions: [champion, replaying], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: "b".repeat(16), state: "serving", check: null, audit: null, audits_off: null, not_auditable: 0 }] }).find((s) => s.key === "took_over")!;
    expect([one.value, one.detail, one.state]).toEqual(["Run 2", "revision aaaaaaa serves; revision bbbbbbb is checked on the inputs of its agent's own runs before it serves", "done"]);
    const two = storyOf({ ...base, ...took, promotions: [champion, replaying, held], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: null, state: "serving", check: null, audit: null, audits_off: null, not_auditable: 0 }] }).find((s) => s.key === "took_over")!;
    expect([two.detail, two.state]).toEqual(["revision aaaaaaa serves; revision bbbbbbb was held: Checked on 20 inputs of the agent's own runs: 10 answered alone (50%, 70% needed), 7 of those said what the agent said (70%, 80% needed), 2 handed back", "done"]);
    // Before any run of it in the cost series: the stage says it serves.
    const three = storyOf({ ...base, notes: 3, promotions: [champion, replaying], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: "b".repeat(16), state: "serving", check: null, audit: null, audits_off: null, not_auditable: 0 }] }).find((s) => s.key === "took_over")!;
    expect([three.value, three.state]).toEqual(["Serving", "done"]);
    // No champion: a held revision warns, and the agent takes the runs.
    const four = storyOf({ ...base, ...took, promotions: [held], serving: [{ workflow: "sort-invoice", digest: null, replaying: null, state: "held", check: null, audit: null, audits_off: null, not_auditable: 0 }] }).find((s) => s.key === "took_over")!;
    expect(four.state).toBe("warn");
  });
  it("the unsure stage's rate is the summary's, over every run since the takeover, not the runs the read listed", () => {
    const runs = [run(1, "workflow"), run(2, "workflow")];
    const stages = storyOf({ ...base, runs: 2, cost: cost({ takeover: { n: 1, run_id: "r1" }, after: { runs: 2, mean_usd: 0.1 }, hand_backs: { ran: 40, back: 30 } }, runs) });
    expect(stages.find((s) => s.key === "unsure")?.value).toBe("75% handed back");
  });
  it("with nothing yet, says what happens next at each stage", () => {
    const stages = storyOf(base);
    expect(stages.map((s) => [s.key, s.state])).toEqual([["notes", "now"], ["compiled", "later"], ["took_over", "later"], ["cheaper", "later"]]);
    expect(stages[1]!.detail).toBe("0 of 20 completed runs: a workflow compiles at 20, then is checked once on those runs' inputs against the agent's own answers");
  });
  it("the compile stage counts to the definition's compile_after: notes alone never bring it closer", () => {
    const stages = storyOf({ ...base, notes: 7, runs: 3, compileAfter: compileAfterOf({ compile_after: 5 }) });
    expect([stages[1]!.state, stages[1]!.detail]).toEqual(["now", "3 of 5 completed runs: a workflow compiles at 5, then is checked once on those runs' inputs against the agent's own answers"]);
    expect([compileAfterOf(true), compileAfterOf({ agree_min: 0.9 }), compileAfterOf("notes")]).toEqual([20, 20, 20]);
  });
  // Review on #2654: an agent with learning "notes" keeps notes and never compiles (the runner skips the compile turn),
  // so its story promises no workflow, no takeover and no cheaper runs.
  it("a notes-only agent's story keeps to notes: no compile, takeover or cheaper runs promised", () => {
    const stages = storyOf({ ...base, notes: 4, runs: 9, mode: "notes" });
    expect(stages.map((s) => [s.key, s.value, s.state])).toEqual([["notes", "4 notes", "done"], ["compiled", "Notes only", "later"]]);
    expect(stages[1]!.detail).toBe("this agent learns notes only: no workflow compiles from them. Full learning compiles one at 20 completed runs");
    expect(stages.some((s) => /compiles at/.test(s.detail) && s.key !== "compiled")).toBe(false);
  });
  it("a champion the money rule stopped: the takeover stage says it no longer runs first", () => {
    const took = { notes: 3, compiledNotes: 3, runs: 4, workflows: [{ name: "sort-invoice", status: "active" }] };
    const stopped = { ...cost({ takeover: { n: 2, run_id: "r2" } }), workflows: [{ workflow: "sort-invoice", digest: "a".repeat(16), state: "needs_revision", served: null, by_hand: null, unknown_cost_runs: 0 }] } as LearningCost;
    const stage = storyOf({ ...base, ...took, cost: stopped, promotions: [record({})], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: null, state: "serving", check: null, audit: null, audits_off: null, not_auditable: 0 }] }).find((s) => s.key === "took_over")!;
    expect([stage.value, stage.detail, stage.state]).toEqual(["Run 2", "revision aaaaaaa no longer runs first: it cost as much as the agent by hand; the agent takes its runs", "warn"]);
    const before = storyOf({ ...base, notes: 3, cost: { ...stopped, summary: cost({}).summary }, promotions: [record({})], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: null, state: "serving", check: null, audit: null, audits_off: null, not_auditable: 0 }] }).find((s) => s.key === "took_over")!;
    expect([before.value, before.state]).toEqual(["Stopped", "warn"]);
  });
  it("once it took over and got cheaper, tells it whole, with how often it handed back", () => {
    const runs = [run(1, "agent"), run(2, "workflow"), run(3, "handed_back"), run(4, "workflow")];
    const loop = { agent: "a", completed_runs: 0, compiles: [{ run_id: "r1", round: 1, at: at(1), workflow: "sort-invoice", from_notes: ["a", "b", "c"], attempts: [{ ok: true, errors: [] }], digest: "a".repeat(16), promoted: true, draft_errors: [], withheld: false }], } as LearningLoop;
    const stages = storyOf({ ...base, notes: 3, compiledNotes: 3, runs: 4, workflows: [{ name: "sort-invoice", status: "active" }], loop, promotions: [record({})],
      cost: cost({ takeover: { n: 2, run_id: "r2" }, before: { runs: 1, mean_usd: 0.89 }, after: { runs: 25, mean_usd: 0.127 }, times_cheaper: 7, hand_backs: { ran: 3, back: 1 } }, runs) });
    expect(stages.map((s) => [s.key, s.value, s.state])).toEqual([
      ["notes", "3 notes", "done"], ["compiled", "sort-invoice", "done"], ["took_over", "Run 2", "done"], ["cheaper", "7x cheaper", "done"], ["unsure", "33% handed back", "warn"],
    ]);
    expect(stages[4]!.detail).toBe("of 3 runs it ran first");
  });
  // A cleared check says what happened (it passed the agreement check: N of M agreed, against its bar), never "at the
  // same accuracy" (#3064 review: an 80% bar is no equal accuracy); else the ratio alone and why accuracy is not claimed.
  // A ratio whose runs' cost isn't all known is no ratio: the sentence says why.
  const took = { takeover: { n: 2, run_id: "r2" }, before: { runs: 18, mean_usd: 0.89 }, after: { runs: 59, mean_usd: 0.127 }, hand_backs: { ran: 59, back: 3 } };
  const cheaper = (over: Partial<LearningCost["summary"]>) => storyOf({ ...base, notes: 3, runs: 80, cost: cost({ ...took, ...over }) }).find((s) => s.key === "cheaper")!;
  const passed = (agreed: number, alone: number, n = alone) => ({ n, workflow_pct: Math.round((agreed / alone) * 1000) / 10, agent_pct: 100, cleared: true, agreed, alone, agree_min: 0.8 });
  it("with a cleared check: about N times cheaper, the agreement check it passed (N of M agreed, its bar) and what it served under it, never the same accuracy", () => {
    const stage = cheaper({ times_cheaper: 7, replay: passed(32, 40) });
    expect([stage.value, stage.detail, stage.state]).toEqual(["About 7x cheaper", "Passed the agreement check: 32 of 40 agreed (bar 80%) · served 59 runs, handed back 3", "done"]);
    expect(`${stage.value} ${stage.detail}`).not.toMatch(/same accuracy|as accurate/);
    expect(cheaper({ times_cheaper: 6.6, replay: passed(17, 20), hand_backs: { ran: 1, back: 0 } })).toMatchObject({ value: "About 7x cheaper", detail: "Passed the agreement check: 17 of 20 agreed (bar 80%) · served 1 run, handed back 0" });
    expect(cheaper({ times_cheaper: 1.3, replay: { ...passed(9, 10, 12), agree_min: 0.9 } })).toMatchObject({ value: "About 1.3x cheaper", detail: "Passed the agreement check: 9 of 10 agreed (bar 90%) · served 59 runs, handed back 3" });
  });
  it("without a cleared check: the ratio alone, and why accuracy is not claimed", () => {
    const none = cheaper({ times_cheaper: 7 });
    expect([none.value, none.detail, none.state]).toEqual(["7x cheaper", "accuracy not claimed: no check yet", "done"]);
    const below = cheaper({ times_cheaper: 7, replay: { n: 40, workflow_pct: 70, agent_pct: 82, cleared: false, agreed: 28, alone: 40, agree_min: 0.8 } });
    expect([below.value, below.detail]).toEqual(["7x cheaper", "accuracy not claimed: its check was below the bar (workflow 70% vs agent 82% on 40 inputs)"]);
  });
  // The after side is served runs only (never a replay): its count said with its level, and no figure when none is priced.
  it("says the after side's served runs, and in words when none is served or priced", () => {
    const few = cheaper({ after: { runs: 5, mean_usd: 0.127 }, times_cheaper: null });
    expect([few.value, few.detail]).toEqual(["5 served runs so far", "$0.890 a run by the agent, $0.127 all-in over the 5 runs it served since; how many times cheaper shows after 20 runs"]);
    const unpriced = cheaper({ after: null, after_state: "cost_unknown", times_cheaper: null });
    expect([unpriced.value, unpriced.detail, unpriced.state]).toEqual(["No cost yet", "no served run's cost is known yet", "now"]);
    // Served runs exist but no priced agent run came before the takeover: never "no served runs yet".
    const noBase = cheaper({ before: null, after: { runs: 5, mean_usd: 0.127 }, times_cheaper: null });
    expect([noBase.value, noBase.state]).toEqual(["5 served runs so far", "now"]);
    expect(noBase.detail).toBe("$0.127 all-in over the 5 runs it served; no priced agent runs before takeover to compare with");
    expect(noBase.detail).not.toContain("no served runs");
    const none = storyOf({ ...base, notes: 3, runs: 80, cost: cost({ before: { runs: 18, mean_usd: 0.89 } }) }).find((s) => s.key === "cheaper")!;
    expect([none.value, none.state]).toEqual(["Not yet", "later"]);
    expect(none.detail).toContain("no served runs yet");
  });
  it.each([
    [{ unknown: 3, at_most: 1 }, "3 runs' cost unknown, 1 known only as at most"],
    [{ unknown: 1, at_most: 0 }, "1 run's cost unknown"],
    [{ unknown: 0, at_most: 2 }, "2 runs' cost known only as at most"],
  ])("withheld %o: no ratio, and the sentence says why", (withheld, why) => {
    const stage = cheaper({ times_cheaper: null, withheld, replay: passed(32, 40) });
    expect([stage.value, stage.detail, stage.state]).toEqual(["No ratio yet", `${why}: how many times cheaper shows once every run's cost is known`, "now"]);
    expect(withheldWords(withheld)).toBe(why);
  });
  it("withheld with no known run before the takeover still says why, never 'not yet'", () => {
    const stage = cheaper({ before: null, times_cheaper: null, withheld: { unknown: 18, at_most: 0 } });
    expect(stage.value).toBe("No ratio yet");
  });
  // A workflow that costs as much as the agent, or more, is not a cheaper run: never "0.5x cheaper", never Done.
  it.each([[0.5, "Not cheaper yet: 2.0x the cost", "now"], [1, "Same cost", "now"]])("a times_cheaper of %s does not read as cheaper", (ratio, value, state) => {
    const stage = storyOf({ ...base, notes: 3, runs: 4, cost: cost({ takeover: { n: 2, run_id: "r2" }, before: { runs: 1, mean_usd: 0.1 }, after: { runs: 25, mean_usd: 0.1 / ratio }, times_cheaper: ratio }) }).find((s) => s.key === "cheaper")!;
    expect([stage.value, stage.state]).toEqual([value, state]);
  });
  // The server rounds times_cheaper to one decimal: $0.01 -> $0.30 comes back as 0, never "Infinityx the cost".
  it.each([[0.01, 0.3, "Not cheaper yet: 30x the cost"], [0, 0.3, "Not cheaper yet"]])("from $%s to $%s a run reads %s", (before, after, value) => {
    const stage = storyOf({ ...base, notes: 3, runs: 4, cost: cost({ takeover: { n: 2, run_id: "r2" }, before: { runs: 1, mean_usd: before }, after: { runs: 25, mean_usd: after }, times_cheaper: 0 }) }).find((s) => s.key === "cheaper")!;
    expect([stage.value, stage.state]).toEqual([value, "now"]);
  });
});
