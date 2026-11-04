// AgentRun's own (not copied): how a process harness settles a turn its session left open.
import { abortedOutcome, type Drive, pendingSubmissions, SessionHalt } from "../kernel/index.js";
import { NativeJournal } from "./journal.js";

/**
 * Records the session's open turn as ended in its transcript, the record a turn that ends writes (so `openTurn` finds
 * none, and the next turn carries no recovery note for it), and runs nothing. Input the turn never placed (a stop that
 * landed before the harness took its prompt) is withdrawn first, as the kernel's follow-up settle does, so no later open
 * finds it pending, and the next message is sent alone. It is the write behind
 * `AdapterSession.settleOpenTurn()` for a turn the person stopped, which is never resumed. The adapter checks that a
 * turn is open. The end is the kernel's for the session's own stop (`abortedOutcome` of its `SessionHalt`), the one
 * path an interrupted turn's end takes, though the turn never ran in this process.
 */
export async function settleTurn(drive: Drive): Promise<void> {
  for (const submission of pendingSubmissions(drive.state())) await drive.submit({ id: `withdraw:${submission.id}`, kind: "withdraw", target: submission.id });
  const { status, error } = abortedOutcome(AbortSignal.abort(new SessionHalt("interrupted")));
  const journal = new NativeJournal(drive);
  journal.message({ type: "turn", status, ...(error === undefined ? {} : { error }) });
  await journal.flush();
}
