import { describe, expect, it } from "vitest";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_LIVE, TRACE_LIVE_NOW, TRACE_START, TRACE_USD } from "@/components/RunTrace.sample";
import { between, byModel, byTool, costSplit, duration, findings, keeps, lane, offset, ordered, panned, percent, percentile, place, spanMs, ticks, timing, traceTotals, traceWindow, usd, vitals, WHOLE, zoomed } from "@/lib/trace";
import type { TraceSpan } from "@/lib/v2";

// The Dev tools tab's figures over the sample trace (RunTrace.sample.ts): each expected value here is worked out by hand
// from the sample's own numbers, never by the code under test.
const span = (id: string) => TRACE.spans.find((s) => s.id === id)!;

describe("how a trace's times and amounts are said", () => {
  it("a length of time in the unit a person reads it in", () => {
    expect([4, 999, 1000, 4800, 59_949, 62_000, 224_500, 3_600_000, 7_500_000].map(duration)).toEqual(["4 ms", "999 ms", "1.0 s", "4.8 s", "59.9 s", "1m 02s", "3m 45s", "1h 00m", "2h 05m"]);
  });
  it("a time since the trace began, to the tenth of a second, and by the hour past one", () => {
    expect([0, 5000, 89_600, 3_727_000].map(offset)).toEqual(["+0:00.0", "+0:05.0", "+1:29.6", "+1:02:07"]);
  });
  it("a share never rounds to none or to all of it", () => {
    expect([0, 0.0006, 0.004, 0.81, 0.996, 1].map(percent)).toEqual(["0%", "<1%", "<1%", "81%", "99%", "100%"]);
  });
  it("dollars to the ten-thousandth under a dollar", () => {
    expect([0, 0.00004, 0.0004, 0.078867, 1.066].map(usd)).toEqual(["$0", "<$0.0001", "$0.0004", "$0.0789", "$1.07"]);
  });
});

describe("where spans sit on the time axis", () => {
  it("the window runs from the first span's start to the last one's end", () => {
    expect(traceWindow(TRACE.spans, TRACE_END)).toEqual({ from: TRACE_START + 3400, to: TRACE_START + 227_900, ms: 224_500 });
  });
  it("a span still going is drawn to now, and one that waits too; a request with no end has no length", () => {
    const [running, waiting] = [TRACE_LIVE.spans.find((s) => s.status === "running")!, TRACE_LIVE.spans.find((s) => s.status === "waiting")!];
    expect([spanMs(running), spanMs(running, TRACE_LIVE_NOW), spanMs(waiting, TRACE_LIVE_NOW)]).toEqual([null, 11_500, 11_400]);
    expect(spanMs({ ...span("m:0:2"), ended_at: null }, TRACE_END)).toBeNull();
  });
  it("calls that overlap go on rows of their own: three searches at once take three rows, and the next call the first row again", () => {
    const tools = TRACE.spans.filter((s) => s.kind === "tool");
    const { bars, rows } = lane(tools, traceWindow(TRACE.spans, TRACE_END), TRACE_END);
    const row = (id: string) => bars.find((b) => b.span.id === id)!.row;
    // The skill's 4 ms call ends just before the searches start, nearer than the gap between bars: a row of its own.
    expect([row("t:0:call_01"), row("t:0:call_02"), row("t:0:call_03"), row("t:0:call_04")]).toEqual([0, 1, 2, 3]);
    expect(row("t:0:call_08")).toBe(0);
    expect(rows).toBe(4);
    const first = bars.find((b) => b.span.id === "t:0:call_10")!;
    expect(first.left).toBeCloseTo(((54_200 - 3400) / 224_500) * 100, 6);
    expect(first.width).toBeCloseTo((38_600 / 224_500) * 100, 6);
  });
  it("the axis is marked at a round step, at most eight marks", () => {
    expect(ticks(224_500).map((t) => t.label)).toEqual(["0:00", "0:30", "1:00", "1:30", "2:00", "2:30", "3:00", "3:30"]);
    expect(ticks(900).map((t) => t.label)).toEqual(["0.0s", "0.2s", "0.4s", "0.6s", "0.8s"]);
    expect(ticks(5 * 3_600_000).at(-1)!.label).toBe("5:00:00");
    expect(ticks(0)).toEqual([{ left: 0, label: "0:00" }]);
  });
});

