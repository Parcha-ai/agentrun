import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import { ClientError } from "@/lib/client";
import type { Run, RunBrowser } from "@/lib/v2";

// The run page's Browser tab, over GET /v2/runs/{id}/browser (owner session only, no-store): `off` (no browser, or it
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
const VIEWER = `/v2/runs/${RUN}/browser/live/v/AbCdEfGhIjKlMnOpQrStUv#t=SECRET-TOKEN-one-1234567890`;
const VIEWER2 = `/v2/runs/${RUN}/browser/live/v/ZyXwVuTsRqPoNmLkJiHgFe#t=SECRET-TOKEN-two-0987654321`;
/** What the iframe frames: the served viewer resolved against this page's origin (a same-origin path, its fragment kept). */
const FRAMED = (viewer: string) => new URL(viewer, location.origin).href;
const settle = async (ms = 60) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function page(read: () => Promise<RunBrowser>, run: Run = working, tab?: "browser") {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(RunDetail, { run, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readBrowser: read, browserEvery: 20, ...(tab ? { tab } : {}) } as never));
  });
  await settle();
  const tabButton = () => [...host.querySelectorAll('[role="tab"]')].find((b) => /^(Browser|Watch live)$/.test(b.textContent ?? "")) as HTMLElement | undefined;
  const open = async () => { const b = tabButton(); expect(b, "the Browser tab").toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
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
describe("the run page reads the run's browser, whatever its capabilities list", () => {
  const base = { run_id: RUN, agent_id: "browsing", agent_version: 1, revision: "rv1", kind: "agentic", status: "working", state: "working", title: "Look", created_at: "2026-11-05T09:00:00Z", ended_at: null, result: null, error: null, cost: null, archived_at: null } as Run;
  async function live(caps: unknown) {
    const reads: string[] = [];
    const v2 = {
      getRun: async () => base, listFiles: async () => ({ run_id: RUN, files: [], complete: true, truncated: false }),
      getTimeline: async () => ({ run_id: RUN, status: "working", state: "working", rows: [], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 0 }),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      runBrowser: async (id: string) => { reads.push(id); return { state: "live", viewer: VIEWER }; },
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
    expect([...p.host.querySelectorAll('[role="tab"]')].some((b) => b.textContent === "Watch live")).toBe(true);
  });
});

describe("the run page's Browser tab", () => {
  it("is not there for a run with no browser (state off)", async () => {
    const p = await page(async () => ({ state: "off", reason: "no browser key" }));
    expect(p.tabButton()).toBeUndefined();
    expect(p.frame()).toBeNull();
  });

  it("is not there for a caller the route refuses (403)", async () => {
    const p = await page(async () => { throw new ClientError(403, "forbidden", "no", false); });
    expect(p.tabButton()).toBeUndefined();
  });

  it("a 404 is a failed read like any other: it reads again, and the tab comes once the route answers", async () => {
    let n = 0;
    const p = await page(async () => { n += 1; if (n === 1) throw new ClientError(404, "not_found", "no", false); return { state: "live", viewer: VIEWER }; });
    await settle(120);
    expect(n).toBeGreaterThan(1);
    expect(p.tabButton()?.textContent).toBe("Watch live");
  });

  it("waits for the browser when the run has one and no page is open yet: the tab reads Browser", async () => {
    const p = await page(async () => ({ state: "none" }));
    expect(p.tabButton()!.textContent).toBe("Browser");
    await p.open();
    expect(p.host.textContent).toContain("Waiting for the browser");
    expect(p.frame()).toBeNull();
  });

  it("embeds the live session's viewer under Watch live: the iframe's src is the viewer on this origin, and the viewer is nowhere else", async () => {
    const p = await page(async () => ({ state: "live", viewer: VIEWER }));
    expect(p.tabButton()!.textContent).toBe("Watch live");
    await p.open();
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER));
    expect(p.frame()!.getAttribute("title")).toBe("The run's browser");
    nowhereBut(p.frame(), VIEWER);
  });

  it("frames the viewer with only what its page needs: its own scripts, its own origin for the WebSocket and the cookie, and its address bar's form", async () => {
    const p = await page(async () => ({ state: "live", viewer: VIEWER }), working, "browser");
    expect(p.frame()!.getAttribute("sandbox")?.split(/\s+/).sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(p.frame()!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("follows the session: live, then none at release, then live again with the new viewer, never the old one", async () => {
    const answers: RunBrowser[] = [{ state: "live", viewer: VIEWER }, { state: "none" }, { state: "live", viewer: VIEWER2 }];
    let i = 0;
    const p = await page(async () => answers[Math.min(i++, answers.length - 1)], working, "browser");
    for (let n = 0; n < 20 && i < answers.length; n++) await settle(30);
    await settle(60);
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER2));
    expect(p.host.innerHTML).not.toContain("SECRET-TOKEN-one");
    nowhereBut(p.frame(), VIEWER2);
  });

  it("a newer session while one is live (no none between) moves the iframe to the newer viewer at once", async () => {
    // The server answers the newest live session (#1685: one hand-over per session; GET /browser the newest that answers).
    let newer = false;
    const p = await page(async () => ({ state: "live", viewer: newer ? VIEWER2 : VIEWER }), working, "browser");
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
    const p = await page(async () => { if (i++ === 0) return { state: "live", viewer: VIEWER }; throw new Error(`GET /v2/runs/${RUN}/browser: 502`); }, working, "browser");
    await settle(120);
    expect(p.frame()!.getAttribute("src")).toBe(FRAMED(VIEWER));
    nowhereBut(p.frame(), VIEWER);
  });

  it("on an ended run, none reads that the browser closed, never that it waits; nothing more is read", async () => {
    let reads = 0;
    const done = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const p = await page(async () => { reads++; return { state: "none" }; }, done, "browser");
    await settle(150);
    const text = p.host.querySelector('section[aria-label="Browser"]')?.textContent ?? "";
    expect(text).toContain("The browser closed when the run ended.");
    expect(text).not.toContain("Waiting for the browser");
    expect(reads).toBe(1);
  });

  it("a follow-up's line shows only where the run takes one: a completed run does, a cancelled one does not", async () => {
    const completed = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const p = await page(async () => ({ state: "none" }), completed, "browser");
    expect(p.host.textContent).toContain("A follow-up opens a new one if the agent needs it.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const cancelled = { ...working, status: "cancelled", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;
    const q = await page(async () => ({ state: "none" }), cancelled, "browser");
    expect(q.host.textContent).toContain("The browser closed when the run ended.");
    expect(q.host.textContent).not.toContain("A follow-up opens");
  });

  it("while the run waits on its question with its session held, it still reads and still waits for the browser", async () => {
    let reads = 0;
    const asking = { ...working, status: "input_required", state: "waiting" } as Run;
    const p = await page(async () => { reads++; return { state: "none" }; }, asking, "browser");
    await settle(150);
    expect(p.host.textContent).toContain("Waiting for the browser");
    expect(reads).toBeGreaterThan(1);
  });

  /** The page, rendered again with `run` changed (it ends) while the reads go on; `reads()` counts them. */
  async function moving(read: () => Promise<RunBrowser>, first: Run = working) {
    let reads = 0;
    const counted = async () => { reads += 1; return read(); };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const show = (run: Run) => act(async () => { root!.render(createElement(RunDetail, { run, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readBrowser: counted, browserEvery: 20, tab: "browser" } as never)); });
    await show(first);
    await settle();
    const section = () => host.querySelector('section[aria-label="Browser"]')?.textContent ?? "";
    return { host, show, section, reads: () => reads, frame: () => host.querySelector("iframe") };
  }
  const ended = { ...working, status: "completed", state: "idle", ended_at: "2026-11-05T09:12:00Z" } as Run;

  it("an ended run whose last read was live shows that the browser closed, with no iframe: an ended run has nothing to watch", async () => {
    const p = await moving(async () => ({ state: "live", viewer: VIEWER }));
    expect(p.frame()).not.toBeNull();
    await p.show(ended);
    await settle(120);
    expect(p.frame()).toBeNull();
    expect(p.section()).toContain("The browser closed when the run ended.");
  });

  it("a failed last read and then the end show the same, and nothing more is read after the end", async () => {
    let failing = false;
    const p = await moving(async () => { if (failing) throw new Error("502"); return { state: "live", viewer: VIEWER }; });
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
    const p = await moving(async () => ({ state: "live", viewer: VIEWER }), paused);
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
    const p = await moving(async () => ({ state: "none" }), paused);
    await settle(80);
    expect(p.section()).toContain("Waiting for the browser");
    expect(p.section()).not.toContain("closed when the run ended");
  });

  it("off while the run is going hides the tab, and the next read still comes: the run's process may still open a browser with the key it launched with", async () => {
    let n = 0;
    const p = await page(async () => (++n <= 2 ? { state: "off", reason: "no browser key" } : { state: "live", viewer: VIEWER }));
    await settle(150);
    expect(n).toBeGreaterThan(2);
    expect(p.tabButton()?.textContent).toBe("Watch live");
  });

  it("has no controls of its own: taking over and handing back are the viewer's", async () => {
    const p = await page(async () => ({ state: "live", viewer: VIEWER }), working, "browser");
    const panel = p.host.querySelector('section[aria-label="Browser"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.querySelector("[data-browser-actions]")).toBeNull();
    expect(panel.querySelector("button")).toBeNull();
  });

  // Only a viewer on this page's own origin, under this run's own path, is framed: anything else says so in words, with
  // no iframe, and the served value is not shown.
  for (const [what, viewer] of [
    ["another origin", `https://elsewhere.example/v2/runs/${RUN}/browser/live/v/AbCd#t=SECRET-TOKEN-foreign-111`],
    ["another run's path", `/v2/runs/someone-elses-run/browser/live/v/AbCd#t=SECRET-TOKEN-other-222`],
    ["no http(s) URL", `javascript:alert(1)//#t=SECRET-TOKEN-script-333`],
  ] as const) {
    it(`a viewer on ${what} is never framed: no iframe, a line in its place, and the value nowhere`, async () => {
      const p = await page(async () => ({ state: "live", viewer }), working, "browser");
      expect(p.frame()).toBeNull();
      const panel = p.host.querySelector('section[aria-label="Browser"]') as HTMLElement;
      expect(panel.textContent).toContain("The live view can't be shown here.");
      expect(document.body.innerHTML).not.toContain(viewer.split("#t=")[1]);
    });
  }
});
