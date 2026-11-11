import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

// The console's loading and error states, in a person's words: a server that went away is never the password page or a
// raw "TypeError: Failed to fetch"; one banner says it is reconnecting and the page keeps what it showed, then
// "Resumed"; a slow read shows the page's shape, not a bare "Loading..."; and every error says what to do next.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
// Each wait gives up after 4 s with its own message; the test's own limit sits above a few of them.
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { models: { source: "providers", ready: true }, harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } };
const STATS = { agents: 1, runs: { total: 1, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 1 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS };
const RUN0 = { run_id: "r1", place: { mode: "runner" }, agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "working", state: "working", title: "What is two and two?", created_at: "2026-10-30T06:00:00Z", ended_at: null as string | null, result: null as unknown, error: null, cost: null, archived_at: null };
// The run as each test starts it; a test that moves it on (it ends while the server is away) is put back after.
const RUN = { ...RUN0 };
afterEach(() => { Object.assign(RUN, RUN0); });
const ROW = { id: "u1", seq: 1, kind: "user_message", summary: "What is two and two?", text: "What is two and two?", timestamp: "2026-10-30T06:00:00Z", tool_name: null };
// A row the run wrote while the server was away, which only the timeline's own read, carried on, brings.
const LATER = { id: "t2", seq: 2, kind: "tool_use", summary: "Read notes.txt", text: null, timestamp: "2026-10-30T06:00:30Z", tool_name: "read", tool_status: "success" };

/** A signed-in server whose answers a test sets per path, and that can be taken away (every request then fails as a
 *  browser's fetch does when nothing listens). */
function serve(answer: (path: string, u: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) {
  const s = { up: true, asked: [] as string[] };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    s.asked.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (!s.up) throw new TypeError("Failed to fetch");
    const a = await answer(u.pathname, u, init);
    if (a) return a;
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, CAPS);
    if (u.pathname === "/v2/health") return json(200, { status: "ok" });
    if (u.pathname === "/v2/stats") return json(200, STATS);
    if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: `no route ${u.pathname}`, retryable: false } });
  });
  return s;
}
function mount(hash: string) {
  location.hash = hash;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  return host;
}
const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};
const runHeader = (host: HTMLElement) => [...host.querySelectorAll("header")].find((h) => h.textContent?.includes("What is two and two?"));
const button = (host: HTMLElement, label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));

