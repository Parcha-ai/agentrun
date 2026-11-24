import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { keptUntilOf, useRunScreen, type ScreenView } from "./RunScreen";
import { messageFeatures, runFixture } from "@/fixtures";
import { ClientError } from "@/lib/client";
import type { Run, RunComputer, TimelineRow } from "@/lib/v2";

// The run page's Screen tab, over GET /v2/runs/{id}/computer (owner session only, no-store): `off` (no browser, or it
// resolves unavailable) hides it; `none` (one, with no session open) waits only while its session is opening, and says
// plainly when the run hasn't opened one or the one it opened closed; `live` embeds the session's
// viewer. The viewer is a same-origin path whose token is in its fragment: it is the iframe's src and nothing else, never
// in the address bar, the history, storage, the console or an error.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
const logs: unknown[][] = [];
beforeEach(() => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); logs.length = 0; localStorage.clear(); sessionStorage.clear(); });

const f = runFixture("run.completed.idle.1");
const working = { ...f.run, kind: "agentic", status: "working", state: "working", result: null } as Run;
const RUN = working.run_id;
const VIEWER = `/v2/runs/${RUN}/computer/live/v/AbCdEfGhIjKlMnOpQrStUv#t=SECRET-TOKEN-one-1234567890`;
const VIEWER2 = `/v2/runs/${RUN}/computer/live/v/ZyXwVuTsRqPoNmLkJiHgFe#t=SECRET-TOKEN-two-0987654321`;
/** What the iframe frames: the served viewer resolved against this page's origin (a same-origin path, its fragment kept). */
const FRAMED = (viewer: string) => new URL(viewer, location.origin).href;
const settle = async (ms = 60) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function page(read: () => Promise<RunComputer>, run: Run = working, tab?: "screen") {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(RunDetail, { run, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readComputer: read, computerEvery: 20, ...(tab ? { tab } : {}) } as never));
  });
  await settle();
  const tabButton = () => [...host.querySelectorAll('[role="tab"]')].find((b) => /^Screen$/.test(b.textContent ?? "")) as HTMLElement | undefined;
  const open = async () => { const b = tabButton(); expect(b, "the Screen tab").toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  const frame = () => host.querySelector("iframe") as HTMLIFrameElement | null;
  return { host, tabButton, open, frame };
}

/** Everywhere the viewer (its token above all) must never be, but the iframe's src. */
function nowhereBut(frame: HTMLIFrameElement | null, ...secrets: string[]) {
  for (const s of secrets) {
    const token = s.split("#t=")[1];
    expect(location.href).not.toContain(token);
    expect(location.hash).not.toContain(token);
    expect(JSON.stringify(history.state ?? null)).not.toContain(token);
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) expect(store.getItem(store.key(i)!) ?? "").not.toContain(token);
    expect(JSON.stringify(logs.map((args) => args.map(String)))).not.toContain(token);
    // In the page, once: the iframe's src attribute.
    const html = document.body.innerHTML.replaceAll("&amp;", "&");
    expect(html.split(token).length - 1, "the token appears once in the page").toBe(frame ? 1 : 0);
  }
}

const MESSAGES = { steer: false, answer: true, follow_up: true, steer_workflow_runs: false };
describe("the run page reads the run's screen, whatever its capabilities list", () => {
  const base = { sha: null, updated_at: "2026-11-05T09:00:00Z", poll_after_ms: 0, run_id: RUN, place: { mode: "runner" }, agent_id: "browsing", agent_version: 1, revision: "rv1", kind: "agentic", status: "working", state: "working", title: "Look", created_at: "2026-11-05T09:00:00Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null } as Run;
  async function live(caps: unknown) {
    const reads: string[] = [];
    const v2 = {
      getRun: async () => base, listFiles: async () => ({ run_id: RUN, files: [], complete: true, truncated: false }),
      getTimeline: async () => ({ run_id: RUN, place: { mode: "runner" }, status: "working", state: "working", rows: [], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 0 }),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      runComputer: async (id: string) => { reads.push(id); return { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }; },
    };
    const { LiveRun } = await import("./LiveRun");
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LiveRun, { v2: v2 as never, runId: RUN, caps: caps as never, agentName: () => "Browsing" })); });
    await settle(80);
    return { host, reads };
  }
  it("it reads the run's browser and offers the tab: no capability gates it, the served state decides", async () => {
    const p = await live({ harnesses: [{ id: "pi", available: true }], features: { messages: MESSAGES } });
    expect(p.reads[0]).toBe(RUN);
    expect([...p.host.querySelectorAll('[role="tab"]')].some((b) => b.textContent === "Screen")).toBe(true);
  });
});

