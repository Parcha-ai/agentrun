// The slice of agentrun.v2/0 the console reads, typed from the server's recorded responses (src/fixtures).

export type RunStatus = "queued" | "working" | "input_required" | "completed" | "failed" | "cancelled";
export type RunState = "working" | "waiting" | "idle";

export type ApiError = { code: string; message: string; retryable: boolean; request_id?: string };

/** `kind` and `node` are null on a run escalated before serve named them; `reason` then comes from the escalation. */
export type RunReview = { kind: string | null; node: string | null; reason: string; at: string };

export type Cost = { usd: number | null; basis: string; charge_state: string | null; cap_usd: number | null };

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
  /** Set when a decision workflow routed the run's case to a person: the run is completed, and it needs review. */
  review?: RunReview | null;
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

/** A recorded response: what the server answered, exactly. */
export type Recorded<T> = { request: { method: string; path: string }; status: number; headers?: Record<string, string>; body: T };
