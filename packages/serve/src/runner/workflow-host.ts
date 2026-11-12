// The interpreter's host for a workflow run on the runner: the workflow task's adapters (model nodes, call nodes,
// decisions), moved from the per-run process's app.ts workflow branch, so the DSL engine runs exactly as it did. What was
// the process's run infrastructure — the model proxy, the node-tool table and its call ctx, the spend cap and budget — is
// injected here; the runner's dispatch wires the real ones (B2c's startModelProxy and run-booking, the kernel cap, the
// node-tool table) at the claim, and a test wires a faux model. This module holds no money of its own: the cap wraps the
// adapters through `cap`, absent for a run with none (a test, or before the cap is wired).
//
// What it owns, verbatim from app.ts: a model node's agent (its tier's model, the tools it names, their extensions); the
// node log's node.start/node.end lines (onEvent); and the `createWorkflowExtension` wiring — the effect-admission flush,
// `withRecovery` over the driver with runNode/runEffect/runJudge/recordDecision, and the cap's wrappers around them. The
// per-run process's pause gate is gone: a cap hold parks the run through the loop (workflow-loop.ts), not a file gate.
import type { Context } from "@earendil-works/chord";
import type { Extension } from "@earendil-works/pi-durable";
import { createWorkflowExtension, type WorkflowTaskHost } from "../workflow/task.js";
import { decisionRecovery } from "../workflow/decision-recovery.js";
import { nodeRunner } from "../workflow/node-runner.js";
import { taskScope } from "../workflow/node.js";
import { judgeFromProviders } from "@parcha/agentrun-dsl";
import { withRecovery, workspaceFiles } from "@parcha/agentrun-dsl/recovery";

/** A model node's tier, as the DSL names it. */
export type NodeTier = string | undefined;

/** A node tool's bindings for a model node's agent (its pi extensions and tools), as the node-tool table binds them. */
export interface NodeToolBinding {
  readonly extensions: readonly Extension[];
  readonly tools: readonly unknown[];
}

/** A call node's effect, its gate and the node log, as app.ts's runEffect ran them. The host wires this into the driver;
 *  the caller builds it over the node-tool table (toolOf(tool).effect) with the run's env, workspace, the llm completer
 *  and the cap ledger — the run infrastructure the runner holds, not this module. */
export type RunEffect = (params: { readonly node: { readonly label: string; readonly via: string; readonly tool?: string }; readonly input: Record<string, unknown>; readonly signal: AbortSignal; readonly executionPath?: string; readonly item?: { readonly index: number } }) => Promise<unknown>;

/** What a decision's wrapper reads from the DSL driver to tell a replayed request (a route the driver decided, or one an
 *  earlier process admitted that did not fail) from a fresh one: a replayed request holds nothing (main's askedBefore). */
export interface DecisionDriver {
  routeDecision(executionPath: never): unknown;
  decisionRequests(): Record<string, { status: string }>;
  /** Resolves once the driver's commits so far are durable (a request it ended, before the run parks on it). */
  flush(): Promise<void>;
}

/** The run's spend cap over the workflow's adapters (app.ts's budget: stepped/failing/capStopped and the decision cap),
 *  injected so this module holds no money of its own. Each wrapper is applied to its adapter where app.ts applied it; a run
 *  with no cap (a test, or before the cap is wired) passes none and the adapters run unwrapped. `held` is a call node's
 *  wait on a raise, which its deadline leaves out. */
export interface WorkflowCap {
  /** stepped(gate(capStopped(·)), true): a model node, counted in flight, failing as a cap stop where no raise fixes it. */
  node<F>(fn: F): F;
  /** stepped(failing(·)): a call node, which waits for a raise on a held effect and goes again. */
  effect<F>(fn: F): F;
  /** A decision, before the driver admits its request: priced, or parked by a pause. The driver tells a replayed request,
   *  which holds nothing. */
  judge<F>(fn: F, driver?: DecisionDriver): F;
  /** A decision's judge once the driver has admitted its request: held through the kernel cap, sent, and settled. Absent:
   *  the judge runs as given. */
  admitted?<F>(fn: F): F;
  /** A call node's wait on a raise (deps.held), left out of its deadline. */
  held?(path: string): number;
}

