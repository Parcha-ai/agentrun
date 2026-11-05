// The slice of agentrun.v2/0 the console reads, typed from the server's recorded responses (src/fixtures).

import type { RunLearning } from "./learning";

/** `paused`: a workflow run paused by POST /v2/runs/{id}/pause; its calls in flight finish and no node starts. */
export type RunStatus = "queued" | "working" | "input_required" | "completed" | "failed" | "cancelled" | "paused";
export type RunState = "working" | "waiting" | "idle";

/** `details`: what the server says beyond the message, by code (a 409 `agent_not_runnable` names the harness or box it lacks). */
export type ApiError = { code: string; message: string; retryable: boolean; request_id?: string; details?: Record<string, unknown> };

/** What the server's tool gate does with a tool's calls: allow runs it, ask waits for the owner's approval, deny refuses
 *  it (approvals/1). */
export type Permission = "allow" | "ask" | "deny";
/** Tool settings by settings key: a provider per capability that has a choice (web_search, web_fetch), and any tool's
 *  permission, a catalog tool's (`monid.<tool>`, `mcp:<server>/<tool>`) and an MCP server's wildcard (`mcp:<server>/*`)
 *  among them. The server's (GET and PUT /v2/settings/tools, which replaces the whole map) and an agent's own
 *  (`definition.tool_settings`), over the server's. */
export type ToolSettings = Record<string, { provider?: string; permission?: Permission }>;
/** GET /v2/agents/{id}'s `tools`: each tool the agent grants, with its permission in force, where it came from and the
 *  one that applies when the agent sets none (the server's); one with a provider choice with the provider in force, where
 *  it came from (the agent's own setting, the server's, or the built-in default), the one that applies when the agent
 *  sets none (the server's), and what it resolves to on the agent's harness and model. */
export type AgentTool = {
  name: string; provider?: string; provider_from?: "agent" | "server" | "default"; default_provider?: string; resolved?: string;
  permission?: Permission; permission_from?: "agent" | "server" | "default"; default_permission?: Permission; permissions?: Permission[];
};

/** `so_far_usd` and `unpriced` (serve's costsofar/1), present only while `usd` is null: the sum of every charge whose cost
 *  is known, and how many charges have none (a request cut, stopped or still pending, a model with no price, a paid call
 *  charged an unknown amount). `so_far_usd` is never the whole cost and never a ceiling. */
export type Cost = { usd: number | null; basis: string; charge_state: string | null; cap_usd: number | null; so_far_usd?: number; unpriced?: number };

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
  /** Where the run's learning is: null for a run that does not learn, absent from a server without learning. */
  learning?: RunLearning;
  archived_at: string | null;
  poll_after_ms?: number;
  /** A workflow run that escalated: it completed, and waits for a person to review it (`kind`, the node it stopped
   *  at, and why). Null or absent on every other run. */
  review?: RunReview | null;
  /** What a run waiting on a person waits for (status input_required): its question; a tool call that waits for the
   *  owner's approval; or, paused at its spend cap, the cap, the refusal's figures and words (a message to it is refused
   *  until its cap is raised). Null on every other run. */
  pending?: PendingQuestion | PendingApproval | BudgetPending | null;
  /** Imported history: where the run was run (`claude-code`, `codex` or `pi`) and its session there; else null. */
  imported_from?: { source: string; session: string } | null;
  /** The schedule that started it and its firing (serve's trigger/1); null for a run a caller started, absent from an
   *  older server. The schedule may have been deleted since. */
  trigger?: { id: string; firing_key: string } | null;
};

/** When a schedule fires (serve's trigger/1): a five-field cron line in an IANA zone, one time, or every N seconds (60
 *  or more) on the grid from `start_at`. */
export type TriggerSource =
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "schedule"; at: string }
  | { kind: "schedule"; every_s: number; start_at: string };
