import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ObservedSessionPage } from "@/components/ObservedSessions";
import { createClient } from "./client";
import type { Observations, ObservedSession } from "./observations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const usage = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, cache_hit_rate: null };
const session = (id: string, name: string, activity = "working"): ObservedSession => ({
  id, connector_id: "connector-a", source_id: "source-a", external_session_id: id, harness: "claude", activity, reported_activity: activity,
  connection_state: "online", selection_active: true, occurred_at: "2026-11-12T12:00:00Z", received_at: "2026-11-12T12:00:01Z",
  created_at: "2026-11-12T11:00:00Z", updated_at: "2026-11-12T12:00:01Z", sequence: 2, display_name: name, models: ["test-model"],
  usage: { ...usage, status: "unavailable" }, observation_only: true,
});
const answer = (id: string, name: string, activity?: string): Observations => ({ connectors: [], sessions: [session(id, name, activity)], usage: { ...usage, models: [], daily: [], status: "unavailable" } });
const json = (data: Observations) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
type Request = { url: string; signal: AbortSignal | null | undefined; resolve: (data: Observations) => void };
let root: Root | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, "hidden", "get").mockReturnValue(false); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); for (let i = 0; i < 12; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function mount() {
  const requests: Request[] = [];
  // Deliberately ignore abort when settling this adapter: buffered/late answers must remain harmless too.
  const fetch: typeof globalThis.fetch = async (url, init) => new Promise<Response>((resolve) => {
    requests.push({ url: String(url), signal: init?.signal, resolve: (data) => resolve(json(data)) });
  });
  const v2 = createClient({ fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const render = (id = "a") => act(async () => root!.render(createElement(ObservedSessionPage, { v2, sessionId: id, go: () => {} })));
  await render(); await flush();
  const refresh = () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh session"]')!;
  const settle = (n: number, data: Observations) => act(async () => { requests[n].resolve(data); });
  return { requests, host, render, refresh, settle };
}

it("times out a truly stalled HTTP read and allows an explicit retry without leaving the page", async () => {
  const page = await mount();
  expect(page.requests).toHaveLength(1); expect(page.refresh().disabled).toBe(true);
  await advance(29_999); expect(page.refresh().disabled).toBe(true);
  await advance(1);
  expect(page.host.querySelector('[role="alert"]')?.textContent).toMatch(/timed out/i);
  expect(page.refresh().disabled).toBe(false);
  expect(page.requests[0].signal?.aborted).toBe(true);
  await act(async () => page.refresh().click());
  expect(page.requests).toHaveLength(2);
  expect(page.requests[1].signal?.aborted).toBe(false);
  await page.settle(1, answer("a", "Recovered"));
  expect(page.host.querySelector("h1")?.textContent).toBe("Recovered");
  expect(page.host.querySelector('[role="alert"]')).toBeNull();
  await page.settle(0, answer("a", "Stale answer"));
  expect(page.host.querySelector("h1")?.textContent).toBe("Recovered");
});

it("retains prior cards, avoids overlapping focus/polls and resumes automatic reads after a timeout", async () => {
  const page = await mount(); await page.settle(0, answer("a", "Existing backend"));
  await advance(15_000); expect(page.requests).toHaveLength(2);
  await advance(29_999);
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(page.requests).toHaveLength(2);
  await advance(1);
  expect(page.host.querySelector("h1")?.textContent).toBe("Existing backend");
  expect(page.host.querySelector('[role="alert"]')?.textContent).toMatch(/timed out/i);
  expect(page.refresh().disabled).toBe(false);
  expect(page.requests[1].signal?.aborted).toBe(true);
  await advance(14_999); expect(page.requests).toHaveLength(2);
  await advance(1); expect(page.requests).toHaveLength(3);
  await page.settle(1, answer("a", "Old buffered answer"));
  expect(page.refresh().disabled).toBe(true);
  expect(page.host.querySelector("h1")?.textContent).toBe("Existing backend");
  await page.settle(2, answer("a", "Existing backend", "idle"));
  expect(page.host.textContent).toContain("Idle");
  expect(page.host.querySelector('[role="alert"]')).toBeNull();
});

it("aborts an old scope without letting its late completion clear the newer scope's pending state", async () => {
  const page = await mount();
  await page.render("b");
  expect(page.requests).toHaveLength(2);
  expect(page.requests[0].signal?.aborted).toBe(true);
  expect(page.requests[1].signal?.aborted).toBe(false);
  await page.settle(0, answer("a", "Old scope"));
  expect(page.host.textContent).not.toContain("Old scope");
  expect(page.refresh().disabled).toBe(true);
  await page.settle(1, answer("b", "New scope"));
  expect(page.host.querySelector("h1")?.textContent).toBe("New scope");
  await advance(1_000); expect(page.requests).toHaveLength(2);
});

it("aborts on unmount and removes the deadline and future polling even if the read later resolves", async () => {
  const page = await mount();
  act(() => root!.unmount()); root = undefined;
  expect(page.requests[0].signal?.aborted).toBe(true);
  await advance(60_000);
  await page.settle(0, answer("a", "Detached answer"));
  await advance(60_000);
  expect(page.requests).toHaveLength(1);
  expect(page.host.querySelector("h1")).toBeNull();
});
