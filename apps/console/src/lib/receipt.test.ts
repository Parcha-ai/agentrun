import { describe, expect, it } from "vitest";
import { receiptFacts, showsReceipt } from "./receipt";
import type { Run, RunTrace, RunUsage } from "./v2";

// A finished run's $0 receipt, made from the three reads the run page already has: the run (its cost and times), its
// usage (the model it ran on and its requests and tokens) and its trace (its tool calls, with what each went through).

const cost = (over: Partial<Run["cost"]>): Run["cost"] => ({ usd: 0, basis: "estimate", free: true, ...over });
const run = (over: Partial<Run> = {}): Run => ({
  run_id: "run_free_1", agent_id: "agent_1", status: "completed", created_at: "2026-11-23T10:00:00.000Z",
  ended_at: "2026-11-23T10:01:30.500Z", cost: cost({}), ...over,
} as Run);

const line = (over: Partial<NonNullable<RunUsage["lines"]>[number]>): NonNullable<RunUsage["lines"]>[number] => ({
  meter: "tokens", model: "qwen3:8b", provider: "ollama", charged_by: null, quantity: null, unit: "token", basis: "estimate",
  attempt: 1, billable: false, usd: 0, requests: 1, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ...over,
});
const usage: RunUsage = {
  run_id: "run_free_1", ended_at: "2026-11-23T10:01:30.500Z", currency: "USD", total: { usd: 0 }, browser_sessions: [],
  lines: [
    line({ requests: 5, tokens: { input: 12000, output: 900, cache_read: 0, cache_write: 0 } }),
    // A second attempt's line of the same model, summed with the first.
    line({ attempt: 2, requests: 2, tokens: { input: 3000, output: 100, cache_read: 0, cache_write: 0 } }),
    line({ meter: "tools", model: null, provider: null, unit: "call", quantity: 4, requests: undefined, tokens: undefined }),
  ],
} as unknown as RunUsage;

const span = (over: Partial<RunTrace["spans"][number]>): RunTrace["spans"][number] => ({
  id: "s", kind: "tool", parent_id: null, name: "web_fetch", agent_label: null, started_at: "2026-11-23T10:00:01.000Z",
  ended_at: "2026-11-23T10:00:02.000Z", status: "ok", stop_reason: null, tokens: null, usd: null, decision: false, charged: false,
  not_metered: true, tool_use_id: "t", input_preview: null, result_preview: null, result_size_bytes: null, ...over,
});
const trace: RunTrace = {
  run_id: "run_free_1", model_requests: "priced", dropped: 0,
  spans: [
    span({ id: "m1", kind: "model", name: "qwen3:8b", tool_use_id: null }),
    span({ id: "s1", name: "web_search", result_preview: "{\"provider\":\"exa-keyless\",\"query\":\"postgres 18 release\",\"results\":[{\"url\":\"https://example.org/a\"" }),
    span({ id: "s2", name: "web_fetch", result_preview: "{\"ok\":true,\"url\":\"https://example.org/a\",\"status\":200,\"title\":\"A\",\"text\":\"short\",\"links\":[],\"via\":\"firecrawl-keyless\"}" }),
    span({ id: "s3", name: "web_fetch", result_preview: "{\"ok\":true,\"url\":\"https://example.org/b\",\"status\":200,\"title\":\"B\",\"text\":\"a page whose head is cut before" }),
    span({ id: "s4", name: "web_fetch", result_preview: "{\"ok\":true,\"url\":\"https://example.org/c\",\"status\":200,\"title\":\"C\",\"text\":\"\",\"links\":[],\"via\":\"direct\"}" }),
  ],
};