describe("a server that can't be reached", () => {
  it("at the start: never the password page or a raw TypeError, and the console connects by itself once it answers", async () => {
    const s = serve(() => undefined);
    s.up = false;
    const host = mount("");
    await wait(() => !!host.textContent?.includes("Can't reach agentrun-serve"), "it says the server can't be reached");
    expect(host.textContent).not.toMatch(/password|sign in/i);
    expect(host.textContent).not.toContain("TypeError");
    expect(host.textContent).toMatch(/next try in \d+ s/i);
    s.up = true;
    await wait(() => host.querySelector("h1")?.textContent === "Mission Control", "Mission Control opens once the server answers");
    expect(host.textContent).not.toContain("Can't reach agentrun-serve");
  });

  it("on a run's page (a restart): one Reconnecting banner over the last rows, then Resumed with the run and its files read again", async () => {
    let files = 0;
    const s = serve((path, u) => {
      if (path === "/v2/runs/r1") return json(200, RUN);
      if (path === "/v2/runs/r1/files") return json(200, { run_id: "r1", files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.txt`, size_bytes: 1, modified_at: RUN.created_at, content_type: "text/plain" })), complete: true, truncated: false });
      if (path === "/v2/runs/r1/timeline") {
        if (!u.searchParams.has("after")) return json(200, { run_id: "r1", place: { mode: "runner" }, status: "working", state: "working", rows: [ROW], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 1 });
        if (RUN.status === "working") return new Promise((r) => setTimeout(() => r(json(200, { run_id: "r1", place: { mode: "runner" }, status: "working", state: "working", rows: [], drop: [], reset: false, unchanged: true, final: false, has_more: false, next_after: 1 })), 40));
        return json(200, { run_id: "r1", place: { mode: "runner" }, status: "completed", state: "idle", rows: [LATER], drop: [], reset: false, unchanged: false, final: true, has_more: false, next_after: 2 });
      }
      return undefined;
    });
    const host = mount("#/runs/r1");
    await wait(() => !!runHeader(host)?.textContent?.includes("Working"), "the run reads working");
    s.up = false;
    await wait(() => !!host.textContent?.includes("Reconnecting"), "the banner says it is reconnecting");
    expect(host.querySelectorAll('[data-connection]')).toHaveLength(1);
    expect(host.textContent).toContain("What is two and two?");
    expect(host.textContent).not.toMatch(/refused|TypeError|Failed to fetch/);
    expect(host.querySelector('[role="alert"]'), "no error beside the banner").toBeNull();
    // The run ends while the server is away, with files it wrote; then the server comes back.
    Object.assign(RUN, { status: "completed", state: "idle", ended_at: "2026-10-30T06:01:00Z", result: { final_answer: "4" } });
    files = 2;
    s.up = true;
    await wait(() => !!host.textContent?.includes("Resumed"), "the banner says Resumed");
    // It says the server is back, never that the page is up to date before its reads have landed.
    expect(host.querySelector('[data-connection]')?.textContent).not.toMatch(/up to date/);
    await wait(() => !!runHeader(host)?.textContent?.includes("Completed"), "the run reads completed");
    expect(host.textContent).toContain("Files 2");
    await wait(() => !!host.textContent?.includes("Read notes.txt"), "the timeline's read carried on from its cursor");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain("Reconnecting");
    Object.assign(RUN, { status: "working", state: "working", ended_at: null, result: null });
  });

  it("a run still working that wrote files while the server was away: once back, its files are read again, though its timeline says nothing moved", async () => {
    let files = 0;
    const s = serve((path, u) => {
      if (path === "/v2/runs/r1") return json(200, RUN);
      if (path === "/v2/runs/r1/files") return json(200, { run_id: "r1", files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.txt`, size_bytes: 1, modified_at: RUN.created_at, content_type: "text/plain" })), complete: true, truncated: false });
      if (path === "/v2/runs/r1/timeline") {
        if (!u.searchParams.has("after")) return json(200, { run_id: "r1", place: { mode: "runner" }, status: "working", state: "working", rows: [ROW], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 1 });
        return new Promise((r) => setTimeout(() => r(json(200, { run_id: "r1", place: { mode: "runner" }, status: "working", state: "working", rows: [], drop: [], reset: false, unchanged: true, final: false, has_more: false, next_after: 1 })), 40));
      }
      return undefined;
    });
    const host = mount("#/runs/r1");
    await wait(() => !!runHeader(host)?.textContent?.includes("Working"), "the run reads working");
    expect(host.textContent).toContain("Files 0");
    s.up = false;
    await wait(() => !!host.textContent?.includes("Reconnecting"), "the banner says it is reconnecting");
    files = 3;
    s.up = true;
    await wait(() => !!host.textContent?.includes("Resumed"), "the banner says Resumed");
    await wait(() => !!host.textContent?.includes("Files 3"), "the files are read again");
    expect(runHeader(host)?.textContent).toContain("Working");
  });
});

describe("a run page that failed", () => {
  it("a run page whose first reads failed: Try again reads the run and starts its timeline again", async () => {
    let broken = true;
    serve((path, u) => {
      const fail = json(500, { error: { code: "internal", message: "The store could not be read.", retryable: false } });
      if (path === "/v2/runs/r1") return broken ? fail : json(200, RUN);
      if (path === "/v2/runs/r1/files") return broken ? fail : json(200, { run_id: "r1", files: [], complete: true, truncated: false });
      if (path === "/v2/runs/r1/timeline") {
        if (broken) return fail;
        if (!u.searchParams.has("after")) return json(200, { run_id: "r1", place: { mode: "runner" }, status: "working", state: "working", rows: [ROW, LATER], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 2 });
        return new Promise((r) => setTimeout(() => r(json(200, { run_id: "r1", place: { mode: "runner" }, status: "working", state: "working", rows: [], drop: [], reset: false, unchanged: true, final: false, has_more: false, next_after: 2 })), 40));
      }
      return undefined;
    });
    const host = mount("#/runs/r1");
    await wait(() => !!host.querySelector('[role="alert"]')?.textContent?.includes("The run could not be read."), "the run's read failed, in words");
    broken = false;
    await act(async () => { button(host, /^Try again$/)!.click(); });
    await wait(() => !!runHeader(host)?.textContent?.includes("Working"), "the run reads working");
    await wait(() => !!host.textContent?.includes("Read notes.txt"), "the timeline is followed again");
  });
});

