// The end-of-run step of a run that learns, on the runner: the reflect hook (reflect-hook.ts createReflectHook) over the
// run's store, driven by the learning start its launch records (run-launch.ts learningStartOf), which the server decided
// once at the run's start. A spec builder gives the adapter loop `endOfRun: learningEndOfRun(launch, deps)`. Each of the
// hook's reads is the server's own rule, over the store in place of the run's directory:
//   - its cap and its spend so far, read as its gates read them;
//   - its owner's words (ownerWords): a grade's, and each message they sent after the job's first, one line of
//     corrections.md, checked against main first (learn/commit.ts correctionRefused);
//   - the compile turn's facts (compileAskOf, learn/compile.ts): whether the job is due to be compiled (its completed
//     runs, no learned workflow yet), or a workflow its promotion holds wants a revision (once per hold); its last runs'
//     traces, the tools a workflow may name (draftTools) and the DSL's own language for writing one;
//   - whether the job gave nothing new (onlyLearnedWorkflows over its timeline): a run whose only tool work was its
//     learned workflows, each answering;
//   - each compile draft's checks (checkDraftOf): the workflow checks, its dry run, the secret and hidden-character
//     refusals, against the commit the run started from (a revision's against the commit its text was read at);
//   - the round's one merge (commitDirect): a passing draft and the owner's line, committed by the run;
//   - what the run must never learn (the server's serverSecrets as far as the runner reads them): every secret the server
//     keeps sealed (store-secrets.ts storeSecrets), the runner's secrets, the keys its claim handed it, and the sign-in
//     pointers its row says it was handed, read back from the store (handed-values.ts handedValuesOf). A run whose
//     pointers can't be read back learns nothing (the hook drops it, saying why), never over a shorter list.
// A run whose seed could not be read keeps that drop. A run whose seed was read at or before a reset of its agent's
// learning learns nothing at all, dropped at its entry with reason `reset`. Every read of the agent's runs here reads
// only those after the reset (learn/compile.ts sinceReset).
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type EntryLike, isMessageRow, type TimelineEvent } from "../timeline/index.js";
import { shownMessage } from "../timeline/timeline.js";
import type { AgentLearning } from "../learn/rows.js";
import { correctionRefused, learningCommit, type LearningChange, type LearningCommitResult } from "../learn/commit.js";
import { CAPS, type Change, checkDraft, problemWords, type Problem, unstorable } from "../learn/index.js";
import { repickSiteOf } from "../learn/check.js";
import { repickLabelOf, repickRewrite } from "../learn/repick.js";
import { holdsSave, learningOf, type LearningRead, readAt, readLearning, readOf, runMergeOf } from "../learn/rows.js";
import { completedRun, type CompileAsk, compileStoppedOf, lastOwnRuns, sinceReset, type CompileTrace, compileDue, compilePrompt, compileReference, COMPILE_TRACES, DRAFT_FAILED, draftFailedOf, type DraftChecked, type HeldAsk, heldNamesOf, newCompileAttempt } from "../learn/compile.js";
import { heldOnGiveBacks, reviseAttemptOf, sdkInputText } from "./promotion.js";
import { loopOf, repickOf } from "../learning-setting.js";
import { CHECK_TEXT_MAX, type PromotionRecord, promotionOf, promotionsOf, recordPromotion, resetAtOf } from "../learn/promote.js";
import { type DraftDecisions, draftDecisionProviders, draftDryRun, draftFiles, draftMcpTools, unpricedCalls, WORKFLOWS_DIR } from "../learn/workflow-draft.js";
import { DECISION_PROVIDER_KEYS } from "../tool-plane.js";
import { handedValuesOf } from "../handed-values.js";
import { excerptShown, MIN_SECRET, redactSecrets } from "../learn/secrets.js";
import { LEARNED_WORKFLOW_TOOL } from "../learned-workflow.js";
import { META_TOOLS } from "../meta-tool-names.js";
import { holdsSecret, LEARNING_LABEL, secretsShown } from "../learning.js";
import type { RunPath } from "../learning-cost.js";
import { said, seedStopped } from "../learning-words.js";
import { learningStartOf, readLaunchBody, type RunLaunch, seedFailed } from "../run-launch.js";
import type { SignInReader } from "../run-view.js";
import { type AlsoRow, type Command, FINAL_STATES, type LearningProposal, type McpServerRow, type Store } from "../store/store.js";
import { shadowRunId } from "../learn/audit.js";
import { keyedBesideOf, noteLearningDeadline } from "../learning-work.js";
import { getMcpServer } from "../mcp-store.js";
import { readApprovers } from "../server-approvers.js";
import { isCliRecord, runEntries, runTimeline, withoutFeedbackRounds } from "../store-reads/journal.js";
import { capNowOf, KINDS } from "./journal-kinds.js";
import { bookedCapSpend, cliModelWorked, runCostOf } from "./metrics.js";
import { fits, sdkTakes, workflowDigest } from "./workflow-first.js";
import { pendingFeedbackOf } from "./feedback-round.js";
import type { EndOfRunTurn } from "./loop-contract.js";
import { type Committed, createReflectHook, type DraftCommit } from "./reflect-hook.js";
import { sdkDraftTools, type SdkWorkflowTool } from "../sdk/workflows.js";
import { runnerSecrets } from "./redact.js";
import { mcpNameOf } from "../tool-names.js";
import { held, heldEndOfRun } from "./held.js";

/** What the step reads: the run's store (its agent's learning among it), the data directory (the server's tool settings
 *  a draft's tools are read with), the runner's environment (the host's secrets a draft or
 *  a correction is refused for), and what the run was handed (its claim's keys, its sign-in's pointers through
 *  `signIns`), which it never learns. */
