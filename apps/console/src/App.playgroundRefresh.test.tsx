import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App, Console, IMPORT_POLL_MS } from "./App";
import { createClient, type Client } from "@/lib/client";
import type { Agent } from "@/lib/agentForm";
import { picker } from "@/test/picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const agent = (id: string): Agent => ({ agent_id: id, kind: "agentic", revision: "r2", revisions: 2, archived_at: null, definition: { version: 2, name: id, instructions: "Answer.", harness: "pi", skills: [], tools: [] } });
const reviewer = agent("reviewer"), other = agent("other");
const fileId = "019a0000-0000-7000-8000-000000000001";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
// The shared picker driver's zero-delay waits use real timers; drive these controlled timers explicitly instead.
const choose = async (field: HTMLButtonElement, value: string) => {
  await act(async () => field.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const option = document.querySelector<HTMLElement>(`[role="listbox"] [role="option"][data-value="${value}"]`)!;
  expect(option).not.toBeNull();
  await act(async () => option.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
};

async function open({ initialPending = false, explicitAgent = true, initialAgents = [reviewer] } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  let signedIn = true, imported = false, holding = initialPending, waiting = 0, uploads = 0, abortedUploads = 0;
  let available = initialAgents;
  const read = deferred<Response>();
  const writes: { path: string; body: unknown }[] = [];
  // Exercise the real upload transport too; refresh must keep its ready attachment, not abort/re-upload it.
  vi.stubGlobal("XMLHttpRequest", class {
    upload = { onprogress: null }; onload: (() => void) | null = null; onerror = null; onabort: (() => void) | null = null;
    status = 201; responseText = JSON.stringify({ file: { file_id: fileId, path: "notes.txt", size_bytes: 5, content_type: "text/plain", sha256: "a".repeat(64), status: "ready" } });
    open() {} setRequestHeader() {}
    send() { uploads++; this.onload?.(); }
    abort() { abortedUploads++; this.onabort?.(); }
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "https://console.example.test"), path = u.pathname;
    if (path === "/v2/auth/session") return json({ password_set: true, signed_in: signedIn });
    if (path === "/v2/auth/sign-out") { signedIn = false; return json({ signed_out: true }); }
    if (path === "/v2/auth/sign-in") { signedIn = true; return json({ signed_in: true }); }
    if (path === "/v2/setup/import") return json(imported ? { state: "done", agents: 1, runs: 2, skipped: 0 } : { state: "running" });
    if (path === "/v2/capabilities") return json({ harnesses: [], models: { ready: true }, features: { efforts: ["high"] } });
    if (path === "/v2/agents") {
      if (holding) { waiting++; return (await read.promise).clone(); }
      return json({ agents: u.searchParams.get("archived") === "true" ? [] : available, next_cursor: null });
    }
    if (path.endsWith("/revisions")) return json({ revisions: [{ revision: "r1", version: 1, current: false, note: "Reviewed" }, { revision: "r2", version: 2, current: true, note: null }], next_cursor: null });
    if (path.endsWith("/runs") && init?.method === "POST") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return json({ error: { code: "scripted_refusal", message: "Scripted refusal", retryable: false } }, 422);
    }
    return json({ error: { code: "not_found", message: path, retryable: false } }, 404);
  });
  history.replaceState(null, "", explicitAgent ? "#/playground?agent=reviewer" : "#/playground");
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const message = () => host.querySelector<HTMLTextAreaElement>('section[aria-label="Request"] textarea');
  const send = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Send request")!;
  return { host, message, send, writes, uploads: () => uploads, abortedUploads: () => abortedUploads,
    completeImport: async () => { holding = true; imported = true; await act(async () => vi.advanceTimersByTimeAsync(IMPORT_POLL_MS)); expect(waiting).toBeGreaterThan(0); },
    finish: async (agents = [reviewer, agent("imported")], status = 200) => { holding = false; available = agents; await act(async () => read.resolve(status === 200 ? json({ agents, next_cursor: null }) : json({ error: { code: "cannot_list", message: "Agent list unavailable", retryable: false } }, status))); },
    navigate: async (id: string) => { holding = false; available = [other]; await act(async () => { history.replaceState(null, "", `#/playground?agent=${id}`); window.dispatchEvent(new HashChangeEvent("hashchange")); }); },
  };
}

it("keeps the composed Playground request mounted while import completion refreshes its agents, then sends the same options and attachment", async () => {
  const page = await open();
  const message = page.message()!;
  type(message, "Keep this unfinished review.");
  await choose(picker(page.host, "Revision")!, "r1");
  await choose(picker(page.host, "Effort")!, "high");
  type(page.host.querySelector<HTMLInputElement>('input[placeholder="owner/name"]')!, "owner/repo");
  type(page.host.querySelector<HTMLInputElement>('input[placeholder="e.g. 0.50"]')!, "0.50");
  const file = page.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { configurable: true, value: [new File(["notes"], "notes.txt", { type: "text/plain" })] });
  await act(async () => file.dispatchEvent(new Event("change", { bubbles: true })));
  expect(page.host.textContent).toContain("notes.txt");
  await page.completeImport();
  expect(page.message()).toBe(message);
  expect(message.value).toBe("Keep this unfinished review.");
  await page.finish();
  expect(page.message()).toBe(message);
  expect(page.uploads()).toBe(1);
  expect(page.abortedUploads()).toBe(0);
  await act(async () => page.send().click());
  expect(page.writes).toEqual([{ path: "/v2/agents/reviewer/runs", body: { input: { content: "Keep this unfinished review." }, revision: "r1", effort: "high", repo: "owner/repo", max_cost_usd: 0.5, file_ids: [fileId] } }]);
});

