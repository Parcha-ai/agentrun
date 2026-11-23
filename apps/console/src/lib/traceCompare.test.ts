import { describe, expect, it } from "vitest";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_START, TRACE_USD } from "@/components/RunTrace.sample";
import { comparedIds, compareFigures, compareHref, compareModels, compareTools, differenceWords, runIdOf, type Side, sideOf } from "@/lib/traceCompare";
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
  });
});

describe("runs' figures side by side", () => {
  it("draws a run still going to the clock, and one that ended to its end", () => {
    expect([sideOf(run("a"), TRACE, 5).now, sideOf(run("b", { status: "working", ended_at: null }), TRACE, 5).now]).toEqual([TRACE_END, 5]);
  });
  it("says each run's figures as its own Dev tools tab does, and the second against the first", () => {
    const rows = compareFigures([FIRST, SECOND]);
    expect(rows.map((row) => [row.label, ...row.words, differenceWords(row)])).toEqual([
      ["Model requests", "8", "2", "−6 (−75%)"],
      ["Tool calls", "16", "3", "−13 (−81%)"],
      ["Failed", "1", "1", "Same"],
      // 498,174 tokens against 4,000: the sample's own sum, as its tile rounds it to 498K.
      ["Tokens", rows[3]!.words[0], "4,000", `−${(rows[3]!.values[0]! - 4000).toLocaleString("en-US")} (−99%)`],
      // 81% of the first's input was read from cache, and half of the second's: 31 points fewer.
      ["Input read from cache", "81%", "50%", "−31 points"],
      ["Cost", "$0.6336", "$0.0400", "−$0.5936 (−94%)"],
      // 224.5 s against 40 s: 184.5 s fewer, which a length of time rounds to 3m 05s.
      ["Time", "3m 45s", "40.0 s", "−3m 05s (−82%)"],
      ["A model answering", rows[7]!.words[0], "30.0 s", differenceWords(rows[7]!)],
      ["A tool running", rows[8]!.words[0], "6.0 s", differenceWords(rows[8]!)],
    ]);
    expect(Math.round(rows[3]!.values[0]! / 1000)).toBe(498);
  });
  it("leaves a figure a run's trace does not carry unknown, and says no difference of it", () => {
    // A CLI harness's record keeps no model request: no count of them, no tokens, and its run's cost not one figure.
    const cli = sideOf(run("run_cli", { cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null } }), TRACE_CLI, 0);
    const rows = compareFigures([FIRST, cli]);
    const said = (label: string) => { const row = rows.find((r) => r.label === label)!; return [row.words[1], differenceWords(row)]; };
    expect([said("Model requests"), said("Tokens"), said("Input read from cache"), said("Cost")]).toEqual([["–", null], ["–", null], ["–", null], ["–", null]]);
    expect(said("Tool calls")[0]).toBe(String(TRACE_CLI.spans.filter((s) => s.kind === "tool").length));
  });
  it("says a difference from nothing with no percent, and a share that rounds to no point as the same", () => {
    expect(differenceWords({ values: [0, 3], say: String })).toBe("+3");
    expect(differenceWords({ values: [0.5, 0.504], say: String, share: true })).toBe("Same");
    expect(differenceWords({ values: [0.5, 0.62], say: String, share: true })).toBe("+12 points");
    expect(differenceWords({ values: [2, 3], say: (n) => `${n} s` })).toBe("+1 s (+50%)");
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
