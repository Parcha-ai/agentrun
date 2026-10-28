import type { Run, RunState, RunStatus } from "./v2";

export type Tone = "active" | "success" | "warning" | "error" | "muted";
export type MessageMode = "steer" | "answer" | "follow_up";

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

/** How the console shows a run: serve's status and state, by its contract table and its guards (runs.ts message, stop,
 *  cancel). Stopped (input_required, idle), input required (input_required, waiting) and cancelled stay distinct. */
export function runState(status: RunStatus, state: RunState, kind: Run["kind"]): RunView {
  const final = FINAL.has(status);
  const agentic = kind === "agentic";
  const label =
    status === "input_required" ? (state === "waiting" ? "Input required" : "Stopped")
    : { queued: "Queued", working: "Working", completed: "Completed", failed: "Failed", cancelled: "Cancelled" }[status];
  const tone: Tone =
    status === "completed" ? "success" : status === "failed" ? "error" : status === "cancelled" ? "muted"
    : status === "input_required" ? "warning" : "active";
  const steer = status === "queued" || (status === "working" && state === "working");
  const messageMode: MessageMode | null = !agentic || status === "failed" || status === "cancelled" || (status === "working" && state === "idle")
    ? null
    : steer ? "steer" : status === "input_required" && state === "waiting" ? "answer" : "follow_up";
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
