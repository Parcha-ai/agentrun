// "Loaded in your browser" is not said until the header says the agent is home: the tab loads the model as soon as it is on the disk, which can be while the agent is still on its
// way back. The load waits here. A failure, or a newer load, replaces what is waiting, so an early load can never overwrite a later failure. Pure.
import type { ModelEvent } from "../episode2/notes.ts";

export type Held = { m: ModelEvent; scripted: boolean };

export class LoadGate {
  private held: Held | null = null;

  /** What to apply now for an incoming model message: itself, or nothing (a load that has to wait for the agent to be home). */
  offer(m: ModelEvent, scripted: boolean, home: boolean): Held | null {
    if (m.type === "model-loaded" && !home) {
      this.held = { m, scripted };
      return null;
    }
    // A failure, or a load that can be said now, ends the wait: whatever was held is older than this and must not come back after it.
    if (m.type === "model-failed" || m.type === "model-loaded") this.held = null;
    return { m, scripted };
  }

  /** The agent is home: the held load, once. */
  release(home: boolean): Held | null {
    if (!home || this.held === null) return null;
    const h = this.held;
    this.held = null;
    return h;
  }

  reset(): void {
    this.held = null;
  }
}
