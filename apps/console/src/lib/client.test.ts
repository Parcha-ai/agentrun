import { describe, expect, it } from "vitest";
import { ClientError, createClient, follow } from "./client";
import type { TimelinePage } from "./v2";
import page412 from "../fixtures/error.definition-stale-etag.json";
import running from "../fixtures/run.working.working.1.timeline.json";

type Call = { url: string; init?: RequestInit };
function fakeFetch(answers: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => { const c = { url: String(url), init }; calls.push(c); return answers(c); }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createClient", () => {
  it("throws the server's typed error, with its status, for a refused request", async () => {
    const { fn } = fakeFetch(() => json(412, page412.body));
    const v2 = createClient({ fetch: fn });
    const err = await v2.getRun("r1").catch((e) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err).toMatchObject({ status: 412, code: "precondition_failed" });
    expect(err.message).toContain("If-Match");
  });

  it("sends a message as same-origin JSON with an Idempotency-Key, the same key on a retry of the same send", async () => {
    const { fn, calls } = fakeFetch(() => json(202, { mode: "answer", message_id: "m1" }));
    const v2 = createClient({ fetch: fn });
    await v2.sendMessage("r1", "EUR", "k-1");
    await v2.sendMessage("r1", "EUR", "k-1");
    const [a, b] = calls;
    expect(a.url).toBe("/v2/runs/r1/messages");
    expect(a.init?.method).toBe("POST");
    expect(new Headers(a.init?.headers).get("idempotency-key")).toBe("k-1");
    expect(new Headers(b.init?.headers).get("idempotency-key")).toBe("k-1");
    expect(new Headers(a.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(a.init?.body))).toEqual({ content: "EUR" });
    expect(a.init?.credentials).toBe("same-origin");
  });

  it("asks the timeline from its cursor and long-polls", async () => {
    const { fn, calls } = fakeFetch(() => json(200, running.body));
    const v2 = createClient({ fetch: fn });
    await v2.getTimeline("r 1", { after: 1793221732286025, waitMs: 25000 });
    expect(calls[0].url).toBe("/v2/runs/r%201/timeline?after=1793221732286025&wait_ms=25000");
  });
});

describe("follow", () => {
  it("applies each page from the previous cursor until the server says final, and never duplicates a row", async () => {
    const first = running.body as unknown as TimelinePage;
    const again: TimelinePage = { ...first, reset: false, rows: first.rows.slice(-1), final: false, next_after: first.next_after + 1 };
    const done: TimelinePage = { ...first, reset: false, rows: [], unchanged: true, final: true, status: "completed", state: "idle", next_after: first.next_after + 2 };
    const pages = [first, again, done];
    const { fn, calls } = fakeFetch(() => json(200, pages.shift()));
    const seen: number[] = [];
    const out = await follow(createClient({ fetch: fn }), "r1", { onRows: (rows) => seen.push(rows.length), waitMs: 1, minDelayMs: 0 });
    expect(calls.map((c) => new URL(c.url, "http://x").searchParams.get("after"))).toEqual([null, String(first.next_after), String(first.next_after + 1)]);
    expect(seen.at(-1)).toBe(first.rows.length);
    expect(out.status).toBe("completed");
  });

  it("stops when aborted", async () => {
    const page = running.body as unknown as TimelinePage;
    const { fn, calls } = fakeFetch(() => json(200, { ...page, final: false }));
    const ctl = new AbortController();
    const run = follow(createClient({ fetch: fn }), "r1", { onRows: () => { if (calls.length >= 2) ctl.abort(); }, signal: ctl.signal, waitMs: 1, minDelayMs: 0 });
    await run;
    expect(calls.length).toBe(2);
  });
});
