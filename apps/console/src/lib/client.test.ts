import { describe, expect, it, vi } from "vitest";
import { ClientError, allPages, createClient, follow } from "./client";
import type { TimelinePage } from "./v2";
import page412 from "../fixtures/error.definition-stale-etag.json";
import running from "../fixtures/run.working.working.1.timeline.json";
import invalid from "../fixtures/write.definition-invalid-harness.json";
import { saveError } from "./agentForm";

type Call = { url: string; init?: RequestInit };
function fakeFetch(answers: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => { const c = { url: String(url), init }; calls.push(c); return answers(c); }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createClient", () => {
  it.each(["/v2?mode=test", "/v2#fragment"])("rejects the relative API base %s before storing or requesting it", (base) => {
    expect(() => createClient({ base })).toThrow(/query|fragment/i);
    expect(() => createClient({ base, auth: { type: "bearer", token: "example" } })).toThrow(/query|fragment/i);
  });
  it("uses explicit bearer credentials without cookies for an SDK request to another server", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { runs: [], next_cursor: null }));
    const v2 = createClient({ fetch: fn, base: "https://server.example/v2", auth: { type: "bearer", token: () => "example-sdk-token" } });
    await v2.listRuns();
    expect(calls[0].url).toBe("https://server.example/v2/runs?limit=50");
    expect(calls[0].init?.credentials).toBe("omit");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer example-sdk-token");
    expect(() => createClient({ fetch: fn, base: "https://server.example/v2" })).toThrow(/same.origin/i);
  });

  it.each([false, true])("uploads original bytes through the configured credential boundary (bearer=%s)", async (bearer) => {
    const uploaded = { file_id: "upload-1", path: "report data.txt", size_bytes: 5, content_type: "text/plain", sha256: "example", status: "ready" };
    const { fn, calls } = fakeFetch(() => json(201, { file: uploaded }));
    const base = bearer ? "https://server.example/v2" : "/console-api";
    const v2 = createClient({ fetch: fn, base, ...(bearer ? { auth: { type: "bearer" as const, token: "example-sdk-token" } } : {}) });
    const file = new File(["bytes"], uploaded.path, { type: "text/plain" });
    const progress = vi.fn();
    expect(await v2.upload(file, progress, new AbortController().signal)).toEqual(uploaded);
    expect(calls[0].url).toBe(`${base}/files?path=report%20data.txt`);
    expect(calls[0].init?.body).toBe(file);
    expect(calls[0].init?.credentials).toBe(bearer ? "omit" : "same-origin");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(bearer ? "Bearer example-sdk-token" : null);
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("text/plain");
    expect(progress.mock.calls.map(([fraction]) => fraction)).toEqual([0, 1]);
  });

  it("invalidates protected session state on a 401 without treating a rejected sign-in as session expiry", async () => {
    const { fn } = fakeFetch(() => json(401, { error: { code: "unauthenticated", message: "Sign in again.", retryable: false } }));
    const v2 = createClient({ fetch: fn });
    const expired = vi.fn();
    const unsubscribe = v2.onUnauthorized(expired);
    await v2.signIn("wrong").catch(() => {});
    expect(expired).not.toHaveBeenCalled();
    await v2.getRun("private-run").catch(() => {});
    expect(expired).toHaveBeenCalledOnce();
    unsubscribe();
    await v2.getRun("private-run").catch(() => {});
    expect(expired).toHaveBeenCalledOnce();
  });

  it("ignores an old identity's late 401 after private session state is cleared", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const v2 = createClient({ fetch: (() => pending) as typeof fetch });
    const expired = vi.fn();
    v2.onUnauthorized(expired);
    const old = v2.getRun("owner-a-run").catch((error) => error);
    v2.clearSessionState();
    release(json(401, { error: { code: "unauthenticated", message: "Old session ended.", retryable: false } }));
    expect(await old).toMatchObject({ code: "session_changed" });
    expect(expired).not.toHaveBeenCalled();
  });

  it("does not populate a new identity's warning cache from an old create response", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const agent = { agent_id: "shared-id", revision: "same-revision", definition: { version: 1, name: "Agent", skills: [], tools: [] } };
    const v2 = createClient({ fetch: (async (_url, init) => init?.method === "POST" ? pending : json(200, agent)) as typeof fetch });
    const old = v2.createAgent({ definition: agent.definition }).catch((error) => error);
    v2.clearSessionState();
    release(json(201, { ...agent, warnings: [{ field: "definition.model", reason: "private", message: "Owner A private setup warning" }] }));
    expect(await old).toMatchObject({ code: "session_changed" });
    expect((await v2.getAgent("shared-id")).agent.warnings).toBeUndefined();
  });

  it.each(["start", "upload"])("does not dispatch an old %s if identity changes while its bearer token is being resolved", async (operation) => {
    let release!: (token: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const f = vi.fn(async () => json(202, { run_id: "unexpected" }));
    const v2 = createClient({ fetch: f as typeof fetch, auth: { type: "bearer", token: () => pending } });
    const old = (operation === "start" ? v2.startRun("agent", { input: { content: "Owner A task" } }, "stable-request") : v2.upload(new File(["Owner A file"], "private.txt"), () => {}, new AbortController().signal)).catch((error) => error);
    v2.clearSessionState();
    release("replacement-owner-token");
    expect(await old).toMatchObject({ code: "session_changed" });
    expect(f).not.toHaveBeenCalled();
  });

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

  it("sends a tool key's PUT and its bodiless DELETE as same-origin JSON, so the server takes the session cookie", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const v2 = createClient({ fetch: fn });
    const fake = "not-a-real-key-0123";
    await v2.saveToolKey("monid", { MONID_API_KEY: fake });
    await v2.removeToolKey("monid");
    await v2.listToolKeys();
    const [put, del, get] = calls;
    expect([put.init?.method, put.url, JSON.parse(String(put.init?.body))]).toEqual(["PUT", "/v2/settings/tool-keys/monid", { values: { MONID_API_KEY: fake } }]);
    expect([del.init?.method, del.url, del.init?.body]).toEqual(["DELETE", "/v2/settings/tool-keys/monid", undefined]);
    for (const write of [put, del]) {
      expect(new Headers(write.init?.headers).get("content-type")).toBe("application/json");
      expect(write.init?.credentials).toBe("same-origin");
    }
    expect(new Headers(get.init?.headers).get("content-type")).toBeNull();
  });

  it("asks the timeline from its cursor and long-polls", async () => {
    const { fn, calls } = fakeFetch(() => json(200, running.body));
    const v2 = createClient({ fetch: fn });
    await v2.getTimeline("r 1", { after: 1793221732286025, waitMs: 25000 });
    expect(calls[0].url).toBe("/v2/runs/r%201/timeline?after=1793221732286025&wait_ms=25000");
  });
});

