import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | undefined;
let server: Server | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  if (server) await new Promise<void>((resolve, reject) => {
    server!.close(error => error ? reject(error) : resolve());
    server!.closeAllConnections();
  });
  server = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  location.hash = "";
});

const CAPS = { models: { source: "providers", ready: true }, harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } };
const failed = (extra: object = {}) => ({
  run_id: "failed-1", agent_id: "calc", agent_version: 1, revision: "original-revision", kind: "agentic",
  title: "Original task", status: "failed", state: "idle", created_at: new Date(Date.now() - 60_000).toISOString(),
  ended_at: new Date().toISOString(), result: null, error: { code: "run_failed", message: "Fixture failure", retryable: false },
  effort: "low", cost: { usd: null, cap_usd: 0.1 }, archived_at: null, ...extra,
});
type HttpRequest = { method: string; path: string; body: unknown; key?: string };

/** The real App/client over a loopback HTTP peer; only the browser origin is forwarded, never v2 methods mocked. */
async function open(input: unknown, kind = "agentic") {
  const requests: HttpRequest[] = [];
  const listed = failed({ kind }); // A list deliberately carries neither the whole input nor file ids.
  const whole = { ...listed, ...(input !== undefined ? { input } : {}), file_ids: ["file-second", "file-first"], effort: "high", cost: { usd: null, cap_usd: 0.75 } };
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://fixture.test");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const method = request.method ?? "GET";
      requests.push({ method, path: url.pathname, body: text ? JSON.parse(text) : undefined, key: request.headers["idempotency-key"] as string | undefined });
      const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (url.pathname === "/v2/auth/session") return send(200, { password_set: true, signed_in: true });
      if (url.pathname === "/v2/capabilities") return send(200, CAPS);
      if (url.pathname === "/v2/health") return send(200, { status: "ok" });
      if (url.pathname === "/v2/stats") return send(200, { agents: 1, runs: { total: 1, active: 0, needs_input: 0, failed: 1, status_unknown: 0, needs_review: 0 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 1 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS });
      if (url.pathname === "/v2/agents") return send(200, { agents: [], next_cursor: null });
      if (url.pathname === "/v2/runs") return send(200, { runs: !url.searchParams.has("status") || url.searchParams.get("status") === "failed" ? [listed] : [], next_cursor: null });
      if (url.pathname === "/v2/runs/failed-1") return send(200, whole);
      // The old reconstruction path is available as a negative control, but contains a shortened, untyped task.
      if (url.pathname === "/v2/runs/failed-1/timeline") return send(200, { rows: [{ kind: "user_message", text: "A shortened timeline message..." }], next_cursor: null });
      if (url.pathname === "/v2/agents/calc/runs" && method === "POST") return send(201, { ...listed, run_id: "restarted-1", status: "queued", state: "queued", ended_at: null, error: null });
      return send(404, { error: { code: "not_found", message: `No fixture route: ${url.pathname}`, retryable: false } });
    })().catch(error => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "fixture_failed", message: String(error), retryable: false } })); });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    const from = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    return realFetch(`${origin}${from.pathname}${from.search}`, init);
  }) as typeof fetch);
  location.hash = "#/";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  const again = () => [...host.querySelectorAll('section[aria-label="Needs you"] button')].find(button => button.textContent === "Run again") as HTMLButtonElement | undefined;
  await wait(() => !!again() && !again()!.disabled, "the App offers the failed run");
  return { host, requests, again: () => again()!, starts: () => requests.filter(request => request.method === "POST") };
}
async function wait(done: () => boolean, why: string) {
  for (let tries = 0; tries < 120 && !done(); tries++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  expect(done(), why).toBe(true);
}

describe("App Run again over HTTP", () => {
  it("posts the read's complete typed input, ordered files, effort and cap, without a timeline reconstruction", async () => {
    const input = { content: "Keep this entire task. ".repeat(180), count: 0, allowed: false, subjects: ["first", "second"], flags: [true, false], note: "  " };
    expect(input.content.length).toBeGreaterThan(2000);
    const app = await open(input);
    await act(async () => app.again().click());
    await wait(() => app.starts().length > 0, "the App sends a new start");
    await wait(() => app.host.textContent?.includes("Started again: 1 run") === true, "the App accepts the successful HTTP response");
    expect(app.starts()).toHaveLength(1);
    expect(app.starts()[0].path).toBe("/v2/agents/calc/runs");
    expect(app.starts()[0].body).toEqual({ input, file_ids: ["file-second", "file-first"], effort: "high", max_cost_usd: 0.75 });
    expect(app.starts()[0].key).toBeTruthy();
    expect(app.requests.filter(request => request.path === "/v2/runs/failed-1")).toHaveLength(1);
    expect(app.requests.some(request => request.path.endsWith("/timeline"))).toBe(false);
  });

  it.each([null, undefined])("refuses withheld or absent input (%s) without a POST or timeline fallback", async input => {
    const app = await open(input);
    await act(async () => app.again().click());
    await wait(() => !!app.host.querySelector('[role="alert"]')?.textContent?.includes("its input can't be read back exactly"), "the App explains that the original task cannot be recovered");
    expect(app.starts()).toEqual([]);
    expect(app.requests.filter(request => request.path === "/v2/runs/failed-1")).toHaveLength(1);
    expect(app.requests.some(request => request.path.endsWith("/timeline"))).toBe(false);
  });

  it("keeps workflow reruns on the agent's page even when an input could be read", async () => {
    const app = await open({ content: "Do not dispatch from Mission Control" }, "workflow");
    await act(async () => app.again().click());
    await wait(() => !!app.host.querySelector('[role="alert"]')?.textContent?.includes("workflow run"), "the workflow guard remains visible");
    expect(app.starts()).toEqual([]);
    expect(app.requests.some(request => request.path === "/v2/runs/failed-1" || request.path.endsWith("/timeline"))).toBe(false);
  });
});
