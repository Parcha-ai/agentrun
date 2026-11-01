import type { Stats } from "./mission";
import type { Agent, Definition } from "./agentForm";
import type { RunGraph } from "./runGraph";
import { applyPage } from "./timeline";
import type { ApiError, Run, RunFiles, TimelinePage, TimelineRow, ToolKeys, ToolKeysFeature } from "./v2";

/** A request AgentRun Server refused: its HTTP status and its typed error (`code`, `message`, `retryable`). */
export type FieldIssue = { field: string; reason: string; message: string };

export class ClientError extends Error {
  /** A 422's issues, by field, as the server names them. */
  fields?: FieldIssue[];
  /** A retryable refusal's wait before asking again, when the server named one (a busy store). */
  retryAfterMs?: number;
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly requestId?: string) {
    super(message);
    this.name = "ClientError";
  }
  toApiError(): ApiError { return { code: this.code, message: this.message, retryable: this.retryable, request_id: this.requestId }; }
}

/** POST /v2/workflows/validate's answer: issues refuse a save, warnings only advise. Paths are JSON Pointers into the
 *  workflow ("" for the document itself). */
export type WorkflowCheck = { ok: boolean; issues: { path: string; code: string; message: string }[]; warnings: (string | { path?: string; message: string })[] };

export type Capabilities = { harnesses: { id: string; available: boolean; reason?: string; steer?: boolean }[]; features: { messages: { steer: boolean; answer: boolean; follow_up: boolean; steer_workflow_runs: boolean }; tool_keys?: ToolKeysFeature } };
export type Client = ReturnType<typeof createClient>;

/** The console's client for `agentrun.v2/0`, on the page's own origin: the server's HttpOnly cookie is the session, and
 *  every write is same-origin JSON (the server refuses a cookie write from another origin). */
