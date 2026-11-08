// The write half of the run's server cut (design 2.1, "the runner takes every run"): the functions the v2 routes call to
// start a run and to act on one (message, stop, raise, approve, archive), over the one store (A). The old per-run-process
// model (runs.ts: a child process, an HTTP door, serve.json, carry-back) is gone; the server only writes rows. A start is an
// INSERT of a queued run plus its launch body (run-launch.ts), which a runner reads at its claim; every other act is a
// command row (runner/commands.ts: stop, steer, approve, deny, raise), which the run's runner reads and applies. The
// acceptance checks and the words a refusal answers with are the old runs.ts ones, kept verbatim; only where the behaviour
// lived moves (to the runner), not what a person or a model sees.
//
// A run's live moment — whether it is working, waiting on a person, paused at its cap, which tool call waits for approval —
// is the run view's to read from the journal (the server's view layer, run-view.ts). These writers take it as `RunMoment`
// and never recompute it; the coarse facts a row already holds (its state, its launch cap) they read from the store.
import { randomBytes } from "node:crypto";
import { CAP_TOLERANCE, money } from "./cap.js";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { sendCommand } from "./runner/commands.js";
import { RunFinal, type Store } from "./store/index.js";

/** The store slice these writers need: the run rows, its commands, and the origin read a retry makes. */
export type RunsStore = Pick<Store, "runs" | "command" | "commands" | "runOfOrigin">;

/** How a tool call's approval was answered, as the run view folds the journal and the command rows: a person's allow or
 *  deny, a withdrawal when the run was stopped, or a cancel with the run. Its words are this module's (the refusal). */
export type ApprovalDecision = "allow" | "deny" | "withdrawn" | "canceled";

/** A run's live moment, as the run view computes it (statusOf and the predicates in the old runs.ts), for the one acceptance
 *  decision each act makes. A writer reads nothing else of the run's live state; the facts a row holds (its state, its
 *  launch cap) it reads from the store itself. */
export interface RunMoment {
  readonly id: string;
  readonly agentId: string;
  readonly kind: "agentic" | "workflow";
  /** Where an imported run came from (run.imported?.source); absent for a run started here. An imported run takes no act. */
  readonly importedSource?: string;
  /** A cancel is in flight (run.cancel), whether or not its end is written yet. */
  readonly cancelled: boolean;
  /** The run has reached a last state (statusOf: completed, failed or cancelled). */
  readonly terminal: boolean;
  /** Which last state, for the refusal's words (completed, failed or cancelled). */
  readonly terminalKind?: "completed" | "failed" | "cancelled";
  /** The message "working" predicate: the run's turn is in flight (queued, working-working, or its agent waits on the
   *  person in its browser), so a message steers it or follows it, never answers. */
  readonly working: boolean;
  /** The run waits on a person's answer to a question it asked (input_required and waiting on ask_person): a message
   *  answers it. */
  readonly awaitingAnswer: boolean;
  /** The run's harness takes a message mid-turn (pi and every workflow run): else a message to a working run follows the
   *  turn as a new one (follow_up), never a steer it cannot do. */
  readonly steers: boolean;
  /** The run's cap as it stands now (its launch cap folded with any raise rows), or undefined when it is uncapped. */
  readonly maxCostUsd?: number;
  /** The run is paused at its cap: a message is refused for the same room (raise the cap first). The pause's words, which
   *  the refusal carries, or undefined when it is not paused. */
  readonly pausedWords?: string;
  /** The run is paused at its cap (pausedAt): raising the cap resumes it. */
  readonly paused: boolean;
  /** The run has a live process now (a runner holds its claim): a raise's cap holds from its next process, not this one. */
  readonly live: boolean;
  /** A message that may not answer a person (a trigger's) is refused while the run waits on one, before anything else. */
  readonly waitsOnPerson: boolean;
  /** The tool call that waits for approval now, if any (waitingApproval): a person's message declines it. */
  readonly waitingApprovalId?: string;
  /** The tool calls this run has or had waiting for approval, by id (for the not-found refusal). */
  readonly approvalIds?: ReadonlySet<string>;
  /** The approvals already answered, by call id, as the run view folds them (for the first-wins refusal and its words). */
  readonly answeredApprovals?: Readonly<Record<string, { readonly decision: ApprovalDecision }>>;
}

/** Why a message that may not answer a person's question is not sent (runs.ts WAITS_ON_A_PERSON). */
export const WAITS_ON_A_PERSON = "The run is waiting on a person.";

