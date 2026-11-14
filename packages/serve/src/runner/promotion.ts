// Promotion by replay, at a run's claim (champion/challenger, shadow deployment): the learned workflow that fits the run's
// input serves first only when its digest is promoted (learn/promote.ts). A digest with no record yet is replayed on the
// agent's last REPLAY_INPUTS graded inputs (runs a person or an eval graded, PUT /runs/{id}/grade, whose answer was the
// agent's): each a queued replay run of its own (RunLaunch.replay, at workflow cost, its guards record-only), the agent
// taking the runs meanwhile. A later claim that finds every replay run ended scores them (replayScore at the serving
// thresholds: a hand-back is the agent's recorded answer) and promotes the digest when it is within PROMOTE_BAR of the
// agent path, else holds it; a held digest whose workflow has guards gets one threshold refit over the replay's rows
// (learn/refit.ts), a new revision that serves when the refit clears the bar. Fewer than REPLAY_MIN graded inputs: the
// digest is promoted on its passing dry run, as before, and its record says so. A serving digest is checked once per
// REFIT_EVERY more graded runs it served: its thresholds refit (a new revision when they move and still clear the bar),
// and held when its graded runs fall below the bar. Escalation never holds a workflow: a hand-back is the agent's answer.
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
// scored); a replay whose every input was skipped holds the revision in those words. Its credentials resolve at its claim
// as any run's of the agent do: saved ones from the server's store, and the per_run MCP credentials the run whose claim
// started it was handed, sealed anew for the replay run alone (startReplay), never opened outside the claim.
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
import { recordedCalls, type ReplayCalls, replayCalls, SKIPPED_WRITE, toolClassOf } from "../learn/replay-calls.js";
import { isObject, type Json } from "../validate.js";
import { championOf, clears, type Grade, gradesOf, PROMOTE_BAR, type PromotionRecord, promotionOf, promotionsOf, recordPromotion, REFIT_EVERY, REPLAY_INPUTS, REPLAY_MIN, type ReplayRow, replayingOf, replayScore, answerCorrect, scoredRows, thresholdsOf } from "../learn/promote.js";
import { sendCommand } from "./commands.js";
import { ClaimRefused } from "./loop-contract.js";
import { readSnapshot } from "../learn/folder.js";
import { type RefitRow, refitGuards } from "../learn/refit.js";
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

/** A replay run's claim (launch.replay), once its first choice is made: refused (ClaimRefused: the run ends failed, no
 *  agent turn, nothing sent) unless its revision's record still says replaying (it is reserved before its runs are
 *  created), or has none (trimmed), and the claim laid that revision to serve it. A superseded, promoted or held revision's
 *  replay run never runs (a cancel that never reached it included); one whose workflow is not laid at its digest (the
 *  seed could not be read, the folder moved on) never falls to the agent's path. Any other run: nothing to check. */
export async function replayClaimed(store: Pick<Store, "settings">, agentId: string, launch: RunLaunch, choice: FirstChoice): Promise<void> {
  if (!launch.replay) return;
  const { workflow, digest } = launch.replay;
  const record = promotionOf(await promotionsOf(store.settings, agentId), workflow, digest);
  if (record && record.decided !== "replaying") throw new ClaimRefused(`This replay of ${workflow} at ${digest} did not run: that revision is ${record.decided === "superseded" ? `superseded by ${record.superseded_by ?? "a newer revision"}` : record.decided === "promote" ? "promoted already" : "held already"}.`);
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
  // The challenger reserved first: its record names the replay runs it will start (their ids minted here), kept only when
  // this digest has none yet and no other revision of the workflow replays, in the one guarded write. Only the claim that
  // kept it starts them: a claim of the same digest, or of another revision, at once, starts none.
  const ids = graded.map(() => uuidv7());
  const reserved = await recordPromotion(store.settings, agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "replaying", source: "replay", reason: `replaying on the agent's last ${plural(graded.length, "graded input")} it fits`, runs: ids, inputs: graded.map((one) => one.grade.run), ...seedOf(deps) },
    (was, items) => was === undefined && replayingOf(items, workflow.name, digest).length === 0);
  if (!reserved.won) {
    const rival = reserved.record ? undefined : replayingOf(await promotionsOf(store.settings, agentId), workflow.name, digest)[0];
    if (rival) log(`workflow-first: ${workflow.name} at ${digest}: ${rival.digest} began replaying first; it does not serve this run`);
    return;
  }
  for (const [i, one] of graded.entries()) await startReplay(deps, workflow, digest, one.grade.run, one.launch, ids[i]!);
  log(`workflow-first: ${workflow.name} at ${digest} is new: replaying it on the agent's last ${plural(graded.length, "graded input")} before it serves`);
}

/** Supersedes `record`, a revision still replaying, by the newer revision at `by`: its record decided superseded (kept only
 *  while it still says replaying: a replay that settled first keeps its decision), then its replay runs not ended are
 *  cancelled (cancelUnended) by the claim whose write kept it. */
