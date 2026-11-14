import { describe, expect, it } from "vitest";
import { binsOf, compiledInto, guardFor, guardsOfText, kindOf, markersOf, replayLine, standingOf, stoppedOf, storyOf } from "./learningLoop";
import type { CostRun, LearningCost, LearningLoop, Promotion } from "./v2";

// The loop's arithmetic for the Learning tab, on an invented invoice-sorter agent: promotion records on the run axis,
// standings, the replay line, guards read from a workflow's JSON, p bins by grade, notes' compiled_into, and the story.

const at = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * 3_600_000).toISOString();
const run = (n: number, path: CostRun["path"]): CostRun => ({ n, run_id: `r${n}`, started_at: at(n), path, workflow: path === "agent" ? null : "sort-invoice", learned_revision: null, cost_usd: 0.1, learning_usd: 0, total_usd: 0.1 });
const record = (over: Partial<Promotion>): Promotion => ({ workflow: "sort-invoice", digest: "a".repeat(16), at: at(3), decided: "promote", source: "replay", reason: "as good as the agent", ...over } as Promotion);
const REPLAY = { of: [], n: 20, agree: 19, agent_acc: 0.9, wf_acc: 0.95, delta: 0.05, handed_back: 2 };

describe("markers on the run axis", () => {
  const runs = [1, 2, 3, 4, 5, 6].map((n) => run(n, n < 4 ? "agent" : "workflow"));
  it("puts each record on the first run started at or after it, by its kind", () => {
    const records = [
      record({ decided: "replaying", at: at(1.5) }),
      record({ decided: "promote", at: at(3) }),
      record({ decided: "promote", source: "refit", digest: "b".repeat(16), at: at(4.2) }),
      record({ decided: "hold", source: "graded", at: at(5.5) }),
      record({ decided: "hold", at: at(9) }),
    ];
    expect(markersOf(runs, records).map((m) => [m.kind, m.n])).toEqual([["revision", 2], ["promote", 3], ["refit", 5], ["hold", 6]]);
  });
  it("leaves out a record older than the runs read, and draws nothing without runs", () => {
    expect(markersOf(runs, [record({ at: at(-5) })])).toEqual([]);
    expect(markersOf([], [record({})])).toEqual([]);
  });
  it("names a kind from its record", () => {
    expect([kindOf(record({ decided: "replaying" })), kindOf(record({ source: "refit" })), kindOf(record({ decided: "hold" })), kindOf(record({ decided: "superseded", superseded_by: "b".repeat(16) }))]).toEqual(["revision", "refit", "hold", "superseded"]);
  });
});

