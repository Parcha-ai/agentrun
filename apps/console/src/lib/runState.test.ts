import { describe, expect, it } from "vitest";
import { harnessSteers, type MessageFeatures, runState as view } from "./runState";

// The server's features.messages as the recorded capabilities report them, and with each mode off.
const ON: MessageFeatures = { steer: true, answer: true, follow_up: true, steer_workflow_runs: false };
const runState = (status: Parameters<typeof view>[0], state: Parameters<typeof view>[1], kind: Parameters<typeof view>[2]) => view(status, state, kind, ON, true);

// The labels follow serve's contract table (statusOf); the actions follow its guards for messages, stop and cancel.
describe("runState", () => {
  it("names the six statuses and keeps stopped, waiting and cancelled apart", () => {
    expect(runState("queued", "working", "agentic")).toMatchObject({ label: "Queued", tone: "active", live: true });
    expect(runState("working", "working", "agentic")).toMatchObject({ label: "Working", tone: "active", live: true });
    expect(runState("completed", "idle", "agentic")).toMatchObject({ label: "Completed", tone: "success", live: false });
    expect(runState("failed", "idle", "agentic")).toMatchObject({ label: "Failed", tone: "error", live: false });
    expect(runState("cancelled", "idle", "agentic")).toMatchObject({ label: "Cancelled", tone: "muted", live: false });
    expect(runState("input_required", "waiting", "agentic")).toMatchObject({ label: "Input required", tone: "warning", needsYou: true });
    expect(runState("input_required", "idle", "agentic")).toMatchObject({ label: "Stopped", tone: "warning", needsYou: true });
  });

  it("reads working with no live turn as working: the server relaunches it on its own", () => {
    expect(runState("working", "idle", "agentic")).toMatchObject({ label: "Working", tone: "active", live: true, needsYou: false });
  });

  it("stops only an agentic run with a live turn", () => {
    expect(runState("working", "working", "agentic").canStop).toBe(true);
    expect(runState("working", "idle", "agentic").canStop).toBe(false);
    expect(runState("queued", "working", "agentic").canStop).toBe(false);
    expect(runState("working", "working", "workflow").canStop).toBe(false);
    expect(runState("input_required", "waiting", "agentic").canStop).toBe(false);
  });

  it("cancels any run that is not final, of either kind", () => {
    expect(runState("working", "working", "workflow")).toMatchObject({ canCancel: true, final: false });
    expect(runState("input_required", "idle", "agentic")).toMatchObject({ canCancel: true, final: false });
    for (const done of ["completed", "failed", "cancelled"] as const) {
      expect(runState(done, "idle", "agentic")).toMatchObject({ canCancel: false, final: true });
    }
  });

  it("offers the mode serve's contract table names for each status and state", () => {
    expect(runState("working", "working", "agentic")).toMatchObject({ canMessage: true, messageMode: "steer" });
    expect(runState("queued", "working", "agentic")).toMatchObject({ canMessage: true, messageMode: "steer" });
    expect(runState("input_required", "waiting", "agentic")).toMatchObject({ canMessage: true, messageMode: "answer" });
    expect(runState("input_required", "idle", "agentic")).toMatchObject({ canMessage: true, messageMode: "follow_up" });
    expect(runState("working", "idle", "agentic")).toMatchObject({ canMessage: true, messageMode: "follow_up" });
    expect(runState("completed", "idle", "agentic")).toMatchObject({ canMessage: true, messageMode: "follow_up" });
    expect(runState("failed", "idle", "agentic").canMessage).toBe(false);
    expect(runState("cancelled", "idle", "agentic").canMessage).toBe(false);
  });

  it("hides a mode the server turned off in features.messages", () => {
    expect(view("working", "working", "agentic", { ...ON, steer: false }, true)).toMatchObject({ canMessage: false, messageMode: null });
    expect(view("input_required", "waiting", "agentic", { ...ON, answer: false }, true)).toMatchObject({ canMessage: false, messageMode: null });
    expect(view("completed", "idle", "agentic", { ...ON, follow_up: false }, true)).toMatchObject({ canMessage: false, messageMode: null });
  });

  it("steers a workflow run only where steer_workflow_runs is on, and never follows one up", () => {
    expect(runState("working", "working", "workflow")).toMatchObject({ canMessage: false, messageMode: null });
    expect(view("working", "working", "workflow", { ...ON, steer_workflow_runs: true }, true)).toMatchObject({ canMessage: true, messageMode: "steer" });
    expect(view("completed", "idle", "workflow", { ...ON, steer_workflow_runs: true }, true).canMessage).toBe(false);
  });

  it("on a harness that does not steer mid-turn (codex, Claude), a message to a working run is a follow_up, never a steer", () => {
    // serve answers steer only when the run's harness steers mid-turn; otherwise the message waits for the turn's end.
    expect(view("working", "working", "agentic", ON, false)).toMatchObject({ canMessage: true, messageMode: "follow_up" });
    expect(view("queued", "working", "agentic", ON, false)).toMatchObject({ canMessage: true, messageMode: "follow_up" });
    expect(view("working", "working", "agentic", { ...ON, follow_up: false }, false)).toMatchObject({ canMessage: false, messageMode: null });
    expect(view("input_required", "waiting", "agentic", ON, false).messageMode).toBe("answer");
  });
});

describe("live", () => {
  it("a run that waits for a person is not live: the server is not moving it", () => {
    expect(view("input_required", "waiting", "agentic", ON, true)).toMatchObject({ live: false, needsYou: true });
    expect(view("input_required", "idle", "agentic", ON, true)).toMatchObject({ live: false, needsYou: true });
  });
});

describe("harnessSteers", () => {
  it("is the server's own word when capabilities say (harnesses[].steer), and pi alone otherwise", () => {
    const caps = [{ id: "pi", available: true, steer: true }, { id: "codex", available: true, steer: false }, { id: "claude-agent", available: true }];
    expect(harnessSteers("codex", caps)).toBe(false);
    expect(harnessSteers("pi", caps)).toBe(true);
    expect(harnessSteers("claude-agent", caps)).toBe(false);
    expect(harnessSteers(undefined, caps)).toBe(true);
    expect(harnessSteers("codex", [{ id: "codex", available: true, steer: true }])).toBe(true);
  });
});