it("retains the request and displayed response when the background agent refresh fails, and recovers without remounting", async () => {
  const page = await open(); const message = page.message()!;
  type(message, "Keep the response, too.");
  await act(async () => page.send().click());
  expect(page.host.textContent).toContain("Scripted refusal");
  await page.completeImport();
  expect(page.message()).toBe(message);
  await page.finish([reviewer], 400);
  expect(page.host.textContent).toContain("Agent list unavailable");
  expect(page.host.textContent).toContain("Scripted refusal");
  expect(page.message()).toBe(message);
  const retry = [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Try again")!;
  await act(async () => retry.click());
  expect(page.host.textContent).not.toContain("Agent list unavailable");
  expect(page.message()).toBe(message);
  expect(message.value).toBe("Keep the response, too.");
});

it("waits for the initial agent list and blocks an unavailable requested agent", async () => {
  const page = await open({ initialPending: true });
  expect(page.message()).toBeNull();
  await page.finish([]);
  expect(page.host.textContent).toContain("The selected agent is unavailable or archived");
  expect(page.message()).toBeNull();
  expect(page.writes).toEqual([]);
});

it("blocks a previously available requested agent confirmed removed by the background refresh", async () => {
  const page = await open(); type(page.message()!, "Do not retarget this request.");
  await page.completeImport();
  await page.finish([other]);
  expect(page.host.textContent).toContain("The selected agent is unavailable or archived");
  expect(page.message()).toBeNull();
  expect(page.writes).toEqual([]);
});

it("does not retarget a composed request when its selected agent disappears on the bare Playground address", async () => {
  const page = await open({ explicitAgent: false }); type(page.message()!, "Only for the selected reviewer.");
  await page.completeImport();
  await page.finish([other]);
  expect(page.host.textContent).toContain("The selected agent is unavailable or archived");
  expect(page.message()).toBeNull();
  expect(page.writes).toEqual([]);
});

it("keeps the person's agent choice instead of restoring the initial URL target after background refresh", async () => {
  const page = await open({ initialAgents: [reviewer, other] });
  await choose(picker(page.host, "Agent")!, "other");
  const message = page.message()!; type(message, "For the agent I chose.");
  await page.completeImport();
  await page.finish([reviewer, other]);
  expect(picker(page.host, "Agent")!.getAttribute("data-value")).toBe("other");
  expect(page.message()).toBe(message);
  await act(async () => page.send().click());
  expect(page.writes).toEqual([{ path: "/v2/agents/other/runs", body: { input: { content: "For the agent I chose." } } }]);
});

it("does not apply a late background list to another explicit agent scope", async () => {
  const page = await open(); type(page.message()!, "Old scope draft");
  await page.completeImport();
  await page.navigate("other");
  expect(page.message()!.value).toBe("");
  expect(picker(page.host, "Agent")!.textContent).toContain("other");
  await page.finish([reviewer]);
  expect(picker(page.host, "Agent")!.textContent).toContain("other");
  expect(page.message()!.value).toBe("");
});

it("discards the prior session draft at sign-out and ignores its late refresh after signing in again", async () => {
  const page = await open(); type(page.message()!, "Prior session private draft");
  await page.completeImport();
  const signOut = [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Sign out")!;
  await act(async () => signOut.click());
  expect(page.message()).toBeNull();
  const password = page.host.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(password).not.toBeNull();
  await page.finish();
  expect(page.message()).toBeNull();
  type(password, "not-a-secret");
  await act(async () => page.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(page.message()!.value).toBe("");
  expect(page.writes).toEqual([]);
});

it("never commits the previous client's agent list or private request when the client instance is replaced", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  history.replaceState(null, "", "#/playground");
  const nextAgents = deferred<Response>();
  const client = (base: string, fresh: boolean) => createClient({ base, fetch: (async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v2/agents") return fresh ? (await nextAgents.promise).clone() : json({ agents: [reviewer], next_cursor: null });
    if (path === "/v2/capabilities") return json({ harnesses: [], features: {}, models: { ready: true } });
    if (path === "/v2/setup/import") return json({ offer: false });
    return json({ error: { code: "not_found", message: path, retryable: false } }, 404);
  }) as typeof fetch });
  const first = client("https://first.example.test/v2", false), second = client("https://second.example.test/v2", true);
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const committed: { text: string; draft: string | null }[] = [];
  function Boundary({ v2 }: { v2: Client }) {
    // Observe the DOM at commit, before passive effects can clear leaked client data after a paint.
    useLayoutEffect(() => { committed.push({ text: host.textContent ?? "", draft: host.querySelector<HTMLTextAreaElement>('section[aria-label="Request"] textarea')?.value ?? null }); }, [v2]);
    return createElement(Console, { v2, onSignedOut: () => {} });
  }
  await act(async () => root!.render(createElement(Boundary, { v2: first })));
  const message = host.querySelector<HTMLTextAreaElement>('section[aria-label="Request"] textarea')!;
  type(message, "Previous client private draft");
  await act(async () => root!.render(createElement(Boundary, { v2: second })));
  expect(committed.at(-1)?.draft).toBeNull();
  expect(committed.at(-1)?.text).not.toContain("reviewer");
  await act(async () => nextAgents.resolve(json({ agents: [other], next_cursor: null })));
  expect(picker(host, "Agent")!.textContent).toContain("other");
  expect(host.querySelector<HTMLTextAreaElement>('section[aria-label="Request"] textarea')!.value).toBe("");
});
