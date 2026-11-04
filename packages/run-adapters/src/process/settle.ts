// AgentRun's own (not copied): how a process harness settles a turn its session left open.
import { abortedOutcome, type DriveContext, SessionHalt } from "../kernel/index.js";
import { NativeJournal } from "./journal.js";

/**
 * Records the session's open turn as ended in its transcript, the record a turn that ends writes (so `openTurn` finds
 * none, and the next turn carries no recovery note for it), and runs nothing. It is the write behind
 * `AdapterSession.settleOpenTurn()` for a turn the person stopped, which is never resumed. The adapter checks that a
 * turn is open. The end is the kernel's for the session's own stop (`abortedOutcome` of its `SessionHalt`), the one
 * path an interrupted turn's end takes, though the turn never ran in this process.
 */
export async function settleTurn(drive: DriveContext): Promise<void> {
  const { status, error } = abortedOutcome(AbortSignal.abort(new SessionHalt("interrupted")));
  const journal = new NativeJournal(drive);
  journal.message({ type: "turn", status, ...(error === undefined ? {} : { error }) });
  await journal.flush();
}
