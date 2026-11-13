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
import type { Revision } from "./agent-rows.js";
import type { MessageOrigin } from "./timeline/index.js";
import { type AgentEntry, type ExternalRef, externalKey, getAgent } from "./agents-store.js";
import { CAP_TOLERANCE, money } from "./cap.js";
import { ApiError, type InputIssue, invalid, unsupported } from "./errors.js";
import { harnessOfBody } from "./harness.js";
import { redacted, redactedOutput } from "./key-refusal.js";
import { chooseWorkflows, LEARNING_BUDGET, learnedParts, type LearningMode, learnsOf, type NoteUsed, type Seed, type Shown } from "./learning.js";
import { thinkingLevel } from "./model.js";
import { type Place, resolvePlace } from "./place.js";
import { type LaunchDisk, launchBody, type RunLaunch, type SeedFailed } from "./run-launch.js";
import { type ApprovalDecision, raiseFollowUpId, type RunMoment } from "./run-view.js";
import { sendCommand } from "./runner/commands.js";
import { AnswerTaken, ExternalBodyConflict, type NewRevision, RunFinal, type RunOrigin, type RunRow, type Store, StoreConstraint } from "./store/index.js";
import { toolingOf } from "./tools.js";
import { type Plane, planeFor, type ToolSettingsMap } from "./tool-plane.js";
import type { RunTrigger } from "./triggers.js";
import { clip } from "./web-fetch-direct.js";
import { isObject, type Json } from "./validate.js";

/** The store slice these writers need: the run rows, its commands, and the origin read a retry makes. */
export type RunsStore = Pick<Store, "runs" | "command" | "commands" | "runOfOrigin">;

/** The run view (run-view.ts) owns a run's live moment and how an approval was answered (statusOf and the predicates it
 *  folds from the journal). The write half reads the moment and never recomputes it; both types are re-exported here so the
 *  writers and their callers (trigger-targets.ts) import them from one place. */
export type { ApprovalDecision, RunMoment };

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

/** An archived run, or a run of an archived agent, takes no message: archiving closes it. Said as archived, never as
 *  finished, with the way back: unarchive it (or its agent), or start a new run. */