describe("receiptFacts", () => {
  it("reads the run, its usage and its trace into the receipt's facts", () => {
    expect(receiptFacts(run(), "Field monitor", usage, trace, 60)).toEqual({
      run_id: "run_free_1", agent_name: "Field monitor", finished_at: "2026-11-23T10:01:30.500Z", wall_s: 90.5,
      cost: { usd: 0, basis: "known", free: true, free_reason: "local", free_words: "local model (Ollama)" },
      model: { id: "qwen3:8b", provider: "ollama", local: true },
      requests: 7, tokens: { input: 15000, output: 1000 },
      // One entry per tool and what its calls went through; a call whose result head does not say has no via.
      tools: [{ name: "web_search", calls: 1, via: "exa-keyless" }, { name: "web_fetch", calls: 1, via: "firecrawl-keyless" }, { name: "web_fetch", calls: 1 }, { name: "web_fetch", calls: 1, via: "direct" }],
    });
  });

  // cost.free speaks of model requests alone; the usage says what else the run used, and a receipt is shared.
  it("none where the usage total is not exactly $0: browser time no charge was booked for, or no total read", () => {
    expect(receiptFacts(run(), "A", { ...usage, total: { usd: null } }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, total: null }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, total: { usd: 0.42 } }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, total: { usd: 0, unpriced: 1 } }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", undefined, trace)).toBeNull();
  });
  it("none where a line has no figure: computer time no price was set for (basis unpriced, usd null)", () => {
    const compute = line({ meter: "compute_time", model: null, provider: "daytona", unit: "vcpu_second", quantity: 90, basis: "unpriced", usd: null, billable: true, requests: undefined, tokens: undefined, resource: "vcpu" });
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, compute] }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, { ...compute, basis: "estimate" }] }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, { ...compute, basis: "unpriced", usd: 0 }] }, trace)).toBeNull();
  });
  it("none where compute time is left unheld by any price (unheld_quantity), even at a $0 line", () => {
    const compute = line({ meter: "compute_time", model: null, provider: "e2b", unit: "vcpu_second", quantity: 90, usd: 0, requests: undefined, tokens: undefined, unheld_quantity: 90 });
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, compute] }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, { ...compute, unheld_quantity: 0 }] }, trace)).not.toBeNull();
  });
  it("none where MCP calls no price meters ran (not_metered_calls), or model requests none metered", () => {
    const tools = line({ meter: "tools", model: null, provider: null, unit: "call", quantity: 3, requests: undefined, tokens: undefined, not_metered_calls: 3 });
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, tools] }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, line({ unmetered_requests: 1 })] }, trace)).toBeNull();
  });
  it("none where browser time cost anything, or any line above $0", () => {
    const browser = line({ meter: "browser_time", model: null, provider: "browserbase", unit: "second", quantity: 60, usd: 0.02, billable: true, requests: undefined, tokens: undefined });
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, browser] }, trace)).toBeNull();
    expect(receiptFacts(run(), "A", { ...usage, lines: [...usage.lines!, { ...browser, usd: null }] }, trace)).toBeNull();
  });

  it("a trace cut at its cap: the rows it left out ride along, so the tool counts read as a floor", () => {
    expect(receiptFacts(run(), "A", usage, { ...trace, dropped: 12 })?.tools_uncounted).toBe(12);
    expect(receiptFacts(run(), "A", usage, trace)).not.toHaveProperty("tools_uncounted");
  });
  it("a free catalog model: not local, its words with the run's request limit", () => {
    const facts = receiptFacts(run(), "A", { total: { usd: 0 }, lines: [line({ provider: "openrouter", model: "example/free-model:free", requests: 3 })] }, undefined, 60);
    expect(facts).toMatchObject({ model: { id: "example/free-model:free", provider: "openrouter", local: false }, requests: 3, tools: [],
      cost: { free_reason: "free_model", free_words: "free model, up to 60 requests a run" } });
    expect(receiptFacts(run(), "A", { total: { usd: 0 }, lines: [line({ provider: "openrouter", model: "example/free-model:free" })] }, undefined)?.cost.free_words).toBe("free model");
  });

  it("local and catalog requests in one run: both", () => {
    const facts = receiptFacts(run(), "A", { total: { usd: 0 }, lines: [line({ requests: 4 }), line({ provider: "openrouter", model: "example/free-model:free", requests: 1 })] }, undefined, 20);
    expect(facts?.model).toEqual({ id: "qwen3:8b", provider: "ollama", local: true });
    expect(facts?.cost).toMatchObject({ free_reason: "local_and_free_model", free_words: "local model (Ollama) and free model, up to 20 requests a run" });
  });

  it("is null for a run with no receipt, and for one whose usage names no model", () => {
    expect(receiptFacts(run({ cost: cost({ usd: null, free: undefined }) }), "A", usage, trace)).toBeNull();
    expect(receiptFacts(run({ cost: cost({ usd: 0.0123, free: undefined }) }), "A", usage, trace)).toBeNull();
    expect(receiptFacts(run({ status: "working", ended_at: null }), "A", usage, trace)).toBeNull();
    expect(receiptFacts(run(), "A", undefined, trace)).toBeNull();
  });
});

describe("showsReceipt", () => {
  it("shows for a completed run that cost $0 on free models", () => {
    expect(showsReceipt(run())).toBe(true);
  });
  it("never for a failed or cancelled run, though it cost $0: a receipt is shared, and only a completed run's is", () => {
    expect(showsReceipt(run({ status: "failed" }))).toBe(false);
    expect(showsReceipt(run({ status: "cancelled" }))).toBe(false);
    expect(receiptFacts(run({ status: "failed" }), "A", usage, trace)).toBeNull();
  });
  it("never for a run whose cost is unknown", () => {
    expect(showsReceipt(run({ cost: cost({ usd: null, free: undefined }) }))).toBe(false);
    expect(showsReceipt(run({ cost: cost({ usd: null }) }))).toBe(false);
  });
  it("never for a paid run, or a $0 one that the server does not call free", () => {
    expect(showsReceipt(run({ cost: cost({ usd: 0.0123, free: undefined }) }))).toBe(false);
    expect(showsReceipt(run({ cost: cost({ usd: 0, free: undefined }) }))).toBe(false);
  });
  it("never before the run ends", () => {
    expect(showsReceipt(run({ status: "working", ended_at: null }))).toBe(false);
    expect(showsReceipt(run({ status: "input_required", ended_at: null }))).toBe(false);
  });
});