describe("a revision's standing and numbers", () => {
  it("says serving, held, replaying, superseded or not decided", () => {
    expect([standingOf(record({}), { serving: "a".repeat(16) }).word, standingOf(record({})).word, standingOf(record({ decided: "hold" })).word, standingOf(record({ decided: "replaying" })).word, standingOf(record({ decided: "superseded" })).word, standingOf(undefined).word]).toEqual(["Serving", "Served", "Held", "Replaying", "Superseded", "Not decided"]);
  });
  // Review on #2654: the money rule (serve learning-cost.ts) stops a serving revision from running first without a
  // promotion record; the cost read says so (`needs_revision`), and the standing follows it.
  it("says Stopped for the champion the money rule stopped, from the cost read's needs_revision", () => {
    const cost = { workflows: [{ workflow: "sort-invoice", digest: "a".repeat(16), state: "needs_revision" }, { workflow: "file-invoice", digest: "c".repeat(16), state: "serving" }] } as unknown as LearningCost;
    expect(stoppedOf(cost, "sort-invoice")).toBe("a".repeat(16));
    expect([stoppedOf(cost, "file-invoice"), stoppedOf(null, "sort-invoice")]).toEqual([null, null]);
    expect(standingOf(record({}), { serving: "a".repeat(16), stopped: "a".repeat(16) })).toEqual({ word: "Stopped", tone: "warning" });
    expect(standingOf(record({ digest: "b".repeat(16) }), { serving: "b".repeat(16), stopped: "a".repeat(16) }).word).toBe("Serving");
  });
  it("puts the replay's numbers in one line, or the reason when there was no replay", () => {
    expect(replayLine(record({ replay: REPLAY }))).toBe("Replay on 20 graded inputs: workflow 95% vs agent 90% (+5 pts), 2 handed back");
    expect(replayLine(record({ source: "dry_run", reason: "no graded input it fits: promoted on its dry run" }))).toBe("no graded input it fits: promoted on its dry run");
  });
  it("says how many replayed inputs were skipped for a write the recording doesn't have, only when any were", () => {
    expect(replayLine(record({ replay: { ...REPLAY, skipped_write: 0 } }))).toBe("Replay on 20 graded inputs: workflow 95% vs agent 90% (+5 pts), 2 handed back");
    expect(replayLine(record({ replay: { ...REPLAY, skipped_write: 3 } }))).toBe("Replay on 20 graded inputs: workflow 95% vs agent 90% (+5 pts), 2 handed back, 3 skipped: needs a write the recording doesn't have");
    expect(replayLine(record({ replay: { ...REPLAY, n: 1, skipped_write: 1 } }))).toBe("Replay on 1 graded input: workflow 95% vs agent 90% (+5 pts), 2 handed back, 1 skipped: needs a write the recording doesn't have");
    // Every input skipped: nothing was scored, the record's reason says why.
    const reason = "every one of its 5 graded inputs needs a write the recording doesn't have: a replay never runs a write, so nothing was replayed";
    expect(replayLine(record({ decided: "hold", reason, replay: { ...REPLAY, n: 0, agree: 0, skipped_write: 5 } }))).toBe(reason);
  });
});

describe("guards and p", () => {
  const doc = JSON.stringify({ v: 2, root: { node: "chain", steps: [
    { node: "extract", label: "classify", guard: { signal: "jev", threshold: 0.7 } },
    { node: "decide", label: "pick", guard: { signal: "both", threshold: 0.82, fit: { w: [1], b: 0 } } },
    { node: "extract", label: "no guard" },
    { node: "extract", guard: { signal: "self", threshold: 0.5 } },
    { node: "extract", label: "bad", guard: { signal: "vibes", threshold: 0.5 } },
  ] } });
  it("reads each labelled guarded step in order", () => {
    expect(guardsOfText(doc)).toEqual([
      { label: "classify", node: "classify", path: "/root/steps/0", signal: "jev", threshold: 0.7, fitted: false },
      { label: "pick", node: "pick", path: "/root/steps/1", signal: "both", threshold: 0.82, fitted: true },
    ]);
    expect(guardsOfText("not json")).toEqual([]);
    expect(guardsOfText(null)).toEqual([]);
  });
  // Review on #2654: the runner names a step of a composed child workflow `parent/child` on its guard rows (serve
  // learn/promote.ts walkGuards), so the card reads its rows by that name; the graph finds it by its JSON pointer.
  it("names a guarded step of a child workflow as the runner does, parent/child, with its own pointer for the graph", () => {
    const nested = JSON.stringify({ v: 2, root: { node: "chain", steps: [
      { node: "workflow", label: "vendor", workflow: { v: 2, root: { node: "chain", steps: [{ node: "extract", label: "check", guard: { signal: "self", threshold: 0.6 } }] } } },
      { node: "extract", label: "check", guard: { signal: "jev", threshold: 0.7 } },
    ] } });
    const guards = guardsOfText(nested);
    expect(guards.map((g) => [g.label, g.node, g.path])).toEqual([["check", "vendor/check", "/root/steps/0/workflow/root/steps/0"], ["check", "check", "/root/steps/1"]]);
    const loop = { agent: "a", compiles: [], guards: [
      { workflow: "sort-invoice", digest: "a".repeat(16), node: "vendor/check", signal: "self", threshold: 0.6, runs: 4, escalated: 1, right: 2, wrong: 0, grades_past: 0, replays: 0, points: [] },
    ] } as unknown as LearningLoop;
    expect(guardFor(loop, "sort-invoice", "a".repeat(16), guards[0]!.node)?.runs).toBe(4);
    expect(guardFor(loop, "sort-invoice", "a".repeat(16), guards[1]!.node)).toBeUndefined();
  });
  it("bins p in tenths by grade, a missing p in the lowest", () => {
    const bins = binsOf([{ run_id: "1", p: 0.95, escalated: false, correct: true }, { run_id: "2", p: 1, escalated: false, correct: false }, { run_id: "3", p: null, escalated: true, correct: null }, { run_id: "4", p: 0.7, escalated: false, correct: null }]);
    expect(bins).toHaveLength(10);
    expect(bins[9]).toMatchObject({ right: 1, wrong: 1, ungraded: 0 });
    expect(bins[0]).toMatchObject({ ungraded: 1 });
    expect(bins[7]).toMatchObject({ ungraded: 1 });
  });
});

