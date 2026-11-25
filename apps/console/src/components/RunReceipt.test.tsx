import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { renderReceipt } from "@/components/Receipt";
import { messageFeatures } from "@/fixtures";
import type { ReceiptFacts } from "@/lib/receipt";
import type { Run, RunTrace, RunUsage } from "@/lib/v2";

// A finished run that cost $0 on free models shows its receipt on its page: the model and where it ran, its requests and
// tokens, its tool calls by tool with what each went through, its time and $0. Never on a run whose cost is unknown or
// that cost money.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const run = (cost: Run["cost"], over: Partial<Run> = {}): Run => ({ sha: null, updated_at: "2026-11-23T10:01:30Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run-free", agent_id: "field", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "WebGPU",
  created_at: "2026-11-23T10:00:00Z", ended_at: "2026-11-23T10:01:30Z", result: null, error: null, cost, archived_at: null, ...over,
});
const FREE: Run["cost"] = { usd: 0, basis: "estimate", free: true, charge_state: null, cap_usd: 0.25 };
const usage: RunUsage = {
  run_id: "run-free", ended_at: "2026-11-23T10:01:30Z", currency: "USD", total: { usd: 0 }, browser_sessions: [],
  lines: [{ meter: "tokens", model: "qwen3:8b", provider: "ollama", charged_by: null, quantity: null, unit: "token", basis: "estimate", attempt: 1, billable: false, usd: 0, requests: 6, tokens: { input: 9000, output: 700, cache_read: 0, cache_write: 0 } }],
} as unknown as RunUsage;
const trace: RunTrace = { run_id: "run-free", model_requests: "priced", dropped: 0, spans: [
  { id: "s1", kind: "tool", parent_id: null, name: "web_search", agent_label: null, started_at: "2026-11-23T10:00:01Z", ended_at: "2026-11-23T10:00:02Z", status: "ok", stop_reason: null, tokens: null, usd: null, decision: false, charged: false, not_metered: true, tool_use_id: "t1", input_preview: null, result_preview: "{\"provider\":\"exa-keyless\",\"query\":\"q\"", result_size_bytes: 10 },
] };

async function open(r: Run) {
  const reads: string[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunDetail, { run: r, agentName: "Field monitor", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report",
    freeRequests: 60, readUsage: async () => { reads.push("usage"); return usage; }, readTrace: async () => { reads.push("trace"); return trace; } })));
  await settle();
  return { host, reads, card: () => host.querySelector('section[aria-label="Receipt"]') as HTMLElement | null };
}

describe("a run's $0 receipt", () => {
  it("shows on a finished run that cost $0 on free models, from its usage and trace", async () => {
    const t = await open(run(FREE));
    const card = t.card()!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("$0.00");
    expect(card.textContent).toContain("qwen3:8b · local (Ollama)");
    expect(card.textContent).toContain("6 requests");
    expect(card.textContent).toContain("local model on your machine (Ollama)");
    expect(card.textContent).toContain("web_search");
    expect(card.textContent).toContain("exa-keyless");
    expect(t.reads).toContain("usage");
    expect(t.reads).toContain("trace");
  });

  it("never on a run whose cost is unknown", async () => {
    const t = await open(run({ usd: null, basis: "unpriced", charge_state: null, cap_usd: 0.25 }));
    expect(t.card()).toBeNull();
    expect(t.reads).not.toContain("trace");
  });

  it("never on a paid run", async () => {
    expect((await open(run({ usd: 0.0123, basis: "estimate", charge_state: null, cap_usd: 0.25 }))).card()).toBeNull();
  });

  it("never on a failed or cancelled run, though it cost $0", async () => {
    expect((await open(run(FREE, { status: "failed" }))).card()).toBeNull();
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    expect((await open(run(FREE, { status: "cancelled" }))).card()).toBeNull();
  });

  it("never while the run works", async () => {
    expect((await open(run(FREE, { status: "working", state: "working", ended_at: null }))).card()).toBeNull();
  });
});

describe("renderReceipt", () => {
  const facts: ReceiptFacts = {
    run_id: "run-free", agent_name: "Docs answerer", finished_at: "2026-11-23T10:00:42Z", wall_s: 42,
    cost: { usd: 0, basis: "known", free: true, free_reason: "free_model", free_words: "free model, up to 60 requests a run" },
    model: { id: "example/free-model:free", provider: "openrouter", local: false },
    requests: 1, tokens: { input: 1200, output: 80 },
    tools: [{ name: "web_fetch", calls: 2, via: "firecrawl-keyless" }, { name: "web_fetch", calls: 1, via: "direct" }, { name: "web_search", calls: 1 }],
  };
  it("says every fact it is given", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(renderReceipt(facts)));
    const text = host.textContent ?? "";
    for (const words of ["Docs answerer", "run-free", "openrouter/example/free-model:free", "free model, up to 60 requests a run", "1 request", "1,200 in", "80 out",
      "web_fetch", "2 calls · via firecrawl-keyless", "1 call · via direct", "web_search", "42 s", "$0.00"]) expect(text).toContain(words);
    expect(text).not.toContain("at least");
  });
  it("a trace cut at its cap: each tool's count reads as a floor, and the rows left out are said", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(renderReceipt({ ...facts, tools_uncounted: 40 })));
    const text = host.textContent ?? "";
    expect(text).toContain("at least 2 calls · via firecrawl-keyless");
    expect(text).toContain("40 more rows not read");
  });
});
