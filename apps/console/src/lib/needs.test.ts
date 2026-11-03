import { afterEach, describe, expect, it, vi } from "vitest";
import { choicesOf, failureGroups, hasOwnRun, mergeNeeds, pollSettled, rerunBody } from "./needs";
import type { Run } from "./v2";

const run = (id: string, over: Partial<Run> = {}): Run => ({
  run_id: id, agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status: "failed", state: "idle", title: id,
  created_at: "2026-11-03T16:08:00Z", ended_at: "2026-11-03T16:08:30Z", result: null, error: null, cost: null, archived_at: null, ...over,
});
const failed = (id: string, message: string, over: Partial<Run> = {}) => run(id, { error: { code: "run_failed", message, retryable: false }, ...over });

// The answers a question offers, as one-tap choices: only when it plainly offers them.
describe("choicesOf", () => {
  it("reads the options after a colon, without their article", () => {
    expect(choicesOf("Contoso Freight isn't on the vendor list yet. Which approval limit applies: the $5,000 standard or the $25,000 preferred tier?"))
      .toEqual(["$5,000 standard", "$25,000 preferred tier"]);
  });
  it("reads an either-or request in the last sentence, without its trailing instead", () => {
    expect(choicesOf("The refund is $640, over the $500 policy limit. Approve an exception, or offer store credit instead?")).toEqual(["Approve an exception", "Offer store credit"]);
  });
  it("reads three options from a list, a bare token kept as written", () => {
    expect(choicesOf("Which region should I deploy to: us-east, eu-west, or ap-south?")).toEqual(["us-east", "eu-west", "ap-south"]);
  });
  it("offers none for an open question, a yes-or-no one, or options too long to be buttons", () => {
    expect(choicesOf("Which product or plan was charged twice?")).toEqual([]);
    expect(choicesOf("Should I use the staging database or production?")).toEqual([]);
    expect(choicesOf("What should the release be called?")).toEqual([]);
    expect(choicesOf(`Pick one: ${"a very long option that keeps going and going ".repeat(2)}or the other one?`)).toEqual([]);
  });
});

// Failures that need a person: the same error once, with every run it stopped behind it; imported history is not here.
describe("failureGroups", () => {
  it("groups failures by their error, the most recent group first, and leaves imported runs out", () => {
    const groups = failureGroups([
      failed("a", "529 overloaded: the provider is over capacity", { ended_at: "2026-11-03T16:09:00Z" }),
      failed("b", "the run hit its spend cap", { ended_at: "2026-11-03T16:10:00Z" }),
      failed("c", "529 overloaded: the provider is over capacity", { ended_at: "2026-11-03T16:08:00Z" }),
      failed("d", "API Error: overloaded", { imported_from: { source: "claude-code", session: "s1" } }),
    ]);
    expect(groups.map((g) => [g.message, g.runs.map((r) => r.run_id)])).toEqual([
      ["the run hit its spend cap", ["b"]],
      ["529 overloaded: the provider is over capacity", ["a", "c"]],
    ]);
  });
  it("names a failure with no error message by what happened", () => {
    expect(failureGroups([run("e")])[0]!.message).toBe("The run failed.");
  });
});

// Mission Control's first-run panel shows until a run of the owner's own exists: imported history is not one.
describe("hasOwnRun", () => {
  const live = (runs: number) => [{ source: "live", runs }];
  it("is false with no runs, or only imported ones", () => {
    expect(hasOwnRun([], [])).toBe(false);
    expect(hasOwnRun([run("i", { imported_from: { source: "codex", session: "s" } })], [{ source: "codex", runs: 1 }])).toBe(false);
  });
  it("is true once a run here exists, in the recent runs or in the analytics", () => {
    expect(hasOwnRun([run("r")], [])).toBe(true);
    expect(hasOwnRun([run("i", { imported_from: { source: "pi", session: "s" } })], live(3))).toBe(true);
  });
});

// Run again starts the same task again: the run's whole first message, its effort and its spend cap, or a refusal that
// says why it can't be.
describe("rerunBody", () => {
  const base = run("x", { status: "failed", cost: { usd: 0.4, basis: "estimate", charge_state: null, cap_usd: 0.5 }, effort: "high" });
  it("carries the first message, the effort and the spend cap", () => {
    expect(rerunBody(base, "Check invoice INV-2299.")).toEqual({ body: { input: { content: "Check invoice INV-2299." }, effort: "high", max_cost_usd: 0.5 } });
    expect(rerunBody({ ...base, effort: undefined, cost: null }, "Go.")).toEqual({ body: { input: { content: "Go." } } });
  });
  it("refuses a workflow run, and a first message the timeline cut, never starting a shortened task", () => {
    expect(rerunBody({ ...base, kind: "workflow" }, "{}")).toHaveProperty("refusal");
    const cut = `${"x".repeat(1997)}...`;
    expect(rerunBody(base, cut)).toEqual({ refusal: `"x": its first message is longer than the timeline keeps; start it again from its agent's page` });
    expect(rerunBody(base, undefined)).toEqual({ refusal: `"x": its first message could not be read` });
  });
});

// The strip's three reads land apart: one that fails keeps what that section showed, and says so.
describe("mergeNeeds", () => {
  const ok = <T,>(value: T) => ({ status: "fulfilled" as const, value });
  const no = (message: string) => ({ status: "rejected" as const, reason: new Error(message) });
  it("takes each read that landed, keeps the last answer of one that failed, and names what could not be read", () => {
    const prev = { asking: [run("q")], failed: [run("f")], live: [run("w")] };
    const next = mergeNeeds(prev, [ok([run("q2")]), no("Failed to fetch"), ok([])]);
    expect(next.needs.asking.map((r) => r.run_id)).toEqual(["q2"]);
    expect(next.needs.failed.map((r) => r.run_id)).toEqual(["f"]);
    expect(next.needs.live).toEqual([]);
    expect(next.problem).toBe("The failed runs could not be read: Failed to fetch");
    expect(mergeNeeds(null, [ok([]), ok([]), ok([])]).problem).toBeNull();
  });
});

// A run given files names them on a line after its first message (serve's "Files for this run: …"). A run started again
// takes only a message, and its files' ids aren't on the run's read, so the files can't come along: refused, by name.
describe("rerunBody, a run that was given files", () => {
  const base = run("r1", { title: "Summarize the report" });
  it("refuses it, saying why, rather than start it without its files", () => {
    const r = rerunBody(base, "Summarize the report.\n\nFiles for this run: inputs/report.pdf (12.0 KB), inputs/notes.md (1.2 KB).");
    expect(r).toHaveProperty("refusal");
    expect((r as { refusal: string }).refusal).toMatch(/was given files/);
  });
  it("starts one whose message only mentions files, with no line of its own", () => {
    expect(rerunBody(base, "Files for this run: none. Just say hi.")).toEqual({ body: { input: { content: "Files for this run: none. Just say hi." } } });
  });
});

// The strip reads every 10 s, but never two reads at once: the next starts only once the last has settled, so an older
// read can't land after a newer one and put back what it said.
describe("pollSettled", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("starts the next read only after the last has settled, then waits the interval; stop stops it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release: (() => void) | undefined;
    const read = () => { calls++; return new Promise<void>((r) => { release = r; }); };
    const stop = pollSettled(read, 10_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(calls).toBe(1);
    release!(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    stop(); release!(); await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
  });
  it("goes on after a read that failed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stop = pollSettled(() => { calls++; return Promise.reject(new Error("offline")); }, 10_000);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(calls).toBe(2);
    stop();
  });
});
