// Promotion by replay, at a run's claim (champion/challenger, shadow deployment): the learned workflow that fits the run's
// input serves first only when its digest is promoted (learn/promote.ts). A digest with no record yet is replayed on the
// agent's last REPLAY_INPUTS graded inputs (runs a person or an eval graded, PUT /runs/{id}/grade, answered by the agent or
// by a learned workflow alone): each a queued replay run of its own (RunLaunch.replay, at workflow cost, its guards record-only), the agent
// taking the runs meanwhile. A later claim that finds every replay run ended scores them (learn/refit.ts scoreRows at the serving
// thresholds: a hand-back is the agent's recorded answer) and promotes the digest when it is within PROMOTE_BAR of the
// agent path and answers alone on at least one input, else holds it; a held digest gets one refit over the replay's rows
// (learn/refit.ts: its guards' thresholds, and its guards and recorded escalates on or off), a new revision that serves
// when the refit clears the bar. A replay records an escalate that reads a judge's field instead of obeying it
// (learn/promote.ts softEscalatesOf): it scores as a hand-back where it fired, and the refit may switch it off. Fewer than
// REPLAY_MIN graded inputs: the digest is promoted on its passing dry run, as before, and its record says so. A serving
// digest is checked once per REFIT_EVERY more graded runs it served: its thresholds refit (a new revision when they move
// and still clear the bar), and held when its graded runs fall below the bar. A hand-back is the agent's answer, never a
// failure; but a revision that hands back every input it replayed would never answer alone, and is held.
// The champion keeps serving meanwhile: while the folder's revision (the challenger) replays, or once it is held, the
// digest promoted last (learn/promote.ts championOf) serves the run, read from the learning commit its record names, so
// a wrong served grade asks for a revision and never stops the workflow serving. The challenger serves once its replay
// promotes it. Only the money rule (workflow-first.ts) and a graded hold of the champion itself stop it. Who serves is
// the champion alone, read at every run's claim, a queued run's included (servingNow): a digest's own promote record
// never serves it once another digest was promoted after it, nor once the champion is held (then the agent). A run
// already executing (an earlier claim of it served a workflow first) keeps that revision (keptFor).
// One challenger at a time: the newest revision (the one the learning folder's main holds now: a claim pinned to an
// older commit never counts as newer, whenever it was launched) supersedes the revision still replaying: that one's replay
// runs are cancelled (in-flight ones stop as any cancelled run does, what they spent stays booked on their rows), and
// none runs after: a replay run's claim refuses it unless its revision still replays (replayClaimed), so a cancel lost
// to a crash or a failed write never leaves one running. Its record says superseded. The newer revision is compiled on
// the folder's main, the challenger's own text, so it already carries that change. The challenger is reserved before any
// of its replay runs starts: its replaying record, naming the runs it will start, is kept only while no other revision of
// the workflow replays (the rival check in the same guarded write), so two claims of two revisions at once start one
// replay. A reserved run not created yet is pending, never ended: a claim between the reservation and the creates decides
// nothing, and a launch interrupted there (a crash, a failed create) is finished by a claim REPLAY_LAUNCH_GRACE_MS on, each
// run under its reserved id on the graded input its record names (relaunch). Every decision is acted on (replay runs started, a refit written, runs cancelled) only by the claim whose write
// kept it (learn/promote.ts Recorded.won). A replay decided with runs still at work (its deadline passed) cancels them.
// A replay never repeats a side effect and runs with what a served run of the agent has (learn/replay-calls.ts, SPEC B4):
// each call node's tool is a read or a write; a read runs live through a cache seeded from the graded run's recorded calls,
// a write is answered only from that recording (same tool, same canonical arguments) and is never sent, and an input whose
// workflow needs a write the recording does not have is skipped (counted in the record's replay.skipped_write, never
// scored); a replay whose every input was skipped holds the revision in those words, or, when the tool that stopped them
// is an MCP tool its server listed with no readOnlyHint, naming it (replay.skipped_tools). Its credentials resolve at its claim
// as any run's of the agent do: saved ones from the server's store, and the per_run MCP credentials the run whose claim
// started it was handed, sealed anew for the replay run alone (startReplay), never opened outside the claim.
// Its owner may start one too (askReplay, POST .../revisions/{digest}/replays): a held revision re-checked, or an edited
// one, on the inputs it was last decided on or the newest graded ones. The same reservation and replay runs (handed no
// per_run MCP credentials: no claimed run handed any), decided by the same settle, at a claim that lays it or at its read
// (replayView), so its records are a claim-started replay's.
import type { Context } from "@earendil-works/chord/context";
import type { LearnedWorkflow } from "../learning.js";
import { LEARNING_LABEL } from "../learning.js";
import type { GuardRow } from "../learned-nodes.js";
import { launchBody, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { uuidv7 } from "../runs-over-store.js";
import { FINAL_STATES, RunFinal, type RunRow, type Store, StoreConstraint } from "../store/store.js";
import { openRunMcpAuth, sealRunMcpAuth } from "../store/seal.js";
import { isCliRecord, piShaped, runEntries, runTimeline } from "../store-reads/journal.js";
import type { McpPin } from "../mcp-gateway.js";
import { recordedCalls, type ReplayCalls, replayCalls, SKIPPED_WRITE, toolClassOf, toolWord, unmarkedWords } from "../learn/replay-calls.js";
import { isObject, type Json } from "../validate.js";
import { answersAlone, championOf, clears, type Grade, gradesOf, PROMOTE_BAR, type PromotionRecord, promotionOf, promotionsOf, recordPromotion, REFIT_EVERY, REPLAY_INPUTS, REPLAY_MIN, type ReplayOutcomes, type ReplayRow, type ReplayScore, replayingOf, skippedToolsOf, thresholdsOf } from "../learn/promote.js";
import { sendCommand } from "./commands.js";
import { ClaimRefused } from "./loop-contract.js";
import { readSnapshot } from "../learn/folder.js";
import { type RefitRow, refitGuards, refitRowsOf, scoreRows } from "../learn/refit.js";
import { type FirstChoice, fits, type Promoted, servedOf, workflowDigest } from "./workflow-first.js";
import { learningCommit } from "../learn/commit.js";
import type { LearningFolder } from "../learn/folder.js";
import { recordOnly } from "../learn/promote.js";
import type { Shown } from "../learning.js";
import { workflowsAt } from "./learning-seed.js";

/** A replay run still not ended this long after its replay started counts as failed (no evidence), and is cancelled once
 *  the replay is decided without it. */
export const REPLAY_DEADLINE_MS = 60 * 60 * 1000;
/** A reserved replay run still not created this long after its record was reserved is a launch that was interrupted (the
 *  reserving claim crashed, or its create failed): the next claim creates it (relaunch). Before then it is pending. */
export const REPLAY_LAUNCH_GRACE_MS = 5 * 60 * 1000;

export interface PromotionDeps {
  readonly store: Store;
  readonly agentId: string;
  /** The run being claimed: never one of its own replay's inputs. */
  readonly runId: string;
  /** The revision the claimed run runs: its replay runs run it too. */
  readonly revisionId: string;
  /** The claimed run's launch: a replay run's is this one with the graded run's input. */
  readonly launch: RunLaunch;
  readonly context: Context;
  readonly log: (line: string) => void;
  /** Writes a refit's new workflow text onto the agent's learning folder (a merge as `id`, from the claim's seed); the
   *  learning commit it landed as, or null when it did not. Absent: no refit is written. */
  readonly commit?: (files: { path: string; text: string }[], reason: string, id: string) => Promise<string | null>;
  /** The learned workflow `name` as the learning folder held it active at `commit` (a champion's text), or undefined when
   *  it held none by that name. Absent: no champion serves. */
  readonly champion?: (name: string, commit: string) => Promise<LearnedWorkflow | undefined>;
  /** The digest of the learned workflow `name` the learning folder's main holds now (the newest revision), or undefined
   *  when it holds none by that name. Absent: no revision supersedes another. */
  readonly newest?: (name: string) => Promise<string | undefined>;
  /** The learned workflow an earlier claim of this run served first (its WORKFLOW_FIRST entry, answered or handed back:
   *  workflow-first.ts servedOf), or undefined for a run no claim served yet: a run already executing keeps its revision
   *  (keptFor). Absent: none kept. */
  readonly kept?: () => Promise<{ readonly workflow: string; readonly digest?: string } | undefined>;
  /** The server's seal key: a replay run is handed the per_run MCP credentials the claimed run was handed, sealed for it
   *  (startReplay). Absent: a replay run is handed none (a per_run server's calls are refused unsent, the input failed). */
  readonly sealKey?: Buffer;
  readonly now?: () => number;
}

/** The claim's promotion ports: `folder`, the agent's learning folder where the run's place keeps it, a refit's revision
 *  written on it as a merge from the claim's seed (a workflow.json changed on main since is a conflict, never written over),
 *  and a champion read from it at its record's commit, cut of the server's secrets (`shown`) as the claim's lay is; and
 *  the workflow an earlier claim of this run served (`kept`, from its journal: none on a first claim). */
export function claimPromotion(deps: Omit<PromotionDeps, "commit" | "champion" | "kept"> & { readonly folder: () => LearningFolder; readonly shown: () => Promise<Shown> }): PromotionDeps {
  const seed = deps.launch.learning?.seed;
  return {
    ...deps,
    kept: async () => servedOf(await runEntries(deps.store, deps.runId, deps.context).catch(() => [])),
    commit: async (files, reason, id) => {
      const folder = deps.folder();
      try {
        const done = await learningCommit(folder.workspace, { kind: "merge", runId: id, reason, files, graded: {}, ...(seed ? { seed } : {}) });
        if (!done.ok) deps.log(`workflow-first: a refit could not be written (${done.reason})`);
        return done.ok ? done.commit : null;
      } finally {
        await folder.end();
      }
    },
    champion: async (name, commit) => (await workflowsAt({ folder: deps.folder, shown: deps.shown }, commit)).find((one) => one.name === name),
    newest: async (name) => {
      const folder = deps.folder();
      let main: string | undefined;
      try {
        main = (await readSnapshot(folder.workspace))?.main;
      } finally {
        await folder.end().catch(() => undefined);
      }
      const text = main ? (await workflowsAt({ folder: deps.folder, shown: deps.shown }, main)).find((one) => one.name === name) : undefined;
      return text ? workflowDigest(text) : undefined;
    },
  };
}

/** A replay run's claim (launch.replay) of run `runId`, once its first choice is made: refused (ClaimRefused: the run ends
 *  failed, no agent turn, nothing sent) unless its revision's record still says replaying and names it among its runs (it
 *  is reserved before its runs are created), or has none (trimmed), and the claim laid that revision to serve it. A
 *  superseded, promoted or held revision's replay run never runs (a cancel that never reached it included), nor an older
 *  replay's leftover once its revision replays again; one whose workflow is not laid at its digest (the seed could not be
 *  read, the folder moved on) never falls to the agent's path. Any other run: nothing to check. */
export async function replayClaimed(store: Pick<Store, "settings">, agentId: string, runId: string, launch: RunLaunch, choice: FirstChoice): Promise<void> {
  if (!launch.replay) return;
  const { workflow, digest } = launch.replay;
  const record = promotionOf(await promotionsOf(store.settings, agentId), workflow, digest);
  if (record && record.decided !== "replaying") throw new ClaimRefused(`This replay of ${workflow} at ${digest} did not run: that revision is ${record.decided === "superseded" ? `superseded by ${record.superseded_by ?? "a newer revision"}` : record.decided === "promote" ? "promoted already" : "held already"}.`);
  if (record && !record.runs?.includes(runId)) throw new ClaimRefused(`This replay of ${workflow} at ${digest} did not run: that revision replays again${record.replay_id ? ` (replay ${record.replay_id})` : ""}, and this run is not one of its runs.`);
  if (choice.serve?.replay !== true || choice.serve.name !== workflow) throw new ClaimRefused(`This replay of ${workflow} at ${digest} did not run: its claim laid no workflow by that name at that digest. The agent was not asked.`);
}

/** The workflows a replay run's claim lays (`laid`, the seed lay's): the one it replays record-only (learn/promote.ts
 *  recordOnly: every guard at the least threshold the DSL takes, so each step's p is read and none hands back on it), or none by that name when
 *  the laid one is not the digest it replays (the replay then fails, never scoring another revision). Any other run's,
 *  as laid. */
export function replayLaid(launch: RunLaunch, laid: readonly LearnedWorkflow[]): LearnedWorkflow[] {
  if (!launch.replay) return [...laid];
  const { workflow, digest } = launch.replay;
  return laid.flatMap((one) => (one.name !== workflow ? [one] : workflowDigest(one) === digest ? [{ ...one, workflow: recordOnly(one.workflow) }] : []));
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The claim's seed as a record's `commit`: the learning commit the laid workflow's text was read from. */
const seedOf = (deps: Pick<PromotionDeps, "launch">): { commit?: string } => (deps.launch.learning?.seed ? { commit: deps.launch.learning.seed } : {});
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The gate workflowFirstOf asks (its `promoted`), at every run's claim, a queued run's included: the workflow that serves
 *  this run first. A run already executing keeps the revision an earlier claim of it served (keptFor). Else the laid
 *  revision (`workflow` at `digest`, the folder's revision as the run's seed holds it) has its promotion moved on (decide:
 *  a replay started, settled or superseded, a dry-run promote), and then servingNow alone says who serves: the champion
 *  (championOf), the laid text when it is the champion, its own text read from its record's commit when not; undefined
 *  when none serves (the agent takes the run). A digest's own record never says it serves. */
export const promotionGate = (deps: PromotionDeps): Promoted => {
  const failed = (workflow: LearnedWorkflow, error: unknown) => {
    // A promotion that could not be read or written leaves the run to its agent: never a workflow served unchecked.
    deps.log(`workflow-first: ${workflow.name}'s promotion could not be read (${(error as Error)?.message ?? error}); the agent takes this run`);
    return undefined;
  };
  const gate = async (workflow: LearnedWorkflow, digest: string): Promise<LearnedWorkflow | undefined> => {
    try {
      const kept = await keptFor(deps, workflow, digest);
      if (kept) return kept;
      await decide(deps, workflow, digest);
      return await servingNow(deps, workflow, digest, true);
    } catch (error) {
      return failed(workflow, error);
    }
  };
  // The champion alone, for a laid revision that does not take the run's input (workflowFirstOf): nothing replays.
  const champion = async (workflow: LearnedWorkflow, digest: string): Promise<LearnedWorkflow | undefined> => {
    try {
      return (await keptFor(deps, workflow, digest)) ?? (await servingNow(deps, workflow, digest, false));
    } catch (error) {
      return failed(workflow, error);
    }
  };
  return Object.assign(gate, { champion });
};

/** Who serves `workflow` now, the one answer every serving path asks: its champion (championOf, read fresh from the
 *  records), never a digest's own record, so a revision promoted before another was (or before the champion was held)
 *  never serves again. The laid revision at `digest` when it is the champion and still serves after its graded check
 *  (stillServing, a refit written as the next revision); `laid` false: it is not asked (the laid text does not take the
 *  input). Another champion: its text at its record's commit (its digest checked), still serving after its graded check
 *  with no refit (a refit written now would land over the laid revision on the folder's main). Undefined when none
 *  serves: none promoted, the champion held, or its text cannot be read (the agent takes the run). */
async function servingNow(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, laid: boolean): Promise<LearnedWorkflow | undefined> {
  const records = await promotionsOf(deps.store.settings, deps.agentId);
  const champion = championOf(records, workflow.name);
  const own = promotionOf(records, workflow.name, digest);
  if (!champion) {
    if (own?.decided === "promote") deps.log(`workflow-first: ${workflow.name} at ${digest} was promoted, but the revision promoted after it is held; no revision serves, the agent takes this run`);
    return undefined;
  }
  if (champion.digest === digest) return laid && (await stillServing(deps, workflow, digest, champion)) ? workflow : undefined;
  if (!deps.champion) return undefined;
  const text = champion.commit ? await deps.champion(workflow.name, champion.commit).catch(() => undefined) : undefined;
  if (!text || workflowDigest(text) !== champion.digest) {
    deps.log(`workflow-first: ${workflow.name}'s champion at ${champion.digest} could not be read from its learning commit; the agent takes this run`);
    return undefined;
  }
  if (!(await stillServing({ ...deps, commit: undefined }, text, champion.digest, champion))) return undefined;
  deps.log(`workflow-first: ${workflow.name}'s champion at ${champion.digest} serves this run while ${digest} ${own?.decided === "promote" ? "is a revision promoted before it" : "is not promoted"}`);
  return text;
}

/** A run already executing keeps its revision: when an earlier claim of it served `workflow` first (its WORKFLOW_FIRST
 *  entry, answered or handed back: `deps.kept`), a re-claim serves the same digest, whoever the champion is now (the loop
 *  recovers that outcome as it is, never runs it again). The laid text at that digest, else its text at its record's
 *  commit; the laid one stands in when that cannot be read (the kept outcome is recovered all the same). Undefined for a
 *  run no claim served yet. */
async function keptFor(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string): Promise<LearnedWorkflow | undefined> {
  const kept = deps.kept ? await deps.kept().catch(() => undefined) : undefined;
  if (!kept || kept.workflow !== workflow.name || !kept.digest) return undefined;
  if (kept.digest !== digest) {
    // Its newest record naming a commit: a graded hold since names none.
    const record = (await promotionsOf(deps.store.settings, deps.agentId)).findLast((one) => one.workflow === workflow.name && one.digest === kept.digest && one.commit);
    const text = record?.commit && deps.champion ? await deps.champion(workflow.name, record.commit).catch(() => undefined) : undefined;
    if (text && workflowDigest(text) === kept.digest) {
      deps.log(`workflow-first: ${workflow.name} at ${kept.digest} served this run on an earlier claim; it keeps that revision`);
      return text;
    }
  }
  deps.log(`workflow-first: ${workflow.name} at ${kept.digest} served this run on an earlier claim; it keeps that revision${kept.digest === digest ? "" : ` (its text could not be read: the laid ${digest} stands in, the kept outcome recovered as it is)`}`);
  return workflow;
}

/** Moves the laid revision's promotion on: a new digest is replayed (or promoted on its dry run), a replaying one
 *  settled once its runs ended, a rival replay superseded. It decides nothing about who serves (servingNow does). */
async function decide(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string): Promise<void> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const record = promotionOf(await promotionsOf(store.settings, agentId), workflow.name, digest);
  if (record?.decided === "promote") return;
  if (record?.decided === "hold") {
    log(`workflow-first: ${workflow.name} at ${digest} is held (${record.reason}); it does not serve this run`);
    return;
  }
  if (record?.decided === "superseded") {
    log(`workflow-first: ${workflow.name} at ${digest} was superseded by ${record.superseded_by ?? "a newer revision"} while it replayed; it does not serve this run`);
    return;
  }
  if (record?.decided === "replaying") {
    await relaunch(deps, workflow, digest, record);
    const decided = await settle(deps, workflow, digest, record);
    if (!decided) log(`workflow-first: ${workflow.name} at ${digest} is replaying on ${plural(record.runs?.length ?? 0, "graded input")}; it does not serve this run`);
    return;
  }
  // A new revision. One challenger at a time: one still replaying is superseded by it when it is the newest revision (the
  // one the learning folder's main holds now); a run pinned to an older commit lays an older text, and starts nothing,
  // whenever it was launched.
  const rivals = replayingOf(await promotionsOf(store.settings, agentId), workflow.name, digest);
  if (rivals.length) {
    const newest = deps.newest ? await deps.newest(workflow.name) : undefined;
    if (newest !== digest) {
      log(`workflow-first: ${workflow.name} at ${digest} is not the learning folder's newest revision of it (${newest ?? "unknown"}), and ${rivals[0]!.digest} replays; it does not serve this run`);
      return;
    }
    for (const rival of rivals) await supersede(deps, rival, digest);
  }
  const graded = await gradedInputs(deps, workflow);
  if (graded.length < REPLAY_MIN) {
    const reason = graded.length ? `${plural(graded.length, "graded input")} it fits, fewer than ${REPLAY_MIN}: promoted on its passing dry run` : `no graded input it fits: promoted on its passing dry run`;
    const kept = await recordPromotion(store.settings, agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "promote", source: "dry_run", reason, ...seedOf(deps) }, (was) => was === undefined);
    if (kept.won) log(`workflow-first: ${workflow.name} at ${digest}: ${reason}`);
    return;
  }
  const reserved = await reserve(deps, workflow, digest, graded, `replaying on the agent's last ${plural(graded.length, "graded input")} it fits`, (was) => was === undefined);
  if (!reserved.won) {
    const rival = reserved.record ? undefined : replayingOf(await promotionsOf(store.settings, agentId), workflow.name, digest)[0];
    if (rival) log(`workflow-first: ${workflow.name} at ${digest}: ${rival.digest} began replaying first; it does not serve this run`);
    return;
  }
  log(`workflow-first: ${workflow.name} at ${digest} is new: replaying it on the agent's last ${plural(graded.length, "graded input")} before it serves`);
}

