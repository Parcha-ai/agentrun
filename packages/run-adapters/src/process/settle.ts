// AgentRun's own (not copied): how a process harness settles a turn its session left open.
import { abortedOutcome, type Drive, pendingSubmissions, SessionHalt } from "../kernel/index.js";
import { NativeJournal } from "./journal.js";

/** How a settle treats the open turn's prompts beyond those still pending. */
export interface SettleOptions {
  /** Placed prompts and follow-ups the harness's CLI never recorded (its own record, as the session keeps it): carried,
   *  as a pending one is. */
  readonly unsent?: readonly string[];
  /** The submission of a host's own prompt (a follow-up's, `FollowUpTarget.settleOpenTurn`'s `opening`): withdrawn
   *  while pending, never carried, and the only one withdrawn. */
  readonly host?: string;
}

/**
 * Records the session's open turn as ended in its transcript, the record a turn that ends writes (so `openTurn` finds
 * none, and the next turn carries no recovery note for it), and runs nothing. Input the turn never placed (a stop that
 * landed before the harness took its prompt) is withdrawn first, so no later open finds it pending and nothing of it
 * runs on its own; a prompt or follow-up is withdrawn with `carry`, so its text stays in the conversation, carried into
 * the next one (the kernel's pendingSubmissions). A steer is not carried. So is a placed one its harness never sent
 * (`unsent`: the adapter reads its CLI's own record), and a host's prompt (`host`) is dropped instead. It is the write behind
 * `AdapterSession.settleOpenTurn()` for a turn the person stopped, which is never resumed. The adapter checks that a
 * turn is open. The end is the kernel's for the session's own stop (`abortedOutcome` of its `SessionHalt`), the one
 * path an interrupted turn's end takes, though the turn never ran in this process.
 */
export async function settleTurn(drive: Drive, options: SettleOptions = {}): Promise<void> {
  const state = drive.state();
  // A placed prompt or follow-up its CLI never recorded (the stop landed between its placement and the CLI's record of
  // it) is carried too, first, as it came first. It stays placed, so nothing sends it on its own. A host's is not.
  for (const id of options.unsent ?? []) {
    const submission = state.submissions.find((s) => s.id === id);
    if (id === options.host || !state.placed.has(id) || (submission?.kind !== "prompt" && submission?.kind !== "followUp")) continue;
    await drive.submit({ id: `withdraw:${id}`, kind: "withdraw", target: id, carry: true, unsent: true });
  }
  // A follow-up's settle names its own prompt (`host`): that one is withdrawn and never carried, and the rest is left
  // as it is (kernel/follow-up.ts). A person's stop withdraws every prompt pending.
  const pending = pendingSubmissions(drive.state()).filter((s) => options.host === undefined || s.id === options.host);
  for (const submission of pending) {
    // A prompt or follow-up the person stopped stays in the conversation: its text is carried into the next one
    // (pendingSubmissions). A stopped steer is dropped, and so is a host's prompt: one that never ran is not sent.
    const carry = submission.kind !== "steer" && submission.id !== options.host;
    await drive.submit({ id: `withdraw:${submission.id}`, kind: "withdraw", target: submission.id, ...(carry ? { carry: true as const } : {}) });
  }
  const { status, error } = abortedOutcome(AbortSignal.abort(new SessionHalt("interrupted")));
  const journal = new NativeJournal(drive);
  journal.message({ type: "turn", status, ...(error === undefined ? {} : { error }) });
  await journal.flush();
}
