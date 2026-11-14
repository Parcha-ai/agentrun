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
const recent = (title: string) => ({ runs: [{ run_id: title, agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title,
  created_at: "2026-11-04T06:00:00Z", ended_at: "2026-11-04T06:00:05Z", result: null, error: null, cost: null, archived_at: null }], next_cursor: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); for (let i = 0; i < 20; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function mount(answerStats: (n: number, url: URL) => Response | Promise<Response>, answerRecent: (n: number) => Response | Promise<Response> = () => json(recent("Current recent run"))) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const statsCalls: URL[] = [], recentCalls: URL[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/auth/session") return json({ password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json({ models: { source: "providers", ready: true }, harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (u.pathname === "/v2/health") return json({ status: "ok" });
    if (u.pathname === "/v2/agents") return json({ agents: [], next_cursor: null });
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