export interface LearningEndDeps {
  readonly store: Store;
  readonly data: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The agent's sign-ins, opened (sign-ins-store.ts signInReads over the store and the seal key): the pointers the run's
   *  row says it was handed are read back through them and never learned. Absent, a run marked as handed one learns
   *  nothing (its pointers can't be read back). */
  readonly signIns?: SignInReader;
  /** The secret values the run's claim handed it (claim-secrets.ts: its tool and model keys), never learned. */
  readonly handed?: readonly string[];
  /** Every secret the server keeps sealed, read once at the run's end (store-secrets.ts storeSecrets over the store, the
   *  seal key and the data directory), never learned. A throw is a list that can't be read: the run learns nothing. */
  readonly stored?: () => Promise<readonly string[]>;
  /** The decision providers a draft's decision nodes may ask (LS-07): built on the host's keys (claim-secrets.ts
   *  hostDecisionKeys), host-side, never handed to the run. Read once per check; none: a draft with a decision node is
   *  refused. */
  readonly decisionProviders?: () => Promise<{ readonly providers: Readonly<Record<string, unknown>>; readonly default: string } | undefined>;
  /** The runner's log: what the compile turn left out for holding a secret, by name and count, never a value. */
  readonly log?: (line: string) => void;
}

/** The end-of-run step for a run launched with `launch`: undefined when its launch records no learning start (a run that
 *  does not learn is asked nothing and keeps nothing), else the reflect hook over the run's store. */
export function learningEndOfRun(launch: RunLaunch, deps: LearningEndDeps): EndOfRunTurn | undefined {
  const start = learningStartOf(launch);
  // A run that only uses what its agent learned (`learning: "use"`) is asked nothing and keeps nothing, at every end.
  if (!start || start.use) return undefined;
  // In a run's own process the step is its runner's (held.ts): what the run must never learn is every secret the runner
  // holds, and a run's process is given none but its own keys.
  if (held()) return heldEndOfRun();
  const env = deps.env ?? process.env;
  const hookFor = (seed: string, round: number, mustHold: string | undefined) => createReflectHook({
    round,
    // A run its cap stopped has no room left, and one whose spend is unknown under a cap cannot be kept within it. The cap
    // is the run's now (capNowOf: its newest raise's, else its launch's), the one its requests were admitted under. Its
    // spend under that cap is what the run's own gates read (capSpendOf: a request with no price of its own at the figure
    // it was held at, and what an earlier end's audit shadow took beside it), never the cost a person is shown, which is
    // unknown once one request's is. Either unknown: the spend is unknown, never read as the whole cap. A person's stop
    // comes to the hook as its `cut`.
    facts: async (runId) => {
      const entries = await runEntries(deps.store, runId, BACKGROUND_CONTEXT);
      // The run's spend so far by the one rule its end stores its cost by (metrics.ts runCostOf, as the store view reads
      // an ended run's): its booking, so the job's cost kept here is the figure the end stores when no turn follows it, and
      // what a turn after it spent is that figure less the job's. Never the Timeline's usage row: it reads pi's answers,
      // and pi answers a compaction's summary with no answer of its own (its cost rides on the next answer), so each one
      // read there as a request cut with no answer, unknown. A cut request still unknown in the booking (a pi retry's
      // earlier one) keeps it unknown; one a crash cut booked at its hold is an upper bound, not a spend: the job's and the
      // compile's figures say no "at most", so they stay unknown, as the run's stored cost reads once it ends.
      const booked = runCostOf(entries, { unbooked: isCliRecord(entries) && cliModelWorked(entries) });
      const costUsd = booked.atMost > 0 ? null : booked.usd;
      if (launch.maxCostUsd === undefined) return { learns: true, costUsd };
      const capUsd = capNowOf(launch.maxCostUsd, entries)!;
      const spentUsd = await capSpendOf(deps.store, runId, entries);
      return { learns: true, costUsd, capUsd, spentUsd, capReached: spentUsd !== null && spentUsd >= capUsd };
    },
    // A grade's feedback round always has something new, the grade's words (feedback-round.ts), whatever the job did.
    nothingNew: async (runId) => !pendingFeedbackOf(await runEntries(deps.store, runId, BACKGROUND_CONTEXT)) && onlyLearnedWorkflows(await runTimeline(deps.store, runId, BACKGROUND_CONTEXT, { settled: false })),
    feedback: async (runId) => {
      // A source hook uploads task dialogue, not owner feedback addressed to AgentRun.
      // CLI corrections are written explicitly through the owner corrections API.
      if (launch.cli_learning) return [];
      const [entries, rows, commands] = await Promise.all([runEntries(deps.store, runId, BACKGROUND_CONTEXT), runTimeline(deps.store, runId, BACKGROUND_CONTEXT, { settled: false }), deps.store.commands(runId, 0)]);
      return ownerWords(entries, rows, messagesOf(commands));
    },
    // A round whose merge is on main already (a stop after its commit, before its end was saved) is not checked for room
    // again: its merge gives back what it did.
    correctionRefused: ({ runId, agentId, round: at, text, refuse }) => correctionRefused(learningOf(deps.store, agentId), text, refuse, { runId, round: at }),
    // A run with no workflow binding (an SDK run's `noWorkflows`) compiles nothing.
    ...(start.noWorkflows ? {} : {
      compileFacts: (input: { runId: string; agentId: string; outcome: "completed" | "failed"; refuse: readonly string[]; round: number }) => compileAskOf(deps, { ...input, input: launch.input, ...(launch.sdk ? { sdkTask: sdkInputText(launch) } : {}), seedWorkflows: start.workflows?.length ?? 0, corrections: start.section }),
      compileFailed: (input: { runId: string; agentId: string; compile: CompileAsk; workflow: string; errors: readonly string[] }) => recordDraftFailed(deps, input),
      compileStarts: ({ runId, until }: { runId: string; until: number }) => noteLearningDeadline(deps.store.settings, runId, until),
    }),
    // The run's secrets, what the claim handed it, every secret the server keeps sealed, and the sign-in pointers it was
    // handed (each at least MIN_SECRET long, as every cut takes them); `unreadable` when those can't be read back, or the
    // server's secrets can't be read (never a check over a shorter list).
    refuse: async (runId) => {
      const pointers = await handedValuesOf(deps, deps.store, runId);
      if (pointers === "unreadable") return "unreadable";
      let stored: readonly string[];
      try {
        stored = deps.stored ? await deps.stored() : [];
      } catch {
        return "unreadable";
      }
      return runnerSecrets(env, [...(deps.handed ?? []), ...stored, ...pointers.refs.filter((ref) => ref.length >= MIN_SECRET)]);
    },
    // A draft is checked against the seed the run was laid from (its conflict base: the merge refuses a file main changed
    // since); a workflow the compile turn revised from main's text (`revised`) against the commit its first ask read it
    // at (kept with that ask, so a restart that replays its answer never reads main again).
    checkDraft: ({ runId, agentId, draft, refuse, revised }) => checkDraftOf(deps, { runId, agentId, seed, draft, refuse, ...(revised ? { revised } : {}) }),
    commit: async ({ runId, agentId, round: at, draft, correction, refuse }) => {
      const reason = draft ? `Compiled the job as workflow ${draft.name}${correction !== undefined ? ", with its owner's correction" : ""}.` : "Its owner's correction.";
      const done = await commitDirect({ learning: learningOf(deps.store, agentId), log: deps.log ?? (() => undefined) }, {
        runId, round: at, reason, seed, ...(mustHold ? { mustHold } : {}), files: draft ? draft.files.map((file) => ({ ...file })) : [],
        ...(draft?.held?.length ? { held: [...draft.held] } : {}), ...(draft?.bases ? { bases: draft.bases } : {}),
        ...(correction !== undefined ? { correction, refuseValues: refuse } : {}),
      });
      return committedOf(done);
    },
  });
  return async (input) => {
    // No seed, no end-of-run step (seedFailed): a run that started from no commit of main has nothing to commit over.
    // Why, as its start recorded it: a folder that could not be read, or a start that could not be made from it; a
    // start that records none names no reason.
    if (seedFailed(start)) {
      const why = seedStopped(start.seedFailed);
      // Every end of it: the first's drop stands for a later one (the store keeps one a round, so it adds nothing new).
      return { also: [{ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason: "seed_failed", detail: said.stopped(why) } } }] };
    }
    // The one check at the entry of a run's learning end, before any merge, look-back, compile, draft check or record: a
    // run whose seed was read at or before a reset of its agent's learning (its watermark, learn/promote.ts resetAtOf; a
    // start that records no time is read as before it) learns nothing, whole. Its corrections and compile would land on
    // what the reset left.
    const reset = await resetAtOf(deps.store.settings, input.agentId);
    if (reset !== undefined && !(start.seededAt !== undefined && start.seededAt > reset)) {
      return { also: [{ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason: "reset", detail: said.reset } } }] };
    }
    // The second wall, once the agent's learning was reset: a seed its learning holds now is one its merge must still
    // find (commit.ts mustHold), so a reset after this check refuses the merge whole in the save's own transaction.
    const mustHold = reset !== undefined && (await holdsSave(learningOf(deps.store, input.agentId), start.seed!)) ? start.seed! : undefined;
    // Which end of the run this is: the round after the newest it kept (a follow-up opened the run again after it), else
    // its first. A replayed end reads the same round: its rows are written only with the end that closes it.
    const prior = await deps.store.learning.proposal(input.runId);
    return hookFor(start.seed!, prior ? prior.round + 1 : 1, mustHold)(input);
  };
}

