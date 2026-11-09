// The workflow loop on the runner (design: "Runners carry many loops"; the lead's ruling, workflow agents keep running
// after the cutover). A run of a workflow revision, which the runner claims like any run: this loop is its driver, so the
// claim, the fence, a cancel and the end commit are its. The DSL's durable runner (pi-durable-agent/workflow
// startWorkflowRevision over agentrun-pi's workflow task) runs the revision's workflow UNCHANGED — the same nodes,
// decisions, call tools and cap it ran with in the per-run process — on the run's journal in the one store (A,
// deps.journal(claim)) in place of a per-run store file. The interpreter's host (model nodes on the run's models, call
// nodes on the tool table, decisions, the cap) is built by the caller (WorkflowRunSpec.build), exactly as the per-run
// process built it; this loop knows only the engine and the journal.
//
// How a run ends is the workflow's outcome, read back from the journal by workflowCarry (the engine's own, over a pi
// Storage): a complete run ends `ended`, an escalated one `ended` with outcome `escalated`, a refused or failed one
// `failed`, a cancelled one `stopped`. The end commit writes that state, its summary, and the end's cost and metrics
// (WorkflowRunSpec.endPatch, the pi loop's shape) on the run's row, with the stop row it takes.
//
// A step the spend cap holds for a raise parks the run the same way the pi adapter does (the kernel cap's parkOf, handed
// in via the spec — the loop never imports the cap): the run's row goes parked in the cap's words with an `agentrun.budget`
// entry, which the existing readers show as the run's pending; a raise command, checked by the cap's rule, takes with an
// `agentrun.raise` entry and the next claim resumes the workflow from its journal with the raised cap. A lost claim or a
// shutdown writes nothing more and the next claim resumes.
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createRegistry, type EntryRecord, type Extension, Harness, ROOT_CONVERSATION_ID, type StorageWrite } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { Workflow } from "@parcha/agentrun-dsl";
import { createWorkflowExtension, type WorkflowTaskHost } from "@parcha/agentrun-pi/durable";
import { startWorkflowRevision, workflowCarry } from "@parcha/pi-durable-agent/workflow";
import { type BudgetData, type EndData, KINDS, type RaiseData } from "./journal-kinds.js";
import { type Claim, type Command, type CommandOutcome, endedBy, type Journal, type Loop, type LoopDeps, type LoopEnd, type LoopFactory, type StopReason } from "./loop-contract.js";
import type { RunOutcome, RunPatch } from "../store/store.js";

/** The most the end's patch (cost and metrics) may take before the end is written without it (the pi loop's CUT_STEP_MS). */
const CUT_STEP_MS = 2_000;

/** A cap refusal, as the kernel cap hands one to parkOf/checkRaise (the loop never imports the cap; its rule is handed in
 *  via the spec, so flat or tiered pricing is the cap's, not this loop's). */
export type CapRefusal = { readonly message: string; readonly forGood: boolean; readonly figures?: unknown };
/** A raise's state as the cap's checkRaise reads it (the kernel cap's RaiseState). */
export type RaiseState = { capUsd?: number; final?: boolean; pause?: string; lastRaise?: { to: number; pause?: string } };
/** What the cap's checkRaise says (the kernel cap's RaiseCheck). */
export type RaiseCheck = { raised: true; resumes: boolean; pause?: string; refused?: undefined } | { retry: true; resumed: boolean; refused?: undefined } | { refused: string };
/** The cap's rule for a run, handed in via the spec (the kernel cap's parkOf/checkRaise/followUpOf): the loop uses it to
 *  park the run and take raises, never importing the cap itself. */
export interface WorkflowCapRule {
  /** The kernel cap's parkOf: a refusal a raise can fix parks the run with a pending budget; else it fails in its words. */
  park(refusal: CapRefusal): { outcome: "parked"; pending: BudgetData["pending"]; words: string } | { outcome: "failed"; error: string };
  /** The kernel cap's checkRaise. Absent: a raise is refused (the run has no cap). */
  checkRaise?(state: RaiseState, raiseUsd: number): RaiseCheck;
  /** The kernel cap's followUpOf (parity with the pi adapter; a workflow needs no follow-up message). */
  followUpOf?(capUsd: number): { readonly text: string };
}

