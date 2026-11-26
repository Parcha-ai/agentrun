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
const defaults = (): AgentFactoryBoardProps => ({ cards: active, review, loading: false, refreshing: false, error: null, updatedAt: AT, hasMore: false, onLoadMore: vi.fn(), onRefresh: vi.fn(), view: "cards", onView: vi.fn() });
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
  /** Refresh: an icon, named for a screen reader. */
  const refresh = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh Agent Factory"]')!;
  return { host, props, render, button, lane, refresh };
}

describe("Agent Factory board", () => {
  it("frames the page as the console's other pages do: its name in the top bar after its icon; the view switch and Refresh end the totals' row", () => {
    const { host, refresh } = mount();
    const bar = host.querySelector("header")!;
    for (const name of pageToolbarClass.split(" ")) expect(bar.classList.contains(name), name).toBe(true);
    const title = bar.querySelector("h1")!;
    expect(title.textContent).toBe("Agent Factory");
    for (const name of pageTitleClass.split(" ")) expect(title.classList.contains(name), name).toBe(true);
    expect(title.querySelector("svg[aria-hidden]")).not.toBeNull();
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    // The bar is the place's name alone: the page's controls sit with the sessions they act on.
    expect(bar.querySelectorAll("button, input")).toHaveLength(0);
    // No sentence under the bar: the totals are the page's first line, as a list is on the other pages.
    expect(host.textContent).not.toContain("Sessions reported to this AgentRun server");
    const row = host.querySelector('[aria-label="Loaded active session totals"]')!.parentElement!;
    expect(row.children).toHaveLength(2);
    // No rule under the row: the filters follow it across the page's own gap.
    expect([...row.classList].filter((name) => name.startsWith("border"))).toEqual([]);
    expect(row.firstElementChild!.getAttribute("aria-label")).toBe("Loaded active session totals");
    // The row's right end: how the sessions are laid out, then Refresh.
    const controls = row.lastElementChild!;
    expect(controls.classList.contains("ml-auto")).toBe(true);
    expect(controls.firstElementChild?.getAttribute("role")).toBe("radiogroup");
    expect(controls.firstElementChild?.getAttribute("aria-label")).toBe("View");
    expect(controls.lastElementChild).toBe(refresh());
    expect(refresh().textContent).toBe("");
  });

  it("keeps the top bar in place: the sessions scroll in a pane of their own under it, as on Mission Control and Runs", () => {
    const { host } = mount();
    const frame = host.querySelector('section[aria-label="Agent Factory"]')!;
    const bar = host.querySelector("header")!;
    // The frame takes the page's height and never scrolls: its two parts are the bar and, under it, the box that holds
    // the pane of sessions (and the open session's panel over it). A bar that scrolled with the sessions would leave
    // the edge under the navigation's logo row as soon as the page moved.
    expect([...frame.children].map((part) => part.tagName)).toEqual(["HEADER", "DIV"]);
    for (const name of ["flex", "h-full", "min-h-0", "flex-col"]) expect(frame.classList.contains(name), name).toBe(true);
    expect(frame.classList.contains("min-h-full")).toBe(false);
    const under = bar.nextElementSibling!;
    for (const name of ["relative", "flex", "min-h-0", "flex-1", "flex-col"]) expect(under.classList.contains(name), name).toBe(true);
    expect(under.classList.contains("overflow-auto")).toBe(false);
    const pane = under.firstElementChild!;
    expect(pane.hasAttribute("data-factory-pane")).toBe(true);
    for (const name of ["min-h-0", "flex-1", "overflow-auto"]) expect(pane.classList.contains(name), name).toBe(true);
    // Everything under the bar is in that pane, the page's last line included.
    expect(pane.contains(host.querySelector('[aria-label="Loaded active session totals"]'))).toBe(true);
    expect(pane.contains(host.querySelector('[aria-label="Active agent sessions"]'))).toBe(true);
    expect(pane.contains(host.querySelector("footer"))).toBe(true);
  });

  it("opens a session in the page's panel: its name leads there, its label leads to the run's own page, and the open one says so", () => {
    const href = (runId: string) => `#/factory?session=${encodeURIComponent(runId)}`;
    for (const view of ["cards", "list"] as const) {
      const { host } = mount({ view, sessionHref: href, openSession: "waiting" });
      const item = (id: string) => host.querySelector(view === "cards" ? `article:has(a[href="${href(id)}"])` : `tr[data-factory-row="${id}"]`)!;
      // The name is the way into the panel; the run's own page is one press away, on the label that names the run.
      const links = [...item("run/worker").querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]);
      expect(links[0]![0]).toBe("#/factory?session=run%2Fworker");
      expect(links).toContainEqual(["#/runs/run%2Fworker", "run/worker"]);
      // Only the open session is marked, for the eye and for a screen reader.
      expect([...host.querySelectorAll('[aria-current="true"]')]).toEqual([item("waiting")]);
      expect(host.textContent).toContain("Open one to see its latest activity and act on it.");
      act(() => root!.unmount());
      document.body.innerHTML = "";
    }
    // Alone, with no panel to open, a session's name still leads to its run's own page, and its label is no link.
    const { host } = mount();
    expect(host.querySelector('[data-factory-lane="working"] article h3 a')!.getAttribute("href")).toBe("#/runs/run%2Fworker");
    expect(host.querySelectorAll('article p a[href^="#/runs/"]')).toHaveLength(0);
  });

  it("leaves a session's name without an underline until the pointer or the keyboard is on it, on a card and on a row", () => {
    for (const view of ["cards", "list"] as const) {
      const { host } = mount({ view });
      const names = [...host.querySelectorAll<HTMLElement>(view === "cards" ? "article h3 a > span:first-child" : "tr[data-factory-row] td > a > span:first-child")];
      expect(names.length).toBeGreaterThan(3);
      for (const name of names) {
        const classes = name.className.split(" ");
        // Its card's heading, bold: an underline under every one made the board busy. Under the pointer, or with the
        // keyboard on its link, it is underlined as a list's names are elsewhere.
        expect(classes, name.textContent ?? "").not.toContain("underline");
        for (const c of ["font-semibold", "group-hover:underline", "group-focus-visible:underline"]) expect(classes, c).toContain(c);
        expect(name.parentElement!.className.split(" ")).toContain("group");
      }
      act(() => root!.unmount());
      document.body.innerHTML = "";
    }
  });

  it("names the next step on a session that waits on a person, as one more way into it, on its card and on its row", () => {
    const href = (runId: string) => `#/factory?session=${runId}`;
    const waiting = [card("asked", "attention", { action: "Answer", agentName: "Triage" }), card("call", "attention", { action: "Review" }), card("busy", "working")];
    for (const view of ["cards", "list"] as const) {
      const { host } = mount({ view, cards: waiting, review: [], sessionHref: href });
      const steps = [...host.querySelectorAll<HTMLAnchorElement>("a[data-factory-action]")];
      expect(steps.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-label")])).toEqual([["Answer", "#/factory?session=asked", "Answer: Triage"], ["Review", "#/factory?session=call", "Review: Builder"]]);
      act(() => root!.unmount());
      document.body.innerHTML = "";
    }
  });

  it("draws the open session's panel over the pane of sessions, never inside the box that scrolls them", () => {
    const { host } = mount({ panel: createElement("aside", { "aria-label": "Session" }, "the open run") });
    const panel = host.querySelector('aside[aria-label="Session"]')!;
    const pane = host.querySelector("[data-factory-pane]")!;
    expect(panel.parentElement).toBe(pane.parentElement);
    expect(pane.contains(panel)).toBe(false);
    expect(panel.previousElementSibling).toBe(pane);
    // The board under it is whole: the panel takes nothing out of the page.
    expect(pane.querySelectorAll("article")).toHaveLength(5);
    // Where the panel covers the whole board (below xl) the board is out of the keyboard's and a screen reader's way,
    // still laid out, so it keeps its scroll: hidden to them only there, and only while a panel is open.
    expect(pane.classList.contains("max-xl:invisible")).toBe(true);
    act(() => root!.unmount());
    document.body.innerHTML = "";
    expect(mount().host.querySelector("[data-factory-pane]")!.classList.contains("max-xl:invisible")).toBe(false);
  });

  it("takes its filters from the page that keeps them in its address, and tells it of each change", async () => {
    const onFilters = vi.fn();
    const { host, render } = mount({ filters: { repository: "unreported", control: "all" }, onFilters });
    expect(host.querySelector('[aria-label="Matching sessions"]')?.textContent).toBe("1 of 4 loaded active sessions match");
    await pick(picker(host, "Control")!, "control:Managed");
    expect(onFilters).toHaveBeenLastCalledWith({ repository: "unreported", control: "control:Managed" });
    // Nothing moves until the page says so: the address is the one place the filters are kept.
    expect(host.querySelector('[aria-label="Matching sessions"]')?.textContent).toBe("1 of 4 loaded active sessions match");
    render({ filters: { repository: "all", control: "control:Observed" } });
    expect(host.querySelector('[aria-label="Matching sessions"]')?.textContent).toBe("1 of 4 loaded active sessions match");
    expect(host.querySelectorAll('[data-factory-lane="unknown"] article')).toHaveLength(1);
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!.click(); });
    expect(onFilters).toHaveBeenLastCalledWith({ repository: "all", control: "all" });
  });

  it("says when the sessions were last read, beside Refresh at the top of the page, and that a failed read left them stale", () => {
    const { host, refresh, render } = mount();
    const said = () => refresh().previousElementSibling!;
    // Between the view switch and Refresh: the time of the read the page shows, to the second, since it is read again
    // every few seconds; the hover says how often.
    expect(said().previousElementSibling?.getAttribute("role")).toBe("radiogroup");
    expect(said().querySelector("time")?.getAttribute("datetime")).toBe(AT);
    expect(said().textContent).toMatch(/^Updated \d{1,2}:\d{2}:\d{2} [AP]M$/);
    expect(said().getAttribute("title")).toBe("Read again every 10 seconds, and when you come back to this tab");
    render({ error: "The server did not answer" });
    expect(said().textContent).toMatch(/^Updated \d{1,2}:\d{2}:\d{2} [AP]M · stale$/);
    // Before the first read there is no time to say.
    render({ error: null, updatedAt: null });
    expect(refresh().previousElementSibling?.getAttribute("role")).toBe("radiogroup");
  });

  it("offers both kinds of control in its filter, whichever the loaded sessions have: Observed can be asked for and answered with none", async () => {
    const { host } = mount({ cards: [card("first", "working"), card("second", "waiting")], review: [] });
    const options = await optionsOf(picker(host, "Control")!);
    expect(options.map((option) => option.value)).toEqual(["all", "control:Managed", "control:Observed"]);
    expect(options.map((option) => option.text)).toEqual(["All controls", "Managed", "Observed"]);
    await pick(picker(host, "Control")!, "control:Observed");
    expect(host.querySelector('[aria-label="Matching sessions"]')?.textContent).toBe("0 of 2 loaded active sessions match");
    expect(host.querySelectorAll("article")).toHaveLength(0);
    await pick(picker(host, "Control")!, "control:Managed");
    expect(host.querySelectorAll("article")).toHaveLength(2);
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

  it("offers the sessions as a list or as cards in lanes: one View group of two icon segments, on Cards until List is picked", () => {
    const { host, props } = mount();
    const group = host.querySelector('[role="radiogroup"][aria-label="View"]')!;
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.value)).toEqual(["list", "cards"]);
    // Each segment is an icon: its word is kept for a screen reader and for a pointer's hover, and is not drawn.
    expect(radios.map((radio) => radio.closest("label")!.textContent)).toEqual(["List", "Cards"]);
    for (const radio of radios) {
      const segment = radio.closest("label")!;
      expect(segment.querySelector("svg[aria-hidden]")).not.toBeNull();
      expect([...segment.querySelectorAll("span")].every((word) => word.classList.contains("sr-only"))).toBe(true);
      expect(segment.title).toBe(segment.textContent);
    }
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    expect(host.querySelectorAll("[data-factory-lane]")).toHaveLength(4);
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("footer")?.textContent).toContain("One card is one session.");
    act(() => radios[0]!.click());
    expect(props.onView).toHaveBeenCalledWith("list");
  });

  it("lists the sessions under a heading for each state, with no State column: the run's link, control, repository, last activity and cost", () => {
    const { host } = mount({ view: "list" });
    expect([...host.querySelectorAll<HTMLInputElement>('[aria-label="View"] input')].map((radio) => radio.checked)).toEqual([true, false]);
    expect(host.querySelectorAll("[data-factory-lane]")).toHaveLength(0);
    expect(host.querySelectorAll("article")).toHaveLength(0);
    const table = host.querySelector('table[aria-label="Active agent sessions"]')!;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Session", "Control", "Repository", "Last activity", "Cost"]);
    // One group a state that has a session, in the lanes' order; its heading names the state, counts its rows and says what the state means.
    const groups = [...table.querySelectorAll("tbody[data-factory-group]")];
    expect(groups.map((group) => group.getAttribute("data-factory-group"))).toEqual(["waiting", "working", "attention", "unknown"]);
    const heading = (group: Element) => group.querySelector('tr:first-child > th[scope="rowgroup"]')!;
    expect(groups.map((group) => heading(group).querySelector("[data-factory-group-name]")?.textContent)).toEqual(["Waiting", "Working", "Needs you", "Unknown"]);
    expect(groups.map((group) => heading(group).querySelector("[data-factory-group-count]")?.textContent)).toEqual(["1", "1", "1", "1"]);
    expect(heading(groups[2]!).textContent).toContain("A decision or approval is needed.");
    const rows = [...table.querySelectorAll("tr[data-factory-row]")];
    expect(rows.map((row) => [row.closest("tbody")!.getAttribute("data-factory-group"), row.querySelector('a[href^="#/runs/"]')?.getAttribute("href")]))
      .toEqual([["waiting", "#/runs/waiting"], ["working", "#/runs/run%2Fworker"], ["attention", "#/runs/approval"], ["unknown", "#/runs/native"]]);
    const [waiting, worker, approval, native] = rows as [Element, Element, Element, Element];
    const cells = (row: Element) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
    const meta = (row: Element) => row.querySelector("[data-factory-meta]")?.textContent;
    expect(cells(worker)).toHaveLength(5);
    expect(cells(worker)[0]).toContain("Builder");
    expect(cells(worker)[0]).toContain("Reviewing verification code");
    expect(cells(worker)[1]).toBe("Managed");
    expect(worker.querySelector('a[href="https://github.com/example/console/pull/8"]')?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(cells(worker)[3]).not.toBe("Not reported");
    expect(cells(worker)[4]).toBe("$1.20 recorded");
    // The group says the state. What the source called it follows the session's label only when it says more.
    expect(meta(worker)).toBe("Codex · run/worker");
    expect(meta(approval)).toBe("Codex · approval · Approval requested");
    expect(cells(approval)[0]).toContain("Tool permission required");
    expect(cells(waiting)[0]).toContain("Parent: Coordinator · root-run");
    expect(cells(native).slice(1)).toEqual(["Observed", "Not reported", "Not reported", "Cost not reported"]);
    // An ended run is a row too, grouped by the state its source gave it.
    const ended = host.querySelector('[aria-label="Ended runs needing attention"]')!;
    const endedGroups = [...ended.querySelectorAll("tbody[data-factory-group]")];
    expect(endedGroups.map((group) => [heading(group).querySelector("[data-factory-group-name]")?.textContent, heading(group).querySelector("[data-factory-group-count]")?.textContent])).toEqual([["Needs review", "1"]]);
    const endedRows = [...ended.querySelectorAll("tr[data-factory-row]")];
    expect(endedRows).toHaveLength(1);
    expect(meta(endedRows[0]!)).toBe("Codex · ended");
    expect(endedRows[0]!.textContent).toContain("Run ended with an uncertain outcome");
    expect(host.querySelector("footer")?.textContent).toContain("One row is one session.");
  });

  it("folds a state's rows away and back from its heading: a button that says whether it is open, with the count still shown", () => {
    const { host, render } = mount({ view: "list" });
    const group = (id: string, table = "Active agent sessions") => host.querySelector(`table[aria-label="${table}"] tbody[data-factory-group="${id}"]`)!;
    const toggle = (id: string, table?: string) => group(id, table).querySelector<HTMLButtonElement>('tr:first-child > th[scope="rowgroup"] button')!;
    const rows = (id: string, table?: string) => group(id, table).querySelectorAll("tr[data-factory-row]");
    // Every state opens unfolded.
    expect(["waiting", "working", "attention", "unknown"].map((id) => toggle(id).getAttribute("aria-expanded"))).toEqual(["true", "true", "true", "true"]);
    expect(toggle("working").textContent).toContain("Working");
    expect(toggle("working").querySelector("svg[aria-hidden]")).not.toBeNull();
    act(() => toggle("working").click());
    expect(toggle("working").getAttribute("aria-expanded")).toBe("false");
    expect(rows("working")).toHaveLength(0);
    // The heading still names the state and counts what it holds, and the other states stay open.
    expect(group("working").querySelector("[data-factory-group-count]")?.textContent).toBe("1");
    expect(rows("attention")).toHaveLength(1);
    expect(host.querySelector('[aria-label="Loaded active session totals"]')?.textContent).toContain("4 active sessions loaded");
    // A refresh and a look at the cards leave it folded.
    render({ updatedAt: "2026-11-22T09:31:00.000Z" });
    render({ view: "cards" });
    render({ view: "list" });
    expect(toggle("working").getAttribute("aria-expanded")).toBe("false");
    expect(rows("working")).toHaveLength(0);
    // The whole band is the target: a press beside the words unfolds it too.
    act(() => (group("working").querySelector("tr:first-child > td") as HTMLElement).click());
    expect(toggle("working").getAttribute("aria-expanded")).toBe("true");
    expect(rows("working")).toHaveLength(1);
    // Ended runs fold by their own states, apart from the active ones.
    act(() => toggle("Needs review", "Ended runs").click());
    expect(rows("Needs review", "Ended runs")).toHaveLength(0);
    expect(host.querySelectorAll('table[aria-label="Active agent sessions"] tr[data-factory-row]')).toHaveLength(4);
  });

  it("keeps a child under its parent only where both are in one state, and names the parent either way", () => {
    const parent = card("root", "working", { agentName: "Coordinator", ref: "run root" });
    const child = (id: string, lane: FactoryCard["lane"]) => card(`root:child:${id}`, lane, { runId: "root", ref: `child ${id}`, agentName: `Task ${id}`, stateLabel: "Reported active", parentLabel: "Coordinator · root" });
    const { host } = mount({ view: "list", review: [], cards: [parent, child("1", "working"), child("2", "unknown"), card("other", "working")] });
    const row = (id: string) => [...host.querySelectorAll("tr[data-factory-row]")].find((each) => each.getAttribute("data-factory-row") === id)!;
    // Under its parent in Working: set in from the parent's edge.
    expect([...host.querySelectorAll('tbody[data-factory-group="working"] tr[data-factory-row]')].map((each) => each.getAttribute("data-factory-row"))).toEqual(["root", "root:child:1", "other"]);
    expect(row("root:child:1").hasAttribute("data-factory-child")).toBe(true);
    // Alone in Unknown, away from its parent: a row like any other, which still says whose child it is.
    expect(row("root:child:2").closest("tbody")!.getAttribute("data-factory-group")).toBe("unknown");
    expect(row("root:child:2").hasAttribute("data-factory-child")).toBe(false);
    for (const id of ["root:child:1", "root:child:2"]) expect(row(id).textContent).toContain("Parent: Coordinator · root");
    expect(row("root").hasAttribute("data-factory-child")).toBe(false);
    expect(row("root:child:1").querySelector("[data-factory-meta]")?.textContent).toBe("Codex · child 1 · Reported active");
  });

  it("filters the list as it filters the cards, and says so when no row is left", async () => {
    const { host } = mount({ view: "list" });
    await pick(picker(host, "Repository")!, "unreported");
    expect(host.querySelectorAll('table[aria-label="Active agent sessions"] tr[data-factory-row]')).toHaveLength(1);
    // A state the filter empties has no heading left.
    expect([...host.querySelectorAll('table[aria-label="Active agent sessions"] tbody[data-factory-group]')].map((group) => group.getAttribute("data-factory-group"))).toEqual(["unknown"]);
    expect(host.querySelector('[aria-label="Matching sessions"]')?.textContent).toBe("1 of 4 loaded active sessions match");
    expect(host.querySelector('[aria-label="Loaded active session totals"]')?.textContent).toContain("4 active sessions loaded");
    await pick(picker(host, "Control")!, "control:Managed");
    expect(host.querySelector('table[aria-label="Active agent sessions"]')).toBeNull();
    expect(host.textContent).toContain("No matching sessions");
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