/** What every cap gate of run `runId` reads as spent beside it on its behalf (adapter-loop.ts RunCapConfig.beside): the
 *  learning work it started (childrenBesideOf), for a capped run with a learning start, the only run whose claims may
 *  start any; none for any other, whose gates read only its own sessions. */
export function spentBesideOf(launch: RunLaunch, store: Pick<Store, "runs" | "settings">, runId: string): (() => Promise<number | null>) | undefined {
  if (launch.maxCostUsd === undefined || !learningStartOf(launch)) return undefined;
  return () => childrenBesideOf(store, runId);
}

/** What run `runId`'s learning work took beside it under its cap: its audit's shadow run (shadowBesideOf) and the replay
 *  runs of a check on its own key (learning-work.ts keyedBesideOf; in a run's own process, its runner's read of them,
 *  Held.keyedBeside, as the process's store reads no other run's row). Null when either is unknown. */
export async function childrenBesideOf(store: Pick<Store, "runs" | "settings">, runId: string): Promise<number | null> {
  const shadow = await shadowBesideOf(store, runId);
  const runner = held();
  const keyed = shadow === null ? null : runner ? await runner.keyedBeside() : await keyedBesideOf(store, runId);
  return shadow === null || keyed === null ? null : shadow + keyed;
}

/** What run `runId`'s audit's shadow run took beside it (runner/audit.ts, started at its end with what its cap left): at
 *  its cost once it ended, at its own cap while it has not (the most it may take) or when it ended at a cost not known,
 *  0 when none was started. Null: unknown. */
export async function shadowBesideOf(store: Pick<Store, "runs">, runId: string): Promise<number | null> {
  const id = shadowRunId(runId);
  const shadow = await store.runs.get(id);
  if (!shadow) return 0;
  const figure = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;
  if (FINAL_STATES.includes(shadow.state) && figure(shadow.costUsd)) return shadow.costUsd;
  const cap = readLaunchBody((await store.runs.launch(id)).body)?.maxCostUsd;
  return figure(cap) ? cap : null;
}

/** What run `runId`'s cap leaves its audit's shadow run at its end (runner/audit.ts startAudit): the cap it is held to now
 *  (capNowOf: its newest raise's, else `launchCapUsd`), less what it spent under it (capSpendOf over `entries`, its
 *  journal: its job, its follow-ups, its compile turns). Null when that spend is unknown. */
export async function auditRoomOf(store: Pick<Store, "runs" | "settings">, runId: string, launchCapUsd: number, entries: readonly EntryLike[]): Promise<number | null> {
  const capUsd = capNowOf(launchCapUsd, entries)!;
  const spent = await capSpendOf(store, runId, entries);
  return spent === null ? null : capUsd - spent;
}

/** What run `runId`'s cap leaves at its end (auditRoomOf over its journal read now): what a check on its own key shares
 *  among its replay runs (runner/promotion.ts keyedCapOf). Null when its spend is unknown. */
export async function roomAtEndOf(store: Store, runId: string, launchCapUsd: number): Promise<number | null> {
  return auditRoomOf(store, runId, launchCapUsd, await runEntries(store, runId, BACKGROUND_CONTEXT));
}

/** What capped run `runId` has spent under its cap, as every gate of the run reads it: its sessions' booking as the kernel
 *  cap counts it (metrics.ts bookedCapSpend over `entries`, its journal) and what its learning work took beside it
 *  (childrenBesideOf). Null when either is unknown.
 *
 *  The rule for a cost no one knows (a request answered with no price of its own, one cut short or lost): under a cap it
 *  counts at the figure the cap held it at when it was admitted (its worst case at the model's price, and a lost one's
 *  cache-miss bound), as the kernel cap's own admissions count it (sessionSpendOf). Never $0, which could overspend, and
 *  never the whole cap, which reads a run that spent $2 as one with nothing left. The cost a person is shown stays
 *  unknown (a held figure is the cap's, never a charge). Only a request held at no figure (none is, under a cap) leaves
 *  the spend itself unknown: then nothing more is sent under the cap, and the words say the spend is unknown, as the
 *  kernel's unknownSpend refusal does, never "no room". */
export async function capSpendOf(store: Pick<Store, "runs" | "settings">, runId: string, entries: readonly EntryLike[]): Promise<number | null> {
  const spent = bookedCapSpend(entries);
  if (spent === null) return null;
  const beside = await childrenBesideOf(store, runId);
  return beside === null ? null : spent + beside;
}

/**
 * A run's merge on the agent's learning, written by the runner directly (learn/commit.ts learningCommit, one save): its
 * compiled draft's files and its owner's correction, saved by `change.runId`. A file changed since the run's seed (or a
 * revision's `bases` save) is a conflict, never written over; a correction that holds what must never be stored, or
 * would take corrections.md past its cap, is refused (past the cap beside a draft, it is left out alone and the draft
 * merges). Any failure is logged by its reason alone.
 */
export async function commitDirect(deps: { readonly learning: AgentLearning; readonly log: (line: string) => void }, change: LearningChange): Promise<LearningCommitResult> {
  const done = await learningCommit(deps.learning, change);
  if (!done.ok) deps.log(`learning: run ${change.runId}: its merge could not be written (${done.reason})`);
  return done;
}

/** A merge's result as the hook reads it. */
const committedOf = (done: LearningCommitResult): Committed =>
  done.ok ? { ok: true, commit: done.commit, ...(done.refusedCorrection ? { refusedCorrection: done.refusedCorrection } : {}) } : done.reason === "unavailable" ? { ok: false, reason: "unavailable", problems: [] } : { ok: false, reason: done.reason, problems: done.problems };

/** A message a person sent that the run took: its whole text, as the run's commands keep it, and their own words beside
 *  it when they sent some (POST /runs/{id}/messages `said`), which its learning keeps in place of that text. */
export type TakenMessage = { readonly text: string; readonly said?: string };

/** The messages a person sent of a run's command rows `commands`, in the order they were written, each whole with its
 *  `said` when sent with one: a steer's text, or the note of a deny (a message makes one of an approval it found
 *  waiting, runs-over-store.ts message). A refused row took no turn, and a trigger's or the server's steer (`origin`) is
 *  no person's: both are left out. The one place a message's whole text and its `said` are read back for learning. */
export function messagesOf(commands: readonly Command[]): TakenMessage[] {
  return commands.flatMap((command) => {
    const body = (command.body ?? {}) as { text?: unknown; note?: unknown; said?: unknown; origin?: unknown };
    const text = command.kind === "steer" ? body.text : command.kind === "deny" ? body.note : undefined;
    if (command.refused !== null || typeof text !== "string" || !text.trim() || body.origin !== undefined) return [];
    return [{ text: text.trim(), ...(typeof body.said === "string" ? { said: body.said } : {}) }];
  });
}

/** A person's words of each of `rows` (their messages after the job's first, in order). A `user_message` row is paired
 *  with the first message of `taken` not yet paired whose text, as the row shows it (timeline.ts shownMessage: cut at
 *  CAPS.text), is the row's, so a long message's cut row still finds its own and the same text sent twice keeps each its
 *  own. A paired row's words are the message's `said` when sent with one, else its whole text, never the cut row; a row
 *  no message pairs (the job's first input, a sign-in) keeps the row's text. */
