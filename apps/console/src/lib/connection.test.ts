import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, createConnection, Unreachable } from "./connection";

// The console rides out its server going away: a read waits and is sent again once the server answers, a write says the
// server can't be reached, and one probe at a time (1, 2, 4, 8, then every 10 s) tells when it is back.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A server that can be taken away and brought back; every request it was asked is in `asked`. */
function server() {
  const s = { up: true, asked: [] as string[], answer: (path: string) => json(200, { path }) };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    s.asked.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (!s.up) throw new TypeError("Failed to fetch");
    return s.answer(path);
  }) as typeof globalThis.fetch;
  return { s, fetch };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("backoffMs", () => {
  it("waits 1, 2, 4 and 8 s, then 10 s at most", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  });
});

describe("createConnection", () => {
  it("a read the server can't take waits, and is sent again once the server answers its probe", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.up = false;
    let body: unknown;
    void c.fetch("/v2/runs/r1").then(async (r) => { body = await r.json(); });
    await flush();
    expect(c.link().state).toBe("offline");
    expect(body).toBeUndefined();
    s.up = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(body).toEqual({ path: "/v2/runs/r1" });
    expect(c.link().state).toBe("resumed");
    expect(s.asked).toEqual(["GET /v2/runs/r1", "GET /v2/health", "GET /v2/runs/r1"]);
  });

  it("probes once per wait, on the backoff, however many reads are waiting", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.up = false;
    for (const p of ["/v2/a", "/v2/b", "/v2/c"]) void c.fetch(p);
    await flush();
    const probes = () => s.asked.filter((a) => a.endsWith("/v2/health")).length;
    await vi.advanceTimersByTimeAsync(999);
    expect(probes()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes()).toBe(1);
    const at = (c.link() as { retryAt: number }).retryAt;
    expect(at - Date.now()).toBe(2000);
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 10000 + 10000);
    expect(probes()).toBe(6);
    expect(s.asked.filter((a) => !a.endsWith("/v2/health"))).toEqual(["GET /v2/a", "GET /v2/b", "GET /v2/c"]);
  });

  it("a write the server can't take is refused with Unreachable, never sent again by itself", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.up = false;
    const sent = c.fetch("/v2/runs/r1/stop", { method: "POST" });
    await expect(sent).rejects.toBeInstanceOf(Unreachable);
    await expect(c.fetch("/v2/runs/r1/stop", { method: "POST" })).rejects.toThrow("Can't reach agentrun-serve");
    s.up = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.asked.filter((a) => a.startsWith("POST"))).toHaveLength(2);
  });

  it("a waiting read whose signal aborts is dropped with the abort", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.up = false;
    const ctl = new AbortController();
    const read = c.fetch("/v2/runs/r1/timeline?after=3", { signal: ctl.signal });
    await flush();
    ctl.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    s.up = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.asked.filter((a) => a.includes("timeline"))).toHaveLength(1);
  });

  it("a 5xx without the server's JSON error is something in front of it (a proxy): the server is away", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.answer = () => new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } });
    void c.fetch("/v2/stats");
    await flush();
    expect(c.link().state).toBe("offline");
    s.answer = (path) => json(200, { path });
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.link().state).toBe("resumed");
  });

  it("the server's own error, a 500 or a 503 with its JSON, is an answer: it reaches the caller and the link stays up", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.answer = () => json(500, { error: { code: "internal", message: "The store could not be read.", retryable: false } });
    expect((await c.fetch("/v2/stats")).status).toBe(500);
    s.answer = () => json(503, { status: "unhealthy" });
    expect((await c.fetch("/v2/health")).status).toBe(503);
    expect(c.link().state).toBe("online");
  });

  it("Retry now probes at once; Resumed turns back into online after a while", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch, resumedMs: 5000 });
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.link().state));
    s.up = false;
    void c.fetch("/v2/runs");
    await flush();
    s.up = true;
    c.retryNow();
    await flush();
    expect(c.link().state).toBe("resumed");
    await vi.advanceTimersByTimeAsync(4999);
    expect(c.link().state).toBe("resumed");
    await vi.advanceTimersByTimeAsync(1);
    expect(c.link().state).toBe("online");
    expect(seen).toEqual(["offline", "resumed", "online"]);
  });

  it("tells who asked when the server is back, once per return", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    let back = 0;
    const stop = c.onResume(() => { back++; });
    for (let i = 0; i < 2; i++) {
      s.up = false;
      void c.fetch("/v2/runs");
      await flush();
      s.up = true;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(back).toBe(2);
    stop();
    s.up = false; void c.fetch("/v2/runs"); await flush(); s.up = true; await vi.advanceTimersByTimeAsync(1000);
    expect(back).toBe(2);
  });

  it("any answer while away brings the link back: a write that went through says the server is there", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.up = false;
    const read = c.fetch("/v2/runs");
    await flush();
    s.up = true;
    expect((await c.fetch("/v2/runs/r1/messages", { method: "POST" })).ok).toBe(true);
    expect(c.link().state).toBe("resumed");
    expect((await read).ok).toBe(true);
  });
});