describe("the part of the run the table's time axis shows", () => {
  const window = { from: TRACE_START + 3400, ms: 224_500 };
  it("a zoom shows half as much about its middle, or about a place given; it stays inside the run and never under a 64th of it", () => {
    expect(zoomed(WHOLE, 2)).toEqual({ from: 0.25, to: 0.75 });
    expect(zoomed(WHOLE, 2, 0.1)).toEqual({ from: 0, to: 0.5 });
    expect(zoomed(WHOLE, 2, 0.95)).toEqual({ from: 0.5, to: 1 });
    // Out again past the whole run is the whole run, the very one: "is it zoomed" is one comparison.
    expect(zoomed({ from: 0.25, to: 0.75 }, 0.5)).toBe(WHOLE);
    expect(zoomed({ from: 0.5, to: 0.5 + 1 / 64 }, 2)).toEqual({ from: 0.5, to: 0.5 + 1 / 64 });
  });
  it("a move goes by a share of what shows and stops at the run's edges; a drag picks between two places in either order", () => {
    expect(panned({ from: 0.25, to: 0.75 }, 0.5)).toEqual({ from: 0.5, to: 1 });
    expect(panned({ from: 0.5, to: 1 }, 0.5)).toEqual({ from: 0.5, to: 1 });
    expect(panned({ from: 0.25, to: 0.5 }, -2)).toEqual({ from: 0, to: 0.25 });
    expect(between(0.75, 0.25)).toEqual({ from: 0.25, to: 0.75 });
  });
  it("a span's place in what shows: cut at an edge it runs past, and none for one wholly outside", () => {
    // The long shell command runs from 54.2 s to 92.8 s of the sample; the window begins at 3.4 s and is 224.5 s long.
    const bash = span("t:0:call_10");
    const whole = place(bash, window, WHOLE, TRACE_END);
    expect(whole.off).toBeNull();
    expect((whole as { left: number }).left).toBeCloseTo((50_800 / 224_500) * 100, 9);
    expect((whole as { width: number }).width).toBeCloseTo((38_600 / 224_500) * 100, 9);
    // The middle half shows 59.525 s to 171.775 s: the command began before it, so its bar starts at the left edge
    // and is what is left of it, 33.275 s of 112.25 s.
    const cut = place(bash, window, { from: 0.25, to: 0.75 }, TRACE_END) as { left: number; width: number; off: null };
    expect(cut.left).toBe(0);
    expect(cut.width).toBeCloseTo((33_275 / 112_250) * 100, 9);
    expect(place(span("t:0:call_01"), window, { from: 0.25, to: 0.75 }, TRACE_END)).toEqual({ off: "before" });
    expect(place(span("m:0:40"), window, { from: 0.25, to: 0.75 }, TRACE_END)).toEqual({ off: "after" });
  });
  it("its marks name the time since the run began, wherever the part that shows begins", () => {
    // The middle half of the sample: 56.125 s to 168.375 s, marked every 30 s from the first round time in it.
    expect(ticks(112_250, 4, 56_125).map((t) => t.label)).toEqual(["1:00", "1:30", "2:00", "2:30"]);
    expect(ticks(112_250, 4, 56_125)[0]!.left).toBeCloseTo((3875 / 112_250) * 100, 9);
  });
});