describe("the run page's Screen tab, for a browser", () => {
  it("is not there for a run with no browser (state off)", async () => {
    const p = await page(async () => ({ state: "off", hold: "agent", why: "no browser key" }));
    expect(p.tabButton()).toBeUndefined();
    expect(p.frame()).toBeNull();
  });

  it("is not there for a caller the route refuses (403)", async () => {
    const p = await page(async () => { throw new ClientError(403, "forbidden", "no", false); });
    expect(p.tabButton()).toBeUndefined();
  });

  it("signed out (401) while watching: the tab stays and says why, with no frame left and nothing read again", async () => {
    let n = 0;
    const p = await page(async () => { n += 1; if (n === 1) return { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }; throw new ClientError(401, "unauthenticated", "sign in first", false); });
    await p.open();
    await settle(120);
    const reads = n;
    await settle(120);
    expect(n).toBe(reads);
    expect(p.tabButton()?.textContent).toBe("Screen");
    expect(p.frame()).toBeNull();
    expect(p.host.querySelector('section[aria-label="Screen"]')?.textContent).toContain("Signed out: sign in to watch.");
  });

  it("a 404 is a failed read like any other: it reads again, and the tab comes once the route answers", async () => {
    let n = 0;
    const p = await page(async () => { n += 1; if (n === 1) throw new ClientError(404, "not_found", "no", false); return { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }; });
    await settle(120);
    expect(n).toBeGreaterThan(1);
    expect(p.tabButton()?.textContent).toBe("Screen");
  });

  it("waits for the browser while the run opens one and no page is open yet", async () => {
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent", session: "opening" }));
    expect(p.tabButton()!.textContent).toBe("Screen");
    await p.open();
    expect(p.host.textContent).toContain("Waiting for the browser");
    expect(p.frame()).toBeNull();
  });

  it("a run waiting for its person that never opened its browser says so plainly, never 'Waiting for the browser'", async () => {
    let reads = 0;
    const waitingOnYou = { ...working, status: "input_required", state: "waiting" } as Run;
    const p = await page(async () => { reads++; return { state: "none", kind: "browser", hold: "agent", session: "unopened" }; }, waitingOnYou, "screen");
    await settle(100);
    const text = p.host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    expect(text).toContain("This run hasn't opened its browser. The agent's page shows here if it opens one.");
    expect(text).not.toContain("Waiting for the browser");
    expect(p.frame()).toBeNull();
    // Still read, so the page shows once the agent opens one.
    expect(reads).toBeGreaterThan(1);
  });

  it("a working run that hasn't opened its browser says so too, and waits once the agent's step opens one", async () => {
    let session: "unopened" | "opening" = "unopened";
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent", session }), working, "screen");
    const section = () => p.host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    expect(section()).toContain("This run hasn't opened its browser.");
    session = "opening";
    await settle(100);
    expect(section()).toContain("Waiting for the browser");
    expect(section()).not.toContain("hasn't opened");
  });

  it("a going run whose browser closed says it isn't open now, never that it waits", async () => {
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent", session: "closed" }), working, "screen");
    const text = p.host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    expect(text).toContain("The run's browser isn't open now. The agent's page shows here if it opens one again.");
    expect(text).not.toContain("Waiting for the browser");
  });

  it("an ended run that never opened its browser says it didn't, never that its browser closed", async () => {
    const done = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent", session: "unopened" }), done, "screen");
    const text = p.host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    expect(text).toContain("This run didn't open its browser. A follow-up opens one if the agent needs it.");
    expect(text).not.toContain("closed when the run ended");
  });

  it("a run that ends with its last read unopened reads once more: a browser opened since reads closed, never 'didn't open'", async () => {
    let opened = false;
    const p = await moving(async () => ({ state: "none", kind: "browser", hold: "agent", session: opened ? "closed" : "unopened" }));
    expect(p.section()).toContain("This run hasn't opened its browser.");
    // The browser opens and closes between two reads, and the run ends before the next one.
    opened = true;
    const before = p.reads();
    await p.show(ended);
    await settle(150);
    const atEnd = p.reads();
    expect(atEnd, "read again at the end").toBeGreaterThan(before);
    expect(p.section()).toContain("The browser closed when the run ended.");
    expect(p.section()).not.toContain("didn't open");
    await settle(150);
    expect(p.reads(), "and nothing more").toBe(atEnd);
  });

  it("a desktop the run hasn't opened says so in a desktop's words", async () => {
    const desktop = { ...working, status: "input_required", state: "waiting", computer: { kind: "desktop", provider: "e2b", state: "ready" } } as Run;
    const p = await page(async () => ({ state: "none", kind: "desktop", hold: "agent", session: "unopened" }), desktop, "screen");
    const text = p.host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    expect(text).toContain("This run hasn't opened its desktop. Its screen shows here if the agent opens one.");
    expect(text).not.toContain("Waiting for the desktop");
  });

  it("embeds the live session's viewer under Screen: the iframe's src is the viewer on this origin, and the viewer is nowhere else", async () => {
    const p = await page(async () => ({ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }));
    expect(p.tabButton()!.textContent).toBe("Screen");
    await p.open();
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER));
    expect(p.frame()!.getAttribute("title")).toBe("The run's screen");
    nowhereBut(p.frame(), VIEWER);
  });

  it("frames the viewer with only what its page needs: its own scripts, its own origin for the WebSocket and the cookie, and its address bar's form", async () => {
    const p = await page(async () => ({ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }), working, "screen");
    expect(p.frame()!.getAttribute("sandbox")?.split(/\s+/).sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(p.frame()!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("follows the session: live, then none at release, then live again with the new viewer, never the old one", async () => {
    const answers: RunComputer[] = [{ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }, { state: "none", kind: "browser", hold: "agent", session: "closed" }, { state: "live", kind: "browser", viewer: VIEWER2, hold: "agent" }];
    let i = 0;
    const p = await page(async () => answers[Math.min(i++, answers.length - 1)], working, "screen");
    for (let n = 0; n < 20 && i < answers.length; n++) await settle(30);
    await settle(60);
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER2));
    expect(p.host.innerHTML).not.toContain("SECRET-TOKEN-one");
    nowhereBut(p.frame(), VIEWER2);
  });

  it("a newer session while one is live (no none between) moves the iframe to the newer viewer at once", async () => {
    // The server answers the newest live session (#1685: one hand-over per session; GET /browser the newest that answers).
    let newer = false;
    const p = await page(async () => ({ state: "live", kind: "browser", viewer: newer ? VIEWER2 : VIEWER, hold: "agent" }), working, "screen");
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER));
    newer = true;
    await settle(120);
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER2));
    expect(p.host.querySelectorAll("iframe")).toHaveLength(1);
    expect(p.host.innerHTML).not.toContain("SECRET-TOKEN-one");
    nowhereBut(p.frame(), VIEWER2);
  });

  it("a failed read after a live one keeps the page, and says nothing of the viewer anywhere", async () => {
    let i = 0;
    const p = await page(async () => { if (i++ === 0) return { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }; throw new Error(`GET /v2/runs/${RUN}/computer: 502`); }, working, "screen");
    await settle(120);
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER));
    nowhereBut(p.frame(), VIEWER);
  });

  it("on an ended run, none reads that the browser closed, never that it waits; nothing more is read", async () => {
    let reads = 0;
    const done = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const p = await page(async () => { reads++; return { state: "none", kind: "browser", hold: "agent", session: "closed" }; }, done, "screen");
    await settle(150);
    const text = p.host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    expect(text).toContain("The browser closed when the run ended.");
    expect(text).not.toContain("Waiting for the browser");
    expect(reads).toBe(1);
  });

  it("a follow-up's line shows only where the run takes one: a completed run does, a cancelled one does not", async () => {
    const completed = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent", session: "closed" }), completed, "screen");
    expect(p.host.textContent).toContain("A follow-up opens a new one if the agent needs it.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const cancelled = { ...working, status: "cancelled", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const q = await page(async () => ({ state: "none", kind: "browser", hold: "agent", session: "closed" }), cancelled, "screen");
    expect(q.host.textContent).toContain("The browser closed when the run ended.");
    expect(q.host.textContent).not.toContain("A follow-up opens");
  });

  it("while the run waits on its question with its session held, it still reads and still waits for the browser", async () => {
    let reads = 0;
    const asking = { ...working, status: "input_required", state: "waiting" } as Run;
    const p = await page(async () => { reads++; return { state: "none", kind: "browser", hold: "agent", session: "opening" }; }, asking, "screen");
    await settle(150);
    expect(p.host.textContent).toContain("Waiting for the browser");
    expect(reads).toBeGreaterThan(1);
  });

  /** The page, rendered again with `run` changed (it ends) while the reads go on; `reads()` counts them. */
  async function moving(read: () => Promise<RunComputer>, first: Run = working) {
    let reads = 0;
    const counted = async () => { reads += 1; return read(); };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const show = (run: Run) => act(async () => { root!.render(createElement(RunDetail, { run, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readComputer: counted, computerEvery: 20, tab: "screen" } as never)); });
    await show(first);
    await settle();
    const section = () => host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    const tabButton = () => [...host.querySelectorAll('[role="tab"]')].find((b) => /^Screen$/.test(b.textContent ?? "")) as HTMLElement | undefined;
    const selected = () => (host.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.textContent ?? null;
    return { host, show, section, tabButton, selected, reads: () => reads, frame: () => host.querySelector("iframe") };
  }
  const ended = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;

  it("a failed last read and then the end show the same, and nothing more is read after the end", async () => {
    let failing = false;
    const p = await moving(async () => { if (failing) throw new Error("502"); return { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }; });
    failing = true;
    await settle(60);
    await p.show(ended);
    const atEnd = p.reads();
    await settle(150);
    expect(p.frame()).toBeNull();
    expect(p.section()).toContain("The browser closed when the run ended.");
    expect(p.reads(), "no read after the end").toBe(atEnd);
  });

  it("a paused workflow is not over: its live browser keeps its iframe and is read on; once the run ends it shows closed and nothing more is read", async () => {
    const paused = { ...working, kind: "workflow", status: "paused", state: "idle" } as Run;
    const p = await moving(async () => ({ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }), paused);
    const before = p.reads();
    await settle(150);
    expect(p.frame(), "a pause blocks new work, and the browser can stay open").not.toBeNull();
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER));
    expect(p.section()).not.toContain("The browser closed when the run ended.");
    expect(p.reads(), "it is read on while paused").toBeGreaterThan(before);
    await p.show({ ...paused, status: "completed", ended_at: "2026-11-05T09:12:00Z" } as Run);
    const atEnd = p.reads();
    await settle(150);
    expect(p.frame()).toBeNull();
    expect(p.section()).toContain("The browser closed when the run ended.");
    expect(p.reads(), "no read after the end").toBe(atEnd);
  });

  it("a paused workflow with no page open waits for the browser, never says it closed with the run", async () => {
    const paused = { ...working, kind: "workflow", status: "paused", state: "idle" } as Run;
    const p = await moving(async () => ({ state: "none", kind: "browser", hold: "agent", session: "opening" }), paused);
    await settle(80);
    expect(p.section()).toContain("Waiting for the browser");
    expect(p.section()).not.toContain("closed when the run ended");
  });

  it("a browser let go while the run waits for its person says so, with when, and stays so: never 'Waiting for the browser'", async () => {
    const waitingOnYou = { ...working, status: "input_required", state: "waiting" } as Run;
    const ended = { at: "2026-11-11T14:26:00.000Z", why: "The browser was released after 15 min waiting for you" };
    let released = false;
    const p = await moving(async () => (released ? { state: "none", kind: "browser", hold: "agent", session: "closed", ended } : { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }), waitingOnYou);
    await settle(80);
    expect(p.frame()).not.toBeNull();
    released = true;
    await settle(80);
    expect(p.frame()).toBeNull();
    expect(p.section()).toContain("The browser was released after 15 min waiting for you");
    expect(p.section()).toContain("A new browser opens when the run goes on.");
    expect(p.section()).not.toContain("Waiting for the browser");
    // Read on and on: it stays.
    await settle(150);
    expect(p.section()).toContain("The browser was released after 15 min waiting for you");
  });

  it("an ended run that answered off is read again once a follow-up makes it go: its new browser shows under Screen", async () => {
    let restored = false;
    const p = await moving(async () => (restored ? { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" } : { state: "off", hold: "agent", why: "no browser key" }), ended);
    await settle(80);
    const stoppedAt = p.reads();
    expect(stoppedAt, "an ended run that says off is read once").toBe(1);
    expect(p.tabButton()).toBeUndefined();
    // The owner restores the browser key and sends a follow-up: the same page, the run going again.
    restored = true;
    await p.show({ ...ended, status: "working", state: "working", ended_at: null } as Run);
    await settle(120);
    expect(p.reads()).toBeGreaterThan(stoppedAt);
    expect(p.tabButton()?.textContent).toBe("Screen");
  });

  it("an ended run that answered off, went again with a live browser and then ended: its browser shows closed, with no iframe, and nothing more is read", async () => {
    let restored = false;
    const p = await moving(async () => (restored ? { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" } : { state: "off", hold: "agent", why: "no browser key" }), ended);
    await settle(80);
    restored = true;
    await p.show({ ...ended, status: "working", state: "working", ended_at: null } as Run);
    await settle(120);
    expect(p.tabButton()?.textContent).toBe("Screen");
    // The follow-up ends: its browser is closed, whatever the last read said.
    await p.show(ended);
    await settle(60);
    const endedAt = p.reads();
    expect(p.host.querySelector("iframe"), "no viewer after the follow-up ended").toBeNull();
    expect(p.host.textContent).toContain("The browser closed when the run ended.");
    await settle(120);
    expect(p.reads(), "nothing more is read").toBe(endedAt);
  });

  it("a Screen tab that goes away while selected (the next read says off) leaves the run's default tab selected, with its content", async () => {
    let off = false;
    const p = await moving(async () => (off ? { state: "off", hold: "agent", why: "no browser key" } : { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }));
    expect(p.selected()).toBe("Screen");
    off = true;
    await settle(120);
    expect(p.tabButton()).toBeUndefined();
    expect(p.selected(), "a tab is selected").toBe("Timeline");
    expect(p.host.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull();
    expect(p.host.textContent).not.toContain("Waiting for the browser");
  });

  it("a refusal (403) stays final: a run going again is not read", async () => {
    let n = 0;
    const p = await moving(async () => { n += 1; throw new ClientError(403, "forbidden", "no", false); }, ended);
    await settle(60);
    const once = n;
    await p.show({ ...ended, status: "working", state: "working", ended_at: null } as Run);
    await settle(120);
    expect(n).toBe(once);
    expect(p.tabButton()).toBeUndefined();
  });

  it("off while the run is going hides the tab, and the next read still comes: the run's process may still open a browser with the key it launched with", async () => {
    let n = 0;
    const p = await page(async () => (++n <= 2 ? { state: "off", hold: "agent", why: "no browser key" } : { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }));
    await settle(150);
    expect(n).toBeGreaterThan(2);
    expect(p.tabButton()?.textContent).toBe("Screen");
  });

  it("a browser has no controls of its own: taking over and handing back are its viewer's", async () => {
    const p = await page(async () => ({ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }), working, "screen");
    const panel = p.host.querySelector('section[aria-label="Screen"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.querySelector("[data-browser-actions]")).toBeNull();
    // No Take over or Hand back of its own: its only button sizes the view (fill the window).
    expect([...panel.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Fill the window"]);
    // The served hold doesn't follow a take in the browser's viewer: the header doesn't say who drives.
    expect(panel.querySelector("header")!.textContent).not.toMatch(/drives|You drive/);
    expect(panel.querySelector("header")!.textContent).toContain("take over in the view below");
  });

  // Only a viewer on this page's own origin, under this run's own path, is framed: anything else says so in words, with
  // no iframe, and the served value is not shown.
  for (const [what, viewer] of [
    ["another origin", `https://elsewhere.example/v2/runs/${RUN}/computer/live/v/AbCd#t=SECRET-TOKEN-foreign-111`],
    ["another run's path", `/v2/runs/someone-elses-run/computer/live/v/AbCd#t=SECRET-TOKEN-other-222`],
    ["no http(s) URL", `javascript:alert(1)//#t=SECRET-TOKEN-script-333`],
    ["the browser's own path (the console reads /computer)", `/v2/runs/${RUN}/browser/live/v/AbCd#t=SECRET-TOKEN-old-444`],
  ] as const) {
    it(`a viewer on ${what} is never framed: no iframe, a line in its place, and the value nowhere`, async () => {
      const p = await page(async () => ({ state: "live", kind: "browser", viewer, hold: "agent" }), working, "screen");
      expect(p.frame()).toBeNull();
      const panel = p.host.querySelector('section[aria-label="Screen"]') as HTMLElement;
      expect(panel.textContent).toContain("The live view can't be shown here.");
      expect(document.body.innerHTML).not.toContain(viewer.split("#t=")[1]);
    });
  }
});

// Every other kind on the same tab: a desktop's or a phone's screen framed the same way, with Take over and Hand back
// here (POST …/computer/take-over and …/hand-back); a sandbox, which has no screen, named from the run read's computer;
// the metered line for a metered provider of every kind but the browser; and the agent's ask at its computer, answered
// Done or Cancel through the one hand-back.
describe("the Screen tab for every kind, and the agent's ask", () => {
  type Extra = { onTakeOver?: unknown; onHandBack?: unknown; readComputers?: unknown; tab?: "screen"; rows?: unknown };
  async function screen(read: () => Promise<RunComputer>, run: Run, extra: Extra = {}) {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const show = (r: Run, more: Extra = {}) => act(async () => { root!.render(createElement(RunDetail, { run: r, agentName: "using", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readComputer: read, computerEvery: 20, ...extra, ...more } as never)); });
    await show(run);
    await settle();
    const panel = () => host.querySelector('section[aria-label="Screen"]') as HTMLElement | null;
    const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined;
    const selected = () => (host.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.textContent ?? null;
    const click = async (name: string) => { const b = button(name); expect(b, name).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
    return { host, show, panel, button, selected, click };
  }
  const desktop = { ...working, computer: { kind: "desktop", provider: "e2b", state: "ready" } } as Run;
  const DESKTOP_LIVE = (hold: "agent" | "pending" | "person" = "agent"): RunComputer => ({ state: "live", kind: "desktop", viewer: VIEWER, hold });
  const computers = (metered: boolean) => async () => ({ kinds: [
    { kind: "desktop", offered: true, groups: [], tools: [], providers: [{ id: "e2b", name: "E2B", metered, secrets: [], required: [], ready: true }] },
    { kind: "browser", offered: true, groups: [], tools: [], providers: [{ id: "browserbase", name: "Browserbase", metered: true, secrets: [], required: [], ready: true }] },
  ] });

  it("a live desktop is framed on the Screen tab, with Take over: taking it posts once and the header follows the answer", async () => {
    // The server's hold: the take-over's row makes it pending, and the next reads say so too.
    let takes = 0;
    let hold: "agent" | "pending" = "agent";
    const p = await screen(async () => DESKTOP_LIVE(hold), desktop, { tab: "screen", onTakeOver: async () => { takes += 1; hold = "pending"; return { hold: "pending" }; } });
    // The viewer is told the page has Take over and Hand back (hands=page), so its own bar shows no second one.
    expect(p.panel()!.querySelector("iframe")!.getAttribute("src")).toBe(`${FRAMED(VIEWER)}&hands=page`);
    expect(p.panel()!.textContent).toContain("The agent drives · desktop");
    await p.click("Take over");
    expect(takes).toBe(1);
    expect(p.panel()!.textContent).toContain("Yours after the agent's step");
    expect(p.button("Taking over")!.disabled).toBe(true);
    nowhereBut(p.panel()!.querySelector("iframe"), VIEWER);
  });

  it("a desktop that was live reads released when it goes at the run's end, never 'waiting', and closed once the run ends", async () => {
    // The order at a run's end: the desktop is let go, its viewer goes, and the read answers none, opening (the run still
    // working: a desktop is held from the run's start to its end) before the run read turns completed.
    let gone = false;
    const p = await screen(async () => (gone ? { state: "none", kind: "desktop", hold: "agent", session: "opening" } : DESKTOP_LIVE()), desktop, { tab: "screen" });
    expect(p.panel()!.querySelector("iframe")).not.toBeNull();
    gone = true;
    await settle(100);
    expect(p.panel()!.querySelector("iframe")).toBeNull();
    expect(p.panel()!.textContent).toContain("This desktop has been released.");
    expect(p.panel()!.textContent).not.toContain("Waiting for the desktop");
    // Read on, it stays released.
    await settle(100);
    expect(p.panel()!.textContent).toContain("This desktop has been released.");
    await p.show({ ...desktop, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z", computer: { kind: "desktop", provider: "e2b", state: "ended" } } as Run);
    await settle(60);
    expect(p.panel()!.textContent).toContain("The desktop closed when the run ended.");
    // A follow-up's turn opens a new desktop: that one is waited for.
    await p.show(desktop);
    await settle(100);
    expect(p.panel()!.textContent).toContain("Waiting for the desktop. Its screen shows here once it is up.");
  });

  it("a desktop kept at the run's park says what the run waits for and until when (its park's row's time and minutes), never released or ended; past that time, that it wasn't kept", async () => {
    const PARKED = "2026-11-05T09:10:00Z";
    const UNTIL = "2026-11-05T09:20:00Z";
    const at = new Date(UNTIL).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const phase = (seq: number, summary: string, timestamp: string) => ({ id: `p${seq}`, seq, kind: "phase", summary, text: null, timestamp, created_at: timestamp, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
    const rows = [phase(1, "The desktop is ready: Linux (amd64), from E2B.", "2026-11-05T09:00:00Z"), phase(2, "The desktop is kept for 10 minutes while you decide.", PARKED)];
    let read: RunComputer = DESKTOP_LIVE();
    const p = await screen(async () => read, desktop, { tab: "screen", rows });
    expect(p.panel()!.querySelector("iframe")).not.toBeNull();
    // Parked on a tool's approval: its viewer closed, the desktop kept for the resume (GET /computer: closed, no more).
    read = { state: "none", kind: "desktop", hold: "agent", session: "closed" };
    const waiting = (kind: string) => ({ ...desktop, status: "input_required", state: "waiting", pending: { kind } } as unknown as Run);
    await p.show(waiting("approval"));
    await settle(100);
    expect(p.panel()!.querySelector("iframe")).toBeNull();
    expect(p.panel()!.textContent).toContain(`Waiting for your approval. The desktop is kept until ${at}.`);
    expect(p.panel()!.textContent).not.toMatch(/released|ended/);
    expect(p.button("Take over")).toBeUndefined();
    await p.show(waiting("question"));
    await settle(60);
    expect(p.panel()!.textContent).toContain(`Waiting for your answer. The desktop is kept until ${at}.`);
    await p.show(waiting("budget"));
    await settle(60);
    expect(p.panel()!.textContent).toContain(`Waiting for you to raise the spend cap. The desktop is kept until ${at}.`);
    // Its time passed: not kept, and a new one starts when the run goes on.
    read = { state: "none", kind: "desktop", hold: "agent", session: "closed", ended: { at: UNTIL, why: "The desktop wasn't kept: 10 minutes passed. A new one starts when the run goes on." } };
    await settle(100);
    expect(p.panel()!.textContent).toContain("The desktop wasn't kept: 10 minutes passed. A new one starts when the run goes on.");
    expect(p.panel()!.textContent).not.toContain("released");
  });

  it("a desktop kept at a park and answered in time is waited for until the resume's screen is up, never 'released'; let go after that, it is", async () => {
    const PARKED = "2026-11-05T09:10:00Z";
    const at = new Date("2026-11-05T09:20:00Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const phase = (seq: number, summary: string, timestamp: string) => ({ id: `p${seq}`, seq, kind: "phase", summary, text: null, timestamp, created_at: timestamp, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
    const rows = [phase(1, "The desktop is ready: Linux (amd64), from E2B.", "2026-11-05T09:00:00Z"), phase(2, "The desktop is kept for 10 minutes while you decide.", PARKED)];
    const resumed = [...rows, phase(3, "The desktop is ready: Linux (amd64), from E2B. It's the same desktop, as the wait left it.", "2026-11-05T09:11:10Z")];
    // GET /computer for a desktop with no viewer up while its run is not over: opening (computer-view.ts sessionIn).
    const opening: RunComputer = { state: "none", kind: "desktop", hold: "agent", session: "opening" };
    const waiting = { ...desktop, status: "input_required", state: "waiting", pending: { kind: "approval" } } as unknown as Run;
    let read: RunComputer = DESKTOP_LIVE();
    const p = await screen(async () => read, desktop, { tab: "screen", rows });
    expect(p.panel()!.querySelector("iframe")).not.toBeNull();
    // Parked: the viewer goes with the park's process, the desktop kept.
    read = opening;
    await p.show(waiting);
    await settle(100);
    expect(p.panel()!.textContent).toContain(`Waiting for your approval. The desktop is kept until ${at}.`);
    // Allowed: the run goes on, and its resume opens the same desktop's screen again.
    await p.show(desktop);
    await settle(100);
    expect(p.panel()!.textContent).toContain("Waiting for the desktop. Its screen shows here once it is up.");
    expect(p.panel()!.textContent).not.toContain("released");
    await p.show(desktop, { rows: resumed });
    await settle(100);
    expect(p.panel()!.textContent).toContain("Waiting for the desktop. Its screen shows here once it is up.");
    read = DESKTOP_LIVE();
    await settle(100);
    expect(p.panel()!.querySelector("iframe")).not.toBeNull();
    // Let go at the run's end, before the run reads ended: released.
    read = opening;
    await settle(100);
    expect(p.panel()!.textContent).toContain("This desktop has been released.");
  });

  it("a page opened on a parked run with its desktop kept says what the run waits for and until when, though it never saw the desktop live", async () => {
    const phase = (seq: number, summary: string, timestamp: string) => ({ id: `p${seq}`, seq, kind: "phase", summary, text: null, timestamp, created_at: timestamp, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
    const rows = [phase(1, "The desktop is kept for 10 minutes while you decide.", "2026-11-05T09:10:00Z")];
    const at = new Date("2026-11-05T09:20:00Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const waiting = { ...desktop, status: "input_required", state: "waiting", pending: { kind: "approval" } } as unknown as Run;
    const p = await screen(async () => ({ state: "none", kind: "desktop", hold: "agent", session: "opening" }), waiting, { tab: "screen", rows });
    expect(p.panel()!.textContent).toContain(`Waiting for your approval. The desktop is kept until ${at}.`);
  });

  it("keptUntilOf reads the newest park's row of the kind, and nothing once that computer is ready again or for another kind", () => {
    const phase = (seq: number, summary: string, timestamp = "2026-11-05T09:10:00Z") => ({ id: `p${seq}`, seq, kind: "phase", summary, text: null, timestamp }) as unknown as TimelineRow;
    const kept = phase(2, "The phone is kept for 10 minutes while you decide.");
    expect(keptUntilOf([phase(1, "The phone is ready: Android."), kept], "phone")).toBe("2026-11-05T09:20:00.000Z");
    expect(keptUntilOf([kept, phase(3, "The phone is ready: Android. It's the same phone, as the wait left it.")], "phone")).toBeUndefined();
    expect(keptUntilOf([kept], "desktop")).toBeUndefined();
    expect(keptUntilOf([], "desktop")).toBeUndefined();
  });

  it("a stopped run's desktop never reads as waited for; the follow-up's new desktop, booting while the run is queued, is waited for", async () => {
    let gone = false;
    const p = await screen(async () => (gone ? { state: "none", kind: "desktop", hold: "agent", session: "opening" } : DESKTOP_LIVE()), desktop, { tab: "screen" });
    expect(p.panel()!.querySelector("iframe")).not.toBeNull();
    // Stopped: the turn ends and its desktop is let go; the run stays open (input required, idle), so it is still read.
    gone = true;
    await p.show({ ...desktop, status: "input_required", state: "idle" } as Run);
    await settle(100);
    expect(p.panel()!.textContent).not.toContain("Waiting for the desktop");
    // A follow-up: the run is queued while its claim starts a new desktop.
    await p.show({ ...desktop, status: "queued", state: "working", computer: { kind: "desktop", provider: "e2b", state: "starting" } } as Run);
    await settle(100);
    expect(p.panel()!.textContent).toContain("Waiting for the desktop. Its screen shows here once it is up.");
    expect(p.panel()!.textContent).not.toContain("released");
  });

  it("a phone opening at the run's start (never live on this page) still waits for it", async () => {
    const phone = { ...working, status: "queued", computer: { kind: "phone", provider: "phone-harness", state: "starting" } } as Run;
    const p = await screen(async () => ({ state: "none", kind: "phone", hold: "agent", session: "opening" }), phone, { tab: "screen" });
    expect(p.panel()!.textContent).toContain("Waiting for the phone. Its screen shows here once it is up.");
    // The run's badge says the phone is starting, never that the run is queued.
    const badge = p.host.querySelector("header")!.textContent ?? "";
    expect(badge).toContain("Starting");
    expect(badge).not.toContain("Queued");
  });

  it("a live phone's frame fits the page's visible height below it, so the whole phone shows without scrolling; on a short page it keeps a usable size", async () => {
    // jsdom lays nothing out: the pane's and the frame's boxes are given. The pane shows 600 px from y 200; the frame
    // starts 150 px into it; the pane keeps 32 px of padding below its content.
    let paneHeight = 600;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "IFRAME") return rect(350, 0);
      if (this.hasAttribute("data-scroll-pane")) return rect(200, paneHeight);
      return rect(0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-scroll-pane") ? paneHeight : 0; });
    const phone = { ...working, computer: { kind: "phone", provider: "phone-harness", state: "ready" } } as Run;
    const p = await screen(async () => ({ state: "live", kind: "phone", viewer: VIEWER, hold: "agent" }), phone, { tab: "screen" });
    const frame = () => p.panel()!.querySelector("iframe") as HTMLIFrameElement;
    expect(frame().style.height).toBe(`${600 - 150 - 32}px`);
    paneHeight = 300;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(frame().style.height, "past the smallest usable phone, the page scrolls").toBe("360px");
  });

  it("a card that comes or goes above a live phone moves it, and its frame fits again", async () => {
    // A card above the screen (the agent's ask) changes the page's content, not the pane's height: the frame refits when
    // the content does. jsdom has no ResizeObserver: this one calls back for whatever is observed when told to.
    const observed: { target: Element; fit: () => void }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly fit: () => void) {}
      observe(target: Element) { observed.push({ target, fit: this.fit }); }
      disconnect() { observed.splice(0, observed.length); }
    });
    let frameTop = 350;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "IFRAME") return rect(frameTop, 0);
      if (this.hasAttribute("data-scroll-pane")) return rect(200, 700);
      return rect(0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-scroll-pane") ? 700 : 0; });
    const phone = { ...working, computer: { kind: "phone", provider: "phone-harness", state: "ready" } } as Run;
    const p = await screen(async () => ({ state: "live", kind: "phone", viewer: VIEWER, hold: "agent" }), phone, { tab: "screen" });
    const frame = () => p.panel()!.querySelector("iframe") as HTMLIFrameElement;
    expect(frame().style.height).toBe(`${700 - 150 - 32}px`);
    // A 100 px card comes above it: the pane's content grows, the pane stays as it was.
    frameTop = 450;
    const content = frame().closest("[data-scroll-pane]")!.firstElementChild!;
    await act(async () => { for (const { target, fit } of observed) if (target === content) fit(); });
    expect(frame().style.height).toBe(`${700 - 250 - 32}px`);
    vi.unstubAllGlobals();
  });

  it("held by the person, it offers Hand back, which hands it back with no outcome", async () => {
    const outcomes: unknown[] = [];
    const p = await screen(async () => DESKTOP_LIVE("person"), desktop, { tab: "screen", onHandBack: async (o?: string) => { outcomes.push(o); return { hold: "agent" }; } });
    expect(p.panel()!.textContent).toContain("You drive · desktop");
    await p.click("Hand back");
    expect(outcomes).toEqual([undefined]);
  });

  it("a refused take-over is said in the server's words, and the screen stays", async () => {
    const p = await screen(async () => DESKTOP_LIVE(), desktop, { tab: "screen", onTakeOver: async () => { throw new ClientError(409, "computer_not_live", "this run's desktop is not up now, so there is nothing to take over", false); } });
    await p.click("Take over");
    expect(p.panel()!.querySelector('[role="alert"]')?.textContent).toBe("this run's desktop is not up now, so there is nothing to take over");
    expect(p.panel()!.querySelector("iframe")).not.toBeNull();
  });

  it("a desktop the live view has no answer for yet (off) still has its tab, from the run read, and waits for its screen", async () => {
    const p = await screen(async () => ({ state: "off", hold: "agent", why: "no viewer" }), { ...desktop, computer: { kind: "desktop", provider: "e2b", state: "starting" } } as Run, { tab: "screen" });
    expect(p.panel()!.textContent).toContain("Waiting for the desktop. Its screen shows here once it is up.");
    expect(p.button("Take over")).toBeUndefined();
  });

  it("a sandbox has the tab too, saying it has no screen; its metered provider's line shows", async () => {
    const sandbox = { ...working, computer: { kind: "sandbox", provider: "e2b", state: "ready" } } as Run;
    const read = async () => ({ kinds: [{ kind: "sandbox", offered: true, groups: [], tools: [], providers: [{ id: "e2b", name: "E2B", metered: true, secrets: [], required: [], ready: true }] }] });
    const p = await screen(async () => ({ state: "off", hold: "agent", why: "this run's agent has no computer" }), sandbox, { tab: "screen", readComputers: read });
    expect(p.panel()!.textContent).toContain("A sandbox has no screen.");
    expect(p.panel()!.textContent).toContain("This provider bills by the minute");
    expect(p.panel()!.querySelector("iframe")).toBeNull();
  });

  it("the metered line shows for a metered desktop provider, not for an unmetered one, and never for a browser", async () => {
    const a = await screen(async () => DESKTOP_LIVE(), desktop, { tab: "screen", readComputers: computers(true) });
    expect(a.panel()!.textContent).toContain("This provider bills by the minute");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const b = await screen(async () => DESKTOP_LIVE(), desktop, { tab: "screen", readComputers: computers(false) });
    expect(b.panel()!.textContent).not.toContain("bills by the minute");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const browserRun = { ...working, computer: { kind: "browser", provider: "browserbase", state: "ready" } } as Run;
    let reads = 0;
    const c = await screen(async () => ({ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }), browserRun, { tab: "screen", readComputers: async () => { reads += 1; return computers(true)(); } });
    expect(c.panel()!.textContent).not.toContain("bills by the minute");
    expect(reads, "a browser's providers are not read").toBe(0);
  });

  const asking = (kind: "browser" | "computer"): Run => ({
    ...(kind === "browser" ? working : desktop), status: "input_required", state: "waiting",
    pending: kind === "browser"
      ? { kind: "browser", instruction: "Sign in to the shop.", completion_condition: "The cart page shows.", asked_at: "2026-11-05T09:01:00Z", expires_at: "2026-11-05T09:31:00Z" }
      : { kind: "computer", computer: "desktop", instruction: "Approve the dialog.", completion_condition: "The dialog closes.", asked_at: "2026-11-05T09:01:00Z", expires_at: "2026-11-05T09:31:00Z" },
  } as Run);

  for (const kind of ["browser", "computer"] as const) {
    it(`the ${kind} ask: its card says what and how it will know, the page moves to Screen, and Done answers it once through the hand-back`, async () => {
      const outcomes: unknown[] = [];
      let release: () => void = () => {};
      const p = await screen(async () => (kind === "browser" ? { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" } : DESKTOP_LIVE()), asking(kind), {
        onHandBack: (o?: string) => { outcomes.push(o); return new Promise((r) => { release = () => r({ hold: "agent", outcome: o }); }); },
      });
      const card = p.host.querySelector('section[aria-label="Waiting for you at the computer"]') as HTMLElement;
      expect(card.textContent).toContain(`Waiting for you · ${kind === "browser" ? "browser" : "desktop"}`);
      expect(card.querySelector("[data-agent-request]")!.textContent).toContain(kind === "browser" ? "The agent asks you to: Sign in to the shop." : "The agent asks you to: Approve the dialog.");
      expect(card.textContent).toContain(kind === "browser" ? "Done when: The cart page shows." : "Done when: The dialog closes.");
      expect(p.selected()).toBe("Screen");
      // Done twice before the first answers: one answer.
      const done = [...card.querySelectorAll("button")].find((b) => b.textContent === "Done")!;
      await act(async () => { done.click(); done.click(); });
      await act(async () => { release(); });
      await settle();
      expect(outcomes).toEqual(["done"]);
      // Taken: the card's answers stay off until the run's next read takes the ask away (the answer comes back before it).
      expect(done.disabled).toBe(true);
      await act(async () => { done.click(); });
      await settle();
      expect(outcomes).toEqual(["done"]);
    });
  }

  it("while the ask waits, a message steers the run and says it doesn't answer the ask", async () => {
    const p = await screen(async () => DESKTOP_LIVE(), asking("computer"), { onHandBack: async () => ({ hold: "agent" }) });
    expect(p.host.textContent).toContain("A message steers the run; it doesn't answer the ask.");
  });

  it("Cancel answers the ask cancelled; a refusal is said on the card", async () => {
    const outcomes: unknown[] = [];
    const p = await screen(async () => DESKTOP_LIVE(), asking("computer"), { onHandBack: async (o?: string) => { outcomes.push(o); throw new ClientError(409, "handoff_answered", "this ask was already answered: done", false); } });
    await p.click("Cancel");
    expect(outcomes).toEqual(["cancelled"]);
    expect(p.host.querySelector('section[aria-label="Waiting for you at the computer"] [role="alert"]')?.textContent).toBe("this ask was already answered: done");
  });

  it("the ask moves the page to Screen once: the owner can go back to another tab, and Open the screen comes back to it", async () => {
    const p = await screen(async () => DESKTOP_LIVE(), asking("computer"), { onHandBack: async () => ({ hold: "agent" }) });
    expect(p.selected()).toBe("Screen");
    const timeline = [...p.host.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "Timeline") as HTMLElement;
    await act(async () => { timeline.click(); });
    await settle(80);
    expect(p.selected()).toBe("Timeline");
    await p.click("Open the screen");
    expect(p.selected()).toBe("Screen");
  });
});

// Fill the window: a live screen of any kind grows to the whole window and back. The viewer inside draws the page as
// large as it fits at its own shape and maps each click through the canvas it drew (pi-browser's live-view test checks
// that a click lands exactly after the window grows), so here: the same iframe (never reloaded, so the session goes on),
// its frame filling the window, and Esc, from this page or from inside the viewer, or the same button, putting it back.
describe("the live view fills the window", () => {
  const LIVE: RunComputer = { state: "live", kind: "browser", viewer: VIEWER, hold: "agent" };
  const fillButton = (host: HTMLElement) => host.querySelector('button[aria-label="Fill the window"]') as HTMLButtonElement | null;
  const exitButton = (host: HTMLElement) => host.querySelector('button[aria-label="Exit full window (Esc)"]') as HTMLButtonElement | null;
  const frameBox = (host: HTMLElement) => host.querySelector('[data-testid="screen-frame"]') as HTMLElement | null;
  const filling = (host: HTMLElement) => /\bfixed\b/.test(frameBox(host)?.className ?? "") && /\binset-0\b/.test(frameBox(host)?.className ?? "");

  it("the button fills the window with the same viewer, and the same button puts it back", async () => {
    const p = await page(async () => LIVE, working, "screen");
    const before = p.frame();
    expect(before, "the viewer").not.toBeNull();
    expect(filling(p.host)).toBe(false);
    await act(async () => { fillButton(p.host)!.click(); });
    expect(filling(p.host), "the frame fills the window").toBe(true);
    expect(frameBox(p.host)!.getAttribute("role")).toBe("dialog");
    expect(p.frame(), "the same iframe: the viewer isn't reloaded").toBe(before);
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER));
    expect(p.frame()!.className).toMatch(/\bflex-1\b/);
    expect(p.frame()!.className, "no fixed shape: the viewer letterboxes the page itself").not.toMatch(/aspect-/);
    await act(async () => { exitButton(p.host)!.click(); });
    expect(filling(p.host)).toBe(false);
    expect(p.frame()).toBe(before);
    nowhereBut(p.frame(), VIEWER);
  });

  it("Esc puts it back, whether this page or the viewer inside has the keyboard", async () => {
    const p = await page(async () => LIVE, working, "screen");
    await act(async () => { fillButton(p.host)!.click(); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(filling(p.host), "Esc on the page").toBe(false);
    await act(async () => { fillButton(p.host)!.click(); });
    expect(filling(p.host)).toBe(true);
    const inner = p.frame()!.contentWindow! as Window & typeof globalThis;
    await act(async () => { inner.dispatchEvent(new inner.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(filling(p.host), "Esc inside the viewer").toBe(false);
    await act(async () => { fillButton(p.host)!.click(); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
    expect(filling(p.host), "another key leaves it filling the window").toBe(true);
  });

  it("a desktop's Take over is on the full-window bar too, and the view leaves full window when the screen closes", async () => {
    let takes = 0;
    let up = true;
    const desktop = { ...working, computer: { kind: "desktop", provider: "e2b", state: "ready" } } as Run;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, { run: desktop, agentName: "using", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readComputer: async () => (up ? { state: "live", kind: "desktop", viewer: VIEWER, hold: "agent" } : { state: "none", kind: "desktop", hold: "agent", session: "closed" }), computerEvery: 20, tab: "screen", onTakeOver: async () => { takes += 1; return { hold: "pending" }; } } as never)); });
    await settle();
    await act(async () => { fillButton(host)!.click(); });
    expect(filling(host)).toBe(true);
    const take = [...frameBox(host)!.querySelectorAll("button")].find((b) => b.textContent === "Take over");
    expect(take, "Take over on the full-window bar").toBeTruthy();
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent === "Take over")).toHaveLength(1);
    await act(async () => { take!.click(); });
    await settle();
    expect(takes).toBe(1);
    up = false;
    await settle(100);
    expect(host.querySelector("iframe"), "the screen closed").toBeNull();
    expect(frameBox(host), "no full-window frame left over").toBeNull();
    expect(fillButton(host), "nothing to fill the window with").toBeNull();
  });

  it("there is no button while there is no live screen", async () => {
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent", session: "opening" }), working, "screen");
    expect(p.frame()).toBeNull();
    expect(fillButton(p.host)).toBeNull();
  });

  it("Esc inside the viewer still puts it back after a new session replaces the viewer while it fills the window", async () => {
    let newer = false;
    const p = await page(async () => ({ state: "live", kind: "browser", viewer: newer ? VIEWER2 : VIEWER, hold: "agent" }), working, "screen");
    await act(async () => { fillButton(p.host)!.click(); });
    const first = p.frame();
    newer = true;
    await settle(100);
    expect(p.frame(), "a new session is a new iframe").not.toBe(first);
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER2));
    expect(filling(p.host), "still filling the window").toBe(true);
    const inner = p.frame()!.contentWindow! as Window & typeof globalThis;
    await act(async () => { inner.dispatchEvent(new inner.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(filling(p.host), "Esc inside the new viewer").toBe(false);
  });

  it("a refused Take over is said inside the full-window frame, where the person is looking", async () => {
    const desktop = { ...working, computer: { kind: "desktop", provider: "e2b", state: "ready" } } as Run;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, { run: desktop, agentName: "using", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readComputer: async () => ({ state: "live", kind: "desktop", viewer: VIEWER, hold: "agent" }), computerEvery: 20, tab: "screen", onTakeOver: async () => { throw new ClientError(409, "computer_not_live", "this run's desktop is not up now, so there is nothing to take over", false); } } as never)); });
    await settle();
    await act(async () => { fillButton(host)!.click(); });
    const take = [...frameBox(host)!.querySelectorAll("button")].find((b) => b.textContent === "Take over")!;
    await act(async () => { take.click(); });
    await settle();
    expect(frameBox(host)!.querySelector('[role="alert"]')?.textContent).toBe("this run's desktop is not up now, so there is nothing to take over");
    expect(host.querySelectorAll('[role="alert"]'), "said once").toHaveLength(1);
  });

  it("as a dialog it holds the focus: it moves into its bar, Tab stays inside, and closing gives it back to the button", async () => {
    const p = await page(async () => LIVE, working, "screen");
    const opened = fillButton(p.host)!;
    opened.focus();
    await act(async () => { opened.click(); });
    const box = frameBox(p.host)!;
    expect(box.contains(document.activeElement), "focus moved into the frame").toBe(true);
    expect(document.activeElement).toBe(exitButton(p.host));
    // Tab from the last stop (the viewer) wraps to the first; Shift+Tab from the first wraps to the last.
    p.frame()!.focus();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement, "Tab from the viewer wraps to the bar").toBe(exitButton(p.host));
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement, "Shift+Tab from the bar wraps to the viewer").toBe(p.frame());
    // Focus outside the frame is pulled back in on Tab.
    document.body.appendChild(document.createElement("button")).focus();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(box.contains(document.activeElement), "Tab from outside lands inside").toBe(true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(filling(p.host)).toBe(false);
    expect(document.activeElement, "focus back on Fill the window").toBe(fillButton(p.host));
  });
});

// The reads come every `every` ms while nothing is changing, and `soon` while a change is on its way: the screen opening
// (none, opening), a take-over waiting for the agent's step (pending), and a moment after the page's own take-over or
// hand-back, whose answer the next reads catch up with. So the first frame and who drives show when they happen, not
// up to a whole `every` later.
describe("the screen is read again soon while a change is on its way", () => {
  const OPENING: RunComputer = { state: "none", kind: "desktop", hold: "agent", session: "opening" } as RunComputer;
  const LIVE = (hold: "agent" | "pending" | "person"): RunComputer => ({ state: "live", kind: "desktop", viewer: VIEWER, hold });
  async function hook(read: () => Promise<RunComputer>) {
    const seen: { view: ScreenView | null; held: (hold: "agent" | "pending" | "person") => void }[] = [];
    function Probe() {
      const got = useRunScreen(read, true, 5_000, 20);
      seen.push(got);
      return null;
    }
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(Probe)); });
    return () => seen[seen.length - 1]!;
  }

  it("a screen being opened is read soon, so it shows once it is up", async () => {
    let reads = 0;
    const now = await hook(async () => (++reads >= 3 ? LIVE("agent") : OPENING));
    await settle(150);
    expect(now().view?.state).toBe("live");
  });

  it("a pending take-over is read soon, so 'You drive' follows the agent's step", async () => {
    let reads = 0;
    const now = await hook(async () => LIVE(++reads >= 3 ? "person" : "pending"));
    await settle(150);
    expect(now().view?.state === "live" && now().view).toMatchObject({ hold: "person" });
  });

  it("a failed read while a take-over is pending keeps the reads soon", async () => {
    let reads = 0;
    // pending, then one read that fails (a blip), then the person has it.
    const now = await hook(async () => { reads += 1; if (reads === 2) throw new Error("a blip"); return LIVE(reads >= 3 ? "person" : "pending"); });
    await settle(150);
    expect(now().view?.state === "live" && now().view).toMatchObject({ hold: "person" });
  });

  it("after the page's hand-back, the reads catch up soon though its answer still said the person's", async () => {
    let hold: "agent" | "person" = "person";
    let reads = 0;
    const now = await hook(async () => { reads += 1; return LIVE(hold); });
    await settle(60);
    const before = reads;
    // The hand-back's answer, read right after its row was written: the runner hasn't applied it yet.
    await act(async () => { now().held("person"); });
    hold = "agent";
    await settle(150);
    expect(reads - before).toBeGreaterThan(1);
    expect(now().view).toMatchObject({ hold: "agent" });
  });

  it("nothing on its way: the reads keep to every", async () => {
    let reads = 0;
    await hook(async () => { reads += 1; return LIVE("agent"); });
    await settle(200);
    expect(reads).toBe(1);
  });
});

// The run's recordings (its agent's computer.record), from its read: "Recording" while one is written, Export (the run
// files route's ?download=1) for each one finished.
describe("the Screen tab's recording", () => {
  const desktop = { ...working, computer: { kind: "desktop", provider: "docker", state: "ready" } } as Run;
  const rec = (path: string, finished: boolean) => ({ path, computer: "desk", seconds: 12.5, bytes: 4096, finished });
  async function shown(recordings: ReturnType<typeof rec>[]) {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(RunDetail, { run: { ...desktop, recordings }, agentName: "rec", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, readComputer: async () => ({ state: "none", kind: "desktop", hold: "agent", session: "opening" }), computerEvery: 20, tab: "screen", fileUrl: (path: string) => `/v2/runs/${RUN}/files/${path}` } as never));
    });
    await settle();
    const exports = [...host.querySelectorAll("a[download]")] as HTMLAnchorElement[];
    return { text: host.textContent ?? "", exports };
  }
  it("says Recording while a file is written, and offers no Export for it", async () => {
    const { text, exports } = await shown([rec("recordings/desk.mp4", false)]);
    expect(text).toContain("Recording");
    expect(exports).toEqual([]);
  });
  it("exports each finished file through the files route's download, and says nothing of recording then", async () => {
    const { text, exports } = await shown([rec("recordings/desk.mp4", true), rec("recordings/desk-2.mp4", true)]);
    expect(text).not.toContain("Recording");
    expect(exports.map((a) => [a.getAttribute("href"), a.textContent?.trim()])).toEqual([[`/v2/runs/${RUN}/files/recordings/desk.mp4?download=1`, "Export 1"], [`/v2/runs/${RUN}/files/recordings/desk-2.mp4?download=1`, "Export 2"]]);
  });
  it("shows neither for a run that recorded nothing", async () => {
    const { text, exports } = await shown([]);
    expect(text).not.toContain("Recording");
    expect(exports).toEqual([]);
  });
});

// A finished run's recording plays where its live screen was: a muted, inline <video> of the run files route's file (the
// Export's URL with no download flag), sized as the live view is; with several, a picker in the header. A run still
// going keeps its live view.
describe("the Screen tab plays a finished run's recording", () => {
  const done = { ...f.run, status: "completed", state: "idle" } as Run;
  const rec = (path: string, finished = true) => ({ path, computer: "desk", seconds: 12.5, bytes: 4096, finished });
  const URL_OF = (path: string) => `/v2/runs/${RUN}/files/${path}`;
  async function played(run: Run, read: () => Promise<RunComputer>, fileUrl: ((path: string) => string) | null = URL_OF) {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(RunDetail, { run, agentName: "rec", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, readComputer: read, computerEvery: 20, tab: "screen", ...(fileUrl ? { fileUrl } : {}) } as never));
    });
    await settle();
    const panel = host.querySelector('section[aria-label="Screen"]') as HTMLElement;
    return { panel, video: () => panel.querySelector("video"), exports: () => [...panel.querySelectorAll("a[download]")] as HTMLAnchorElement[] };
  }
  const closedDesktop = async () => ({ state: "none", kind: "desktop", hold: "agent", session: "closed" }) as RunComputer;
  const onDesktop = (recordings: ReturnType<typeof rec>[], run: Run = done) => ({ ...run, computer: { kind: "desktop", provider: "docker", state: "ready" }, recordings }) as Run;

  it("a finished desktop run plays its one recording from the file route, inline, muted, and keeps Export", async () => {
    const p = await played(onDesktop([rec("recordings/desk.mp4")]), closedDesktop);
    const video = p.video();
    expect(video, "a player where the live screen was").toBeTruthy();
    expect(video!.getAttribute("src")).toBe(URL_OF("recordings/desk.mp4"));
    expect(video!.hasAttribute("controls")).toBe(true);
    expect(video!.muted).toBe(true);
    expect(video!.hasAttribute("playsinline")).toBe(true);
    expect(video!.getAttribute("preload")).toBe("metadata");
    expect(video!.className).toContain("aspect-[16/10]");
    expect(p.panel.textContent).not.toContain("closed when the run ended");
    expect(p.exports().map((a) => a.getAttribute("href"))).toEqual([`${URL_OF("recordings/desk.mp4")}?download=1`]);
  });

  it("a finished phone run's player is framed as the phone is, at the height below it", async () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "VIDEO") return rect(350, 0);
      if (this.hasAttribute("data-scroll-pane")) return rect(200, 600);
      return rect(0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-scroll-pane") ? 600 : 0; });
    const run = { ...done, computer: { kind: "phone", provider: "phone-harness", state: "ready" }, recordings: [rec("recordings/phone.mp4")] } as Run;
    const p = await played(run, async () => ({ state: "none", kind: "phone", hold: "agent", session: "closed" }));
    const video = p.video();
    expect(video!.getAttribute("src")).toBe(URL_OF("recordings/phone.mp4"));
    expect(video!.className).toContain("aspect-[9/19]");
    expect(video!.style.height).toBe(`${600 - 150 - 32}px`);
  });

  it("a live phone whose run ends in its recording fits the player, not the frame it replaced, and refits it", async () => {
    let paneHeight = 600;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "IFRAME") return rect(350, 0);
      if (this.tagName === "VIDEO") return rect(300, 0);
      if (this.hasAttribute("data-scroll-pane")) return rect(200, paneHeight);
      return rect(0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-scroll-pane") ? paneHeight : 0; });
    const phone = { computer: { kind: "phone", provider: "phone-harness", state: "ready" }, recordings: [rec("recordings/phone.mp4")] };
    const props = (run: Run) => ({ run, agentName: "rec", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, readComputer: async () => ({ state: "live", kind: "phone", viewer: VIEWER, hold: "agent" }), computerEvery: 20, tab: "screen", fileUrl: URL_OF }) as never;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, props({ ...working, ...phone } as Run))); });
    await settle();
    expect((host.querySelector("iframe") as HTMLIFrameElement).style.height).toBe(`${600 - 150 - 32}px`);
    await act(async () => { root!.render(createElement(RunDetail, props({ ...done, ...phone } as Run))); });
    await settle();
    const video = () => host.querySelector("video") as HTMLVideoElement;
    expect(host.querySelector("iframe")).toBeNull();
    expect(video().style.height).toBe(`${600 - 100 - 32}px`);
    paneHeight = 650;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(video().style.height).toBe(`${650 - 100 - 32}px`);
  });

  it("with several recordings, a picker in the header plays the one picked; every Export stays", async () => {
    const p = await played(onDesktop([rec("recordings/desk.mp4"), rec("recordings/desk-2.mp4")]), closedDesktop);
    expect(p.video()!.getAttribute("src")).toBe(URL_OF("recordings/desk.mp4"));
    const picker = p.panel.querySelector('header [role="radiogroup"]') as HTMLElement;
    expect(picker, "the picker sits in the header").toBeTruthy();
    const second = [...picker.querySelectorAll("input")][1] as HTMLInputElement;
    await act(async () => { second.click(); });
    expect(p.video()!.getAttribute("src")).toBe(URL_OF("recordings/desk-2.mp4"));
    expect(p.exports()).toHaveLength(2);
  });

  it("one finished recording has no picker, and one still being written is not played", async () => {
    const p = await played(onDesktop([rec("recordings/desk.mp4"), rec("recordings/desk-2.mp4", false)]), closedDesktop);
    expect(p.video()!.getAttribute("src")).toBe(URL_OF("recordings/desk.mp4"));
    expect(p.panel.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("a run still going keeps its live view and its Recording chip: no player", async () => {
    const p = await played(onDesktop([rec("recordings/desk.mp4"), rec("recordings/desk-2.mp4", false)], working), async () => ({ state: "live", kind: "desktop", viewer: VIEWER, hold: "agent" }));
    expect(p.video()).toBeNull();
    expect(p.panel.querySelector("iframe")).toBeTruthy();
    expect(p.panel.textContent).toContain("Recording");
  });

  it("a finished run with no file route says its words, with no player", async () => {
    const p = await played(onDesktop([rec("recordings/desk.mp4")]), closedDesktop, null);
    expect(p.video()).toBeNull();
    expect(p.panel.textContent).toContain("The desktop closed when the run ended.");
  });
});

// A finished run's recording has the run's steps beside it: the timeline's own steps that began while the file was
// recorded, each at its time on the video (its row's time less the time of the row that says the recording began). A
// step is a button that moves the video there; the step the video is at is marked. With no row that says when the
// recording began there is no list, and the player is alone as before.
describe("the Screen tab's recording has the run's steps beside it", () => {
  const done = { ...f.run, status: "completed", state: "idle" } as Run;
  const URL_OF = (path: string) => `/v2/runs/${RUN}/files/${path}`;
  const rec = (path: string) => ({ path, computer: "desk", seconds: 60, bytes: 4096, finished: true });
  const recorded = (recordings: ReturnType<typeof rec>[]) => ({ ...done, computer: { kind: "desktop", provider: "docker", state: "ready" }, recordings }) as Run;
  const at = (s: number) => new Date(Date.parse("2026-11-05T09:00:00Z") + s * 1000).toISOString();
  let n = 0;
  const row = (kind: TimelineRow["kind"], summary: string, timestamp: string, more: Partial<TimelineRow> = {}) => ({
    id: `v${(n += 1)}`, seq: n, kind, summary, text: null, timestamp, created_at: timestamp, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null,
    tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, ...more,
  }) as TimelineRow;
  const ROWS = [
    row("user_message", "You: Find the cheapest nonstop.", at(-20)),
    row("phase", "Recording the desktop's screen into recordings/desk.mp4.", at(0)),
    row("tool_use", "computer_act", at(4), { tool_name: "computer_act", tool_use_id: "c1" }),
    row("tool_result", "Opened Chrome: ok", at(6), { tool_name: "computer_act", tool_use_id: "c1", tool_status: "success" }),
    row("phase", "You took over the desktop", at(75 - 60)),
    row("tool_use", "computer_act", at(31), { tool_name: "computer_act", tool_use_id: "c2" }),
    row("tool_result", "Clicked “Sort”: no element with that name", at(32), { tool_name: "computer_act", tool_use_id: "c2", tool_status: "failed" }),
    row("phase", "Recording the desktop's screen into recordings/desk-2.mp4.", at(200)),
    row("final_answer", "Skyline 214, $238.", at(210)),
  ];
  async function played(run: Run, rows: TimelineRow[]) {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(RunDetail, { run, agentName: "rec", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, readComputer: async () => ({ state: "none", kind: "desktop", hold: "agent", session: "closed" }), computerEvery: 20, tab: "screen", fileUrl: URL_OF } as never));
    });
    await settle();
    const panel = host.querySelector('section[aria-label="Screen"]') as HTMLElement;
    const list = () => panel.querySelector('ol[aria-label="The recording\'s steps"]');
    const steps = () => [...(list()?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
    return { panel, video: () => panel.querySelector("video") as HTMLVideoElement, list, steps, said: () => steps().map((b) => b.textContent), current: () => steps().filter((b) => b.getAttribute("aria-current") === "step").map((b) => b.textContent) };
  }

  it("lists the steps made while the file was recorded, each at its time on the video, in the timeline's words", async () => {
    const p = await played(recorded([rec("recordings/desk.mp4")]), ROWS);
    expect(p.said()).toEqual([
      "0:00PhaseRecording the desktop's screen into recordings/desk.mp4.",
      "0:06Computer actOpened Chrome",
      "0:15PhaseYou took over the desktop",
      "0:32Computer actClicked “Sort”: no element with that name",
    ]);
    // What came before the recording, and after its length, is not a step of this video.
    expect(p.panel.textContent).not.toContain("Find the cheapest nonstop");
    expect(p.panel.textContent).not.toContain("Skyline 214");
    // A step that failed reads as failed.
    expect(p.steps()[3]!.querySelector(".text-destructive-text")?.textContent).toBe("Clicked “Sort”: no element with that name");
    // The player is the same one: the file route's file, sized as the live view is.
    expect(p.video().getAttribute("src")).toBe(URL_OF("recordings/desk.mp4"));
    expect(p.video().className).toContain("aspect-[16/10]");
  });

  // The run's trace, as far as these cases read it: its two computer calls, by the ids their timeline rows carry.
  const call = (id: string, startedAt: string, status: "ok" | "failed") => ({ id: `t:0:${id}`, kind: "tool", parent_id: null, name: "computer_act", agent_label: null, started_at: startedAt, ended_at: startedAt, status, stop_reason: null, tokens: null, usd: null, charged: false, decision: false, not_metered: false, tool_use_id: id, input_preview: null, result_preview: null, result_size_bytes: null });
  const TRACE = { run_id: RUN, model_requests: "priced", dropped: 0, spans: [call("c1", at(4), "ok"), call("c2", at(31), "failed"), call("c9", at(205), "ok")] };
  async function traced(run: Run, rows: TimelineRow[], tab: "screen" | "trace" = "screen") {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(RunDetail, { run, agentName: "rec", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, readComputer: async () => ({ state: "none", kind: "desktop", hold: "agent", session: "closed" }), computerEvery: 20, tab, fileUrl: URL_OF, readTrace: async () => TRACE } as never));
    });
    await settle();
    const tabNow = () => host.querySelector('[role=tab][aria-selected="true"]')!.textContent;
    const toDevTools = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Open this step in Dev tools") as HTMLButtonElement | undefined;
    const callPanel = () => host.querySelector("aside[aria-label='Call details']");
    const toRecording = () => [...(callPanel()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Show on the recording") as HTMLButtonElement | undefined;
    const steps = () => [...host.querySelectorAll('ol[aria-label="The recording\'s steps"] button')] as HTMLButtonElement[];
    const press = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
    return { host, tabNow, toDevTools, callPanel, toRecording, steps, press, video: () => host.querySelector("video") as HTMLVideoElement };
  }

  it("the step the video is at opens in Dev tools when it is a tool call: the tab opens on that call's details", async () => {
    const p = await traced(recorded([rec("recordings/desk.mp4")]), ROWS);
    // At the recording's start the video is at a phase, which is no call: the button is there and says why it is off.
    expect([p.toDevTools()!.disabled, p.toDevTools()!.title]).toEqual([true, "The step the video is at is not a tool call"]);
    await p.press(p.steps()[3]);
    expect(p.toDevTools()!.disabled).toBe(false);
    await p.press(p.toDevTools());
    expect(p.tabNow()).toBe("Dev tools");
    // The failed click, by its call's id: the panel is that call's, and its row is the one marked open.
    expect(p.callPanel()!.textContent).toMatch(/^Tool callFailedcomputer_act/);
    expect([...p.host.querySelectorAll("section[aria-label='Trace'] > div > table > tbody > tr button[aria-pressed='true']")]).toHaveLength(1);
  });

  it("a call's details in Dev tools show it on the recording made while it ran: the Screen tab plays from the call's time", async () => {
    const p = await traced(recorded([rec("recordings/desk.mp4")]), ROWS, "trace");
    const row = (n: number) => p.host.querySelectorAll("section[aria-label='Trace'] > div > table > tbody > tr")[n]!;
    // The call made after the recording's length is on no recording: its panel offers none.
    await p.press(row(2));
    expect(p.toRecording()).toBeUndefined();
    await p.press(row(0));
    await p.press(p.toRecording());
    expect(p.tabNow()).toBe("Screen");
    // The player takes no time before it knows the video's length: it moves once it does.
    expect(p.video().currentTime).toBe(0);
    await act(async () => { p.video().dispatchEvent(new Event("loadedmetadata")); });
    // The first computer call's result came 6 s into the recording, where its step is.
    expect(p.video().currentTime).toBe(6);
  });

  it("opens the very call a step is, though another conversation made a call of the same id, and shows that one on the recording", async () => {
    // A subagent's conversation (1) makes a call with the id the run's own first call has: two spans, two steps.
    const rows = [...ROWS.slice(0, 7),
      row("tool_use", "computer_act", at(40), { tool_name: "computer_act", tool_use_id: "c1", conversation_id: 1 }),
      row("tool_result", "Typed the query: ok", at(42), { tool_name: "computer_act", tool_use_id: "c1", conversation_id: 1, tool_status: "success" }),
      ...ROWS.slice(7)];
    const twice = { ...TRACE, spans: [TRACE.spans[0]!, TRACE.spans[1]!, { ...call("c1", at(40), "ok"), id: "t:1:c1" }] };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(RunDetail, { run: recorded([rec("recordings/desk.mp4")]), agentName: "rec", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, readComputer: async () => ({ state: "none", kind: "desktop", hold: "agent", session: "closed" }), computerEvery: 20, tab: "screen", fileUrl: URL_OF, readTrace: async () => twice } as never));
    });
    await settle();
    const press = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
    const button = (words: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === words);
    const steps = [...host.querySelectorAll('ol[aria-label="The recording\'s steps"] button')];
    expect(steps.map((b) => b.textContent)).toContain("0:42Computer actTyped the query");
    await press(steps.find((b) => b.textContent === "0:42Computer actTyped the query"));
    await press(button("Open this step in Dev tools"));
    // The subagent's call, by its span, never the run's own call of the same id.
    const details = () => host.querySelector("aside[aria-label='Call details']")!;
    expect(details().textContent).toContain("Spant:1:c1");
    await press(button("Show on the recording"));
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("loadedmetadata")); });
    expect(host.querySelector("video")!.currentTime).toBe(42);
  });

  it("brings a call opened from the recording into view, as one opened from the table is", async () => {
    // Under the wide layout the details sit below the table: far down the page here.
    const into = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = into;
    const box = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return { top: this.tagName === "ASIDE" ? 5000 : 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect; });
    try {
      const p = await traced(recorded([rec("recordings/desk.mp4")]), ROWS);
      await p.press(p.steps()[3]);
      await p.press(p.toDevTools());
      expect(p.callPanel()).toBeTruthy();
      expect(into.mock.contexts.some((el) => (el as Element).tagName === "ASIDE")).toBe(true);
    } finally {
      box.mockRestore();
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("says so when a step's call is past what the trace returned, and opens no other call", async () => {
    // A read serves a run's first spans: this one left the failed click out, with 12 more.
    const short = { ...TRACE, spans: [TRACE.spans[0]!], dropped: 12 };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(RunDetail, { run: recorded([rec("recordings/desk.mp4")]), agentName: "rec", messages: messageFeatures, harnessSteers: true, rows: ROWS, files: [], actions: {}, readComputer: async () => ({ state: "none", kind: "desktop", hold: "agent", session: "closed" }), computerEvery: 20, tab: "screen", fileUrl: URL_OF, readTrace: async () => short } as never));
    });
    await settle();
    const press = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
    await press([...host.querySelectorAll('ol[aria-label="The recording\'s steps"] button')][3]);
    await press([...host.querySelectorAll("button")].find((b) => b.textContent === "Open this step in Dev tools"));
    expect(host.querySelector('[role=tab][aria-selected="true"]')!.textContent).toBe("Dev tools");
    expect(host.querySelector("aside[aria-label='Call details']")).toBeNull();
    expect(host.textContent).toContain("That step's call is not in this traceThe trace shows the run's first 1 requests and calls, and that call came after them.");
  });

  it("offers neither where the trace can't be read, or while the run can still open its computer", async () => {
    const p = await played(recorded([rec("recordings/desk.mp4")]), ROWS);
    expect([...p.panel.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Open this step in Dev tools");
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    const live = await traced({ ...recorded([rec("recordings/desk.mp4")]), status: "working", state: "working" } as Run, ROWS, "trace");
    await live.press(live.host.querySelectorAll("section[aria-label='Trace'] > div > table > tbody > tr")[0]);
    expect(live.callPanel()).toBeTruthy();
    expect(live.toRecording()).toBeUndefined();
  });

  it("a step moves the video to its time and is marked; the mark follows the video as it plays", async () => {
    const p = await played(recorded([rec("recordings/desk.mp4")]), ROWS);
    expect(p.current()).toEqual(["0:00PhaseRecording the desktop's screen into recordings/desk.mp4."]);
    await act(async () => { p.steps()[2]!.click(); });
    expect(p.video().currentTime).toBe(15);
    expect(p.current()).toEqual(["0:15PhaseYou took over the desktop"]);
    // The video plays on past the next step: the mark moves with it, on the player's own events.
    await act(async () => { p.video().currentTime = 33; p.video().dispatchEvent(new Event("timeupdate")); });
    expect(p.current()).toEqual(["0:32Computer actClicked “Sort”: no element with that name"]);
    // Dragged back with the player's own bar.
    await act(async () => { p.video().currentTime = 7; p.video().dispatchEvent(new Event("seeked")); });
    expect(p.current()).toEqual(["0:06Computer actOpened Chrome"]);
  });

  it("another recording picked has its own steps, from its own start", async () => {
    const p = await played(recorded([rec("recordings/desk.mp4"), rec("recordings/desk-2.mp4")]), ROWS);
    const second = [...p.panel.querySelectorAll('header [role="radiogroup"] input')][1] as HTMLInputElement;
    await act(async () => { second.click(); });
    expect(p.video().getAttribute("src")).toBe(URL_OF("recordings/desk-2.mp4"));
    expect(p.said()).toEqual(["0:00PhaseRecording the desktop's screen into recordings/desk-2.mp4.", "0:10AnswerSkyline 214, $238."]);
  });

  it("steps that arrive after the player is drawn come beside the same player: it is not made again", async () => {
    const run = recorded([rec("recordings/desk.mp4")]);
    const props = (rows: TimelineRow[]) => ({ run, agentName: "rec", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, readComputer: async () => ({ state: "none", kind: "desktop", hold: "agent", session: "closed" }), computerEvery: 20, tab: "screen", fileUrl: URL_OF }) as never;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, props([]))); });
    await settle();
    const before = host.querySelector("video") as HTMLVideoElement;
    expect(host.querySelector('ol[aria-label="The recording\'s steps"]')).toBeNull();
    before.currentTime = 7;
    // The timeline's pages come in.
    await act(async () => { root!.render(createElement(RunDetail, props(ROWS))); });
    await settle();
    expect(host.querySelector("video"), "the same element").toBe(before);
    expect(before.currentTime).toBe(7);
    const marked = [...host.querySelectorAll('ol[aria-label="The recording\'s steps"] button[aria-current="step"]')].map((b) => b.textContent);
    expect(marked, "marked where the video already is").toEqual(["0:06Computer actOpened Chrome"]);
  });

  it("with no row that says when the recording began there is no list: the player alone", async () => {
    const p = await played(recorded([rec("recordings/desk.mp4")]), ROWS.filter((r) => r.kind !== "phase"));
    expect(p.list()).toBeNull();
    expect(p.panel.textContent).not.toContain("Steps");
    expect(p.video().getAttribute("src")).toBe(URL_OF("recordings/desk.mp4"));
  });
});