describe("notes and the story", () => {
  it("reads a note's compiled_into from its front matter only", () => {
    expect(compiledInto("---\nname: x\ncompiled_into: sort-invoice\n---\nbody")).toBe("sort-invoice");
    expect(compiledInto("---\nname: x\n---\ncompiled_into: sort-invoice")).toBeNull();
    expect(compiledInto("no front matter")).toBeNull();
  });
  const cost = (over: Partial<LearningCost["summary"]>, runs: CostRun[] = []): LearningCost => ({ agent: "a", runs, total_runs: runs.length, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, times_cheaper: null, hand_backs: null, ...over }, workflows: [] });
  const base = { notes: 0, compiledNotes: 0, runs: 0, workflows: [], cost: null, promotions: [], serving: [], loop: null };
  it("champion/challenger: while a revision replays, or after its replay held it, the one promoted before keeps serving and the story says both", () => {
    const champion = record({ replay: REPLAY });
    const replaying = record({ digest: "b".repeat(16), at: at(5), decided: "replaying", replay: undefined, reason: "replaying" });
    const held = record({ digest: "b".repeat(16), at: at(6), decided: "hold", replay: { ...REPLAY, wf_acc: 0.8, delta: -0.1 } });
    const took = { notes: 3, compiledNotes: 3, runs: 4, workflows: [{ name: "sort-invoice", status: "active" }], cost: cost({ takeover: { n: 2, run_id: "r2" } }) };
    const one = storyOf({ ...base, ...took, promotions: [champion, replaying], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: "b".repeat(16) }] }).find((s) => s.key === "took_over")!;
    expect([one.value, one.detail, one.state]).toEqual(["Run 2", "revision aaaaaaa serves; revision bbbbbbb replays on graded inputs before it serves", "done"]);
    const two = storyOf({ ...base, ...took, promotions: [champion, replaying, held], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: null }] }).find((s) => s.key === "took_over")!;
    expect([two.detail, two.state]).toEqual(["revision aaaaaaa serves; revision bbbbbbb was held: Replay on 20 graded inputs: workflow 80% vs agent 90% (-10 pts), 2 handed back", "done"]);
    // Before any run of it in the cost series: the stage says it serves.
    const three = storyOf({ ...base, notes: 3, promotions: [champion, replaying], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: "b".repeat(16) }] }).find((s) => s.key === "took_over")!;
    expect([three.value, three.state]).toEqual(["Serving", "done"]);
    // No champion: a held revision warns, and the agent takes the runs.
    const four = storyOf({ ...base, ...took, promotions: [held], serving: [{ workflow: "sort-invoice", digest: null, replaying: null }] }).find((s) => s.key === "took_over")!;
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
    expect(stages[1]!.detail).toBe("0 of 3 notes, 0 of 5 runs: a workflow compiles at 3 notes or 5 runs");
  });
  // Review on #2654: an agent with learning "notes" keeps notes and never compiles (the runner skips the compile turn),
  // so its story promises no workflow, no takeover and no cheaper runs.
  it("a notes-only agent's story keeps to notes: no compile, takeover or cheaper runs promised", () => {
    const stages = storyOf({ ...base, notes: 4, runs: 9, mode: "notes" });
    expect(stages.map((s) => [s.key, s.value, s.state])).toEqual([["notes", "4 notes", "done"], ["compiled", "Notes only", "later"]]);
    expect(stages[1]!.detail).toBe("this agent learns notes only: no workflow compiles from them. Full learning compiles one at 3 notes or 5 runs");
    expect(stages.some((s) => /compiles at/.test(s.detail) && s.key !== "compiled")).toBe(false);
  });
  it("a champion the money rule stopped: the takeover stage says it no longer runs first", () => {
    const took = { notes: 3, compiledNotes: 3, runs: 4, workflows: [{ name: "sort-invoice", status: "active" }] };
    const stopped = { ...cost({ takeover: { n: 2, run_id: "r2" } }), workflows: [{ workflow: "sort-invoice", digest: "a".repeat(16), state: "needs_revision", served: null, by_hand: null, unknown_cost_runs: 0 }] } as LearningCost;
    const stage = storyOf({ ...base, ...took, cost: stopped, promotions: [record({ replay: REPLAY })], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: null }] }).find((s) => s.key === "took_over")!;
    expect([stage.value, stage.detail, stage.state]).toEqual(["Run 2", "revision aaaaaaa no longer runs first: it cost as much as the agent by hand; its next run asks the agent for a new version", "warn"]);
    const before = storyOf({ ...base, notes: 3, cost: { ...stopped, summary: cost({}).summary }, promotions: [record({ replay: REPLAY })], serving: [{ workflow: "sort-invoice", digest: "a".repeat(16), replaying: null }] }).find((s) => s.key === "took_over")!;
    expect([before.value, before.state]).toEqual(["Stopped", "warn"]);
  });
  it("once it took over and got cheaper, tells it whole, with where it is unsure", () => {
    const runs = [run(1, "agent"), run(2, "workflow"), run(3, "handed_back"), run(4, "workflow")];
    const loop = { agent: "a", compiles: [{ run_id: "r1", round: 1, at: at(1), workflow: "sort-invoice", from_notes: ["a", "b", "c"], attempts: [{ ok: true, errors: [] }], digest: "a".repeat(16), promoted: true, draft_errors: [], withheld: false }],
      guards: [{ workflow: "sort-invoice", digest: "a".repeat(16), node: "classify", signal: "jev", threshold: 0.7, runs: 3, escalated: 1, right: 0, wrong: 0, grades_past: 0, replays: 0, points: [] }] } as LearningLoop;
    const stages = storyOf({ ...base, notes: 3, compiledNotes: 3, runs: 4, workflows: [{ name: "sort-invoice", status: "active" }], loop, promotions: [record({ replay: REPLAY })],
      cost: cost({ takeover: { n: 2, run_id: "r2" }, before: { runs: 1, mean_usd: 0.89 }, after: { runs: 25, mean_usd: 0.127 }, times_cheaper: 7, hand_backs: { ran: 3, back: 1 } }, runs) });
    expect(stages.map((s) => [s.key, s.value, s.state])).toEqual([
      ["notes", "3 notes", "done"], ["compiled", "sort-invoice", "done"], ["took_over", "Run 2", "done"], ["cheaper", "7.0x cheaper", "done"], ["unsure", "33% handed back", "warn"],
    ]);
    expect(stages[4]!.detail).toBe('most at "classify": 1 of 3 under 0.70');
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