describe("a span's time in three parts", () => {
  it("a tool call: from its request's answer to its start, its run, and to the next request's start", () => {
    const t = timing(span("t:0:call_08"), TRACE.spans, TRACE_END);
    expect([t.before!.ms, t.before!.since.id, t.ran, t.then!.ms, t.then!.until.id]).toEqual([200, "m:0:16", 12_400, 200, "m:0:19"]);
  });
  it("a model request: from the end of the last thing before it, its answer, and to its first call's start", () => {
    // The second request started at 14.9 s: the slowest of the three searches ended at 14.6 s. Its fetches began at 18.0 s, 200 ms after its answer.
    const t = timing(span("m:0:9"), TRACE.spans, TRACE_END);
    expect([t.before!.ms, t.before!.since.id, t.ran, t.then!.ms, t.then!.until.tool_use_id]).toEqual([300, "t:0:call_03", 2900, 200, "call_05"]);
  });
  it("a part the trace cannot say is left out: nothing before the first request, nothing after the last, no next for a call still going", () => {
    expect(timing(span("m:0:2"), TRACE.spans, TRACE_END).before).toBeNull();
    expect(timing(span("m:0:40"), TRACE.spans, TRACE_END).then).toBeNull();
    const waiting = TRACE_LIVE.spans.find((s) => s.status === "waiting")!;
    const t = timing(waiting, TRACE_LIVE.spans, TRACE_LIVE_NOW);
    expect([t.before!.ms, t.ran, t.then]).toEqual([400, 11_400, null]);
  });
  it("a subagent's spans are not read against the run's own", () => {
    const sub = { ...span("m:0:9"), id: "m:1:1", agent_label: "researcher" };
    expect(timing(sub, [...TRACE.spans, sub], TRACE_END).before).toBeNull();
  });
});

describe("the figures every run has", () => {
  it("how soon it first answered and first acted, its largest input, its calls at once and its longest pause", () => {
    const v = vitals(TRACE.spans, TRACE_END);
    // From the window's start at 3.4 s: the first request answered at 8.2 s and the first call began at 8.4 s.
    expect([v.firstAnswer!.ms, v.firstAnswer!.span.id]).toEqual([4800, "m:0:2"]);
    expect([v.firstCall!.ms, v.firstCall!.span.id]).toEqual([5000, "t:0:call_01"]);
    // The last request's input: 2 fresh, 85,712 read from cache, 6,886 written.
    expect([v.largestInput!.tokens, v.largestInput!.nth, v.largestInput!.of]).toEqual([92_600, 8, 8]);
    // Three searches ran together from 8.6 s; the skill call before them had ended.
    expect(v.atOnce).toEqual({ calls: 3, at: 5200 });
    // The longest stretch with nothing going: from the last search's end at 14.6 s to the next request at 14.9 s.
    expect([v.longestPause!.ms, v.longestPause!.at, v.longestPause!.after.id]).toEqual([300, 11_200, "t:0:call_03"]);
  });
  it("a trace with no request has no first answer and no input; one call alone has no pause", () => {
    const v = vitals(TRACE_CLI.spans.slice(0, 1), TRACE_END);
    expect([v.firstAnswer, v.largestInput, v.longestPause]).toEqual([null, null, null]);
    expect(v.atOnce).toEqual({ calls: 1, at: 0 });
    expect(vitals([], TRACE_END)).toEqual({ firstAnswer: null, firstCall: null, largestInput: null, atOnce: null, longestPause: null });
  });
});

