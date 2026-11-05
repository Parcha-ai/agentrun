// AgentRun's own (not copied): how a process harness settles a turn its session left open.
import { abortedOutcome, type Drive, type DriveContext, pendingSubmissions, SessionHalt, type SessionState } from "../kernel/index.js";
import { NativeJournal } from "./journal.js";

/** How a settle treats the open turn's prompts beyond those still pending. */
export interface SettleOptions {
  /** Placed prompts and follow-ups the harness never sent its CLI (no send mark): carried, as a pending one is. */
  readonly unsent?: readonly string[];
  /** The submission of a host's own prompt (a follow-up's, `FollowUpTarget.settleOpenTurn`'s `opening`): withdrawn
   *  while pending, never carried, and the only one withdrawn. */
  readonly host?: string;
}

/** The kernel effect a harness writes for a prompt just before it hands it to its CLI, by the id the CLI knows it by
 *  (Codex's clientUserMessageId, Claude's message uuid). Durable before the send: a crash between the two reads
 *  "marked, maybe sent", so the prompt is never carried and never sent twice. A halted drive writes none (it rejects),
 *  and its harness sends nothing. */
export async function markSent(ctx: Pick<DriveContext, "effect">, id: string): Promise<void> {
  await ctx.effect(`${SENT_PREFIX}${id}`, { name: "sent", replay: "safe", input: { id } }, async () => true);
}

const SENT_PREFIX = "sent:";

/** The ids `markSent` marked in `state`. */
export function sentMarks(state: SessionState): Set<string> {
  return new Set(state.effectOrder.filter((e) => e.name === "sent" && e.key.startsWith(SENT_PREFIX)).map((e) => e.key.slice(SENT_PREFIX.length)));
}

/**
 * Records the session's open turn as ended in its transcript, the record a turn that ends writes (so `openTurn` finds
 * none, and the next turn carries no recovery note for it), and runs nothing. Input the turn never placed (a stop that
 * landed before the harness took its prompt) is withdrawn first, so no later open finds it pending and nothing of it
 * runs on its own; a prompt or follow-up is withdrawn with `carry`, so its text stays in the conversation, carried into
 * the next one (the kernel's pendingSubmissions). A steer is not carried. So is a placed one its harness never sent
 * (`unsent`: the adapter reads its send marks), and a host's prompt (`host`) is dropped instead. It is the write behind
 * `AdapterSession.settleOpenTurn()` for a turn the person stopped, which is never resumed. The adapter checks that a
 * turn is open. The end is the kernel's for the session's own stop (`abortedOutcome` of its `SessionHalt`), the one
 * path an interrupted turn's end takes, though the turn never ran in this process.
 */
export async function settleTurn(drive: Drive, options: SettleOptions = {}): Promise<void> {
  const state = drive.state();
  // A placed prompt or follow-up its CLI was never sent (no send mark: the stop landed between its placement and its
  // send) is carried too, first, as it came first. It stays placed, so nothing sends it on its own. A host's is not.
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
