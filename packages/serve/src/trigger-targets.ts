// The trigger target policy (what a trigger may start or message, and in what words it is refused), over the one store. It
// was inline in the server's trigger wiring (the Triggers deps: targetIssues, start, message, statusOf, runOf); here it is
// rewritten against the run write half (runs-over-store: startRun, message) and the run readers (store-reads: runOfOrigin,
// and the run view the switch wires in). The queue a firing takes — how many of a trigger's messages wait for a busy run,
// which are skipped — is the store's trigger side (store.triggers), not this policy; this says only which runs a
// trigger may touch and what each refusal answers with.
import { ApiError, type InputIssue, unsupported } from "./errors.js";
import { message, type RunMoment, type RunsStore, startRun, type StartDeps, WAITS_ON_A_PERSON } from "./runs-over-store.js";
import { runOfOrigin } from "./store-reads/runs.js";
import type { Store } from "./store/index.js";
import type { AgentEntry } from "./agents-store.js";
import type { MessageOrigin } from "@parcha/pi-durable-agent/timeline";
import type { Json } from "./validate.js";
import type { LastRun, RunTrigger, Target } from "./triggers.js";

/** Why a trigger may not message a run with no cap (server.ts NO_CAP). */
const NO_CAP = "The run has no spend cap: a trigger only messages a run with one, as every turn it drives is capped.";

/** What the trigger target policy needs that lives elsewhere: the run-start leaves (StartDeps, shared with the create
 *  route), the agent reads, and the run view that gives a run's live moment and its v2 status. */
export interface TriggerTargetDeps {
  /** The run-start leaves, shared with the create route (runs-over-store.StartDeps). */
  readonly start: StartDeps;
  /** The agent an id names, with its current revision; undefined when unknown (the agent store's getAgent). */
  getAgent(agentId: string): Promise<AgentEntry | undefined>;
  /** The agent an id names, or an ApiError not_found (server.ts needAgent). */
  needAgent(agentId: string): Promise<AgentEntry>;
  /** A run's live moment, for a message's acceptance and a target's cap/kind check (the run view → RunMoment); undefined
   *  for an unknown run. */
  momentOf(runId: string): Promise<RunMoment | undefined>;
  /** A run's v2 status, or null for an unknown run (the run view): the trigger engine's overlap and active-run checks. */
  runStatus(runId: string): Promise<string | null>;
  /** A run's status, end and final answer as GET /v2/runs/{id} serves them (the run view), or null for an unknown run. */
  runEnd(runId: string): Promise<LastRun | null>;
}

/** The trigger-facing run policy: the subset of the trigger engine's deps this module owns. The engine's other deps (an
 *  adapter's sealed settings, the failed-firing webhook) stay server-wired. */
export type TriggerTargets = {
  targetIssues(target: Target): Promise<InputIssue[]>;
  start(target: Extract<Target, { kind: "start_run" }>, input: Json, origin: RunTrigger, from: MessageOrigin): Promise<{ run_id: string }>;
  message(target: Extract<Target, { kind: "message_run" }>, input: Json, key: string, from: MessageOrigin): Promise<void | { skipped: string }>;
  statusOf(runId: string): Promise<string | null>;
  lastRun(runId: string): Promise<LastRun | null>;
  runOf(key: string): Promise<{ run_id: string; setup_lost: boolean } | null>;
};

/** The trigger target policy over `store`, with its reads and the run-start leaves injected. */
export function triggerTargets(store: Store & RunsStore, deps: TriggerTargetDeps): TriggerTargets {
  return {
    async targetIssues(target) {
      if (target.kind === "message_run") {
        const run = await deps.momentOf(target.run_id);
        if (!run) return [{ field: "target.run_id", reason: "not_found", message: `no run ${target.run_id}` }];
        if (run.kind === "workflow") return [{ field: "target.run_id", reason: "not_allowed", message: "A workflow run takes no messages here." }];
        return run.maxCostUsd === undefined ? [{ field: "target.run_id", reason: "not_allowed", message: NO_CAP }] : [];
      }
      const entry = await deps.getAgent(target.agent_id);
      if (!entry) return [{ field: "target.agent_id", reason: "not_found", message: `no agent ${target.agent_id}` }];
      if (!entry.revision) return [{ field: "target.agent_id", reason: "invalid", message: `the agent ${target.agent_id} has no current revision` }];
      // The revision the run would start on (its current), in the shape the input and cap checks read.
      const pinned = await deps.start.pinnedOf(entry, { input: target.input });
      const revision = pinned?.revision;
      const defaultCap = (revision?.body as { maxCostUsd?: number } | undefined)?.maxCostUsd;
      const uncapped = target.max_cost_usd === undefined && defaultCap === undefined
        ? [{ field: "target.max_cost_usd", reason: "missing", message: `Every run a trigger starts is capped: give the target a max_cost_usd or set the agent's (the agent ${target.agent_id} has none).` }]
        : [];
      const wrong = revision ? await deps.start.explainRun(await deps.start.inputIssuesOf(revision, target.input), { input: target.input }, revision) : [];
      return [...uncapped, ...wrong.map((issue) => ({ ...issue, field: `target.${issue.field}` }))];
    },
    async start(target, input, trigger, from) {
      const entry = await deps.needAgent(target.agent_id);
      // The target's cap, else the agent's default as it stands now: a run a trigger starts is never uncapped (capped).
      const run = await startRun(
        store,
        deps.start,
        entry,
        { input, ...(target.max_cost_usd !== undefined ? { max_cost_usd: target.max_cost_usd } : {}), ...(target.effort ? { effort: target.effort } : {}) },
        { trigger, origin: { key: trigger.firing_key }, capped: true, from },
      );
      return { run_id: run.id };
    },
    async message(target, input, key, from) {
      const run = await deps.momentOf(target.run_id);
      if (!run) throw new ApiError("not_found", `There is no run ${target.run_id}.`);
      if (run.kind === "workflow") throw unsupported("messages.steer_workflow_runs", "A workflow run takes no messages here.");
      // Never an uncapped turn, nor an answer to a person's question, an approval or a budget pause: a run that waits on its
      // person is told nothing by a trigger (skipped, never queued behind the person).
      if (run.maxCostUsd === undefined) throw new ApiError("not_continuable", NO_CAP);
      if (run.waitsOnPerson) return { skipped: WAITS_ON_A_PERSON };
      try {
        // The firing's key is the message's id; the message answers no person (answers false), its origin the trigger's.
        // How many of a trigger's messages a busy run keeps, and which are skipped, is the store's trigger side
        // (store.triggers.message's bound); this writes the command through the run write half.
        await message(store, run, String((input as { content?: unknown }).content), { answers: false, origin: from, requestId: key });
      } catch (error) {
        if (error instanceof ApiError && error.message === WAITS_ON_A_PERSON) return { skipped: WAITS_ON_A_PERSON };
        throw error;
      }
    },
    statusOf(runId) {
      return deps.runStatus(runId);
    },
    lastRun(runId) {
      return deps.runEnd(runId);
    },
    async runOf(key) {
      const found = await runOfOrigin(store, key);
      if (!found) return null;
      // A run is inserted whole (its row and launch in one transaction), so there is no half-set-up run a server left
      // behind: a found run started.
      return { run_id: found.runId, setup_lost: false };
    },
  };
}
