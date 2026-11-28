import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFactoryPage } from "./AgentFactoryPage";
import { Shell } from "./Shell";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import type { FactoryRunPage, Run } from "@/lib/v2";
import running from "../fixtures/run.working.working.1.json";
import waitingRun from "../fixtures/run.input_required.waiting.1.json";
import waitingTimeline from "../fixtures/run.input_required.waiting.1.timeline.json";
import { messageFeatures } from "@/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); localStorage.clear(); });
const at = "2026-11-21T10:00:00Z";
const makeRun = (id: string): Run => ({ ...running.body, run_id: id, title: `Task ${id}`, factory: {
  lifecycle_version: "10", source: "managed", runtime: "pi", control: "managed", controls: { stop: false, cancel: true, approve: false },
  observation: { basis: "runner", status: "current", last_seen_at: at }, last_activity_at: at, github: null, children: [],
} } as Run);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
function host() { const el = document.body.appendChild(document.createElement("div")); root = createRoot(el); return el; }
const agentName = () => "Implementation agent";

describe("Agent Factory page", () => {
  it("is a first-class console destination with navigation to its route", () => {
    expect(route("#/factory")).toEqual({ section: "factory", factory: { repository: "all", control: "all" } });
    // Its query names the session open beside the board and the board's filters; what it does not know is the default.
    expect(route("#/factory?session=run%2F1&repo=acme%2Fconsole&control=observed")).toEqual({ section: "factory", factory: { session: "run/1", repository: "repo:acme/console", control: "control:Observed" } });
    expect(route("#/factory?repo=unreported&control=everyone")).toEqual({ section: "factory", factory: { repository: "unreported", control: "all" } });
    // Only the board's own address: a longer one is not the factory's.
    expect(route("#/factoryfloor").section).not.toBe("factory");
    const el = host(); const navigate = vi.fn();
    act(() => root!.render(createElement(Shell, { active: "factory", onNavigate: navigate, children: "board" })));
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Agent Factory")!;
    act(() => button.click());
    expect(navigate).toHaveBeenCalledWith("factory");
  });

  it("reads scoped pages, follows their cursor and keeps ended review out of active counts", async () => {
    const urls: string[] = [];
    const v2 = createClient({ fetch: (async (url) => {
      urls.push(String(url));const q = new URL(String(url), "https://serve.example").searchParams;
      const scope = q.get("scope");
      if (scope === "review") return json({ scope, observed_at: at, runs: [{ ...makeRun("ended"), status: "completed", ended_at: "2026-11-21T10:00:00Z", review: { kind: null, node: null, reason: "Inspect result", at } }], next_cursor: null });
      return json({ scope, observed_at: at, runs: [makeRun(q.has("cursor") ? "older-active" : "new-active")], next_cursor: q.has("cursor") ? null : "after" });
    }) as typeof fetch });
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    expect(urls).toContain("/v2/runs?scope=active&limit=50&cursor=after");
    expect(el.querySelector('[aria-label="Loaded active session totals"]')?.textContent).toContain("2 active sessions loaded");
    expect(el.textContent).toContain("Task older-active");
    expect(el.querySelector('[aria-label="Ended runs needing attention"]')?.textContent).toContain("Inspect result");
  });

  it("keeps the picked view in this browser: List is still List on the next visit", async () => {
    const v2 = createClient({ fetch: (async (url) => {
      const scope = new URL(String(url), "https://serve.example").searchParams.get("scope");
      return json({ scope, observed_at: at, runs: scope === "active" ? [makeRun("kept")] : [], next_cursor: null });
    }) as typeof fetch });
    const list = 'table[aria-label="Active agent sessions"]';
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    expect(el.querySelectorAll("[data-factory-lane]")).toHaveLength(4);
    expect(el.querySelector(list)).toBeNull();
    await act(async () => el.querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="View"] input[value="list"]')!.click());
    expect(el.querySelector(list)?.textContent).toContain("Task kept");
    expect(el.querySelectorAll("[data-factory-lane]")).toHaveLength(0);
    // The page is left and opened again: the view is the one picked, not the default.
    act(() => root!.unmount()); document.body.innerHTML = "";
    const again = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    expect(again.querySelector(list)?.textContent).toContain("Task kept");
    expect(again.querySelector<HTMLInputElement>('[aria-label="View"] input[value="list"]')!.checked).toBe(true);
  });

  it("retains last-known cards on a failed refresh and labels the counts stale", async () => {
    let fail = false;
    const v2 = createClient({ fetch: (async (url) => {
      const scope = new URL(String(url), "https://serve.example").searchParams.get("scope");
      if (fail) return json({ error: { code: "unavailable", message: "Store temporarily unavailable", retryable: true } }, 503);
      return json({ scope, observed_at: at, runs: scope === "active" ? [makeRun("held")] : [], next_cursor: null });
    }) as typeof fetch });
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    fail = true;
    const refresh = el.querySelector<HTMLButtonElement>('button[aria-label="Refresh Agent Factory"]')!;
    await act(async () => refresh.click());await settle();
    expect(el.textContent).toContain("Task held");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("counts may be stale");
    expect(el.textContent).toContain("Store temporarily unavailable");
  });

  it("does not drop a transitioning session when active succeeds but ended attention fails", async () => {
    let transition = false;
    const v2 = createClient({ fetch: (async (url) => {
      const scope = new URL(String(url), "https://serve.example").searchParams.get("scope");
      if (transition && scope === "review") return json({ error: { code: "unavailable", message: "Attention unavailable", retryable: true } }, 503);
      return json({ scope, observed_at: at, runs: scope === "active" && !transition ? [makeRun("moving")] : [], next_cursor: null });
    }) as typeof fetch });
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName })));await settle();
    transition = true;
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Refresh Agent Factory"]')!.click());await settle();
    expect(el.textContent).toContain("Task moving");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("counts may be stale");
  });

  it("ignores an old client's late answer after the page changes client", async () => {
    const pending: ((page: FactoryRunPage) => void)[] = [];
    const old = { listFactoryRuns: vi.fn((_scope: "active" | "review", _cursor?: string | null, _signal?: AbortSignal) => new Promise<FactoryRunPage>((r) => { pending.push(r); })) };
    const fresh = { listFactoryRuns: vi.fn(async (scope: "active" | "review") => ({ scope, observed_at: at, runs: scope === "active" ? [makeRun("fresh")] : [], next_cursor: null } as FactoryRunPage)) };
    const el = host();await act(async () => root!.render(createElement(AgentFactoryPage, { v2: old as never, agentName })));
    await act(async () => root!.render(createElement(AgentFactoryPage, { v2: fresh as never, agentName })));await settle();
    await act(async () => { pending[0]({ scope: "active", observed_at: at, runs: [makeRun("late")], next_cursor: null } as FactoryRunPage); pending[1]({ scope: "review", observed_at: at, runs: [], next_cursor: null } as FactoryRunPage); });
    expect(el.textContent).toContain("Task fresh");expect(el.textContent).not.toContain("Task late");
    expect(old.listFactoryRuns.mock.calls[0]?.[2]?.aborted).toBe(true);
  });

  // The session panel: the address names the open session and the filters, the page draws the run beside the board,
  // and what is done there is read back onto the board at once.
  describe("with a session open beside the board", () => {
    // A recorded run that waits on its question, as the board's projection would carry it.
    const asking = (id: string): Run => ({ ...waitingRun.body, run_id: id, title: `Task ${id}`, factory: makeRun(id).factory, pending: { kind: "question", question: "Which currency?", asked_at: at } } as unknown as Run);
    function server() {
      const runs = [asking("asks"), makeRun("works")];
      const listFactoryRuns = vi.fn(async (scope: "active" | "review") => ({ scope, observed_at: at, runs: scope === "active" ? runs : [], next_cursor: null } as FactoryRunPage));
      const sendMessage = vi.fn(async () => ({}));
      const v2 = {
        listFactoryRuns, sendMessage,
        getRun: async (id: string) => runs.find((run) => run.run_id === id)!, listFiles: async (id: string) => ({ run_id: id, files: [], complete: true, truncated: false }),
        getTimeline: async (id: string) => ({ ...waitingTimeline.body, run_id: id, final: true, has_more: false }),
        listRevisions: async () => ({ revisions: [], next_cursor: null }), harnesses: async () => ({ harnesses: [{ id: "pi", available: true, steer: true }] }),
      };
      return { v2: v2 as never, listFactoryRuns, sendMessage };
    }
    const many = async () => { for (let i = 0; i < 12; i++) await settle(); };
    const link = (el: HTMLElement, href: string) => [...el.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.getAttribute("href") === href);

    it("draws the run the address names over the board, marks its card, and keeps the filters in every link it writes", async () => {
      const { v2 } = server(); const go = vi.fn(); const el = host();
      await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName, go, place: { repository: "all", control: "control:Managed", session: "asks" } })));
      await many();
      const panel = el.querySelector<HTMLElement>('aside[aria-label="Session"]')!;
      expect(panel.getAttribute("data-factory-session")).toBe("asks");
      expect(panel.textContent).toContain("Implementation agent · run asks");
      expect(panel.querySelector("h2")?.textContent).toBe("Task asks");
      // The board is whole under it, and only the open session's card says it is the one open.
      expect(el.querySelectorAll("[data-factory-pane] article")).toHaveLength(2);
      expect([...el.querySelectorAll('[aria-current="true"]')].map((card) => card.querySelector("h3")?.textContent)).toEqual(["Implementation agentTask asks"]);
      // Another card opens in the same panel under the same filter; the waiting one names its next step.
      expect(link(el, "#/factory?session=works&control=managed")).toBeTruthy();
      expect(link(el, "#/factory?session=asks&control=managed")?.closest("article")?.querySelector("[data-factory-action]")?.textContent).toBe("Answer");
      // Closing keeps the filter and drops the session; a filter change keeps the session.
      act(() => panel.querySelector<HTMLButtonElement>('button[aria-label="Close session"]')!.click());
      expect(go).toHaveBeenLastCalledWith("#/factory?control=managed");
      act(() => [...el.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!.click());
      expect(go).toHaveBeenLastCalledWith("#/factory?session=asks");
    });

    it("gives the keyboard back to the session's own link when its panel closes", async () => {
      const { v2 } = server(); const el = host();
      const open = { repository: "all", control: "all", session: "works" };
      await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName, go: vi.fn(), place: open })));
      await many();
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Close session");
      await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName, go: vi.fn(), place: { repository: "all", control: "all" } })));
      await many();
      expect(el.querySelector('aside[aria-label="Session"]')).toBeNull();
      expect(document.activeElement).toBe(link(el, "#/factory?session=works"));
    });

    it("gives the keyboard to the board's view switch when the closed session's card has left the board", async () => {
      const { v2, listFactoryRuns } = server(); const el = host();
      // The run still reads, and its panel is open, but the board no longer lists it (it ended while the panel was open).
      listFactoryRuns.mockImplementation(async (scope: "active" | "review") => ({ scope, observed_at: at, runs: scope === "active" ? [asking("asks")] : [], next_cursor: null } as FactoryRunPage));
      await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName, go: vi.fn(), place: { repository: "all", control: "all", session: "works" } })));
      await many();
      expect(link(el, "#/factory?session=works")).toBeUndefined();
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Close session");
      await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName, go: vi.fn(), place: { repository: "all", control: "all" } })));
      await many();
      expect(el.querySelector('aside[aria-label="Session"]')).toBeNull();
      // Never the page's body, where the next Tab would start from the top of the page.
      const view = el.querySelector<HTMLInputElement>('input[name="factory-view"]:checked')!;
      expect(view).toBeTruthy();
      expect(document.activeElement).toBe(view);
    });

    it("reads the board again as soon as an answer sent from the panel is read back, not at its next 10 seconds", async () => {
      const { v2, listFactoryRuns, sendMessage } = server(); const el = host();
      await act(async () => root!.render(createElement(AgentFactoryPage, { v2, agentName, go: vi.fn(), place: { repository: "all", control: "all", session: "asks" }, caps: { features: { messages: messageFeatures }, harnesses: [{ id: "pi", available: true, steer: true }] } })));
      await many();
      const field = el.querySelector<HTMLTextAreaElement>('aside[aria-label="Session"] textarea')!;
      const before = listFactoryRuns.mock.calls.length;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "USD"); field.dispatchEvent(new Event("input", { bubbles: true })); });
      await act(async () => { field.closest("form")!.requestSubmit(); });
      await many();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      // Both scopes, read once more, well inside the board's 10 seconds.
      expect(listFactoryRuns.mock.calls.length).toBe(before + 2);
    });
  });
});

