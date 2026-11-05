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
const working = { ...f.run, status: "working", state: "working", result: null } as Run;
const RUN = working.run_id;
const VIEWER = `/v2/runs/${RUN}/browser/live/v/AbCdEfGhIjKlMnOpQrStUv#t=SECRET-TOKEN-one-1234567890`;
const VIEWER2 = `/v2/runs/${RUN}/browser/live/v/ZyXwVuTsRqPoNmLkJiHgFe#t=SECRET-TOKEN-two-0987654321`;
const settle = async (ms = 60) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function page(read: () => Promise<RunBrowser>, run: Run = working, tab?: "browser") {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(RunDetail, { run, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: {}, readBrowser: read, browserEvery: 20, ...(tab ? { tab } : {}) } as never));
  });
  await settle();
  const tabButton = () => [...host.querySelectorAll('[role="tab"]')].find((b) => /^Browser/.test(b.textContent ?? "")) as HTMLElement | undefined;
  const open = async () => { const b = tabButton(); expect(b, "the Browser tab").toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  const frame = () => host.querySelector("iframe") as HTMLIFrameElement | null;
  return { host, tabButton, open, frame };
}

/** Everywhere the viewer (its token above all) must never be, but the iframe's src. */
function nowhereBut(frame: HTMLIFrameElement | null, ...secrets: string[]) {
  for (const s of secrets) {
    const token = s.split("#t=")[1];
    expect(location.href).not.toContain(token);
    expect(JSON.stringify(history.state ?? null)).not.toContain(token);
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) expect(store.getItem(store.key(i)!) ?? "").not.toContain(token);
    expect(JSON.stringify(logs.map((args) => args.map(String)))).not.toContain(token);
    // In the page, once: the iframe's src attribute.
    const html = document.body.innerHTML.replaceAll("&amp;", "&");
    expect(html.split(token).length - 1, "the token appears once in the page").toBe(frame ? 1 : 0);
  }
}

describe("the run page's Browser tab", () => {
  it("is not there for a run with no browser (state off)", async () => {
    const p = await page(async () => ({ state: "off", reason: "no browser key" }));
    expect(p.tabButton()).toBeUndefined();
    expect(p.frame()).toBeNull();
  });

  it("is not there on an older server with no such route (404), nor for a caller it refuses (403)", async () => {
    for (const status of [404, 403]) {
      const p = await page(async () => { throw new ClientError(status, status === 404 ? "not_found" : "forbidden", "no", false); });
      expect(p.tabButton(), String(status)).toBeUndefined();
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("waits for the browser when the run has one and no page is open yet", async () => {
    const p = await page(async () => ({ state: "none" }));
    await p.open();
    expect(p.host.textContent).toContain("Waiting for the browser");
    expect(p.frame()).toBeNull();
  });

  it("embeds the live session's viewer: the iframe's src is the viewer exactly, and the viewer is nowhere else", async () => {
    const p = await page(async () => ({ state: "live", viewer: VIEWER }));
    expect(p.tabButton()!.textContent).toMatch(/live/i);
    await p.open();
    expect(p.frame()!.getAttribute("src")).toBe(VIEWER);
    expect(p.frame()!.getAttribute("title")).toBe("The run's browser");
    nowhereBut(p.frame(), VIEWER);
  });

  it("follows the session: live, then none at release, then live again with the new viewer, never the old one", async () => {
    const answers: RunBrowser[] = [{ state: "live", viewer: VIEWER }, { state: "none" }, { state: "live", viewer: VIEWER2 }];
    let i = 0;
    const p = await page(async () => answers[Math.min(i++, answers.length - 1)], working, "browser");
    for (let n = 0; n < 20 && i < answers.length; n++) await settle(30);
    await settle(60);
    expect(p.frame()!.getAttribute("src")).toBe(VIEWER2);
    expect(p.host.innerHTML).not.toContain("SECRET-TOKEN-one");
    nowhereBut(p.frame(), VIEWER2);
  });

  it("a failed read after a live one keeps the page, and says nothing of the viewer anywhere", async () => {
    let i = 0;
    const p = await page(async () => { if (i++ === 0) return { state: "live", viewer: VIEWER }; throw new Error(`GET /v2/runs/${RUN}/browser: 502`); }, working, "browser");
    await settle(120);
    expect(p.frame()!.getAttribute("src")).toBe(VIEWER);
    nowhereBut(p.frame(), VIEWER);
  });

  it("leaves room for taking over: an actions area and a line for what the agent waits on, both empty for now", async () => {
    const p = await page(async () => ({ state: "live", viewer: VIEWER }), working, "browser");
    const panel = p.host.querySelector('section[aria-label="Browser"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.querySelector("[data-browser-actions]")?.children.length).toBe(0);
    expect(panel.querySelector("button")).toBeNull();
  });
});
