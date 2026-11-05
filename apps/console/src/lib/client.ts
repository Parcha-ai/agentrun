import type { Stats } from "./mission";
import type { UploadedFile } from "./uploads";
import type { Agent, Definition, SaveWarning, ToolOffer } from "./agentForm";
import type { components } from "./contract.generated";
import type { AgentLearning, LearningChange, LearningDiff, LearningNote, NoteProblem, NoteText, Page } from "./learning";
import type { RunGraph } from "./runGraph";
import { applyPage } from "./timeline";
import type { ApiError, Firing, RaiseAnswer, Run, RunFiles, RunStatus, TimelinePage, TimelineRow, ToolKeys, ToolSettings, Trigger, TriggerInput, Webhook, WebhookAttempt, WebhookSaved } from "./v2";

/** A request AgentRun Server refused: its HTTP status and its typed error (`code`, `message`, `retryable`). */
export type FieldIssue = { field: string; reason: string; message: string };

export class ClientError extends Error {
  /** A 422's issues, by field, as the server names them. */
  fields?: FieldIssue[];
  /** A retryable refusal's wait before asking again, when the server named one (a busy store). */
  retryAfterMs?: number;
  /** What the server says beyond the message (`error.details`): a 409 `agent_not_runnable` names the box it lacks. */
  details?: Record<string, unknown>;
  /** A note the server's checks refused (400): each check it fails, printable. */
  problems?: NoteProblem[];
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly requestId?: string) {
    super(message);
    this.name = "ClientError";
  }
  toApiError(): ApiError { return { code: this.code, message: this.message, retryable: this.retryable, request_id: this.requestId, ...(this.details ? { details: this.details } : {}) }; }
}