describe("what a trace adds up to", () => {
  const totals = traceTotals(TRACE, TRACE_END);
  it("its requests, calls and failures, and its requests' tokens", () => {
    expect([totals.requests, totals.calls, totals.failed, totals.untold]).toEqual([8, 16, 1, 0]);
    expect(totals.tokens).toEqual({ input: 1218, cache_read: 395_516, cache_write: 91_384, output: 9879, reasoning: 320 });
  });
  it("its cost: the requests' and the charges under its calls, which together are the run's", () => {
    expect(totals.cost.charges).toEqual({ usd: expect.closeTo(0.0204, 9), unknown: 0 });
    expect([totals.cost.charged, totals.cost.notMetered, totals.cost.requests!.unknown]).toEqual([5, 1, 0]);
    expect(totals.cost.requests!.usd + totals.cost.charges.usd).toBeCloseTo(TRACE_USD, 9);
  });
  it("where the time went, each moment once: a model answering, a tool running, neither", () => {
    expect(totals.time).toEqual({ wall: 224_500, model: 86_400, tools: 135_036, other: 3064 });
  });
  it("a charge of an unknown amount is counted, never read as $0; a run with no priced request has no request cost", () => {
    const unknown = traceTotals({ ...TRACE, spans: TRACE.spans.map((s) => (s.id === "t:0:call_02" ? { ...s, usd: null } : s)) }, TRACE_END);
    expect(unknown.cost.charges).toEqual({ usd: expect.closeTo(0.0154, 9), unknown: 1 });
    expect(traceTotals(TRACE_CLI, TRACE_END).cost.requests).toBeNull();
    expect(traceTotals(TRACE_CLI, TRACE_END).tokens).toBeNull();
    // A workflow run: its model nodes' requests carry no cost (booked for the run); its decisions carry their own.
    const flow = TRACE.spans.map((s) => (s.kind === "model" ? { ...s, usd: null } : s));
    expect(traceTotals({ ...TRACE, model_requests: "tokens_only", spans: flow }, TRACE_END).cost.requests).toBeNull();
    const decided = flow.map((s) => (s.id === "m:0:2" || s.id === "m:0:9" ? { ...s, decision: true, usd: 0.0003 } : s));
    expect(traceTotals({ ...TRACE, model_requests: "tokens_only", spans: decided }, TRACE_END).cost.requests).toEqual({ usd: expect.closeTo(0.0006, 9), unknown: 0 });
    // A decision whose receipt keeps no cost is one unknown: the subtotal never reads whole without it. The model
    // nodes' requests, which carry none by design, are still not counted.
    const unpriced = decided.map((s) => (s.id === "m:0:9" ? { ...s, usd: null } : s));
    expect(traceTotals({ ...TRACE, model_requests: "tokens_only", spans: unpriced }, TRACE_END).cost.requests).toEqual({ usd: expect.closeTo(0.0003, 9), unknown: 1 });
    const rows = byModel(unpriced.map((s) => (s.decision ? { ...s, name: "typesafe/jev-1" } : s)), false);
    expect(rows.map((r) => [r.name, r.cost])).toEqual([["claude-sonnet-5-5", null], ["typesafe/jev-1", { usd: expect.closeTo(0.0003, 9), unknown: 1 }]]);
  });
});

describe("the same by tool and by model", () => {
  it("each tool's calls, failures and times, the tool that took the most time first", () => {
    const rows = byTool(TRACE.spans, TRACE_END);
    expect(rows.slice(0, 2).map((r) => [r.name, r.calls, r.totalMs])).toEqual([["mcp:mail/send_draft", 1, 58_800], ["bash", 2, 47_500]]);
    const [bash, fetch, search] = ["bash", "web_fetch", "web_search"].map((name) => rows.find((r) => r.name === name)!);
    expect([bash.p50, bash.p95, bash.maxMs]).toEqual([8900, 38_600, 38_600]);
    expect([fetch.calls, fetch.failed, fetch.bytes]).toEqual([4, 1, 62_140 + 24_630 + 366 + 30_410]);
    expect([search.calls, search.charged, search.charges.usd]).toEqual([4, 4, expect.closeTo(0.02, 9)]);
  });
  it("the nearest rank of a percentile", () => {
    expect([percentile([], 0.5), percentile([7], 0.95), percentile([1, 2, 3, 4], 0.5), percentile([1, 2, 3, 4], 0.95)]).toEqual([null, 7, 2, 4]);
  });
  it("a model's requests, the share of its input read from cache, and how fast it wrote", () => {
    const [model] = byModel(TRACE.spans);
    expect([model!.name, model!.requests, model!.failed, model!.totalMs]).toEqual(["claude-sonnet-5-5", 8, 0, 86_400]);
    // Its eight requests took 2.1, 2.9, 3.1, 3.4, 4.8, 5.6, 6.2 and 58.3 s: the fourth is the middle, the eighth the 95th.
    expect([model!.p50, model!.p95]).toEqual([3400, 58_300]);
    expect(model!.cache).toBeCloseTo(395_516 / 488_118, 9);
    expect(model!.perSecond).toBeCloseTo(9879 / 86.4, 6);
    expect(model!.cost!.usd + 0.0204).toBeCloseTo(TRACE_USD, 9);
  });
});

