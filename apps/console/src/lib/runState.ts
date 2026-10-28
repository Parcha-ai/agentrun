import type { Run, RunState, RunStatus } from "./v2";

export type Tone = "active" | "success" | "warning" | "error" | "muted";
export type MessageMode = "steer" | "answer" | "follow_up";
/** The server's `features.messages` (GET /v2/capabilities): which modes it takes. */
export type MessageFeatures = { steer: boolean; answer: boolean; follow_up: boolean; steer_workflow_runs: boolean };
/** For views that show a run's status but send it no message. */
export const NO_MESSAGES: MessageFeatures = { steer: false, answer: false, follow_up: false, steer_workflow_runs: false };

export type RunView = {
  label: string;
  tone: Tone;
  /** The server is moving it: queued, working, or working with no live turn (relaunched on its own after a restart). */
  live: boolean;
  /** It waits for a person: an `ask_person` question (input required) or a stopped turn. */
  needsYou: boolean;
  final: boolean;
  canStop: boolean;
  canCancel: boolean;
  canMessage: boolean;
  messageMode: MessageMode | null;
};

const FINAL = new Set<RunStatus>(["completed", "failed", "cancelled"]);

/** The mode `POST /v2/runs/{id}/messages` takes for a run, by the contract's table: `steer` while queued or working with a
 *  live turn, `answer` when it waits on a question, `follow_up` after a stop, while parked (working, idle) or once
 *  completed; none once failed or cancelled. A mode the server turned off is not offered; a workflow run only steers,
 *  and only where `steer_workflow_runs` is on. */
function modeFor(status: RunStatus, state: RunState, kind: Run["kind"], on: MessageFeatures): MessageMode | null {
  const mode: MessageMode | null =
    status === "queued" || (status === "working" && state === "working") ? "steer"
    : status === "input_required" && state === "waiting" ? "answer"
    : status === "input_required" || status === "working" || status === "completed" ? "follow_up"
    : null;
  if (!mode || !on[mode]) return null;
  if (kind === "workflow") return mode === "steer" && on.steer_workflow_runs ? mode : null;
  return mode;
}

/** How the console shows a run: serve's status and state, by its contract table and its guards (runs.ts message, stop,
 *  cancel). Stopped (input_required, idle), input required (input_required, waiting) and cancelled stay distinct. */
export function runState(status: RunStatus, state: RunState, kind: Run["kind"], messages: MessageFeatures): RunView {
  const final = FINAL.has(status);
  const agentic = kind === "agentic";
  const label =
    status === "input_required" ? (state === "waiting" ? "Input required" : "Stopped")
    : { queued: "Queued", working: "Working", completed: "Completed", failed: "Failed", cancelled: "Cancelled" }[status];
  const tone: Tone =
    status === "completed" ? "success" : status === "failed" ? "error" : status === "cancelled" ? "muted"
    : status === "input_required" ? "warning" : "active";
  const messageMode = modeFor(status, state, kind, messages);
  return {
    label,
    tone,
    live: status === "queued" || status === "working",
    needsYou: status === "input_required",
    final,
    canStop: agentic && status === "working" && state === "working",
    canCancel: !final,
    canMessage: messageMode !== null,
    messageMode,
  };
}
