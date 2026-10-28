import { applyPage } from "./timeline";
import type { ApiError, Run, RunFiles, TimelinePage, TimelineRow } from "./v2";

/** A request AgentRun Server refused: its HTTP status and its typed error (`code`, `message`, `retryable`). */
export class ClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly requestId?: string) {
    super(message);
    this.name = "ClientError";
  }
  toApiError(): ApiError { return { code: this.code, message: this.message, retryable: this.retryable, request_id: this.requestId }; }
}

export type Capabilities = { harnesses: { id: string; available: boolean; reason?: string }[]; features: { messages: { steer: boolean; answer: boolean; follow_up: boolean; steer_workflow_runs: boolean } } };
export type Client = ReturnType<typeof createClient>;

/** The console's client for `agentrun.v2/0`, on the page's own origin: the server's HttpOnly cookie is the session, and
 *  every write is same-origin JSON (the server refuses a cookie write from another origin). */
export function createClient({ fetch: f = globalThis.fetch.bind(globalThis), base = "/v2" }: { fetch?: typeof fetch; base?: string } = {}) {
  async function call<T>(method: string, path: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const e = ((await res.json().catch(() => null)) as { error?: ApiError } | null)?.error;
      throw new ClientError(res.status, e?.code ?? "http_error", e?.message ?? `${method} ${path}: ${res.status}`, e?.retryable ?? false, e?.request_id);
    }
    return (res.headers.get("content-type") ?? "").includes("json") ? ((await res.json()) as T) : ((await res.text()) as T);
  }
  const run = (id: string) => `/runs/${encodeURIComponent(id)}`;
  return {
    capabilities: () => call<Capabilities>("GET", "/capabilities"),
    listRuns: (limit = 50) => call<{ runs: Run[]; next_cursor: string | null }>("GET", `/runs?limit=${limit}`),
    listAgents: () => call<{ agents: { agent_id: string; definition: { name?: string } }[] }>("GET", "/agents"),
    getRun: (id: string) => call<Run>("GET", run(id)),
    getTimeline: (id: string, { after, waitMs }: { after?: number; waitMs?: number } = {}) => {
      const q = new URLSearchParams();
      if (after !== undefined) q.set("after", String(after));
      if (waitMs !== undefined) q.set("wait_ms", String(waitMs));
      return call<TimelinePage>("GET", `${run(id)}/timeline${q.size ? `?${q}` : ""}`);
    },
    listFiles: (id: string) => call<RunFiles>("GET", `${run(id)}/files`),
    readFile: (id: string, path: string) => call<string>("GET", `${run(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`),
    /** One send, one key: a retry of the same send reuses its key, so the server keeps the first request's identity. */
    sendMessage: (id: string, content: string, idempotencyKey: string) =>
      call<{ mode: string; message_id: string }>("POST", `${run(id)}/messages`, { body: { content }, headers: { "idempotency-key": idempotencyKey } }),
    stop: (id: string) => call<unknown>("POST", `${run(id)}/stop`, { body: {} }),
    cancel: (id: string) => call<unknown>("POST", `${run(id)}/cancel`, { body: {} }),
  };
}

/** Follows a run's timeline from its cursor until the server says the timeline is final (or `signal` aborts), handing
 *  the merged rows to `onRows` after each page. Resolves with the last page. */
export async function follow(
  v2: Client,
  runId: string,
  { onRows, onPage, signal, waitMs = 25000, minDelayMs = 250 }: { onRows: (rows: TimelineRow[]) => void; onPage?: (page: TimelinePage) => void; signal?: AbortSignal; waitMs?: number; minDelayMs?: number },
): Promise<TimelinePage> {
  let rows: TimelineRow[] = [];
  let after: number | undefined;
  let last: TimelinePage | undefined;
  while (!signal?.aborted) {
    const page = await v2.getTimeline(runId, after === undefined ? {} : { after, waitMs });
    last = page;
    rows = applyPage(rows, page);
    onPage?.(page);
    onRows(rows);
    if (page.final || signal?.aborted) break;
    after = page.next_after;
    const delay = Math.max(minDelayMs, page.unchanged ? (page.poll_after_ms ?? 0) : 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  return last as TimelinePage;
}