/** What one run's workflow loop runs: the revision's workflow and its input, the run's models, and the interpreter's host.
 *  The caller (the runner's dispatch) reads the launch and the revision and builds this at the claim, as it builds a pi
 *  run's spec — the model proxy, the tool table, the cap and the decision providers live there, not here. */
export interface WorkflowRunSpec {
  /** The run's models (the model proxy under the run's cap), as the per-run process chose them for the workflow's tiers. */
  readonly models: Models;
  /** The revision's workflow, as authored. */
  readonly workflow: Workflow;
  /** The run's input: the start request's body, checked against the workflow's input schema by the engine. */
  readonly input: Record<string, unknown>;
  /** The tools the workflow may call, which the host registers (inspectWorkflow(workflow).requires.tools). */
  readonly tools: readonly string[];
  readonly agentId: string;
  readonly revisionId: string;
  /** Builds the interpreter's host and the extensions to install before the Harness opens, exactly as the per-run process
   *  did: model nodes on the run's models, call nodes on the tool table, decisions, the cap. `hooks.park` parks the run
   *  for a raise: a step the cap holds calls it with the refusal and then lets its node's signal (which the loop aborts)
   *  end its wait, and the loop parks the run for a later claim. Called once per start, so a resume builds a fresh host
   *  over the resumed journal with the raised cap. */
  readonly build: (hooks: WorkflowHostHooks) => { readonly extensions: readonly Extension[]; readonly host: WorkflowTaskHost };
  /** The cap's rule (the kernel cap's parkOf/checkRaise/followUpOf), handed in: the loop parks and takes raises with it,
   *  never importing the cap. Absent: the run has no cap, so nothing parks and a raise is refused. */
  readonly cap?: WorkflowCapRule;
  /** The end's cost and metrics beside its state, read when the end is written (the pi loop's endPatch, bounded the same).
   *  The outcome (completed or escalated) is the workflow's own, read from the journal, not this. */
  readonly endPatch?: (end: EndData) => Promise<Pick<EndData, "costUsd" | "metrics">>;
  /** pi-durable's restart limit for the run's Harness. Absent: pi's own default. */
  readonly restartLimit?: number;
  /** Called once the run's Harness is open, before the workflow runs: the spec wires anything that needs the Harness here
   *  (the run's model booking over the journal's sessions, which the model proxy's requests go through — the booking's
   *  writer is the Harness's, not available at build()). Absent: nothing to wire. A resume calls it afresh on the reopened
   *  Harness. */
  readonly harnessReady?: (harness: Harness, context: Context) => void | Promise<void>;
  /** Lets the spec's per-claim resources go once the loop is done with the claim (the model proxies it started): called
   *  once, however the run ended (ended, stopped, failed, parked or interrupted), so a parked or resumed run starts fresh
   *  proxies on its next claim. Never throws out. Absent: nothing to let go. */
  readonly release?: () => Promise<void>;
}

/** What the interpreter's host may ask of the loop while it runs. */
export interface WorkflowHostHooks {
  /** A step the cap holds for a raise lets go here, with the cap's refusal: the loop parks the run (parkOf's pending
   *  budget, in the cap's words) and a later claim resumes the workflow from its journal (the held step was never admitted,
   *  so nothing is half done), with the raised cap. The caller must let the node's signal, which the loop aborts, end the
   *  step's wait. */
  park(refusal: CapRefusal): void;
}

/** Whether a revision runs on the workflow loop (the runner's dispatch picks it by the revision's kind): a workflow
 *  revision does, an agentic one does not. */
export const isWorkflowRevision = (revision: { readonly kind: string }): boolean => revision.kind === "workflow";

/** Loops for workflow runs: `spec(claim)` gives each claim's run what it runs (its workflow, input, models and host). */
export function createWorkflowLoop(specOf: (claim: Claim) => WorkflowRunSpec | Promise<WorkflowRunSpec>): LoopFactory {
  return (deps) => workflowLoop(specOf, deps);
}

