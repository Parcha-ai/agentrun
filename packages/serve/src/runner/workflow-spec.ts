// The claim-time builder for a workflow run on the runner: it turns a claim (plus the run's launch, row and revision) into
// the WorkflowRunSpec the workflow loop runs (createWorkflowLoop(specOf)). This is where the run's money lives, the same
// path pi's turn books through (runner/adapters/pi.ts): each model node's requests go through the session's model proxy
// (the kernel's startModelProxy), admitted and booked by the runner's booking (modelPortFor + runBooking) under the kernel
// cap's one rule (beforeRequestOf). A step the cap holds for a raise parks the run (the loop's hooks.park, the kernel cap's
// parkOf/checkRaise/followUpOf); a call node's effect is the node-tool table's (toolOf(tool).effect) with the run's ctx.
//
// Two tier rules, binding and the same as pi's: the cap prices a model at the catalog's cost as given, tiers included
// (CapModel.price = model.cost), and the proxy books an answered request at pi-ai's calculateCost, tiered (the provider's
// `price`). So a hold and a booking past a model's tier threshold are never under what the provider bills.
import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { type Extension, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Workflow } from "@parcha/agentrun-dsl";
import { type BeforeRequest, modelPortFor, type Refusal, runBooking, type RunSessions, sessionSpendOf } from "@parcha/agentrun-kernel";
import { type ModelProxy, type ProviderPolicy, type ProxyUsage, startModelProxy } from "@parcha/agentrun-kernel/host";
import { beforeRequestOf, type CapMode, type CapModel, checkRaise, followUpOf, parkOf, type RaiseState } from "@parcha/agentrun-kernel/kernel/cap";
import { completer } from "../llm.js";
import { llmTiers, nodeTiers, type Tier, workflowNodes } from "../model.js";
import { type EffectRun, toolOf } from "../tools.js";
import { deniedText } from "./loop-contract.js";
import { journalSessions } from "./sessions.js";
import { type BudgetData, type EndData, KINDS, type RaiseData } from "./journal-kinds.js";
import type { CapRefusal, WorkflowCapRule, WorkflowHostHooks, WorkflowRunSpec } from "./workflow-loop.js";
import { type WorkflowCap, workflowHost, type WorkflowHostDeps } from "./workflow-host.js";
import type { Store } from "../store/store.js";

/** The one session key the workflow's model requests book under (the run's one booking sums it, runBooking). */
const SESSION = "workflow";
/** A call node's tool failure and a cap-held effect, as app.ts's runEffect completed them (the loop's `failing` reads them). */
const TOOL_FAILED = "agentrun_serve_tool_failed";
const CAP_HELD = "agentrun_serve_cap_held";

/** How a tier's model is reached and priced, resolved by the caller for each tier the workflow names: the proxy's provider
 *  (its API, origin, credential and policy), the catalog price the proxy books an answered request at (calculateCost,
 *  tiered), and the cap's model (its price the catalog's cost as given). A test gives a scripted origin and fetch. */
