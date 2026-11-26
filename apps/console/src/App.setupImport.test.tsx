import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
// The Playground's picker watches its field's size; jsdom has no ResizeObserver (not a stub: globals are unstubbed after
// each test).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

// Setup's list: the projects a server on this machine found (GET /v2/setup/import), each with a box, none ticked; only
// the projects ticked are sent, and the list is absent where the route answers nothing. With some ticked, the console
// shows the import running, then done.
describe("App, setup's import of this machine's sessions", () => {
  // Setup's twelve characters, and a value the source export knows for a test's own.
  const PASSWORD = "not-a-secret";
  // A project the server names: `id` is what setup sends back for it.
  const project = (n: number, sessions: number) => ({ id: `imp-${String(n).padStart(32, "0")}`, name: `project-${n}`, path: `/work/project-${n}`, sessions, sources: ["claude-code"], last_active: "2026-10-20T09:00:00.000Z" });
  const [ONE, TWO, THREE] = [project(1, 2), project(2, 7), project(3, 3)];
  /** The offer of a count that ended: its counts, and the projects to choose from. */
  const counted = (...candidates: ReturnType<typeof project>[]) => ({ projects: candidates.length, sessions: candidates.reduce((n, c) => n + c.sessions, 0), candidates });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const missing = (path: string) => ({ error: { code: "not_found", message: path, retryable: false } });
  /** A server before its owner: `offer` answers GET /v2/setup/import in turn until setup (its last again), then `after`
   *  likewise. */
  function server({ offer, after = [] }: { offer: [number, unknown] | [number, unknown][]; after?: [number, unknown][] }) {
    const before = (Array.isArray(offer[0]) ? offer : [offer]) as [number, unknown][];
    const sent: Record<string, unknown>[] = [];
    let agentsRead = 0;
    // The names' read asks for the archived agents too; nothing else does on the agents list.
    let archivedRead = 0;
    let statsRead = 0;
    // Setup's reads of the import offer: a status of 0 answers as a network failure.
    let importRead = 0;
    let set = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: set, signed_in: set });
      if (path === "/v2/setup") { set = true; const body = JSON.parse(String(init?.body)); sent.push(body); return json(201, { signed_in: true, ...(body.import ? { importing: true } : {}) }); }
      if (path === "/v2/setup/import") {
        if (!set) {
          importRead += 1;
          const [status, body] = (before.length > 1 ? before.shift() : before[0])!;
          if (status === 0) throw new TypeError("fetch failed");
          return json(status, body);
        }
        const [status, body] = (after.length > 1 ? after.shift() : after[0]) ?? [404, missing(path)];
        return json(status, body);
      }
      if (path === "/v2/agents") { agentsRead += 1; if (new URL(url, "http://serve.test").searchParams.get("archived") === "true") archivedRead += 1; return json(200, { agents: [], next_cursor: null }); }
      if (path === "/v2/stats") statsRead += 1;
      return json(404, missing(path));
    });
    return { sent, agentsRead: () => agentsRead, archivedRead: () => archivedRead, statsRead: () => statsRead, importRead: () => importRead };
  }
  async function until(host: HTMLElement, found: () => unknown, ms = 3000) {
    const end = Date.now() + ms;
    while (!found() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return found();
  }
  async function render() {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    await until(host, () => host.querySelector("form"));
    return host;
  }
  const boxes = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox][name=import]")];
  const box = (host: HTMLElement, id?: string) => boxes(host).find((b) => id === undefined || b.value === id) ?? null;
  async function setPassword(host: HTMLElement) {
    for (const input of host.querySelectorAll<HTMLInputElement>("input[type=password]")) {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, PASSWORD); input.dispatchEvent(new Event("input", { bubbles: true })); });
    }
  }
  const submit = (host: HTMLElement) => act(async () => { host.querySelector<HTMLButtonElement>("button[type=submit]")!.click(); });

  it("lists the server's projects, each with its sessions and none ticked", async () => {
    server({ offer: [200, counted(ONE, TWO, THREE)] });
    const host = await render();
    expect(await until(host, () => box(host))).toBeTruthy();
    expect(boxes(host).map((b) => [b.value, b.checked])).toEqual([[ONE.id, false], [TWO.id, false], [THREE.id, false]]);
    expect(host.textContent).toContain("Import sessions from this machine");
    expect(host.textContent).toContain("12 sessions in 3 projects");
    expect(host.textContent).toContain("project-2");
    expect(host.textContent).toContain("7 sessions · Claude Code");
    expect(host.textContent).toContain("/work/project-2");
    expect(host.textContent).toContain("None chosen: nothing will be imported.");
  });

  it("names the tools the projects' sessions came from, each by its own name, OpenCode too", async () => {
    server({ offer: [200, counted({ ...ONE, sources: ["opencode", "claude-code"] }, { ...TWO, sources: ["pi"] }, { ...THREE, sources: ["claude-code"] })] });
    const host = await render();
    expect(await until(host, () => box(host))).toBeTruthy();
    expect(host.textContent).toContain("12 sessions in 3 projects, from Claude Code, pi and OpenCode.");
    expect(host.textContent).toContain("2 sessions · Claude Code, OpenCode");
    expect(host.textContent).not.toContain("opencode");
    expect(host.textContent).not.toContain("Codex");
  });

  it("sends no import unless a project is ticked", async () => {
    const { sent } = server({ offer: [200, counted(ONE, TWO)] });
    const host = await render();
    await until(host, () => box(host));
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD }]);
  });

  it("sends only the projects ticked, by id, and says how much is chosen", async () => {
    const { sent } = server({ offer: [200, counted(ONE, TWO, THREE)] });
    const host = await render();
    await until(host, () => box(host));
    await act(async () => { box(host, TWO.id)!.click(); });
    await act(async () => { box(host, THREE.id)!.click(); });
    await act(async () => { box(host, THREE.id)!.click(); });
    expect(boxes(host).map((b) => b.checked)).toEqual([false, true, false]);
    expect(host.textContent).toContain("1 project, 7 sessions chosen.");
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD, import: [TWO.id] }]);
  });

  it("Select all ticks every project listed, and Clear unticks them", async () => {
    const { sent } = server({ offer: [200, counted(ONE, TWO, THREE)] });
    const host = await render();
    await until(host, () => box(host));
    const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button[type=button]")].find((b) => b.textContent === name);
    await act(async () => { button("Select all")!.click(); });
    expect(boxes(host).every((b) => b.checked)).toBe(true);
    expect(host.textContent).toContain("3 projects, 12 sessions chosen.");
    await act(async () => { button("Clear")!.click(); });
    expect(boxes(host).some((b) => b.checked)).toBe(false);
    await act(async () => { button("Select all")!.click(); });
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD, import: [ONE.id, TWO.id, THREE.id] }]);
  });

  it("says when the server lists only the latest of more projects", async () => {
    server({ offer: [200, { projects: 640, sessions: 9000, candidates: [ONE, TWO] }] });
    const host = await render();
    await until(host, () => box(host));
    expect(host.textContent).toContain("9,000 sessions in 640 projects");
    expect(host.textContent).toContain("The 2 most recently active are listed.");
  });

  it("sends the projects ticked, then shows the import running, then done (a failed read tried again), and reads the page and the agents again", async () => {
    const failed = [500, { error: { code: "internal", message: "busy", retryable: true } }] as [number, unknown];
    const { sent, agentsRead, statsRead } = server({ offer: [200, counted(ONE)], after: [[200, { state: "running" }], failed, [200, { state: "done", agents: 1, runs: 2, skipped: 0 }]] });
    const host = await render();
    await until(host, () => box(host));
    await act(async () => { box(host)!.click(); });
    expect(box(host)!.checked).toBe(true);
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD, import: [ONE.id] }]);
    expect(await until(host, () => /Importing this machine's sessions/.test(host.textContent ?? ""))).toBe(true);
    const [names, stats] = [agentsRead(), statsRead()];
    expect(await until(host, () => /Imported 2 sessions into 1 agent\./.test(host.textContent ?? ""), 6000)).toBe(true);
    expect(await until(host, () => agentsRead() > names && statsRead() > stats)).toBe(true);
  }, 15_000);

  it("says an import the server gave up, and that its log says why", async () => {
    const { sent } = server({ offer: [200, counted(ONE)], after: [[200, { state: "failed" }]] });
    const host = await render();
    await until(host, () => box(host));
    await act(async () => { box(host)!.click(); });
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(await until(host, () => /was given up before it finished/.test(host.textContent ?? ""), 6000)).toBe(true);
  }, 15_000);

  it("an import that ends while the agents list is open reads the agents' names again, though that list is not a runs view", async () => {
    location.hash = "#/agents";
    const { sent, archivedRead } = server({ offer: [200, counted(ONE)], after: [[200, { state: "running" }], [200, { state: "done", agents: 1, runs: 2, skipped: 0 }]] });
    const host = await render();
    await until(host, () => box(host));
    await act(async () => { box(host)!.click(); });
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(await until(host, () => /Importing this machine's sessions/.test(host.textContent ?? ""))).toBe(true);
    expect(await until(host, () => archivedRead() > 0)).toBe(true);
    const read = archivedRead();
    expect(await until(host, () => /Imported 2 sessions into 1 agent\./.test(host.textContent ?? ""), 6000)).toBe(true);
    expect(await until(host, () => archivedRead() > read)).toBe(true);
    location.hash = "";
  }, 15_000);

  it("an earlier read of the playground's agents that answers after the import ended never replaces the newer list", async () => {
    location.hash = "#/playground";
    const agent = (id: string) => ({ agent_id: id, kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: id, instructions: "Answer.", harness: "pi", skills: [], tools: [] } });
    let set = false;
    let done = false;
    let reads = 0;
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://serve.test");
      if (u.pathname === "/v2/auth/session") return json(200, { password_set: set, signed_in: set });
      if (u.pathname === "/v2/setup") { set = true; sent.push(JSON.parse(String(init?.body))); return json(201, { signed_in: true, importing: true }); }
      if (u.pathname === "/v2/setup/import") {
        if (!set) return json(200, counted(ONE));
        // Running at the first read after setup, done at the next.
        reads += 1;
        if (reads < 2) return json(200, { state: "running" });
        done = true;
        return json(200, { state: "done", agents: 1, runs: 2, skipped: 0 });
      }
      if (u.pathname === "/v2/agents") {
        // A read made before the import ended answers late, with the agents from before it.
        if (!done) { await new Promise((r) => setTimeout(r, 1500)); return json(200, { agents: [agent("before")], next_cursor: null }); }
        return json(200, { agents: [agent("before"), agent("imported")], next_cursor: null });
      }
      return json(404, missing(u.pathname));
    });
    const host = await render();
    await until(host, () => box(host));
    await act(async () => { box(host)!.click(); });
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    // The Playground's Agent picker, opened (its list renders only while open) and kept open: the agents it offers.
    const picker = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"][aria-label="Agent"]');
    const options = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent);
    await until(host, () => !!picker(), 6000);
    await act(async () => { if (picker()!.getAttribute("aria-expanded") !== "true") picker()!.click(); });
    expect(await until(host, () => options().includes("imported"), 6000)).toBe(true);
    // Past the late answer of the read made before the import ended.
    await act(async () => { await new Promise((r) => setTimeout(r, 2000)); });
    expect(options()).toContain("imported");
    location.hash = "";
  }, 15_000);

  it("says at once that it is looking while the server counts, with nothing to tick, and lists the projects when they arrive", async () => {
    server({ offer: [[202, { counting: true }], [202, { counting: true }], [200, counted(ONE, TWO, THREE)]] });
    const host = await render();
    expect(await until(host, () => /Looking for this machine's coding-agent sessions/.test(host.textContent ?? ""))).toBe(true);
    expect(box(host)).toBeNull();
    expect(await until(host, () => /12 sessions in 3 projects/.test(host.textContent ?? ""), 5000)).toBe(true);
    expect(host.textContent).not.toContain("Looking for this machine's");
    expect(boxes(host).map((b) => b.checked)).toEqual([false, false, false]);
  }, 15_000);

  it("sends no import when the password is set before the projects arrive: nothing was ticked", async () => {
    const { sent } = server({ offer: [202, { counting: true }] });
    const host = await render();
    await until(host, () => /Looking for this machine's/.test(host.textContent ?? ""));
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD }]);
  });

  it.each([
    ["the server's count failed", [[202, { counting: true }], [200, { projects: null, sessions: null }]]],
    ["a read failed after the offer showed", [[202, { counting: true }], [500, { error: { code: "internal", message: "busy", retryable: true } }]]],
  ] as [string, [number, unknown][]][])("says the sessions couldn't be listed, with nothing to tick, when %s", async (_, offer) => {
    const { sent } = server({ offer });
    const host = await render();
    expect(await until(host, () => /sessions couldn't be listed/.test(host.textContent ?? ""), 5000)).toBe(true);
    expect(box(host)).toBeNull();
    await setPassword(host);
    await submit(host);
    await until(host, () => sent.length);
    expect(sent).toEqual([{ password: PASSWORD }]);
  }, 15_000);

  it("shows no list when the count finds no session", async () => {
    server({ offer: [200, counted()] });
    const host = await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(box(host)).toBeNull();
    expect(host.textContent).not.toContain("Import sessions from this machine");
  });

  it.each([
    [200, "a server that offers no import", { offer: false }],
    [404, "a server without accounts, which has no such route", undefined],
    [403, "a read the server refuses", undefined],
  ] as [number, string, unknown][])("shows no list for %i, %s, and asks no more", async (status, _, body) => {
    const { importRead } = server({ offer: [status, body ?? missing("/v2/setup/import")] });
    const host = await render();
    // Past a poll's wait: no second read.
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(box(host)).toBeNull();
    expect(host.textContent).not.toContain("Import sessions from this machine");
    expect(importRead()).toBe(1);
  });

  it.each([
    ["a 500", [500, { error: { code: "internal", message: "busy", retryable: true } }]],
    ["a network failure", [0, null]],
  ] as [string, [number, unknown]][])("shows the list once a read that failed before it showed (%s) is tried again", async (_, failed) => {
    const { importRead } = server({ offer: [failed, [200, counted(ONE, TWO, THREE)]] });
    const host = await render();
    expect(await until(host, () => /12 sessions in 3 projects/.test(host.textContent ?? ""), 5000)).toBe(true);
    expect(box(host)!.checked).toBe(false);
    expect(importRead()).toBe(2);
  }, 15_000);
});
