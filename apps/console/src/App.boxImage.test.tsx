import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

// Mission Control says when the Docker box's image is still coming, as a run's page does on its timeline: from
// capabilities' places.boxes (the docker box's state "preparing" and its served reason). While a box is preparing, the
// console reads the capabilities again (the one guarded reader, on the no-model check's cadence), so the banner goes by
// itself once the server says the box is ready; with nothing preparing, nothing is read again.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.useRealTimers(); location.hash = ""; });
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BUILDING = "building the box image (python, git, curl, node, npm, rg)";
type Docker = { available: boolean; state: "ready" | "preparing" | "unavailable"; reason?: string };
const capsWith = (docker: Docker) => ({
  harnesses: [], models: { source: "providers", ready: true }, features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } },
  places: { modes: ["runner", "sandbox"], default_place: { mode: "sandbox", box: "docker" }, boxes: [{ id: "bwrap", available: false, state: "unavailable", reason: "not listed" }, { id: "docker", ...docker }], allow: [] },
});
const RUN = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", title: "Hi", status: "completed", state: "idle", created_at: "2026-11-06T09:00:00Z", ended_at: "2026-11-06T09:00:05Z", result: null, error: null, cost: null, archived_at: null };
const STATS = {
  agents: 1, runs: { total: 1, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 },
  per_agent: [{ agent_id: "calc", name: "Calculator", runs: 1 }], cost: { usd: null, basis: null, unknown_runs: 1 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS,
};

function serve(docker: () => Docker, hold?: () => Promise<void> | undefined) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    asked.push(u.pathname);
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") { await hold?.(); return json(200, capsWith(docker())); }
    if (u.pathname === "/v2/health") return json(200, { status: "ok" });
    if (u.pathname === "/v2/stats") return json(200, STATS);
    if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: u.searchParams.get("status") ? [] : [RUN], next_cursor: null });
    return json(404, { error: { code: "not_found", message: `no route ${u.pathname}`, retryable: false } });
  });
  return { reads: () => asked.filter((p) => p === "/v2/capabilities").length };
}
const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};
async function mount() {
  location.hash = "#/";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  await wait(() => !!host.querySelector('section[aria-label="Analytics"]'), "Mission Control");
  return host;
}
const banner = (host: HTMLElement) => host.querySelector('[role="status"][aria-label="Docker box"]');

describe("Mission Control while the Docker box's image is coming", () => {
  it("says the box is preparing, in the server's words", async () => {
    serve(() => ({ available: true, state: "preparing", reason: BUILDING }));
    const host = await mount();
    await wait(() => !!banner(host), "the box banner");
    expect(banner(host)!.textContent).toBe(`Preparing the Docker box: ${BUILDING}. A sandbox run waits for it before its first tool call.`);
  });

  it("reads the capabilities again while it prepares, and the banner goes once the box is ready", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let docker: Docker = { available: true, state: "preparing", reason: BUILDING };
    const s = serve(() => docker);
    const host = await mount();
    await wait(() => !!banner(host), "the box banner");
    const before = s.reads();
    docker = { available: true, state: "ready" };
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await wait(() => !banner(host), "the banner gone");
    expect(s.reads()).toBe(before + 1);
    // Ready: no more reads of its own.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(s.reads()).toBe(before + 1);
  });

  it("starts no read again while one is still answering: a slow read's answer lands, and the banner goes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let docker: Docker = { available: true, state: "preparing", reason: BUILDING };
    let release: (() => void) | undefined;
    let held: Promise<void> | undefined;
    const s = serve(() => docker, () => held);
    const host = await mount();
    await wait(() => !!banner(host), "the box banner");
    const before = s.reads();
    // The next read takes longer than the poll's period: the server answers ready only when it is released.
    held = new Promise((r) => { release = r; });
    docker = { available: true, state: "ready" };
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await wait(() => s.reads() === before + 1, "the poll's read");
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(s.reads(), "no read starts while one is in flight").toBe(before + 1);
    held = undefined;
    release!();
    await wait(() => !banner(host), "the banner gone, from the slow read's answer");
  });

  it("with the box ready, there is no banner and no read again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = serve(() => ({ available: true, state: "ready" }));
    const host = await mount();
    const before = s.reads();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(banner(host)).toBeNull();
    expect(s.reads()).toBe(before);
  });
});
