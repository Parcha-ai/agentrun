import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFactoryBoard, type AgentFactoryBoardProps, type FactoryCard } from "./AgentFactoryBoard";
import { pageTitleClass, pageToolbarClass } from "@/components/ui";
import { optionsOf, pick, picker } from "@/test/picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-11-22T09:30:00.000Z";
const card = (id: string, lane: FactoryCard["lane"], over: Partial<FactoryCard> = {}): FactoryCard => ({
  id, runId: id, ref: id, agentName: "Builder", title: `Work for ${id}`, lane,
  stateLabel: lane, sourceLabel: "Codex", controlLabel: "Managed", repo: "example/console",
  githubLinks: [], activityAt: AT, reason: null, costLabel: "Cost not reported", ...over,
});
const active = [
  card("run/worker", "working", { title: "Reviewing verification code", costLabel: "$1.20 recorded", githubLinks: [{ label: "PR #8", url: "https://github.com/example/console/pull/8" }] }),
  card("waiting", "waiting", { reason: "Waiting for a child", parentLabel: "Coordinator · root-run" }),
  card("approval", "attention", { stateLabel: "Approval requested", reason: "Tool permission required" }),
  card("native", "unknown", { controlLabel: "Observed", sourceLabel: "Native Codex", repo: null, activityAt: null, reason: "Current activity unavailable" }),
];
const review = [card("ended", "attention", { agentName: "Reviewer", repo: "example/api", stateLabel: "Needs review", reason: "Run ended with an uncertain outcome" })];
const defaults = (): AgentFactoryBoardProps => ({ cards: active, review, loading: false, refreshing: false, error: null, updatedAt: AT, hasMore: false, onLoadMore: vi.fn(), onRefresh: vi.fn() });
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

function mount(over: Partial<AgentFactoryBoardProps> = {}) {
  let props = { ...defaults(), ...over };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = (next: Partial<AgentFactoryBoardProps> = {}) => { props = { ...props, ...next }; act(() => root!.render(createElement(AgentFactoryBoard, props))); };
  render();
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const lane = (name: string) => host.querySelector(`[data-factory-lane="${name}"]`)!;
  /** The top bar's Refresh: an icon, named for a screen reader. */
  const refresh = () => host.querySelector<HTMLButtonElement>('header button[aria-label="Refresh Agent Factory"]')!;
  return { host, props, render, button, lane, refresh };
}

