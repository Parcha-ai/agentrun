// The slice of agentrun.v2/0 the console reads, typed from the server's recorded responses (src/fixtures).

/** `paused`: a workflow run paused by POST /v2/runs/{id}/pause; its calls in flight finish and no node starts. */
export type RunStatus = "queued" | "working" | "input_required" | "completed" | "failed" | "cancelled" | "paused";
export type RunState = "working" | "waiting" | "idle";

/** `details`: what the server says beyond the message, by code (a 409 `agent_not_runnable` names the harness or box it lacks). */
export type ApiError = { code: string; message: string; retryable: boolean; request_id?: string; details?: Record<string, unknown> };

/** A provider per capability that has a choice (web_search, web_fetch): the server's (GET and PUT /v2/settings/tools)
 *  and an agent's own (`definition.tool_settings`), over the server's. */
export type ToolSettings = Record<string, { provider?: string }>;
/** GET /v2/agents/{id}'s `tools`: each tool the agent grants; one with a provider choice with the provider in force, where
 *  it came from (the agent's own setting, the server's, or the built-in default), the one that applies when the agent sets
 *  none (the server's), and what it resolves to on the agent's harness and model. */
export type AgentTool = { name: string; provider?: string; provider_from?: "agent" | "server" | "default"; default_provider?: string; resolved?: string };

/** `at_most_usd`: the run's cost bound, when the server knows one. It is set only while `usd` is null because requests
 *  were cut or stopped, each with a worst case, and it is the most the run can have cost. Absent, the cost is unknown with
 *  no bound. */
export type Cost = { usd: number | null; basis: string; charge_state: string | null; cap_usd: number | null; at_most_usd?: number | null };

export type Run = {
  run_id: string;
  agent_id: string;
  agent_version: number;
  revision: string;
  kind: "agentic" | "workflow";
  status: RunStatus;
  state: RunState;
  title: string;
  /** The effort the run was started with; absent when it was started with none. */
  effort?: string;
  created_at: string;
  updated_at?: string;
  ended_at: string | null;
  result: { output?: unknown; final_answer?: string | null } | null;
  error: ApiError | null;
  cost: Cost | null;
  archived_at: string | null;
  poll_after_ms?: number;
  /** A workflow run that escalated: it completed, and waits for a person to review it (`kind`, the node it stopped
   *  at, and why). Null or absent on every other run. */
  review?: RunReview | null;
};

export type RunReview = { kind: string | null; node: string | null; reason: string; at?: string };

export type TimelineKind =
  | "user_message" | "thinking" | "tool_use" | "tool_result" | "waiting" | "usage" | "final_answer" | "phase" | "decision" | string;

export type TimelineRow = {
  id: string;
  seq: number;
  kind: TimelineKind;
  summary: string;
  text: string | null;
  timestamp: string;
  created_at?: string;
  tool_name: string | null;
  /** The call a tool row belongs to: a call and its result share it. */
  tool_use_id?: string | null;
  /** The file a row names: an action's write (one row per action), or an older phase row's "Saved" file. */
  path?: string | null;
  /** When an action ended (one row per action): null while it runs. */
  ended_at?: string | null;
  /** A tool row's outcome. With one row per action (capabilities' `timeline.actions`) the call's own row changes in
   *  place: `running` until it ends, then `success`, `failed`, `missing` (a read that found nothing the run wrote: not an
   *  error) or `interrupted` (no result came). */
  tool_status?: "running" | "success" | "failed" | "missing" | "interrupted" | null;
  tool_input_preview?: string | null;
  tool_result_preview?: string | null;
  agent_label?: string | null;
};

export type TimelinePage = {
  run_id: string;
  status: RunStatus;
  state: RunState;
  rows: TimelineRow[];
  drop: string[];
  reset: boolean;
  unchanged: boolean;
  final: boolean;
  has_more: boolean;
  next_after: number;
  poll_after_ms?: number;
  cost?: Cost | null;
};

export type RunFile = { path: string; size_bytes: number; modified_at: string; content_type: string | null };
export type RunFiles = { run_id: string; files: RunFile[]; complete: boolean; truncated: boolean };

/** Tool keys (GET /v2/settings/tool-keys, a serve extension): each key a person may save, what it unlocks and the
 *  harnesses that run that, and each field by name with where it is set. The server never sends a value. */
export type ToolKeyField = { name: string; set: boolean; source: "server" | "stored" | null; stored_unreadable?: true };
/** A saved key's check with its provider: accepted, when; or not checked, why (in plain words) and when it last tried, if
 *  it did. Null, or absent from a server that does not check, says nothing. */
export type ToolKeyCheck = { state: "accepted"; at: string } | { state: "not_checked"; reason: string; at?: string };
/** `kind`: `model`, a model provider's key, which every run gets; `tool`, one a tool needs. Absent on an older server. */
export type ToolKey = { id: string; kind?: "tool" | "model"; label: string; fields: ToolKeyField[]; unlocks: string[]; harnesses: string[]; check?: ToolKeyCheck | null };
/** Saved values that do not open on this server, and why. `fields` is empty when the whole file does not read. */
export type ToolKeysReenter = { reason: "seal_key_missing" | "seal_key_changed" | "file_unreadable"; fields: string[] };
export type ToolKeys = { keys: ToolKey[]; reenter: ToolKeysReenter | null };
/** `capabilities.features.tool_keys`: the routes, and whether a saved key is kept (`sealed`) or cannot be (`unavailable`). */
export type ToolKeysFeature = { routes: boolean; at_rest: "sealed" | "unavailable" };

/** The webhook (GET /v2/settings/webhook, a serve extension): the URL run notices are POSTed to, signed by the Standard
 *  Webhooks spec; whether its secret signs here; and why it is off, when a 410 turned it off. Never the secret. */
export type Webhook = { configured: false } | { configured: true; url: string; signing: "sealed" | "seal_key_missing" | "unreadable"; disabled: { at: string; reason: string } | null; updated_at: string };
/** A PUT's answer: the webhook, and its secret the first time (201), shown this once. */
export type WebhookSaved = Extract<Webhook, { configured: true }> & { secret?: string };
/** One try of a message (GET .../deliveries, newest first): its webhook-id, the receiver's answer or why it failed, and
 *  when it is tried again. */
export type WebhookAttempt = { webhook_id: string; type: "run.needs_input" | "run.ended" | "webhook.test"; at: string; status_code: number | null; latency_ms: number; error: string | null; retry_at: string | null; redelivery: boolean };
/** `capabilities.features.webhooks`: the routes, the events, and whether a secret is kept (`sealed`) or cannot be. */
export type WebhooksFeature = { routes: boolean; events: string[]; signing: string; at_rest: "sealed" | "unavailable" };

/** A recorded response: what the server answered, exactly. */
export type Recorded<T> = { request: { method: string; path: string }; status: number; headers?: Record<string, string>; body: T };