function workflowLoop(specOf: (claim: Claim) => WorkflowRunSpec | Promise<WorkflowRunSpec>, deps: LoopDeps): Loop {
  let harness: Harness | undefined;
  let workflows: ReturnType<typeof createWorkflowExtension> | undefined;
  let runId: string | undefined;
  let stopReason: StopReason | undefined;
  /** The claimed run's spec, once read: writeEnd reads the end's patch and the cap's rule from it. */
  let spec: WorkflowRunSpec | undefined;
  let harnessClosed = false;
  let finished: Promise<LoopEnd> | undefined;
  /** Raise commands this claim was handed, buffered until the run's raises are taken (before the workflow runs); after
   *  that a raise waits for the next claim. */
  const raises: { readonly command: Command; readonly settle: (outcome: CommandOutcome) => void }[] = [];
  let takingDone = false;

  const closeHarness = async (): Promise<void> => {
    if (!harness || harnessClosed) return;
    harnessClosed = true;
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  };

  /** A person's cancel: the workflow's task is aborted, and the run ends stopped with the stop row taken in its end
   *  commit (startWorkflowRevision's wait resolves with the cancelled outcome). A stop may arrive before the task is
   *  created, so this retries briefly until it is live. */
  const requestCancel = async (): Promise<void> => {
    for (let tries = 0; tries < 200 && !harnessClosed; tries += 1) {
      if (workflows && harness && runId) {
        const stopped = await workflows.stop(harness, runId, "cancel", BACKGROUND_CONTEXT, "a person").catch(() => "not-live" as const);
        if (stopped !== "not-live") return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** The run's root conversation entries, oldest first (the budget and raise entries this reads). */
  const rootEntries = async (journal: Journal, context: Context): Promise<EntryRecord[]> => {
    const out: EntryRecord[] = [];
    for (let cursor: unknown = undefined; ; ) {
      const page = await journal.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" } as never, 500, cursor as never, context);
      out.push(...page.items);
      if (page.next === undefined) return out;
      cursor = page.next;
    }
  };

  /** One entry on the run's root, committed; `staged.run` stages the run row's patch with it (keyed to this entry, its
   *  effect), and `staged.take` the command rows it applies. The workflow task made the root; a resume finds it. */
  const append = async (journal: Journal, context: Context, kind: string, data: unknown, staged?: { run?: RunPatch; take?: readonly number[] }): Promise<void> => {
    const writes: StorageWrite[] = [];
    if (!(await journal.conversation(ROOT_CONVERSATION_ID, context))) writes.push({ type: "conversation", value: { id: ROOT_CONVERSATION_ID } } as StorageWrite);
    const id = await journal.mintId();
    writes.push({ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind, data } } as StorageWrite);
    if (staged?.run || staged?.take?.length) {
      journal.stage({ ...(staged.run ? { run: staged.run, effect: id } : {}), ...(staged.take?.length ? { take: staged.take.map((command) => ({ command, effect: id })) } : {}) });
    }
    const result = await journal.commit([writes], () => {}, context);
    if (result.stored === 0) throw result.refused;
  };

  /** The run's raise state, read from its root (the kernel cap's reading): the newest budget entry with no raise after it
   *  is the pause a raise is checked against; the newest raise entry is its last raise. */
  const raiseStateOf = async (journal: Journal, context: Context): Promise<RaiseState> => {
    let budget: { id: string; data: BudgetData } | undefined;
    let last: { data: RaiseData; pause?: string } | undefined;
    for (const entry of await rootEntries(journal, context)) {
      if (entry.kind === KINDS.budget) budget = { id: String(entry.id), data: entry.data as unknown as BudgetData };
      if (entry.kind === KINDS.raise) {
        const data = entry.data as unknown as RaiseData & { pause?: string };
        last = { data, ...(data.pause ? { pause: data.pause } : {}) };
        if (budget && data.pause === budget.id) budget = undefined;
      }
    }
    const capUsd = budget ? budget.data.pending.cap_usd : last?.data.capUsd;
    return { ...(capUsd !== undefined ? { capUsd } : {}), ...(budget ? { pause: budget.id } : {}), ...(last ? { lastRaise: { to: last.data.capUsd, ...(last.pause ? { pause: last.pause } : {}) } } : {}) };
  };

  /** Takes the raise commands this claim was handed, in arrival order, each checked by the cap's rule against the state the
   *  ones before it left: refused ones say why; the rest are taken in one `agentrun.raise` entry, which clears the run's
   *  paused words when a raise resumes the pause. Run before the workflow does, so the resumed run reads the raised cap. */
  const takeRaises = async (journal: Journal, context: Context): Promise<void> => {
    const pending = raises.splice(0);
    takingDone = true;
    if (pending.length === 0) return;
    const check = spec?.cap?.checkRaise;
    if (!check) {
      for (const { settle } of pending) settle({ refused: "This run has no cap to raise: a cap is named when a run starts." });
      return;
    }
    let state = await raiseStateOf(journal, context);
    const takes: number[] = [];
    const settles: Array<() => void> = [];
    let capUsd = state.capUsd;
    let resumes = false;
    for (const { command, settle } of pending) {
      const usd = (command.body as { capUsd?: unknown } | null)?.capUsd;
      const answer = check(state, typeof usd === "number" ? usd : Number.NaN);
      if (answer.refused !== undefined) {
        settle({ refused: answer.refused });
        continue;
      }
      takes.push(command.id);
      if ("raised" in answer && answer.raised) {
        resumes ||= answer.resumes;
        capUsd = usd as number;
        state = { ...state, capUsd: usd as number, lastRaise: { to: usd as number, ...(state.pause ? { pause: state.pause } : {}) } };
      }
      settles.push(() => settle({ taken: true }));
    }
    if (takes.length) {
      const data: RaiseData & { pause?: string } = { capUsd: capUsd ?? 0, takes, ...(state.pause ? { pause: state.pause } : {}) };
      await append(journal, context, KINDS.raise, data, { ...(resumes ? { run: { summary: null } } : {}), take: takes });
    }
    for (const settle of settles) settle();
  };

  /** The end's cost and metrics from the spec, bounded like the pi loop: late or failing, none. */
  const endPatchOf = async (spec: WorkflowRunSpec, data: EndData): Promise<Pick<EndData, "costUsd" | "metrics">> => {
    if (!spec.endPatch) return {};
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CUT_STEP_MS)));
    try {
      const patch = await Promise.race([spec.endPatch(data), late]);
      if (patch === "late") {
        console.warn(`[runner] ${runId}: its end's patch gave no answer within ${CUT_STEP_MS / 1000} s; the end is written without it`);
        return {};
      }
      return patch ?? {};
    } catch (error) {
      console.warn(`[runner] ${runId}: its end's patch failed: ${(error as Error).message}`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  };

  async function run(claim: Claim): Promise<LoopEnd> {
    runId = claim.runId;
    try {
    // A step the cap holds parks the run: `park` keeps the refusal and aborts this controller, which ends the held step's
    // wait (its node's signal) and the workflow's invocation, leaving the task pending for a later claim; the loop then
    // writes the run parked instead of interrupted. The claim's own signal (a lost claim, a shutdown) aborts it too.
    const parkController = new AbortController();
    let heldRefusal: CapRefusal | undefined;
    const context = withAbortSignal(AbortSignal.any([deps.signal, parkController.signal]), BACKGROUND_CONTEXT);
    spec = await specOf(claim);
    const revision = { id: spec.revisionId, kind: "workflow" as const, body: { workflow: spec.workflow, tools: [...spec.tools] } };

    // The claim's first delivery hands over any raises that woke a parked run: take them before the workflow runs, so the
    // resumed run reads the raised cap and the run's row no longer shows the budget pause.
    await (deps.delivered ?? Promise.resolve());
    await takeRaises(deps.journal(claim), BACKGROUND_CONTEXT);

    const hooks: WorkflowHostHooks = { park: (refusal) => { heldRefusal ??= refusal; parkController.abort(); } };
    const { extensions, host } = spec.build(hooks);
    workflows = createWorkflowExtension(host);
    const registry = createRegistry();
    for (const extension of extensions) registry.install(extension);
    registry.install(workflows.extension);
    harness = await Harness.open(deps.journal(claim), { models: spec.models, registry, onReport: () => {}, ...(spec.restartLimit !== undefined ? { settings: { restartLimit: spec.restartLimit } } : {}) }, context);
    harnessClosed = false;
    // The run's model booking lives on the Harness (the journal's sessions), so it is wired now, before the workflow's
    // first model request goes through the proxy. A resume rebuilds it on the reopened Harness.
    await spec.harnessReady?.(harness, context);

    // A cancel the runner handed over before the Harness opened: take it now the workflow is about to run.
    if (stopReason?.kind === "command") void requestCancel();

    let outcome;
    try {
      outcome = await startWorkflowRevision({
        harness, workflows, context,
        run: { runId: claim.runId, agentId: spec.agentId, revision },
        input: spec.input, tools: spec.tools,
      });
    } catch (error) {
      await closeHarness();
      if (heldRefusal) return await parkAtCap(claim, heldRefusal);
      // The Session failed at a storage error, or the claim's context aborted (a lost claim, a shutdown): nothing more is
      // written, and the next claim resumes the workflow from its journal.
      void error;
      return { state: "interrupted" };
    }

    // The task is terminal. Close the Harness, then read the run's view from its journal and write the end, both on a
    // fresh journal of the same claim (the Harness closed its own).
    await closeHarness();
    const endJournal = deps.journal(claim);
    // A person stopped or cancelled: the run ends stopped whatever the workflow's own outcome (its last node may have
    // completed as the stop landed, since the engine cancels by aborting the task), in the words that say which (endedBy),
    // with the stop row taken in the end commit.
    if (stopReason?.kind === "command") return await writeEnd(endJournal, context, { state: "stopped", summary: endedBy(stopReason.cancel) });
    const carry = await workflowCarry({ runId: claim.runId, storage: endJournal, revision }, outcome, { context });
    return await writeEnd(endJournal, context, carry);
    } finally {
      // The claim is done however it ended (ended, stopped, failed, parked, interrupted): let the spec's per-claim
      // resources go, the model proxies it started. A parked or resumed run starts fresh ones on its next claim.
      await spec?.release?.().catch(() => undefined);
    }
  }

  /** A step's spend cap held it: the run parks with the cap's pending budget (an `agentrun.budget` entry, the run's row in
   *  the cap's words), or fails when no raise could fix it (parkOf). A later claim's raise resumes the workflow. */
  async function parkAtCap(claim: Claim, refusal: CapRefusal): Promise<LoopEnd> {
    const journal = deps.journal(claim);
    const parked = spec?.cap?.park(refusal);
    if (!parked) return { state: "interrupted" };
    if (parked.outcome === "failed") return await writeEnd(journal, BACKGROUND_CONTEXT, { state: "failed", summary: parked.error });
    const budget: BudgetData = { pending: parked.pending, words: parked.words };
    await append(journal, BACKGROUND_CONTEXT, KINDS.budget, budget, { run: { state: "parked", summary: parked.words } });
    return { state: "parked" };
  }

  async function writeEnd(journal: Journal, context: Context, carry: { state: "completed" | "failed" | "stopped" | "escalated"; summary: string }): Promise<LoopEnd> {
    const state: EndData["state"] = carry.state === "failed" ? "failed" : carry.state === "stopped" ? "stopped" : "ended";
    const outcome: RunOutcome | undefined = carry.state === "escalated" ? "escalated" : undefined;
    const base: EndData = { state, summary: carry.summary, ...(outcome ? { outcome } : {}) };
    const patch = await endPatchOf(spec!, base);
    const data: EndData = { ...base, ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}), ...(patch.metrics !== undefined ? { metrics: patch.metrics } : {}) };
    const runPatch: RunPatch = {
      state, summary: carry.summary,
      ...(outcome !== undefined ? { outcome } : {}),
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
      ...(data.metrics !== undefined ? { metrics: data.metrics } : {}),
    };
    const take = stopReason?.kind === "command" ? [stopReason.commandId] : undefined;
    await append(journal, context, KINDS.end, data, { run: runPatch, ...(take ? { take } : {}) });
    return state === "failed" ? { state: "failed", error: { code: "workflow-failed", message: carry.summary } } : { state };
  }

  return {
    start(claim) {
      finished = run(claim);
      return finished;
    },
    async command(command: Command): Promise<CommandOutcome> {
      // A raise is taken before the workflow runs (takeRaises); one that comes after waits for the run's next claim.
      if (command.kind === "raise") {
        if (takingDone) return { later: "the raise waits for the run's next claim" };
        return new Promise<CommandOutcome>((settle) => raises.push({ command, settle }));
      }
      return { refused: "a workflow run takes no messages or answers" };
    },
    async stop(reason: StopReason): Promise<void> {
      stopReason ??= reason;
      if (reason.kind === "command") {
        // The run ends stopped when the cancel lands; requestCancel retries until the task is live, so a stop that beat
        // the task's creation still takes.
        void requestCancel();
      } else {
        // A lost claim or a shutdown: wind the run down where it can resume. The claim's signal aborts the in-flight work;
        // closing the Harness ends the task invocation, which stays pending for the next claim.
        await closeHarness();
      }
      await finished?.catch(() => undefined);
    },
  };
}
