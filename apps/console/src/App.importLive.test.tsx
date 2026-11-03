import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, IMPORT_REFRESH_MS } from "./App";

// The import asked for at setup, while it runs: the line says how far it has got (sessions of the total, agents, the time
// left, a bar), and Mission Control, the runs list and the agents list read again as it goes, keeping what they show
// through a failed read, never emptied between two reads.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const missing = (path: string) => ({ error: { code: "not_found", message: path, retryable: false } });
const busy = { error: { code: "home_busy", message: "the agent store is busy with another write; try again", retryable: true } };
const group = { runs: 1, completed: 1, failed: 0, needs_review: 0, runs_with_metrics: 1, tokens: 1000, cost_usd: 0.01, unknown_cost_runs: 0 };
const stats = (agents: number, runs: number) => ({
  agents, runs: { total: runs, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [],
  cost: { usd: 0.01, basis: "estimate", unknown_runs: 0 }, archived: { agents: 0, runs: 0 },
  analytics: {
    filter: { from: null, to: null, agent: null },
    totals: { ...group, input: 500, cache_read: 300, cache_write: 0, output: 200, requests: 2, unmetered: 0 },
    time: { ended_runs: 1, wall_ms: 60_000, active_runs: 0, active_ms: 0 },
    by_harness_effort: [{ harness: "pi", effort: null, ...group }], by_day: [{ day: new Date().toISOString().slice(0, 10), ...group }], by_source: [{ source: "claude-code", ...group }], tools: [],
  },
});
const agent = (n: number) => ({ agent_id: `imp-${n}`, kind: "agentic", revision: `r${n}`, revisions: 1, archived_at: null, definition: { version: 1, name: `project-${n}`, instructions: "", harness: "pi", skills: [], tools: [] } });
const run = (n: number) => ({ run_id: `run-${n}`, agent_id: "imp-1", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: `Session ${n}`, created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: null, imported_from: { source: "claude-code", session: `s${n}` } });
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

type Step = { import: unknown; agents: number; runs: number; statsFail?: boolean };
/** A signed-in owner's server whose import is at `steps[i]`: each read of GET /v2/setup/import moves to the next step
 *  (the last stays), and the store's lists and counts are those of the step reached. */
function server(steps: Step[]) {
  let at = 0;
  const read = { stats: 0, agents: 0, runs: 0, import: 0 };
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    const step = steps[at]!;
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (u.pathname === "/v2/setup/import") {
      read.import += 1;
      const answer = steps[at]!.import;
      at = Math.min(at + 1, steps.length - 1);
      return json(200, answer);
    }
    if (u.pathname === "/v2/stats") { read.stats += 1; return step.statsFail ? json(409, busy) : json(200, stats(step.agents, step.runs)); }
    if (u.pathname === "/v2/agents") {
      read.agents += 1;
      return json(200, { agents: u.searchParams.get("archived") === "true" ? [] : range(step.agents).map(agent), next_cursor: null });
    }
    if (u.pathname === "/v2/runs") { read.runs += 1; return json(200, { runs: range(Math.min(step.runs, 50)).reverse().map(run), next_cursor: null }); }
    return json(404, missing(u.pathname));
  });
  return read;
}
async function open(hash = "") {
  location.hash = hash;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  return host;
}
async function until(found: () => unknown, ms = 4000) {
  const end = Date.now() + ms;
  while (!found() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return found();
}
/** Waits `ms`, calling `look` every 20 ms: what a person would have seen meanwhile. */
async function watch(ms: number, look: () => void) {
  const end = Date.now() + ms;
  while (Date.now() < end) { look(); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); }
}
const text = (host: HTMLElement) => host.textContent ?? "";
// The refresh period, as the console exports it (2.5 s where it exports none, so a run without it fails on what it shows).
const REFRESH_MS = IMPORT_REFRESH_MS ?? 2500;
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

