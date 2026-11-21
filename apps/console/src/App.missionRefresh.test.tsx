import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.innerHTML = ""; location.hash = ""; localStorage.clear(); sessionStorage.clear();
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const stats = (total: number) => ({ agents: 1, runs: { total, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 },
  per_agent: [{ agent_id: "calc", name: "Calculator", runs: total }], cost: { usd: null, basis: null, unknown_runs: total },
  archived: { agents: 0, runs: 0 }, analytics: ANALYTICS });
const unavailable = () => new Response(JSON.stringify({ error: { code: "store_busy", message: "The store is busy.", retryable: true } }), { status: 503, headers: { "content-type": "application/json" } });
const recent = (title: string) => ({ runs: [{ run_id: title, agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title,
  created_at: "2026-11-04T06:00:00Z", ended_at: "2026-11-04T06:00:05Z", result: null, error: null, cost: null, archived_at: null }], next_cursor: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); for (let i = 0; i < 20; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function mount(answerStats: (n: number, url: URL) => Response | Promise<Response>, answerRecent: (n: number) => Response | Promise<Response> = () => json(recent("Current recent run")), answerAgents?: (url: URL) => Response | Promise<Response>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const statsCalls: URL[] = [], recentCalls: URL[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/auth/session") return json({ password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json({ models: { source: "providers", ready: true }, harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (u.pathname === "/v2/health") return json({ status: "ok" });
    if (u.pathname === "/v2/observations") return json({ sessions: [], connectors: [], usage: { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cache_hit_rate: null, status: "unavailable", models: [], daily: [] } });
    // A connected agent remains visible independently of the stats/recent-run refreshes below.
    if (u.pathname === "/v2/agents") return answerAgents?.(u) ?? json({ agents: u.searchParams.get("archived") === "true" ? [] : [{ agent_id: "calc", kind: "agentic", archived_at: null, revision: "r1", revisions: 1, definition: { version: 1, name: "Calculator", instructions: "Help", tools: [], skills: [] } }], next_cursor: null });
    if (u.pathname === "/v2/stats") { statsCalls.push(u); return answerStats(statsCalls.length, u); }
    if (u.pathname === "/v2/runs" && u.searchParams.get("limit") === "10" && !u.searchParams.has("status")) { recentCalls.push(u); return answerRecent(recentCalls.length); }
    if (u.pathname === "/v2/runs") return json({ runs: [], next_cursor: null });
    return new Response(JSON.stringify({ error: { code: "not_found", message: "Not exposed", retryable: false } }), { status: 404, headers: { "content-type": "application/json" } });
  });
  location.hash = "#/";
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App))); await flush();
  const total = () => [...host.querySelectorAll("li")].find((li) => li.querySelector("p")?.textContent === "Runs")?.querySelectorAll("p")[1]?.textContent;
  return { host, statsCalls, recentCalls, total };
}

it.each(["stats", "recent"] as const)("keeps a valid slow %s read through interval/focus/visibility refreshes and resumes polling afterward", async (slow) => {
  const held = deferred<Response>();
  const page = await mount((n) => slow === "stats" && n === 1 ? held.promise : json(stats(n === 1 ? 71 : 72)),
    (n) => slow === "recent" && n === 1 ? held.promise : json(recent("Current recent run")));
  expect(page.statsCalls).toHaveLength(1); expect(page.recentCalls).toHaveLength(1);
  await advance(46_000);
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(page.statsCalls).toHaveLength(1); expect(page.recentCalls).toHaveLength(1);
  await act(async () => held.resolve(slow === "stats" ? json(stats(71)) : json(recent("Slow recent answer")))); await flush();
  expect(page.total()).toBe("71");
  expect(page.host.textContent).toContain(slow === "recent" ? "Slow recent answer" : "Current recent run");
  await advance(15_000);
  expect(page.statsCalls).toHaveLength(2); expect(page.recentCalls).toHaveLength(2);
  expect(page.total()).toBe("72");
});