describe("raiseCap", () => {
  it("raises a run's spend cap with PATCH /v2/runs/{id} and only max_cost_usd, as same-origin JSON, and answers what the server says", async () => {
    const answer = { run_id: "r 1", max_cost_usd: 1.03, resumed: true, message_id: "m1", status: "input_required", state: "waiting" };
    const { fn, calls } = fakeFetch(() => json(200, answer));
    const v2 = createClient({ fetch: fn });
    expect(await v2.raiseCap("r 1", 1.03)).toEqual(answer);
    expect([calls[0].init?.method, calls[0].url, JSON.parse(String(calls[0].init?.body))]).toEqual(["PATCH", "/v2/runs/r%201", { max_cost_usd: 1.03 }]);
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("application/json");
    expect(calls[0].init?.credentials).toBe("same-origin");
  });
});

describe("follow", () => {
  it("resumes a disconnected timeline at its saved cursor without replacing prior rows", async () => {
    const first = running.body as unknown as TimelinePage;
    const checkpoint = { rows: [] as TimelinePage["rows"], after: undefined as number | undefined };
    let fail = false;
    const requests: (number | undefined)[] = [];
    const v2 = { getTimeline: async (_id: string, opts: { after?: number }) => {
      requests.push(opts.after);
      if (fail) throw new TypeError("Network disconnected");
      fail = true;
      return { ...first, final: false };
    } };
    await expect(follow(v2 as never, "r1", { checkpoint, minDelayMs: 0, onRows: () => {} })).rejects.toThrow("Network disconnected");
    const restored: string[][] = [];
    v2.getTimeline = async (_id, opts) => { requests.push(opts.after); return { ...first, reset: false, rows: [], final: true }; };
    await follow(v2 as never, "r1", { checkpoint, minDelayMs: 0, onRows: (rows) => restored.push(rows.map((r) => r.id)) });
    expect(requests).toEqual([undefined, first.next_after, first.next_after]);
    expect(restored[0]).toEqual(first.rows.map((r) => r.id));
  });

  it("with no onRows, follows a run's status alone: each page to onPage, the cursor kept, no rows merged or held", async () => {
    const first = running.body as unknown as TimelinePage;
    const done: TimelinePage = { ...first, reset: false, rows: [], unchanged: true, final: true, status: "completed", state: "idle", next_after: first.next_after + 1 };
    const pages = [first, done];
    const { fn, calls } = fakeFetch(() => json(200, pages.shift()));
    const statuses: string[] = [];
    const out = await follow(createClient({ fetch: fn }), "r1", { onPage: (p) => statuses.push(p.status), waitMs: 1, minDelayMs: 0 });
    expect(calls.map((c) => new URL(c.url, "http://x").searchParams.get("after"))).toEqual([null, String(first.next_after)]);
    expect(statuses).toEqual([first.status, "completed"]);
    expect(out.status).toBe("completed");
  });

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

  it("archives and unarchives a run through its routes, as same-origin JSON with the empty body a cookie write needs", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { run_id: "r 1", archived_at: null }));
    const v2 = createClient({ fetch: fn });
    await v2.archiveRun("r 1");
    await v2.unarchiveRun("r 1");
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual(["POST /v2/runs/r%201/archive", "POST /v2/runs/r%201/unarchive"]);
    for (const c of calls) {
      expect(new Headers(c.init?.headers).get("content-type")).toBe("application/json");
      expect(c.init?.body).toBe("{}");
      expect(c.init?.credentials).toBe("same-origin");
    }
  });

  it("retires a learned skill's SKILL.md and a draft's README.md through the note's retire route, slashes percent-encoded, under If-Match", async () => {
    const { fn, calls } = fakeFetch(() => new Response("---\nname: find-policies\nstatus: retired\n---\n", { status: 200, headers: { "content-type": "text/markdown", etag: '"skill-v2"' } }));
    const v2 = createClient({ fetch: fn });
    const done = await v2.retireNote("refunds", "skills/find-policies/SKILL.md", '"skill-v1"');
    await v2.retireNote("refunds", "workflows/check-refunds/README.md", '"readme-v1"');
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "POST /v2/agents/refunds/learning/files/skills%2Ffind-policies%2FSKILL.md/retire",
      "POST /v2/agents/refunds/learning/files/workflows%2Fcheck-refunds%2FREADME.md/retire",
    ]);
    expect(new Headers(calls[0].init?.headers).get("if-match")).toBe('"skill-v1"');
    expect(new Headers(calls[1].init?.headers).get("if-match")).toBe('"readme-v1"');
    expect(calls[0].init?.credentials).toBe("same-origin");
    expect(done).toEqual({ note: "---\nname: find-policies\nstatus: retired\n---\n", etag: '"skill-v2"' });
  });

  it("lists runs in one state, or the archived ones, with the server's list parameters", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { runs: [], next_cursor: null }));
    const v2 = createClient({ fetch: fn });
    await v2.listRuns(10);
    await v2.listRuns(50, null, { status: "failed" });
    await v2.listRuns(50, "c2", { archived: true });
    await v2.listAgentRuns("x", 50, null, { status: "input_required", archived: true });
    await v2.listRuns(50, null, { archived: false });
    expect(calls.map((c) => c.url)).toEqual([
      "/v2/runs?limit=10",
      "/v2/runs?limit=50&status=failed",
      "/v2/runs?limit=50&cursor=c2&archived=true",
      "/v2/agents/x/runs?limit=50&status=input_required&archived=true",
      "/v2/runs?limit=50",
    ]);
  });

  it("keeps a create's warnings for the next read of that revision of the agent, and an edit's come on its answer", async () => {
    const warnings = [{ field: "definition.model", reason: "not_set_up_here", message: "No key for openai." }];
    const made = { agent_id: "a1", kind: "agentic", revision: "rev-1", revisions: 1, archived_at: null, definition: { version: 1, name: "a1", skills: [], tools: [] } };
    let current = made.revision;
    const { fn } = fakeFetch((c) => {
      if (c.init?.method === "POST") return json(201, { ...made, warnings });
      if (c.init?.method === "PUT") return json(200, { ...made, revision: (current = "rev-2"), warnings: [] });
      return json(200, { ...made, revision: current });
    });
    const v2 = createClient({ fetch: fn });
    expect((await v2.createAgent({ definition: made.definition })).warnings).toEqual(warnings);
    expect((await v2.getAgent("a1")).agent.warnings, "the page that opens after the create").toEqual(warnings);
    expect((await v2.getAgent("a1")).agent.warnings, "still that revision").toEqual(warnings);
    expect((await v2.updateDefinition("a1", { definition: { version: 2 } }, "rev-1")).agent.warnings).toEqual([]);
    expect((await v2.getAgent("a1")).agent.warnings, "another revision has its own").toBeUndefined();
  });

  it("drops a create's warnings once the agent is saved again or another revision is made current: back on the first revision, none", async () => {
    const warnings = [{ field: "definition.model", reason: "not_set_up_here", message: "No key for openai." }];
    const made = { agent_id: "a1", kind: "agentic", revision: "rev-1", revisions: 1, archived_at: null, definition: { version: 1, name: "a1", skills: [], tools: [] } };
    for (const later of ["save", "make current"] as const) {
      let current = made.revision;
      const { fn } = fakeFetch((c) => {
        if (c.init?.method === "POST" && c.url.endsWith("/agents")) return json(201, { ...made, warnings });
        if (c.init?.method === "POST") return json(200, { ...made, revision: (current = JSON.parse(String(c.init.body)).revision) });
        if (c.init?.method === "PUT") return json(200, { ...made, revision: (current = "rev-2"), warnings: [] });
        return json(200, { ...made, revision: current });
      });
      const v2 = createClient({ fetch: fn });
      await v2.createAgent({ definition: made.definition });
      expect((await v2.getAgent("a1")).agent.warnings).toEqual(warnings);
      if (later === "save") await v2.updateDefinition("a1", { definition: { version: 2 } }, "rev-1");
      else await v2.setCurrent("a1", "rev-0");
      await v2.setCurrent("a1", "rev-1");
      expect((await v2.getAgent("a1")).agent.warnings, `after a ${later}, the first revision again`).toBeUndefined();
    }
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
  it("preserves a binary artifact's bytes instead of decoding them as UTF-8", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const { fn, calls } = fakeFetch(() => new Response(bytes, { headers: { "content-type": "image/png" } }));
    const blob = await createClient({ fetch: fn }).readFileBlob("r1", "plots/a b.png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    expect(calls[0].url).toBe("/v2/runs/r1/files/plots/a%20b.png");
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

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
    await v2.listAgentRuns("x", 50, "u3", true);
    expect(calls.map((c) => c.url)).toEqual(["/v2/agents?cursor=a2", "/v2/agents?archived=true&cursor=a3", "/v2/agents/x/revisions?cursor=r2", "/v2/agents/x/runs?limit=50&cursor=u2", "/v2/agents/x/runs?limit=50&cursor=u3&archived=true"]);
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

describe("setup's import status", () => {
  it("reads a 200 that says there is no offer as none, and still a 404 or 403 from an older server", async () => {
    const answers: [number, unknown][] = [
      [200, { offer: false }],
      [404, { error: { code: "not_found", message: "no route /v2/setup/import", retryable: false } }],
      [403, { error: { code: "forbidden", message: "this read must come from this server's page", retryable: false } }],
    ];
    const { fn, calls } = fakeFetch(() => json(...answers.shift()!));
    const v2 = createClient({ fetch: fn });
    expect([await v2.setupImport(), await v2.setupImport(), await v2.setupImport()]).toEqual([null, null, null]);
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual(Array(3).fill("GET /v2/setup/import"));
  });
  it("passes an offer and an import's state through as the server says them", async () => {
    const answers: unknown[] = [{ counting: true }, { projects: 1, sessions: 2 }, { state: "done", agents: 1, runs: 2, skipped: 0 }];
    const { fn } = fakeFetch(() => json(200, answers.shift()));
    const v2 = createClient({ fetch: fn });
    expect([await v2.setupImport(), await v2.setupImport(), await v2.setupImport()]).toEqual([{ counting: true }, { projects: 1, sessions: 2 }, { state: "done", agents: 1, runs: 2, skipped: 0 }]);
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

describe("allPages and a 422", () => {
  it("asks each page with the cursor the last one gave, from none, and stops at the page with none", async () => {
    const pages = [{ agents: [{ agent_id: "a" }], next_cursor: "c1" }, { agents: [{ agent_id: "b" }], next_cursor: "c2" }, { agents: [{ agent_id: "c" }], next_cursor: null }];
    const asked: (string | null)[] = [];
    const all = await allPages(async (cursor) => { asked.push(cursor); return pages.shift()!; }, (p) => p.agents);
    expect(asked).toEqual([null, "c1", "c2"]);
    expect(all.map((a) => a.agent_id)).toEqual(["a", "b", "c"]);
  });

  it("carries a 422's field issues on the ClientError, so the editor shows them by field", async () => {
    const { fn } = fakeFetch(() => json(invalid.status, invalid.body));
    const err = await createClient({ fetch: fn }).updateDefinition("a1", { definition: { version: 2 } }, '"rev-1"').catch((e) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.fields).toEqual(invalid.body.error.fields);
    expect(saveError(err)).toEqual({ kind: "invalid", message: invalid.body.error.message, fields: { "definition.harness": invalid.body.error.fields[0].message } });
  });
});

describe("the session's errors", () => {
  it("only a 404 reads as a server without accounts: any other refusal on /auth/session is that refusal", async () => {
    for (const status of [500, 401, 503]) {
      const { fn } = fakeFetch(() => json(status, { error: { code: status === 401 ? "unauthenticated" : "internal", message: "refused", retryable: false } }));
      const err = await createClient({ fetch: fn }).session().catch((e) => e);
      expect(err).toBeInstanceOf(ClientError);
      expect(err.status).toBe(status);
    }
    const { fn } = fakeFetch(() => json(404, { error: { code: "not_found", message: "no route /v2/auth/session", retryable: false } }));
    expect(await createClient({ fetch: fn }).session()).toEqual({ status: 404, body: null });
  });
});
