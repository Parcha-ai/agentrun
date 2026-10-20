import { createHash } from "node:crypto";
import { inspectWorkflow, validateWorkflow, type Workflow } from "@parcha/agentrun-dsl";
import type { createWorkflowExtension, WorkflowCaller } from "@parcha/agentrun-pi/durable";
import { WorkflowStore } from "@parcha/agentrun-pi/workflows";
import type { Repo } from "@parcha/pi-git-remote";
import { servingRevision } from "./promotion.js";
import { currentRevision, readTrial } from "./trial.js";
import { readRevision } from "./workflows.js";

type Context = Parameters<ReturnType<typeof createWorkflowExtension>["start"]>[2];
/** The DSL's workflow extension, as `createWorkflowExtension` returns it (or `createWorkflowTool(...).workflow`). */
export type WorkflowStarter = Pick<ReturnType<typeof createWorkflowExtension>, "start">;

/** What the host serves for one run: a revision of a saved workflow and its document. `canary` is a superseded revision
 *  served while its successor, `trial`, is on trial. */
export type ServingPlan = {
  readonly name: string;
  readonly sha256: string;
  readonly workflow: Workflow;
  readonly canary: boolean;
  readonly trial?: string;
};

/** How a served run ended. `complete` is an output the host's check accepted, the run's answer; an output it refused is
 *  `escalated` with its `problems`; `refused` never started (no task, `key` null). */
export type ServedRun = {
  readonly name: string;
  readonly sha256: string;
  readonly canary: boolean;
  readonly key: string | null;
  readonly outcome: "complete" | "escalated" | "failed" | "aborted" | "refused";
  readonly output?: unknown;
  readonly problems?: readonly string[];
  readonly escalation?: unknown;
  readonly detail?: string;
};

const canonical = (value: unknown): string => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value ?? null));

/** A served run's key: `host:<name>:<workflow sha256>:<input hash>`, so the run's records name the workflow. */
export const hostKey = (name: string, sha256: string, input: unknown): string => `host:${name}:${sha256}:${createHash("sha256").update(canonical(input)).digest("hex")}`;

/** The name a served run's key carries, or null for a run the agent started. */
export const hostRunName = (key: unknown): string | null => (typeof key === "string" && key.startsWith("host:") ? key.split(":")[1] || null : null);

export type ServeOptions = {
  readonly harness: WorkflowCaller;
  readonly workflows: WorkflowStarter;
  readonly context: Context;
  readonly plan: ServingPlan;
  readonly input: Record<string, unknown>;
  /** The tools this host registers for a workflow's call nodes. */
  readonly tools: readonly string[];
  /** The host's check of an output, its answer's own: the problems, none when it is a valid answer. */
  readonly check: (output: unknown) => readonly string[];
};

/**
 * Runs `plan` as a durable workflow task of the run, before the agent says anything. The checks the agentrun tool makes
 * come first, and a workflow that fails one is `refused` with no task: a code node, SOP text, a tool the host does not
 * register, an input the workflow does not take or a node that reads a key the input lacks. A complete run whose output
 * `check` accepts is `complete`, the answer; one it refuses is `escalated`, with the problems.
 */
