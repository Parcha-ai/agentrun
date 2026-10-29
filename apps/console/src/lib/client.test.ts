import { describe, expect, it } from "vitest";
import { ClientError, allPages, createClient, follow } from "./client";
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

describe("agents", () => {
  it("reads an agent with its ETag, and saves an edit with If-Match, getting the next ETag back", async () => {
    const { fn, calls } = fakeFetch((c) => new Response(JSON.stringify({ agent_id: "a1", revisions: c.init?.method === "PUT" ? 2 : 1 }), {
      status: 200, headers: { "content-type": "application/json", etag: c.init?.method === "PUT" ? '"rev-2"' : '"rev-1"' },
    }));
    const v2 = createClient({ fetch: fn });
    const got = await v2.getAgent("a1");
    expect(got.etag).toBe('"rev-1"');
    const saved = await v2.updateDefinition("a1", { definition: { version: 2 } }, got.etag);
    expect(new Headers(calls[1].init?.headers).get("if-match")).toBe('"rev-1"');
    expect(calls[1].url).toBe("/v2/agents/a1/definition");
    expect(saved).toMatchObject({ etag: '"rev-2"', agent: { revisions: 2 } });
  });

  it("lists archived agents with the server's list parameter, and archives through its route", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { agents: [], next_cursor: null }));
    const v2 = createClient({ fetch: fn });
    await v2.listAgents({ archived: true });
    await v2.archiveAgent("a 1");
    await v2.setCurrent("a1", "rev-1");
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual(["GET /v2/agents?archived=true", "POST /v2/agents/a%201/archive", "POST /v2/agents/a1/current"]);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ revision: "rev-1" });
  });
});

describe("review fixes", () => {
  it("reads a file's bytes as text, even a JSON file the server labels application/json", async () => {
    const { fn } = fakeFetch(() => json(200, { a: 1 }));
    const text = await createClient({ fetch: fn }).readFile("r1", "out.json");
    expect(typeof text).toBe("string");
    expect(text).toBe('{"a":1}');
  });

  it("keeps following a settled run while the server says it has more rows", async () => {
    const first = running.body as unknown as TimelinePage;
    const pages = [{ ...first, final: true, has_more: true }, { ...first, reset: false, rows: [], final: true, has_more: false, next_after: first.next_after + 1 }];
    const { fn, calls } = fakeFetch(() => json(200, pages.shift()));
    await follow(createClient({ fetch: fn }), "r1", { onRows: () => {}, waitMs: 1, minDelayMs: 0 });
    expect(calls.length).toBe(2);
  });

  it("an aborted follow passes its signal to the request and publishes nothing after the abort", async () => {
    const page = running.body as unknown as TimelinePage;
    const ctl = new AbortController();
    let seenSignal: AbortSignal | null | undefined;
    const fn = (async (_url: string, init?: RequestInit) => { seenSignal = init?.signal; ctl.abort(); return json(200, { ...page, final: false }); }) as typeof fetch;
    let published = 0;
    await follow(createClient({ fetch: fn }), "r1", { onRows: () => { published++; }, signal: ctl.signal, waitMs: 1, minDelayMs: 0 });
    expect(seenSignal).toBe(ctl.signal);
    expect(published).toBe(0);
  });

  it("asks for the next page of runs with the server's cursor", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { runs: [], next_cursor: null }));
    await createClient({ fetch: fn }).listRuns(50, "c2");
    expect(calls[0].url).toBe("/v2/runs?limit=50&cursor=c2");
  });
});

describe("paging", () => {
  it("asks for the next page of agents, revisions and an agent's runs with the server's cursor", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { agents: [], revisions: [], runs: [], next_cursor: null }));
    const v2 = createClient({ fetch: fn });
    await v2.listAgents({ cursor: "a2" });
    await v2.listAgents({ archived: true, cursor: "a3" });
    await v2.listRevisions("x", "r2");
    await v2.listAgentRuns("x", 50, "u2");
    expect(calls.map((c) => c.url)).toEqual(["/v2/agents?cursor=a2", "/v2/agents?archived=true&cursor=a3", "/v2/agents/x/revisions?cursor=r2", "/v2/agents/x/runs?limit=50&cursor=u2"]);
  });

  it("reads every page: all() follows next_cursor to the end", async () => {
    const pages = [{ agents: [{ agent_id: "a" }], next_cursor: "c2" }, { agents: [{ agent_id: "b" }], next_cursor: null }];
    const { fn } = fakeFetch(() => json(200, pages.shift()));
    const v2 = createClient({ fetch: fn });
    const all = await allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents);
    expect(all.map((a) => a.agent_id)).toEqual(["a", "b"]);
  });
});

describe("the owner's session", () => {
  it("reads a server without accounts (404 on the session route) as such, instead of throwing", async () => {
    const { fn } = fakeFetch(() => json(404, { error: { code: "not_found", message: "no route /v2/auth/session", retryable: false } }));
    expect(await createClient({ fetch: fn }).session()).toEqual({ status: 404, body: null });
  });
  it("signs in and sets up as same-origin JSON, and signs out", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { signed_in: true }));
    const v2 = createClient({ fetch: fn });
    await v2.signIn("pw-1"); await v2.setup("pw-2", "c-1"); await v2.signOut();
    expect(calls.map((c) => `${c.init?.method} ${c.url} ${c.init?.body}`)).toEqual([
      'POST /v2/auth/sign-in {"password":"pw-1"}', 'POST /v2/setup {"password":"pw-2","code":"c-1"}', "POST /v2/auth/sign-out {}",
    ]);
    expect(calls.every((c) => c.init?.credentials === "same-origin")).toBe(true);
  });
});

describe("follow's pace", () => {
  it("waits at least minDelayMs between polls, even when the server says poll_after_ms 0 on unchanged pages", async () => {
    const page = running.body as unknown as TimelinePage;
    const pages = [page, ...[1, 2, 3].map((n) => ({ ...page, reset: false, rows: [], unchanged: true, poll_after_ms: 0, final: false, next_after: page.next_after + n })), { ...page, reset: false, rows: [], unchanged: true, final: true, has_more: false }];
    const at: number[] = [];
    const fn = (async () => { at.push(Date.now()); return json(200, pages.shift()); }) as typeof fetch;
    await follow(createClient({ fetch: fn }), "r1", { onRows: () => {}, waitMs: 1, minDelayMs: 40 });
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps.length).toBe(4);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(35);
  });
});