/** Reserves a replay of `workflow` at `digest` on `graded`, then starts its runs: its replaying record names the replay
 *  runs it will start (their ids, and the replay's own, minted here), kept only when `still` holds of the digest's record
 *  now and no other revision of the workflow replays, in the one guarded write. Only the writer that kept it starts them:
 *  a claim of the same digest, or of another revision, or a person's ask, at once, starts none. A claim's (decide) and a
 *  person's (askReplay) are this one reservation. */
async function reserve(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, graded: readonly GradedInput[], reason: string, still: (was: PromotionRecord | undefined) => boolean) {
  const now = deps.now ?? Date.now;
  const ids = graded.map(() => uuidv7());
  const reserved = await recordPromotion(deps.store.settings, deps.agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "replaying", source: "replay", reason, runs: ids, inputs: graded.map((one) => one.grade.run), replay_id: uuidv7(), ...seedOf(deps) },
    (was, items) => still(was) && replayingOf(items, workflow.name, digest).length === 0);
  if (reserved.won) for (const [i, one] of graded.entries()) await startReplay(deps, workflow, digest, one.grade.run, one.launch, ids[i]!);
  return reserved;
}

/** Whether `was`, a digest's newest record now, is still the replay `record` reserved: replaying, under the same replay
 *  id. A replay settled or superseded meanwhile, and a newer replay of the same revision its owner started since (a held
 *  revision may be replayed again), are not: an older replay's late decision never lands over a newer one. */