// A live screen has the run's steps so far beside it: the timeline's own steps and words, oldest first, the list kept at
// its newest step as steps come until the reader scrolls up. With the steps beside it the panel is wider than the reading
// column, so the frame keeps its size; alone (no step yet, or nothing live) it keeps the reading column's width.
describe("the Screen tab's live screen has the run's steps beside it", () => {
  const live = async () => ({ state: "live", kind: "desktop", viewer: VIEWER, hold: "agent" }) as RunComputer;
  const onDesktop = (run: Run = working) => ({ ...run, computer: { kind: "desktop", provider: "docker", state: "ready" } }) as Run;
  const at = (s: number) => new Date(Date.parse("2026-11-05T09:00:00Z") + s * 1000).toISOString();
  let n = 0;
  const row = (kind: TimelineRow["kind"], summary: string, timestamp: string, more: Partial<TimelineRow> = {}) => ({
    id: `l${(n += 1)}`, seq: n, kind, summary, text: null, timestamp, created_at: timestamp, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null,
    tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, ...more,
  }) as TimelineRow;
  const ROWS = [
    row("user_message", "You: Find the cheapest nonstop.", at(0)),
    row("phase", "The desktop is ready: Linux (amd64), from Docker.", at(4)),
    row("tool_use", "computer_act", at(6), { tool_name: "computer_act", tool_use_id: "a1" }),
    row("tool_result", "Opened Chrome: ok", at(8), { tool_name: "computer_act", tool_use_id: "a1", tool_status: "success" }),
    row("usage", "Cost so far: $0.02", at(9)),
  ];
  const NEXT = [
    row("tool_use", "computer_act", at(12), { tool_name: "computer_act", tool_use_id: "a2" }),
    row("tool_result", "Clicked “Sort”: no element with that name", at(13), { tool_name: "computer_act", tool_use_id: "a2", tool_status: "failed" }),
  ];
  function mount() {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const draw = async (rows: TimelineRow[], run: Run = onDesktop(), read: () => Promise<RunComputer> = live) => {
      await act(async () => {
        root!.render(createElement(RunDetail, { run, agentName: "live", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, readComputer: read, computerEvery: 20, tab: "screen" } as never));
      });
      await settle();
    };
    // The box that scrolls: a named region the keyboard can stop on, the list inside it.
    const list = () => host.querySelector('[role="region"][aria-label="The run\'s steps"]') as HTMLElement | null;
    // A step's words without its time of day, which is the reader's own clock's.
    const said = () => [...(list()?.querySelectorAll("li") ?? [])].map((li) => (li.textContent ?? "").replace(/^\d{1,2}:\d{2}\s?[AP]M/, ""));
    const panel = () => host.querySelector('section[aria-label="Screen"]') as HTMLElement;
    return { host, draw, list, said, panel, frame: () => host.querySelector("iframe") as HTMLIFrameElement };
  }

  it("lists the run's steps so far in the timeline's words, a tool once, without the cost row, and says the run is working", async () => {
    const p = mount();
    await p.draw(ROWS);
    expect(p.frame().getAttribute("src")).toBe(`${FRAMED(VIEWER)}&hands=page`);
    expect(p.said()).toEqual(["YouFind the cheapest nonstop.", "PhaseThe desktop is ready: Linux (amd64), from Docker.", "Computer actOpened Chrome", " Working"]);
    expect(p.panel().textContent).toContain("3 steps so far");
    expect(p.panel().textContent).not.toContain("Cost so far");
    // A step that failed reads as failed.
    await p.draw([...ROWS, ...NEXT]);
    expect(p.said().at(-2)).toBe("Computer actClicked “Sort”: no element with that name");
    expect(p.list()!.querySelector(".text-destructive-text")?.textContent).toBe("Clicked “Sort”: no element with that name");
    expect(p.panel().textContent).toContain("4 steps so far");
  });

  it("a run that waits on its person is not said to be working", async () => {
    const p = mount();
    await p.draw(ROWS, onDesktop({ ...working, status: "input_required", state: "waiting" } as Run));
    expect(p.said()).toEqual(["YouFind the cheapest nonstop.", "PhaseThe desktop is ready: Linux (amd64), from Docker.", "Computer actOpened Chrome"]);
  });

  it("the first steps come beside the same frame: the viewer is not loaded again", async () => {
    const p = mount();
    await p.draw([]);
    const before = p.frame();
    expect(before, "the frame, alone").toBeTruthy();
    expect(p.list()).toBeNull();
    await p.draw(ROWS);
    expect(p.frame(), "the same element").toBe(before);
    expect(p.list()).toBeTruthy();
  });

  it("stays at its newest step as steps come, until the reader scrolls up; back at the end it follows again", async () => {
    const p = mount();
    await p.draw(ROWS);
    const box = p.list()!;
    // jsdom lays nothing out: the list's own sizes are given, a box 100px tall over 400px of steps.
    let height = 400;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 100 });
    height = 460;
    await p.draw([...ROWS, NEXT[0]!]);
    expect(box.scrollTop, "followed the new step").toBe(460);
    // The reader scrolls up to an earlier step.
    await act(async () => { box.scrollTop = 120; box.dispatchEvent(new Event("scroll", { bubbles: true })); });
    height = 520;
    await p.draw([...ROWS, ...NEXT]);
    expect(box.scrollTop, "left where the reader put it").toBe(120);
    // Back at the end (within a line of it).
    await act(async () => { box.scrollTop = 410; box.dispatchEvent(new Event("scroll", { bubbles: true })); });
    height = 580;
    await p.draw([...ROWS, ...NEXT, row("thinking", "Thinking: Try the menu instead.", at(20))]);
    expect(box.scrollTop, "follows again").toBe(580);
  });

  it("follows a step whose words change without a new step: a call's result takes its call's place", async () => {
    const p = mount();
    const call = row("tool_use", "computer_act", at(12), { tool_name: "computer_act", tool_use_id: "b1" });
    await p.draw([...ROWS, call]);
    const box = p.list()!;
    let height = 400;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 100 });
    await act(async () => { box.scrollTop = 300; box.dispatchEvent(new Event("scroll", { bubbles: true })); });
    // The result folds into its call's step (the count stays), with words that take more lines.
    height = 470;
    await p.draw([...ROWS, call, row("tool_result", "Clicked the check box “Nonstop only”, clicked the pop-up “Sort”, clicked “Price: low to high”: ok", at(14), { tool_name: "computer_act", tool_use_id: "b1", tool_status: "success" })]);
    expect(p.said().filter((s) => s !== " Working")).toHaveLength(4);
    expect(box.scrollTop, "followed the longer words").toBe(470);
  });

  it("the list's box is a named region the keyboard can stop on: it scrolls and holds no control", async () => {
    const p = mount();
    await p.draw(ROWS);
    const box = p.list()!;
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.querySelector("button, a, input")).toBeNull();
    expect(box.querySelector("ol")).toBeTruthy();
  });

  it("is wider than the reading column with its steps, and the reading column's width alone", async () => {
    const p = mount();
    await p.draw([]);
    expect(p.panel().parentElement!.className).toContain("max-w-4xl");
    await p.draw(ROWS);
    expect(p.panel().parentElement!.className).toContain("max-w-7xl");
    expect(p.panel().parentElement!.className).not.toContain("max-w-4xl");
  });

  it("a screen that is not up has no steps beside it: its words alone, in the reading column", async () => {
    const p = mount();
    await p.draw(ROWS, onDesktop(), async () => ({ state: "none", kind: "desktop", hold: "agent", session: "opening" }));
    expect(p.list()).toBeNull();
    expect(p.panel().textContent).toContain("Waiting for the desktop");
    expect(p.panel().parentElement!.className).toContain("max-w-4xl");
  });

  it("a browser's live page has them too", async () => {
    const p = mount();
    await p.draw(ROWS, { ...working, computer: { kind: "browser", provider: "local", state: "ready" } } as Run, async () => ({ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }));
    expect(p.frame().getAttribute("src")).toBe(FRAMED(VIEWER));
    expect(p.said().slice(0, 3)).toEqual(["YouFind the cheapest nonstop.", "PhaseThe desktop is ready: Linux (amd64), from Docker.", "Computer actOpened Chrome"]);
  });
});
