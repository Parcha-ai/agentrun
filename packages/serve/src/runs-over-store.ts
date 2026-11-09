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
import type { Revision } from "@parcha/pi-durable-agent";
import type { MessageOrigin } from "@parcha/pi-durable-agent/timeline";
import type { AgentEntry } from "./agents-store.js";
import { CAP_TOLERANCE, money } from "./cap.js";
import { ApiError, type InputIssue, invalid, unsupported } from "./errors.js";
import { harnessOfBody } from "./harness.js";
import { redacted, redactedOutput } from "./key-refusal.js";
import { type Place, resolvePlace } from "./place.js";
import { launchBody, type RunLaunch } from "./run-launch.js";
import type { ApprovalDecision, RunMoment } from "./run-view.js";
import { sendCommand } from "./runner/commands.js";
import { RunFinal, type RunOrigin, type RunRow, type Store, StoreConstraint } from "./store/index.js";
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
 *  nothing written). A run's first end is its last, so a cancel that races the end is the runner's to drop. (The runner's
 *  "cancel" command kind is tl-jobs'; this writes the row through the store directly until it is in runner/commands.ts.) */
export async function cancel(store: RunsStore, moment: RunMoment): Promise<boolean> {
  if (moment.importedSource !== undefined) return false;
  // Already ended, or already ending (an outcome being written, or a cancel in flight): a run's first end is its last.
  if (moment.terminal || moment.cancelled) return false;
  try {
    await store.command(moment.id, { kind: "cancel", body: {} });
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
type StartBody = { readonly maxCostUsd?: number; readonly capMode?: string; readonly place?: unknown; readonly tools?: readonly unknown[] };

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
  /** Where a revision naming these tools and no place runs here (server.ts fallbackPlace). */
  fallbackPlace(kind: "agentic" | "workflow", tools: readonly unknown[]): Place;
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
  /** The run's model, pinned at start: resolved exactly as the old per-run process resolved it from the revision and agent
   *  (app.ts's runModels / wireModels over revision.body.model on its harness). The runner reads launch.model alone, so one
   *  resolution happens, here. Required. */
  modelOf(entry: AgentEntry, revision: Revision): Promise<{ provider: string; modelId: string } | undefined>;
}

/** How a run is asked to start, beyond its create body: a trigger and its firing, an idempotency or firing origin, whether
 *  it must have a cap (a trigger's), and who its first message is from when the person did not write it. */
export interface StartOptions {
  readonly trigger?: RunTrigger;
  readonly origin?: RunOrigin;
  readonly capped?: boolean;
  readonly from?: MessageOrigin;
}

/** Starts a run of `entry`'s agent from a create body, as POST /agents/{id}/runs starts it: every check the old start made
 *  before a run started, in the same order and words (the body's fields, the revision it pins, the input against its schema,
 *  the cap rules, the plane this host resolves, whether the revision can run here), then an INSERT — a queued run and its
 *  launch body in one transaction (store.runs.create), which a runner reads at its claim. No process, no door, no setup
 *  file: where the run runs is the runner's. Under `origin`, a key that already started a run gets that run (the store's
 *  one-run-per-key), so a retry never starts a second. */
export async function startRun(store: Pick<Store, "runs" | "runOfOrigin">, deps: StartDeps, entry: AgentEntry, body: Json, { trigger, origin, capped = false, from }: StartOptions = {}): Promise<RunRow> {
  const issues = deps.runBodyIssues(body);
  if (issues.length) {
    // Told from the revision the run would start on (a pinned one, else the current), once it reads as one: a pin that is
    // malformed or names no revision gets the refusal alone, no hint.
    const on = issues.some((issue) => issue.field === "revision") ? undefined : await deps.pinnedOf(entry, body);
    throw deps.told(invalid(on ? await deps.explainRun(issues, body, on.revision) : issues));
  }
  if (body.quote_id !== undefined) throw unsupported("quotes", "This server has no billing, so it takes no quotes.");
  // Each a ready file, before anything starts: checked ready here, then named in the launch (in order) for the runner to
  // copy into the run's work/inputs/ at its claim.
  const fileIds = Array.isArray(body.file_ids) ? (body.file_ids as string[]) : [];
  if (fileIds.length) await deps.readyFiles(fileIds);
  const pinned = await deps.pinnedOf(entry, body);
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
  const title = revision.kind === "workflow" ? deps.workflowTitle(entry.agent.name || entry.agent.id, isObject(shown) ? shown : {}) : typeof input.content === "string" ? input.content : (Object.values(input).find((v): v is string => typeof v === "string") ?? JSON.stringify(input));
  // Its tools' providers, resolved before the run exists (tool-plane.ts) and kept in its launch body, so a claim reads them
  // back, never the settings of that moment. (The old start wrote them to serve.json; now they ride the launch row.)
  const tooling = await toolingOf(revision);
  const plane: Plane = tooling ? planeFor(deps.planeEnv(), tooling, deps.toolSettings(), { capped: cap !== undefined, run: true }) : {};
  // The run's model, resolved once, at start (the runner reads launch.model only).
  const model = await deps.modelOf(entry, revision);
  const launch: RunLaunch = {
    input,
    title: clip(redacted(title.trim().replace(/\s+/g, " "), deps.serverSecrets()), 80),
    place,
    harness: harnessOfBody(revision.body),
    ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
    ...(cap !== undefined ? { maxCostUsd: cap } : {}),
    ...(capMode !== undefined ? { capMode } : {}),
    ...(Object.keys(plane).length ? { plane } : {}),
    ...(deps.approvers !== undefined ? { approvers: deps.approvers } : {}),
    ...(deps.documents !== undefined ? { documents: deps.documents } : {}),
    ...(deps.boxAllow !== undefined ? { boxAllow: deps.boxAllow } : {}),
    ...(fileIds.length ? { files: fileIds } : {}),
    ...(trigger ? { trigger } : {}),
    ...(from ? { inputOrigin: from } : {}),
    ...(model ? { model } : {}),
  };
  const runId = (deps.newRunId ?? uuidv7)();
  try {
    return await store.runs.create({ id: runId, agentId: entry.agent.id, revisionId: revision.id, ...(origin ? { origin } : {}) }, { body: launchBody(launch) });
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

/** For tests and the switch: the issue list an input refusal carries. */
export type { InputIssue };