export async function serve(options: ServeOptions): Promise<ServedRun> {
  const { plan, input } = options;
  const base = { name: plan.name, sha256: plan.sha256, canary: plan.canary };
  const refuse = (detail: string): ServedRun => ({ ...base, key: null, outcome: "refused", detail });
  let inspection: ReturnType<typeof inspectWorkflow>;
  try {
    inspection = inspectWorkflow(plan.workflow);
  } catch (error) {
    return refuse(`it does not inspect: ${error instanceof Error ? error.message : String(error)}`);
  }
  const code = inspection.nodes.filter((node) => node.kind === "code").map((node) => node.label);
  if (code.length) return refuse(`it has code nodes (${code.join(", ")}), and this host runs no code`);
  if (inspection.requires.sopSections.length) return refuse("it needs SOP text, which this host has none of");
  const missing = inspection.requires.tools.filter((tool) => !options.tools.includes(tool));
  if (missing.length) return refuse(`it uses tools this host does not register: ${missing.join(", ")}`);
  const fits = validateWorkflow(plan.workflow, { executeCode: false, input });
  if (!fits.ok) return refuse(`it does not take this input: ${fits.errors.slice(0, 20).join("; ")}`);
  const key = hostKey(plan.name, plan.sha256, input);
  const run = await options.workflows.start(options.harness, { key, workflow: plan.workflow, input }, options.context, { background: true });
  const outcome = await run.wait(options.context);
  if (outcome.status === "complete") {
    const problems = [...new Set(options.check(outcome.output))].slice(0, 20);
    return problems.length
      ? { ...base, key, outcome: "escalated", output: outcome.output, problems }
      : { ...base, key, outcome: "complete", output: outcome.output };
  }
  if (outcome.status === "escalated") return { ...base, key, outcome: "escalated", escalation: outcome.escalation };
  if (outcome.status === "stopped") return { ...base, key, outcome: "aborted", detail: outcome.stop };
  // A task that failed comes back refused, with the run's error.
  return { ...base, key, outcome: "failed", detail: `${outcome.code}: ${outcome.message}` };
}

/** A served run's outcome as a use, or undefined when it says nothing about the workflow (it never started, or was cut). */
export const servedUse = (run: ServedRun): "frozen" | "escalated" | "failed" | undefined =>
  run.key === null ? undefined : run.outcome === "complete" ? "frozen" : run.outcome === "escalated" ? "escalated" : run.outcome === "failed" ? "failed" : undefined;

export type PlanServingOptions = {
  readonly repo: Pick<Repo, "read" | "list">;
  /** The commit the run was seeded from. */
  readonly sha: string;
  /** The run's working directory: its workflow store, where `seedWorkflows` put the live revisions. */
  readonly workDir: string;
  /** What `seedWorkflows` loaded into the run, in its order (active ones first). */
  readonly workflows: readonly { readonly name: string; readonly sha256: string }[];
  /** The host's: whether a workflow takes this job (its input, the shape of its output). */
  readonly takes: (workflow: Workflow) => boolean;
};

/**
 * What the host serves for this run, or null. Of the workflows seeded into the run, in their order, the first whose live
 * revision at `sha` is the one seeded and whose served revision `takes` the job: the live revision when it is active; while
 * it is on trial, the revision it superseded, the last one proven (`canary`, read from the repository at `sha` and checked
 * against its digest), so the trial still earns its place through the agent. A first revision on trial, with none proven
 * before it, is not served.
 */
export async function planServing(options: PlanServingOptions): Promise<ServingPlan | null> {
  for (const { name, sha256 } of options.workflows) {
    const trial = await readTrial(options.repo, name, options.sha).catch(() => undefined);
    const live = trial && currentRevision(trial);
    if (!trial || !live || live.sha256 !== sha256) continue;
    if (live.status === "active") {
      const workflow = await new WorkflowStore(options.workDir).load(name, sha256).then((stored) => stored.workflow, () => undefined);
      if (workflow && options.takes(workflow)) return { name, sha256, workflow, canary: false };
      continue;
    }
    // A superseded revision whose record cannot be read is passed over for the next most recent one.
    const unrunnable = new Set<string>();
    for (let pick = servingRevision(trial, { unrunnable }); pick?.canary; pick = servingRevision(trial, { unrunnable })) {
      const workflow = (await readRevision(options.repo, name, pick.serve.sha256, options.sha)) as Workflow | undefined;
      if (!workflow) { unrunnable.add(pick.serve.sha256); continue; }
      if (options.takes(workflow)) return { name, sha256: pick.serve.sha256, workflow, canary: true, trial: live.sha256 };
      break;
    }
  }
  return null;
}
