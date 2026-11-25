// The learned workflow a claim starts on and the ones its learned_workflow tool runs, decided at the claim: the audits that
// finished since written (audit.ts settleAudits), the laid revision's promotion moved on (promotion.ts promotionGate: a
// check reserved, its replay runs created, a verdict written), a replay run's claim checked (replayClaimed), and a replay
// run's recorded calls read from the run it replays (replayRecordedFor). Every step writes the store or reads another
// run, so it runs where the seal key and the store are: the runner, for the claim it holds. A run's own process asks it
// (held.ts learnedFirst) with whether its seed lay laid any workflow, and never names the workflows: the runner reads
// them from the agent's learning folder at the claim's seed itself (learning-seed.ts workflowsAt).
import type { Context } from "@earendil-works/chord/context";
import type { LearnedWorkflow, Shown } from "../learning.js";
import type { LearningFolder } from "../learn/folder.js";
import type { Recorded } from "../learn/replay-calls.js";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { pastRunsOverStore } from "../store-reads/learning.js";
import { learnsWorkflows } from "./adapter-run-spec.js";
import { settleAudits } from "./audit.js";
import { held } from "./held.js";
import type { AuxiliaryAdmitter } from "../source-sync/auxiliary.js";
import { claimPromotion, promotionGate, replayClaimed, replayLaid, replayRecordedFor, toolFlowsFor } from "./promotion.js";
import { type FirstChoice, type PastRuns, toolStopsOf, workflowFirstOf } from "./workflow-first.js";

/** The claim, as the runner read it, for learnedFirst. */
export interface LearnedFirstDeps {
  readonly store: Store;
  readonly admitAuxiliary?: AuxiliaryAdmitter;
  readonly sealKey?: Buffer;
  readonly agentId: string;
  readonly runId: string;
  readonly revisionId: string;
  /** The revision's kind and its output schema (workflowFirstOf). */
  readonly kind: string;
  readonly outputSchema?: unknown;
  readonly launch: RunLaunch;
  readonly context: Context;
  readonly log: (line: string) => void;
  readonly folder: () => LearningFolder;
  readonly shown: () => Promise<Shown>;
  readonly spendOff?: (what: string) => string | undefined;
}

/** What the claim starts with: its first choice, the workflows its learned_workflow tool runs, and a replay run's
 *  recorded calls (by learn/replay-calls.ts callKey; none for any other run). Data alone. */
export interface LearnedFirst {
  readonly choice: FirstChoice;
  readonly workflows: LearnedWorkflow[];
  readonly recorded?: [string, Recorded][];
}

/** The claim's learned first choice over `laid`, the workflows its seed lay laid (see the file's head). A replay run's
 *  claim that is refused throws ClaimRefused, as replayClaimed does. */
export async function learnedFirst(deps: LearnedFirstDeps, laid: readonly LearnedWorkflow[]): Promise<LearnedFirst> {
  const { store, agentId, runId, revisionId, launch, context, log, folder, shown } = deps;
  const own = { ...(deps.sealKey ? { sealKey: deps.sealKey } : {}), ...(deps.spendOff ? { spendOff: deps.spendOff } : {}), ...(deps.admitAuxiliary ? { admitAuxiliary: deps.admitAuxiliary } : {}) };
  // A replay run lays only the workflow it replays (promotion.ts replayLaid).
  const laidFlows = replayLaid(launch, laid);
  if (launch.learning && !launch.replay && !launch.audit) await settleAudits({ store, agentId, revisionId, context, log, folder, shown, ...own });
  const promotion = claimPromotion({ store, agentId, runId, revisionId, launch, context, log, folder, shown, ...own });
  const learns = learnsWorkflows(deps.kind, laidFlows);
  // The agent's past runs, read once for both sides of the money rule: the platform's first choice and the agent's tool.
  let read: Promise<PastRuns> | undefined;
  const past = () => (read ??= pastRunsOverStore(store, agentId));
  let choice: FirstChoice = learns ? await workflowFirstOf(deps.kind, laidFlows, launch, log, past, promotionGate(promotion), deps.outputSchema) : { reason: "none_laid" };
  // A replay run runs only its revision, while it still replays: else its claim is refused (the run ends failed, no agent).
  await replayClaimed(store, agentId, runId, launch, choice);
  const recorded = await replayRecordedFor(store, launch, context);
  // The tool runs what serves, never a revision not promoted (promotion.ts toolFlowsFor), nor one the money rule stops,
  // whoever made its calls (workflow-first.ts toolStopsOf): a learning run's, not a replay's (it runs its revision, read
  // past or not). A shadow has no learning start (runner/audit.ts): it lays no workflow and reads no past.
  let workflows = await toolFlowsFor(promotion, launch, laidFlows, choice);
  if (learns && launch.learning && !launch.replay && workflows.length) {
    const money = toolStopsOf(await past().catch((error: unknown) => ({ unread: error instanceof Error ? error.message : String(error) })), workflows);
    for (const line of money.said) log(line);
    workflows = money.flows;
    // A stop asks for its revision on a run nothing else serves or stops first (the run's one WORKFLOW_FIRST entry).
    const stop = money.stops[0];
    if (stop && !choice.serve && !choice.revise) choice = { ...choice, reason: "cost_stop", revise: { ...stop, revision: launch.learning.seed, ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}) } };
  }
  return { choice, workflows, ...(recorded ? { recorded: [...recorded] } : {}) };
}

/** learnedFirst where the claim is held: a runner's own (its seal key), else, in a run's own process, its runner's
 *  (held.ts learnedFirst), told only whether `laid` holds any workflow. */
export async function learnedFirstWhereHeld(deps: { readonly store: Store; readonly sealKey?: Buffer | undefined }, claim: Omit<LearnedFirstDeps, "store" | "sealKey">, laid: readonly LearnedWorkflow[]): Promise<LearnedFirst> {
  const at = deps.sealKey ? undefined : held();
  if (at) return at.learnedFirst({ laid: laid.length > 0 });
  return learnedFirst({ ...claim, store: deps.store, ...(deps.sealKey ? { sealKey: deps.sealKey } : {}) }, laid);
}
