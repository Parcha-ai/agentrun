import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { cost, costOfCap } from "@/lib/format";
import { MANAGE_USAGE_URL } from "@/lib/chatgpt";
import type { Run } from "@/lib/v2";

// A run on a ChatGPT plan costs no dollars here: its cost says its tokens and the plan ("41.2K tokens · Using ChatGPT
// plan · Manage usage"), never "$0.00" and never "Unknown". A run that also spent dollars (a paid tool, a model on a key)
// says the dollars and "+ ChatGPT plan".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

type Cost = Run["cost"];
const ON_PLAN: Cost = { usd: 0, basis: "estimate", charge_state: null, cap_usd: null, plan: { requests: 3, tokens: 41_230 } };
const MIXED: Cost = { usd: 0.0123, basis: "estimate", charge_state: null, cap_usd: null, plan: { requests: 2, tokens: 9_000 } };
const run = (c: Cost): Run => ({ sha: null, updated_at: "2026-11-15T11:01:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "r1", agent_id: "hello", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Say hello",
  created_at: "2026-11-15T11:01:00Z", ended_at: "2026-11-15T11:02:00Z", result: null, error: null, archived_at: null, cost: c });

describe("a run's cost on a ChatGPT plan", () => {
  it("says its tokens and the plan, never $0.00 or Unknown", () => {
    expect(cost(ON_PLAN)).toBe("41.2K tokens · Using ChatGPT plan");
    expect(cost({ ...ON_PLAN, plan: { requests: 1, tokens: 812 } })).toBe("812 tokens · Using ChatGPT plan");
    expect(cost(ON_PLAN)).not.toMatch(/\$|Unknown/);
  });

  it("a mixed run says the dollars, then + ChatGPT plan", () => {
    expect(cost(MIXED)).toBe("$0.01 est. + ChatGPT plan");
    expect(cost({ ...MIXED, usd: null, so_far_usd: 0.0123, unpriced: 1 }, { ended: true })).toBe("$0.0123 est. known · 1 not priced + ChatGPT plan");
    expect(costOfCap(MIXED, 1)).toBe("$0.01 est. + ChatGPT plan · cap $1.00");
  });

  it("a run with no plan request reads as before", () => {
    expect(cost({ usd: 0.0059, basis: "estimate", charge_state: null, cap_usd: null })).toBe("$0.0059 est.");
    expect(cost({ usd: 0, basis: "estimate", charge_state: null, cap_usd: null, plan: { requests: 0, tokens: 0 } })).toBe("$0.0000 est.");
  });

  it("the run's header says it with Manage usage, to ChatGPT's settings in a new tab", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunHeader, { run: run(ON_PLAN), agentName: "Hello" })));
    const header = host.querySelector("header")!;
    expect(header.textContent).toContain("41.2K tokens · Using ChatGPT plan · Manage usage");
    expect(header.textContent).not.toMatch(/\$0\.00|Unknown/);
    const link = [...header.querySelectorAll("a")].find((a) => a.textContent === "Manage usage")!;
    expect(link.getAttribute("href")).toBe(MANAGE_USAGE_URL);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("a workflow still running on the plan says its tokens and the plan, not its graph's dollar total", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const working: Run = { ...run(ON_PLAN), kind: "workflow", status: "working", state: "working", ended_at: null };
    act(() => root!.render(createElement(RunHeader, { run: working, agentName: "Hello", costText: "$0.0000" })));
    const header = host.querySelector("header")!;
    expect(header.textContent).toContain("41.2K tokens · Using ChatGPT plan");
    expect(header.textContent).not.toContain("$0.0000");
  });
});