/** What one workflow run's host needs, the run infrastructure injected (the model proxy via `modelOf`, the node-tool
 *  table via `nodeTool`/`runEffect`, the decision providers, the cap). */
export interface WorkflowHostDeps {
  /** A node's tier's model (byTier): app.ts's nodeAgent model. */
  readonly modelOf: (tier: NodeTier) => { readonly provider: string; readonly modelId: string };
  /** Told as each model node's execution starts, before it runs: its execution path and the tier it asked for (the graph
   *  keeps what each execution ran on). Absent: nothing told. */
  readonly onModelNode?: (node: { readonly executionPath: string; readonly tier?: string }) => Promise<void>;
  /** The thinking level every node agent runs at. */
  readonly thinkingLevel?: unknown;
  /** The extensions every model node's agent shares (the coding extension and the gate), installed in the registry too. */
  readonly sharedExtensions: readonly Extension[];
  /** A node tool's bindings by name, for a model node's agent; undefined for a name the host does not bind. */
  readonly nodeTool: (name: string) => NodeToolBinding | undefined;
  /** A call node's effect (the node-tool table's, with the run's ctx and the cap ledger). */
  readonly runEffect: RunEffect;
  /** The decision providers (runJudge) by id and the one a node that names none gets, and how a decision's images load;
   *  absent: the workflow runs no decision node. */
  readonly decisionProviders?: { readonly providers: Readonly<Record<string, unknown>>; readonly default: string };
  readonly loadImage?: unknown;
  /** The run's work folder (the DSL's file reads are rooted here: workspaceFiles). */
  readonly workRoot: string;
  /** A workflow effect's admission made durable before it is dispatched (the loop's flush over A's journal). */
  readonly flush: () => Promise<void>;
  /** The node log's node.start/node.end lines; absent: no log. */
  readonly log?: (line: Record<string, unknown>) => void;
  /** Told each workflow step's start and end, by its label (the workflow's node.start/node.end): what a cap's pause reads
   *  to name the node whose step it held (workflow-spec.ts openSteps). */
  readonly steps?: { start(label: string): void; end(label: string): void };
  /** What a decision's receipt is shown as, as it is recorded (the live view); absent: not shown. */
  readonly onReceipt?: (receipt: Record<string, unknown>) => void;
  /** The run's spend cap over the adapters; absent: the workflow runs with no cap. */
  readonly cap?: WorkflowCap;
}

const identityCap: WorkflowCap = { node: (fn) => fn, effect: (fn) => fn, judge: (fn) => fn };

/** `runNode` that tells `told` of each model node's execution (its path and tier) before it runs it. */
function withModelNode<P extends { executionPath?: string; tier?: unknown }, R>(runNode: (params: P) => Promise<R>, told: WorkflowHostDeps["onModelNode"]): (params: P) => Promise<R> {
  if (!told) return runNode;
  return async (params) => {
    if (typeof params.executionPath === "string") await told({ executionPath: params.executionPath, ...(typeof params.tier === "string" ? { tier: params.tier } : {}) });
    return runNode(params);
  };
}

/** The workflow task's host and the extensions to install before the Harness opens, as the per-run process built them.
 *  Pass the result to createWorkflowLoop's spec.build. */