async function supersede(deps: PromotionDeps, record: PromotionRecord, by: string): Promise<void> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const runs = record.runs ?? [];
  const reason = `superseded by ${by}, a newer revision, while it replayed: its replay runs were cancelled`;
  const kept = await recordPromotion(store.settings, agentId, {
    workflow: record.workflow, digest: record.digest, at: iso(now()), decided: "superseded", source: "replay", reason, superseded_by: by,
    ...(runs.length ? { runs } : {}), ...(record.commit ? { commit: record.commit } : {}),
  }, (was) => was?.decided === "replaying");
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

/** The agent's newest graded runs whose answer was the agent's (path `agent`, or `handed_back`: the agent finished it), at
 *  most REPLAY_INPUTS, newest first: each with a launch read back, no uploaded file, an input `workflow` fits, never the
 *  run being claimed, nor an archived or imported one. */
async function gradedInputs(deps: PromotionDeps, workflow: LearnedWorkflow): Promise<GradedInput[]> {
  const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
  const out: GradedInput[] = [];
  const grades = (await gradesOf(deps.store.settings, deps.agentId)).filter((grade) => grade.path === "agent" || grade.path === "handed_back");
  for (const grade of grades.reverse()) {
    if (out.length >= REPLAY_INPUTS) break;
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

const metricsOf = (row: RunRow | undefined) => (isObject(row?.metrics as Json) ? (row!.metrics as { replay?: { outcome?: unknown }; guards?: unknown; path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : {});

/** The replay's rows, once every replay run ended (or REPLAY_DEADLINE_MS passed: one not ended is failed, no evidence);
 *  undefined while one is at work or not created yet (its record is reserved before its runs are created: a run missing
 *  is a launch still under way, or one a later claim finishes, relaunch). With what the replay runs cost (null when one's
 *  is unknown), and how many reserved runs were never created by the deadline (`unstarted`). */
async function replayRows(deps: PromotionDeps, record: PromotionRecord): Promise<{ rows: ReplayRow[]; cost: number | null; unstarted: number } | undefined> {
  const { store, context } = deps;
  const now = (deps.now ?? Date.now)();
  const grades = new Map((await gradesOf(store.settings, deps.agentId)).map((grade) => [grade.run, grade]));
  const runs = await Promise.all((record.runs ?? []).map((id) => store.runs.get(id)));
  const late = now - Date.parse(record.at) > REPLAY_DEADLINE_MS;
  if (!late && runs.some((row) => !row || !FINAL_STATES.includes(row.state))) return undefined;
  const rows: ReplayRow[] = [];
  let cost: number | null = 0;
  for (const run of runs) {
    if (!run) continue;
    const launch = await store.runs.launch(run.id).then((one) => readLaunchBody(one.body), () => undefined);
    const of = launch?.replay?.of;
    const grade = of ? grades.get(of) : undefined;
    if (!of || !grade) continue;
    const ended = FINAL_STATES.includes(run.state);
    cost = cost === null || !ended || run.costUsd === null ? null : cost + run.costUsd;
    const m = metricsOf(run);
    const outcome = ended && run.state === "ended" && (m.replay?.outcome === "answered" || m.replay?.outcome === "handed_back" || m.replay?.outcome === "skipped_write") ? m.replay.outcome : "failed";
    rows.push({
      of,
      recorded: { answer: await answerOf(store, of, context), correct: grade.correct, ...(grade.expected ? { expected: grade.expected } : {}) },
      outcome,
      answer: outcome === "answered" ? await answerOf(store, run.id, context) : null,
      guards: Array.isArray(m.guards) ? (m.guards as GuardRow[]) : [],
    });
  }
  return { rows, cost: cost === null ? null : Math.round(cost * 1e6) / 1e6, unstarted: runs.filter((row) => !row).length };
}

/** A replaying digest's decision, once its replay runs ended: promote within the bar, else hold, then one refit when its
 *  workflow has guards. Undefined while a replay run is at work. */
async function settle(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<PromotionRecord | undefined> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const read = await replayRows(deps, record);
  if (!read) return undefined;
  // Scored: the inputs the workflow answered or handed back on. One it failed on (a node failed: a credential or a tool the
  // replay ran without, say) is no evidence either way, never the agent's answer in its name.
  // Skipped: the inputs whose workflow needed a write the graded run's recording does not have (learn/replay-calls.ts): a
  // replay never runs one, so they are no evidence either, and never wrong.
  const scored = scoredRows(read.rows);
  const score = replayScore(scored, thresholdsOf(workflow.workflow));
  const ok = scored.length >= REPLAY_MIN && clears(score);
  const pts = (value: number) => `${(value * 100).toFixed(1)}%`;
  const skipped = read.rows.filter((row) => row.outcome === "skipped_write").length;
  const failed = read.rows.length - scored.length - skipped;
  const aside = [...(failed ? [`${failed} failed: a step failed, no evidence either way`] : []), ...(skipped ? [`${skipped} skipped: ${SKIPPED_WRITE}`] : []),
    ...(read.unstarted ? [`${read.unstarted} never started by the replay's deadline`] : [])].join("; ");
  const said = `on ${plural(score.n, "graded input")}: the workflow ${pts(score.wf_acc)} (${score.handed_back} handed back, the agent's answer), the agent ${pts(score.agent_acc)}, ${score.delta >= 0 ? "+" : ""}${(score.delta * 100).toFixed(1)} pts${aside ? ` (${aside})` : ""}`;
  const reason = read.rows.length && skipped === read.rows.length
    ? `every one of its ${plural(skipped, "graded input")} ${SKIPPED_WRITE}: a replay never runs a write, so nothing was replayed`
    : scored.length < REPLAY_MIN
      ? `only ${plural(scored.length, "replay")} answered or handed back${aside ? ` (${aside})` : ""}, fewer than ${REPLAY_MIN}`
      : ok ? `replayed ${said}: within ${PROMOTE_BAR * 100} pts` : `replayed ${said}: more than ${PROMOTE_BAR * 100} pts under the agent`;
  const decided = await recordPromotion(store.settings, agentId, {
    workflow: workflow.name, digest, at: iso(now()), decided: ok ? "promote" : "hold", source: "replay", reason,
    replay: { ...score, of: read.rows.map((row) => row.of), cost_usd: read.cost, skipped_write: skipped }, ...(record.runs ? { runs: record.runs } : {}),
    ...(record.commit ? { commit: record.commit } : seedOf(deps)),
  }, (was) => was?.decided === "replaying");
  // Another claim's decision came first: it logs, cancels and refits; this one reads it.
  if (!decided.won) return decided.record?.decided === "replaying" ? undefined : decided.record;
  log(`workflow-first: ${workflow.name} at ${digest} ${ok ? "promoted" : "held"}: ${reason}`);
  // Decided past its deadline with runs still at work: they are cancelled, never left spending on a decided replay.
  const cancelled = await cancelUnended(deps, record);
  if (cancelled) log(`workflow-first: ${workflow.name} at ${digest}: ${plural(cancelled, "replay run")} still at work past the replay's deadline cancelled`);
  if (!ok && scored.length >= REPLAY_MIN) {
    // Held with guards: one refit over the replay's scored rows (each step's p known: its guards read record-only).
    await refitAndWrite(deps, workflow, digest, scored.map(replayRefitRow), "its replay held it", scored);
  }
  return decided.record;
}

/** A replayed input as a refit row: answered alone only when every guard read a p (record-only, none handed back). */
const replayRefitRow = (row: ReplayRow): RefitRow => {
  const answered = row.outcome === "answered" && row.guards.every((guard) => guard.p !== null);
  return { guards: row.guards, answered, wfCorrect: answered ? answerCorrect(row.answer, row.recorded) : null, agentCorrect: row.recorded.correct ? 1 : 0 };
};

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
  const replayed = record.source === "replay" && record.runs?.length ? scoredRows((await replayRows(deps, record))?.rows ?? []) : [];
  const all = [...rows, ...replayed.map(replayRefitRow)];
  const wrote = await refitAndWrite(deps, workflow, digest, all, `${plural(served.length, "graded run")} it served`, replayed);
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
async function refitAndWrite(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, rows: RefitRow[], why: string, replayed: readonly ReplayRow[]): Promise<boolean> {
  if (!deps.commit || rows.length < REPLAY_MIN) return false;
  const now = deps.now ?? Date.now;
  const refit = refitGuards(workflow.workflow, rows, iso(now()));
  if (!refit.text || !clears(refit)) return false;
  const next = workflowDigest({ workflow: refit.text });
  const moved = refit.guards.map((one) => `${one.node} ${one.was} -> ${one.threshold}${one.fit ? " (fit)" : ""}`).join(", ");
  const reason = `refit ${workflow.name}'s guards over ${why} (${plural(rows.length, "row")}): ${moved}`;
  const landed = await deps.commit([{ path: `workflows/${workflow.name}/workflow.json`, text: refit.text }], reason, `refit-${digest}-${next}`);
  if (landed === null) {
    deps.log(`workflow-first: ${workflow.name}'s refit did not land on its learning folder; it keeps its thresholds`);
    return false;
  }
  const agree = replayed.length ? replayScore(replayed, new Map(refit.guards.map((one) => [one.node, one.threshold]))).agree : 0;
  await recordPromotion(deps.store.settings, deps.agentId, {
    workflow: workflow.name, digest: next, at: iso(now()), decided: "promote", source: "refit",
    reason: `${reason}: the workflow ${(refit.wf_acc * 100).toFixed(1)}%, the agent ${(refit.agent_acc * 100).toFixed(1)}% on those rows`,
    replay: { n: refit.n, agree, agent_acc: refit.agent_acc, wf_acc: refit.wf_acc, delta: refit.delta, handed_back: refit.handed_back, of: replayed.map((row) => row.of) },
    refit: { from: digest, guards: refit.guards }, commit: landed,
  }, (was) => was === undefined);
  deps.log(`workflow-first: ${reason}; the new revision (${next}) serves from the next run`);
  return true;
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
    return listed?.annotations;
  };
  return replayCalls(recorded, (tool) => toolClassOf(tool, annotations));
}
