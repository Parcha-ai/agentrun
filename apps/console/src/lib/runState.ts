import type { Run, RunState, RunStatus } from "./v2";

export type Tone = "active" | "success" | "warning" | "error" | "muted";
export type MessageMode = "steer" | "answer" | "follow_up";
/** The server's `features.messages` (GET /v2/capabilities): which modes it takes. */
export type MessageFeatures = { steer: boolean; answer: boolean; follow_up: boolean; steer_workflow_runs: boolean };
/** Whether a harness steers mid-turn: the server's own `capabilities.harnesses[].steer` when it says, and otherwise pi
 *  alone (serve's steersMidTurn). An unnamed harness is the default, pi. On one that does not, a message to a working run
 *  waits for the turn's end: the server answers `follow_up`, so the console offers that, not a steer. */
export function harnessSteers(harness: string | undefined, harnesses: { id: string; available?: boolean; steer?: boolean }[]): boolean {
  const id = harness ?? "pi";
  const said = harnesses.find((h) => h.id === id)?.steer;
  return typeof said === "boolean" ? said : id === "pi";
}

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
function modeFor(status: RunStatus, state: RunState, kind: Run["kind"], on: MessageFeatures, steers: boolean): MessageMode | null {
  const midTurn = status === "queued" || (status === "working" && state === "working");
  const mode: MessageMode | null =
    // A harness that does not steer mid-turn takes the message after the turn: the server answers follow_up.
    midTurn ? (steers || kind === "workflow" ? "steer" : "follow_up")
    : status === "input_required" && state === "waiting" ? "answer"
    : status === "input_required" || status === "working" || status === "completed" ? "follow_up"
    : null;
  if (!mode || !on[mode]) return null;
  if (kind === "workflow") return mode === "steer" && on.steer_workflow_runs ? mode : null;
  return mode;
}

/** How the console shows a run: serve's status and state, by its contract table and its guards (runs.ts message, stop,
 *  cancel). Stopped (input_required, idle), input required (input_required, waiting) and cancelled stay distinct. */
export function runState(status: RunStatus, state: RunState, kind: Run["kind"], messages: MessageFeatures, steers: boolean): RunView {
  const final = FINAL.has(status);
  const agentic = kind === "agentic";
  const label =
    status === "input_required" ? (state === "waiting" ? "Input required" : "Stopped")
    : { queued: "Queued", working: "Working", completed: "Completed", failed: "Failed", cancelled: "Cancelled", paused: "Paused" }[status];
  const tone: Tone =
    status === "completed" ? "success" : status === "failed" ? "error" : status === "cancelled" ? "muted"
    : status === "input_required" || status === "paused" ? "warning" : "active";
  const messageMode = modeFor(status, state, kind, messages, steers);
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
