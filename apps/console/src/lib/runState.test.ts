import { describe, expect, it } from "vitest";
import { runState } from "./runState";

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

  it("messages an agentic run that is open or completed (a steer, an answer or a follow-up), never a workflow run", () => {
    expect(runState("working", "working", "agentic")).toMatchObject({ canMessage: true, messageMode: "steer" });
    expect(runState("queued", "working", "agentic")).toMatchObject({ canMessage: true, messageMode: "steer" });
    expect(runState("input_required", "waiting", "agentic")).toMatchObject({ canMessage: true, messageMode: "answer" });
    expect(runState("input_required", "idle", "agentic")).toMatchObject({ canMessage: true, messageMode: "follow_up" });
    expect(runState("completed", "idle", "agentic")).toMatchObject({ canMessage: true, messageMode: "follow_up" });
    expect(runState("failed", "idle", "agentic").canMessage).toBe(false);
    expect(runState("cancelled", "idle", "agentic").canMessage).toBe(false);
    expect(runState("working", "working", "workflow").canMessage).toBe(false);
    expect(runState("completed", "idle", "workflow").canMessage).toBe(false);
  });
});