const sameReplay = (was: PromotionRecord | undefined, record: PromotionRecord): boolean => was?.decided === "replaying" && was.replay_id === record.replay_id;

/** Supersedes `record`, a revision still replaying, by the newer revision at `by`: its record decided superseded (kept only
 *  while it is still that replay, sameReplay: a replay that settled first keeps its decision), then its replay runs not
 *  ended are cancelled (cancelUnended) by the claim whose write kept it. */
async function supersede(deps: PromotionDeps, record: PromotionRecord, by: string): Promise<void> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const runs = record.runs ?? [];
  const reason = `superseded by ${by}, a newer revision, while it replayed: its replay runs were cancelled`;
  const kept = await recordPromotion(store.settings, agentId, {
    workflow: record.workflow, digest: record.digest, at: iso(now()), decided: "superseded", source: "replay", reason, superseded_by: by,
    ...(runs.length ? { runs } : {}), ...(record.commit ? { commit: record.commit } : {}), ...(record.replay_id ? { replay_id: record.replay_id } : {}),
  }, (was) => sameReplay(was, record));
  if (!kept.won) return;
  const cancelled = await cancelUnended(deps, record);
  log(`workflow-first: ${record.workflow} at ${record.digest} superseded by ${by} while it replayed; ${plural(cancelled, "replay run")} cancelled`);
}

