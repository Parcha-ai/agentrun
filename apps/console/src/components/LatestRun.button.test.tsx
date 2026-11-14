import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture, runFixture } from "@/fixtures";

// The agent workspace links historical runs alongside its shared coding-agent Run action.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

describe("the agent page's run links", () => {
  it("links each historical run from the Runs workspace alongside the coding-agent actions", async () => {
    const run = { ...runFixture("run.completed.idle.1").run, run_id: "r1" };
    const v2 = { getAgent: async () => ({ agent: agentFixture("invoice-checker"), etag: null }), statsOver: async () => ({}), listAgentRuns: async () => ({ runs: [run], next_cursor: null }) };
    const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
    await act(async () => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: "invoice-checker", go: () => {} })));
    expect(host.querySelector('a[href="#/runs/r1"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Choose coding agent for Run agent"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Agent run history"]')).not.toBeNull();
  });
});