describe("loading", () => {
  it("a slow Mission Control shows its shape (tiles to come), not a bare Loading...", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    serve(async (path) => (path === "/v2/stats" ? (await slow, json(200, STATS)) : undefined));
    const host = mount("");
    await wait(() => !!host.querySelector('[role="status"][aria-label="Loading Mission Control"]'), "a skeleton of Mission Control");
    expect(host.textContent).not.toContain("Loading...");
    release();
    await wait(() => host.querySelector("h1")?.textContent === "Mission Control" && !host.querySelector('[aria-label="Loading Mission Control"]'), "the page fills in");
  });

  it("a slow runs list shows rows to come, and a slow run its page's shape", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    serve(async (path) => (path === "/v2/runs" || path.startsWith("/v2/runs/r1") ? (await slow, undefined) : undefined));
    const host = mount("#/runs");
    await wait(() => !!host.querySelector('[role="status"][aria-label="Loading the runs"]'), "a skeleton of the runs");
    expect(host.textContent).not.toContain("Loading runs...");
    location.hash = "#/runs/r1";
    await wait(() => !!host.querySelector('[role="status"][aria-label="Loading the run"]'), "a skeleton of the run");
    expect(host.textContent).not.toContain("Loading the run...");
    release();
  });
});

describe("errors in plain words, each with a next step", () => {
  it("Mission Control's store fails: what happened, the server's words, and Try again", async () => {
    let calls = 0;
    serve((path) => (path === "/v2/stats" && ++calls === 1 ? json(500, { error: { code: "internal", message: "The store could not be read.", retryable: false, request_id: "req_1" } }) : undefined));
    const host = mount("");
    await wait(() => !!host.querySelector('[role="alert"]'), "an error shows");
    const alert = host.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain("Mission Control could not be read.");
    expect(alert).toContain("The server hit a problem on its side.");
    expect(alert).toContain("The store could not be read.");
    expect(alert).not.toMatch(/^internal:/);
    await act(async () => { button(host, /^Try again$/)!.click(); });
    await wait(() => host.querySelector("h1")?.textContent === "Mission Control" && !host.querySelector('[role="alert"]'), "Try again reads it again");
  });

  it("the runs list fails: plain words and a Try again that reads it again", async () => {
    let calls = 0;
    serve((path) => (path === "/v2/runs" && ++calls === 1 ? json(500, { error: { code: "internal", message: "The store could not be read.", retryable: false } }) : undefined));
    const host = mount("#/runs");
    await wait(() => !!host.querySelector('[role="alert"]'), "an error shows");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("The runs could not be read.");
    expect(host.textContent).not.toContain("internal: The store");
    await act(async () => { button(host, /^Try again$/)!.click(); });
    await wait(() => !!host.textContent?.includes("No runs yet"), "Try again reads the runs again");
    expect(calls).toBe(2);
  });

  it("a run that isn't there: no 'refused', and a way to the runs list", async () => {
    serve((path) => (path === "/v2/runs/01a1" || path.startsWith("/v2/runs/01a1/") ? json(404, { error: { code: "not_found", message: "no run 01a1", retryable: false, request_id: "req_b1" } }) : undefined));
    const host = mount("#/runs/01a1");
    await wait(() => !!host.querySelector('[role="alert"]'), "an error shows");
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("No run with this id.");
    expect(alert.textContent).not.toMatch(/refused/i);
    expect(alert.querySelector('a[href="#/runs"]')?.textContent).toBe("Open the runs list");
  });

  it("an agent that isn't there: plain words and a way to the agents list", async () => {
    serve((path) => (path === "/v2/agents/no-such-agent" ? json(404, { error: { code: "not_found", message: "no agent no-such-agent", retryable: false } }) : undefined));
    const host = mount("#/agents/no-such-agent");
    await wait(() => !!host.querySelector('[role="alert"]'), "an error shows");
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("No agent with this id.");
    expect(alert.textContent).not.toContain("not_found: no agent");
    expect(alert.querySelector('a[href="#/agents"]')?.textContent).toBe("Open the agents list");
  });

  it("a stop the server can't take while it is away says so, in words", async () => {
    const s = serve((path) => (path === "/v2/runs/r1" ? json(200, RUN) : path === "/v2/runs/r1/files" ? json(200, { run_id: "r1", files: [], complete: true, truncated: false })
      : path === "/v2/runs/r1/timeline" ? json(200, { run_id: "r1", place: { mode: "runner" }, status: "working", state: "working", rows: [ROW], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 1, poll_after_ms: 60000 }) : undefined));
    const host = mount("#/runs/r1");
    await wait(() => !!button(host, /^Stop$/), "the run offers Stop");
    s.up = false;
    await act(async () => { button(host, /^Stop$/)!.click(); });
    await wait(() => !!host.querySelector('[role="alert"]'), "the stop's failure shows");
    const alert = host.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain("Can't reach agentrun-serve");
    expect(alert).not.toMatch(/refused|TypeError/);
    s.up = true;
  });
});