/** Cancels each of `record`'s replay runs not ended, as a person's cancel is (an in-flight one stops, what it spent booked
 *  on its row): once its revision is superseded, or decided with runs still at work. How many were sent their cancel. The
 *  record is the durable half: a cancel that is lost (a crash after the record, a write that fails) leaves a run whose
 *  claim refuses it (replayClaimed: its revision no longer replays), so each cancel is tried and a failed one only logged. */
async function cancelUnended(deps: PromotionDeps, record: PromotionRecord): Promise<number> {
  const { store, log } = deps;
  let cancelled = 0;
  for (const id of record.runs ?? []) {
    const row = await store.runs.get(id);
    if (!row || FINAL_STATES.includes(row.state)) continue;
    try {
      await sendCommand(store, id, { kind: "cancel", body: {} });
      cancelled += 1;
    } catch (error) {
      if (!(error instanceof RunFinal)) log(`workflow-first: replay run ${id} of ${record.workflow} at ${record.digest} was not sent its cancel (${(error as Error)?.message ?? error}); its claim refuses it`);
    }
  }
  return cancelled;
}

/** A graded input a replay runs on: the graded run, its grade, its launch. */
type GradedInput = { readonly grade: Grade; readonly launch: RunLaunch };

/** The paths a graded run a replay runs on took: the agent's (`agent`, or `handed_back`: the agent finished it), or a
 *  learned workflow's alone (`workflow`). Each has a recorded answer (the run's final answer, whoever wrote it) and its
 *  grade, which is all a replay scores against (answerCorrect reads the grade, not the path); a replay run never is one. */
const REPLAYABLE: ReadonlySet<string> = new Set(["agent", "handed_back", "workflow"]);

/** The agent's newest graded runs a replay runs on (REPLAYABLE), newest first: at most REPLAY_INPUTS, or `pick.n`; only
 *  the runs `pick.of` names when given (a revision's held inputs). Each with a launch read back, no uploaded file, an input
 *  `workflow` fits, never the run being claimed, nor an archived or imported one. */
async function gradedInputs(deps: Pick<PromotionDeps, "store" | "agentId" | "runId">, workflow: LearnedWorkflow, pick: { readonly of?: readonly string[]; readonly n?: number } = {}): Promise<GradedInput[]> {
  const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
  const out: GradedInput[] = [];
  const most = pick.of?.length ?? pick.n ?? REPLAY_INPUTS;
  const grades = (await gradesOf(deps.store.settings, deps.agentId)).filter((grade) => REPLAYABLE.has(grade.path) && (!pick.of || pick.of.includes(grade.run)));
  for (const grade of grades.reverse()) {
    if (out.length >= most) break;
    if (grade.run === deps.runId) continue;
    const row = await deps.store.runs.get(grade.run);
    if (!row || row.archivedAt !== null || row.importedFrom) continue;
    const launch = await deps.store.runs.launch(grade.run).then((one) => readLaunchBody(one.body), () => undefined);
    if (!launch || launch.files?.length || launch.replay || !fits(workflow, launch.input, resolveSchemaForWorkflow as never)) continue;
    out.push({ grade, launch });
  }
  return out;
}

/** The per_run MCP credentials the claimed run was handed (its launch's sealed column, opened under the seal key), sealed
 *  for the replay run `id` alone, as the server's start seals a run's mcp_auth (store/seal.ts sealRunMcpAuth): the replay's
 *  claim reads them where any run's claim does (runner/mcp-claim.ts). None when the claimed run was handed none, or they
 *  do not open. Never written anywhere else, never logged. */
async function handedTo(deps: PromotionDeps, id: string): Promise<Uint8Array | undefined> {
  if (!deps.sealKey) return undefined;
  const sealed = await deps.store.runs.launch(deps.runId).then((one) => one.sealed ?? null, () => null);
  const handed = sealed === null ? undefined : openRunMcpAuth(deps.sealKey, deps.runId, sealed);
  return handed && Object.keys(handed).length ? sealRunMcpAuth(deps.sealKey, id, handed) : undefined;
}

/** Starts the replay of `workflow` at `digest` on graded run `of` (its launch `from`) as run `id` (the id its reserved
 *  record names), with the claimed run's handed credentials (handedTo). False when a run by that id exists already:
 *  another claim created it (a relaunch and the reserving claim at once), and it is left to that one. */
async function startReplay(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, of: string, from: RunLaunch, id: string): Promise<boolean> {
  const { store, agentId, launch } = deps;
  const replay: RunLaunch = {
    input: from.input,
    title: `Replay of ${workflow.name}: ${from.title}`.slice(0, 200),
    place: launch.place,
    ...(launch.harness !== undefined ? { harness: launch.harness } : {}),
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
    ...(launch.maxCostUsd !== undefined ? { maxCostUsd: launch.maxCostUsd } : {}),
    ...(launch.capMode !== undefined ? { capMode: launch.capMode } : {}),
    ...(launch.plane ? { plane: launch.plane } : {}),
    ...(launch.approvers !== undefined ? { approvers: launch.approvers } : {}),
    ...(launch.documents !== undefined ? { documents: launch.documents } : {}),
    ...(launch.boxAllow !== undefined ? { boxAllow: launch.boxAllow } : {}),
    ...(launch.boxAllowSet ? { boxAllowSet: true as const } : {}),
    ...(launch.learning ? { learning: launch.learning } : {}),
    ...(launch.archilDisk ? { archilDisk: launch.archilDisk } : {}),
    replay: { of, workflow: workflow.name, digest },
  };
  const sealed = await handedTo(deps, id);
  try {
    await store.runs.create({ id, agentId, revisionId: deps.revisionId }, { body: launchBody(replay) as Json, ...(sealed ? { sealed } : {}) });
    return true;
  } catch (error) {
    if (error instanceof StoreConstraint && (await store.runs.get(id))) return false;
    throw error;
  }
}