export interface WorkflowProvider {
  /** The model id the node asks for (the tier's model). */
  readonly modelId: string;
  /** The provider the proxy forwards to. */
  readonly api: string;
  readonly origin: string;
  readonly credential: () => string | Promise<string>;
  readonly headers?: Readonly<Record<string, string>>;
  /** The proxy's policy for this provider (anthropicPolicy for an Anthropic Messages model). */
  readonly policy: ProviderPolicy;
  /** The price of an answered request's usage, tiered (pi-ai's calculateCost on the catalog model): the proxy's booking. */
  readonly price: (model: string, usage: ProxyUsage) => number | null;
  /** The model as the cap prices it (its price the catalog's cost as given, tiers included): the hold. */
  readonly capModel: CapModel;
  /** The proxy's upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
}

/** What the claim-time builder reads and wires. */
export interface WorkflowSpecDeps {
  readonly store: Pick<Store, "runs" | "agents" | "flush">;
  readonly env?: NodeJS.ProcessEnv;
  /** Resolves the provider and cap model for each tier the workflow names (byTier's model, its provider, its price). The
   *  runner's dispatch gives the production resolver (the run's models and keys); a test gives a scripted one. */
  readonly providerOf: (tier: Tier) => WorkflowProvider | Promise<WorkflowProvider>;
  readonly now?: () => number;
}

/** A claimed run's revision and launch, as the builder reads them. */
interface Claimed {
  readonly agentId: string;
  readonly revisionId: string;
  readonly workflow: Workflow;
  readonly input: Record<string, unknown>;
  readonly capUsd: number | undefined;
  readonly mode: CapMode;
  readonly workRoot: string;
}

/** The newest raise's cap on the run's root, else none: the effective cap after takeRaises wrote this claim's raise, read
 *  once the Harness is open. One root scan, oldest-to-newest; the latest `agentrun.raise` entry's capUsd wins. */
async function raisedCapOf(harness: Harness, context: Context): Promise<number | undefined> {
  const root = await harness.conversation(ROOT_CONVERSATION_ID, context);
  if (!root) return undefined;
  let capUsd: number | undefined;
  for (let cursor: unknown = undefined; ; ) {
    const page = await root.entries({ order: "ascending" }, 500, cursor as never, context);
    for (const entry of page.items) if (entry.kind === KINDS.raise) capUsd = (entry.data as unknown as RaiseData).capUsd;
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return capUsd;
}

/** The run's cap rule, handed to the loop so it parks and takes raises by the kernel cap without importing it. */
function capRuleOf(capUsd: number): WorkflowCapRule {
  return {
    park: (refusal) => {
      const park = parkOf({ message: refusal.message, forGood: refusal.forGood, ...(refusal.figures ? { figures: refusal.figures } : {}) } as never, capUsd);
      return park.outcome === "parked"
        ? { outcome: "parked", pending: park.pending as unknown as BudgetData["pending"], words: park.words }
        : { outcome: "failed", error: park.error };
    },
    checkRaise: (state, raiseUsd) => checkRaise(state as RaiseState, raiseUsd) as never,
    followUpOf: (usd) => ({ text: followUpOf(usd).text }),
  };
}

/** The claim-time builder: `specOf(claim)` the loop calls. Reads the run's launch and revision, resolves each tier's
 *  provider, and returns the spec. The model proxies and the booking are started per claim (release closes them). */
export function workflowSpecOf(deps: WorkflowSpecDeps): (claim: { runId: string }) => Promise<WorkflowRunSpec> {
  const now = deps.now ?? Date.now;
  return async (claim) => {
    const claimed = await readClaim(deps, claim.runId);
    const tiers = tiersOf(claimed.workflow);

    // Each tier's provider and cap model, resolved once; the proxies start here (before the Harness opens, since the models
    // catalog the Harness takes points at them), their hooks deferred to the booking wired at harnessReady.
    const providers = new Map<Tier, WorkflowProvider>();
    for (const tier of tiers) providers.set(tier, await deps.providerOf(tier));

    const proxies: ModelProxy[] = [];
    const models = createModels();
    const hooks = deferredHooks();
    for (const [tier, provider] of providers) {
      const proxy = await startModelProxy({
        policy: provider.policy,
        hooks: hooks.port,
        model: provider.modelId,
        origin: provider.origin,
        credential: async () => (await provider.credential()) ?? "",
        price: provider.price as never,
        ...(provider.headers ? { headers: provider.headers } : {}),
        ...(provider.fetch ? { fetch: provider.fetch } : {}),
      }, randomBytes(32).toString("base64url"));
      proxies.push(proxy);
      models.setProvider(createProvider({
        id: providerId(tier),
        baseUrl: proxy.url,
        auth: { apiKey: { name: "AGENTRUN_SESSION_KEY", resolve: async () => ({ auth: { apiKey: proxy.key }, source: "session" }) } },
        models: [{ id: provider.modelId, name: provider.modelId, api: provider.api, provider: providerId(tier), baseUrl: proxy.url, headers: { authorization: `Bearer ${proxy.key}` }, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 }],
        api: anthropicMessagesApi(),
      } as never));
    }

    const modelOf = (tier: string | undefined): { provider: string; modelId: string } => {
      const resolved = (tier as Tier | undefined) ?? "default";
      const provider = providers.get(resolved) ?? providers.get("default");
      if (!provider) throw new Error(`the workflow names tier ${String(tier)}, which this run has no model for`);
      return { provider: providerId(providers.has(resolved) ? resolved : "default"), modelId: provider.modelId };
    };
    const capModelOf = (id: string): CapModel | undefined => {
      for (const provider of providers.values()) if (provider.capModel.id === id) return provider.capModel;
      return undefined;
    };

    // The cap read against every request: the run's cap, raised in place once harnessReady reads this claim's raise.
    let effectiveCapUsd = claimed.capUsd;

    // The run's completer for a call node's `llm` tool: one completion on the run's models, its tier's model (the proxy
    // books it under the cap like a model node's).
    const complete = completer(models as never, (tier) => modelOf(tier as string | undefined), undefined as never);

    let booking: Awaited<ReturnType<typeof modelPortFor>> | undefined;

    const spec: WorkflowRunSpec = {
      models,
      workflow: claimed.workflow,
      input: claimed.input,
      tools: toolsOf(claimed.workflow),
      agentId: claimed.agentId,
      revisionId: claimed.revisionId,
      ...(claimed.capUsd !== undefined ? { cap: capRuleOf(claimed.capUsd) } : {}),
      endPatch: async () => endPatchOf(booking),
      build: (loopHooks: WorkflowHostHooks) => {
        hooks.setPark(loopHooks.park);
        const hostDeps: WorkflowHostDeps = {
          modelOf,
          sharedExtensions: [],
          nodeTool: () => undefined,
          runEffect: runEffectOf(claimed, complete, deps.env ?? process.env),
          workRoot: claimed.workRoot,
          flush: () => deps.store.flush(),
          cap: identityWorkflowCap(),
        };
        return workflowHost(hostDeps) as { extensions: readonly Extension[]; host: never };
      },
      harnessReady: async (harness, context) => {
        // The raise this claim took (takeRaises wrote it before the workflow ran) moves the cap in place.
        const raised = await raisedCapOf(harness, context);
        if (raised !== undefined && (effectiveCapUsd === undefined || raised > effectiveCapUsd)) effectiveCapUsd = raised;
        // The run's booking over the journal's sessions: the model proxy's requests go through it, checked by the cap and
        // summed across the run (runBooking). Wired now the Harness is open; the proxies' hooks forward here.
        const sessions = journalSessions(harness, context, { flush: () => deps.store.flush() });
        const writer = await sessions.open(SESSION);
        const cap = cappedBefore({
          capUsd: () => effectiveCapUsd,
          modelOf: capModelOf,
          mode: claimed.mode,
          now,
          park: hooks.park,
        });
        booking = await modelPortFor(writer, {
          key: SESSION,
          label: SESSION,
          beforeRequest: runBooking(sessions as RunSessions, cap),
          onEvent: async (event) => { if (event.type === "request_start") await deps.store.flush(); },
        });
        hooks.setPort(booking.models as never);
      },
      release: async () => {
        for (const proxy of proxies) await proxy.close().catch(() => undefined);
      },
    };
    return spec;
  };
}

/** The cap's beforeRequest for the run's model requests: the kernel cap's rule (beforeRequestOf), and on a refusal it
 *  parks the run through the loop's hook (parkOf decides room vs for good from the refusal), the same as the pi adapter's
 *  parkAtCap. It still returns the refusal, so the proxy refuses the request and the node's turn ends. */
function cappedBefore(options: { capUsd: () => number | undefined; modelOf: (id: string) => CapModel | undefined; mode: CapMode; now: () => number; park: (refusal: CapRefusal) => void }): BeforeRequest {
  const before = beforeRequestOf({ capUsd: options.capUsd, modelOf: options.modelOf, mode: options.mode, now: options.now });
  return async (request) => {
    const verdict = await before(request);
    if (verdict && "refuse" in verdict) {
      const refusal = verdict as Refusal;
      options.park({ message: refusal.refuse, forGood: refusal.forGood ?? true, ...(refusal.figures ? { figures: refusal.figures } : {}) });
    }
    return verdict;
  };
}

/** The proxies start before the booking is wired; their hooks forward to the booking set at harnessReady. A request before
 *  then would be a bug (no model request runs before the workflow does), so it refuses loudly. `park` is the loop's hook,
 *  set at build, which a cap refusal calls. */
function deferredHooks() {
  let port: { beforeRequest(r: unknown): Promise<unknown>; afterRequest(u: unknown, t?: unknown, e?: unknown): Promise<void>; responded?(ids: unknown, t?: unknown): Promise<void>; note?(m: string, r?: unknown): string | undefined } | undefined;
  let park: ((refusal: CapRefusal) => void) | undefined;
  return {
    port: {
      beforeRequest: (request: never) => (port ?? missing()).beforeRequest(request),
      afterRequest: (usage: never, ticket?: never, ended?: never) => (port ?? missing()).afterRequest(usage, ticket, ended),
      responded: (ids: never, ticket?: never) => (port ?? missing()).responded?.(ids, ticket) ?? Promise.resolve(),
      note: (model: never, request?: never) => (port ?? missing()).note?.(model, request),
    },
    setPort: (p: typeof port) => { port = p; },
    park: (refusal: CapRefusal) => park?.(refusal),
    setPark: (p: (refusal: CapRefusal) => void) => { park = p; },
  };
}
const missing = (): never => { throw new Error("a workflow model request left before its run's booking was wired"); };

/** The cap wrappers over the DSL driver's adapters. The run's money is booked on the model proxy and held by the cap's
 *  beforeRequest (which parks the run on a refusal), so these count no money of their own: the pause gate is gone and a
 *  cap hold parks through the loop, so each wrapper runs its adapter as the driver gave it. */
function identityWorkflowCap(): WorkflowCap {
  return { node: (fn) => fn, effect: (fn) => fn, judge: (fn) => fn };
}

/** A call node `via: "tool"`: the node-tool table's effect (toolOf(tool).effect) with the run's ctx, as app.ts ran it. Its
 *  paid requests (its `llm` call) book through the run's models under the cap. A cap-held request ends the effect held
 *  (CAP_HELD), a tool failure as the tool's own (TOOL_FAILED); the loop's `failing` reads both. */
function runEffectOf(claimed: Claimed, complete: ReturnType<typeof completer>, env: NodeJS.ProcessEnv): EffectRun extends never ? never : WorkflowHostDeps["runEffect"] {
  return (async ({ node, input, signal }: { node: { label: string; via: string; tool?: string }; input: Record<string, unknown>; signal: AbortSignal }) => {
    const effect = node.via === "tool" && node.tool ? toolOf(node.tool)?.effect : undefined;
    if (!effect) throw new Error(`call node "${node.label}": agentrun-serve runs no tool ${node.tool ?? `via ${node.via}`}`);
    try {
      return await effect(input, { signal, env, work: claimed.workRoot, complete });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (signal.aborted || (error as Error)?.name === "AbortError") throw error;
      return { [TOOL_FAILED]: `call node "${node.label}": ${node.tool} failed: ${message.slice(0, 500)}` };
    }
  }) as never;
}

/** The end's cost and metrics from the run's booking: what every model request of the run cost (null once one is unknown). */
async function endPatchOf(booking: Awaited<ReturnType<typeof modelPortFor>> | undefined): Promise<Pick<EndData, "costUsd" | "metrics">> {
  if (!booking) return {};
  const spent = booking.spentUsd();
  return spent === null ? {} : { costUsd: spent };
}

/** The tiers the workflow's model nodes run on (model.ts): the llm tiers over its nodes, else the default. */
function tiersOf(workflow: Workflow): Tier[] {
  const nodes = workflowNodes(workflow, { nodes: [] } as never);
  const tiers = llmTiers(nodes, nodeTiers(nodes));
  return tiers.length ? tiers : ["default"];
}

/** The tools the workflow may call, for the host to register. */
function toolsOf(workflow: Workflow): string[] {
  void workflow;
  return [];
}

const providerId = (tier: Tier): string => `workflow-session-${tier}`;

/** The run's revision, launch and work folder, read at the claim. */
async function readClaim(deps: WorkflowSpecDeps, runId: string): Promise<Claimed> {
  const run = await deps.store.runs.get(runId);
  if (!run) throw new Error(`the store has no run ${runId}`);
  const revision = await deps.store.agents.revision(run.revisionId);
  if (!revision || revision.kind !== "workflow") throw new Error(`run ${runId} is not a workflow run`);
  const launchRow = await deps.store.runs.launch(runId);
  const launch = launchRow.body as { input?: unknown; max_cost_usd?: unknown; cap_mode?: unknown; documents?: unknown } | null;
  const input = launch && typeof launch.input === "object" && launch.input !== null ? (launch.input as Record<string, unknown>) : {};
  const capUsd = typeof launch?.max_cost_usd === "number" ? launch.max_cost_usd : undefined;
  const mode: CapMode = launch?.cap_mode === "strict" ? "strict" : "expected";
  const workRoot = typeof launch?.documents === "string" ? launch.documents : "/tmp";
  return { agentId: run.agentId, revisionId: run.revisionId, workflow: (revision.body as { workflow: Workflow }).workflow, input, capUsd, mode, workRoot };
}

export { BACKGROUND_CONTEXT };