/** What a firing does: start a run of `agent_id` with `input`, capped at `max_cost_usd`. */
/** `max_cost_usd` absent: each run takes the agent's default cap per run (its definition's max_cost_usd). */
export type TriggerTarget = { kind: "start_run"; agent_id: string; input: { content?: string } & Record<string, unknown>; max_cost_usd?: number; effort?: string };
/** `sent`: a firing of a trigger that sends a message to a run (not a schedule this console shows). */
export type FiringStatus = "due" | "started" | "sent" | "skipped" | "failed" | "missed";
/** One firing: by the schedule or by hand (Run now), for `nominal_at`, and what came of it. `count`: a missed row's
 *  times; `attempts` and `retry_at`: a due one a full server keeps for later; `catch_up`: a time missed while the server
 *  was down, fired late within the schedule's catch-up window. */
export type Firing = { key: string; by: "schedule" | "manual"; nominal_at: string; status: FiringStatus; at: string; run_id: string | null; reason: string | null; error: { code: string; message: string } | null; count?: number; attempts?: number; retry_at?: string; catch_up?: true };
/** Why the server turned a schedule off itself: a failure streak (`auto_paused`), or a source it can no longer read. */
export type TriggerDisabled = { at: string; reason: "auto_paused" } | { at: string; reason: "source_unreadable"; detail: string };
/** A schedule (GET /v2/triggers): `next_at` null when it is paused or has no time left; `last_firing` null until it fires.
 *  `failures_in_a_row` and `disabled` (null while it is on, or a person paused it) from a server that turns a schedule off
 *  itself; absent from an older one. */
export type Trigger = { id: string; name: string; enabled: boolean; source: TriggerSource; target: TriggerTarget; created_at: string; updated_at: string; next_at: string | null; overlap: "skip"; last_firing: Firing | null; failures_in_a_row?: number; disabled?: TriggerDisabled | null };
/** A create's or an edit's body: the parts the form holds. */
export type TriggerInput = { name?: string; enabled?: boolean; source?: TriggerSource | { kind: "schedule"; every_s: number; start_at?: string }; target?: TriggerTarget };
/** A question the run asked a person (ask_person): a message answers it. */
export type PendingQuestion = { kind: "question"; question: string; asked_at: string };
/** A tool call set to ask, waiting for the owner's approval (approvals/1): POST /v2/runs/{id}/approvals/{id} answers it.
 *  `tool`: its settings key (`web_fetch`, `monid.run`, `mcp:<server>/<tool>`); `call_id`: its tool_result row's
 *  tool_use_id; `args_preview`: its arguments as JSON, redacted, cut at 2 KiB; `price`: USD per call where its tool names
 *  one, "not metered" for an unpriced MCP call, absent otherwise. */
export type PendingApproval = { kind: "approval"; id: string; tool: string; call_id: string; args_preview: string; requested_at: string; price?: number | "not metered" };

export type RunReview = { kind: string | null; node: string | null; reason: string; at?: string };

export type TimelineKind =
  | "user_message" | "thinking" | "tool_use" | "tool_result" | "waiting" | "usage" | "final_answer" | "phase" | "decision"
  /** A tool call that waited for the owner's approval, after its result's row and with its tool_use_id (approvals/1). */
  | "tool_approval_requested" | string;

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
  /** `server` on the row of a message the server wrote into the run (an approval's resume, a raised cap's follow-up): a
   *  `phase` row whose summary is "AgentRun: <its first line>". It is the message the turn took, never the person's. */
  origin?: "server";
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

/** PATCH /v2/runs/{id} {max_cost_usd}'s answer: the cap now. `resumed`: a run paused at its cap goes on (its follow-up
 *  turn, `message_id`, is sent once its process has been let go). `note`: a working run's live process keeps its old cap
 *  until its next one. */
export type RaiseAnswer = { run_id: string; max_cost_usd: number; resumed: boolean; message_id?: string; status: RunStatus; state: RunState; note?: string };

/** A run paused at its spend cap: what is left of its cap cannot buy its next request's least, which was not sent. */
export type BudgetPending = { kind: "budget"; cap_usd: number; spent_usd?: number; needs_usd?: number; said: string; at: string;
  /** The server's suggested new cap, always strictly above `cap_usd` (a newer server's; absent from an older one). */
  suggested_cap_usd?: number };