describe("where the cost went", () => {
  it("each model's requests, then the charges under the calls", () => {
    const split = costSplit(TRACE.spans)!;
    expect(split.parts.map((p) => [p.name, p.kind])).toEqual([["claude-sonnet-5-5", "model"], ["Tool charges", "tool"]]);
    expect(split.parts[1]!.usd).toBeCloseTo(0.0204, 9);
    expect(split.total).toBeCloseTo(TRACE_USD, 9);
  });
  it("a second model's requests are a part of their own, the dearer model first; a trace that knows no cost has no split", () => {
    const two = costSplit(TRACE.spans.map((s) => (s.id === "m:0:2" ? { ...s, name: "claude-haiku-5-5" } : s)))!;
    expect(two.parts.map((p) => p.name)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5", "Tool charges"]);
    expect(two.parts[1]!.usd).toBeCloseTo(0.078867, 9);
    expect(costSplit(TRACE_CLI.spans)).toBeNull();
    // A run on a free model: its requests have a known cost, $0. A split of nothing, never "no known cost".
    const free = costSplit(TRACE.spans.filter((s) => s.kind === "model").map((s) => ({ ...s, usd: 0 })))!;
    expect([free.total, free.parts.map((p) => p.name)]).toEqual([0, ["claude-sonnet-5-5"]]);
  });
});

describe("what stands out", () => {
  it("what failed first, then the slowest call and request, the dearest request, the cache and the largest result", () => {
    const found = findings(TRACE, TRACE_END);
    expect(found.map((f) => f.id)).toEqual(["failed", "slowest-call", "slowest-request", "dearest", "cache", "largest"]);
    expect(found.map((f) => f.span)).toEqual(["t:0:call_07", "t:0:call_15", "m:0:37", "m:0:37", undefined, "t:0:call_05"]);
    expect(found[0]).toMatchObject({ bad: true, title: "1 call failed: web_fetch", detail: "At +0:14.7. The run went on after it." });
    // A run whose last span failed: nothing is said to have gone on.
    const last = findings({ ...TRACE, spans: TRACE.spans.map((s, i) => (i === TRACE.spans.length - 1 ? { ...s, status: "failed" } : s.status === "failed" ? { ...s, status: "ok" } : s)) }, TRACE_END)[0]!;
    expect(last).toMatchObject({ title: "1 call failed: claude-sonnet-5-5", detail: "At +3:42.4. Nothing ran after it." });
    expect(found[1]!.detail).toBe("58.8 s · 26% of the run's time");
    expect(found[4]!.title).toBe("81% of input was read from cache");
    expect(found[4]!.detail).toBe("395,516 of 488,118 input tokens. 1 of 8 requests read nothing from cache.");
    expect(found[5]!.detail).toContain("61 KB");
  });
  it("time between calls is said once it is a quarter of the run; a CLI harness's trace says nothing of requests or cache", () => {
    const idle: TraceSpan[] = [{ ...span("t:0:call_01"), started_at: new Date(TRACE_START).toISOString(), ended_at: new Date(TRACE_START + 1000).toISOString() }, { ...span("t:0:call_11"), started_at: new Date(TRACE_START + 9000).toISOString(), ended_at: new Date(TRACE_START + 10_000).toISOString() }];
    expect(findings({ spans: idle, model_requests: "not_recorded" }, TRACE_END).find((f) => f.id === "between")!.title).toBe("80% of the run was between calls");
    expect(findings(TRACE_CLI, TRACE_END).map((f) => f.id)).toEqual(["failed", "slowest-call"]);
  });
});

describe("what stands out in how a run used its cache and its tools", () => {
  it("a request that read nothing from cache after the cache was written is said, with what it sent fresh", () => {
    // The fourth request of the sample, with nothing read from cache: its 48,816 cached tokens sent fresh instead.
    const spans = TRACE.spans.map((s) => (s.id === "m:0:19" ? { ...s, tokens: { input: 48_818, cache_read: 0, cache_write: 9240, output: 734 } } : s));
    const found = findings({ ...TRACE, spans }, TRACE_END).find((f) => f.id === "cache-reset")!;
    expect([found.title, found.detail, found.span]).toEqual(["A request read nothing from cache at +0:36.0", "Earlier requests to claude-sonnet-5-5 wrote to the cache. This one sent its whole input fresh: 58,058 tokens.", "m:0:19"]);
    // The run's first request reads nothing from cache and is not one: nothing was written before it.
    expect(findings(TRACE, TRACE_END).some((f) => f.id === "cache-reset")).toBe(false);
  });
  it("three or more calls to one tool with the same arguments are said; two are not, and a head too long to compare is left out", () => {
    const again = (n: number, input: string, more: Partial<TraceSpan> = {}): TraceSpan => ({ ...span("t:0:call_05"), id: `t:0:again_${n}`, tool_use_id: `again_${n}`, input_preview: input, ...more });
    const url = '{"url":"https://registry.example/companies/NF-204418"}';
    // The sample fetches that address once; two more fetches of it make three.
    const thrice = findings({ ...TRACE, spans: [...TRACE.spans, again(1, url), again(2, url, { status: "failed" })] }, TRACE_END).find((f) => f.id === "repeated")!;
    expect([thrice.title, thrice.detail, thrice.span]).toEqual(["3 calls to web_fetch had the same arguments", `${url} · 1 failed`, "t:0:again_1"]);
    expect(findings({ ...TRACE, spans: [...TRACE.spans, again(1, url)] }, TRACE_END).some((f) => f.id === "repeated")).toBe(false);
    // A CLI run that tests, edits and tests again made the same call twice: not a finding.
    expect(findings(TRACE_CLI, TRACE_END).some((f) => f.id === "repeated")).toBe(false);
    const long = "x".repeat(480);
    expect(findings({ ...TRACE, spans: [...TRACE.spans, again(1, long), again(2, long), again(3, long)] }, TRACE_END).some((f) => f.id === "repeated")).toBe(false);
  });
});

describe("the table's filter and order", () => {
  it("keeps a span by its kind, or one that failed, and by every word typed", () => {
    const kept = (kind: Parameters<typeof keeps>[1], query = "") => TRACE.spans.filter((s) => keeps(s, kind, query)).map((s) => s.id);
    expect(kept("failed")).toEqual(["t:0:call_07"]);
    expect(kept("model")).toHaveLength(8);
    expect(kept("all", "bash pip")).toEqual(["t:0:call_09"]);
    // By its arguments, never its result: the search whose result names the site is not kept, the two fetches of it are.
    expect(kept("tool", "SANCTIONS.example")).toEqual(["t:0:call_06", "t:0:call_13"]);
    expect(kept("all", "nothing-like-this")).toEqual([]);
  });
  it("orders by start, or the longest, the dearest or the largest first, one with no such figure last", () => {
    expect(ordered(TRACE.spans, "started", TRACE_END).slice(0, 2).map((s) => s.id)).toEqual(["m:0:2", "t:0:call_01"]);
    expect(ordered(TRACE.spans, "duration", TRACE_END)[0]!.id).toBe("t:0:call_15");
    expect(ordered(TRACE.spans, "cost", TRACE_END)[0]!.id).toBe("m:0:37");
    expect(ordered(TRACE.spans, "tokens", TRACE_END)[0]!.id).toBe("m:0:40");
    // By size a request's tokens and a call's bytes are two figures: the requests first, then the calls by their result's
    // size, so the Tools filter sorts too (the 62,140-byte fetch, then the 51,600-byte script).
    const bySize = ordered(TRACE.spans, "tokens", TRACE_END);
    expect(bySize.slice(0, 8).every((s) => s.kind === "model")).toBe(true);
    expect(bySize.slice(8, 10).map((s) => s.id)).toEqual(["t:0:call_05", "t:0:call_10"]);
    expect(ordered(TRACE.spans.filter((s) => s.kind === "tool"), "tokens", TRACE_END).slice(0, 2).map((s) => s.id)).toEqual(["t:0:call_05", "t:0:call_10"]);
    // A call nothing charged has no cost: after every span that has one, in the order they started.
    const byCost = ordered(TRACE.spans, "cost", TRACE_END);
    expect(byCost.slice(-11).every((s) => s.usd === null)).toBe(true);
    expect(byCost.at(-11)!.id).toBe("t:0:call_01");
  });
});
