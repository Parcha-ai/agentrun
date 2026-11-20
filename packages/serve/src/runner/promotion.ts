// Promotion, at a run's claim (champion/challenger, shadow deployment): the learned workflow that fits the run's input
// serves first only when its digest is promoted (learn/promote.ts). Promote once: a digest with no record yet, the learning
// folder's newest revision, is checked once (startCheck): a replay run of it (RunLaunch.replay, at workflow cost) on the
// input of each of the agent's last compile_after completed runs of its own (its definition's `learning`,
// learning-setting.ts), the agent taking the runs meanwhile. A later claim that finds every check run ended scores each
// against the agent's own recorded answer (learn/promote.ts sameAnswer; no grade is read) and promotes the digest when,
// of the inputs it ran on, it answered at least alone_min alone and at least agree_min of those said what the agent said
// (checkPasses); else it is held, its record keeping the inputs it disagreed on, which the agent's next run's compile
// turn reads to write its one recompile (learn/compile.ts); that revision is checked the same way, once, and a hold of
// it stops (nothing compiles again). A check-promoted digest is never checked again: no grade, no refit, no queue, no
// second replay. Every reserved input counts: one whose replay run was never created, or never ended, by the check's
// deadline is a failed input. With nothing to check it on (no input of the agent's it takes, or every input skipped at a
// write) it is never promoted: it stops, its record naming why (stopUnchecked), and asks no recompile.
//
// The champion keeps serving meanwhile: while the folder's revision (the challenger) is checked, or once it is held, the
// digest promoted last (learn/promote.ts championOf) serves the run, read from the learning commit its record names. Only
// the money rule (workflow-first.ts) stops it. Who serves is the champion alone, read at every run's claim, a queued run's
// included (servingNow): a digest's own promote record never serves it once another digest was promoted after it. A run
// already executing (an earlier claim of it served a workflow first) keeps that revision (keptFor). A serving revision
// this release's workflow DSL refuses (a key an older release took, say) is held at the claim that finds it, once per
// digest, its reason the DSL's (holdRefused): the run hands back as before, and the hold asks the one recompile.
// One check at a time: a check at work finishes (a revision newer than it waits, and decides it first: settleAhead). The
// check is reserved before any of its replay runs starts: its replaying record, naming the runs it will start, is kept
// only while no other revision of the workflow replays (the rival check in the same guarded write), so two claims of two
// revisions at once start one check. A reserved run not created yet is pending, never ended: a claim between the
// reservation and the creates decides nothing, and a launch interrupted there (a crash, a failed create) is finished by a
// claim REPLAY_LAUNCH_GRACE_MS on, each run under its reserved id on the input its record names (relaunch), with the
// launch its record chose when it was reserved (PromotionRecord.launch: model, revision, credentials), never the finishing
// claim's. Every decision is acted on (replay runs started, runs cancelled) only by the claim whose write kept it
// (learn/promote.ts Recorded.won). A check decided with runs still at work (its deadline passed) cancels them. A replay
// run's claim refuses it unless its revision still replays (replayClaimed), so a cancel lost to a crash or a failed write
// never leaves one running.
// A replay never repeats a side effect and runs with what a served run of the agent has (learn/replay-calls.ts, SPEC B4):
// each call node's tool is a read or a write; a read runs live through a cache seeded from the agent's recorded calls, a
// write is answered only from that recording (same tool, same canonical arguments) and is never sent, and an input whose
// workflow needs a write the recording does not have is skipped (counted in the record's check.outcomes, never scored); a
// check whose every input was skipped holds the revision in those words, or, when the tool that stopped them is an MCP
// tool its server listed with no readOnlyHint, naming it (check.skipped_tools). Its credentials resolve at its claim as
// any run's of the agent do: saved ones from the server's store, and the per_run MCP credentials the run whose claim
// reserved it was handed (its record's launch.handed_from), sealed anew for the replay run alone (startReplay), never
// opened outside the claim.
// Its owner may start one too (askReplay, POST .../revisions/{digest}/replays): a held revision re-checked, or an edited
// one, on the inputs it was last checked on or the agent's newest, decided by the same settleCheck, at a claim that lays
// it or at its read (replayView), so its records are a claim-started check's.
import type { Context } from "@earendil-works/chord/context";
import type { LearnedWorkflow } from "../learning.js";
import { LEARNING_LABEL } from "../learning.js";
import { loopOf } from "../learning-setting.js";
import { LEARNED_WORKFLOW_TOOL } from "../learned-workflow.js";
import { launchBody, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { uuidv7 } from "../runs-over-store.js";
import { FINAL_STATES, RunFinal, type RunRow, type Store, StoreConstraint } from "../store/store.js";
import { openRunMcpAuth, sealRunMcpAuth } from "../store/seal.js";
import { isCliRecord, piShaped, runEntries, runTimeline } from "../store-reads/journal.js";
import type { McpPin } from "../mcp-gateway.js";
import { pinAnnotations, type Recorded, recordedCalls, type ReplayCalls, replayCalls, type Skipped, SKIPPED_WRITE, toolClassOf, toolWord, unmarkedWords } from "../learn/replay-calls.js";
import { listed } from "../learning-words.js";
import { isObject, type Json } from "../validate.js";
import { agentRun, lastOwnRuns, newCompileAttempt } from "../learn/compile.js";
import { type CheckBar, type CheckDisagreement, type CheckRecord, checkPasses, checkShares, CHECK_TEXT_MAX, championOf, compareAnswers, type Compared, comparedOf, type PromotionRecord, promotionOf, promotionsOf, recordPromotion, type ReplayLaunch, type ReplayOutcomes, type ReplayScore, replayingOf, type SkippedTool, skippedToolsOf } from "../learn/promote.js";
import { sendCommand } from "./commands.js";
import { ClaimRefused } from "./loop-contract.js";
import { readSnapshot } from "../learn/folder.js";
import { type FirstChoice, fits, laidFor, type Promoted, type ReplayOutcome, servedOf, type Serving, workflowDigest } from "./workflow-first.js";
import type { LearningFolder } from "../learn/folder.js";
import { excerptShown } from "../learn/secrets.js";
import { dslRefusalOf } from "../learn/workflow-draft.js";
import type { Shown } from "../learning.js";
import { workflowsAt } from "./learning-seed.js";
import { held } from "./held.js";

/** A replay run still not ended this long after its replay started counts as failed (no evidence), and is cancelled once
 *  the replay is decided without it. */
export const REPLAY_DEADLINE_MS = 60 * 60 * 1000;
/** A reserved replay run still not created this long after its record was reserved is a launch that was interrupted (the
 *  reserving claim crashed, or its create failed): the next claim creates it (relaunch). Before then it is pending. */
export const REPLAY_LAUNCH_GRACE_MS = 5 * 60 * 1000;

export interface PromotionDeps {
  readonly store: Store;
  /** Why model spend beside the claimed run is skipped (claim-secrets.ts claimSpendOff): a replay check starts runs with
   *  no caller's key. Absent: it runs. */
  readonly spendOff?: (what: string) => string | undefined;
  readonly agentId: string;
  /** The run being claimed: never one of its own check's inputs. Absent: no run is claimed (a person's replay, and its
   *  read): no run served first to keep, none whose per_run MCP credentials a replay is handed. */
  readonly runId?: string;
  /** The revision the claimed run runs: its replay runs run it too. */
  readonly revisionId: string;
  /** The claimed run's launch: a replay run's is this one with the agent run's input. */
  readonly launch: RunLaunch;
  readonly context: Context;
  readonly log: (line: string) => void;
  /** The learned workflow `name` as the learning folder held it active at `commit` (a champion's text), or undefined when
   *  it held none by that name. Absent: no champion serves. */
  readonly champion?: (name: string, commit: string) => Promise<LearnedWorkflow | undefined>;
  /** The digest of the learned workflow `name` the learning folder's main holds now (the newest revision), or undefined
   *  when it holds none by that name. Absent: every revision is the newest. */
  readonly newest?: (name: string) => Promise<string | undefined>;
  /** The learned workflow an earlier claim of this run served first (its WORKFLOW_FIRST entry, answered or handed back:
   *  workflow-first.ts servedOf), or undefined for a run no claim served yet: a run already executing keeps its revision
   *  (keptFor). Absent: none kept. */
  readonly kept?: () => Promise<{ readonly workflow: string; readonly digest?: string } | undefined>;
  /** The server's seal key: a replay run is handed the per_run MCP credentials the claimed run was handed, sealed for it
   *  (startReplay). Absent: a replay run is handed none (a per_run server's calls are refused unsent, the input failed). */
  readonly sealKey?: Buffer;
  readonly now?: () => number;
  /** The host's secrets as a reader cuts them (learning.ts secretsShown): a check's texts are cut of them whole, before
   *  they are shortened (decideCheck). */
  readonly shown: () => Promise<Shown>;
}

/** The claim's promotion ports: `folder`, the agent's learning folder where the run's place keeps it, a champion read
 *  from it at its record's commit, cut of the server's secrets (`shown`) as the claim's lay is; and the workflow an earlier
 *  claim of this run served (`kept`, from its journal: none on a first claim). */
export function claimPromotion(deps: Omit<PromotionDeps, "champion" | "kept"> & { readonly folder: () => LearningFolder }): PromotionDeps {
  return {
    ...deps,
    kept: async () => (deps.runId ? servedOf(await runEntries(deps.store, deps.runId, deps.context).catch(() => [])) : undefined),
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
 *  promoted or held revision's replay run never runs (a cancel that never reached it included), nor an older
 *  replay's leftover once its revision replays again; one whose workflow is not laid at its digest (the seed could not be
 *  read, the folder moved on) never falls to the agent's path. Any other run: nothing to check. */
export async function replayClaimed(store: Pick<Store, "settings">, agentId: string, runId: string, launch: RunLaunch, choice: FirstChoice): Promise<void> {
  if (!launch.replay) return;
  const { workflow, digest } = launch.replay;
  const record = promotionOf(await promotionsOf(store.settings, agentId), workflow, digest);
  if (record && record.decided !== "replaying") throw new ClaimRefused(`This replay of ${workflow} at ${digest} did not run: that revision is ${record.decided === "promote" ? "promoted already" : "held already"}.`);
  if (record && !record.runs?.includes(runId)) throw new ClaimRefused(`This replay of ${workflow} at ${digest} did not run: that revision replays again${record.replay_id ? ` (replay ${record.replay_id})` : ""}, and this run is not one of its runs.`);
  if (choice.serve?.replay !== true || choice.serve.name !== workflow) throw new ClaimRefused(`This replay of ${workflow} at ${digest} did not run: its claim laid no workflow by that name at that digest. The agent was not asked.`);
}

/** The workflows a replay run's claim lays (`laid`, the seed lay's): the one it replays, or none by that name when the
 *  laid one is not the digest it replays (the replay then fails, never scoring another revision). Any other run's, as laid. */
export function replayLaid(launch: RunLaunch, laid: readonly LearnedWorkflow[]): LearnedWorkflow[] {
  if (!launch.replay) return [...laid];
  const { workflow, digest } = launch.replay;
  return laid.filter((one) => one.name !== workflow || workflowDigest(one) === digest);
}

/** The learned workflows a run's learned_workflow tool runs, once its first choice is made: what serves, never a
 *  revision its promotion has not promoted. The one its first choice served or the money rule stopped (laidFor: its
 *  champion in place of the laid revision) as chosen; any other the records name, its champion (championOf: the laid
 *  text when that is the champion, else its text at its record's commit), and none while nothing of it serves (none
 *  promoted yet, or the champion held): a revision replaying, held or never decided is never handed to the agent to run
 *  in its place. One the records never named is an unchecked draft and is not offered. A replay run's as
 *  laid (replayLaid). The records unread: only the chosen one, as the gate leaves a run to its agent. */
export async function toolFlowsFor(deps: Pick<PromotionDeps, "store" | "agentId" | "champion" | "log">, launch: RunLaunch, laid: readonly LearnedWorkflow[], choice: FirstChoice): Promise<LearnedWorkflow[]> {
  const chosen = laidFor(laid, choice);
  if (launch.replay || !chosen.length) return chosen;
  const name = choice.serve?.name ?? choice.revise?.workflow;
  let records: PromotionRecord[];
  try {
    records = await promotionsOf(deps.store.settings, deps.agentId);
  } catch (error) {
    deps.log(`workflow-first: the promotions could not be read (${(error as Error)?.message ?? error}); the learned_workflow tool runs only the workflow chosen first`);
    return chosen.filter((one) => one.name === name);
  }
  const out: LearnedWorkflow[] = [];
  for (const one of chosen) {
    if (one.name === name) {
      out.push(one);
      continue;
    }
    const digest = workflowDigest(one);
    const champion = championOf(records, one.name);
    if (champion?.digest === digest) {
      out.push(one);
      continue;
    }
    const text = champion?.commit && deps.champion ? await deps.champion(one.name, champion.commit).catch(() => undefined) : undefined;
    if (text && workflowDigest(text) === champion!.digest) {
      deps.log(`workflow-first: the learned_workflow tool runs ${one.name}'s champion at ${champion!.digest}, not ${digest}, which is not promoted`);
      out.push(text);
    } else deps.log(`workflow-first: the learned_workflow tool leaves out ${one.name}: ${digest} is not promoted, and ${champion ? `its champion at ${champion.digest} could not be read from its learning commit` : "no revision of it serves"}`);
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The claim's seed as a record's `commit`: the learning commit the laid workflow's text was read from. */
const seedOf = (deps: Pick<PromotionDeps, "launch">): { commit?: string } => (deps.launch.learning?.seed ? { commit: deps.launch.learning.seed } : {});
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The gate workflowFirstOf asks (its `promoted`), at every run's claim, a queued run's included: the workflow that serves
 *  this run first. A run already executing keeps the revision an earlier claim of it served (keptFor). Else the laid
 *  revision (`workflow` at `digest`, the folder's revision as the run's seed holds it) has its check moved on (decide:
 *  started, or settled once its runs ended), and then servingNow alone says who serves: the champion (championOf), the
 *  laid text when it is the champion, its own text read from its record's commit when not; undefined when none serves
 *  (the agent takes the run). A digest's own record never says it serves. */
export const promotionGate = (deps: PromotionDeps): Promoted => {
  const failed = (workflow: LearnedWorkflow, error: unknown) => {
    // A promotion that could not be read or written leaves the run to its agent: never a workflow served unchecked.
    deps.log(`workflow-first: ${workflow.name}'s promotion could not be read (${(error as Error)?.message ?? error}); the agent takes this run`);
    return undefined;
  };
  const gate = async (workflow: LearnedWorkflow, digest: string): Promise<Serving | undefined> => {
    try {
      const kept = await keptFor(deps, workflow, digest);
      if (kept) return { workflow: kept };
      await decide(deps, workflow, digest);
      return await holdRefused(deps, await servingNow(deps, workflow, digest, true));
    } catch (error) {
      return failed(workflow, error);
    }
  };
  // The champion alone, for a laid revision that does not take the run's input (workflowFirstOf): nothing is checked.
  const champion = async (workflow: LearnedWorkflow, digest: string): Promise<Serving | undefined> => {
    try {
      const kept = await keptFor(deps, workflow, digest);
      return kept ? { workflow: kept } : await holdRefused(deps, await servingNow(deps, workflow, digest, false));
    } catch (error) {
      return failed(workflow, error);
    }
  };
  return Object.assign(gate, { champion });
};

/** Who serves `workflow` now, the one answer every serving path asks: its champion (championOf, read fresh from the
 *  records), never a digest's own record, so a revision promoted before another was (or before the champion was held)
 *  never serves again. The laid revision at `digest` when it is the champion; `laid` false: it is not asked (the laid text
 *  does not take the input). Another champion: its text at its record's commit (its digest checked). Undefined when none
 *  serves: none promoted, the champion held, or its text cannot be read (the agent takes the run). */
async function servingNow(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, laid: boolean): Promise<Serving | undefined> {
  const records = await promotionsOf(deps.store.settings, deps.agentId);
  const champion = championOf(records, workflow.name);
  const own = promotionOf(records, workflow.name, digest);
  if (!champion) {
    if (own?.decided === "promote") deps.log(`workflow-first: ${workflow.name} at ${digest} was promoted, but the revision promoted after it is held; no revision serves, the agent takes this run`);
    return undefined;
  }
  if (champion.digest === digest) return laid ? { workflow } : undefined;
  if (!deps.champion) return undefined;
  const text = champion.commit ? await deps.champion(workflow.name, champion.commit).catch(() => undefined) : undefined;
  if (!text || workflowDigest(text) !== champion.digest) {
    deps.log(`workflow-first: ${workflow.name}'s champion at ${champion.digest} could not be read from its learning commit; the agent takes this run`);
    return undefined;
  }
  deps.log(`workflow-first: ${workflow.name}'s champion at ${champion.digest} serves this run while ${digest} ${own?.decided === "promote" ? "is a revision promoted before it" : "is not promoted"}`);
  return { workflow: text };
}

/** The words a hold of a serving revision this release's workflow DSL refuses starts with (holdRefused). */
export const DSL_REFUSES = "this release's workflow DSL refuses it";

/** `serving` as it serves this run, once a serving revision this release's workflow DSL refuses is held. The refusal is of
 *  the text alone (learn/workflow-draft.ts dslRefusalOf: the DSL's own validation, no tool list), never of a host setting (a tool
 *  gated, denied or missing, no adapter), which the run's own check still refuses as before. The hold is a promotion
 *  record of its digest, `hold` by its reason alone ("this release's workflow DSL refuses it: <code> at <path>: <its
 *  words>", cut of the host's secrets as a check's texts are), written only while the digest's newest record is still the
 *  promotion this claim read: of two claims at once one writes it, and a later claim finds it (nothing serves). The run
 *  still runs it, refused before any node runs, and hands back as before: the agent answers. The hold follows compile
 *  once as a check's does: the agent's next due run asks the one recompile with the reason as data (learn/compile.ts
 *  heldNamesOf), and that revision's check is the compile's second (attemptOf). */
async function holdRefused(deps: PromotionDeps, serving: Serving | undefined): Promise<Serving | undefined> {
  if (!serving) return serving;
  const refused = dslRefusalOf(await import("@parcha/agentrun-dsl"), serving.workflow.workflow);
  if (refused === undefined) return serving;
  const { name } = serving.workflow;
  const digest = workflowDigest(serving.workflow);
  const current = promotionOf(await promotionsOf(deps.store.settings, deps.agentId), name, digest);
  if (current?.decided !== "promote") return serving;
  const reason = excerptShown(`${DSL_REFUSES}: ${refused}`, await deps.shown(), CHECK_TEXT_MAX);
  const record: PromotionRecord = { workflow: name, digest, at: iso((deps.now ?? Date.now)()), decided: "hold", reason, ...(current.commit ? { commit: current.commit } : {}) };
  const kept = await recordPromotion(deps.store.settings, deps.agentId, record, (was) => was?.decided === "promote" && was.at === current.at);
  if (kept.won) deps.log(`workflow-first: ${name} at ${digest} is held: ${reason}; the agent's next run recompiles it once`);
  return serving;
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
    // Its newest record naming a commit.
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

/** Moves the laid revision's check on: a new digest is checked (startCheck), a replaying one settled once its runs ended
 *  (after finishing a launch that was interrupted). It decides nothing about who serves (servingNow does). */
async function decide(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string): Promise<void> {
  const { store, agentId, log } = deps;
  const record = promotionOf(await promotionsOf(store.settings, agentId), workflow.name, digest);
  if (record?.decided === "promote") return;
  if (record?.decided === "hold") {
    log(`workflow-first: ${workflow.name} at ${digest} is held (${record.reason}); it does not serve this run`);
    return;
  }
  if (record?.decided === "replaying") {
    await relaunch(deps, workflow, digest, record);
    if (!(await settleCheck(deps, workflow, digest, record))) log(`workflow-first: ${workflow.name} at ${digest} is being checked on ${record.runs?.length ?? 0} of the agent's inputs; it does not serve this run`);
    return;
  }
  return startCheck(deps, workflow, digest);
}

/** The loop's numbers (learning-setting.ts) of the revision the claim runs: its definition's `learning`, each one it
 *  leaves out at its default, and the answer paths its check compares on (its agree_on; none, the whole answer). A read
 *  that fails throws: no check is saved on defaults (a bar with no agree_on would compare the whole answer for the
 *  check's life); the claim's gate leaves the run to its agent and the next claim reads it again (#3182 review). */
async function loopOfRevision(deps: Pick<PromotionDeps, "store" | "revisionId">) {
  const revision = await deps.store.agents.revision(deps.revisionId);
  return loopOf((revision?.body as { learning?: unknown } | undefined)?.learning);
}

/** Which check of a compile a new revision's is: 2 when the workflow's newest record of another revision is a first
 *  check's hold, an audit's hold or a hold by its reason alone (holdRefused: the DSL refuses a serving revision), or a
 *  first compile's failed draft (this revision is its one recompile), else 1. A stop with nothing checked
 *  (stopUnchecked) is no first check's hold: it spends no recompile. A workflow's first revision after a first compile
 *  whose drafts failed under another name (learn/compile.ts newCompileAttempt) is that compile's recompile too. */
export function attemptOf(records: readonly PromotionRecord[], name: string, digest: string): 1 | 2 {
  const before = records.findLast((one) => one.workflow === name && one.digest !== digest);
  if (!before) return newCompileAttempt(records.filter((one) => one.digest !== digest));
  if (before.decided !== "hold") return 1;
  if (before.audit) return before.audit.stopped ? 1 : 2;
  return !before.check || (before.check.attempt === 1 && !before.check.stopped) ? 2 : 1;
}

/** The shadow runs a recompile's check runs on beside the agent's last runs: the disagreeing audit rows the workflow's
 *  newest audit hold names (a grade's row has no answer of the agent's to check against), when that hold is the
 *  workflow's newest record of another revision. */
function auditInputsOf(records: readonly PromotionRecord[], name: string, digest: string): string[] {
  const before = records.findLast((one) => one.workflow === name && one.digest !== digest);
  if (before?.decided !== "hold" || !before.audit || before.audit.stopped) return [];
  return before.audit.disagreements.filter((one) => !one.graded && one.agent !== null).map((one) => one.run);
}

/** An agent run a check may read its input from: a completed run of its own (agentRun: no learned workflow answered it
 *  alone, and it is no replay), neither archived nor imported, and never the claimed run (lastOwnRuns' own rule). */
const checkable = (deps: Pick<PromotionDeps, "runId">, row: RunRow): boolean =>
  row.id !== deps.runId && agentRun(row) && row.archivedAt === null && !row.importedFrom;

/** The inputs a check runs its draft on: the agent's runs `pick.of` names (a check's own, asked again; each still
 *  checkable), then the agent's last `pick.n` completed runs of its own (lastOwnRuns: never the claimed run, an archived
 *  or imported one), newest first, picked before anything else limits them: runs its workflow served since, however many,
 *  never push them out of the read. And `audited`: an audit hold's disagreeing shadow runs (auditInputsOf), each ended.
 *  Of those, the ones whose input `workflow` takes (fits), each with its launch read back; one with an uploaded file is
 *  never an input. With how many of the agent's runs it looked at (`looked`) and why each it looked at is no input
 *  (`unfit`, `files`). */
async function checkInputs(deps: Pick<PromotionDeps, "store" | "agentId" | "runId">, workflow: LearnedWorkflow, pick: { readonly of: readonly string[]; readonly n: number }, audited: readonly string[] = []): Promise<{ inputs: ReplayInput[]; looked: number; unfit: number; files: number }> {
  const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
  const named = (await Promise.all(pick.of.map((id) => deps.store.runs.get(id)))).filter((row): row is RunRow => row !== undefined && checkable(deps, row));
  const last = pick.n ? await lastOwnRuns(deps.store, deps.agentId, pick.n + pick.of.length, deps.runId) : [];
  const own = [...named, ...last.filter((row) => !pick.of.includes(row.id)).slice(0, pick.n)];
  // And an audit hold's disagreeing shadow runs: the agent's answers the recompile must say too.
  for (const id of audited) {
    const row = await deps.store.runs.get(id);
    if (row && row.state === "ended" && !own.some((one) => one.id === id)) own.push(row);
  }
  const out: ReplayInput[] = [];
  let files = 0;
  for (const row of own) {
    const launch = await deps.store.runs.launch(row.id).then((one) => readLaunchBody(one.body), () => undefined);
    if (launch?.files?.length) files += 1;
    if (!launch || launch.files?.length || launch.replay || !fits(workflow, launch.input, resolveSchemaForWorkflow as never)) continue;
    out.push({ run: row.id, launch });
  }
  return { inputs: out, looked: own.length, unfit: own.length - out.length - files, files };
}

/** Starts a new revision's one check: a replay run of it on each input of the agent's last compile_after completed runs
 *  (checkInputs), at workflow cost, the agent taking the runs meanwhile; reserved with the bar its definition says now
 *  (CheckBar) and only while no other revision of the workflow is replaying (one at a time). A later claim, or the
 *  replay's read, decides it once its runs ended (settleCheck). With no input it takes (a workflow landed before any run
 *  it fits), it is decided at once: never promoted, it stops with nothing checked (stopUnchecked). */
async function startCheck(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string): Promise<void> {
  const { store, agentId, log } = deps;
  // Its replay runs are runs the runner starts, on no caller's key: skipped where the claimed run brought its own key or
  // the server holds none (claimSpendOff).
  const off = deps.spendOff?.("A learned workflow's replay check");
  if (off) return void log(`workflow-first: ${off} ${workflow.name} at ${digest} is not checked and does not serve this run`);
  // Only the learning folder's newest revision is checked: a run pinned to an older commit lays an older text.
  const newest = deps.newest ? await deps.newest(workflow.name) : undefined;
  if (newest !== undefined && newest !== digest) {
    log(`workflow-first: ${workflow.name} at ${digest} is not the learning folder's newest revision of it (${newest}); it is not checked and does not serve this run`);
    return;
  }
  // One check at a time, and one at work finishes: decided here once its runs ended (its verdict stands), never
  // cancelled. While it runs, this revision waits, recording nothing: the claim after it is decided starts this one.
  for (const ahead of replayingOf(await promotionsOf(store.settings, agentId), workflow.name, digest)) await settleAhead(deps, workflow.name, ahead);
  const records = await promotionsOf(store.settings, agentId);
  const rival = replayingOf(records, workflow.name, digest)[0];
  if (rival) {
    log(`workflow-first: ${workflow.name} at ${digest} waits: ${rival.digest} is being checked (one check at a time); it does not serve this run`);
    return;
  }
  const loop = await loopOfRevision(deps);
  const bar: CheckBar = { ...loop, attempt: attemptOf(records, workflow.name, digest) };
  const { inputs, looked, unfit, files } = await checkInputs(deps, workflow, { of: [], n: loop.compile_after }, auditInputsOf(records, workflow.name, digest));
  if (!inputs.length) {
    // Nothing of the agent's to check it on (a workflow landed before any run it fits): never promoted unchecked. It
    // stops, its record naming why (the compile's draft error), and asks no recompile: a revision would have nothing to be
    // checked on either.
    const why = !looked
      ? "the agent has no completed run of its own to check it against"
      : `none of the agent's last ${plural(looked, "completed run")} has an input it takes${files ? ` (${files} came with an uploaded file, which a check never replays${unfit ? `; ${unfit} do not fit its input` : ""})` : ""}`;
    await stopUnchecked(deps, workflow.name, digest, bar, why, (was) => was === undefined);
    return;
  }
  const said = `checking it on ${plural(inputs.length, "input")} of the agent's last ${plural(bar.compile_after, "completed run")} against its own answers`;
  const reserved = await reserve(deps, workflow, digest, inputs, said, (was) => was === undefined, bar);
  if (!reserved.won) {
    log(`workflow-first: ${workflow.name} at ${digest}: another claim's decision on it came first; it does not serve this run`);
    return;
  }
  log(`workflow-first: ${workflow.name} at ${digest} is new: ${said} before it serves`);
}

/** The words a stopped check's record starts with when it had nothing to check its draft on. */
export const NOTHING_TO_CHECK = "nothing to check it on";
/** What a held check compared on the whole answer says when it answered some inputs alone and agreed on none: only a
 *  check no grader compared (no agree_on, and no fast model to read the answers). */
export const NEVER_WORD_FOR_WORD = "its answers never matched the agent's word for word, and no fast model compared their decisions (a learning agent with no agree_on wants one: AGENT_MODEL_FAST, or its model_tiers.fast); name the fields that carry the decision (learning.agree_on)";
/** What a held check the grader compared says of the inputs it disagreed on: k of n, with one of the decisions. */
export const differentDecisionWords = (k: number, n: number, example: string | undefined): string => `its answers reached a different decision from the agent's on ${k} of ${n}${example ? ` (for example: ${example})` : ""}`;

/** Stops a draft its check had nothing to run on (`why`: no input of the agent's it takes, or every input skipped at a
 *  write): held, never promoted unchecked, its record `stopped` (nothing compiles again until a hold or its owner acts)
 *  and naming the cause, which the compile's draft errors show (store-reads/loop.ts). It asks no recompile: a revision
 *  would have nothing to be checked on either, and a stop with nothing checked never counts as a compile's first check
 *  (attemptOf). Kept only while `still` holds of the digest's record (the one write). */
async function stopUnchecked(deps: PromotionDeps, name: string, digest: string, bar: CheckBar, why: string, still: (was: PromotionRecord | undefined) => boolean, check: Partial<CheckRecord> = {}, extra: Partial<PromotionRecord> = {}) {
  const reason = `${NOTHING_TO_CHECK}: ${why}. It is not promoted, and it stops: nothing compiles again until a hold or its owner acts`;
  const decided = await recordPromotion(deps.store.settings, deps.agentId, { workflow: name, digest, at: iso((deps.now ?? Date.now)()), decided: "hold", reason, check: { ...bar, n: 0, agreed: 0, alone: 0, of: [], ...check, stopped: true }, ...seedOf(deps), ...extra }, still);
  if (decided.won) deps.log(`workflow-first: ${name} at ${digest} stopped: ${reason}`);
  return decided;
}

/** One input a check ran its draft on: the agent's run (`of`) and its input, the agent's recorded answer, and what the
 *  draft did: its answer when it answered alone, why it handed the input back, or failed (or skipped a write). A
 *  reserved input whose replay run was never created, or never ended, by the check's deadline failed (`unstarted` for
 *  the first). */
type CheckRow = { readonly of: string; readonly input: string; readonly agent: string | null; readonly outcome: ReplayOutcome; readonly answer: string | null; readonly escalated?: string; readonly skipped?: Skipped; readonly unstarted?: true; readonly compared?: Compared };

/** Decides `ahead`, the check at work for a revision older than the laid (newest) one, as a claim laying it would
 *  (relaunch, then settleCheck) once its runs ended: its text read at its record's commit, its verdict standing (promote
 *  or hold) though a newer revision waits. Left replaying while a run of it is at work, or when its text cannot be read
 *  (its read, replayView, decides it then). */
async function settleAhead(deps: PromotionDeps, name: string, ahead: PromotionRecord): Promise<void> {
  const text = ahead.commit && deps.champion ? await deps.champion(name, ahead.commit).catch(() => undefined) : undefined;
  if (text === undefined || workflowDigest(text) !== ahead.digest) {
    deps.log(`workflow-first: ${name} at ${ahead.digest} is being checked, and its text could not be read from its learning commit to decide it at this claim`);
    return;
  }
  await relaunch(deps, text, ahead.digest, ahead);
  await settleCheck(deps, text, ahead.digest, ahead);
}

/** A check's rows, once every replay run ended (or REPLAY_DEADLINE_MS passed); undefined while one is at work or not
 *  created yet. One row per reserved input, so every one counts: a run not ended by the deadline failed, and so did one
 *  never created by then (`unstarted`: the server stopped after reserving it, say), its input read from the agent's run
 *  the record names for it. With what its runs cost, the rows' outcomes (one per row, the never created failed), and how
 *  many were never created by the deadline.
 *  No grade is read: the label is the agent's own recorded answer. */
async function checkRows(deps: Pick<PromotionDeps, "store" | "context" | "now">, record: PromotionRecord): Promise<{ rows: CheckRow[]; cost: number | null; outcomes: ReplayOutcomes; unstarted: number } | undefined> {
  const { store, context } = deps;
  const runs = await Promise.all((record.runs ?? []).map((id) => store.runs.get(id)));
  const late = (deps.now ?? Date.now)() - Date.parse(record.at) > REPLAY_DEADLINE_MS;
  if (!late && runs.some((row) => !row || !FINAL_STATES.includes(row.state))) return undefined;
  const rows: CheckRow[] = [];
  for (const [i, run] of runs.entries()) {
    const reservedOf = record.inputs?.[i];
    const launch = run ? await store.runs.launch(run.id).then((one) => readLaunchBody(one.body), () => undefined) : undefined;
    const replayed = launch?.replay?.of;
    if (!run || !launch || !replayed) {
      // Never created (or its launch unreadable): a failed input, never left out of n.
      const of = reservedOf;
      const from = of ? await store.runs.launch(of).then((one) => readLaunchBody(one.body), () => undefined) : undefined;
      rows.push({ of: of ?? record.runs![i]!, input: from ? inputText(from.input) : "", agent: of ? await answerOf(store, of, context) : null, outcome: "failed", answer: null, ...(run ? {} : { unstarted: true as const }) });
      continue;
    }
    const outcome = outcomeOf(run);
    const stoppedAt = outcome === "skipped_write" ? metricsOf(run).replay?.skipped : undefined;
    // The grader's verdict on this pair, asked at the replay run's end (runner/compare-end.ts).
    const compared = outcome === "answered" ? comparedOf(metricsOf(run).replay?.compared) : undefined;
    rows.push({
      ...(compared ? { compared } : {}),
      of: replayed, input: inputText(launch.input), agent: await answerOf(store, replayed, context), outcome,
      answer: outcome === "answered" ? await answerOf(store, run.id, context) : null,
      ...(outcome === "handed_back" ? { escalated: (await handedBackOf(store, run.id, context)) ?? "" } : {}),
      ...(stoppedAt ? { skipped: stoppedAt } : {}),
    });
  }
  // The outcomes are the rows', so they add up to its n: a reserved run never created is a failed input there too.
  const outcomes = { ...NO_OUTCOMES };
  for (const row of rows) outcomes[row.outcome] += 1;
  return { rows, cost: replayCost(runs, late), outcomes, unstarted: rows.filter((row) => row.unstarted).length };
}

/** A run's input as a check's disagreement shows it: its text, else its JSON. */
const inputText = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input) ?? "");

/** What a replay run's workflow said when it handed its input back: its learned_workflow call's result. */
async function handedBackOf(store: PromotionDeps["store"], runId: string, context: Context): Promise<string | undefined> {
  try {
    const rows = await runTimeline(store, runId, context, { settled: true, caps: { text: Number.POSITIVE_INFINITY } });
    return rows.findLast((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL)?.tool_result_preview ?? undefined;
  } catch {
    return undefined;
  }
}

/** A replaying check's decision, once its replay runs ended (checkRows); undefined while one is at work. */
async function settleCheck(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<PromotionRecord | undefined> {
  const { name } = workflow;
  const read = await checkRows(deps, record);
  if (!read) return undefined;
  const bar: CheckBar = record.check ?? { ...(await loopOfRevision(deps)), attempt: 1 };
  const decided = await decideCheck(deps, name, digest, bar, read, (was) => sameReplay(was, record), { ...(record.runs ? { runs: record.runs } : {}), ...(record.replay_id ? { replay_id: record.replay_id } : {}), ...(record.commit ? { commit: record.commit } : {}) });
  if (decided.won) {
    const cancelled = await cancelUnended(deps, record);
    if (cancelled) deps.log(`workflow-first: ${name} at ${digest}: ${plural(cancelled, "replay run")} still at work past the check's deadline cancelled`);
  }
  return decided.record?.decided === "replaying" ? undefined : decided.record;
}

/** Decides a check on its rows: each input it ran on (a skipped write is none) agreed when the draft answered it alone
 *  with the agent's recorded answer (learn/promote.ts compareAnswers, the audit's one comparison: on the bar's agree_on
 *  when it names fields, else equal, or the same decision by the grader's verdict its replay run kept), alone
 *  when it answered it with no escalate and no failed step. Promoted when it clears the bar (checkPasses); else held with the inputs it did not agree on, which the
 *  agent's next run's compile turn reads as data (its one recompile); a recompile's check that holds it too stops:
 *  nothing compiles again. No grade, refit, queue or second replay. Kept only while `still` holds of the digest's record
 *  (the one write: of two claims at once, one decides). */
export async function decideCheck(deps: PromotionDeps, name: string, digest: string, bar: CheckBar, read: { rows: readonly CheckRow[]; cost: number | null; outcomes: ReplayOutcomes; unstarted: number; exactMismatchReason?: string }, still: (was: PromotionRecord | undefined) => boolean, extra: Partial<PromotionRecord>) {
  const now = deps.now ?? Date.now;
  const ran = read.rows.filter((row) => row.outcome !== "skipped_write");
  const alone = (row: CheckRow) => row.outcome === "answered";
  // Compared on the bar's agree_on when it names paths (the definition's), else equal answers agree and the grader's
  // verdict decides the rest; with no grader (no fast model), the whole answer.
  const compared = new Map(ran.map((row) => [row, compareAnswers(row.answer, row.agent, bar.agree_on, row.compared)]));
  const agrees = (row: CheckRow) => alone(row) && compared.get(row)!.same;
  const score = { n: ran.length, agreed: ran.filter(agrees).length, alone: ran.filter(alone).length };
  const ok = checkPasses(score, bar);
  // The fast model that compared, when it read any input's answers.
  const grader = [...compared.values()].find((one) => one.grader !== undefined)?.grader;
  // Each text is cut of the host's secrets whole, then shortened (learn/secrets.ts excerptShown).
  const shown = await deps.shown();
  const cut = (text: string) => excerptShown(text, shown, CHECK_TEXT_MAX);
  const disagreements: CheckDisagreement[] = ran.filter((row) => !agrees(row)).map((row) => {
    const differs = row.outcome === "answered" ? compared.get(row)!.differs_on : undefined;
    return {
      run: row.of, input: cut(row.input), agent: row.agent === null ? null : cut(row.agent),
      ...(row.outcome === "answered" ? { draft: cut(row.answer ?? "") } : row.outcome === "handed_back" ? { escalated: cut(row.escalated ?? "") } : { failed: true as const }),
      ...(differs ? { differs_on: cut(differs) } : {}),
    };
  });
  const stopped = !ok && bar.attempt === 2;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const shares = checkShares(score);
  // Inputs stopped at a write the recording lacks are no evidence either way; one stopped at an MCP tool its server listed
  // with no readOnlyHint names that tool (skipWordsOf), never a data problem.
  const tools = skippedToolsOf(read.rows);
  const { skipped_write: skipped, failed } = read.outcomes;
  const { hint, why: skipWhy } = skipWordsOf(tools, skipped);
  const numbers = { of: read.rows.map((row) => row.of), cost_usd: read.cost, outcomes: read.outcomes, ...(read.unstarted ? { unstarted: read.unstarted } : {}), ...(tools.length ? { skipped_tools: tools } : {}) };
  // Every input skipped at a write (each reserved input counts: one never created or never ended failed, so this is the
  // only way to none): nothing to check it on, so it stops, never promoted unchecked, and asks no recompile.
  if (!score.n) {
    const why = skipped ? `${plural(skipped, "input")} skipped because ${hint ? skipWhy : `each ${SKIPPED_WRITE} (a check never runs a write)`}` : "it ran on no input";
    return stopUnchecked(deps, name, digest, bar, why, still, numbers, extra);
  }
  // A run never created is a failed outcome too, said once: as never started.
  const ranFailed = failed - read.unstarted;
  const aside = [...(ranFailed ? [`${ranFailed} failed: a step failed, or it was still at work at the check's deadline`] : []), ...(skipped ? [`${skipped} skipped: ${skipWhy}`] : []), ...(read.unstarted ? [`${read.unstarted} never started by the check's deadline (the server stopped after reserving it, say), each a failed input`] : [])].join("; ");
  // Every input reserved and none started (a launch interrupted before its first run existed): each counts failed in n,
  // and the words say none ran.
  const said = read.unstarted === score.n
    ? `none of its ${plural(score.n, "check run")} started by the check's deadline (its launch was interrupted: the server stopped after reserving it, say): nothing was checked`
    : `checked on ${score.n} of the agent's inputs: answered ${score.alone} alone (${pct(shares.alone)}, the bar ${pct(bar.alone_min)}), and ${score.agreed} of those said what the agent said${bar.agree_on?.length ? ` on ${listed(bar.agree_on)}` : grader ? `, compared by the fast model (${grader})` : ""} (${pct(shares.agreement)}, the bar ${pct(bar.agree_min)})${aside ? ` (${aside})` : ""}`;
  // The grader compared: how many answered alone reached another decision, with one it named. Compared whole and never
  // once the same (no grader): free text two runs never repeat, most likely, so the owner is told what to set.
  const differed = score.alone - score.agreed;
  const example = disagreements.find((one) => one.differs_on !== undefined)?.differs_on;
  const verbatim = ok || bar.agree_on?.length ? "" : grader ? (differed > 0 ? `; ${differentDecisionWords(differed, score.alone, example)}` : "") : score.alone > 0 && score.agreed === 0 ? `; ${read.exactMismatchReason ?? NEVER_WORD_FOR_WORD}` : "";
  const reason = ok ? `${said}: promoted` : stopped ? `${said}: held${verbatim}, and this was the recompile's check, so it stops: nothing compiles again until a hold or its owner acts` : `${said}: held${verbatim}; the agent's next run recompiles it once with the inputs it did not agree on`;
  const check: CheckRecord = { ...bar, ...score, ...numbers, ...(disagreements.length ? { disagreements } : {}), ...(stopped ? { stopped: true as const } : {}), ...(grader ? { grader } : {}) };
  const decided = await recordPromotion(deps.store.settings, deps.agentId, { workflow: name, digest, at: iso(now()), decided: ok ? "promote" : "hold", reason, check, ...seedOf(deps), ...extra }, still);
  if (decided.won) deps.log(`workflow-first: ${name} at ${digest} ${ok ? "promoted" : "held"}: ${reason}`);
  return decided;
}

/** Reserves a check of `workflow` at `digest` on `inputs`, then starts its runs: its replaying record names the replay
 *  runs it will start (their ids, and the replay's own, minted here), kept only when `still` holds of the digest's record
 *  now and no other revision of the workflow replays, in the one guarded write. Only the writer that kept it starts them:
 *  a claim of the same digest, or of another revision, or a person's ask, at once, starts none. A claim's (startCheck) and
 *  a person's (askReplay) are this one reservation. */
async function reserve(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, inputs: readonly ReplayInput[], reason: string, still: (was: PromotionRecord | undefined) => boolean, check: CheckBar) {
  const now = deps.now ?? Date.now;
  const ids = inputs.map(() => uuidv7());
  const launch = replayLaunchOf(deps);
  const reserved = await recordPromotion(deps.store.settings, deps.agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "replaying", reason, runs: ids, inputs: inputs.map((one) => one.run), replay_id: uuidv7(), launch, ...seedOf(deps), check },
    (was, items) => still(was) && replayingOf(items, workflow.name, digest).length === 0);
  if (reserved.won) for (const [i, one] of inputs.entries()) await startReplay(deps, workflow, digest, one.run, one.launch, ids[i]!, launch);
  return reserved;
}

/** An input a replay runs on: the agent run whose input it is, and that run's launch. */
type ReplayInput = { readonly run: string; readonly launch: RunLaunch };

/** The launch a replay's runs all run with (PromotionRecord.launch), chosen once by the claim or person reserving it:
 *  `deps.launch` as a replay run takes it (a claim's claimed run's; a person's ask makes one now), the revision it runs,
 *  and the claimed run as the one whose per_run MCP credentials its runs are handed, when the server can seal them. A
 *  person's ask claims no run, so an owner's replay runs are handed none. */
function replayLaunchOf(deps: PromotionDeps): ReplayLaunch {
  const { launch } = deps;
  const base: RunLaunch = {
    input: null,
    title: "",
    place: launch.place,
    ...(launch.harness !== undefined ? { harness: launch.harness } : {}),
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
    ...(launch.maxCostUsd !== undefined ? { maxCostUsd: launch.maxCostUsd } : {}),
    ...(launch.plane ? { plane: launch.plane } : {}),
    ...(launch.approvers !== undefined ? { approvers: launch.approvers } : {}),
    ...(launch.documents !== undefined ? { documents: launch.documents } : {}),
    ...(launch.boxAllow !== undefined ? { boxAllow: launch.boxAllow } : {}),
    ...(launch.boxAllowSet ? { boxAllowSet: true as const } : {}),
    ...(launch.learning ? { learning: launch.learning } : {}),
    ...(launch.archilDisk ? { archilDisk: launch.archilDisk } : {}),
  };
  return { revision: deps.revisionId, body: launchBody(base), ...((deps.sealKey || held()) && deps.runId ? { handed_from: deps.runId } : {}) };
}

/** Whether `was`, a digest's newest record now, is still the replay `record` reserved: replaying, under the same replay
 *  id. A replay settled meanwhile, and a newer replay of the same revision its owner started since (a held revision may
 *  be replayed again), are not: an older replay's late decision never lands over a newer one. */
const sameReplay = (was: PromotionRecord | undefined, record: PromotionRecord): boolean => was?.decided === "replaying" && was.replay_id === record.replay_id;

/** Cancels each of `record`'s replay runs not ended, as a person's cancel is (an in-flight one stops, what it spent booked
 *  on its row): once its check is decided with runs still at work (past its deadline). How many were sent their cancel. The
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

/** The per_run MCP credentials run `launch.handed_from` was handed (its launch's sealed column, opened under the seal
 *  key), sealed for the replay run `id` alone, as the server's start seals a run's mcp_auth (store/seal.ts
 *  sealRunMcpAuth): the replay's claim reads them where any run's claim does (runner/mcp-claim.ts). None when the replay
 *  names no such run (an owner's), that run was handed none, or they do not open. Never written anywhere else, never
 *  logged. */
async function handedTo(deps: PromotionDeps, launch: ReplayLaunch, id: string): Promise<Uint8Array | undefined> {
  const from = launch.handed_from;
  if (!from) return undefined;
  // A run's own process holds no seal key: its runner seals them again, from its own run alone (held.ts handOn).
  if (!deps.sealKey) return held()?.handOn(from, id);
  const sealed = await deps.store.runs.launch(from).then((one) => one.sealed ?? null, () => null);
  const handed = sealed === null ? undefined : openRunMcpAuth(deps.sealKey, from, sealed);
  return handed && Object.keys(handed).length ? sealRunMcpAuth(deps.sealKey, id, handed) : undefined;
}

/** Starts the replay of `workflow` at `digest` on agent run `of` (its launch `from`) as run `id` (the id its reserved
 *  record names), with the replay's chosen `launch` (replayLaunchOf: its run launch, revision and handed credentials,
 *  handedTo), whichever claim creates it. False when a run by that id exists already: another claim created it (a
 *  relaunch and the reserving claim at once), and it is left to that one. */
async function startReplay(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, of: string, from: RunLaunch, id: string, launch: ReplayLaunch): Promise<boolean> {
  const { store, agentId } = deps;
  const base = readLaunchBody(launch.body);
  if (!base) throw new Error(`the launch of ${workflow.name} at ${digest}'s replay could not be read`);
  const replay: RunLaunch = { ...base, input: from.input, title: `Replay of ${workflow.name}: ${from.title}`.slice(0, 200), replay: { of, workflow: workflow.name, digest } };
  const sealed = await handedTo(deps, launch, id);
  try {
    await store.runs.create({ id, agentId, revisionId: launch.revision }, { body: launchBody(replay) as Json, ...(sealed ? { sealed } : {}) });
    return true;
  } catch (error) {
    if (error instanceof StoreConstraint && (await store.runs.get(id))) return false;
    throw error;
  }
}

/** Finishes a launch that was interrupted: `record`'s reserved replay runs still not created REPLAY_LAUNCH_GRACE_MS after
 *  its reservation (and before its deadline) are created now, each under its reserved id on the agent run its record
 *  names for it (`inputs`), with the launch the record chose when it was reserved (`launch`: its model, revision and
 *  handed credentials, an owner's replay none), never this claim's: one check runs on one set of settings. One whose
 *  agent run's launch can no longer be read stays missing: past the deadline it is counted as never started. How many
 *  this claim created. */
async function relaunch(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<number> {
  const { store } = deps;
  if (deps.spendOff?.("A replay")) return 0;
  const since = (deps.now ?? Date.now)() - Date.parse(record.at);
  const launch = record.launch;
  if (!launch || since <= REPLAY_LAUNCH_GRACE_MS || since > REPLAY_DEADLINE_MS) return 0;
  let made = 0;
  for (const [i, id] of (record.runs ?? []).entries()) {
    const of = record.inputs?.[i];
    if (!of || (await store.runs.get(id))) continue;
    const from = await store.runs.launch(of).then((one) => readLaunchBody(one.body), () => undefined);
    if (from && (await startReplay(deps, workflow, digest, of, from, id, launch))) made += 1;
  }
  if (made) deps.log(`workflow-first: ${workflow.name} at ${digest}: its check's launch was interrupted; ${plural(made, "replay run")} it reserved started now`);
  return made;
}

/** A run's final answer row, its text whole (its last final answer row that is not its end-of-run turn's), or null: none,
 *  or its record could not be read. `turn`: the row of that id instead (the answer an audit is of, runner/audit.ts), so an
 *  answer a follow-up gave since is never read for it. */
export async function answerRowOf(store: PromotionDeps["store"], runId: string, context: Context, turn?: string): Promise<{ id: string; text: string } | null> {
  try {
    const rows = await runTimeline(store, runId, context, { settled: true, caps: { text: Number.POSITIVE_INFINITY } });
    const row = rows.findLast((one) => one.kind === "final_answer" && one.agent_label !== LEARNING_LABEL && (turn === undefined || one.id === turn));
    return typeof row?.text === "string" ? { id: row.id, text: row.text } : null;
  } catch {
    return null;
  }
}

/** A run's final answer, whole (answerRowOf's text; `turn`: that row's), or null. */
export const answerOf = async (store: PromotionDeps["store"], runId: string, context: Context, turn?: string): Promise<string | null> => (await answerRowOf(store, runId, context, turn))?.text ?? null;

const metricsOf = (row: RunRow | undefined) => (isObject(row?.metrics as Json) ? (row!.metrics as { replay?: { outcome?: unknown; skipped?: Skipped; compared?: unknown }; path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : {});

/** What a replay run did, read from its row alone: answered, handed back or skipped at a write once it ended as such; any
 *  other end, or one not ended (past the check's deadline), failed: no evidence either way. */
const outcomeOf = (run: RunRow): ReplayOutcome => {
  const m = metricsOf(run);
  return run.state === "ended" && (m.replay?.outcome === "answered" || m.replay?.outcome === "handed_back" || m.replay?.outcome === "skipped_write") ? m.replay.outcome : "failed";
};

const NO_OUTCOMES: ReplayOutcomes = { answered: 0, handed_back: 0, failed: 0, skipped_write: 0 };

/** How many of a check's runs ended each way so far (ReplayOutcomes): one not ended counts only past the deadline
 *  (`late`), as failed; one never created, nothing. */
function outcomesOf(runs: readonly (RunRow | undefined)[], late: boolean): ReplayOutcomes {
  const counts = { ...NO_OUTCOMES };
  for (const run of runs) if (run && (late || FINAL_STATES.includes(run.state))) counts[outcomeOf(run)] += 1;
  return counts;
}

/** What `record`'s replay runs cost together, at `now`: null while one's is unknown (one not created yet before the
 *  deadline, one not ended, one ended with no cost); a run never created by the deadline spent nothing. */
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

/** Why `skipped` inputs of a replay were skipped, in one phrase (`why`): the MCP tools among `tools` its server listed
 *  with no readOnlyHint, named (`hint`: the server may only lack the hint), with the rest in the recording's words;
 *  with none of those, the recording's words alone (SKIPPED_WRITE). */
function skipWordsOf(tools: readonly SkippedTool[], skipped: number): { hint: string | undefined; why: string } {
  const unmarked = tools.filter((one) => one.no_read_only_hint);
  const writes = skipped - unmarked.reduce((sum, one) => sum + one.inputs, 0);
  const hint = unmarked.length ? unmarkedWords(unmarked.map((one) => toolWord(one.tool))) : undefined;
  return { hint, why: !hint ? SKIPPED_WRITE : writes ? `${hint} (${writes} more ${writes === 1 ? "needs" : "need"} a write the recording doesn't have)` : hint };
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
 *  on: a replay run's is this one with its agent run's input (startReplay), at the revision's learning commit. */
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

/** The agent runs `name` at `digest` was last checked on: its newest record that names them, a decided
 *  check's `check.of` or a reservation's `inputs`. A check's reservation leaves the kept history (trimPromotions) while
 *  its decision stays, so the decision's own list is read first. Undefined when no record names any. */
function heldInputsOf(records: readonly PromotionRecord[], name: string, digest: string): readonly string[] | undefined {
  const checked = (one: PromotionRecord) => (one.decided !== "replaying" && one.check?.of?.length ? one.check.of : undefined);
  const last = records.findLast((one) => one.workflow === name && one.digest === digest && (checked(one) ?? one.inputs)?.length);
  return last && (checked(last) ?? last.inputs);
}

/** A check of `name` at `digest` a person asked for: the claim path's check (reserve, startReplay), on `inputs`: `held`,
 *  the agent runs its last check ran on (else, with none, the agent's last compile_after completed runs), or a number,
 *  the agent's newest that many (each a completed run of its own the workflow fits). Its runs end as a claim's do, and it
 *  is decided by settleCheck: at a claim that lays the revision, or at its read (replayView). Refused (ReplayRefused): no
 *  such workflow or revision; one replaying already, or another revision of it replaying (one at a time); a promoted one
 *  (it serves already); no input it fits (nothing is reserved); an agent that does not learn here. The replay's id and
 *  its inputs. */
export async function askReplay(ask: ReplayAsk, name: string, digest: string, inputs: "held" | number): Promise<{ replay: string; inputs: number }> {
  const records = await promotionsOf(ask.store.settings, ask.agentId);
  const found = await revisionOf(ask, records, name, digest);
  if ("named" in found) throw new ReplayRefused("missing", found.named ? `The learned workflow ${name} has no revision ${digest}: no promotion record names it, and the learning folder's main holds another.` : `The agent has no learned workflow ${name}.`);
  const own = promotionOf(records, name, digest);
  if (own?.decided === "replaying") throw new ReplayRefused("conflict", `${name} at ${digest} is replaying already: read that replay, or wait for it to end.`);
  if (own?.decided === "promote") throw new ReplayRefused("conflict", `${name} at ${digest} is promoted: it serves already. A replay checks a revision that does not serve yet, or was held.`);
  const rival = replayingOf(records, name, digest)[0];
  if (rival) throw new ReplayRefused("conflict", `${name} at ${rival.digest} is replaying: one revision of a workflow is checked at a time, and a running check finishes. Ask again once it ends.`);
  const last = inputs === "held" ? heldInputsOf(records, name, digest) : undefined;
  // The agent's own numbers (its current revision's definition, the one its replay runs launch on): with no earlier
  // check, its last compile_after completed runs, as the claim's check picks them (startCheck), never the default's.
  const current = (await ask.store.agents.get(ask.agentId).catch(() => undefined))?.currentRevision;
  const loop = current ? await loopOfRevision({ store: ask.store, revisionId: current }) : loopOf(undefined);
  const { inputs: picked } = await checkInputs({ store: ask.store, agentId: ask.agentId }, found.workflow, { of: last ?? [], n: typeof inputs === "number" ? inputs : last ? 0 : loop.compile_after });
  if (!picked.length) throw new ReplayRefused("conflict", `${name} at ${digest} has no input to replay on: none of ${typeof inputs === "number" ? `the agent's newest ${plural(inputs, "completed run")}` : last ? "the runs it was last checked on" : "the agent's last completed runs"} has an input it fits. Nothing was started.`);
  const { launch, revisionId } = await ask.launchOf(picked[0]!.launch.input as Json);
  if (!launch.learning || launch.learning.noWorkflows) throw new ReplayRefused("conflict", `A replay runs ${name} as a run of the agent that learns does, and the agent's runs do not take learned workflows here (its learning is off, it takes no workflows, or this server's is off).`);
  const deps: PromotionDeps = { store: ask.store, agentId: ask.agentId, revisionId, launch: { ...launch, learning: { ...launch.learning, seed: found.commit } }, context: ask.context, log: ask.log, shown: ask.shown, ...(ask.now ? { now: ask.now } : {}) };
  const bar: CheckBar = { ...loop, attempt: attemptOf(records, name, digest) };
  const said = `checking it on ${plural(picked.length, "input")} of the agent's own runs, as its owner asked`;
  // Kept only while the revision's newest record is still the one read here: each record write stamps a new `at`.
  const reserved = await reserve(deps, found.workflow, digest, picked, said, (was) => was?.at === own?.at && was?.decided === own?.decided, bar);
  if (!reserved.won || !reserved.record?.replay_id) throw new ReplayRefused("conflict", `${name} at ${digest} changed while this replay was asked for (another replay or decision came first): read its promotions and ask again.`);
  ask.log(`workflow-first: ${name} at ${digest}: ${said}`);
  return { replay: reserved.record.replay_id, inputs: picked.length };
}

/** A replay as its read answers it (GET .../replays/{replay_id}). `status`: `running` while its record says replaying,
 *  `done` once promoted or held, `failed` when none of its runs started by its deadline (nothing was replayed; held, its
 *  `reason` says so). `outcomes`: what its own runs did (outcomesOf), so far while it runs, and once decided as its
 *  record kept them. `score`: the decided check's numbers in the replay's shape with the agent's own answers as the label
 *  (`agree` the inputs the draft answered alone as the agent did, `agent_acc` 1, `wf_acc` those plus the ones handed back,
 *  a hand-back being the agent's answer, over the inputs it ran on), zero while it runs. `cost_usd` the decided record's,
 *  else the runs ended so far, and null while a run's cost is unknown (replayCost). */
type ReplayView = {
  readonly replay: string; readonly workflow: string; readonly digest: string;
  readonly status: "running" | "done" | "failed"; readonly inputs: number;
  readonly outcomes: ReplayOutcomes; readonly score: ReplayScore; readonly cost_usd: number | null;
  readonly decided?: "promote" | "hold"; readonly reason?: string;
};

const NO_SCORE: ReplayScore = { n: 0, agree: 0, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 };

/** A check's replay as its read answers it (replayView): decided, its record's numbers (CheckRecord), else its runs ended
 *  so far. */
async function checkView(ask: ReplayAsk, record: PromotionRecord, id: string, name: string, digest: string): Promise<ReplayView> {
  const inputs = record.runs?.length ?? 0;
  const decided = record.decided === "promote" || record.decided === "hold" ? record.decided : undefined;
  const check = record.check;
  if (decided && check?.outcomes) {
    const n = check.n ?? 0;
    const handedBack = check.outcomes.handed_back;
    const wf = n ? Math.round(((check.agreed ?? 0) + handedBack) / n * 1e4) / 1e4 : 0;
    const neverStarted = inputs > 0 && check.unstarted === inputs;
    return { replay: id, workflow: name, digest, status: neverStarted ? "failed" : "done", inputs, outcomes: check.outcomes, score: { n, agree: check.agreed ?? 0, agent_acc: n ? 1 : 0, wf_acc: wf, delta: n ? Math.round((wf - 1) * 1e4) / 1e4 : 0, handed_back: handedBack }, cost_usd: check.cost_usd ?? null, decided, reason: record.reason };
  }
  const runs = await Promise.all((record.runs ?? []).map((run) => ask.store.runs.get(run)));
  return { replay: id, workflow: name, digest, status: decided ? "done" : "running", inputs, outcomes: outcomesOf(runs, false), score: NO_SCORE, cost_usd: replayCost(runs, false), ...(decided ? { decided, reason: record.reason } : {}) };
}

/** The claim's ports a replay's read settles it through (replayView), with the launch its record chose when it was
 *  reserved (PromotionRecord.launch, the one every replay run of it runs with): its revision, and its learning commit.
 *  Undefined when that launch cannot be read. */
function readPorts(ask: ReplayAsk, launch: ReplayLaunch): PromotionDeps | undefined {
  const body = readLaunchBody(launch.body);
  return body ? claimPromotion({ ...ask, revisionId: launch.revision, launch: body }) : undefined;
}

/** Reads replay `id` of `name` at `digest`, settling it first as a claim of its revision would (settleCheck) once its runs
 *  ended or its deadline passed: it writes only the decision. A read never starts a run: a replay whose launch was
 *  interrupted (reserved runs never created) reads running until its deadline, then is decided held, read as failed, its
 *  reason saying none of its runs started and to start it again with POST. So a replay of a revision no claim lays (an
 *  older, held one) is decided too, and never running forever. Once decided, it reads only its record. Refused
 *  (missing) when the agent has no such replay. */
export async function replayView(ask: ReplayAsk, name: string, digest: string, id: string): Promise<ReplayView> {
  const find = async () => (await promotionsOf(ask.store.settings, ask.agentId)).findLast((one) => one.workflow === name && one.digest === digest && one.replay_id === id);
  let record = await find();
  if (!record) throw new ReplayRefused("missing", `${name} at ${digest} has no replay ${id}.`);
  if (record.decided === "replaying" && record.commit && record.launch) {
    const text = (await workflowsAt(ask, record.commit).catch(() => [])).find((one) => one.name === name && workflowDigest(one) === digest);
    const ports = text ? readPorts(ask, record.launch) : undefined;
    if (ports && text) {
      // Read back by its id: whatever settled it (this read, a claim, another read), never another replay's record.
      await settleCheck(ports, text, digest, record);
      record = (await find()) ?? record;
    }
  }
  return checkView(ask, record, id, name, digest);
}

/** A replay run's recording (launch.replay; learn/replay-calls.ts): the agent run's recorded calls, read from its journal
 *  (a CLI's record shaped as pi's; another run's, which only a runner reads: learned-first.ts). Undefined for any other
 *  run. A recording that cannot be read is an empty one: every write is then skipped, never run. */
export async function replayRecordedFor(store: Store, launch: RunLaunch, context: Context): Promise<Map<string, Recorded> | undefined> {
  if (!launch.replay) return undefined;
  const entries = await runEntries(store, launch.replay.of, context).catch(() => []);
  return recordedCalls(isCliRecord(entries) ? piShaped(entries) : entries);
}

/** The replay's call nodes over `recorded`, each tool classed by run `runId`'s own MCP pin (its servers' annotations as
 *  they listed them) or the built-in list. */
export async function replayCallsOver(store: Pick<Store, "mcp">, runId: string, recorded: ReadonlyMap<string, Recorded>): Promise<ReplayCalls> {
  const pin = (await store.mcp.pin(runId).catch(() => undefined))?.body as McpPin | undefined;
  const annotations = pinAnnotations(pin);
  return replayCalls(recorded, (tool) => toolClassOf(tool, annotations));
}
