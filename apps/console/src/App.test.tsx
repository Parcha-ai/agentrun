import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, route, runsHash } from "./App";
import { agentHash } from "@/components/AgentPage";

// Mission Control is the first page: the bare address and the old start page's both open it, so no link dead-ends.
describe("route", () => {
  it("opens Mission Control for the bare address and the old start page", () => {
    for (const h of ["", "#", "#/", "#/start"]) expect(route(h).section, h).toBe("mission");
  });
  it("still opens the runs list, a run, and an agent's runs at their own addresses", () => {
    expect(route("#/runs")).toEqual({ section: "runs" });
    expect(route("#/runs/r1")).toEqual({ section: "runs", run: "r1" });
    expect(route("#/runs?agent=calc")).toEqual({ section: "runs", runsOf: "calc" });
  });
  it("opens Settings → Tool keys at its own address, and at #/settings", () => {
    expect(route("#/settings/keys")).toEqual({ section: "settings", settings: "keys" });
    expect(route("#/settings")).toEqual({ section: "settings", settings: "keys" });
  });
  it("reads the runs list's filters from the address and writes them back the same way, so a reload keeps them", () => {
    expect(route("#/runs?status=failed")).toEqual({ section: "runs", status: "failed" });
    expect(route("#/runs?agent=calc&status=input_required&archived=true")).toEqual({ section: "runs", runsOf: "calc", status: "input_required", archived: true });
    expect(route("#/runs?status=sleeping&archived=yes")).toEqual({ section: "runs" });
    expect(runsHash({ runsOf: "calc", status: "failed", archived: true })).toBe("#/runs?agent=calc&status=failed&archived=true");
    for (const f of [{}, { status: "failed" as const }, { archived: true }, { runsOf: "c a", status: "completed" as const, archived: true }]) expect(route(runsHash(f))).toEqual({ section: "runs", ...f });
  });
  it("opens an agent's page at its address, and its editor under /edit; a new agent and the archived list are unchanged", () => {
    expect(route("#/agents/x")).toEqual({ section: "agents", agent: "x" });
    expect(route("#/agents/x/workflow")).toEqual({ section: "agents", agent: "x", tab: "workflow" });
    expect(route("#/agents/x/edit")).toEqual({ section: "agents", agent: "x", edit: true });
    expect(route("#/agents/new")).toEqual({ section: "agents", agent: null });
    expect(route("#/agents?archived=true")).toEqual({ section: "agents", archived: true });
    expect(route("#/agents")).toEqual({ section: "agents", archived: false });
  });
  it("gives an agent whose id is new addresses that never open the create form", () => {
    expect(route(agentHash("new"))).toEqual({ section: "agents", agent: "new", tab: "runs" });
    expect(route(agentHash("new", "edit"))).toEqual({ section: "agents", agent: "new", edit: true });
    expect(route(agentHash("a b"))).toEqual({ section: "agents", agent: "a b" });
  });
});

// A server without GET /v2/stats (or one that fails it) says so on the page, never a "Loading..." that never ends.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

describe("App, Mission Control when the stats can't be read", () => {
  it("shows the error, not Loading for ever", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/stats") return json(404, { error: { code: "not_found", message: "no route GET /v2/stats", retryable: false } });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const end = Date.now() + 4000;
    while (!host.textContent?.includes("could not be read") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(host.textContent).toContain("Mission Control could not be read");
    expect(host.textContent).toContain("not_found");
  });
});

describe("App, Mission Control after a failed read", () => {
  it("Try again reads the stats and the latest runs again, and shows them", async () => {
    let statsCalls = 0;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/stats") return ++statsCalls === 1
        ? json(503, { error: { code: "store_busy", message: "the store is busy", retryable: true } })
        : json(200, { agents: 3, runs: { total: 9, active: 0, needs_input: 0, failed: 0, status_unknown: 0 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 9 }, archived: { agents: 0, runs: 0 } });
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const wait = async (ok: () => boolean) => { const end = Date.now() + 4000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); };
    await wait(() => !!host.textContent?.includes("could not be read"));
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /try again/i.test(b.textContent ?? ""))!.click(); });
    await wait(() => !host.textContent?.includes("could not be read"));
    expect(statsCalls).toBe(2);
    expect(host.textContent).toContain("Mission Control");
    expect(host.textContent).not.toContain("could not be read");
  });
});