function personWords(rows: readonly TimelineEvent[], taken: readonly TakenMessage[]): Map<TimelineEvent, string> {
  const left = [...taken];
  return new Map(rows.map((row) => {
    const text = String(row.text ?? row.summary ?? "");
    const at = row.kind === "user_message" && row.text !== null ? left.findIndex((one) => shownMessage(one.text) === row.text) : -1;
    if (at < 0) return [row, text];
    const [message] = left.splice(at, 1);
    return [row, message!.said ?? message!.text];
  }));
}

/** What a run's owner said of it, in order, each a line for corrections.md: the grade's words its end closes (a feedback
 *  round, feedback-round.ts pendingFeedbackOf over its root `entries`), and each message a person sent in this round of
 *  its timeline `rows`: after the job's first on its first round, after its previous end on a later one (a follow-up
 *  opened it again). A grade's round's rows, the end-of-run turn's and a subagent's (a child conversation's rows carry
 *  its spawning call, parent_tool_use_id: its task prompt is the job's, not the owner's) are left out. Each message is
 *  read whole from the run's commands (`taken`, messagesOf), never as its row cuts it: one sent with `said` is the
 *  person's own words, its text the host's, so `said` is kept; one without keeps its whole text. */
export function ownerWords(entries: readonly EntryLike[], rows: readonly TimelineEvent[], taken: readonly TakenMessage[] = []): string[] {
  const graded = pendingFeedbackOf(entries)?.text;
  const ended = entries.findLast((entry) => entry.kind === KINDS.end)?.id;
  const messages = withoutFeedbackRounds(rows).filter((row) => row.agent_label !== LEARNING_LABEL && !row.parent_tool_use_id && isMessageRow(row));
  // Read over every round's messages, so an earlier round's row pairs with its own message first.
  const words = personWords(messages.slice(1), taken);
  const said = ended === undefined ? messages.slice(1) : messages.filter((row) => Number(row.id.split(":")[1]) > ended);
  return [...(graded ? [graded] : []), ...said.filter((row) => row.kind === "user_message").map((row) => words.get(row) ?? String(row.text ?? row.summary ?? ""))];
}

/** learned_workflow by every name a harness calls it: its own, and claude-agent's host-tool alias (`mcp__hands__<name>`).
 *  A harness that names it another way reads as another tool, so its run is asked as before. */
export const LEARNED_NAMES: ReadonlySet<string> = new Set([LEARNED_WORKFLOW_TOOL, `mcp__hands__${LEARNED_WORKFLOW_TOOL}`]);

/** Over a run's timeline `rows`: whether a row is a call the job's model made, or its result: one at the top, or one a
 *  script or tools_call made for it (a call nested in a META_TOOLS call, by any harness's name for it), never a
 *  subagent's row or a call another tool nested (a learned workflow's own). */
export function modelsOwn(rows: readonly TimelineEvent[]): (row: TimelineEvent) => boolean {
  const named = new Map(rows.flatMap((row) => (row.kind === "tool_use" && row.tool_use_id ? [[row.tool_use_id, row.tool_name ?? ""] as const] : [])));
  return (row) => !row.parent_tool_use_id || META_TOOLS.has((named.get(row.parent_tool_use_id) ?? "").replace(/^(?:mcp__hands__|hands_)/, ""));
}

/** Whether a run's job, by its timeline `rows` (the end-of-run turn's own, labelled LEARNING_LABEL, left out), gave
 *  nothing new: it called tools, every one of them learned_workflow (a workflow's own nested calls are its), each
 *  answering; no tool result failed or was refused; no error, approval or wait; and one message, its first, came in.
 *  Read on the job's turns (withoutFeedbackRounds): a grade's feedback round is no message of the job's. */
export function onlyLearnedWorkflows(rows: readonly TimelineEvent[]): boolean {
  const own = withoutFeedbackRounds(rows).filter((row) => row.agent_label !== LEARNING_LABEL);
  if (own.some((row) => row.kind === "error" || row.kind === "tool_approval_requested" || row.kind === "waiting")) return false;
  if (own.filter(isMessageRow).length !== 1) return false;
  const models = modelsOwn(own);
  const calls = own.filter((row) => row.kind === "tool_use" && models(row));
  if (!calls.length || calls.some((row) => !LEARNED_NAMES.has(row.tool_name ?? ""))) return false;
  const results = own.filter((row) => row.kind === "tool_result");
  if (results.some((row) => row.tool_status !== "success")) return false;
  const answered = new Set(results.filter(models).map((row) => row.tool_use_id));
  return calls.every((row) => answered.has(row.tool_use_id));
}

/** The path a run took (learning-cost.ts RunPath), by its timeline `rows` as runTimeline labels them (its end-of-run
 *  turn's rows, LEARNING_LABEL, are the learning's and left out): `workflow` when its job did only what
 *  onlyLearnedWorkflows asks of a run with nothing new, `handed_back` when it called a learned workflow otherwise,
 *  `agent` when it called none. */
export function runPathOf(rows: readonly TimelineEvent[]): RunPath {
  const models = modelsOwn(rows);
  const ran = rows.some((row) => row.agent_label !== LEARNING_LABEL && row.kind === "tool_use" && models(row) && LEARNED_NAMES.has(row.tool_name ?? ""));
  if (!ran) return "agent";
  return onlyLearnedWorkflows(rows) ? "workflow" : "handed_back";
}

/** Whether a draft's workflow.json (`json`) waits for its owner's OK whatever its checks say: a step of it calls an MCP
 *  tool with no declared price (workflow-draft.ts unpricedCalls), from the prices each server's row keeps (mcp-probe.ts
 *  McpPrices), or an SDK run's manifest gives. A server the store can't read gives no price: held. */
async function heldOf(store: Pick<Store, "mcp">, json: string, manifest?: readonly SdkWorkflowTool[]): Promise<boolean> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return false;
  }
  const rows = new Map<string, Promise<McpServerRow | undefined>>();
  const priced = new Map<string, number | undefined>();
  // Every MCP tool its call nodes run, as the workflow's own read reads them (draftMcpTools over the parsed JSON: an
  // escaped "\/" is a slash there), its price read first (unpricedCalls asks synchronously).
  for (const name of draftMcpTools(doc)) {
    if (manifest) { priced.set(name, manifest.find((tool) => tool.name === name)?.price_usd); continue; }
    const { server, tool } = mcpNameOf(name)!;
    if (!rows.has(server)) rows.set(server, getMcpServer(store, server).catch(() => undefined));
    const price = ((await rows.get(server))?.prices as Record<string, unknown> | undefined)?.[tool];
    priced.set(name, typeof price === "number" && Number.isFinite(price) ? price : undefined);
  }
  return unpricedCalls(doc, (tool) => priced.get(tool)).length > 0;
}

/**
 * One compile draft through the checks (the compile turn's `check`): its two files as the folder would hold them
 * (workflow-draft.ts draftFiles: its workflow.json, and the README.md the host writes from its front matter), against
 * `seed`, the commit the run started from (a revision of main's text, `revised`, against the commit it read that text
 * at). In order: its example, the run's own input, refused for anything that must never be stored; the static checks
 * (check.ts checkDraft: the DSL's validation, caps, the secret and hidden-character refusals, a file a person retired or
 * holds for their OK); then its dry run (workflow-draft.ts draftDryRun: every model and tool answer synthesized, nothing
 * sent, paid or run) and the checks again with it. Its errors, each naming its file; else what is committed: the files
 * whole, the README held when a step calls an unpriced tool, the revision's base, and the workflow.json's digest. A
 * draft that is the very text the commit holds passes nothing and keeps nothing.
 */