it("keeps explicit refresh effective while automatic refresh waits for its slow answer", async () => {
  const held = deferred<Response>();
  const page = await mount((n) => n === 2 ? held.promise : json(stats(n)));
  expect(page.total()).toBe("1");
  await act(async () => page.host.querySelector<HTMLButtonElement>('[aria-label="Refresh Mission Control"]')!.click());
  expect(page.statsCalls).toHaveLength(2);
  await advance(31_000);
  expect(page.statsCalls).toHaveLength(2);
  await act(async () => held.resolve(json(stats(88)))); await flush();
  expect(page.total()).toBe("88");
});

it("keeps the last connected-agent inventory through a failed poll and explicit refresh, with an error until recovery", async () => {
  let fail = false;
  const recovery = deferred<Response>();
  let recovering = false;
  const agents = () => json({ agents: [{ agent_id: "calc", kind: "agentic", archived_at: null, revision: "r1", revisions: 1, definition: { version: 1, name: "Calculator", instructions: "Help", tools: [], skills: [] } }], next_cursor: null });
  const page = await mount(() => json(stats(1)), undefined, url => url.searchParams.get("archived") === "true" ? json({ agents: [], next_cursor: null }) : recovering ? recovery.promise : fail ? unavailable() : agents());
  const inventory = () => page.host.querySelector('section[aria-label="Connected agents"]')!;
  const count = () => page.host.querySelector('a[href="#/agents"]')?.querySelectorAll("p")[1]?.textContent;
  expect(inventory().textContent).toContain("Calculator");
  expect(count()).toBe("1");
  fail = true;
  await advance(10_000); await flush();
  expect(inventory().textContent).toContain("Calculator");
  expect(count()).toBe("1");
  expect(inventory().querySelector('[role="alert"]')?.textContent).toContain("Could not refresh connected agents");
  recovering = true;
  await act(async () => page.host.querySelector<HTMLButtonElement>('[aria-label="Refresh Mission Control"]')!.click()); await flush();
  expect(inventory().textContent).toContain("Calculator");
  expect(count()).toBe("1");
  expect(inventory().querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => recovery.resolve(agents())); await flush();
  expect(inventory().textContent).toContain("Calculator");
  expect(inventory().querySelector('[role="alert"]')).toBeNull();
});

it("lets a user scope change supersede a pending read without its late answer unlocking or overwriting the new scope", async () => {
  const old = deferred<Response>(), current = deferred<Response>();
  const page = await mount((n) => n === 2 ? old.promise : n === 3 ? current.promise : json(stats(n)));
  expect(page.total()).toBe("1");
  await advance(15_000); expect(page.statsCalls).toHaveLength(2);
  await act(async () => page.host.querySelector<HTMLInputElement>('input[name="mission-range"][value="7d"]')!.click());
  expect(page.statsCalls).toHaveLength(3);
  expect(page.statsCalls[2]!.searchParams.get("from")).not.toBe(page.statsCalls[1]!.searchParams.get("from"));
  await act(async () => old.resolve(json(stats(999)))); await flush();
  expect(page.total()).toBe("1");
  await advance(31_000);
  expect(page.statsCalls).toHaveLength(3); expect(page.total()).not.toBe("999");
  await act(async () => current.resolve(json(stats(7)))); await flush();
  expect(page.total()).toBe("7");
});

