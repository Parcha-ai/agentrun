import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "./AgentPage";
import { agentFixture, editorCaps, recorded } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import type { Run } from "@/lib/v2";

// A stand-in for the Learning tab: one button that saves a newer revision through the page's `onAgent`, as its switch does.
vi.mock("@/components/Learning", () => ({
  LearningTab: ({ agent, onAgent }: { agent: Agent; onAgent?: (a: Agent) => void }) =>
    createElement("button", { onClick: () => onAgent?.({ ...agent, revision: "r2", definition: { ...agent.definition, version: 2 } } as Agent) }, "Save newer"),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const efforts = recorded<{ features: { efforts: string[] } }>("capabilities").body.features.efforts;
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("AgentPage Forget", () => {
  it("a slow read after a Forget never puts an older revision over a newer save", async () => {
    const base = agentFixture("invoice-checker");
    const saved = { ...base, sign_ins: [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: null, secret: { name: "browserbase sign-in", set: true, source: "sign-in", changed_at: "2026-11-05T08:00:00.000Z" } }] } as Agent;
    const older = { ...saved, revision: "r1", sign_ins: [] } as Agent;
    let slow!: () => void;
    let reads = 0;
    const v2 = {
      getAgent: async () => { const n = reads++; return { agent: n === 0 ? saved : n === 1 ? await new Promise<Agent>((r) => { slow = () => r(older); }) : { ...saved, revision: "r2" }, etag: null }; },
      forgetSignIn: async (_id: string, key: string) => ({ key, removed: [{ provider: "browserbase", at_vendor: "deleted" }] }),
      listAgentRuns: async () => ({ runs: [] as Run[], next_cursor: null }),
      statsOver: async () => ({}), getTimeline: async () => ({}), getRun: async () => ({}),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentPage, { v2: v2 as never, agentId: saved.agent_id, harnesses: editorCaps.harnesses, efforts, go: () => {}, tab: "learning", learning: "on" } as never)));
    await settle();
    const byText = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()))!;
    await act(async () => { byText(/^Forget/).click(); });
    await act(async () => { byText(/^Yes, forget/).click(); });
    await settle();
    // The Forget's read is still open; a newer save lands (and reads the agent itself).
    await act(async () => { byText(/^Save newer/).click(); });
    await settle();
    await act(async () => { slow(); });
    await settle();
    // The Forget's read began before the newer save: it must not replace it (the older list has no sign-ins; the newer keeps the row).
    expect(host.querySelector('section[aria-label="Sign-ins"]')).toBeTruthy();
  });
});