describe("Agent Factory board", () => {
  it("frames the page as the console's other pages do: its name in the top bar after its icon, and Refresh as the bar's action", () => {
    const { host, refresh } = mount();
    const bar = host.querySelector("header")!;
    for (const name of pageToolbarClass.split(" ")) expect(bar.classList.contains(name), name).toBe(true);
    const title = bar.querySelector("h1")!;
    expect(title.textContent).toBe("Agent Factory");
    for (const name of pageTitleClass.split(" ")) expect(title.classList.contains(name), name).toBe(true);
    expect(title.querySelector("svg[aria-hidden]")).not.toBeNull();
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(bar.contains(refresh())).toBe(true);
    expect(refresh().textContent).toBe("");
    // No sentence under the bar: the totals are the page's first line, as a list is on the other pages.
    expect(host.textContent).not.toContain("Sessions reported to this AgentRun server");
    expect(host.querySelector("header + div")?.firstElementChild?.getAttribute("aria-label")).toBe("Loaded active session totals");
  });

  it("shows every supplied active session in its reported lane and keeps terminal review separate", () => {
    const { host, lane } = mount();
    expect(host.querySelector('[aria-label="Loaded active session totals"]')?.textContent).toContain("4 active sessions loaded");
    for (const name of ["waiting", "working", "attention", "unknown"]) expect(lane(name).querySelectorAll("article")).toHaveLength(1);
    // A task mentioning verification does not manufacture a Checking state.
    expect(lane("working").textContent).toContain("Reviewing verification code");
    expect(host.querySelector('[data-factory-lane="checking"]')).toBeNull();
    const ended = host.querySelector('[aria-label="Ended runs needing attention"]')!;
    expect(ended.querySelectorAll("article")).toHaveLength(1);
    expect(ended.textContent).toContain("Excluded from active session totals");
    expect(lane("attention").textContent).not.toContain("uncertain outcome");
    expect(lane("unknown").textContent).toContain("Repository not reported");
    expect(lane("unknown").textContent).toContain("Activity time not reported");
    expect(lane("unknown").textContent).toContain("Cost not reported");
    expect(lane("waiting").textContent).toContain("Coordinator · root-run");
  });

  it("opens the existing run route and keeps GitHub navigation outside it", () => {
    const { host, lane } = mount();
    const article = lane("working").querySelector("article")!;
    const run = article.querySelector('a[href="#/runs/run%2Fworker"]')!;
    expect(run.textContent).toContain("Builder");
    expect(article.textContent).toContain("run/worker");
    const github = article.querySelector('a[href="https://github.com/example/console/pull/8"]')!;
    expect(run.contains(github)).toBe(false);
    expect(github.getAttribute("rel")).toContain("noopener");
    expect(host.querySelector("a a, button a")).toBeNull();
  });

  it("distinguishes child sessions even when their existing detail route belongs to the same parent run", () => {
    const { lane } = mount({ cards: [
      card("child-a", "working", { runId: "parent/run", parentLabel: "parent/run" }),
      card("child-b", "working", { runId: "parent/run", parentLabel: "parent/run" }),
    ], review: [] });
    const children = [...lane("working").querySelectorAll("article")];
    expect(children).toHaveLength(2);
    expect(children[0].textContent).toContain("child-a");
    expect(children[1].textContent).toContain("child-b");
    for (const child of children) expect(child.querySelector('a[href="#/runs/parent%2Frun"]')).not.toBeNull();
  });

  it("names a session by its short label and writes its repository once; the loaded sessions are counted once until a filter narrows them", async () => {
    const whole = "01a20ee0-b5a2-7000-b6d1-1ed9964844d8";
    const { host, lane } = mount({ cards: [card(whole, "working", { ref: "run 964844d8", title: "Review the change", githubLinks: [
      { label: "example/console", url: "https://github.com/example/console" }, { label: "PR #8", url: "https://github.com/example/console/pull/8" },
    ] })], review: [] });
    const article = lane("working").querySelector("article")!;
    expect(article.textContent).toContain("run 964844d8");
    expect(article.textContent).not.toContain(whole);
    expect(article.querySelector(`a[href="#/runs/${whole}"]`)).not.toBeNull();
    expect(article.textContent!.split("example/console")).toHaveLength(2);
    // No filter: the totals say it once, and no second line repeats them.
    expect(host.querySelector('[aria-label="Matching sessions"]')).toBeNull();
    expect(host.textContent).not.toContain("with unknown activity");
    await pick(picker(host, "Repository")!, "repo:example/console");
    // The filter's result is said in the filters' own row, just left of the button that clears them, and not among the totals.
    const clear = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!;
    const match = host.querySelector('[aria-label="Matching sessions"]')!;
    expect(match.textContent).toBe("1 of 1 loaded active sessions match");
    expect(clear.previousElementSibling?.contains(match)).toBe(true);
    expect(host.querySelector('[aria-label="Loaded active session totals"] [aria-label="Matching sessions"]')).toBeNull();
  });

  it("filters both active and ended runs without changing the explicitly loaded totals", async () => {
    const { host, lane } = mount();
    await pick(picker(host, "Repository")!, "unreported");
    expect(host.querySelector('[aria-label="Matching sessions"]')?.textContent).toContain("1 of 4 loaded active sessions");
    expect(host.querySelector('[aria-label="Loaded active session totals"]')?.textContent).toContain("4 active sessions loaded");
    expect(lane("unknown").querySelectorAll("article")).toHaveLength(1);
    expect(lane("working").querySelectorAll("article")).toHaveLength(0);
    expect(host.querySelector('[aria-label="Ended runs needing attention"]')?.textContent).toContain("0 of 1 loaded ended runs");
    await pick(picker(host, "Control")!, "control:Managed");
    expect(host.querySelector('[aria-label="Matching sessions"]')?.textContent).toContain("0 of 4 loaded active sessions");
    expect(host.textContent).toContain("No loaded sessions match these filters");
    expect(host.textContent).not.toContain("No active sessions reported");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!.click(); });
    expect(host.querySelectorAll("article")).toHaveLength(5);
  });

  it("retains a selected repository when a refresh removes its last session", async () => {
    const { host, render } = mount();
    await pick(picker(host, "Repository")!, "repo:example/api");
    render({ review: [] });
    expect(picker(host, "Repository")?.textContent).toContain("example/api");
    expect(host.textContent).toContain("No loaded sessions match these filters");
    expect((await optionsOf(picker(host, "Repository")!)).some((o) => o.value === "repo:example/api")).toBe(true);
  });

  it("marks partial coverage and offers further reads without implying the loaded set is complete", async () => {
    const { host, props, button, render, refresh } = mount({ hasMore: true });
    expect(host.textContent).toContain("Partial coverage");
    expect(host.textContent).toContain("More sessions may be available");
    expect(host.textContent).not.toContain("All active agents");
    await act(async () => { button("Load more").click(); refresh().click(); });
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    render({ refreshing: true });
    expect(refresh().disabled).toBe(true);
    expect(refresh().getAttribute("aria-busy")).toBe("true");
    expect(button("Load more").disabled).toBe(true);
    expect(host.querySelectorAll("article")).toHaveLength(5);
  });

  it("preserves last known cards and labels their staleness when a read fails", async () => {
    const { host, props, render, button } = mount({ error: "The server is unavailable" });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The server is unavailable");
    expect(host.textContent).toContain("Showing last known sessions; counts may be stale");
    expect(host.querySelectorAll("article")).toHaveLength(5);
    expect(host.querySelector('time[dateTime="2026-11-22T09:30:00.000Z"]')).not.toBeNull();
    await act(async () => { button("Try again").click(); });
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    render({ refreshing: true });
    expect(button("Try again").disabled).toBe(true);
  });

  it("distinguishes first load, failed first load, empty, and review-only results", () => {
    const { host, render } = mount({ cards: [], review: [], loading: true, updatedAt: null });
    expect(host.textContent).toContain("Loading agent sessions");
    expect(host.textContent).not.toContain("0 active sessions loaded");
    expect(host.textContent).not.toContain("No active sessions reported");
    render({ loading: false, error: "Connection failed" });
    expect(host.textContent).toContain("Could not load Agent Factory");
    expect(host.textContent).not.toContain("No active sessions reported");
    render({ error: null, updatedAt: AT });
    expect(host.textContent).toContain("No active sessions reported");
    render({ review });
    expect(host.querySelector('[aria-label="Loaded active session totals"]')?.textContent).toContain("0 active sessions loaded");
    expect(host.querySelector('[aria-label="Ended runs needing attention"]')?.querySelectorAll("article")).toHaveLength(1);
  });
});
