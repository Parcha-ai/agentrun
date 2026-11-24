import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Run, RunUsage } from "@/lib/v2";

// A run names its model in its header, read from what the server booked (GET /v2/runs/{id}/usage, its `tokens` lines),
// so a run on the host's default model, which its definition does not name, says which one it ran on, in the words
// modelLabel gives it everywhere else.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const run = (requests: number, extra: Partial<Run> = {}): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "01a1a869-ce4e-7cf5-abf8-c5407893934a", agent_id: "notes", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Write release notes.",
  created_at: "2026-11-04T21:14:00Z", ended_at: "2026-11-04T21:14:03Z", result: null, error: null, archived_at: null,
  cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: 0.25, free: true, tokens: { input: 12, output: 3, cache_read: 0, cache_write: 0, requests, unmetered: 0 } },
  ...extra,
} as Run);
const tokens = (model: string, provider: string | null, requests: number) => ({ meter: "tokens", model, provider, charged_by: null, quantity: 15, unit: "token", basis: "estimate", attempt: 1, billable: true, usd: 0, requests, tokens: { input: 12, output: 3, cache_read: 0, cache_write: 0 } });
const usage = (...lines: ReturnType<typeof tokens>[]): RunUsage => ({ run_id: "r", ended_at: null, currency: "USD", total: { usd: 0 }, lines, browser_sessions: [], computer_intervals: [], infra_usd: 0, reason: null } as unknown as RunUsage);

async function header(props: { run: Run; readUsage?: () => Promise<RunUsage> }) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(RunHeader, { agentName: "Release notes", ...props })));
  await settle();
  return host;
}

describe("the run header's model", () => {
  it("names the model a run on the host default ran on: an Ollama model reads its tag and local (Ollama)", async () => {
    const readUsage = vi.fn(async () => usage(tokens("qwen3:8b", "ollama", 3)));
    const host = await header({ run: run(3), readUsage });
    const model = host.querySelector("[data-run-model]");
    expect(model?.textContent).toBe("qwen3:8b · local (Ollama)");
    expect(model?.getAttribute("title")).toBe("ollama/qwen3:8b");
  });
  it("reads once per request count, however often the page renders it with a new reader", async () => {
    const readUsage = vi.fn(async () => usage(tokens("qwen3:8b", "ollama", 1)));
    await header({ run: run(1), readUsage: () => readUsage() });
    act(() => root!.render(createElement(RunHeader, { agentName: "Release notes", run: run(1), readUsage: () => readUsage() })));
    await settle();
    expect(readUsage).toHaveBeenCalledTimes(1);
    act(() => root!.render(createElement(RunHeader, { agentName: "Release notes", run: run(2), readUsage: () => readUsage() })));
    await settle();
    expect(readUsage).toHaveBeenCalledTimes(2);
  });
  it("takes the model most of its requests went to, a side call's aside; behind a gateway, the id as booked", async () => {
    const host = await header({ run: run(5), readUsage: async () => usage(tokens("claude-haiku-5-5", "anthropic", 1), tokens("claude-sonnet-5-5", "anthropic", 4)) });
    expect(host.querySelector("[data-run-model]")?.textContent).toBe("anthropic/claude-sonnet-5-5");
    act(() => root?.unmount());
    const gateway = await header({ run: run(2), readUsage: async () => usage(tokens("gpt-6-luna", null, 2)) });
    expect(gateway.querySelector("[data-run-model]")?.textContent).toBe("gpt-6-luna");
  });
  it("reads again when the run ends: a read while it works can find no lines yet, and the end brings no new request", async () => {
    const working = { status: "working", state: "working", ended_at: null } as Partial<Run>;
    const readUsage = vi.fn(async () => ({ ...usage(), lines: null }) as unknown as RunUsage);
    const host = await header({ run: run(3, working), readUsage });
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-run-model]")).toBeNull();
    readUsage.mockImplementation(async () => usage(tokens("qwen3:8b", "ollama", 3)));
    act(() => root!.render(createElement(RunHeader, { agentName: "Release notes", run: run(3), readUsage })));
    await settle();
    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-run-model]")?.textContent).toBe("qwen3:8b · local (Ollama)");
  });
  it("sums a model's requests across its lines (one per attempt) before it takes the most", async () => {
    const host = await header({ run: run(9), readUsage: async () => usage(tokens("qwen3:8b", "ollama", 2), tokens("qwen3:8b", "ollama", 2), tokens("qwen3:0.6b", "ollama", 3), tokens("qwen3:8b", "ollama", 2)) });
    expect(host.querySelector("[data-run-model]")?.textContent).toBe("qwen3:8b · local (Ollama)");
  });
  it("asks nothing before the run's first request, and nothing of a workflow run", async () => {
    const readUsage = vi.fn(async () => usage(tokens("qwen3:8b", "ollama", 1)));
    const host = await header({ run: run(0, { status: "working", state: "working", ended_at: null } as Partial<Run>), readUsage });
    expect(readUsage).not.toHaveBeenCalled();
    expect(host.querySelector("[data-run-model]")).toBeNull();
    act(() => root?.unmount());
    await header({ run: run(4, { kind: "workflow" } as Partial<Run>), readUsage });
    expect(readUsage).not.toHaveBeenCalled();
  });
});