export async function checkDraftOf(deps: LearningEndDeps, input: { runId: string; agentId: string; seed: string; draft: { name: string; text: string }; refuse: readonly string[]; revised?: { readonly workflow: string; readonly base: string } }): Promise<DraftChecked<DraftCommit>> {
  const { name } = input.draft;
  const { json, readme, example } = draftFiles(name, input.draft.text);
  const jsonPath = `${WORKFLOWS_DIR}/${name}/workflow.json`;
  const readmePath = `${WORKFLOWS_DIR}/${name}/README.md`;
  const revised = input.revised && input.revised.workflow === name && input.revised.base !== input.seed ? input.revised : undefined;
  const base = revised?.base ?? input.seed;
  const at = await readAt(learningOf(deps.store, input.agentId), base);
  if (!at) throw new Error(`the agent's learning has no save ${base}`);
  if (at.text(jsonPath) === json && at.text(readmePath) === readme) return { errors: [] };
  const refused = (problems: readonly Problem[]) => ({ errors: problems.map((problem) => problemWords([problem])), problems });
  const held = new Set((at.view?.workflows ?? []).flatMap((item) => item.files.map(({ path }) => path)));
  const changeOf = (path: string, text: string): Change => ({ path, status: held.has(path) ? "modified" : "added", mode: "100644", bytes: Buffer.from(text) });
  // Its example is the run's own input, read as every text it gave is: one that holds what must never be stored refuses
  // the draft, said at its README, though it is never written there.
  if (example !== undefined) {
    const leaky = unstorable([{ ...changeOf(readmePath, example), status: "added" }], input.refuse);
    if (leaky.length) return refused(leaky);
  }
  const { tools, gated, deniedBy, decisions, outputSchema, workflowAdapters, manifest } = await draftTools(deps, input.runId);
  const dsl = await import("@parcha/agentrun-dsl");
  // The owner's learning.repick (learning-setting.ts), read as the draft is checked: a change reaches the workflows
  // compiled after it, never one main already holds. An SDK bridge's runNode is its own (it picks every model and takes
  // none of the compact state rule), so an SDK agent's drafts are never rewritten.
  const repick = workflowAdapters === undefined ? repickOf(await learningOfRun(deps.store, input.runId)) : undefined;
  // A draft whose text on main has a status is a person's call (retired, or waiting for their OK): never changed.
  const kept = (at.view?.workflows ?? []).filter((item) => item.status !== "active").map((item) => item.file);
  const check = (text: string, dryRuns?: Parameters<typeof checkDraft>[0]["dryRuns"]) => checkDraft({
    changes: [changeOf(jsonPath, text), changeOf(readmePath, readme)], refuseValues: input.refuse, tools, dsl,
    ...(Object.keys(gated).length ? { gated } : {}), ...(Object.keys(deniedBy).length ? { deniedBy } : {}), ...(decisions ? { decisions } : {}),
    ...(workflowAdapters !== undefined ? { workflowAdapters } : {}), ...(kept.length ? { kept } : {}), ...(dryRuns ? { dryRuns } : {}),
    ...(repick?.repick ? { repick: true } : {}),
  });
  const checked = async (text: string): Promise<Problem[]> => {
    const statics = check(text);
    return statics.length ? statics : check(text, { [jsonPath]: await draftDryRun(dsl, text, example, outputSchema) });
  };
  const problems = await checked(json);
  if (problems.length) return refused(problems);
  // With learning.repick on, what is committed is the draft with its answer's re-pick reading the run's pages on its
  // second pass (learn/repick.ts), through the same checks and dry run, so the digest that serves is the doc the
  // promotion check replays. A re-pick the rewrite does not reach, or a rewrite they refuse (one past CAPS.file even on
  // one line), leaves the draft as compiled, which the log says (the latter by rule alone).
  let text = json;
  const doc: unknown = repick?.repick ? JSON.parse(json) : undefined;
  const site = repickSiteOf(doc);
  const rewritten = repick?.repick ? repickRewrite(doc, site, repick.repick_max_chars) : undefined;
  if (site && repick?.repick && !rewritten) deps.log?.(`learning.repick: workflow ${name} is kept as compiled: its re-pick ${JSON.stringify(repickLabelOf(site))} is not one the rewrite reaches`);
  if (rewritten) {
    const marked = workflowText(rewritten);
    const again = marked === json ? [] : await checked(marked);
    if (!again.length) text = marked;
    else deps.log?.(`learning.repick: workflow ${name} is kept as compiled; its re-pick over the run's pages failed the checks (${[...new Set(again.map((problem) => problem.rule))].join(", ")})`);
  }
  if (text !== json && at.text(jsonPath) === text && at.text(readmePath) === readme) return { errors: [] };
  const files = [{ path: jsonPath, text }, { path: readmePath, text: readme }];
  return {
    errors: [],
    kept: { name, files, ...((await heldOf(deps.store, text, manifest)) ? { held: [readmePath] } : {}), ...(revised ? { bases: { [jsonPath]: revised.base, [readmePath]: revised.base } } : {}) },
    digest: workflowDigest({ workflow: text }),
  };
}

/** The backend manifest is data describing existing callbacks, not a server MCP connection. */
function sdkDescribed(manifest: readonly SdkWorkflowTool[]): { name: string; does: string }[] {
  return manifest.map((tool) => ({ name: tool.name, does: `${tool.description}. Takes ${JSON.stringify(tool.input_schema)}.${tool.output_schema ? ` Gives ${JSON.stringify(tool.output_schema)}.` : ""}` }));
}

/** What each of `tools` takes and gives a workflow's call node, in the server's own words for it (tools.ts ToolEntry's
 *  summary): the compile ask's `described`. An MCP tool (`mcp:<server>/<tool>`, LS-07) is described by its server's
 *  listing as the store keeps it: what it does, the schema it takes and, when it lists one, the one it gives. A server or
 *  a tool the store does not list is described by none. */
async function describedOf(tools: readonly string[], store: Pick<Store, "mcp">): Promise<{ name: string; does: string }[]> {
  const { toolOf } = await import("../tools.js");
  const listed = new Map<string, Promise<McpServerRow | undefined>>();
  const out: { name: string; does: string }[] = [];
  for (const name of tools) {
    const mcp = mcpNameOf(name);
    if (!mcp) {
      const does = toolOf(name)?.summary;
      if (does) out.push({ name, does });
      continue;
    }
    const { server, tool } = mcp;
    if (!listed.has(server)) listed.set(server, getMcpServer(store, server).catch(() => undefined));
    const row = await listed.get(server)!;
    const entry = ((row?.tools ?? []) as { name?: unknown; title?: unknown; description?: unknown; input_schema?: unknown; output_schema?: unknown }[]).find((one) => one?.name === tool);
    if (!entry) continue;
    const said = typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : typeof entry.title === "string" ? entry.title.trim() : "";
    const does = [said ? `${said.replace(/[.\s]+$/, "")}.` : "", `Takes ${JSON.stringify(entry.input_schema ?? {})}.`, entry.output_schema !== undefined ? `Gives ${JSON.stringify(entry.output_schema)}.` : ""].filter(Boolean).join(" ");
    out.push({ name, does });
  }
  return out;
}

/** The most of an agent's kept learning, newest first, read for a held workflow's ask since its hold (compileAskOf). */
const HELD_ASKED_READ = 200;

/** The definition's `learning` of the revision run `runId` runs; undefined when it can't be read. */
async function learningOfRun(store: Store, runId: string): Promise<unknown> {
  try {
    const run = await store.runs.get(runId);
    const revision = run ? await store.agents.revision(run.revisionId) : undefined;
    return (revision?.body as { learning?: unknown } | undefined)?.learning;
  } catch {
    return undefined;
  }
}

