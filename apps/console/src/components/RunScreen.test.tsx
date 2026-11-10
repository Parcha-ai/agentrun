import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import { ClientError } from "@/lib/client";
import type { Run, RunComputer } from "@/lib/v2";

// The run page's Screen tab, over GET /v2/runs/{id}/computer (owner session only, no-store): `off` (no browser, or it
// resolves unavailable) hides it; `none` (one, with no session open yet or any more) waits; `live` embeds the session's
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
  const base = { sha: null, updated_at: "2026-11-05T09:00:00Z", poll_after_ms: 0, run_id: RUN, agent_id: "browsing", agent_version: 1, revision: "rv1", kind: "agentic", status: "working", state: "working", title: "Look", created_at: "2026-11-05T09:00:00Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null } as Run;
  async function live(caps: unknown) {
    const reads: string[] = [];
    const v2 = {
      getRun: async () => base, listFiles: async () => ({ run_id: RUN, files: [], complete: true, truncated: false }),
      getTimeline: async () => ({ run_id: RUN, status: "working", state: "working", rows: [], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 0 }),
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

  it("waits for the browser when the run has one and no page is open yet", async () => {
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent" }));
    expect(p.tabButton()!.textContent).toBe("Screen");
    await p.open();
    expect(p.host.textContent).toContain("Waiting for the browser");
    expect(p.frame()).toBeNull();
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
    const answers: RunComputer[] = [{ state: "live", kind: "browser", viewer: VIEWER, hold: "agent" }, { state: "none", kind: "browser", hold: "agent" }, { state: "live", kind: "browser", viewer: VIEWER2, hold: "agent" }];
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
    const p = await page(async () => { reads++; return { state: "none", kind: "browser", hold: "agent" }; }, done, "screen");
    await settle(150);
    const text = p.host.querySelector('section[aria-label="Screen"]')?.textContent ?? "";
    expect(text).toContain("The browser closed when the run ended.");
    expect(text).not.toContain("Waiting for the browser");
    expect(reads).toBe(1);
  });

  it("a follow-up's line shows only where the run takes one: a completed run does, a cancelled one does not", async () => {
    const completed = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const p = await page(async () => ({ state: "none", kind: "browser", hold: "agent" }), completed, "screen");
    expect(p.host.textContent).toContain("A follow-up opens a new one if the agent needs it.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const cancelled = { ...working, status: "cancelled", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const q = await page(async () => ({ state: "none", kind: "browser", hold: "agent" }), cancelled, "screen");
    expect(q.host.textContent).toContain("The browser closed when the run ended.");
    expect(q.host.textContent).not.toContain("A follow-up opens");
  });

  it("while the run waits on its question with its session held, it still reads and still waits for the browser", async () => {
    let reads = 0;
    const asking = { ...working, status: "input_required", state: "waiting" } as Run;
    const p = await page(async () => { reads++; return { state: "none", kind: "browser", hold: "agent" }; }, asking, "screen");
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
    const p = await moving(async () => ({ state: "none", kind: "browser", hold: "agent" }), paused);
    await settle(80);
    expect(p.section()).toContain("Waiting for the browser");
    expect(p.section()).not.toContain("closed when the run ended");
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
    expect(panel.querySelector("button")).toBeNull();
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
  type Extra = { onTakeOver?: unknown; onHandBack?: unknown; readComputers?: unknown; tab?: "screen" };
  async function screen(read: () => Promise<RunComputer>, run: Run, extra: Extra = {}) {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const show = (r: Run) => act(async () => { root!.render(createElement(RunDetail, { run: r, agentName: "using", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readComputer: read, computerEvery: 20, ...extra } as never)); });
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
    expect(p.panel()!.querySelector("iframe")!.getAttribute("src")).toBe(FRAMED(VIEWER));
    expect(p.panel()!.textContent).toContain("The agent drives · desktop");
    await p.click("Take over");
    expect(takes).toBe(1);
    expect(p.panel()!.textContent).toContain("Yours after the agent's step");
    expect(p.button("Taking over")!.disabled).toBe(true);
    nowhereBut(p.panel()!.querySelector("iframe"), VIEWER);
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