/** A run that may not take this act because it waits on a person (runs.ts waitingRefusal). */
const waitingRefusal = (): ApiError => new ApiError("not_continuable", WAITS_ON_A_PERSON, { details: { reason: "waiting" } });

/** An imported run takes no message: it is history, not run here (runs.ts importedRefusal). */
function importedRefusal(moment: RunMoment): ApiError {
  const source = moment.importedSource;
  return new ApiError("not_continuable", `This run was imported from ${source}: it is history, not run here, so it takes no message. Start a new run of the agent.`, {
    details: { reason: "imported", imported_from: source },
    next_action: { type: "request", method: "POST", path: `/agents/${moment.agentId}/runs`, caller_supplies: ["input", "Idempotency-Key"] },
  });
}

/** A run that has ended takes no further act: start a new run (runs.ts finished). */
function finished(moment: RunMoment): ApiError {
  const status = moment.cancelled ? "cancelled" : moment.terminalKind;
  const why = status === "completed" ? "This run is finished." : `This run ${status === "failed" ? "failed" : "was cancelled"}.`;
  return new ApiError("not_continuable", `${why} Start a new run of the agent.`, {
    next_action: { type: "request", method: "POST", path: `/agents/${moment.agentId}/runs`, caller_supplies: ["input", "Idempotency-Key"] },
  });
}

/** A new message id, as runs.ts minted one for a message with no caller id. */
const newMessageId = (): string => `m${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/** Archives the run, or unarchives it (store.runs.archive): the run's own archive time, idempotent. Replaces the old
 *  agents.setArchived("run", …) and the run sweep it triggered (the runner reads an archived run's rows, no sweep needed). */
export async function archiveRun(store: RunsStore, runId: string, archived: boolean): Promise<void> {
  await store.runs.archive(runId, archived);
}

/** Stops the run: one stop command row, which the run's runner reads and applies (it aborts the turn in flight, withdraws a
 *  tool call waiting for approval, and ends the run stopped). A stop always lands — one command, no second path. An imported
 *  or already-ended run has none to stop: `false`, nothing written (store.command refuses a final run, RunFinal). */
export async function stop(store: RunsStore, runId: string): Promise<boolean> {
  const row = await store.runs.get(runId);
  if (!row || row.importedFrom) return false;
  try {
    await sendCommand(store, runId, { kind: "stop", body: {} });
    return true;
  } catch (error) {
    if (error instanceof RunFinal) return false;
    throw error;
  }
}

/** The mode a message takes, as the old contract's table named it: a steer into the turn in flight, an answer to a question
 *  the run asked, or a follow-up turn of its own. The runner delivers a steer command as the right one from the run's state;
 *  this is the label the v2 answer reports. */
export type MessageMode = "steer" | "answer" | "follow_up";

/** One message to an agentic run: a command row the run's runner reads and delivers. A person's message that declines a tool
 *  call waiting for approval is a deny with the person's words as the reason (as runs.ts declineBy did); every other message
 *  is a steer, which the runner places into the turn in flight, answers a question with, or runs as a follow-up turn, by the
 *  run's state. `answers: false` is a trigger's message, which never answers a person: refused while the run waits on one,
 *  and never a deny of an approval. The mode is the label the v2 answer reports, from the run's moment. */
export async function message(
  store: RunsStore,
  moment: RunMoment,
  content: string,
  { requestId, answers = true, origin }: { requestId?: string; answers?: boolean; origin?: unknown } = {},
): Promise<{ mode: MessageMode; messageId: string }> {
  if (moment.importedSource !== undefined) throw importedRefusal(moment);
  // A cancelled run takes no message, whether or not its end is written yet.
  if (moment.cancelled) throw finished(moment);
  // A message that may not answer a person (a trigger's) is refused while the run waits on one, before anything else, as the
  // old door refused it (WAITING): it never declines a parked approval, nor answers a question or a cap's pause.
  if (!answers && moment.waitsOnPerson) throw waitingRefusal();
  // A person's message while a tool call waits for approval declines it, with the message as the reason: a deny the run's
  // gate acts on as any deny, resuming the session with the refusal and the person's words in one turn. A trigger's never
  // does (answers false, refused above).
  if (answers && moment.kind === "agentic" && moment.waitingApprovalId !== undefined) {
    const messageId = newMessageId();
    await sendCommand(store, moment.id, { kind: "deny", body: { approval: moment.waitingApprovalId, note: content } });
    return { mode: "answer", messageId };
  }
  if (moment.terminal) throw finished(moment);
  // Paused at its cap: a message would be refused for the same room, so the cap is raised first.
  if (moment.pausedWords !== undefined) {
    throw new ApiError("budget_reached", `The run is paused at its ${money(moment.maxCostUsd ?? 0)} cap: raise the cap first. ${moment.pausedWords}`, { details: { cap_usd: moment.maxCostUsd ?? null } });
  }
  const mode: MessageMode = moment.working ? (moment.steers ? "steer" : "follow_up") : moment.awaitingAnswer ? "answer" : "follow_up";
  // A message that may not answer (a trigger's): one that would is refused here, past every wait, before it is sent.
  if (mode === "answer" && !answers) throw waitingRefusal();
  const messageId = requestId ?? newMessageId();
  const body: Record<string, unknown> = { text: content, ...(answers ? {} : { answers: false }), ...(origin !== undefined ? { origin } : {}) };
  await sendCommand(store, moment.id, { kind: "steer", body });
  return { mode, messageId };
}

/** The raise command rows this run already has, newest last, with the cap each names. */
async function raiseRows(store: RunsStore, runId: string): Promise<number[]> {
  return (await store.commands(runId, 0)).filter((c) => c.kind === "raise").map((c) => Number((c.body as { capUsd?: unknown })?.capUsd)).filter((n) => Number.isFinite(n));
}

/** Raises the cap of an agentic or workflow run that names one, to `cap`: above its own (by more than CAP_TOLERANCE), or the
 *  same as its newest raise (a retry, which changes nothing). A raise command row the run's runner reads: it resumes a run
 *  paused at its cap and sends its continuation, or (for a run working now) holds the raised cap from the run's next
 *  process, as the old path did. The answer reports whether the run resumed; the runner owns the resume itself. */
export async function raiseCap(store: RunsStore, moment: RunMoment, cap: number): Promise<{ resumed: boolean; messageId?: string; note?: string }> {
  if (moment.importedSource !== undefined) throw importedRefusal(moment);
  if (moment.cancelled || moment.terminal) throw finished(moment);
  const from = moment.maxCostUsd;
  if (from === undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "This run has no cap to raise: a cap is named when a run starts." }]);
  const raises = await raiseRows(store, moment.id);
  const last = raises.at(-1);
  // The same raise again (a retry): what the first one did stands, no second row.
  if (Math.abs(cap - from) <= CAP_TOLERANCE && last !== undefined && Math.abs(last - cap) <= CAP_TOLERANCE) {
    return moment.paused ? { resumed: true } : { resumed: false };
  }
  if (!(cap > from + CAP_TOLERANCE)) throw invalid([{ field: "max_cost_usd", reason: "invalid", message: `A cap is only raised: name more than the run's ${money(from)}.` }]);
  await sendCommand(store, moment.id, { kind: "raise", body: { capUsd: cap } });
  // A run paused at its cap is brought back by the raise (its runner claims it and sends its continuation); a run working
  // now keeps the cap its process was opened with until its next one.
  if (moment.paused) return { resumed: true };
  return { resumed: false, ...(moment.live ? { note: `The run's process keeps the ${money(from)} cap it was opened with; the ${money(cap)} cap holds from its next process.` } : {}) };
}