/** The loop's numbers (learning-setting.ts loopOf) of the revision run `runId` runs: its definition's `learning`. */
async function loopOfRun(store: Store, runId: string) {
  return loopOf(await learningOfRun(store, runId));
}

/** A rewritten workflow.json's text: indented as JSON.stringify indents, or on one line when only that fits CAPS.file. */
const workflowText = (doc: unknown): string => {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  return Buffer.byteLength(text) <= CAPS.file ? text : `${JSON.stringify(doc)}\n`;
};

/** The digest of the failed-draft record run `runId`'s compile keeps (recordDraftFailed): one per run. */
export const draftFailedDigest = (runId: string): string => createHash("sha256").update(`draft-failed\n${runId}`).digest("hex").slice(0, 16);

/** Compile once: run `runId`'s compile turn whose drafts all failed their checks is the compile's attempt, kept as a
 *  promotion record of the shape a check's stop has (runner/promotion.ts stopUnchecked): a hold with nothing checked,
 *  its reason (DRAFT_FAILED) naming the failed checks. A first compile's earns the one recompile, as a check's hold
 *  does (the agent's next due run compiles once more: learn/compile.ts newCompileAttempt); a recompile's (a revision of
 *  a held workflow, or a new one after a first compile's failed drafts) stops (compileStoppedOf, heldNamesOf): nothing
 *  compiles it again. A revision of a connected agent's hold on give-backs is no recompile (runner/promotion.ts
 *  reviseAttemptOf). One record per run (its digest is the run's, and the record is the run's: its purge takes it, and
 *  one written after that purge writes nothing), written once: a claim that ends the run again writes none. */