/** A failed request as a page says it: a refusal as the server's `code: message`, any other failure by its message. */
export const problemOf = (e: unknown) => (e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

/** POST /v2/workflows/validate's answer: issues refuse a save, warnings only advise. Paths are JSON Pointers into the
 *  workflow ("" for the document itself). */
export type WorkflowCheck = { ok: boolean; issues: { path: string; code: string; message: string }[]; warnings: (string | { path?: string; message: string })[] };

/** `GET /v2/setup/import`'s answer. Before the owner is set: the server can import, still counting (202), then its counts
 *  (null for each when the count failed). After: the import's state. `{ offer: false }`: none, either way. */
export type ImportOffer = { counting: true } | { projects: number | null; sessions: number | null };
export type ImportState = { state: "running" } | { state: "done"; agents: number; runs: number; skipped: number } | { state: "stopped" };
export type SetupImport = ImportOffer | ImportState;
type NoOffer = { offer: false };

/** A runs list's filter (GET /v2/runs's `status` and `archived`): runs in one status, and the archived runs in place of
 *  the others. */
export type RunsFilter = { status?: RunStatus; archived?: boolean };

const runsQuery = (limit: number, cursor: string | null | undefined, { status, archived }: RunsFilter = {}) => {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  if (status) q.set("status", status);
  if (archived) q.set("archived", "true");
  return `?${q}`;
};

export type NativeCapabilities = components["schemas"]["Capabilities"];
type NativeFeatures = components["schemas"]["Features"];
type CompatibleFeatures = { [K in keyof NativeFeatures]?: NativeFeatures[K] extends readonly unknown[] ? NativeFeatures[K] : NativeFeatures[K] extends object ? Partial<NativeFeatures[K]> : NativeFeatures[K] };
/** Older compatible servers may omit newer fields or list tool names without offers. The generated schema describes
 *  this server in full; these optional fields keep those older responses usable without inventing capabilities. */
export type Capabilities = Omit<Partial<NativeCapabilities>, "harnesses" | "features" | "models" | "tools" | "workflows"> & {
  harnesses: { id: string; available: boolean; reason?: string; steer?: boolean }[];
  models?: Omit<NonNullable<NativeCapabilities["models"]>, "source"> & { source?: "faux" | "gateway" | "providers"; ready?: boolean; needs?: "key" | "model" | null };
  tools?: (string | ToolOffer)[];
  workflows?: { nodes?: string[]; node_tools?: string[]; adapters?: string[]; decisions?: { providers?: { id: string; available: boolean; reason?: string; note?: string }[] } };
  features: CompatibleFeatures & Pick<NativeFeatures, "messages"> & {
    triggers?: { routes: boolean; min_every_s?: number; history_kept?: number };
    [extension: string]: unknown;
  };
};
export type ClientOptions = {
  fetch?: typeof fetch;
  base?: string;
  /** Cookie sessions are restricted to the page's own origin. SDK callers opt into bearer transport, which omits cookies. */
  auth?: { type: "cookie" } | { type: "bearer"; token: string | (() => string | Promise<string>) };
};
export type AgentRevision = { revision: string; version: number; current: boolean; note: string | null; created_at: string; kind: "agentic" | "workflow"; definition: Definition };
export type StopResult = components["schemas"]["StopResult"];
export type CancelResult = components["schemas"]["CancelResult"];
export type MessageResult = components["schemas"]["MessageResult"];
export type Client = ReturnType<typeof createClient>;

/** The console's client for `agentrun.v2/0`, on the page's own origin: the server's HttpOnly cookie is the session, and
 *  every write is same-origin JSON (the server refuses a cookie write from another origin). */
export function createClient({ fetch: f = globalThis.fetch.bind(globalThis), base = "/v2", auth = { type: "cookie" } }: ClientOptions = {}) {
  const endpoint = base.replace(/\/$/, "");
  const url = new URL(endpoint, globalThis.location?.href ?? "https://agentrun.invalid/");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("The API base must be an HTTP(S) endpoint without credentials, a query or a fragment.");
  const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(endpoint);
  if (auth.type === "cookie" && ((globalThis.location && url.origin !== globalThis.location.origin) || (!globalThis.location && absolute))) throw new Error("Cookie transport requires a same-origin API. Use explicit bearer transport for another server.");
  const unauthorized = new Set<() => void>();
  const created = new Map<string, { revision: string; warnings: SaveWarning[] }>();
  let generation = 0;
  const current = (started: number) => {
    if (started !== generation) throw new ClientError(0, "session_changed", "The connection or identity changed while the request was in flight.");
  };
  async function call<T>(method: string, path: string, opts: { body?: unknown; raw?: boolean; headers?: Record<string, string>; signal?: AbortSignal; text?: boolean; blob?: boolean } = {}): Promise<T> {
    const started = generation;
    const answer = await callTagged<T>(method, path, opts);
    current(started);
    return answer.body;
  }
  /** A request and its response's ETag (an agent's current revision, for the next If-Match). `text`: the body as text
   *  whatever its type (a run's file is its bytes, never parsed). */
  async function callTagged<T>(method: string, path: string, { body, raw = false, headers = {}, signal, text = false, blob = false }: { body?: unknown; raw?: boolean; headers?: Record<string, string>; signal?: AbortSignal; text?: boolean; blob?: boolean } = {}): Promise<{ body: T; etag: string | null; status: number }> {
    const started = generation;
    // Every write is JSON, a bodiless DELETE too: the server takes the cookie on a write only with this type.
    const json = !raw && (body !== undefined || (method !== "GET" && method !== "HEAD"));
    const bearer = auth.type === "bearer" ? (typeof auth.token === "function" ? await auth.token() : auth.token) : undefined;
    current(started);
    const res = await f(`${endpoint}${path}`, {
      method,
      signal,
      credentials: auth.type === "bearer" ? "omit" : "same-origin",
      headers: { accept: "application/json", ...(json ? { "content-type": "application/json" } : {}), ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body as BodyInit : JSON.stringify(body),
    }).catch((error) => { current(started); throw error; });
    current(started);
    if (!res.ok) {
      const e = ((await res.json().catch(() => null)) as { error?: ApiError & { fields?: FieldIssue[]; retry_after_ms?: number; problems?: NoteProblem[] } } | null)?.error;
      current(started);
      const err = new ClientError(res.status, e?.code ?? "http_error", e?.message ?? `${method} ${path}: ${res.status}`, e?.retryable ?? false, e?.request_id);
      if (e?.fields) err.fields = e.fields;
      if (typeof e?.retry_after_ms === "number") err.retryAfterMs = e.retry_after_ms;
      if (e?.details && typeof e.details === "object" && !Array.isArray(e.details)) err.details = e.details;
      if (Array.isArray(e?.problems)) err.problems = e.problems;
      if (res.status === 401 && !path.startsWith("/auth/") && path !== "/setup") {
        created.clear();
        for (const listener of unauthorized) listener();
      }
      throw err;
    }
    const out = blob ? ((await res.blob()) as T) : !text && (res.headers.get("content-type") ?? "").includes("json") ? ((await res.json()) as T) : ((await res.text()) as T);
    current(started);
    return { body: out, etag: res.headers.get("etag"), status: res.status };
  }
  const agent = (id: string) => `/agents/${encodeURIComponent(id)}`;
  const run = (id: string) => `/runs/${encodeURIComponent(id)}`;
  const trigger = (id: string) => `/triggers/${encodeURIComponent(id)}`;
  // A create's warnings come on its answer, and the agent's page that opens next reads the agent again (a read carries
  // none): they are kept here and put on a read of that same revision, until the next save or make-current of the agent,
  // after which they may be stale (the host can be set up since), so they go.
  const note = (id: string, file: string) => `${agent(id)}/learning/files/${encodeURIComponent(file)}`;
  // A note is text (text/markdown) both ways round, with its version as the ETag; a refusal is still JSON.
  const asNote = (r: { body: string; etag: string | null }): NoteText => ({ note: r.body, etag: r.etag });
  const noteAccept = { accept: "text/markdown, application/json" };
  return {
    /** Non-secret connection identity; bearer credentials are kept inside the transport closure. */
    endpoint,
    /** Uploads through this client's endpoint and credential boundary. Fetch reports completion, not byte progress. */
    upload: async (file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<UploadedFile> => {
      if (signal.aborted) throw new ClientError(0, "aborted", "The upload was stopped.");
      onProgress(0);
      const answer = await call<{ file: UploadedFile }>("POST", `/files?path=${encodeURIComponent(file.name)}`, { body: file, raw: true, headers: file.type ? { "content-type": file.type } : {}, signal });
      if (!answer.file?.file_id) throw new ClientError(0, "bad_answer", "The server's answer named no file.");
      if (signal.aborted) throw new ClientError(0, "aborted", "The upload was stopped.");
      onProgress(1);
      return answer.file;
    },
    onUnauthorized: (listener: () => void) => { unauthorized.add(listener); return () => { unauthorized.delete(listener); }; },
    clearSessionState: () => { generation++; created.clear(); },
    capabilities: () => call<Capabilities>("GET", "/capabilities"),
    /** The owner's session; its status too, since a server without accounts answers 404. */
    session: () => callTagged<{ password_set: boolean; signed_in: boolean }>("GET", "/auth/session").then((r) => ({ status: r.status, body: r.body as unknown }), (e) => {
      if (e instanceof ClientError && e.status === 404) return { status: 404, body: null as unknown };
      throw e;
    }),
    signIn: (password: string) => call<{ signed_in: boolean }>("POST", "/auth/sign-in", { body: { password } }),
    /** Sets the owner's password. `importSessions`: the owner ticked setup's box, so the server imports this machine's
     *  sessions once the password is set; never sent otherwise. */
    setup: (password: string, code?: string, importSessions = false) =>
      call<{ signed_in: boolean; importing?: boolean }>("POST", "/setup", { body: { password, ...(code ? { code } : {}), ...(importSessions ? { import: true } : {}) } }),
    /** `GET /v2/setup/import` (a serve extension, on a server on this machine only): before the owner is set, how many
     *  sessions setup's box would import; after, to the signed-in owner, how the import asked for at setup stands. Null
     *  where the server offers none (`{ offer: false }`, or a 404 from an older server) or refuses the read. */
    setupImport: () => call<SetupImport | NoOffer>("GET", "/setup/import").then((r) => ((r as Partial<NoOffer> | null)?.offer === false ? null : (r as SetupImport)), (e) => {
      if (e instanceof ClientError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }),
    signOut: async () => { const started = generation; const answer = await call<{ signed_out: boolean }>("POST", "/auth/sign-out", { body: {} }); current(started); generation++; created.clear(); return answer; },
    /** Counts and sums from the server's store, for Mission Control (`GET /v2/stats`, a serve extension). */
    stats: () => call<Stats>("GET", "/stats"),
    listRuns: (limit = 50, cursor?: string | null, filter?: RunsFilter) => call<{ runs: Run[]; next_cursor: string | null }>("GET", `/runs${runsQuery(limit, cursor, filter)}`),
    /** `filter`: one status and the archived runs only, or (the agent page's) just `archived`: the archived runs only (an
     *  archived agent's runs are all archived with it). */
    listAgentRuns: (id: string, limit = 50, cursor?: string | null, filter: RunsFilter | boolean = {}) => call<{ runs: Run[]; next_cursor: string | null }>("GET", `${agent(id)}/runs${runsQuery(limit, cursor, typeof filter === "boolean" ? { archived: filter } : filter)}`),
    listAgents: ({ archived = false, cursor }: { archived?: boolean; cursor?: string | null } = {}) => {
      const q = new URLSearchParams();
      if (archived) q.set("archived", "true");
      if (cursor) q.set("cursor", cursor);
      return call<{ agents: Agent[]; next_cursor: string | null }>("GET", `/agents${q.size ? `?${q}` : ""}`);
    },
    getAgent: async (id: string) => {
      const started = generation;
      const r = await callTagged<Agent>("GET", agent(id));
      current(started);
      const kept = created.get(id);
      return { agent: kept && kept.revision === r.body.revision && !r.body.warnings ? { ...r.body, warnings: kept.warnings } : r.body, etag: r.etag };
    },
    createAgent: async (body: { definition: Definition; skills?: Record<string, string> }) => {
      const started = generation;
      const made = await call<Agent>("POST", "/agents", { body });
      current(started);
      if (made.warnings?.length) created.set(made.agent_id, { revision: made.revision, warnings: made.warnings });
      return made;
    },
    /** Saves a new revision. `etag` is the revision the edit was made on: the server refuses the save (412) when another
     *  landed first. The answer's ETag is the new revision, for the next edit. */
    updateDefinition: async (id: string, body: { definition: Partial<Definition>; note?: string; skills?: Record<string, string> }, etag: string | null) => {
      const started = generation;
      const r = await callTagged<Agent>("PUT", `${agent(id)}/definition`, { body, headers: etag ? { "if-match": etag } : {} });
      current(started);
      created.delete(id);
      return { agent: r.body, etag: r.etag };
    },
    listRevisions: (id: string, cursor?: string | null) => call<{ revisions: AgentRevision[]; next_cursor: string | null }>("GET", `${agent(id)}/revisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    setCurrent: async (id: string, revision: string) => { const started = generation; const r = await call<Agent>("POST", `${agent(id)}/current`, { body: { revision } }); current(started); created.delete(id); return r; },
    archiveAgent: (id: string) => call<Agent>("POST", `${agent(id)}/archive`, { body: {} }),
    unarchiveAgent: (id: string) => call<Agent>("POST", `${agent(id)}/unarchive`, { body: {} }),
    /** What an agent learned: its notes' first page, the index its next run reads, the changes, and how its runs did. */
    agentLearning: (id: string) => call<AgentLearning>("GET", `${agent(id)}/learning`),
    learningNotes: (id: string, cursor: string) => call<Page<LearningNote>>("GET", `${agent(id)}/learning/notes?cursor=${encodeURIComponent(cursor)}`),
    learningLog: (id: string, cursor: string) => call<Page<LearningChange>>("GET", `${agent(id)}/learning/log?cursor=${encodeURIComponent(cursor)}`),
    /** A note's whole text and its version, for the If-Match of an edit or a retire. */
    readNote: async (id: string, file: string) => asNote(await callTagged<string>("GET", note(id, file), { headers: noteAccept, text: true })),
    /** Edits a note (`etag`: the version the edit was made on; 412 when it changed since) or creates one (`create`: 412
     *  when the name is taken). The text goes as JSON, the one write the server takes under the page's session. The
     *  answer is the note as it now is, and its new version. */
    writeNote: async (id: string, file: string, text: string, on: { etag: string } | { create: true }) =>
      asNote(await callTagged<string>("PUT", note(id, file), { body: { text }, headers: { ...noteAccept, ...("etag" in on ? { "if-match": on.etag } : { "if-none-match": "*" }) }, text: true })),
    /** Retires a note: out of every later run's instructions, its record kept. 412 when it changed since `etag`. */
    retireNote: async (id: string, file: string, etag: string) => asNote(await callTagged<string>("POST", `${note(id, file)}/retire`, { body: {}, headers: { ...noteAccept, "if-match": etag }, text: true })),
    /** Approves a note that waits for the owner's OK, so later runs read it; 412 when it changed since `etag`. */
    approveNote: async (id: string, file: string, etag: string) => asNote(await callTagged<string>("POST", `${note(id, file)}/approve`, { body: {}, headers: { ...noteAccept, "if-match": etag }, text: true })),
    getRun: (id: string) => call<Run>("GET", run(id)),
    /** What the run's learning changed in its agent's notes, file by file (each with its patch, or why it is withheld). */
    runLearningDiff: (id: string) => call<LearningDiff>("GET", `${run(id)}/learning/diff`),
    /** Hides a run from the runs list (or shows it again), its history kept. The answer is the run. */
    archiveRun: (id: string) => call<Run>("POST", `${run(id)}/archive`, { body: {} }),
    unarchiveRun: (id: string) => call<Run>("POST", `${run(id)}/unarchive`, { body: {} }),
    /** Raises an agentic run's spend cap (only a raise: above its current cap, else 422). A run paused at its cap goes on
     *  (`resumed`); an ended run is 409 not_continuable. */
    raiseCap: (id: string, maxCostUsd: number) => call<RaiseAnswer>("PATCH", run(id), { body: { max_cost_usd: maxCostUsd } }),
    /** Starts a run. The server answers 202 with the run; the same key with the same body answers with that same run. */
    startRun: async (agentId: string, body: { input: unknown; revision?: string; effort?: string; max_cost_usd?: number; file_ids?: string[] }, idempotencyKey: string) => {
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
    /** Deletes an upload (`DELETE /v2/files/{id}`): one the person removed before a run named it. */
    deleteUpload: (fileId: string) => call<string>("DELETE", `/files/${encodeURIComponent(fileId)}`),
    readFile: (id: string, path: string) => call<string>("GET", `${run(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, { text: true }),
    /** The authenticated original bytes, for downloads and binary previews. */
    readFileBlob: (id: string, path: string) => call<Blob>("GET", `${run(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, { blob: true }),
    /** One send, one key: a retry of the same send reuses its key, so the server keeps the first request's identity. */
    sendMessage: (id: string, content: string, idempotencyKey: string) =>
      call<MessageResult>("POST", `${run(id)}/messages`, { body: { content }, headers: { "idempotency-key": idempotencyKey } }),
    /** A workflow run's graph, live: each node's state, its decisions and tool calls, and the totals. */
    getRunGraph: (id: string, signal?: AbortSignal) => call<RunGraph>("GET", `${run(id)}/graph`, { signal }),
    /** Pauses a workflow run: calls in flight finish, and no new node starts until it resumes. */
    pauseRun: (id: string) => call<{ paused: boolean }>("POST", `${run(id)}/pause`, { body: {} }),
    resumeRun: (id: string) => call<{ paused: boolean }>("POST", `${run(id)}/resume`, { body: {} }),
    /** The server's own check of a workflow (the DSL's validator, no code run, nothing stored). 404 on a server without it. */
    validateWorkflow: (body: { workflow: unknown; tools?: string[] }, signal?: AbortSignal) => call<WorkflowCheck>("POST", "/workflows/validate", { body, signal }),
    /** GET /v2/stats with its `analytics` bounded: runs started at or after `from`, of `agent`. Every other number is the
     *  whole store's. */
    statsOver: ({ from, agent: of }: { from?: string; agent?: string }) => {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (of) q.set("agent", of);
      return call<Stats>("GET", `/stats${q.size ? `?${q}` : ""}`);
    },
    /** A run file's URL on this origin (a rendered page's image), for an <img>: the session cookie goes with it. */
    fileUrl: (id: string, path: string) => `${endpoint}${run(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    /** The tool keys and where each field is set, never a value (a serve extension; 404 on a server without it). */
    listToolKeys: () => call<ToolKeys>("GET", "/settings/tool-keys"),
    /** Saves the given fields of one key (204); its other fields stay. No Idempotency-Key: the same PUT twice is the same
     *  state, and the server keeps no record of a body that holds the values. */
    saveToolKey: (id: string, values: Record<string, string>) => call<unknown>("PUT", `/settings/tool-keys/${encodeURIComponent(id)}`, { body: { values } }),
    removeToolKey: (id: string) => call<unknown>("DELETE", `/settings/tool-keys/${encodeURIComponent(id)}`),
    /** The webhook, never its secret (a serve extension). */
    webhook: () => call<Webhook>("GET", "/settings/webhook"),
    /** Sets the webhook's URL; the first PUT makes its secret and answers it, once (`secret`). */
    saveWebhook: (url: string) => call<WebhookSaved>("PUT", "/settings/webhook", { body: { url } }),
    removeWebhook: () => call<unknown>("DELETE", "/settings/webhook"),
    /** A `webhook.test` message, tried once now: its attempt. */
    testWebhook: () => call<WebhookAttempt>("POST", "/settings/webhook/test", { body: {} }),
    /** The last attempts, newest first. */
    /** Schedules (serve's trigger/1): each starts an agent's capped runs. */
    listTriggers: () => call<{ triggers: Trigger[] }>("GET", "/triggers"),
    getTrigger: (id: string) => call<Trigger>("GET", trigger(id)),
    createTrigger: (body: TriggerInput) => call<Trigger>("POST", "/triggers", { body }),
    updateTrigger: (id: string, body: TriggerInput) => call<Trigger>("PATCH", trigger(id), { body }),
    deleteTrigger: (id: string) => call<unknown>("DELETE", trigger(id)),
    /** Runs a schedule now: `key` is the click's own Idempotency-Key, so the same click sent again fires once. */
    fireTrigger: (id: string, key: string) => call<Firing>("POST", `${trigger(id)}/fire`, { body: {}, headers: { "idempotency-key": key } }),
    /** Its last firings, newest first. */
    triggerFirings: (id: string) => call<{ firings: Firing[] }>("GET", `${trigger(id)}/firings`),
    webhookDeliveries: () => call<{ attempts: WebhookAttempt[] }>("GET", "/settings/webhook/deliveries"),
    /** A message of the log sent again, once now, under its webhook-id: its attempt. */
    redeliverWebhook: (id: string) => call<WebhookAttempt>("POST", `/settings/webhook/deliveries/${encodeURIComponent(id)}/redeliver`, { body: {} }),
    /** The server's provider per capability that has a choice (its default where it sets none). */
    toolSettings: () => call<ToolSettings>("GET", "/settings/tools"),
    /** Replaces the server's providers: a capability the body leaves out takes its default. The answer is each one's now. */
    saveToolSettings: (settings: ToolSettings) => call<ToolSettings>("PUT", "/settings/tools", { body: settings }),
    stop: (id: string) => call<StopResult>("POST", `${run(id)}/stop`, { body: {} }),
    /** Answers the tool call the run waits on the owner's approval of (`pending.id`, approvals/1): 204. The owner's
     *  password session alone may (a token is 403); the first answer wins, so the same one again is 204 and another 409
     *  `not_continuable` with `details: { reason: "already_answered", decision }`. `note`: with deny, the reason the model
     *  is told; sent only when given. */
    answerApproval: (id: string, approvalId: string, decision: "allow" | "deny", note?: string) =>
      call<unknown>("POST", `${run(id)}/approvals/${encodeURIComponent(approvalId)}`, { body: { decision, ...(note ? { note } : {}) } }),
    cancel: (id: string) => call<CancelResult>("POST", `${run(id)}/cancel`, { body: {} }),
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
export type TimelineCheckpoint = { rows: TimelineRow[]; after?: number };

export async function follow(
  v2: Client,
  runId: string,
  { onRows, onPage, signal, checkpoint, waitMs = 25000, minDelayMs = 250 }: { onRows?: (rows: TimelineRow[]) => void; onPage?: (page: TimelinePage) => void; signal?: AbortSignal; checkpoint?: TimelineCheckpoint; waitMs?: number; minDelayMs?: number },
): Promise<TimelinePage> {
  let rows: TimelineRow[] = checkpoint?.rows ?? [];
  let after: number | undefined = checkpoint?.after;
  let last: TimelinePage | undefined;
  while (!signal?.aborted) {
    const page = await v2.getTimeline(runId, after === undefined ? { signal } : { after, waitMs, signal }).catch((e) => { if (signal?.aborted) return null; throw e; });
    if (!page || signal?.aborted) break;
    last = page;
    if (onRows) rows = applyPage(rows, page);
    if (checkpoint) { checkpoint.rows = rows; checkpoint.after = page.next_after; }
    onPage?.(page);
    onRows?.(rows);
    if (page.final && !page.has_more) break;
    after = page.next_after;
    const delay = Math.max(minDelayMs, page.unchanged ? (page.poll_after_ms ?? 0) : 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  return last as TimelinePage;
}
