import { describe, expect, it } from "vitest";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_START, TRACE_USD } from "@/components/RunTrace.sample";
import { comparedIds, compareFigures, compareHref, compareModels, compareTools, differenceWords, partial, runIdOf, type Side, sideOf } from "@/lib/traceCompare";
import type { Run, RunTrace, TraceSpan } from "@/lib/v2";

// Runs' Dev tools figures side by side. The first run is the sample trace (RunTrace.sample.ts), whose figures the tab's
// own tests state: 8 requests, 16 calls, 1 failed, 498K tokens, 81% of input from cache, 3m 45s. The second is a small
// run written here, so each of its figures and each difference below is worked out by hand.
const run = (id: string, more: Partial<Run> = {}): Run => ({ sha: null, updated_at: new Date(TRACE_END).toISOString(), poll_after_ms: 0, place: { mode: "runner" }, run_id: id, agent_id: "supplier-screening", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: id,
  created_at: new Date(TRACE_START).toISOString(), ended_at: new Date(TRACE_END).toISOString(), result: null, error: null, cost: { usd: TRACE_USD, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, ...more }) as Run;
const at = (ms: number) => new Date(TRACE_START + ms).toISOString();
const span = (more: Partial<TraceSpan> & Pick<TraceSpan, "id" | "kind" | "name">): TraceSpan => ({ parent_id: null, agent_label: null, started_at: at(0), ended_at: at(1000), status: "ok", stop_reason: null, tokens: null, usd: null, charged: false, decision: false, not_metered: false, tool_use_id: null, input_preview: null, result_preview: null, result_size_bytes: null, ...more });
// Two requests to another model (10 s and 20 s, 1,000 + 3,000 tokens, half of the input from cache, $0.01 + $0.03) and
// three web_search calls between them (2 s each, one failed), over 40 s.
const SMALL: RunTrace = { run_id: "run_small", model_requests: "priced", dropped: 0, spans: [
  span({ id: "m1", kind: "model", name: "claude-haiku-5-5", started_at: at(0), ended_at: at(10_000), tokens: { input: 400, cache_read: 400, cache_write: 0, output: 200 }, usd: 0.01 }),
  span({ id: "t1", kind: "tool", name: "web_search", started_at: at(10_000), ended_at: at(12_000) }),
  span({ id: "t2", kind: "tool", name: "web_search", started_at: at(12_000), ended_at: at(14_000), status: "failed" }),
  span({ id: "t3", kind: "tool", name: "web_search", started_at: at(14_000), ended_at: at(16_000) }),
  span({ id: "m2", kind: "model", name: "claude-haiku-5-5", started_at: at(20_000), ended_at: at(40_000), tokens: { input: 1_100, cache_read: 1_100, cache_write: 0, output: 800 }, usd: 0.03 }),
] };
const FIRST: Side = sideOf(run("run_first"), TRACE, 0);
const SECOND: Side = sideOf(run("run_small", { cost: { usd: 0.04, basis: "estimate", charge_state: null, cap_usd: null } }), SMALL, 0);

describe("the address of a comparison", () => {
  it("names its runs in order, each once, four at most; a pasted id or run page's address is read as the run", () => {
    expect(compareHref(["run_a", "run b"])).toBe("#/compare?runs=run_a,run%20b");
    expect(comparedIds("runs=run_a,run%20b")).toEqual(["run_a", "run b"]);
    expect(comparedIds("runs=a,,b,a, c ,d,e")).toEqual(["a", "b", "c", "d"]);
    expect(comparedIds("")).toEqual([]);
    expect([runIdOf(" run_7f3a9c2e "), runIdOf("https://console.example/#/runs/01a1fb3a-18a0-7b6d"), runIdOf("two words"), runIdOf("")]).toEqual(["run_7f3a9c2e", "01a1fb3a-18a0-7b6d", null, null]);
    // An address whose id is no valid escape is no run's: refused like any other, never thrown.
    expect([runIdOf("https://console.example/#/runs/%"), runIdOf("https://console.example/#/runs/run%20b")]).toEqual([null, "run b"]);
  });
});

describe("runs' figures side by side", () => {
  it("draws a run still going to the clock, and one that ended to its end", () => {
    expect([sideOf(run("a"), TRACE, 5).now, sideOf(run("b", { status: "working", ended_at: null }), TRACE, 5).now]).toEqual([TRACE_END, 5]);
  });
  const words = (row: { cells: { words: string }[] }) => row.cells.map((cell) => cell.words);
  const exact = (value: number) => ({ value, words: String(value), exact: true });
  it("says each run's figures as its own Dev tools tab does, and the second against the first", () => {
    const rows = compareFigures([FIRST, SECOND]);
    expect(rows.map((row) => [row.label, ...words(row), differenceWords(row)])).toEqual([
      ["Model requests", "8", "2", "−6 (−75%)"],
      ["Tool calls", "16", "3", "−13 (−81%)"],
      ["Failed", "1", "1", "Same"],
      // 498K tokens against 4,000: the sample's own sum, as its tile rounds it.
      ["Tokens", rows[3]!.cells[0]!.words, "4,000", `−${(rows[3]!.cells[0]!.value! - 4000).toLocaleString("en-US")} (−99%)`],
      // 81% of the first's input was read from cache, and half of the second's: 31 points fewer.
      ["Input read from cache", "81%", "50%", "−31 points"],
      ["Cost", "$0.6336", "$0.0400", "−$0.5936 (−94%)"],
      // 224.5 s against 40 s: 184.5 s fewer, which a length of time rounds to 3m 05s.
      ["Time", "3m 45s", "40.0 s", "−3m 05s (−82%)"],
      ["A model answering", rows[7]!.cells[0]!.words, "30.0 s", differenceWords(rows[7]!)],
      ["A tool running", rows[8]!.cells[0]!.words, "6.0 s", differenceWords(rows[8]!)],
    ]);
    expect(Math.round(rows[3]!.cells[0]!.value! / 1000)).toBe(498);
    expect(rows.every((row) => row.cells.every((cell) => cell.exact))).toBe(true);
  });
  it("leaves a figure a run's trace does not carry unknown, and says no difference of it", () => {
    // A CLI harness's record keeps no model request: no count of them, no tokens, no time of a model answering (it
    // answered; the trace does not say for how long), and its run's cost not one figure.
    const cli = sideOf(run("run_cli", { cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null } }), TRACE_CLI, 0);
    const rows = compareFigures([FIRST, cli]);
    const said = (label: string) => { const row = rows.find((r) => r.label === label)!; return [row.cells[1]!.words, differenceWords(row)]; };
    expect([said("Model requests"), said("Tokens"), said("Input read from cache"), said("Cost"), said("A model answering")]).toEqual([["–", null], ["–", null], ["–", null], ["–", null], ["–", null]]);
    expect(said("Tool calls")[0]).toBe(String(TRACE_CLI.spans.filter((s) => s.kind === "tool").length));
    // Nor is a model it never recorded a request to "not used": its requests, tokens and cost for it are unknown.
    expect(compareModels([FIRST, cli]).map((model) => [model.name, model.requests[1], model.tokens[1], model.usd[1]])).toEqual([["claude-sonnet-5-5", null, null, null]]);
  });
  it("says a run's figures as at least where its trace is its first spans only, and no difference of them; its cost is the run's own", () => {
    // A read serves a run's first 2,000 spans: this one left 37 out.
    const long: Side = { ...SECOND, trace: { ...SMALL, dropped: 37 } };
    expect([partial(SECOND), partial(long)]).toEqual([false, true]);
    const rows = compareFigures([FIRST, long]);
    expect(rows.map((row) => [row.label, row.cells[1]!.words, row.cells[1]!.exact, differenceWords(row)])).toEqual([
      ["Model requests", "at least 2", false, null],
      ["Tool calls", "at least 3", false, null],
      ["Failed", "at least 1", false, null],
      ["Tokens", "at least 4,000", false, null],
      ["Input read from cache", "50%, partial", false, null],
      ["Cost", "$0.0400", true, "−$0.5936 (−94%)"],
      ["Time", "at least 40.0 s", false, null],
      ["A model answering", "at least 30.0 s", false, null],
      ["A tool running", "at least 6.0 s", false, null],
    ]);
  });
  it("says a cost that is a ceiling as at most, and no difference of it", () => {
    // At most $1.00 against $0.50: the first may have cost less than the second.
    const held = sideOf(run("run_held", { cost: { usd: 1, basis: "estimate", charge_state: null, cap_usd: null, upper_bound: true } }), SMALL, 0);
    const half = sideOf(run("run_half", { cost: { usd: 0.5, basis: "estimate", charge_state: null, cap_usd: null } }), SMALL, 0);
    const cost = compareFigures([held, half]).find((row) => row.label === "Cost")!;
    expect([words(cost), cost.cells[0]!.exact, differenceWords(cost)]).toEqual([["at most $1.00", "$0.5000"], false, null]);
  });
  it("says a cost with a charge that has no price as at least what is priced, as the run's own tab does, and no difference of it", () => {
    // One request of the run has no price (cut before it answered): the server gives no whole cost, and what is priced so far.
    const part = sideOf(run("run_part", { cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null, so_far_usd: 0.0382, unpriced: 1 } }), SMALL, 0);
    const cost = compareFigures([FIRST, part]).find((row) => row.label === "Cost")!;
    expect([words(cost), cost.cells[1]!.value, cost.cells[1]!.exact, differenceWords(cost)]).toEqual([["$0.6336", "at least $0.0382"], 0.0382, false, null]);
    // A whole cost stands as it is, a ceiling still said as at most, though the server sends what is priced beside it.
    const held = sideOf(run("run_held", { cost: { usd: 1, basis: "estimate", charge_state: null, cap_usd: null, upper_bound: true, so_far_usd: 0.4, unpriced: 0 } }), SMALL, 0);
    expect(words(compareFigures([FIRST, held]).find((row) => row.label === "Cost")!)).toEqual(["$0.6336", "at most $1.00"]);
    // A run whose cost the server does not say at all stays unknown.
    const none = sideOf(run("run_none", { cost: { usd: null, basis: "unpriced", charge_state: null, cap_usd: null } }), SMALL, 0);
    expect(words(compareFigures([FIRST, none]).find((row) => row.label === "Cost")!)).toEqual(["$0.6336", "–"]);
  });
  it("says tokens as at least where a request reported none, and unknown where none did", () => {
    // The second request was cut before its usage came: its tokens are in no sum.
    const cutLast = { ...SMALL, spans: SMALL.spans.map((s) => (s.id === "m2" ? { ...s, tokens: null, usd: null, status: "interrupted" as const } : s)) };
    const some = compareFigures([FIRST, sideOf(SECOND.run, cutLast, 0)]);
    expect([some[3]!.cells[1], some[4]!.cells[1]!.words, differenceWords(some[3]!), differenceWords(some[4]!)]).toEqual([{ value: 1000, words: "at least 1,000", exact: false }, "50%, partial", null, null]);
    // A run whose only request was interrupted: unknown, never 0 tokens.
    const none = { ...SMALL, spans: [{ ...SMALL.spans[0]!, tokens: null, usd: null, status: "interrupted" as const }] };
    const told = compareFigures([FIRST, sideOf(SECOND.run, none, 0)]);
    expect([told[3]!.cells[1]!.words, told[4]!.cells[1]!.words, differenceWords(told[3]!)]).toEqual(["–", "–", null]);
  });
  it("says a time as at least where a span's length is not kept, and unknown where none of its kind has one; never a run made faster by it", () => {
    // The second request answered, and its record keeps no duration: its 20 s are in no sum.
    const noEnd = { ...SMALL, spans: SMALL.spans.map((s) => (s.id === "m2" ? { ...s, ended_at: null } : s)) };
    const rows = compareFigures([FIRST, sideOf(SECOND.run, noEnd, 0)]);
    const said = (label: string) => { const row = rows.find((r) => r.label === label)!; return [row.cells[1]!.words, row.cells[1]!.exact, differenceWords(row)]; };
    // The window ends where the last span with a length does (the request's start, 20 s in), and 10 s of a model answering is known.
    expect([said("Time"), said("A model answering")]).toEqual([["at least 20.0 s", false, null], ["at least 10.0 s", false, null]]);
    // That request may have answered while a tool ran: the tools' 6 s is said as partial, with no difference.
    expect(said("A tool running")).toEqual(["6.0 s, partial", false, null]);
    // A call cut with no result has no length either: the tools' time is at least the two that have.
    const cutCall = { ...SMALL, spans: SMALL.spans.map((s) => (s.id === "t2" ? { ...s, ended_at: null, status: "interrupted" as const } : s)) };
    const cut = compareFigures([FIRST, sideOf(SECOND.run, cutCall, 0)]);
    expect([cut[8]!.cells[1], cut[7]!.cells[1]!.exact, differenceWords(cut[8]!)]).toEqual([{ value: 4000, words: "at least 4.0 s", exact: false }, true, null]);
    // No span of a kind with a length: its time is unknown, never 0 with −100% beside it.
    const none = { ...SMALL, spans: SMALL.spans.map((s) => (s.kind === "model" ? { ...s, ended_at: null } : s)) };
    const model = compareFigures([FIRST, sideOf(SECOND.run, none, 0)])[7]!;
    expect([model.cells[1]!.words, differenceWords(model)]).toEqual(["–", null]);
  });
  it("says a difference from nothing with no percent, and a share that rounds to no point as the same", () => {
    expect(differenceWords({ cells: [exact(0), exact(3)], say: String })).toBe("+3");
    expect(differenceWords({ cells: [exact(0.5), exact(0.504)], say: String, share: true })).toBe("Same");
    expect(differenceWords({ cells: [exact(0.5), exact(0.62)], say: String, share: true })).toBe("+12 points");
    expect(differenceWords({ cells: [exact(2), exact(3)], say: (n) => `${n} s` })).toBe("+1 s (+50%)");
  });
  it("lists every tool and every model any run used, a run that used none of one at 0", () => {
    const tools = compareTools([FIRST, SECOND]);
    const search = tools.find((tool) => tool.name === "web_search")!;
    expect([search.calls[1], search.failed[1], search.ms[1]]).toEqual([3, 1, 6000]);
    // A tool only the first run called: the second has none of it.
    const only = tools.find((tool) => tool.calls[1] === 0)!;
    expect([only.calls[0]! > 0, only.failed[1], only.ms[1]]).toEqual([true, 0, 0]);
    const models = compareModels([FIRST, SECOND]);
    expect(models.map((model) => [model.name, model.requests, model.tokens[1], model.usd[1]])).toEqual([
      ["claude-sonnet-5-5", [8, 0], 0, 0],
      ["claude-haiku-5-5", [0, 2], 4000, 0.04],
    ]);
  });
});