export async function recordDraftFailed(deps: Pick<LearningEndDeps, "store" | "log">, input: { runId: string; agentId: string; compile: CompileAsk; workflow: string; errors: readonly string[] }): Promise<void> {
  try {
    const records = await promotionsOf(deps.store.learning, input.agentId);
    const attempt = input.compile.mode === "revise" ? reviseAttemptOf(records, input.compile.held) : newCompileAttempt(records);
    const { compile_after, agree_min, alone_min } = await loopOfRun(deps.store, input.runId);
    const workflow = input.compile.mode === "revise" ? input.compile.workflow : input.workflow;
    const digest = draftFailedDigest(input.runId);
    const failed = input.errors.join("; ").slice(0, CHECK_TEXT_MAX) || "no draft passed";
    const reason = `${DRAFT_FAILED}: ${failed}. ${attempt === 2 ? "It was the recompile, so it stops: nothing compiles again until its owner acts" : "It is not promoted; the next due run compiles it once more"}`;
    const check = { compile_after, agree_min, alone_min, attempt, n: 0, agreed: 0, alone: 0, agent_agreed: 0, of: [], ...(attempt === 2 ? { stopped: true as const } : {}) };
    const kept = await recordPromotion(deps.store.learning, input.agentId, { workflow, digest, at: new Date().toISOString(), decided: "hold", reason, check }, (was) => was === undefined, { anyDigest: true, runId: input.runId });
    if (kept.won) deps.log?.(`learning: run ${input.runId}: the compile of ${workflow} failed its checks (attempt ${attempt}${attempt === 2 ? ", stopped" : ""})`);
  } catch (error) {
    deps.log?.(`learning: run ${input.runId}: the compile's failed drafts were not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The most tool calls of one run a trace keeps, and the most of a call's input or a message it holds, in characters. */
const TRACE_CALLS = 20;
const TRACE_TEXT = 600;

/** One earlier run as the compile turn reads it (learn/compile.ts CompileTrace), from its timeline (traceFrom). */
export async function traceOf(store: Store, runId: string, refuse: readonly string[]): Promise<CompileTrace> {
  const [timeline, commands] = await Promise.all([runTimeline(store, runId, BACKGROUND_CONTEXT, { settled: false }), store.commands(runId, 0)]);
  return traceFrom(timeline, refuse, messagesOf(commands));
}

/** A run's trace from its timeline rows, the end-of-run turn's (LEARNING_LABEL) left out: its first message (the
 *  person's, or a trigger's firing: what it was asked), each tool call its job made at the top level, its answer, and
 *  each message the person sent after the first (`user_message`: their feedback), never the server's words (an
 *  approval's resume, which can carry a call's result, a raised cap's follow-up, a hand-back), a trigger's or a grade's
 *  (its feedback round is no turn of the job's: withoutFeedbackRounds); every text cut of `refuse` and every secret's
 *  shape. A person's message is read as ownerWords reads it (`taken`, messagesOf over the run's commands): its `said`
 *  when sent with one, else its whole text. */
export function traceFrom(timeline: readonly TimelineEvent[], refuse: readonly string[], taken: readonly TakenMessage[] = []): CompileTrace {
  const rows = withoutFeedbackRounds(timeline).filter((row) => row.agent_label !== LEARNING_LABEL);
  const shown = { text: (text: string) => redactSecrets(text, refuse, Number.POSITIVE_INFINITY).replace(/\s+/g, " ").trim() };
  const cut = (text: string | null | undefined) => excerptShown(String(text ?? ""), shown, TRACE_TEXT);
  const messages = rows.filter(isMessageRow);
  const failed = new Set(rows.filter((row) => row.kind === "tool_result" && row.tool_status === "failed").map((row) => row.tool_use_id));
  const models = modelsOwn(rows);
  const calls = rows.filter((row) => row.kind === "tool_use" && models(row)).slice(0, TRACE_CALLS).map((row) => ({ tool: cut(row.tool_name), input: cut(row.tool_input_preview), ...(failed.has(row.tool_use_id) ? { failed: true as const } : {}) }));
  const answer = rows.findLast((row) => row.kind === "final_answer")?.text;
  const first = messages[0];
  const words = personWords(messages.slice(1), taken);
  return { input: first ? cut(first.text ?? first.summary) : "", calls, answer: cut(answer), feedback: messages.slice(1).filter((row) => row.kind === "user_message").map((row) => cut(words.get(row))) };
}

/** The compile turn's facts for run `runId` of agent `agentId` (learn/compile.ts): a revision of the learned workflow
 *  that fits the run's input and whose promotion holds it at main's digest (runner/promotion.ts: its one check on the
 *  agent's own runs fell under the bar; its champion served the run, or the agent did by hand), its text as main holds
 *  it, with the check's numbers and the inputs it disagreed on, once per hold (none when any run since the hold was asked
 *  its revise, read from the agent's kept learning; a stopped check's none; a connected agent's hold on give-backs only once it
 *  is due, as a first compile is, on its runs since the hold); else, when the job is due (compileDue: the run
 *  completed, the agent has no learned workflow active or waiting, and it has its definition's compile_after completed
 *  agent runs), a new one, compiled once: one more after a first compile whose drafts all failed their checks, and none
 *  after a recompile's (recordDraftFailed). A draft that passes is on main at once (a learned workflow then), so nothing
 *  waits on it. Nothing else asks one: a hand-back, a wrong grade of a served answer and the money rule's stop are single
 *  runs, which the hold reads among many. Either way the traces of the agent's last COMPILE_TRACES completed runs before
 *  this one, the tools a call node may run (draftTools) with what each takes and gives, its decision providers, the
 *  run's input (`input`, its fields for the workflow's input schema), the agent's output schema when it has one (its
 *  final output's shape) and the DSL's language with this host's addendum. An SDK run's compile, asked outside its
 *  session, also carries the owner's standing corrections it was laid with (`corrections`, its # Learned section), as an
 *  in-session compile reads them in its session; its held workflow is the one its task fits (`sdkTask`: sdkTakes, as its
 *  start reserves a check). Undefined when it compiles nothing, or when the folder can't be read. */
export async function compileAskOf(deps: LearningEndDeps, input: { runId: string; agentId: string; outcome: "completed" | "failed"; refuse: readonly string[]; round?: number; input?: unknown; sdkTask?: string; seedWorkflows?: number; corrections?: string }): Promise<CompileAsk | undefined> {
  const { agentId } = input;
  // A revision is asked only of a workflow its promotion holds, once per hold. The workflows whose newest revision other
  // than their champion (learn/promote.ts championOf: it serves while that one is held) is held: the run's own may be one.
  const records: PromotionRecord[] = await promotionsOf(deps.store.learning, agentId).catch(() => []);
  const heldNames = heldNamesOf(records);
  // The loop's numbers on the agent's definition (the revision this run runs): the first compile waits for compile_after
  // completed agent runs, the ending one counted.
  const { compile_after: compileAfter } = await loopOfRun(deps.store, input.runId);
  // The agent's latest runs, newest first: those after the ending one in the list started before it, and after its
  // learning's reset (sinceReset): a run before the reset is never a compile's trace. None on a named disk: it learns
  // nothing (learn/learning-of.ts).
  const listed = await deps.store.runs.list({ agentId, disk: null, limit: Math.max(200, 2 * compileAfter) });
  const at = listed.findIndex((run) => run.id === input.runId);
  const since = await sinceReset(deps.store, agentId);
  const earlier = (at < 0 ? listed : listed.slice(at + 1)).filter((run) => run.agentId === agentId && since(run));
  const done = earlier.filter(completedRun);
  const own = await lastOwnRuns(deps.store, agentId, compileAfter, input.runId);
  // Due on the agent's own completed runs, the ending one counted.
  const ending = input.outcome === "completed" ? 1 : 0;
  const dueWith = (workflows: number) => compileDue({ completed: ending === 1, runs: own.length + ending, workflows, compileAfter });
  const compiledOf = (kept: LearningProposal | undefined) => (kept?.proposal as { compiled?: { workflow?: unknown; held?: unknown } } | null | undefined)?.compiled;
  // Compile once: a recompile whose drafts failed their checks stopped the agent's new compiles (recordDraftFailed).
  const stopped = compileStoppedOf(records);
  // First by what the run started from (the workflows it was offered): a run not due by them opens no folder, unless one
  // of its workflows is held. Main is read below for the turn itself, and decides again.
  if (!heldNames.size && (stopped || !dueWith(input.seedWorkflows ?? 0))) return undefined;
  const dsl = await import("@parcha/agentrun-dsl");
  // Every text the turn is told passes the check a run's start makes (learning.ts holdsSecret, as chooseWorkflows reads a
  // learned workflow) over what the run must never learn (`refuse`): one that holds a secret is left out whole, never sent
  // cut, and logged by name and count only. A workflow the start left out is never revised from its text either.
  const shown = secretsShown(input.refuse);
  const holds = (value: unknown) => holdsSecret(typeof value === "string" ? value : (JSON.stringify(value) ?? ""), shown);
  const leftOut = { workflows: new Set<string>(), traces: 0, input: false };
  const learning = learningOf(deps.store, input.agentId);
  // `main`: the save the read is at, which `current` was read from.
  let read: { workflows: number; current?: string; held?: PromotionRecord; main?: string };
  try {
    const readFrom = async ({ view, text: textAt }: LearningRead) => {
      const workflows = (view?.workflows ?? []).filter(({ status }) => status === "active" || status === "pending");
      const textOf = async (name: string) => {
        const file = workflows.find((one) => one.name === name)?.files.find(({ path }) => path.endsWith("/workflow.json"));
        const text = file ? textAt(file.path) : undefined;
        if (text === undefined || !(holds(name) || holds(text))) return text;
        leftOut.workflows.add(shown.name(name));
        return undefined;
      };
      let current: string | undefined;
      let held: PromotionRecord | undefined;
      if (heldNames.size) {
        // The one active workflow that fits the run's input (the one workflow-first would serve; an SDK run's, the one its
        // task fits as its start reserves a check), held at main's digest.
        const active: { name: string; workflow: string }[] = [];
        for (const one of workflows) if (one.status === "active" && heldNames.has(one.name)) { const text = await textOf(one.name); if (text !== undefined) active.push({ name: one.name, workflow: text }); }
        const resolve = dsl.resolveSchemaForWorkflow as never;
        const fitting = active.filter((one) => input.sdkTask !== undefined ? sdkTakes(one as never, input.sdkTask, resolve) : fits(one as never, input.input, resolve));
        const record = fitting.length === 1 ? promotionOf(records, fitting[0]!.name, workflowDigest(fitting[0]!)) : undefined;
        if (record?.decided === "hold" && !record.check?.stopped && !record.audit?.stopped) [held, current] = [record, fitting[0]!.workflow];
      }
      return { workflows: workflows.length, ...(current !== undefined ? { current } : {}), ...(held ? { held } : {}), ...(view?.main ? { main: view.main } : {}) };
    };
    // A round that merged already (a crash between its save and its end): the newest save holds its own merge, so the
    // turn is decided again as that merge read it (the save before it), and the replayed answer lands on the merge it
    // made (learn/commit.ts learningCommit: a round merges once), never a drop that leaves its save unrecorded.
    const own = await runMergeOf(learning, input.runId, input.round);
    const before = own ? (own.parent ? await readAt(learning, own.parent) : readOf(undefined)) : undefined;
    read = before ? await readFrom(before) : await readLearning(learning, readFrom);
  } catch {
    return undefined;
  }
  // What it left out, by name and count: said once the facts are gathered, or now when it asks nothing.
  const sayLeftOut = () => {
    const parts = [...[...leftOut.workflows].map((name) => `workflow \`${name}\``), ...(leftOut.traces ? [`${leftOut.traces} earlier run${leftOut.traces === 1 ? "" : "s"}`] : []), ...(leftOut.input ? ["the run's input"] : [])];
    if (parts.length) deps.log?.(`learning: run ${input.runId}: the compile turn left out what holds a secret: ${parts.join(", ")}`);
  };
  let held: HeldAsk | undefined;
  if (read.held) {
    // A give-back hold revises at a first compile's cadence: compile_after own completed runs started after the hold (the turn that wrote it is not one).
    const heldAt = Date.parse(read.held.at);
    const after = (run: { readonly startedAt: number } | undefined) => run !== undefined && run.startedAt > heldAt;
    const sinceHold = own.filter(after).length + (after(listed[at]) ? ending : 0);
    if (heldOnGiveBacks(read.held.check) && !(ending === 1 && sinceHold >= compileAfter)) return sayLeftOut(), undefined;
    // Once per hold: a run since it that was asked this hold's revise (its compile record names the held digest) asked
    // already, whatever came of it (its revision is on its way to a replay, or its draft failed its checks), however many
    // runs ago. A new compile asked before the hold (in flight as it was decided) that drafted the same workflow and ended
    // after it is no revise. Read from the agent's kept learning since the hold, never a window of its last runs; one that
    // can't be read asks nothing. A draft that failed since, not stopped (only a revise of a connected agent's hold on
    // give-backs: reviseAttemptOf), asks once more: counted from it, its own run's kept learning (written after its record,
    // at the run's end) not counted.
    const failed = records.findLast((one) => one.workflow === read.held!.workflow && draftFailedOf(one) && !one.check?.stopped && !(one.at < read.held!.at));
    const since = Date.parse(failed?.at ?? read.held.at);
    const kept = await deps.store.learning.proposals(agentId, { limit: HELD_ASKED_READ }).catch(() => undefined);
    const asked = (one: LearningProposal) => !(one.createdAt < since) && compiledOf(one)?.workflow === read.held!.workflow && compiledOf(one)?.held === read.held!.digest && draftFailedDigest(one.runId) !== failed?.digest;
    if (!kept || kept.some(asked)) return sayLeftOut(), undefined;
    const { workflow, digest, reason, check, audit } = read.held;
    // A check's or an audit's disagreements are the agent's own inputs and answers: cut of the run's secrets as a trace is
    // (traceFrom).
    const cut = (text: string) => redactSecrets(text, input.refuse, Number.POSITIVE_INFINITY);
    const checked = check ? { ...check, ...(check.disagreements ? { disagreements: check.disagreements.map((one) => ({ ...one, input: cut(one.input), agent: one.agent === null ? null : cut(one.agent), ...(one.draft !== undefined ? { draft: cut(one.draft) } : {}), ...(one.escalated !== undefined ? { escalated: cut(one.escalated) } : {}) })) } : {}) } : undefined;
    const audited = audit ? { ...audit, disagreements: audit.disagreements.map((one) => ({ ...one, input: cut(one.input), agent: one.agent === null ? null : cut(one.agent), draft: one.draft === null ? null : cut(one.draft) })) } : undefined;
    held = { workflow, digest, reason, ...(checked ? { check: checked } : {}), ...(audited ? { audit: audited } : {}) };
  }
  if (!held && (stopped || !dueWith(read.workflows))) return sayLeftOut(), undefined;
  // An earlier run's trace is cut of each value it held (traceFrom); one that still holds a secret (a value in a call's
  // input spelled in JSON escapes, a shape the cut does not take) is left out whole.
  const traces = (await Promise.all(done.slice(0, COMPILE_TRACES).reverse().map((run) => traceOf(deps.store, run.id, input.refuse).catch(() => undefined)))).filter((one): one is CompileTrace => {
    if (one === undefined) return false;
    if (!holds(one)) return true;
    leftOut.traces += 1;
    return false;
  });
  const { tools, decisions, outputSchema, workflowAdapters, described: sdkCatalog } = await draftTools(deps, input.runId);
  const allowed = draftDecisionProviders(decisions);
  const judges = workflowAdapters !== undefined ? workflowAdapters.includes("runJudge") : allowed.length > 0;
  const described = sdkCatalog ?? await describedOf(tools, deps.store);
  const object = input.input !== null && typeof input.input === "object" && !Array.isArray(input.input);
  leftOut.input = object && holds(input.input);
  const fields = object && !leftOut.input ? { input: input.input as Record<string, unknown> } : {};
  // An SDK compile is one request outside the run's session: it carries the corrections the session was laid with.
  const bridge = workflowAdapters !== undefined ? { workflowAdapters } : {};
  const corrections = workflowAdapters !== undefined && input.corrections?.trim() ? { corrections: input.corrections } : {};
  const base = { ...bridge, ...corrections, reference: compileReference(dsl, { tools, judges, ...bridge }), traces, tools, described, judges, ...fields, ...(outputSchema !== undefined ? { outputSchema } : {}) };
  // A revision is of main's text as read here, whatever the run started from: that commit is its conflict base (`base`).
  const ask: CompileAsk = !held ? { mode: "new", ...base } : { mode: "revise", workflow: held.workflow, current: read.current!, ...(read.main ? { base: read.main } : {}), held, ...base };
  sayLeftOut();
  // Last, the prompt itself, whatever it is told now or later (a tool's description, the agent's output schema): one that
  // still holds a secret asks nothing.
  if (holds(compilePrompt(ask))) {
    deps.log?.(`learning: run ${input.runId}: the compile turn asked nothing: its prompt holds a secret`);
    return undefined;
  }
  return ask;
}

