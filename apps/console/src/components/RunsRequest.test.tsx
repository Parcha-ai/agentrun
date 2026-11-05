import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunsRequest } from "./RunsRequest";
import { createClient } from "@/lib/client";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const origin = "https://console.example.test";
type Call = { url: URL; method: string; body: BodyInit | null | undefined };
let root: Root | undefined;
let host: HTMLDivElement;
let calls: Call[];
const run = (id: string) => ({ run_id: id, agent_id: "support/a", kind: "agentic", status: "completed", state: "idle", title: `Result ${id}`, created_at: "2026-11-01T00:00:00Z", ended_at: "2026-11-01T00:00:01Z", cost: null, error: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function mount(props: Omit<ComponentProps<typeof RunsRequest>, "v2" | "origin"> = {}, answer: (c: Call) => Response | Promise<Response> = () => json({ runs: [], next_cursor: null })) {
  calls = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { url: new URL(url, origin), method: init?.method ?? "GET", body: init?.body };
    calls.push(call); return answer(call);
  }) as typeof globalThis.fetch;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const v2 = createClient({ fetch });
  await act(async () => root!.render(createElement(RunsRequest, { ...props, origin, v2 })));
  return v2;
}
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;
const select = (name: string, value: string) => act(() => {
  const field = host.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("change", { bubbles: true }));
});
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); });

describe("RunsRequest", () => {
  it("prepares a read-only all-runs request and fetches only when Send is clicked", async () => {
    await mount();
    expect(calls).toEqual([]);
    expect(host.querySelector("pre")?.textContent).toContain("GET");
    expect(host.querySelector("pre")?.textContent).toContain("/v2/runs?limit=50");
    await act(async () => button("Send request").click());
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].url.pathname).toBe("/v2/runs");
    expect(host.textContent).toContain("No runs match this request");
  });

  it("keeps agent, status and archived scope across cursor pages and links to results", async () => {
    await mount({ agentId: "support/a", filter: { status: "failed", archived: true } }, (c) => c.url.searchParams.has("cursor") ? json({ runs: [run("second")], next_cursor: null }) : json({ runs: [run("first")], next_cursor: "next/page + 1" }));
    expect(calls).toEqual([]);
    await act(async () => button("Send request").click());
    expect(host.querySelector('a[href="#/runs/first"]')).not.toBeNull();
    await act(async () => button("Next page").click());
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeUndefined();
      expect(call.url.pathname).toBe("/v2/agents/support%2Fa/runs");
      expect(call.url.searchParams.get("status")).toBe("failed");
      expect(call.url.searchParams.get("archived")).toBe("true");
    }
    expect(calls[1].url.searchParams.get("cursor")).toBe("next/page + 1");
    expect(host.querySelector('a[href="#/runs/second"]')).not.toBeNull();
    expect(button("Next page")).toBeUndefined();
  });

  it("resets cursor and response when changing filters, without automatically fetching", async () => {
    await mount({}, () => json({ runs: [run("first")], next_cursor: "page-two" }));
    await act(async () => button("Send request").click());
    await act(async () => button("Next page").click());
    expect(calls).toHaveLength(2);
    select("Run status", "working");
    expect(calls).toHaveLength(2);
    expect(host.querySelector('a[href="#/runs/first"]')).toBeNull();
    await act(async () => button("Send request").click());
    expect(calls[2].url.searchParams.get("cursor")).toBeNull();
    expect(calls[2].url.searchParams.get("status")).toBe("working");
  });

  it("copies the exact scoped query for the preferred coding agent", async () => {
    localStorage.setItem(CODING_AGENT_PREFERENCE, "codex-cli");
    const copy = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    await mount({ agentId: "agent one" });
    select("Run status", "input_required");
    select("Archived runs", "true");
    await act(async () => button("Use your agent").click());
    const prompt = copy.mock.calls[0][0] as string;
    expect(prompt).toContain("GET https://console.example.test/v2/agents/agent%20one/runs?limit=50&status=input_required&archived=true");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("Do not broaden");
    expect(calls).toEqual([]);
  });

  it("discards a pending response after switching agent scope and waits for an explicit request", async () => {
    let finish!: (response: Response) => void;
    const v2 = await mount({ agentId: "first-agent" }, (c) => c.url.pathname.includes("first-agent")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : json({ runs: [run("second-agent-run")], next_cursor: null }));
    await act(async () => button("Send request").click());
    expect(calls).toHaveLength(1);
    await act(async () => root!.render(createElement(RunsRequest, { origin, v2, agentId: "second-agent" })));
    await act(async () => finish(json({ runs: [run("old-agent-run")], next_cursor: "old-cursor" })));
    expect(calls).toHaveLength(1);
    expect(host.textContent).not.toContain("old-agent-run");
    expect(button("Next page")).toBeUndefined();
    await act(async () => button("Send request").click());
    expect(calls[1].url.pathname).toBe("/v2/agents/second-agent/runs");
    expect(calls[1].url.searchParams.has("cursor")).toBe(false);
    expect(host.querySelector('a[href="#/runs/second-agent-run"]')).not.toBeNull();
  });

  it("shows a read failure without retrying or exposing another page's cursor", async () => {
    await mount({}, () => json({ error: { code: "unavailable", message: "Store unavailable", retryable: true } }, 503));
    await act(async () => button("Send request").click());
    expect(host.textContent).toContain("Store unavailable");
    expect(calls).toHaveLength(1);
    expect(button("Next page")).toBeUndefined();
  });
});