export function workflowHost(deps: WorkflowHostDeps): { readonly extensions: readonly Extension[]; readonly host: WorkflowTaskHost } {
  const cap = deps.cap ?? identityCap;
  const admitted = <F>(fn: F): F => (cap.admitted ? cap.admitted(fn) : fn);

  /** A model node's agent: its tier's model, the tools it names, and the extensions they come from (app.ts nodeAgent). */
  const nodeAgent = (node: { tier?: string; tools?: string[] }) => {
    const bindings = (node.tools ?? []).flatMap((name) => deps.nodeTool(name) ?? []);
    return {
      model: deps.modelOf(node.tier),
      thinkingLevel: deps.thinkingLevel,
      extensions: [...new Set([...deps.sharedExtensions, ...bindings.flatMap((binding) => binding.extensions)])],
      tools: bindings.flatMap((binding) => binding.tools),
    };
  };
  const nodes = nodeRunner({ agent: (node) => nodeAgent(node) as never });

  /** The node log's starts and ends, from the workflow's events (app.ts onEvent). */
  const onEvent = (event: { type: string; label?: string; detail?: unknown; executionPath?: string }) => {
    // A nested `workflow` step stays open while its own steps run and sends no request itself: the steps open are the ones
    // that can, so a pause inside it names its step, never nothing.
    const enclosing = (event.detail as { kind?: unknown } | undefined)?.kind === "workflow";
    if (typeof event.label === "string" && event.type === "node.start" && !enclosing) deps.steps?.start(event.label);
    if (typeof event.label === "string" && event.type === "node.end" && !enclosing) deps.steps?.end(event.label);
    if (!deps.log || (event.type !== "node.start" && event.type !== "node.end") || typeof event.executionPath !== "string") return;
    const detail = (event.detail ?? {}) as { kind?: string; status?: string; duration_ms?: number; error?: unknown };
    deps.log({
      t: event.type, path: event.executionPath, kind: String(detail.kind ?? ""), at: new Date().toISOString(),
      ...(detail.status ? { status: detail.status } : {}),
      ...(typeof detail.duration_ms === "number" ? { duration_ms: detail.duration_ms } : {}),
      ...(detail.error !== undefined ? { error: String((detail.error as Error)?.message ?? detail.error).slice(0, 500) } : {}),
    });
  };

  const host: WorkflowTaskHost = {
    // Each workflow effect's admission is made durable before it is dispatched: on the runner, the loop's flush over A's
    // journal, in place of the per-run store's barrier sync.
    options: () => ({ files: workspaceFiles(deps.workRoot) as never, afterAdmit: async () => void (await deps.flush()) }),
    run: ({ key, runtime, context, driver }: { key: string; runtime: unknown; context: Context; driver: unknown }) => {
      const decisions = decisionRecovery({ key, runtime: runtime as never, context });
      const recovered = withRecovery(driver as never, {
        runNode: withModelNode(nodes.on(taskScope(runtime as never), context).runNode, deps.onModelNode),
        runEffect: deps.runEffect as never,
        // The judge the driver asks once it has admitted a request: the cap holds, sends and settles it there (admitted).
        ...(deps.decisionProviders ? { runJudge: admitted(judgeFromProviders({ ...deps.decisionProviders, loadImage: deps.loadImage } as never)) as never, decisionProviders: deps.decisionProviders as never } : {}),
        recordDecision: async (receipt: Parameters<typeof decisions.recordDecision>[0], exchange: Parameters<typeof decisions.recordDecision>[1]) => {
          await decisions.recordDecision(receipt, exchange);
          deps.onReceipt?.(receipt as unknown as Record<string, unknown>);
        },
      }, { durableNodes: true });
      const { recovery } = recovered;
      if (!recovery) throw new Error("the workflow's recovery gave the run no recovery hooks");
      // The cap wraps each adapter where app.ts wrapped it. The per-run process's pause gate is gone: a cap hold parks the
      // run through the loop, so there is no `gated(...)` here.
      return { deps: {
        ...recovered,
        runNode: cap.node(recovered.runNode),
        runEffect: cap.effect(recovered.runEffect),
        ...(recovered.runJudge ? { runJudge: cap.judge(recovered.runJudge, driver as DecisionDriver) } : {}),
        onEvent,
        ...(cap.held ? { held: (path: string) => cap.held!(path) } : {}),
        recovery: { ...recovery, decision: decisions.decision },
      } };
    },
  };

  // The shared extensions (the nodes' tools and their gate) are installed in the run's registry too, as main's
  // registry.install did: pi's node runner offers and runs a node's tool by its registration there.
  return { extensions: [nodes.extension as unknown as Extension, ...deps.sharedExtensions], host };
}