/** The tools a workflow draft may name: the revision's own, as its run's gate reads them with the server's settings
 *  (from the store) and the agent's, or an SDK run's manifest (`manifest`, its prices with it); none for a workflow
 *  revision. */
async function draftTools(deps: LearningEndDeps, runId: string): Promise<{ tools: string[]; gated: Record<string, string>; deniedBy: Record<string, "agent" | "server" | "default">; decisions?: DraftDecisions; outputSchema?: unknown; workflowAdapters?: readonly ("runNode" | "runJudge")[]; described?: { name: string; does: string }[]; manifest?: readonly SdkWorkflowTool[] }> {
  const run = await deps.store.runs.get(runId);
  const launch = run ? readLaunchBody((await deps.store.runs.launch(runId)).body) : undefined;
  const revision = run ? await deps.store.agents.revision(run.revisionId) : undefined;
  if (revision?.kind !== "agentic") return { tools: [], gated: {}, deniedBy: {} };
  const body = revision.body as { tools?: string[]; toolSettings?: unknown; approvals?: string; outputSchema?: unknown };
  // The agent's output schema, which a learned workflow's answer is served shaped to (answer-json.ts answerAsServed): the
  // compile turn is told it and a draft's dry run holds its answer to it.
  const shaped = body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {};
  if (launch?.sdk?.workflow_tools) {
    const catalog = sdkDraftTools(launch.sdk.workflow_tools);
    return { ...catalog, ...shaped, workflowAdapters: launch.sdk.workflow_adapters ?? [], manifest: launch.sdk.workflow_tools, described: sdkDescribed(launch.sdk.workflow_tools.filter(tool => catalog.tools.includes(tool.name))) };
  }
  const [{ learnedDraftTools }, { permissionFrom }, { loadToolSettings }] = await Promise.all([import("../tools.js"), import("../tool-gate.js"), import("../tool-plane.js")]);
  // The server's settings from the one store, as the run's gate reads them: a stored row that does not read carries
  // SETTINGS_UNREAD, which permissionFrom honours (no ask is lifted over a deny the row may hold).
  const server = (await loadToolSettings(deps.store)).settings;
  const agent = (body.toolSettings ?? {}) as never;
  const approvals = body.approvals === "never" ? "never" : "ask";
  // `deniedBy`: where each deny was set (the agent's tool settings, the server's, a default), which a refused draft's
  // words name.
  const { tools, gated, deniedBy } = learnedDraftTools(body.tools ?? [], (name) => permissionFrom(name, server as never, agent, approvals).permission, undefined, (name) => permissionFrom(name, server as never, agent, approvals).from, { mcp: true, approvers: await readApprovers(deps.store.settings) });
  // A draft's decision nodes (LS-07): the host's decision providers, each held to the gate by its bare id as the run's
  // gate holds it (tool-plane.ts DECISION_PROVIDER_KEYS); deny alone refuses one.
  const providers = await deps.decisionProviders?.();
  if (!providers) return { tools, gated, deniedBy, ...shaped };
  const decided: Record<string, string> = {};
  const decisionDeniedBy: Record<string, "agent" | "server" | "default"> = {};
  for (const id of DECISION_PROVIDER_KEYS) {
    const { permission, from } = permissionFrom(id, server as never, agent, approvals);
    if (permission === "allow") continue;
    decided[id] = permission;
    if (permission === "deny") decisionDeniedBy[id] = from as "agent" | "server" | "default";
  }
  return { tools, gated, deniedBy, decisions: { providers: providers.providers, default: providers.default, gated: decided, deniedBy: decisionDeniedBy }, ...shaped };
}