/** The refusal for a tool call already answered, in the old runs.ts words, by how it was answered. */
function alreadyAnswered(id: string, decision: ApprovalDecision): ApiError {
  const how = decision === "canceled" ? "canceled with its run" : decision === "withdrawn" ? "withdrawn when its run was stopped" : `answered: ${decision}`;
  return new ApiError("not_continuable", `The tool call ${id} was already ${how}.`, { details: { reason: "already_answered", decision } });
}

/** A person's answer to the tool call `id` that waits for approval (tool-gate.ts): an approve or deny command row the run's
 *  runner reads and acts on. The first answer wins — the same one again changes nothing, another is 409 already-answered —
 *  and a run with no such waiting call is 404. The note is the person's words, carried on the command for the run's gate. */
export async function approve(store: RunsStore, moment: RunMoment, id: string, decision: "allow" | "deny", note?: string): Promise<void> {
  const given = moment.answeredApprovals?.[id];
  if (!given && !(moment.approvalIds?.has(id) ?? false)) throw new ApiError("not_found", `The run ${moment.id} has no tool call ${id} waiting for approval.`);
  if (given) {
    if (given.decision === decision) return;
    throw alreadyAnswered(id, given.decision);
  }
  const body: Record<string, unknown> = { approval: id, ...(note !== undefined ? { note } : {}) };
  await sendCommand(store, moment.id, { kind: decision === "allow" ? "approve" : "deny", body });
}

/** For tests and the switch: the issue list an input refusal carries. */
export type { InputIssue };