// Settings shows only on a server with the tool keys routes, so the console never offers a page its server lacks.
describe("App, Settings", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const keys = { keys: [{ id: "monid", label: "Monid", fields: [{ name: "MONID_API_KEY", set: false, source: null }], unlocks: ["monid.run"], harnesses: ["pi"] }], reenter: null };
  async function open(features: Record<string, unknown>, hash: string) {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://serve.test").pathname;
      asked.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path.startsWith("/v2/settings/tool-keys/")) return new Response(null, { status: 204 });
      if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false }, ...features } });
      if (path === "/v2/settings/tool-keys") return json(200, keys);
      if (path === "/v2/runs" || path === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = hash;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const end = Date.now() + 4000;
    while (!host.querySelector('nav[aria-label="Navigation"] button') && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const nav = () => [...host.querySelectorAll('nav[aria-label="Navigation"] button')].map((b) => b.textContent?.trim());
    return { host, nav, asked };
  }

  it("has no Settings in the nav when the server has no features.tool_keys", async () => {
    const page = await open({}, "#/runs");
    expect(page.nav()).toContain("Runs");
    expect(page.nav()).not.toContain("Settings");
  });

  it("shows Settings when the server has the routes, and #/settings/keys opens Tool keys", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/keys");
    expect(page.nav()).toContain("Settings");
    expect(page.host.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe("Settings");
    expect(page.host.querySelector("h1")?.textContent).toBe("Tool keys");
    expect(page.host.textContent).toContain("MONID_API_KEYnot set");
  });

  it("reads the capabilities again after a key is saved, so the tools it unlocks are offered without a reload", async () => {
    const page = await open({ tool_keys: { routes: true, at_rest: "sealed" } }, "#/settings/keys");
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    const button = (label: RegExp) => [...page.host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!;
    const caps = () => page.asked.filter((a) => a === "GET /v2/capabilities").length;
    expect(caps()).toBe(1);
    await act(async () => { button(/^Add key$/).click(); }); await settle();
    const input = page.host.querySelector('input[name="MONID_API_KEY"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "not-a-real-key-0123"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { button(/^Save$/).click(); }); await settle();
    expect(page.asked).toContain("PUT /v2/settings/tool-keys/monid");
    expect(caps()).toBe(2);
  });
});

// Archive on a run's page hides it from the runs list and keeps it among the archived runs; the list's filters ask the
// server with its own parameters, and the address keeps them.
describe("App, archiving a run and filtering the runs list", () => {
  it("Archive moves the run out of the default list into the archived one; the state filter asks the server", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const run = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "What is two and two?", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: { final_answer: "4" }, error: null, cost: null, archived_at: null as string | null };
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://serve.test");
      const method = init?.method ?? "GET";
      asked.push(`${method} ${u.pathname}${u.search}`);
      if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
      if (u.pathname === "/v2/runs") {
        const archived = u.searchParams.get("archived") === "true", status = u.searchParams.get("status");
        return json(200, { runs: [run].filter((r) => !!r.archived_at === archived && (!status || r.status === status)), next_cursor: null });
      }
      if (u.pathname === "/v2/runs/r1") return json(200, run);
      if (u.pathname === "/v2/runs/r1/archive" && method === "POST") { run.archived_at = "2026-11-01T07:00:00Z"; return json(200, run); }
      if (u.pathname === "/v2/runs/r1/files") return json(200, { run_id: "r1", files: [], complete: true, truncated: false });
      if (u.pathname === "/v2/runs/r1/timeline") return json(200, { run_id: "r1", status: "completed", state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
      return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
    });
    location.hash = "#/runs";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const wait = async (ok: () => boolean, what: string) => {
      const end = Date.now() + 4000;
      while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
      expect(ok(), what).toBe(true);
    };
    const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
    await wait(() => !!host.textContent?.includes("What is two and two?"), "the run is listed");
    await act(async () => { button(/What is two and two\?/)!.click(); });
    await wait(() => !!button(/^Archive$/), "the run's page offers Archive");
    await act(async () => { button(/^Archive$/)!.click(); });
    await wait(() => !!button(/^Unarchive$/), "the run reads archived");
    expect(asked).toContain("POST /v2/runs/r1/archive");
    expect([...host.querySelectorAll("header")].find((h) => h.textContent?.includes("What is two and two?"))?.textContent).toContain("Archived");
    location.hash = "#/runs";
    await wait(() => !!host.textContent?.includes("No runs yet."), "the default list leaves it out");
    expect(host.textContent).not.toContain("What is two and two?");
    await act(async () => { button(/^Archived$/)!.click(); });
    await wait(() => !!host.textContent?.includes("What is two and two?"), "the archived runs hold it");
    expect(location.hash).toBe("#/runs?archived=true");
    expect(host.querySelector("h1")?.textContent).toBe("Archived runs");
    const select = host.querySelector("select[aria-label='Runs in one state']") as HTMLSelectElement;
    await act(async () => { select.value = "failed"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await wait(() => !!host.textContent?.includes("No run matches."), "no archived run failed");
    expect(location.hash).toBe("#/runs?status=failed&archived=true");
    expect(asked).toContain("GET /v2/runs?limit=50&status=failed&archived=true");
  });
});

describe("App, an agent's address", () => {
  it("opens the agent's page, and /edit opens its editor", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const calc = { agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [{ id: "pi", available: true }], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/agents") return json(200, { agents: [calc], next_cursor: null });
      if (path === "/v2/agents/calc") return json(200, calc);
      if (path === "/v2/agents/calc/runs" || path === "/v2/agents/calc/revisions") return json(200, { runs: [], revisions: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "#/agents/calc";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const wait = async (ok: () => boolean) => { const end = Date.now() + 4000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); };
    await wait(() => !!host.textContent?.includes("No runs of this agent yet."));
    expect(host.querySelector('[role="tab"]')?.textContent).toBe("Runs");
    expect(host.textContent).not.toContain("Save revision");
    await act(async () => { location.hash = "#/agents/calc/edit"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await wait(() => !!host.textContent?.includes("Save revision"));
    expect(host.textContent).toContain("Save revision");
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });
});