/** Finishes a launch that was interrupted: `record`'s reserved replay runs still not created REPLAY_LAUNCH_GRACE_MS after
 *  its reservation (and before its deadline) are created now, each under its reserved id on the graded run its record
 *  names for it (`inputs`), with this claim's launch and handed credentials. One whose graded run's launch can no longer be
 *  read stays missing: past the deadline it is counted as never started. How many this claim created. */
async function relaunch(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<number> {
  const { store } = deps;
  const since = (deps.now ?? Date.now)() - Date.parse(record.at);
  if (since <= REPLAY_LAUNCH_GRACE_MS || since > REPLAY_DEADLINE_MS) return 0;
  let made = 0;
  for (const [i, id] of (record.runs ?? []).entries()) {
    const of = record.inputs?.[i];
    if (!of || (await store.runs.get(id))) continue;
    const from = await store.runs.launch(of).then((one) => readLaunchBody(one.body), () => undefined);
    if (from && (await startReplay(deps, workflow, digest, of, from, id))) made += 1;
  }
  if (made) deps.log(`workflow-first: ${workflow.name} at ${digest}: its replay's launch was interrupted; ${plural(made, "replay run")} it reserved started now`);
  return made;
}

/** A run's final answer, whole (its last final answer row that is not its end-of-run turn's), or null: none, or its
 *  record could not be read (a grade's `expected` fields still score a replay without it). */
async function answerOf(store: PromotionDeps["store"], runId: string, context: Context): Promise<string | null> {
  try {
    const rows = await runTimeline(store, runId, context, { settled: true, caps: { text: Number.POSITIVE_INFINITY } });
    return rows.findLast((row) => row.kind === "final_answer" && row.agent_label !== LEARNING_LABEL)?.text ?? null;
  } catch {
    return null;
  }
}

const metricsOf = (row: RunRow | undefined) => (isObject(row?.metrics as Json) ? (row!.metrics as { replay?: { outcome?: unknown; skipped?: { tool?: unknown; unmarked?: unknown } }; guards?: unknown; path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : {});

/** What a replay run did, read from its row alone: answered, handed back or skipped at a write once it ended as such; any
 *  other end, or one not ended (past the replay's deadline), failed: no evidence either way. */
const outcomeOf = (run: RunRow): ReplayRow["outcome"] => {
  const m = metricsOf(run);
  return run.state === "ended" && (m.replay?.outcome === "answered" || m.replay?.outcome === "handed_back" || m.replay?.outcome === "skipped_write") ? m.replay.outcome : "failed";
};

/** How many of a replay's runs ended each way so far (ReplayOutcomes): one not ended counts only past the deadline
 *  (`late`), as failed; one never created, nothing. */
function outcomesOf(runs: readonly (RunRow | undefined)[], late: boolean): ReplayOutcomes {
  const counts = { answered: 0, handed_back: 0, failed: 0, skipped_write: 0 };
  for (const run of runs) if (run && (late || FINAL_STATES.includes(run.state))) counts[outcomeOf(run)] += 1;
  return counts;
}

/** What `record`'s replay runs cost together, at `now`: null while one's is unknown (one not created yet before the
 *  deadline, one not ended, one ended with no cost), whatever its grade; a run never created by the deadline spent nothing. */
function replayCost(runs: readonly (RunRow | undefined)[], late: boolean): number | null {
  let cost = 0;
  for (const run of runs) {
    if (!run) {
      if (!late) return null;
      continue;
    }
    if (!FINAL_STATES.includes(run.state) || run.costUsd === null) return null;
    cost += run.costUsd;
  }
  return Math.round(cost * 1e6) / 1e6;
}

/** The replay's rows, once every replay run ended (or REPLAY_DEADLINE_MS passed: one not ended is failed, no evidence);
 *  undefined while one is at work or not created yet (its record is reserved before its runs are created: a run missing
 *  is a launch still under way, or one a later claim relaunches). With the rows it scores (`scored`, refitRowsOf: the ones
 *  its workflow answered or handed back), what the replay runs cost (replayCost), its runs' outcomes (outcomesOf), and how
 *  many reserved runs were never created by the deadline (`unstarted`). `partial`: the rows of the runs ended so far, at
 *  any time (a replay's read while it runs). A row needs its graded run's grade (what it is scored against): a run whose
 *  grade the agent's newer grades rolled out of those kept has none, and is counted (`outcomes`) but not scored. */
async function replayRows(deps: Pick<PromotionDeps, "store" | "agentId" | "context" | "now">, record: PromotionRecord, partial = false): Promise<{ rows: ReplayRow[]; scored: RefitRow[]; cost: number | null; outcomes: ReplayOutcomes; unstarted: number } | undefined> {
  const { store, context } = deps;
  const now = (deps.now ?? Date.now)();
  const grades = new Map((await gradesOf(store.settings, deps.agentId)).map((grade) => [grade.run, grade]));
  const runs = await Promise.all((record.runs ?? []).map((id) => store.runs.get(id)));
  const late = now - Date.parse(record.at) > REPLAY_DEADLINE_MS;
  if (!late && !partial && runs.some((row) => !row || !FINAL_STATES.includes(row.state))) return undefined;
  const rows: ReplayRow[] = [];
  for (const run of runs) {
    if (!run || (partial && !late && !FINAL_STATES.includes(run.state))) continue;
    const launch = await store.runs.launch(run.id).then((one) => readLaunchBody(one.body), () => undefined);
    const of = launch?.replay?.of;
    const grade = of ? grades.get(of) : undefined;
    if (!of || !grade) continue;
    const m = metricsOf(run);
    const outcome = outcomeOf(run);
    const stoppedAt = outcome === "skipped_write" ? m.replay?.skipped : undefined;
    rows.push({
      of,
      recorded: { answer: await answerOf(store, of, context), correct: grade.correct, ...(grade.expected ? { expected: grade.expected } : {}) },
      outcome,
      ...(stoppedAt && typeof stoppedAt.tool === "string" ? { skipped: { tool: stoppedAt.tool, ...(stoppedAt.unmarked === true ? { unmarked: true as const } : {}) } } : {}),
      answer: outcome === "answered" ? await answerOf(store, run.id, context) : null,
      guards: Array.isArray(m.guards) ? (m.guards as GuardRow[]) : [],
    });
  }
  return { rows, scored: refitRowsOf(rows), cost: replayCost(runs, late), outcomes: outcomesOf(runs, late), unstarted: runs.filter((row) => !row).length };
}

/** A replaying digest's decision, once its replay runs ended: promote within the bar when it answered alone at least once,
 *  else hold, then one refit (of its guards and recorded escalates). Undefined while a replay run is at work. */
async function settle(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<PromotionRecord | undefined> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const read = await replayRows(deps, record);
  if (!read) return undefined;
  // Scored: the inputs the workflow answered or handed back on. One it failed on (a node failed: a credential or a tool the
  // replay ran without, say) is no evidence either way, never the agent's answer in its name.
  // Skipped: the inputs whose workflow needed a write the graded run's recording does not have (learn/replay-calls.ts): a
  // replay never runs one, so they are no evidence either, and never wrong.
  const scored = read.scored;
  const score = scoreRows(scored, thresholdsOf(workflow.workflow));
  const ok = scored.length >= REPLAY_MIN && clears(score);
  const pts = (value: number) => `${(value * 100).toFixed(1)}%`;
  const skipped = read.rows.filter((row) => row.outcome === "skipped_write").length;
  const failed = read.rows.length - scored.length - skipped;
  // Inputs stopped at an MCP tool its server listed with no readOnlyHint: the hold names those tools (the server may only
  // lack the hint); any other skip (a destructive tool, a built-in write) keeps the recording's words.
  const tools = skippedToolsOf(read.rows);
  const unmarked = tools.filter((one) => one.no_read_only_hint);
  const writes = skipped - unmarked.reduce((sum, one) => sum + one.inputs, 0);
  const hint = unmarked.length ? unmarkedWords(unmarked.map((one) => toolWord(one.tool))) : undefined;
  const skipWhy = !hint ? SKIPPED_WRITE : writes ? `${hint} (${writes} more ${writes === 1 ? "needs" : "need"} a write the recording doesn't have)` : hint;
  const aside = [...(failed ? [`${failed} failed: a step failed, no evidence either way`] : []), ...(skipped ? [`${skipped} skipped: ${skipWhy}`] : []),
    ...(read.unstarted ? [`${read.unstarted} never started by the replay's deadline`] : [])].join("; ");
  const said = `on ${plural(score.n, "graded input")}: the workflow ${pts(score.wf_acc)} (${score.handed_back} handed back, the agent's answer), the agent ${pts(score.agent_acc)}, ${score.delta >= 0 ? "+" : ""}${(score.delta * 100).toFixed(1)} pts${aside ? ` (${aside})` : ""}`;
  const reserved = record.runs?.length ?? 0;
  const reason = reserved && read.unstarted === reserved
    ? `none of its ${plural(reserved, "replay run")} started by the replay's deadline (its launch was interrupted: the server stopped after reserving it, say): nothing was replayed; start it again with POST .../learning/workflows/${workflow.name}/revisions/${digest}/replays`
    : read.rows.length && skipped === read.rows.length
    ? hint ? `nothing was replayed on its ${plural(skipped, "graded input")}: ${skipWhy}` : `every one of its ${plural(skipped, "graded input")} ${SKIPPED_WRITE}: a replay never runs a write, so nothing was replayed`
    : scored.length < REPLAY_MIN
      ? `only ${plural(scored.length, "replay")} answered or handed back${aside ? ` (${aside})` : ""}, fewer than ${REPLAY_MIN}`
      : ok ? `replayed ${said}: within ${PROMOTE_BAR * 100} pts`
        : !answersAlone(score) ? `it handed back every one of its ${plural(score.n, "replayed input")}: it would never answer alone (${said})`
          : `replayed ${said}: more than ${PROMOTE_BAR * 100} pts under the agent`;
  // A revision that served before (promoted, then held, now replayed again): its graded check counts only the grades after
  // this promotion, never again the ones it was held on (stillServing reads `checked` as its cursor).
  const servedSeqs = ok ? (await gradesOf(store.settings, agentId)).filter((grade) => grade.workflow === workflow.name && grade.digest === digest && (grade.path === "workflow" || grade.path === "handed_back")).map((grade) => grade.seq ?? 0) : [];
  const decided = await recordPromotion(store.settings, agentId, {
    workflow: workflow.name, digest, at: iso(now()), decided: ok ? "promote" : "hold", source: "replay", reason,
    replay: { ...score, of: read.rows.map((row) => row.of), cost_usd: read.cost, skipped_write: skipped, skipped_tools: tools, outcomes: read.outcomes }, ...(record.runs ? { runs: record.runs } : {}),
    ...(record.commit ? { commit: record.commit } : seedOf(deps)), ...(record.replay_id ? { replay_id: record.replay_id } : {}),
    ...(servedSeqs.length ? { checked: Math.max(...servedSeqs) } : {}),
  }, (was) => sameReplay(was, record));
  // Another claim's decision came first: it logs, cancels and refits; this one reads it.
  if (!decided.won) return decided.record?.decided === "replaying" ? undefined : decided.record;
  log(`workflow-first: ${workflow.name} at ${digest} ${ok ? "promoted" : "held"}: ${reason}`);
  // Decided past its deadline with runs still at work: they are cancelled, never left spending on a decided replay.
  const cancelled = await cancelUnended(deps, record);
  if (cancelled) log(`workflow-first: ${workflow.name} at ${digest}: ${plural(cancelled, "replay run")} still at work past the replay's deadline cancelled`);
  if (!ok && scored.length >= REPLAY_MIN) {
    // Held: one refit over the replay's scored rows (each step's p known: its guards read record-only, its judge-driven
    // escalates recorded). One with neither changes nothing.
    await refitAndWrite(deps, workflow, digest, scored, "its replay held it");
  }
  return decided.record;
}

/** A serving digest, checked once per REFIT_EVERY more graded runs it served: its thresholds refit over those runs and its
 *  replay's rows (a new revision when they move and still clear the bar), and held when its graded runs' accuracy fell
 *  more than PROMOTE_BAR under the agent's. True: it still serves this run. */
async function stillServing(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<boolean> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const grades = await gradesOf(store.settings, agentId);
  const served = grades.filter((grade) => grade.workflow === workflow.name && grade.digest === digest && (grade.path === "workflow" || grade.path === "handed_back"));
  // New since the last check: by seq (putGrade), a cursor the trim of the kept grades never moves back.
  const checked = record.checked ?? 0;
  const through = Math.max(checked, ...served.map((grade) => grade.seq ?? 0));
  if (served.filter((grade) => (grade.seq ?? 0) > checked).length < REFIT_EVERY) return true;
  // The agent's accuracy by hand: its newest graded runs on the agent path, else the replay's.
  const byHand = grades.filter((grade) => grade.path === "agent").slice(-REPLAY_INPUTS);
  const agentAcc = byHand.length ? byHand.filter((grade) => grade.correct).length / byHand.length : record.replay?.agent_acc;
  // Marked checked at this count first, so two claims never check the same window twice.
  // Only the claim whose write marked it refits: one that lost the write reads the winner's record back, the same cursor.
  const marked = await recordPromotion(store.settings, agentId, { ...record, at: iso(now()), checked: through }, (was) => was?.decided === "promote" && (was.checked ?? 0) === checked);
  if (!marked.won || agentAcc === undefined) return marked.record?.decided === "promote";
  const rows: RefitRow[] = [];
  for (const grade of served) {
    const run = await store.runs.get(grade.run);
    const m = metricsOf(run);
    const guards = Array.isArray(m.guards) ? (m.guards as GuardRow[]) : [];
    rows.push(grade.path === "workflow" ? { guards, answered: true, wfCorrect: grade.correct, agentCorrect: agentAcc } : { guards, answered: false, wfCorrect: null, agentCorrect: grade.correct ? 1 : 0 });
  }
  const replayed = record.source === "replay" && record.runs?.length ? (await replayRows(deps, record))?.scored ?? [] : [];
  const wrote = await refitAndWrite(deps, workflow, digest, [...rows, ...replayed], `${plural(served.length, "graded run")} it served`);
  // What actually happened on the served runs: the recorded grades (a workflow-path grade is the workflow's answer, a
  // handed-back one the agent's). Recorded, not rescored: the guards on a run may belong to other workflows the agent called
  // after a hand-back, and rescoring over them would count a right answer as a hand-back at the agent's accuracy.
  const servedAcc = served.filter((grade) => grade.correct).length / served.length;
  if (!wrote && servedAcc < agentAcc - PROMOTE_BAR - 1e-9) {
    const reason = `${plural(served.length, "graded run")} it served were right ${(servedAcc * 100).toFixed(1)}% of the time, more than ${PROMOTE_BAR * 100} pts under the agent's ${(agentAcc * 100).toFixed(1)}% by hand`;
    const held = await recordPromotion(store.settings, agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "hold", source: "graded", reason }, (was) => was?.decided === "promote");
    if (held.won) log(`workflow-first: ${workflow.name} at ${digest} held: ${reason}`);
    return held.record?.decided === "promote";
  }
  return true;
}

/** One refit of `workflow` over `rows`; when it moves a guard and the rows clear the bar at the new thresholds, the new
 *  text is written as a new revision (a merge from the claim's seed) and promoted with the rows' numbers. True when one
 *  was written. */
async function refitAndWrite(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, rows: RefitRow[], why: string): Promise<boolean> {
  if (!deps.commit || rows.length < REPLAY_MIN) return false;
  const now = deps.now ?? Date.now;
  const refit = refitGuards(workflow.workflow, rows, iso(now()));
  if (!refit.text || !clears(refit)) return false;
  const next = workflowDigest({ workflow: refit.text });
  const moved = refit.guards.map((one) => (one.escalate ? `${one.node} escalate off` : one.threshold === null ? `${one.node} guard off` : `${one.node} ${one.was} -> ${one.threshold}${one.fit ? " (fit)" : ""}`)).join(", ");
  const reason = `refit ${workflow.name}'s guards over ${why} (${plural(rows.length, "row")}): ${moved}`;
  const landed = await deps.commit([{ path: `workflows/${workflow.name}/workflow.json`, text: refit.text }], reason, `refit-${digest}-${next}`);
  if (landed === null) {
    deps.log(`workflow-first: ${workflow.name}'s refit did not land on its learning folder; it keeps its thresholds`);
    return false;
  }
  const { n, agree, agent_acc, wf_acc, delta, handed_back } = refit;
  await recordPromotion(deps.store.settings, deps.agentId, {
    workflow: workflow.name, digest: next, at: iso(now()), decided: "promote", source: "refit",
    reason: `${reason}: the workflow ${(refit.wf_acc * 100).toFixed(1)}%, the agent ${(refit.agent_acc * 100).toFixed(1)}% on those rows`,
    replay: { n, agree, agent_acc, wf_acc, delta, handed_back, of: rows.flatMap((row) => (row.of === undefined ? [] : [row.of])) },
    refit: { from: digest, guards: refit.guards }, commit: landed,
  }, (was) => was === undefined);
  deps.log(`workflow-first: ${reason}; the new revision (${next}) serves from the next run`);
  return true;
}

/** Why a replay a person asked for (askReplay) or read (replayView) was refused: `missing`, no such workflow, revision or
 *  replay of the agent (404); `conflict`, the revision cannot replay now (409), in words that say why. */
export class ReplayRefused extends Error {
  constructor(readonly kind: "missing" | "conflict", message: string) {
    super(message);
  }
}

/** What a person's replay reads and writes through (POST and GET .../revisions/{digest}/replays): the claim's ports, with
 *  no claimed run. `launchOf`: a run's launch of the agent on `input` as its start makes one now, and the revision it runs
 *  on: a replay run's is this one with its graded run's input (startReplay), at the revision's learning commit. */
export interface ReplayAsk {
  readonly store: Store;
  readonly agentId: string;
  readonly context: Context;
  readonly log: (line: string) => void;
  readonly folder: () => LearningFolder;
  readonly shown: () => Promise<Shown>;
  readonly launchOf: (input: Json) => Promise<{ readonly launch: RunLaunch; readonly revisionId: string }>;
  readonly now?: () => number;
}

/** The text of `name` at `digest` and the learning commit it is read from: a commit a record of that digest names (newest
 *  first), else the folder's main. When neither holds it, whether the agent has a workflow by that name at all (`named`:
 *  a record names it, or main holds it). */
async function revisionOf(ask: Pick<ReplayAsk, "folder" | "shown">, records: readonly PromotionRecord[], name: string, digest: string): Promise<{ workflow: LearnedWorkflow; commit: string } | { named: boolean }> {
  const folder = ask.folder();
  let main: string | undefined;
  try {
    main = (await readSnapshot(folder.workspace))?.main;
  } finally {
    await folder.end().catch(() => undefined);
  }
  const named = records.filter((one) => one.workflow === name && one.digest === digest && one.commit).map((one) => one.commit!).reverse();
  let onMain = false;
  for (const commit of new Set([...named, ...(main ? [main] : [])])) {
    const workflow = (await workflowsAt(ask, commit).catch(() => [])).find((one) => one.name === name);
    if (workflow && workflowDigest(workflow) === digest) return { workflow, commit };
    if (commit === main) onMain = workflow !== undefined;
  }
  return { named: onMain || records.some((one) => one.workflow === name) };
}

/** A replay of `name` at `digest` a person asked for: the claim path's replay (reserve, startReplay), on `inputs`: `held`,
 *  the graded runs its last replay or hold was decided on (else, with none, the agent's newest REPLAY_INPUTS), or a number,
 *  the agent's newest that many (each a graded input the workflow fits). Its runs end as a claim's do, and it is decided by
 *  the claim path's settle: at a claim that lays the revision, or at its read (replayView). Refused (ReplayRefused): no
 *  such workflow or revision; one replaying already, or another revision of it replaying (one at a time); a promoted
 *  one (it serves already); no graded input it fits; an agent that does not learn here. The replay's id and its inputs. */
export async function askReplay(ask: ReplayAsk, name: string, digest: string, inputs: "held" | number): Promise<{ replay: string; inputs: number }> {
  const records = await promotionsOf(ask.store.settings, ask.agentId);
  const found = await revisionOf(ask, records, name, digest);
  if ("named" in found) throw new ReplayRefused("missing", found.named ? `The learned workflow ${name} has no revision ${digest}: no promotion record names it, and the learning folder's main holds another.` : `The agent has no learned workflow ${name}.`);
  const own = promotionOf(records, name, digest);
  if (own?.decided === "replaying") throw new ReplayRefused("conflict", `${name} at ${digest} is replaying already: read that replay, or wait for it to end.`);
  if (own?.decided === "promote") throw new ReplayRefused("conflict", `${name} at ${digest} is promoted: it serves already. A replay checks a revision that does not serve yet, or was held.`);
  const rival = replayingOf(records, name, digest)[0];
  if (rival) throw new ReplayRefused("conflict", `${name} at ${rival.digest} is replaying: one revision of a workflow replays at a time. Ask again once it ends.`);
  const held = inputs === "held" ? records.findLast((one) => one.workflow === name && one.digest === digest && (one.inputs?.length || one.replay?.of.length)) : undefined;
  const of = held ? (held.inputs ?? held.replay!.of) : undefined;
  const graded = await gradedInputs({ store: ask.store, agentId: ask.agentId, runId: "" }, found.workflow, of ? { of } : typeof inputs === "number" ? { n: inputs } : {});
  if (!graded.length) throw new ReplayRefused("conflict", of ? `None of the ${plural(of.length, "graded input")} ${name} at ${digest} was last decided on is still graded and fits it: ask for a number of the agent's newest graded inputs instead.` : `The agent has no graded run ${name} fits: grade some of its runs first (PUT /runs/{run_id}/grade).`);
  const { launch, revisionId } = await ask.launchOf(graded[0]!.launch.input as Json);
  if (!launch.learning || launch.learning.notesOnly) throw new ReplayRefused("conflict", `A replay runs ${name} as a run of the agent that learns does, and the agent's runs do not take learned workflows here (its learning is off, notes only, or this server's is off).`);
  const deps: PromotionDeps = { store: ask.store, agentId: ask.agentId, runId: "", revisionId, launch: { ...launch, learning: { ...launch.learning, seed: found.commit } }, context: ask.context, log: ask.log, ...(ask.now ? { now: ask.now } : {}) };
  const said = of ? `replaying on the ${plural(graded.length, "graded input")} it was last decided on, as its owner asked` : `replaying on the agent's newest ${plural(graded.length, "graded input")} it fits, as its owner asked`;
  const reserved = await reserve(deps, found.workflow, digest, graded, said, (was) => JSON.stringify(was) === JSON.stringify(own));
  if (!reserved.won || !reserved.record?.replay_id) throw new ReplayRefused("conflict", `${name} at ${digest} changed while this replay was asked for (another replay or decision came first): read its promotions and ask again.`);
  ask.log(`workflow-first: ${name} at ${digest}: ${said}`);
  return { replay: reserved.record.replay_id, inputs: graded.length };
}

/** A replay as its read answers it (GET .../replays/{replay_id}). `status`: `running` while its record says replaying,
 *  `done` once promoted or held, `failed` when superseded (its runs cancelled) or when none of its runs started by its
 *  deadline (nothing was replayed; held, its `reason` says so). The counts: what its own runs did (outcomesOf), so far
 *  while it runs, and once decided as its record kept them, whatever the agent's grades kept now; never the thresholds'
 *  reading (a run answered under its guard's threshold stays answered: `alone` and `score` hand it back). `score` and
 *  `cost_usd` the decided record's, else the runs ended so far at the revision's serving thresholds, and null while a
 *  run's cost is unknown (replayCost). */
export type ReplayView = {
  readonly replay: string; readonly workflow: string; readonly digest: string;
  readonly status: "running" | "done" | "failed"; readonly inputs: number;
  readonly answered: number; readonly handed_back: number; readonly failed: number; readonly skipped_write: number; readonly alone: number;
  readonly score: ReplayScore; readonly cost_usd: number | null;
  readonly decided?: PromotionRecord["decided"]; readonly reason?: string;
};

/** The claim's ports a replay's read settles it through (replayView), at its learning commit (a refit lands as a merge
 *  from it): a replay run's own launch and revision, the first of its runs that exists; else (none created: its launch
 *  was interrupted before the first) a bare launch at the replay's commit, enough to decide it and never to start a run. */
async function readPorts(ask: ReplayAsk, record: PromotionRecord): Promise<PromotionDeps> {
  const ports = (launch: RunLaunch, revisionId: string) => claimPromotion({ ...ask, runId: "", revisionId, launch });
  for (const id of record.runs ?? []) {
    const row = await ask.store.runs.get(id);
    const launch = row ? await ask.store.runs.launch(id).then((one) => readLaunchBody(one.body), () => undefined) : undefined;
    if (row && launch) return ports(launch, row.revisionId);
  }
  return ports({ input: {}, title: "", place: { mode: "runner" } } as RunLaunch, "");
}

/** Reads replay `id` of `name` at `digest`, settling it first as a claim of its revision would (the claim path's settle)
 *  once its runs ended or its deadline passed: it writes only the decision. A read never starts a run: a replay whose
 *  launch was interrupted (reserved runs never created) reads running until its deadline, then is decided held, read as
 *  failed, its reason saying none of its runs started and to start it again with POST. So a replay of a revision no claim
 *  lays (an older, held one) is decided too, and never running forever. Refused (missing) when the agent has no such
 *  replay. */
export async function replayView(ask: ReplayAsk, name: string, digest: string, id: string): Promise<ReplayView> {
  const find = async () => (await promotionsOf(ask.store.settings, ask.agentId)).findLast((one) => one.workflow === name && one.digest === digest && one.replay_id === id);
  let record = await find();
  if (!record) throw new ReplayRefused("missing", `${name} at ${digest} has no replay ${id}.`);
  const text = record.commit ? (await workflowsAt(ask, record.commit).catch(() => [])).find((one) => one.name === name && workflowDigest(one) === digest) : undefined;
  if (record.decided === "replaying" && text) {
    // Read back by its id: whatever settled it (this read, a claim, another read), never another replay's record.
    await settle(await readPorts(ask, record), text, digest, record);
    record = (await find()) ?? record;
  }
  const decided = record.decided === "replaying" ? undefined : record.decided;
  const read = await replayRows(ask, record, true);
  const runs = await Promise.all((record.runs ?? []).map((one) => ask.store.runs.get(one)));
  const late = (ask.now ?? Date.now)() - Date.parse(record.at) > REPLAY_DEADLINE_MS;
  const kept = record.replay && decided && decided !== "superseded" ? record.replay : undefined;
  // Decided with not one of its reserved runs ever created: nothing was replayed (settle's reason says so).
  const neverStarted = kept !== undefined && runs.length > 0 && runs.every((run) => !run);
  const counts = kept?.outcomes ?? outcomesOf(runs, late);
  const score: ReplayScore = kept
    ? { n: kept.n, agree: kept.agree, agent_acc: kept.agent_acc, wf_acc: kept.wf_acc, delta: kept.delta, handed_back: kept.handed_back }
    : scoreRows(read?.scored ?? [], text ? thresholdsOf(text.workflow) : new Map());
  return {
    replay: id, workflow: name, digest, status: decided === undefined ? "running" : decided === "superseded" || neverStarted ? "failed" : "done", inputs: runs.length,
    ...counts, alone: score.n - score.handed_back, score,
    cost_usd: kept ? (kept.cost_usd ?? null) : (read?.cost ?? null),
    ...(decided ? { decided, reason: record.reason } : {}),
  };
}

/** A replay run's call nodes (launch.replay; learn/replay-calls.ts): the graded run's recorded calls, read from its journal
 *  (a CLI's record shaped as pi's), and each tool classed by the claim's MCP pin (`runId`'s, its servers' annotations as
 *  they listed them) or the built-in list. Undefined for any other run. A recording that cannot be read is an empty one:
 *  every write is then skipped, never run. */
export async function replayCallsFor(store: Store, runId: string, launch: RunLaunch, context: Context): Promise<ReplayCalls | undefined> {
  if (!launch.replay) return undefined;
  const entries = await runEntries(store, launch.replay.of, context).catch(() => []);
  const recorded = recordedCalls(isCliRecord(entries) ? piShaped(entries) : entries);
  const pin = (await store.mcp.pin(runId).catch(() => undefined))?.body as McpPin | undefined;
  const annotations = (tool: string) => {
    const named = /^mcp:([^/]+)\/(.+)$/.exec(tool);
    const server = named && pin && Object.hasOwn(pin, named[1]!) ? pin[named[1]!] : undefined;
    const listed = server?.tools.find((one) => one.name === named![2]) as { annotations?: Record<string, unknown> } | undefined;
    // Listed with none: `{}`, so a tool its server left unannotated reads unmarked, never as one it does not list.
    return listed ? (listed.annotations ?? {}) : undefined;
  };
  return replayCalls(recorded, (tool) => toolClassOf(tool, annotations));
}
