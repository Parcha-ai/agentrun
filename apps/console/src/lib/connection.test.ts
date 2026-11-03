import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, createConnection, Unreachable } from "./connection";

// The console rides out its server going away: a read waits and is sent again once the server answers, a write says the
// server can't be reached, and one probe at a time (1, 2, 4, 8, then every 10 s) tells when it is back.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A server that can be taken away and brought back; every request it was asked is in `asked`. */
function server() {
  const s = { up: true, stall: false, drop: 0, asked: [] as string[], answer: (path: string) => json(200, { path }) };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    s.asked.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    // A health check that never answers (a server half up), until its signal gives up on it.
    if (s.stall && path === "/v2/health") return new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(new DOMException("aborted", "AbortError"))));
    if (!s.up) throw new TypeError("Failed to fetch");
    // A connection cut on this one request (a proxy dropping a long poll) while the server answers the rest.
    if (s.drop > 0 && path !== "/v2/health") { s.drop -= 1; throw new TypeError("Failed to fetch"); }
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
    // The failure is checked against /v2/health at once (is it the server, or this request?), then probed on the backoff.
    expect(s.asked).toEqual(["GET /v2/runs/r1", "GET /v2/health", "GET /v2/health", "GET /v2/runs/r1"]);
  });

  it("probes once per wait, on the backoff, however many reads are waiting", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.up = false;
    for (const p of ["/v2/a", "/v2/b", "/v2/c"]) void c.fetch(p);
    await flush();
    const probes = () => s.asked.filter((a) => a.endsWith("/v2/health")).length;
    // One check at once, shared by the three reads that failed together.
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes()).toBe(2);
    const at = (c.link() as { retryAt: number }).retryAt;
    expect(at - Date.now()).toBe(2000);
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 10000 + 10000);
    expect(probes()).toBe(7);
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

  it("a proxy's 5xx on one read while /v2/health answers is that read's own failure: handed back, and the link stays up", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.answer = (path) => (path === "/v2/stats" ? new Response("Gateway Timeout", { status: 504, headers: { "content-type": "text/plain" } }) : json(200, { path }));
    expect((await c.fetch("/v2/stats")).status).toBe(504);
    expect(c.link().state).toBe("online");
    await vi.advanceTimersByTimeAsync(60_000);
    // Nothing sends it again by itself, and nothing piles up.
    expect(s.asked.filter((a) => a.endsWith("/v2/stats"))).toHaveLength(1);
  });

  it("a read whose connection was cut while the server answers (a long poll a proxy dropped) is sent again, at most twice", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch });
    s.drop = 1;
    let body: unknown;
    void c.fetch("/v2/runs/r1/timeline?after=3").then(async (r) => { body = await r.json(); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(body).toEqual({ path: "/v2/runs/r1/timeline?after=3" });
    expect(c.link().state).toBe("online");
    s.drop = 3;
    const failed = c.fetch("/v2/runs/r1/timeline?after=4").catch((e) => e);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await failed).toBeInstanceOf(TypeError);
    expect(s.asked.filter((a) => a.endsWith("after=4"))).toHaveLength(3);
  });

  it("a health check that never answers gives up after its deadline, so the next probe and Retry now still run", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch, probeMs: 5000 });
    s.up = false;
    s.stall = true;
    void c.fetch("/v2/runs");
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.link().state).toBe("offline");
    // The probe at 1 s stalls too; Retry now drops it and asks afresh, which the server, back, answers.
    await vi.advanceTimersByTimeAsync(1000);
    s.stall = false;
    s.up = true;
    c.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.link().state).toBe("resumed");
  });

  it("a stalled probe left alone times out and the backoff goes on", async () => {
    const { s, fetch } = server();
    const c = createConnection({ fetch, probeMs: 5000 });
    s.up = false;
    s.stall = true;
    void c.fetch("/v2/runs");
    await vi.advanceTimersByTimeAsync(5000 + 1000 + 5000);
    expect((c.link() as { attempt: number }).attempt).toBe(1);
    s.stall = false;
    s.up = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.link().state).toBe("resumed");
  });
});
