// AgentRun's own (not copied): how a process harness settles a turn its session left open.
import type { DriveContext } from "../kernel/index.js";
import { NativeJournal } from "./journal.js";

/**
 * Records the session's open turn as ended, interrupted, in its transcript, the record a turn that ends writes (so
 * `openTurn` finds none, and the next turn carries no recovery note for it), and runs nothing. It is the write behind
 * `AdapterSession.settleOpenTurn()` for a turn the person stopped, which is never resumed. The adapter checks that a
 * turn is open; the turn's outcome in this process is still the kernel's (`abortedOutcome`).
 */
export async function settleTurn(drive: DriveContext): Promise<void> {
  const journal = new NativeJournal(drive);
  journal.message({ type: "turn", status: "interrupted" });
  await journal.flush();
}
