// The slice of agentrun.v2/0 the console reads, typed from the server's recorded responses (src/fixtures).

/** `paused`: a workflow run paused by POST /v2/runs/{id}/pause; its calls in flight finish and no node starts. */
export type RunStatus = "queued" | "working" | "input_required" | "completed" | "failed" | "cancelled" | "paused";
export type RunState = "working" | "waiting" | "idle";

export type ApiError = { code: string; message: string; retryable: boolean; request_id?: string };

/** `source` (a serve extension): "reported" when every part of the cost is a provider's own report, else "estimate".
 *  An older server leaves it out, and then `basis` says whether the number is an estimate. */
export type Cost = { usd: number | null; basis: string; source?: "reported" | "estimate"; charge_state: string | null; cap_usd: number | null };

export type Run = {
  run_id: string;
  agent_id: string;
  agent_version: number;
  revision: string;
  kind: "agentic" | "workflow";
  status: RunStatus;
  state: RunState;
  title: string;
  created_at: string;
  updated_at?: string;
  ended_at: string | null;
  result: { output?: unknown; final_answer?: string | null } | null;
  error: ApiError | null;
  cost: Cost | null;
  archived_at: string | null;
  poll_after_ms?: number;
};

export type TimelineKind =
  | "user_message" | "thinking" | "tool_use" | "tool_result" | "waiting" | "usage" | "final_answer" | "phase" | string;

export type TimelineRow = {
  id: string;
  seq: number;
  kind: TimelineKind;
  summary: string;
  text: string | null;
  timestamp: string;
  created_at?: string;
  tool_name: string | null;
  tool_status?: string | null;
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
export type ToolKey = { id: string; label: string; fields: ToolKeyField[]; unlocks: string[]; harnesses: string[] };
/** Saved values that do not open on this server, and why. `fields` is empty when the whole file does not read. */
export type ToolKeysReenter = { reason: "seal_key_missing" | "seal_key_changed" | "file_unreadable"; fields: string[] };
export type ToolKeys = { keys: ToolKey[]; reenter: ToolKeysReenter | null };
/** `capabilities.features.tool_keys`: the routes, and whether a saved key is kept (`sealed`) or cannot be (`unavailable`). */
export type ToolKeysFeature = { routes: boolean; at_rest: "sealed" | "unavailable" };

/** A recorded response: what the server answered, exactly. */
export type Recorded<T> = { request: { method: string; path: string }; status: number; headers?: Record<string, string>; body: T };