function archivedRefusal(moment: RunMoment): ApiError {
  const own = moment.archived === "run";
  const why = own ? "This run is archived" : "This run's agent is archived";
  const back = own ? `unarchive it (POST /runs/${moment.id}/unarchive)` : `unarchive the agent (POST /agents/${moment.agentId}/unarchive)`;
  return new ApiError("not_continuable", `${why}, so it takes no message: ${back} to go on, or start a new run of the agent.`, {
    details: { reason: "archived", archived: moment.archived },
    next_action: own
      ? { type: "request", method: "POST", path: `/runs/${moment.id}/unarchive`, caller_supplies: [] }
      : { type: "request", method: "POST", path: `/agents/${moment.agentId}/unarchive`, caller_supplies: [] },
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

/** Cancels the run: one cancel command row, which the run's runner reads and applies (it ends the run cancelled, aborting
 *  the turn in flight and cancelling a tool call waiting for approval). Returns whether a cancel was requested — the old
 *  cancel's checks and their result, verbatim: an imported run, or one already ended or ending, has none to cancel (false,
 *  nothing written). A run's first end is its last, so a cancel that races the end is the runner's to drop. */
export async function cancel(store: RunsStore, moment: RunMoment): Promise<boolean> {
  if (moment.importedSource !== undefined) return false;
  // Already ended, or already ending (an outcome being written, or a cancel in flight): a run's first end is its last.
  if (moment.terminal || moment.cancelled) return false;
  try {
    await sendCommand(store, moment.id, { kind: "cancel", body: {} });
    return true;
  } catch (error) {
    if (error instanceof RunFinal) return false;
    throw error;
  }
}

/** Pauses a workflow run, or resumes it (pauseRun/resumeRun): a pause or resume command the run's runner reads and applies.
 *  Verbatim from runs.ts pause: an agentic run has no pause here (501, a turn is stopped instead), an ended or cancelling one
 *  takes none (409). Returns the run id and whether it is paused; the route adds the run's status from its view. The runner
 *  acks the command in an agentrun.pause or agentrun.resume entry's commit (runner/commands.ts COMMAND_KINDS). */
async function pauseOrResume(store: RunsStore, moment: RunMoment, paused: boolean): Promise<{ run_id: string; paused: boolean }> {
  if (moment.kind !== "workflow") throw unsupported("runs.pause", "Only a workflow run pauses here: an agentic run's turn is stopped with POST /runs/{id}/stop.");
  if (moment.terminal || moment.cancelled) throw finished(moment);
  await sendCommand(store, moment.id, { kind: paused ? "pause" : "resume", body: {} });
  return { run_id: moment.id, paused };
}

/** Pauses a workflow run (pauseRun). */
export const pause = (store: RunsStore, moment: RunMoment): Promise<{ run_id: string; paused: boolean }> => pauseOrResume(store, moment, true);

/** Resumes a paused workflow run (resumeRun). */
export const resume = (store: RunsStore, moment: RunMoment): Promise<{ run_id: string; paused: boolean }> => pauseOrResume(store, moment, false);

/** The mode a message takes, as the old contract's table named it: a steer into the turn in flight, an answer to a question
 *  the run asked, or a follow-up turn of its own. The runner delivers a steer command as the right one from the run's state;
 *  this is the label the v2 answer reports. */
export type MessageMode = "steer" | "answer" | "follow_up";

/** One message to an agentic run: a command row the run's runner reads and delivers. A person's message that declines a tool
 *  call waiting for approval is a deny with the person's words as the reason (as runs.ts declineBy did); every other message
 *  is a steer, which the runner places into the turn in flight, answers a question with, or runs as a follow-up turn, by the
 *  run's state. `answers: false` is a trigger's message, which never answers a person: refused while the run waits on one,
 *  and never a deny of an approval. The mode is the label the v2 answer reports, from the run's moment. `queue`: the steer's
 *  write when it is not this run's own (a trigger's: its firing marked with it, within its bound, store.triggers.message),
 *  which may skip it, in words. */
export async function message(
  store: RunsStore,
  moment: RunMoment,
  content: string,
  { requestId, answers = true, origin, queue, launchSealed, beforeSubmit }: { requestId?: string; answers?: boolean; origin?: unknown; queue?: (command: SteerCommand) => Promise<{ skipped: string } | void>; launchSealed?: Uint8Array; beforeSubmit?: (runId: string, content: string) => Promise<void> | void } = {},
): Promise<{ mode: MessageMode; messageId: string; skipped?: string }> {
  if (moment.importedSource !== undefined) throw importedRefusal(moment);
  // Archiving closes a run: it, or a run of its archived agent, takes no message, said as archived (never as finished).
  if (moment.archived !== undefined) throw archivedRefusal(moment);
  // A cancelled run takes no message, whether or not its end is written yet.
  if (moment.cancelled) throw finished(moment);
  // A message that may not answer a person (a trigger's) is refused while the run waits on one, before anything else, as the
  // old door refused it (WAITING): it never declines a parked approval, nor answers a question or a cap's pause.
  if (!answers && moment.waitsOnPerson) throw waitingRefusal();
  // A person's message while a tool call waits for approval declines it, with the message as the reason: a deny the run's
  // gate acts on as any deny, resuming the session with the refusal and the person's words in one turn. A trigger's never
  // does (answers false, refused above). Marked as the person's message (`by`), so its approval reads "Declined by your
  // message", as main's declineBy kept it. A person's answer to that call written first (not taken yet) stands, and the store refuses this deny (one answer per
  // approval): the message is then a message like any other, below.
  if (answers && moment.kind === "agentic" && moment.waitingApprovalId !== undefined) {
    const messageId = newMessageId();
    const declined = await sendCommand(store, moment.id, { kind: "deny", body: { approval: moment.waitingApprovalId, note: content, by: "message" } }, launchSealed ? { launchSealed } : undefined).then(
      () => true,
      (error: unknown) => {
        if (error instanceof AnswerTaken) return false;
        throw error;
      },
    );
    if (declined) return { mode: "answer", messageId };
  }
  // A person's message puts no check of the run's end in front of its steer: the store's reopen alone says whether an ended
  // run opens again with it (steerOrReopen). A trigger's message to an ended run is refused here, as before.
  if (queue && moment.terminal) throw finished(moment);
  // Paused at its cap: a message would be refused for the same room, so the cap is raised first.
  if (moment.pausedWords !== undefined) {
    throw new ApiError("budget_reached", `The run is paused at its ${money(moment.maxCostUsd ?? 0)} cap: raise the cap first. ${moment.pausedWords}`, { details: { cap_usd: moment.maxCostUsd ?? null } });
  }
  const mode: MessageMode = moment.working ? (moment.steers ? "steer" : "follow_up") : moment.awaitingAnswer ? "answer" : "follow_up";
  // A message that may not answer (a trigger's): one that would is refused here, past every wait, before it is sent.
  if (mode === "answer" && !answers) throw waitingRefusal();
  const messageId = requestId ?? newMessageId();
  const body: Record<string, unknown> = { text: content, ...(answers ? {} : { answers: false }), ...(origin !== undefined ? { origin } : {}) };
  // A test's seam (ServeOptions.beforeSubmit): every check above read `moment`; the write below is the run's door.
  await beforeSubmit?.(moment.id, content);
  if (queue) {
    const queued = await queue({ kind: "steer", body });
    return { mode, messageId, ...(queued ? { skipped: queued.skipped } : {}) };
  }
  await steerOrReopen(store, moment, { kind: "steer", body }, launchSealed);
  return { mode, messageId };
}

/** A steer command row, as message() writes it. */
export type SteerCommand = { kind: "steer"; body: Record<string, unknown> };

/** The message's steer row: one door. A run the store holds final takes no new row (RunFinal); the message then goes
 *  through runs.reopen, which opens the run again with the steer in one transaction when the store says it may
 *  (reopenableWhere: an agentic run that completed, or that a person stopped, as the console offers a follow-up to both).
 *  Any other (cancelled, failed, a workflow's, an imported or a learning run) answers 409 finished, nothing written. */
async function steerOrReopen(store: RunsStore, moment: RunMoment, command: SteerCommand, launchSealed?: Uint8Array): Promise<void> {
  // The message's launch secrets (its mcp_auth, sealed) ride in the same write as its steer, whichever door takes it.
  const sealed = launchSealed ? { launchSealed } : undefined;
  try {
    await sendCommand(store, moment.id, command, sealed);
  } catch (error) {
    if (!(error instanceof RunFinal)) throw error;
    try {
      await store.runs.reopen(moment.id, command, sealed);
    } catch (again) {
      if (!(again instanceof RunFinal)) throw again;
      // Refused: another message may have opened the run again meanwhile, so the steer is sent once more, to the run now
      // running. Refused that too, the run takes no message.
      try {
        await sendCommand(store, moment.id, command, sealed);
      } catch (last) {
        if (!(last instanceof RunFinal)) throw last;
        // Worded by the run's end as the store holds it now: the moment may have been read before that end (a race).
        const state = (await store.runs.get(moment.id))?.state;
        const terminalKind = state === "failed" ? "failed" : state === "stopped" ? "cancelled" : "completed";
        throw finished({ ...moment, terminal: true, terminalKind });
      }
    }
  }
}

/** The raise command rows this run already has, newest last: the cap each names, and whether its runner has taken it. */
async function raiseRows(store: RunsStore, runId: string): Promise<{ capUsd: number; taken: boolean }[]> {
  return (await store.commands(runId, 0))
    .filter((c) => c.kind === "raise")
    .map((c) => ({ capUsd: Number((c.body as { capUsd?: unknown })?.capUsd), taken: c.takenAt !== null }))
    .filter((row) => Number.isFinite(row.capUsd));
}

/** Raises the cap of an agentic or workflow run that names one, to `cap`: above its own (by more than CAP_TOLERANCE), or the
 *  same as its newest raise (a retry, which changes nothing). A raise command row the run's runner reads: it resumes a run
 *  paused at its cap and sends its continuation, or (for a run working now) holds the raised cap from the run's next
 *  step. The answer reports whether the run resumed; the runner owns the resume itself. */
export async function raiseCap(store: RunsStore, moment: RunMoment, cap: number): Promise<{ resumed: boolean; messageId?: string; note?: string }> {
  if (moment.importedSource !== undefined) throw importedRefusal(moment);
  if (moment.cancelled || moment.terminal) throw finished(moment);
  const from = moment.maxCostUsd;
  if (from === undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "This run has no cap to raise: a cap is named when a run starts." }]);
  const raises = await raiseRows(store, moment.id);
  const last = raises.at(-1);
  // An agentic run paused at its cap goes on with one follow-up turn the runner sends under its pause's id
  // (raiseFollowUpId): the answer names it, so every raise of this pause (a retry, two sent at once) names the same message.
  // A workflow run sends none (the step that waits is judged again), so its answer names no message.
  const resumed = (): { resumed: true; messageId?: string } => ({ resumed: true, ...(moment.kind === "agentic" && moment.pause !== undefined ? { messageId: raiseFollowUpId(moment.pause) } : {}) });
  // The same raise again (a retry): what the first one did stands, no second row. It resumes the run only while that raise
  // is still on its way (its row untaken): once taken, a pause the run stands at now is a new one, under the raised cap,
  // which this retry does not raise (it answers resumed false, and the run stays paused).
  if (Math.abs(cap - from) <= CAP_TOLERANCE && last !== undefined && Math.abs(last.capUsd - cap) <= CAP_TOLERANCE) {
    return moment.paused && !last.taken ? resumed() : { resumed: false };
  }
  if (!(cap > from + CAP_TOLERANCE)) throw invalid([{ field: "max_cost_usd", reason: "invalid", message: `A cap is only raised: name more than the run's ${money(from)}.` }]);
  try {
    await sendCommand(store, moment.id, { kind: "raise", body: { capUsd: cap } });
  } catch (error) {
    // A run a person stopped reads waiting on its next message (its moment is not terminal), but its row takes no command
    // until a message reopens it: refused in words, nothing written. (Main took the raise and held it for the run's next
    // process; that waits for a stopped run's reopen here.)
    if (error instanceof RunFinal && (await store.runs.get(moment.id))?.state === "stopped") throw new ApiError("not_continuable", "This run was stopped: send it a message to go on, then raise its cap.");
    throw error;
  }
  // A run paused at its cap is brought back by the raise (its runner claims it and sends its continuation).
  if (moment.paused) return resumed();
  // A run its runner holds takes the raise as its next command: its next step is admitted under the raised cap (the
  // runner's loop holds the run to its newest raise), and a step already under way keeps the cap it was admitted at.
  return { resumed: false, ...(moment.live ? { note: `The ${money(cap)} cap holds from the run's next step; a step already under way keeps the ${money(from)} cap it was admitted at.` } : {}) };
}

/** The refusal for a tool call already answered, in the old runs.ts words, by how it was answered; a withdrawal by a run
 *  that ended (completed or failed, `ended`) says its run ended, never that it was stopped. */
function alreadyAnswered(id: string, decision: ApprovalDecision, ended = false): ApiError {
  const how = decision === "canceled" ? "canceled with its run" : decision === "withdrawn" ? (ended ? "withdrawn when its run ended" : "withdrawn when its run was stopped") : `answered: ${decision}`;
  return new ApiError("not_continuable", `The tool call ${id} was already ${how}.`, { details: { reason: "already_answered", decision } });
}

/** The answer to approval `id` of run `runId` already written as a command, taken by its runner or not: the first approve or
 *  deny naming it that the runner has not refused (the store keeps one, schema.ts COMMANDS_ONE_ANSWER). A refused one (its
 *  run could not resume) answers nothing, so the person may answer again. */
async function sentAnswer(store: RunsStore, runId: string, id: string): Promise<{ decision: "allow" | "deny"; at: number } | undefined> {
  const row = (await store.commands(runId, 0)).find((command) => (command.kind === "approve" || command.kind === "deny") && command.refused === null && isObject(command.body) && command.body.approval === id);
  return row && { decision: row.kind === "approve" ? "allow" : "deny", at: row.id };
}

/** How a stop or cancel written to run `runId` before `before` (a command id; absent, any) answers every call still waiting:
 *  the runner reads commands in the order they were written, so it applies the stop first and withdraws (or, on a cancel,
 *  cancels) the call, and refuses every answer written after it. An answer written then is told so at once, the same 409
 *  the call's withdrawal gives, never 204 for a call that will not run. Read by the rows' order, so a stop that lands
 *  between this read and the answer's write is caught once the answer is written (approve). Untaken rows only, unless
 *  `taken` (a run already final: the end its runner applied). */
async function endBefore(store: RunsStore, runId: string, { before = Number.POSITIVE_INFINITY, taken = false }: { before?: number; taken?: boolean } = {}): Promise<{ decision: "withdrawn" | "canceled" } | undefined> {
  // The first: the runner applies the first stop or cancel it reads and stops reading there.
  const row = (await store.commands(runId, 0)).find((command) => (command.kind === "stop" || command.kind === "cancel") && command.id < before && command.refused === null && (taken || command.takenAt === null));
  return row && { decision: row.kind === "cancel" ? "canceled" : "withdrawn" };
}

/** A person's answer to the tool call `id` that waits for approval (tool-gate.ts): an approve or deny command row the run's
 *  runner reads and acts on. The first answer wins from the moment it is written, before the runner takes it — the same one
 *  again changes nothing, another is 409 already-answered — and a run with no such waiting call is 404. Two answers at once
 *  each write or lose to the store's one-answer index, and the one that loses reads the one that won. The note is the
 *  person's words, carried on the command for the run's gate. */
export async function approve(store: RunsStore, moment: RunMoment, id: string, decision: "allow" | "deny", note?: string): Promise<void> {
  const settle = (given: { decision: ApprovalDecision; ended?: true }): void => {
    if (given.decision !== decision) throw alreadyAnswered(id, given.decision, given.ended === true);
  };
  const answered = moment.answeredApprovals?.[id];
  if (answered) return settle(answered);
  const given = await sentAnswer(store, moment.id, id);
  if (given) {
    // The answer written before (this one's retry, or another) sits behind a stop or cancel the runner has not taken yet:
    // it never runs, so it is told as any answer behind that stop is, never settled as taken.
    const behind = await endBefore(store, moment.id, { before: given.at });
    if (behind) throw alreadyAnswered(id, behind.decision);
    return settle(given);
  }
  if (!(moment.approvalIds?.has(id) ?? false)) throw new ApiError("not_found", `The run ${moment.id} has no tool call ${id} waiting for approval.`);
  const ending = await endBefore(store, moment.id);
  if (ending) throw alreadyAnswered(id, ending.decision);
  const body: Record<string, unknown> = { approval: id, ...(note !== undefined ? { note } : {}) };
  let sent: { id: number };
  try {
    sent = await sendCommand(store, moment.id, { kind: decision === "allow" ? "approve" : "deny", body });
  } catch (error) {
    // The run went final since it was read (its runner took a stop or a cancel, or it ended): its calls were answered by
    // that end, so the answer is told how, never a 500.
    if (error instanceof RunFinal) {
      const end = await endBefore(store, moment.id, { taken: true });
      throw alreadyAnswered(id, end?.decision ?? "withdrawn", end === undefined);
    }
    // Lost to an answer written first (the store's AnswerTaken, from its one-answer index alone): read the winner.
    const won = error instanceof AnswerTaken ? await sentAnswer(store, moment.id, id) : undefined;
    if (!won) throw error;
    return settle(won);
  }
  // A stop or cancel written between the read above and this answer comes first in the runner's order: the answer will be
  // refused at that end, so the person is told now.
  const raced = await endBefore(store, moment.id, { before: sent.id });
  if (raced) throw alreadyAnswered(id, raced.decision);
  // That stop's end may already be written by this read: its runner took the stop and refused this answer in the same
  // commit. Read the answer back: refused behind a stop or cancel, it never runs either.
  const mine = (await store.commands(moment.id, 0)).find((command) => command.id === sent.id);
  if (mine?.refused != null) {
    const end = await endBefore(store, moment.id, { before: sent.id, taken: true });
    if (end) throw alreadyAnswered(id, end.decision);
  }
}

// ---- start -----------------------------------------------------------------------------------------------------------

/** A UUIDv7 run id: time-ordered, so a listing by start time is stable, and unique per run. */
function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The revision's body fields a start reads: its default cap and cap mode, its place, and (agentic) its tools, for the
 *  place fallback. Read with the shapes the old start read them with. */
type StartBody = { readonly maxCostUsd?: number; readonly capMode?: string; readonly place?: unknown; readonly tools?: readonly unknown[]; readonly learning?: boolean | "notes"; readonly thinking?: unknown };

/** The pieces a start needs that live in the server's request layer, not here: the leaf validators (the create body's field
 *  issues, the revision a run pins, a run's input against its schema, the hint told from the revision, a revision this host
 *  cannot run), the uploads check, the place fallback, the title's redaction, the plane's settings and key environment, and
 *  the per-server run choices (approvers, documents, box reach). The switch wires the server's own to each; a start calls
 *  them in the old order, with the old words. */
export interface StartDeps {
  /** A new run id; defaults to a UUIDv7. */
  readonly newRunId?: () => string;
  /** The create body's field issues, before the agent is read (server.ts runBodyIssues). */
  runBodyIssues(body: Json): InputIssue[];
  /** The revision a run starts on (server.ts pinnedOf): the body's pin, else the agent's current; undefined when none. */
  pinnedOf(entry: AgentEntry, body: Json): Promise<{ revision: Revision; version: number } | undefined>;
  /** A run's input against its revision's input schema (server.ts inputIssuesOf). */
  inputIssuesOf(revision: Revision, input: Json): Promise<InputIssue[]>;
  /** The issues told from the revision they would start on, with its hints (server.ts explainRun). */
  explainRun(issues: InputIssue[], body: Json, revision: Revision | null | undefined): Promise<InputIssue[]>;
  /** Marks an input refusal as told from a revision (server.ts told). */
  told(error: ApiError): ApiError;
  /** Refuses a revision this host cannot run, by field (server.ts runnable). */
  runnable(revision: Revision, place: Place, options: { capped: boolean }): Promise<void>;
  /** The uploaded files named by file_ids, ready to copy; throws when one is not ready (server.ts uploads.readyFiles). The
   *  copy into the run's work/ is the runner's at its claim; this only checks they are ready before the run starts. */
  readyFiles(ids: readonly unknown[]): Promise<unknown>;
  /** Holds the run's files for it (uploads.ts Uploads.hold) before its row is written, so a file deleted after the start
   *  is still the run's at its claim; `release` lets go of a hold whose run was never written (or was another's). */
  readonly files?: { hold(runId: string, ids: readonly string[]): Promise<void>; release(runId: string): Promise<void> };
  /** Where a revision naming these tools and no place runs here (server.ts fallbackPlace). */
  fallbackPlace(kind: "agentic" | "workflow", tools: readonly unknown[]): Place;
  /** The Archil disk the run's launch record keeps (server.ts launchDiskOf): the one its body's `archil_disk` names, else
   *  its agent's when it has one now; undefined for neither, or in Mode 1. A disk named in Mode 1 is refused. Absent, no
   *  disk is kept. */
  launchDiskOf?(agentId: string, named: string | undefined): Promise<LaunchDisk | undefined>;
  /** A run's title from its input (server.ts workflowTitle), for a workflow run's title. */
  workflowTitle(name: string, input: Record<string, unknown>): string;
  /** Every secret this server never shows, for the title's redaction (server.ts serverSecrets). */
  serverSecrets(): string[];
  /** The server's tool settings, for the plane (runs.ts toolSettings). */
  toolSettings(): ToolSettingsMap;
  /** The environment the plane reads to pick each tool's provider: the server's keys as it holds them (runs.ts storedKeys
   *  merged into the environment). */
  planeEnv(): NodeJS.ProcessEnv;
  /** Whether anyone can answer a tool call's approval here (RunsOptions.approvers). */
  readonly approvers?: boolean;
  /** The documents directory a workflow's reads are rooted at, when the server gives one. */
  readonly documents?: string;
  /** What a run's box may reach, as the server resolved it, or "none". */
  readonly boxAllow?: readonly string[] | "none";
  /** The operator set that (run-launch.ts boxAllowSet). */
  readonly boxAllowSet?: true;
  /** The run's model, pinned at start: resolved exactly as the old per-run process resolved it from the revision and agent
   *  (app.ts's runModels / wireModels over revision.body.model on its harness). The runner reads launch.model alone, so one
   *  resolution happens, here. Required. */
  modelOf(entry: AgentEntry, revision: Revision): Promise<{ provider: string; modelId: string } | undefined>;
  /** The server's learning switch (learning.ts LearningMode): a run learns only when it is not "off" and its revision says
   *  so. Absent, no run learns. */
  readonly learning?: LearningMode;
  /** The agent's learning seed, read now (learning-run.ts seedFor): the learning commit a run starts from, or a reason it
   *  could not be read. Only read for a run that learns. */
  seedFor?(agentId: string): Promise<{ seed: Seed } | { failed: string }>;
  /** The learning budget in bytes (learning.ts LEARNING_BUDGET), for which notes fit a run's # Learned section. */
  readonly learningBudget?: number;
  /** The model the server names to grade what a run proposes (learning.ts gradeModelOf), put on each learning start; none,
   *  the agent's own grades it. */
  readonly gradeModel?: string;
  /** The host's secrets as they are shown now (learning-run.ts shown), for cutting the notes a run is given. */
  shown?(): Shown;
}

/** How a run is asked to start, beyond its create body: a trigger and its firing, an idempotency or firing origin, whether
 *  it must have a cap (a trigger's), and who its first message is from when the person did not write it. */
export interface StartOptions {
  readonly trigger?: RunTrigger;
  /** The run's launch secrets, sealed for its id once it has one (the create body's mcp_auth, server.ts). */
  readonly sealed?: (runId: string) => Uint8Array;
  /** The run's title when its starter names one (a trigger's: "<Source> <name>"), else it is made from its input. */
  readonly title?: string;
  readonly origin?: RunOrigin;
  readonly capped?: boolean;
  readonly from?: MessageOrigin;
}

/** A no-op redactor, when the server gives none: no secret is cut (the switch wires the real shown for a learning run). */
const noShown: Shown = { text: (text) => text, name: (name) => name, holds: () => false };

/** The run's learning start as the old start decided it (learning-run.ts onStart): undefined when the run does not learn (the
 *  server's learning off, a workflow revision, or its revision does not say learning), else the notes its # Learned section
 *  names and the # Learned text (learnedParts, the one decision the runner puts in the prompt), the seed sha it starts
 *  from and the count of all the seed's notes before the budget picked `given` (seedNotes) — or given empty, seed null and no
 *  seedNotes when its seed cannot be read (a learning fault never refuses a run). */
async function learningStartFor(deps: StartDeps, entry: AgentEntry, revision: Revision, rbody: StartBody, input: unknown): Promise<{ given: NoteUsed[]; seed: string | null; section: string; seedNotes?: number; skills?: string[]; workflows?: string[]; notesOnly?: true; gradeModel?: string; seedFailed?: SeedFailed } | undefined> {
  const learns = deps.learning !== undefined && deps.learning !== "off" && revision.kind === "agentic" && learnsOf(rbody.learning);
  // `learning: "notes"`: its notes and skills, never a learned workflow (none offered, none asked for at its end).
  const notesOnly = rbody.learning === "notes" ? { notesOnly: true as const } : {};
  if (!learns || !deps.seedFor) return undefined;
  const grade = deps.gradeModel ? { gradeModel: deps.gradeModel } : {};
  const seeded = await deps.seedFor(entry.agent.id);
  // The folder could not be read (main's STOPPED.unreadable), or what it read could not be made into the start (main's
  // copy that threw, STOPPED.notCopied): the run starts with nothing learned, and its learning end says which.
  if (!("seed" in seeded)) return { given: [], seed: null, section: "", seedFailed: "unreadable", ...notesOnly, ...grade };
  try {
    // The run's input goes to the note selector (learning.ts NoteSelector; byRelevance, the default, scores the notes by it).
    const options = { budget: deps.learningBudget ?? LEARNING_BUDGET, read: Array.isArray(rbody.tools) && rbody.tools.includes("read"), shown: deps.shown ? deps.shown() : noShown, run: { input } };
    // The notes and the # Learned text are the old start's one decision (learnedParts: one choice of the note selector), so
    // the runner lays exactly this section for exactly these notes and reads no learning folder. seedNotes is the whole
    // seed's note count, before the budget narrowed `given` (as the old seed_notes was).
    const { section, given } = learnedParts(seeded.seed, options);
    // The learned skills the seed offers the run, by name: each with its files (one over a run's skill budget at all is held
    // by its size and never laid) and no host secret in it, as chooseSkills leaves them out. The claim lays them; the
    // agent's impact counts the runs each served.
    const skills = (seeded.seed.skills ?? []).flatMap(({ name, files }) => (files && !options.shown.holds(name) && !Object.entries(files).some(([path, text]) => options.shown.holds(path) || options.shown.holds(text)) ? [name] : []));
    // The learned workflows its learned_workflow tool runs, by name, as the claim chooses them (chooseWorkflows): what the
    // agent's impact counts a run as started from, beside its notes and skills.
    const workflows = notesOnly.notesOnly ? [] : chooseWorkflows(seeded.seed, options.shown).flows.map(({ name }) => name);
    return { given: given.map(({ file, name }) => ({ file, name })), seed: seeded.seed.sha, section: section ?? "", seedNotes: Object.keys(seeded.seed.notes).length, ...(skills.length ? { skills } : {}), ...(workflows.length ? { workflows } : {}), ...notesOnly, ...grade };
  } catch {
    return { given: [], seed: null, section: "", seedFailed: "not_copied", ...notesOnly, ...grade };
  }
}

/** Starts a run of `entry`'s agent from a create body, as POST /agents/{id}/runs starts it: every check the old start made
 *  before a run started (prepareLaunch), then an INSERT — a queued run and its launch body in one transaction
 *  (store.runs.create), which a runner reads at its claim. No process, no door, no setup file: where the run runs is the
 *  runner's. Under `origin`, a key that already started a run gets that run (the store's one-run-per-key), so a retry never
 *  starts a second. */
export async function startRun(store: Pick<Store, "runs" | "runOfOrigin">, deps: StartDeps, entry: AgentEntry, body: Json, { trigger, origin, capped = false, from, title, sealed }: StartOptions = {}): Promise<RunRow> {
  const { launch, revision } = await prepareLaunch(deps, entry, body, { ...(trigger ? { trigger } : {}), capped, ...(from ? { from } : {}), ...(title !== undefined ? { title } : {}) });
  const runId = (deps.newRunId ?? uuidv7)();
  try {
    return await withHeldFiles(deps, runId, launch, () => store.runs.create({ id: runId, agentId: entry.agent.id, revisionId: revision.id, ...(origin ? { origin } : {}) }, { body: launchBody(launch), ...(sealed ? { sealed: sealed(runId) } : {}) }));
  } catch (error) {
    // Only another writer of the store got here first under the same origin key: its run is the one asked for.
    if (origin && error instanceof StoreConstraint) {
      const existing = await store.runOfOrigin(origin.key);
      const row = existing && (await store.runs.get(existing.runId));
      if (row) return row;
    }
    throw error;
  }
}

/** Writes run `runId` with `write`, its files (launch.files) held for it first (StartDeps.files): a hold that fails part
 *  way, a write that fails, or one that answers another run (an origin key's run started before), lets go of the hold. */
async function withHeldFiles(deps: StartDeps, runId: string, launch: RunLaunch, write: () => Promise<RunRow>): Promise<RunRow> {
  const ids = launch.files ?? [];
  if (!ids.length || !deps.files) return await write();
  try {
    await deps.files.hold(runId, ids);
    const row = await write();
    if (row.id !== runId) await deps.files.release(runId);
    return row;
  } catch (error) {
    await deps.files.release(runId).catch(() => undefined);
    throw error;
  }
}

/** An agent given inline (POST /runs): its reference in its source with the version, its name and description, and the
 *  revision its checked definition makes (agents-store makeRevision), not yet stored. */
export interface InlineAgent {
  readonly external: ExternalRef & { readonly version: string };
  readonly name: string;
  readonly description: string | null;
  readonly revision: NewRevision & { readonly note?: string };
}

/** Starts a run of an agent given inline, as POST /agents/{id}/runs starts a run of a stored one: the same checks over the
 *  revision the definition makes (prepareLaunch), then ONE transaction (store.runs.createInline) that writes the agent on
 *  its reference's first run and the revision on its version's first run, or reads them, then the run and its launch. The
 *  agent already mapped to the reference is the run's (its id, its learning), so a run of a later version learns from the
 *  earlier ones. A different definition under a version already run is 409 external_body_conflict, nothing written; under
 *  `origin`, a key that already started a run gets that run, as startRun's. */
export async function startInline(store: Pick<Store, "runs" | "runOfOrigin" | "agents">, deps: StartDeps, inline: InlineAgent, body: Json, { origin, sealed }: Pick<StartOptions, "origin" | "sealed"> = {}): Promise<RunRow> {
  const { external, revision } = inline;
  const ref = externalKey(external);
  const mapped = await store.agents.byExternal(ref);
  const stored = mapped ? await getAgent(store, mapped.id) : null;
  // A version's first run brings the agent's name and description up to it, in the start's own transaction (createInline),
  // so its launch is prepared under them: a workflow run's title names the version it runs. A run of a version already
  // stored keeps the agent's as they are, as a run of any agent's earlier revision does.
  const firstOfVersion = !stored || !(await store.agents.hasExternalVersion(stored.agent.id, external.version));
  const entry: AgentEntry = stored
    ? firstOfVersion ? { ...stored, agent: { ...stored.agent, name: inline.name, description: inline.description } } : stored
    : {
        agent: { id: uuidv7(), name: inline.name, description: inline.description, currentRevision: null, createdAt: Date.now(), archivedAt: null, externalRef: ref },
        revision: null, version: 0, revisions: 0, sizes: new Map(),
      };
  // A store revision is the revision the run path reads as a pi Revision (its body is the revision body), as pinnedOf hands
  // one across.
  const { launch } = await prepareLaunch(deps, entry, body, { revision: revision as unknown as Revision });
  const runId = (deps.newRunId ?? uuidv7)();
  try {
    return await withHeldFiles(deps, runId, launch, () => store.runs.createInline({
      agent: { id: entry.agent.id, name: inline.name, description: inline.description, ref },
      revision: { id: revision.id, version: external.version, kind: revision.kind, body: revision.body, skills: revision.skills, ...(revision.note !== undefined ? { note: revision.note } : {}) },
      run: { id: runId, ...(origin ? { origin } : {}) },
      launch: { body: launchBody(launch), ...(sealed ? { sealed: sealed(runId) } : {}) },
    }));
  } catch (error) {
    if (error instanceof ExternalBodyConflict) {
      const { source, kind, id, version } = external;
      throw new ApiError("external_body_conflict", `${source} ${kind} ${id} version ${version} already ran here with a different definition. A version's definition never changes here: publish a new version and run that.`, { details: { external: { source, kind, id, version } } });
    }
    if (origin && error instanceof StoreConstraint) {
      const existing = await store.runOfOrigin(origin.key);
      const row = existing && (await store.runs.get(existing.runId));
      if (row) return row;
    }
    throw error;
  }
}

/** A run's launch from its create body, with every check the old start made before a run started, in the same order and
 *  words: the body's fields, the revision it pins, the input against its schema, the cap rules, the plane this host
 *  resolves, whether the revision can run here; then its title, plane, model and learning start. Nothing is written: the
 *  caller INSERTs the run with it (startRun; an inline agent's run, which writes its agent and revision in the same
 *  transaction). `revision`: the revision the run starts on, given (an inline agent's, not yet stored), in place of the
 *  one the body pins or the agent's current (deps.pinnedOf). */
export async function prepareLaunch(deps: StartDeps, entry: AgentEntry, body: Json, { trigger, capped = false, from, title: given, revision: onRevision }: Omit<StartOptions, "origin"> & { readonly revision?: Revision } = {}): Promise<{ launch: RunLaunch; revision: Revision }> {
  const pinnedOf = onRevision ? async () => ({ revision: onRevision, version: entry.version }) : () => deps.pinnedOf(entry, body);
  const issues = deps.runBodyIssues(body);
  if (issues.length) {
    // Told from the revision the run would start on (a pinned one, else the current), once it reads as one: a pin that is
    // malformed or names no revision gets the refusal alone, no hint.
    const on = issues.some((issue) => issue.field === "revision") ? undefined : await pinnedOf();
    throw deps.told(invalid(on ? await deps.explainRun(issues, body, on.revision) : issues));
  }
  if (body.quote_id !== undefined) throw unsupported("quotes", "This server has no billing, so it takes no quotes.");
  // Each a ready file, before anything starts: checked ready here, then named in the launch (in order) for the runner to
  // copy into the run's work/inputs/ at its claim.
  const fileIds = Array.isArray(body.file_ids) ? (body.file_ids as string[]) : [];
  if (fileIds.length) await deps.readyFiles(fileIds);
  const pinned = await pinnedOf();
  if (!pinned) throw invalid([{ field: "revision", reason: "not_an_option", message: typeof body.revision === "string" ? `${body.revision} is not a revision of the agent ${entry.agent.id}` : `the agent ${entry.agent.id} has no current revision` }]);
  const { revision } = pinned;
  const rbody = revision.body as StartBody;
  const input = body.input as Json;
  const wrong = await deps.inputIssuesOf(revision, input);
  if (wrong.length) throw deps.told(invalid(await deps.explainRun(wrong, body, revision)));
  // The run's own cap, else the agent's default: the caller chose its own.
  const cap = typeof body.max_cost_usd === "number" ? body.max_cost_usd : rbody.maxCostUsd;
  if (capped && cap === undefined) throw invalid([{ field: "max_cost_usd", reason: "missing", message: "Every run a trigger starts is capped: give the trigger's target a max_cost_usd or set the agent's." }]);
  // How its cap prices a request: the run's own, else the agent's, else expected (cap.ts). Only a run with a cap has one.
  if (body.cap_mode !== undefined && cap === undefined) throw invalid([{ field: "cap_mode", reason: "not_allowed", message: "cap_mode says how a run's cap prices its requests, and this run has no cap: give it a max_cost_usd, or set the agent's." }]);
  const capMode = cap === undefined ? undefined : typeof body.cap_mode === "string" ? body.cap_mode : rbody.capMode;
  const place = resolvePlace(rbody.place as Place | undefined, deps.fallbackPlace(revision.kind, revision.kind === "agentic" ? (rbody.tools ?? []) : []));
  await deps.runnable(revision, place, { capped: cap !== undefined });
  // The title shows on the run's page, the runs list and Mission Control: built from its input as shown, each held value
  // redacted before a long one is cut (a cut key could no longer be found).
  const shown = redactedOutput(input, deps.serverSecrets());
  // A starter's title (a trigger's "<Source> <name>") is shown words too: cut as the input is, then as every title is below.
  const title = given !== undefined ? String(redactedOutput(given, deps.serverSecrets())) : revision.kind === "workflow" ? deps.workflowTitle(entry.agent.name || entry.agent.id, isObject(shown) ? shown : {}) : typeof input.content === "string" ? input.content : (Object.values(input).find((v): v is string => typeof v === "string") ?? JSON.stringify(input));
  // Its tools' providers, resolved before the run exists (tool-plane.ts) and kept in its launch body, so a claim reads them
  // back, never the settings of that moment. (The old start wrote them to serve.json; now they ride the launch row.)
  const tooling = await toolingOf(revision);
  const plane: Plane = tooling ? planeFor(deps.planeEnv(), tooling, deps.toolSettings(), { capped: cap !== undefined, run: true }) : {};
  // The run's model, resolved once, at start (the runner reads launch.model only).
  const model = await deps.modelOf(entry, revision);
  // The run's learning start, decided here as the old start did (learning-run.ts onStart): a run learns when the server's
  // learning is on and its revision says so; then its seed is read now and the notes its # Learned section names (learnedParts,
  // the one decision) are pinned in the launch for the runner to put in the prompt. A seed that cannot be read starts it with
  // nothing (given empty, seed null); the end state is the runner's.
  const learning = await learningStartFor(deps, entry, revision, rbody, input);
  // The run's Archil disk, chosen now and kept in its launch (run-launch.ts archilDisk): the one the body names (a disk per
  // customer), else its agent's when it has one; with neither, its claim makes the agent's.
  const named = isObject(body.archil_disk) && typeof body.archil_disk.disk_id === "string" ? body.archil_disk.disk_id : undefined;
  if (named !== undefined && !deps.launchDiskOf) throw invalid([{ field: "archil_disk", reason: "not_allowed", message: "This server keeps no run on an Archil disk." }]);
  const archilDisk = deps.launchDiskOf ? await deps.launchDiskOf(entry.agent.id, named) : undefined;
  // The run's effort: its own, else its revision's saved thinking, else the host's AGENT_THINKING (each a thinking level,
  // else none). Nothing set: none, so the run gets no effort note and its harness's own default. Kept in its launch, so
  // its harness's thinking, its guidance and its metrics all read the one value.
  const effort = typeof body.effort === "string" ? body.effort : (thinkingLevel(rbody.thinking) ?? thinkingLevel(deps.planeEnv().AGENT_THINKING));
  const launch: RunLaunch = {
    input,
    title: clip(redacted(title.trim().replace(/\s+/g, " "), deps.serverSecrets()), 80),
    place,
    harness: harnessOfBody(revision.body),
    ...(effort !== undefined ? { effort } : {}),
    ...(cap !== undefined ? { maxCostUsd: cap } : {}),
    ...(capMode !== undefined ? { capMode } : {}),
    ...(Object.keys(plane).length ? { plane } : {}),
    ...(deps.approvers !== undefined ? { approvers: deps.approvers } : {}),
    ...(deps.documents !== undefined ? { documents: deps.documents } : {}),
    ...(deps.boxAllow !== undefined ? { boxAllow: deps.boxAllow } : {}),
    ...(deps.boxAllowSet ? { boxAllowSet: true as const } : {}),
    ...(fileIds.length ? { files: fileIds } : {}),
    ...(learning ? { learning } : {}),
    ...(body.workflow_first === false ? { workflowFirst: false as const } : {}),
    ...(trigger ? { trigger } : {}),
    ...(from ? { inputOrigin: from } : {}),
    ...(model ? { model } : {}),
    ...(archilDisk ? { archilDisk } : {}),
  };
  return { launch, revision };
}

/** For tests and the switch: the issue list an input refusal carries. */
export type { InputIssue };
