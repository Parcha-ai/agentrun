import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

// Mission Control's Failed tile counts what Needs you's Failed lists: the failures of the last 24 h, imported history left
// out (GET /v2/runs?status=failed, filtered here), and links to all of them with the server's own count (GET /v2/stats
// runs.failed, every failed run). Ten failed in all, four of them live and in the last day: both read 4, both say "last
// 24 h", and both offer all 10.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.useRealTimers(); location.hash = ""; });
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const failedRun = (id: string, endedAgo: number, extra: object = {}) => ({ run_id: id, agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", title: `Run ${id}`, status: "failed", state: "idle", created_at: ago(endedAgo + 60_000), ended_at: ago(endedAgo), result: null, error: { code: "run_failed", message: `boom ${id}`, retryable: false }, cost: null, archived_at: null, ...extra });
const HOUR = 3_600_000;
const FAILED = [
  failedRun("f1", HOUR), failedRun("f2", 2 * HOUR), failedRun("f3", 3 * HOUR), failedRun("f4", 20 * HOUR),
  failedRun("imp", HOUR, { imported_from: { source: "claude-code", session: "s1" } }),
  failedRun("old1", 30 * HOUR), failedRun("old2", 50 * HOUR),
];
const STATS = {
  agents: 1, runs: { total: 12, active: 0, needs_input: 0, failed: 10, status_unknown: 0, needs_review: 0 },
  per_agent: [{ agent_id: "calc", name: "Calculator", runs: 12 }], cost: { usd: null, basis: null, unknown_runs: 12 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS,
};

function serve(state: { failed: unknown[]; total: number; statsReads: number } = { failed: FAILED, total: 10, statsReads: 0 }) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, CAPS);
    if (u.pathname === "/v2/health") return json(200, { status: "ok" });
    if (u.pathname === "/v2/stats") { state.statsReads += 1; return json(200, { ...STATS, runs: { ...STATS.runs, failed: state.total } }); }
    if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
    if (u.pathname === "/v2/runs") {
      const status = u.searchParams.get("status");
      return json(200, { runs: status === "failed" ? state.failed : status ? [] : state.failed.slice(0, 3), next_cursor: null });
    }
    return json(404, { error: { code: "not_found", message: `no route ${u.pathname}`, retryable: false } });
  });
}
const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};

describe("Mission Control's Failed tile and Needs you's Failed list", () => {
  it("count the same last-24-h failures, both say the window, and both offer all of them", async () => {
    serve();
    location.hash = "#/";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const head = () => [...host.querySelectorAll('section[aria-label="Needs you"] p')].find((p) => /^Failed/.test(p.textContent ?? ""));
    await wait(() => !!head(), "Needs you with its failures");
    expect(head()!.querySelector("span")?.textContent).toBe("Failed in the last 24 h · 4");
    expect(head()!.querySelector('a[href="#/runs?status=failed"]')?.textContent).toBe("All 10 failed runs →");
    const tile = [...host.querySelectorAll("li")].find((li) => /^Failed/.test(li.querySelector("p")?.textContent ?? ""))!;
    expect(tile.querySelector("p")?.textContent).toBe("Failed · last 24 h");
    expect(tile.querySelectorAll("p")[1]?.textContent).toBe("4");
    expect(tile.textContent).toContain("See all 10");
  });

  it("a run that fails after the page opened: the next poll reads the total again, so the tile, the list and See all agree", async () => {
    // The 10 s poll of the lists, on a fake clock; the date stays real (the 24 h window).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = { failed: [] as unknown[], total: 0, statsReads: 0 };
    serve(state);
    location.hash = "#/";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const tile = () => [...host.querySelectorAll("li")].find((li) => /^Failed/.test(li.querySelector("p")?.textContent ?? ""));
    const head = () => [...host.querySelectorAll('section[aria-label="Needs you"] p')].find((p) => /^Failed/.test(p.textContent ?? ""));
    const tick = async (ms: number, until: () => boolean, what: string) => {
      for (let t = 0; t < ms && !until(); t += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(until(), what).toBe(true);
    };
    await tick(4000, () => tile()?.querySelectorAll("p")[1]?.textContent === "0", "Mission Control with no failure");
    const before = state.statsReads;
    // A run fails; the next poll lists it.
    state.failed = [failedRun("new", 1000)];
    state.total = 1;
    await tick(12_000, () => !!head(), "Needs you with the new failure");
    await tick(2000, () => !!tile()?.textContent?.includes("See all 1"), "the tile's See all, read again");
    expect(tile()!.querySelectorAll("p")[1]?.textContent).toBe("1");
    expect(head()!.querySelector("span")?.textContent).toBe("Failed in the last 24 h · 1");
    expect(head()!.querySelector('a[href="#/runs?status=failed"]')?.textContent).toBe("All 1 failed run →");
    // The total is read again for the new failure only: once, not on every poll.
    expect(state.statsReads - before).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(state.statsReads - before).toBe(1);
  });
});
