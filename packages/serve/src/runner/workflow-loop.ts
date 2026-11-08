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
// (WorkflowRunSpec.endPatch, the pi loop's shape) on the run's row, with the stop row it takes. A lost claim or a
// shutdown writes nothing more and the next claim resumes the workflow from its journal.
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createRegistry, type Extension, Harness, ROOT_CONVERSATION_ID, type StorageWrite } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { Workflow } from "@parcha/agentrun-dsl";
import { createWorkflowExtension, type WorkflowTaskHost } from "@parcha/agentrun-pi/durable";
import { startWorkflowRevision, workflowCarry } from "@parcha/pi-durable-agent/workflow";
import { type EndData, KINDS } from "./journal-kinds.js";
import type { Claim, Command, CommandOutcome, Journal, Loop, LoopDeps, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";
import type { RunOutcome, RunPatch } from "../store/store.js";

/** The most the end's patch (cost and metrics) may take before the end is written without it (the pi loop's CUT_STEP_MS). */
const CUT_STEP_MS = 2_000;

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
   *  for a raise: a step the cap holds calls it and then lets its node's signal (which the loop aborts) end its wait, and
   *  the loop parks the run for a later claim. Called once per start, so a resume builds a fresh host over the resumed
   *  journal. */
  readonly build: (hooks: WorkflowHostHooks) => { readonly extensions: readonly Extension[]; readonly host: WorkflowTaskHost };
  /** The end's cost and metrics beside its state, read when the end is written (the pi loop's endPatch, bounded the same).
   *  The outcome (completed or escalated) is the workflow's own, read from the journal, not this. */
  readonly endPatch?: (end: EndData) => Promise<Pick<EndData, "costUsd" | "metrics">>;
  /** pi-durable's restart limit for the run's Harness. Absent: pi's own default. */
  readonly restartLimit?: number;
}

/** What the interpreter's host may ask of the loop while it runs. */
export interface WorkflowHostHooks {
  /** A step the cap holds for a raise lets go here: the run parks and a later claim resumes the workflow from its journal
   *  (the held step was never admitted, so nothing is half done). `wakeAt` (epoch ms) makes it claimable again with no
   *  command; a raise command wakes it sooner. `detail` is the refusal a reader shows as the run's pending (its words and
   *  figures). The caller must let the node's signal, which the loop aborts, end the step's wait. */
  park(info: { readonly wakeAt?: number; readonly detail?: unknown }): void;
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
  /** The claimed run's spec, once read: writeEnd reads the end's patch from it. */
  let spec: WorkflowRunSpec | undefined;
  let harnessClosed = false;
  let finished: Promise<LoopEnd> | undefined;

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

  /** One entry on the run's root, committed; `run` stages the run row's patch with it (keyed to this entry, its effect),
   *  and `take` the stop row it applies. The workflow task made the root; a resume finds it. */
  const append = async (journal: Journal, context: Context, kind: string, data: unknown, run?: RunPatch, take?: number): Promise<void> => {
    const writes: StorageWrite[] = [];
    if (!(await journal.conversation(ROOT_CONVERSATION_ID, context))) writes.push({ type: "conversation", value: { id: ROOT_CONVERSATION_ID } } as StorageWrite);
    const id = await journal.mintId();
    writes.push({ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind, data } } as StorageWrite);
    if (run) journal.stage({ run, effect: id, ...(take !== undefined ? { take: [{ command: take, effect: id }] } : {}) });
    const result = await journal.commit([writes], () => {}, context);
    if (result.stored === 0) throw result.refused;
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
    // A step the cap holds parks the run: `park` aborts this controller, which ends the held step's wait (its node's
    // signal) and the workflow's invocation, leaving the task pending for a later claim; the loop then writes the run
    // parked instead of interrupted. The claim's own signal (a lost claim, a shutdown) aborts it too.
    const parkController = new AbortController();
    let parkRequested: { readonly wakeAt?: number; readonly detail?: unknown } | undefined;
    const context = withAbortSignal(AbortSignal.any([deps.signal, parkController.signal]), BACKGROUND_CONTEXT);
    spec = await specOf(claim);
    const revision = { id: spec.revisionId, kind: "workflow" as const, body: { workflow: spec.workflow, tools: [...spec.tools] } };

    const hooks: WorkflowHostHooks = { park: (info) => { parkRequested ??= info; parkController.abort(); } };
    const { extensions, host } = spec.build(hooks);
    workflows = createWorkflowExtension(host);
    const registry = createRegistry();
    for (const extension of extensions) registry.install(extension);
    registry.install(workflows.extension);
    harness = await Harness.open(deps.journal(claim), { models: spec.models, registry, onReport: () => {}, ...(spec.restartLimit !== undefined ? { settings: { restartLimit: spec.restartLimit } } : {}) }, context);
    harnessClosed = false;

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
      if (parkRequested) {
        // A step's spend cap held it and let go: the run parks, and a later claim resumes the workflow from its journal
        // (the held step was never admitted, so nothing is half done), reading the raised cap.
        const parkJournal = deps.journal(claim);
        await append(parkJournal, BACKGROUND_CONTEXT, KINDS.workflowParked, { detail: parkRequested.detail ?? null }, { state: "parked" });
        return { state: "parked", ...(parkRequested.wakeAt !== undefined ? { wakeAt: parkRequested.wakeAt } : {}) };
      }
      // The Session failed at a storage error, or the claim's context aborted (a lost claim, a shutdown): nothing more is
      // written, and the next claim resumes the workflow from its journal.
      void error;
      return { state: "interrupted" };
    }

    // The task is terminal. Close the Harness, then read the run's view from its journal and write the end, both on a
    // fresh journal of the same claim (the Harness closed its own).
    await closeHarness();
    const endJournal = deps.journal(claim);
    const carry = await workflowCarry({ runId: claim.runId, storage: endJournal, revision }, outcome, { context });
    return await writeEnd(endJournal, context, carry);
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
    const take = stopReason?.kind === "command" ? stopReason.commandId : undefined;
    await append(journal, context, KINDS.end, data, runPatch, take);
    return state === "failed" ? { state: "failed", error: { code: "workflow-failed", message: carry.summary } } : { state };
  }

  return {
    start(claim) {
      finished = run(claim);
      return finished;
    },
    async command(command: Command): Promise<CommandOutcome> {
      void command;
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