export function createClient({ fetch: f = globalThis.fetch.bind(globalThis), base = "/v2" }: { fetch?: typeof fetch; base?: string } = {}) {
  async function call<T>(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; text?: boolean } = {}): Promise<T> {
    return (await callTagged<T>(method, path, opts)).body;
  }
  /** A request and its response's ETag (an agent's current revision, for the next If-Match). `text`: the body as text
   *  whatever its type (a run's file is its bytes, never parsed). */
  async function callTagged<T>(method: string, path: string, { body, headers = {}, signal, text = false }: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; text?: boolean } = {}): Promise<{ body: T; etag: string | null; status: number }> {
    // Every write is JSON, a bodiless DELETE too: the server takes the cookie on a write only with this type.
    const json = body !== undefined || (method !== "GET" && method !== "HEAD");
    const res = await f(`${base}${path}`, {
      method,
      signal,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(json ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const e = ((await res.json().catch(() => null)) as { error?: ApiError & { fields?: FieldIssue[]; retry_after_ms?: number } } | null)?.error;
      const err = new ClientError(res.status, e?.code ?? "http_error", e?.message ?? `${method} ${path}: ${res.status}`, e?.retryable ?? false, e?.request_id);
      if (e?.fields) err.fields = e.fields;
      if (typeof e?.retry_after_ms === "number") err.retryAfterMs = e.retry_after_ms;
      throw err;
    }
    const out = !text && (res.headers.get("content-type") ?? "").includes("json") ? ((await res.json()) as T) : ((await res.text()) as T);
    return { body: out, etag: res.headers.get("etag"), status: res.status };
  }
  const agent = (id: string) => `/agents/${encodeURIComponent(id)}`;
  const run = (id: string) => `/runs/${encodeURIComponent(id)}`;
  return {
    capabilities: () => call<Capabilities>("GET", "/capabilities"),
    /** The owner's session; its status too, since a server without accounts answers 404. */
    session: () => callTagged<{ password_set: boolean; signed_in: boolean }>("GET", "/auth/session").then((r) => ({ status: r.status, body: r.body as unknown }), (e) => {
      if (e instanceof ClientError && e.status === 404) return { status: 404, body: null as unknown };
      throw e;
    }),
    signIn: (password: string) => call<{ signed_in: boolean }>("POST", "/auth/sign-in", { body: { password } }),
    setup: (password: string, code?: string) => call<{ signed_in: boolean }>("POST", "/setup", { body: { password, ...(code ? { code } : {}) } }),
    signOut: () => call<{ signed_out: boolean }>("POST", "/auth/sign-out", { body: {} }),
    /** Counts and sums from the server's store, for Mission Control (`GET /v2/stats`, a serve extension). */
    stats: () => call<Stats>("GET", "/stats"),
    listRuns: (limit = 50, cursor?: string | null) => call<{ runs: Run[]; next_cursor: string | null }>("GET", `/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    listAgentRuns: (id: string, limit = 50, cursor?: string | null) => call<{ runs: Run[]; next_cursor: string | null }>("GET", `${agent(id)}/runs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    listAgents: ({ archived = false, cursor }: { archived?: boolean; cursor?: string | null } = {}) => {
      const q = new URLSearchParams();
      if (archived) q.set("archived", "true");
      if (cursor) q.set("cursor", cursor);
      return call<{ agents: Agent[]; next_cursor: string | null }>("GET", `/agents${q.size ? `?${q}` : ""}`);
    },
    getAgent: async (id: string) => { const r = await callTagged<Agent>("GET", agent(id)); return { agent: r.body, etag: r.etag }; },
    createAgent: (body: { definition: Definition; skills?: Record<string, string> }) => call<Agent>("POST", "/agents", { body }),
    /** Saves a new revision. `etag` is the revision the edit was made on: the server refuses the save (412) when another
     *  landed first. The answer's ETag is the new revision, for the next edit. */
    updateDefinition: async (id: string, body: { definition: Partial<Definition>; note?: string; skills?: Record<string, string> }, etag: string | null) => {
      const r = await callTagged<Agent>("PUT", `${agent(id)}/definition`, { body, headers: etag ? { "if-match": etag } : {} });
      return { agent: r.body, etag: r.etag };
    },
    listRevisions: (id: string, cursor?: string | null) => call<{ revisions: { revision: string; version: number; current: boolean; note: string | null; created_at: string; kind: string; definition: Definition }[]; next_cursor: string | null }>("GET", `${agent(id)}/revisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    setCurrent: (id: string, revision: string) => call<Agent>("POST", `${agent(id)}/current`, { body: { revision } }),
    archiveAgent: (id: string) => call<Agent>("POST", `${agent(id)}/archive`, { body: {} }),
    unarchiveAgent: (id: string) => call<Agent>("POST", `${agent(id)}/unarchive`, { body: {} }),
    getRun: (id: string) => call<Run>("GET", run(id)),
    /** Starts a run. The server answers 202 with the run; the same key with the same body answers with that same run. */
    startRun: async (agentId: string, body: { input: unknown; revision?: string; effort?: string; max_cost_usd?: number }, idempotencyKey: string) => {
      const r = await callTagged<Run>("POST", `${agent(agentId)}/runs`, { body, headers: { "idempotency-key": idempotencyKey } });
      return { run: r.body, status: r.status };
    },
    getTimeline: (id: string, { after, waitMs, signal }: { after?: number; waitMs?: number; signal?: AbortSignal } = {}) => {
      const q = new URLSearchParams();
      if (after !== undefined) q.set("after", String(after));
      if (waitMs !== undefined) q.set("wait_ms", String(waitMs));
      return call<TimelinePage>("GET", `${run(id)}/timeline${q.size ? `?${q}` : ""}`, { signal });
    },
    listFiles: (id: string) => call<RunFiles>("GET", `${run(id)}/files`),
    readFile: (id: string, path: string) => call<string>("GET", `${run(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, { text: true }),
    /** One send, one key: a retry of the same send reuses its key, so the server keeps the first request's identity. */
    sendMessage: (id: string, content: string, idempotencyKey: string) =>
      call<{ mode: string; message_id: string }>("POST", `${run(id)}/messages`, { body: { content }, headers: { "idempotency-key": idempotencyKey } }),
    /** A workflow run's graph, live: each node's state, its decisions and tool calls, and the totals (contract C4). */
    getRunGraph: (id: string, signal?: AbortSignal) => call<RunGraph>("GET", `${run(id)}/graph`, { signal }),
    /** Pauses a workflow run: calls in flight finish, and no new node starts until it resumes. */
    pauseRun: (id: string) => call<{ paused: boolean }>("POST", `${run(id)}/pause`, { body: {} }),
    resumeRun: (id: string) => call<{ paused: boolean }>("POST", `${run(id)}/resume`, { body: {} }),
    /** The server's own check of a workflow (the DSL's validator, no code run, nothing stored). 404 on a server without it. */
    validateWorkflow: (body: { workflow: unknown; tools?: string[] }, signal?: AbortSignal) => call<WorkflowCheck>("POST", "/workflows/validate", { body, signal }),
    /** A run file's URL on this origin (a rendered page's image), for an <img>: the session cookie goes with it. */
    fileUrl: (id: string, path: string) => `${base}${run(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    /** The tool keys and where each field is set, never a value (a serve extension; 404 on a server without it). */
    listToolKeys: () => call<ToolKeys>("GET", "/settings/tool-keys"),
    /** Saves the given fields of one key (204); its other fields stay. No Idempotency-Key: the same PUT twice is the same
     *  state, and the server keeps no record of a body that holds the values. */
    saveToolKey: (id: string, values: Record<string, string>) => call<unknown>("PUT", `/settings/tool-keys/${encodeURIComponent(id)}`, { body: { values } }),
    removeToolKey: (id: string) => call<unknown>("DELETE", `/settings/tool-keys/${encodeURIComponent(id)}`),
    stop: (id: string) => call<unknown>("POST", `${run(id)}/stop`, { body: {} }),
    cancel: (id: string) => call<unknown>("POST", `${run(id)}/cancel`, { body: {} }),
  };
}

/** Every item of a listing the server pages (`next_cursor`), read to its end (at most `max` pages). */
export async function allPages<P extends { next_cursor: string | null }, T>(page: (cursor: string | null) => Promise<P>, items: (p: P) => T[], max = 100): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < max; i++) {
    const p = await page(cursor);
    out.push(...items(p));
    if (!p.next_cursor) break;
    cursor = p.next_cursor;
  }
  return out;
}

/** Follows a run's timeline from its cursor until the server says the timeline is final and has no more rows (or
 *  `signal` aborts), handing the merged rows to `onRows` after each page. A request in flight when `signal` aborts is
 *  cancelled, and nothing after the abort is published. Resolves with the last page. */
export async function follow(
  v2: Client,
  runId: string,
  { onRows, onPage, signal, waitMs = 25000, minDelayMs = 250 }: { onRows: (rows: TimelineRow[]) => void; onPage?: (page: TimelinePage) => void; signal?: AbortSignal; waitMs?: number; minDelayMs?: number },
): Promise<TimelinePage> {
  let rows: TimelineRow[] = [];
  let after: number | undefined;
  let last: TimelinePage | undefined;
  while (!signal?.aborted) {
    const page = await v2.getTimeline(runId, after === undefined ? { signal } : { after, waitMs, signal }).catch((e) => { if (signal?.aborted) return null; throw e; });
    if (!page || signal?.aborted) break;
    last = page;
    rows = applyPage(rows, page);
    onPage?.(page);
    onRows(rows);
    if (page.final && !page.has_more) break;
    after = page.next_after;
    const delay = Math.max(minDelayMs, page.unchanged ? (page.poll_after_ms ?? 0) : 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  return last as TimelinePage;
}
