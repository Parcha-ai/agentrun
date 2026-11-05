// AgentRun's own (not copied): how a process harness settles a turn its session left open.
import { abortedOutcome, type Drive, pendingSubmissions, SessionHalt } from "../kernel/index.js";
import { NativeJournal } from "./journal.js";

/**
 * Records the session's open turn as ended in its transcript, the record a turn that ends writes (so `openTurn` finds
 * none, and the next turn carries no recovery note for it), and runs nothing. Input the turn never placed (a stop that
 * landed before the harness took its prompt) is withdrawn first, so no later open finds it pending and nothing of it
 * runs on its own; a prompt or follow-up is withdrawn with `carry`, so its text stays in the conversation, carried into
 * the next one (the kernel's pendingSubmissions). A steer is not carried. It is the write behind
 * `AdapterSession.settleOpenTurn()` for a turn the person stopped, which is never resumed. The adapter checks that a
 * turn is open. The end is the kernel's for the session's own stop (`abortedOutcome` of its `SessionHalt`), the one
 * path an interrupted turn's end takes, though the turn never ran in this process.
 */
export async function settleTurn(drive: Drive): Promise<void> {
  for (const submission of pendingSubmissions(drive.state())) {
    // A prompt or follow-up the person stopped stays in the conversation: its text is carried into the next one
    // (pendingSubmissions). A stopped steer is dropped.
    await drive.submit({ id: `withdraw:${submission.id}`, kind: "withdraw", target: submission.id, ...(submission.kind === "steer" ? {} : { carry: true as const }) });
  }
  const { status, error } = abortedOutcome(AbortSignal.abort(new SessionHalt("interrupted")));
  const journal = new NativeJournal(drive);
  journal.message({ type: "turn", status, ...(error === undefined ? {} : { error }) });
  await journal.flush();
}