it.each(["stats", "recent"] as const)("keeps saved Mission Control data visible after an automatic %s failure and during explicit recovery", async (failed) => {
  const refresh = deferred<Response>(), retry = deferred<Response>();
  const page = await mount((n) => failed === "stats" && n === 2 ? refresh.promise : n === 3 ? retry.promise : json(stats(n === 1 ? 71 : 72)),
    (n) => failed === "recent" && n === 2 ? refresh.promise : json(recent(n === 1 ? "Saved recent run" : "Recovered recent run")));
  const analytics = () => page.host.querySelector('section[aria-label="Analytics"]')?.textContent;
  const savedAnalytics = analytics();
  expect(page.total()).toBe("71");
  expect(savedAnalytics).toContain("Tokens");
  expect(page.host.querySelector('a[href="#/agents/calc/runs"]')?.textContent).toContain("Calculator");
  expect(page.host.querySelector('a[href="#/runs/Saved%20recent%20run"]')).not.toBeNull();

  await advance(15_000);
  expect(page.statsCalls).toHaveLength(2); expect(page.recentCalls).toHaveLength(2);
  expect(page.total()).toBe("71"); expect(analytics()).toBe(savedAnalytics);
  await act(async () => refresh.resolve(unavailable())); await flush();
  expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("Mission Control could not be read");
  expect(page.total()).toBe("71"); expect(analytics()).toBe(savedAnalytics);
  expect(page.host.querySelector('a[href="#/agents/calc/runs"]')?.textContent).toContain("Calculator");
  expect(page.host.querySelector('a[href="#/runs/Saved%20recent%20run"]')).not.toBeNull();
  expect(page.host.querySelector('a[href="#/runs/Recovered%20recent%20run"]')).toBeNull();

  const retryButton = [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again")!;
  await act(async () => retryButton.click()); await flush();
  expect(page.statsCalls).toHaveLength(3); expect(page.recentCalls).toHaveLength(3);
  expect(page.host.querySelector('[role="alert"]')).toBeNull();
  expect(page.total()).toBe("71"); expect(analytics()).toBe(savedAnalytics);
  expect(page.host.querySelector('a[href="#/runs/Saved%20recent%20run"]')).not.toBeNull();
  expect(page.host.querySelector<HTMLButtonElement>('[aria-label="Refresh Mission Control"]')!.disabled).toBe(true);
  await act(async () => retry.resolve(json(stats(72)))); await flush();
  expect(page.total()).toBe("72");
  expect(page.host.querySelector('[role="alert"]')).toBeNull();
  expect(page.host.querySelector('a[href="#/runs/Recovered%20recent%20run"]')).not.toBeNull();
  expect(page.host.querySelector('a[href="#/runs/Saved%20recent%20run"]')).toBeNull();
  expect(page.host.querySelector<HTMLButtonElement>('[aria-label="Refresh Mission Control"]')!.disabled).toBe(false);
});

it("keeps an initial Mission Control failure as an error without inventing saved data, then recovers on retry", async () => {
  const first = deferred<Response>();
  const page = await mount((n) => n === 1 ? first.promise : json(stats(8)));
  expect(page.host.querySelector('[aria-label="Loading Mission Control"]')).not.toBeNull();
  expect(page.total()).toBeUndefined();
  await act(async () => first.resolve(unavailable())); await flush();
  expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("Mission Control could not be read");
  expect(page.host.querySelector('[aria-label="Loading Mission Control"]')).toBeNull();
  expect(page.host.querySelector('section[aria-label="Analytics"]')).toBeNull();
  expect(page.host.querySelector('a[href="#/runs/Current%20recent%20run"]')).toBeNull();
  expect(page.total()).toBeUndefined();
  await act(async () => [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again")!.click()); await flush();
  expect(page.total()).toBe("8");
  expect(page.host.querySelector('[role="alert"]')).toBeNull();
  expect(page.host.querySelector('section[aria-label="Analytics"]')).not.toBeNull();
});

it("ignores a late failed old-scope refresh after a new scope has successfully loaded", async () => {
  const old = deferred<Response>();
  const page = await mount((n) => n === 2 ? old.promise : json(stats(n === 3 ? 7 : 1)),
    (n) => json(recent(n === 3 ? "Current scope run" : "Previous scope run")));
  await advance(15_000); expect(page.statsCalls).toHaveLength(2);
  await act(async () => page.host.querySelector<HTMLInputElement>('input[name="mission-range"][value="7d"]')!.click()); await flush();
  expect(page.statsCalls).toHaveLength(3);
  expect(page.statsCalls[2]!.searchParams.get("from")).not.toBe(page.statsCalls[1]!.searchParams.get("from"));
  expect(page.total()).toBe("7");
  await act(async () => old.resolve(unavailable())); await flush();
  expect(page.total()).toBe("7");
  expect(page.host.querySelector<HTMLInputElement>('input[name="mission-range"][value="7d"]')!.checked).toBe(true);
  expect(page.host.querySelector('[role="alert"]')).toBeNull();
  expect(page.host.querySelector('a[href="#/runs/Current%20scope%20run"]')).not.toBeNull();
  expect(page.host.querySelector('a[href="#/runs/Previous%20scope%20run"]')).toBeNull();
});