describe("App, the import at setup while it runs", () => {
  it("says how many of the sessions are in, how many agents, and about how long is left, with a bar", async () => {
    server([{ import: { state: "running", phase: "index", runs: 1240, transcripts: 0, agents: 74, total: 2500, started_at: ago(10) }, agents: 74, runs: 1240 }]);
    const host = await open();
    expect(await until(() => /1,240 of 2,500 sessions · 74 agents · about 10 s left/.test(text(host)))).toBe(true);
    const bar = host.querySelector("[role=progressbar]");
    expect(bar?.getAttribute("aria-valuenow")).toBe("1240");
    expect(bar?.getAttribute("aria-valuemax")).toBe("2500");
  });

  it("says minutes when more than a minute is left", async () => {
    server([{ import: { state: "running", phase: "index", runs: 100, transcripts: 0, agents: 3, total: 2500, started_at: ago(10) }, agents: 3, runs: 100 }]);
    const host = await open();
    expect(await until(() => /100 of 2,500 sessions · 3 agents · about 4 min left/.test(text(host)))).toBe(true);
  });

  it("says no time left until it has a rate to go by", async () => {
    server([{ import: { state: "running", phase: "index", runs: 0, transcripts: 0, agents: 0, total: 2500, started_at: ago(0) }, agents: 0, runs: 0 }]);
    const host = await open();
    expect(await until(() => /0 of 2,500 sessions · 0 agents/.test(text(host)))).toBe(true);
    expect(text(host)).not.toMatch(/left/);
  });

  it("once every session is in, says the console is complete and counts the transcripts still to read", async () => {
    server([{ import: { state: "running", phase: "transcripts", runs: 2500, transcripts: 800, agents: 150, total: 2500, started_at: ago(20) }, agents: 150, runs: 2500 }]);
    const host = await open();
    expect(await until(() => /All 2,500 sessions are in · reading their transcripts: 800 of 2,500/.test(text(host)))).toBe(true);
    expect(host.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("800");
  });

  it("keeps a line with no numbers, and no bar, for a server that says only that it runs", async () => {
    server([{ import: { state: "running" }, agents: 0, runs: 0 }]);
    const host = await open();
    expect(await until(() => /Importing this machine's sessions/.test(text(host)))).toBe(true);
    expect(host.querySelector("[role=progressbar]")).toBeNull();
  });

  it("reads Mission Control again while the import runs, and keeps it through a busy read", async () => {
    const running = (runs: number) => ({ state: "running", phase: "index", runs, transcripts: 0, agents: 1, total: 100, started_at: ago(5) });
    const steps: Step[] = [
      { import: running(10), agents: 1, runs: 10 },
      ...Array.from({ length: 3 }, () => ({ import: running(20), agents: 2, runs: 20, statsFail: true })),
      ...Array.from({ length: 20 }, () => ({ import: running(40), agents: 3, runs: 40 })),
    ];
    const read = server(steps);
    const host = await open();
    expect(await until(() => /Total cost/.test(text(host)))).toBe(true);
    const first = read.stats;
    let alerted = false;
    await watch(REFRESH_MS * 2 + 1500, () => { if (host.querySelector("main [role=alert], [role=alert]")) alerted = true; });
    expect(read.stats).toBeGreaterThanOrEqual(first + 2);
    expect(alerted).toBe(false);
  }, 20_000);

  it("fills the runs list as runs arrive, never emptied between two reads", async () => {
    const running = (runs: number) => ({ state: "running", phase: "index", runs, transcripts: 0, agents: 1, total: 5, started_at: ago(5) });
    server([
      { import: running(1), agents: 1, runs: 1 },
      { import: running(1), agents: 1, runs: 1 },
      ...Array.from({ length: 30 }, () => ({ import: running(5), agents: 1, runs: 5 })),
    ]);
    const host = await open("#/runs");
    expect(await until(() => /Session 1/.test(text(host)))).toBe(true);
    let emptied = false;
    await watch(REFRESH_MS * 2 + 1500, () => { if (/Loading runs|No runs yet/.test(text(host))) emptied = true; });
    expect(text(host)).toContain("Session 5");
    expect(emptied).toBe(false);
  }, 20_000);

  it("fills the agents list in place as agents arrive", async () => {
    const running = (agents: number) => ({ state: "running", phase: "index", runs: agents, transcripts: 0, agents, total: 4, started_at: ago(5) });
    server([
      { import: running(1), agents: 1, runs: 1 },
      { import: running(1), agents: 1, runs: 1 },
      ...Array.from({ length: 30 }, () => ({ import: running(4), agents: 4, runs: 4 })),
    ]);
    const host = await open("#/agents");
    expect(await until(() => /project-1/.test(text(host)))).toBe(true);
    let emptied = false;
    await watch(REFRESH_MS * 2 + 1500, () => { if (/Loading agents/.test(text(host))) emptied = true; });
    expect(text(host)).toContain("project-4");
    expect(emptied).toBe(false);
  }, 20_000);

  it("reads nothing again once the import is done, past the one read at its end", async () => {
    const read = server([
      { import: { state: "running", phase: "index", runs: 1, transcripts: 0, agents: 1, total: 2, started_at: ago(5) }, agents: 1, runs: 1 },
      { import: { state: "done", agents: 1, runs: 2, skipped: 0 }, agents: 1, runs: 2 },
    ]);
    const host = await open();
    expect(await until(() => /Imported 2 sessions into 1 agent\./.test(text(host)))).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    const after = read.stats;
    await act(async () => { await new Promise((r) => setTimeout(r, REFRESH_MS + 1000)); });
    expect(read.stats).toBe(after);
  }, 20_000);

  it("Load more while a refresh of the list is under way keeps the rows it loaded", async () => {
    let firstPage = 0;
    const running = { state: "running", phase: "index", runs: 100, transcripts: 0, agents: 1, total: 200, started_at: ago(5) };
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url, "http://serve.test");
      if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (u.pathname === "/v2/setup/import") return json(200, running);
      if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
      if (u.pathname === "/v2/stats") return json(200, stats(1, 100));
      if (u.pathname === "/v2/runs") {
        if (u.searchParams.get("cursor") === "c2") return json(200, { runs: range(100).slice(50).map(run), next_cursor: null });
        // The import's refresh of the first page answers slowly.
        if (++firstPage >= 2) await new Promise((r) => setTimeout(r, 2000));
        return json(200, { runs: range(50).map(run), next_cursor: "c2" });
      }
      return json(404, missing(u.pathname));
    });
    const host = await open("#/runs");
    const more = () => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Load more");
    expect(await until(() => /Session 50/.test(text(host)) && more())).toBeTruthy();
    expect(await until(() => firstPage >= 2, REFRESH_MS + 2000)).toBe(true);
    await act(async () => { more()!.click(); });
    expect(await until(() => /Session 100/.test(text(host)))).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });
    expect(text(host)).toContain("Session 100");
  }, 20_000);

  it("a refresh that lands before a slower first read leaves Mission Control not busy once both are in", async () => {
    let reads = 0;
    const running = { state: "running", phase: "index", runs: 10, transcripts: 0, agents: 1, total: 100, started_at: ago(5) };
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url, "http://serve.test");
      if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (u.pathname === "/v2/setup/import") return json(200, running);
      if (u.pathname === "/v2/stats") {
        // The page's first read is slow: the import's refresh starts after it and lands first.
        if (++reads === 1) await new Promise((r) => setTimeout(r, 4000));
        return json(200, stats(1, 10));
      }
      if (u.pathname === "/v2/runs" || u.pathname === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, missing(u.pathname));
    });
    const host = await open();
    expect(await until(() => /Total cost/.test(text(host)), REFRESH_MS + 3000)).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 4500)); });
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  }, 20_000);
});
