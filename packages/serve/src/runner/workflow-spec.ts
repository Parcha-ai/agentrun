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
import { createModels } from "@earendil-works/pi-ai/models";
import { type Extension, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Revision } from "@parcha/pi-durable-agent";
import { chargedCost, type DecisionProvider, DecisionProviderError, EffectFailure, inspectWorkflow, type LoadImage, type Workflow, type WorkflowDeps } from "@parcha/agentrun-dsl";
import type { DecisionModelPrice } from "@parcha/agentrun-decisions";
import { type BeforeRequest, modelPortFor, type Refusal, type RunSessions, type Wire } from "@parcha/agentrun-kernel";
import { type ModelProxy, type ProviderPolicy, type ProxyUsage, startModelProxy } from "@parcha/agentrun-kernel/host";
import { type CapMode, type CapModel, CapRefused, checkRaise, DECISION_SESSION, type DecisionCapRequest, followUpOf, parkOf, type RaiseState, runCap, type RunDecisions } from "@parcha/agentrun-kernel/kernel/cap";
import { completer } from "../llm.js";
// The serve decision-provider list prices and the replay check, shared with main's decision cap. They move to the new
// path when the old per-run decision cap (decision-cap.ts) is deleted in the cutover; one source of truth until then.
import { askedBefore, JEV_INPUT_USD, PARALLEL_DECISION_USD } from "../decision-cap.js";
import { decisionProvidersIn } from "../decisions.js";
import { imageLoader } from "../pdf-pages.js";
import type { RunLaunch } from "../run-launch.js";
import { llmTiers, nodeTiers, type Tier, workflowNodes } from "../model.js";
import { CALL_TOOLS, type EffectRun, toolOf, workflowTools } from "../tools.js";
import { runGate } from "../tool-gate.js";
import { callNodeAskText, deniedText } from "../refusal-words.js";
import { loadToolSettings, planeOf, TOOL_PLANE_ENV } from "../tool-plane.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { SUBMIT_TOOL } from "@parcha/agentrun-pi";
import { type PaidBooking, parallelExtractFee, parallelSearchFee } from "../paid-calls.js";
import { searchArgs } from "../web-search.js";
import { money, pricingOf, requestPrice, type RunTools, TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { claimSecrets } from "./claim-secrets.js";
import { type ModelRoute, routeOf } from "./model-route.js";
import { PI_WIRES } from "./adapter-run-spec.js";
import { policyFor } from "./adapters/pi.js";
import { sessionProvider } from "../port-models.js";
import { journalSessions } from "./sessions.js";
import { type BudgetData, type EndData, KINDS, type RaiseData } from "./journal-kinds.js";
import { type CapRefusal, PAUSED_WORDS, type WorkflowCapRule, type WorkflowHostHooks, type WorkflowRunSpec, type WorkflowSpecRun } from "./workflow-loop.js";
import { heldRedactor, holdClaimed } from "./redact.js";
import { holdStored } from "./store-secrets.js";
import { type DecisionDriver, type WorkflowCap, workflowHost, type WorkflowHostDeps } from "./workflow-host.js";
import type { Store } from "../store/store.js";

/** The one session key the workflow's model requests book under (the run's one booking sums it, runBooking). */
const SESSION = "workflow";
/** A call node's tool failure and a cap-held effect, as app.ts's runEffect completed them (the loop's `failing` reads them). */
const TOOL_FAILED = "agentrun_serve_tool_failed";
const CAP_HELD = "agentrun_serve_cap_held";

type RunJudge = NonNullable<WorkflowDeps["runJudge"]>;
type JudgeParams = Parameters<RunJudge>[0];
type JudgeResult = Awaited<ReturnType<RunJudge>>;

/** How a tier's model is reached and priced, resolved by the caller for each tier the workflow names: the proxy's provider
 *  (its API, origin, credential and policy), the catalog price the proxy books an answered request at (calculateCost,
 *  tiered), and the cap's model (its price the catalog's cost as given). A test gives a scripted origin and fetch. */
export interface WorkflowProvider {
  /** The model id the node asks for (the tier's model). */
  readonly modelId: string;
  /** The wire the proxy forwards on, and pi-ai's client of it speaks to the proxy (port-models.ts sessionProvider). */
  readonly api: Wire;
  /** The catalog's entry for the model (whether it reasons, its window), as pi's session takes it (model-route.ts). */
  readonly like?: { readonly reasoning?: boolean; readonly contextWindow?: number; readonly maxTokens?: number };
  readonly origin: string;
  readonly credential: () => string | Promise<string>;
  readonly headers?: Readonly<Record<string, string>>;
  /** The proxy's policy for this provider: its wire's, as pi's session takes it (pi.ts policyFor). */
  readonly policy: ProviderPolicy;
  /** The price of an answered request's usage, tiered (pi-ai's calculateCost on the catalog model): the proxy's booking. */
  readonly price: (model: string, usage: ProxyUsage) => number | null;
  /** The model as the cap prices it (its price the catalog's cost as given, tiers included): the hold. */
  readonly capModel: CapModel;
  /** The proxy's upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
}

/** A tier's provider from the runner's model route (model-route.ts routeOf), the one way the runner resolves a model
 *  (the pi adapter's path): the route's provider, model and price for the proxy's booking, and the catalog's cost and
 *  output ceiling as the cap prices the hold. So a workflow model node and a pi turn book the same model the same way. */
export function routeProviderOf(env: NodeJS.ProcessEnv): (tier: Tier) => Promise<WorkflowProvider> {
  // Asked on pi's wires: a model node speaks the route's wire as a pi turn does; a model on neither keeps the route's
  // Messages translation (model-route.ts messagesFetch).
  return async (tier) => providerFromRoute(await routeOf(undefined, env, tier, PI_WIRES));
}

/** A WorkflowProvider from a resolved model route: its provider for the proxy, its price for the booking, and its catalog
 *  cost and output ceiling as the cap's model (the hold). The proxy's policy is the route's wire's, as pi's session takes
 *  it (pi.ts policyFor: claude-agent's on Messages, codex's on Responses, no fork), with no tool of the session's own. */
export async function providerFromRoute(route: ModelRoute): Promise<WorkflowProvider> {
  return {
    modelId: route.model,
    api: route.provider.api,
    ...(route.like ? { like: route.like } : {}),
    origin: route.provider.origin,
    credential: route.provider.credential,
    ...(route.provider.headers ? { headers: route.provider.headers } : {}),
    policy: await policyFor(route.provider, route.model, []),
    price: (route.price ?? (() => null)) as (model: string, usage: ProxyUsage) => number | null,
    capModel: { id: route.model, api: route.provider.api, price: route.cost ?? null, outputCeiling: route.outputCeiling ?? null },
    ...(route.fetch ? { fetch: route.fetch } : {}),
  };
}

/** What the claim-time builder reads and wires. */
export interface WorkflowSpecDeps {
  readonly store: Pick<Store, "runs" | "agents" | "flush" | "sealedKeys" | "settings" | "sealedSecrets">;
  readonly env?: NodeJS.ProcessEnv;
  /** The runner's seal key, for reading a claim's sealed secrets from the store (claim-secrets.ts). Given in production, so
   *  the default decision providers and image loader read the run's own stored keys; a test that injects decisionProvidersOf
   *  needs none. */
  readonly sealKey?: Buffer;
  /** The runner's data directory: what the server keeps sealed beside the store is read from it (store-secrets.ts). */
  readonly data?: string;
  /** Resolves the provider and cap model for each tier the workflow names (byTier's model, its provider, its price).
   *  Absent: the runner's model route (routeProviderOf), so a workflow and a pi run resolve models one way; a test gives a
   *  scripted one. */
  readonly providerOf?: (tier: Tier) => WorkflowProvider | Promise<WorkflowProvider>;
  /** The run's decision providers (jev, parallel, openrouter) and the one a node that names none gets. Absent: built from
   *  the claim's own sealed keys (claim-secrets.ts + decisions.ts decisionProvidersIn) when `sealKey` is given, so a workflow
   *  decision runs on the run's stored provider key; a test gives a scripted resolver. */
  readonly decisionProvidersOf?: () => DecisionProviders | undefined | Promise<DecisionProviders | undefined>;
  /** How a decision's images load. Absent: pdf-pages.ts imageLoader on the run's work folder, when the workflow has a
   *  decision node; a test gives its own. */
  readonly loadImage?: LoadImage;
  readonly now?: () => number;
}

/** The run's decision providers, by id, and the one a node that names none is answered by (decisions.ts). */
interface DecisionProviders {
  readonly providers: Readonly<Record<string, DecisionProvider>>;
  readonly default: string;
}

/** A claimed run's revision and launch, as the builder reads them. */
interface Claimed {
  readonly agentId: string;
  readonly revisionId: string;
  readonly revision: Revision;
  readonly workflow: Workflow;
  readonly input: Record<string, unknown>;
  readonly capUsd: number | undefined;
  readonly mode: CapMode;
  readonly workRoot: string;
  /** The launch's tool plane (which web tools resolve to Parallel), for scoping the run's decision keys. */
  readonly plane: RunLaunch["plane"];
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
export function workflowSpecOf(deps: WorkflowSpecDeps): (claim: { runId: string }, run?: WorkflowSpecRun) => Promise<WorkflowRunSpec> {
  const now = deps.now ?? Date.now;
  // The run's models resolve the one way the runner resolves any (routeProviderOf over routeOf), unless a test gives its own.
  const providerOf = deps.providerOf ?? routeProviderOf(deps.env ?? process.env);
  return async (claim, run) => {
    /** The keys a claim opens, held by the runner's one redactor (run.redact) before a decision can echo one. */
    const holding = async (opening: Promise<NodeJS.ProcessEnv>): Promise<NodeJS.ProcessEnv> => {
      const opened = await opening;
      if (run?.redact) holdClaimed(heldRedactor(run.redact), opened);
      return opened;
    };
    const claimed = await readClaim(deps, claim.runId);
    // Every secret the server keeps sealed (store-secrets.ts) held by the runner's one redactor before the workflow runs.
    if (run?.redact) await holdStored(heldRedactor(run.redact), deps.store, deps.sealKey, deps.data);
    const tiers = tiersOf(claimed.workflow);

    // Each tier's provider and cap model, resolved once; the proxies start here (before the Harness opens, since the models
    // catalog the Harness takes points at them), their hooks deferred to the booking wired at harnessReady.
    const providers = new Map<Tier, WorkflowProvider>();
    for (const tier of tiers) providers.set(tier, await providerOf(tier));

    const proxies: ModelProxy[] = [];
    const models = createModels();
    const hooks = deferredHooks();
    // The call nodes' effects in flight: a model request inside one is not where a pause lands (pauseAtEffects).
    const flight: EffectsInFlight = { count: 0 };
    // What a model node offers its model: its `submit` and the tools its node names. The session proxy's policy drops every
    // tool definition it is not given, so it admits this whole set by name (as pi's admits its session's tools); main's
    // nodes send their requests straight to the provider (app.ts:117), unfiltered.
    const offered = nodeOffer(claimed.workflow);
    for (const [tier, provider] of providers) {
      const proxy = await startModelProxy({
        policy: await policyFor({ api: provider.api, origin: provider.origin, credential: provider.credential, ...(provider.headers ? { headers: provider.headers } : {}) }, provider.modelId, offered),
        hooks: hooks.port,
        model: provider.modelId,
        origin: provider.origin,
        credential: async () => (await provider.credential()) ?? "",
        price: provider.price as never,
        ...(provider.headers ? { headers: provider.headers } : {}),
        ...(provider.fetch ? { fetch: provider.fetch } : {}),
      }, randomBytes(32).toString("base64url"));
      proxies.push(proxy);
      // pi-ai's client of the provider's wire at its proxy (port-models.ts sessionProvider), as pi's session reaches its own.
      models.setProvider(sessionProvider(provider.api, proxy, provider.modelId, { provider: providerId(tier), keyName: "AGENTRUN_SESSION_KEY", ...(provider.like ? { like: provider.like } : {}), reasoning: false }));
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

    // The run's decision providers, when its workflow has a decision node: the scripted resolver a test gives, else built
    // from the claim's own sealed keys (claim-secrets.ts reads the run's provider keys from the store into a scoped
    // environment; decisionProvidersIn builds the providers on them), so a decision runs on the run's stored key and never
    // another run's or this process's. The decisions book on the run's ONE cap (runCap), created with the model booking once
    // the Harness is open (harnessReady); a decision node runs after that, so it reaches the cap through a deferred reference.
    const decisions = deps.decisionProvidersOf
      ? (await deps.decisionProvidersOf()) ?? undefined
      : deps.sealKey
        ? (await decisionProvidersIn(await holding(claimSecrets({ store: deps.store, sealKey: deps.sealKey, ...(deps.env ? { env: deps.env } : {}) }, claimed.revision, { plane: claimed.plane })))) ?? undefined
        : undefined;
    // A decision's images load from the run's work folder, unless a test gives its own loader.
    const loadImage: LoadImage | undefined = deps.loadImage ?? (decisions ? imageLoader(claimed.workRoot) : undefined);
    let decisionCap: RunDecisions | undefined;
    // The run's paid tool calls on its one cap (TOOL_SESSION), wired at harnessReady: a call node's hold and its request.
    let paidTools: RunTools | undefined;
    const callEnv = callEnvOf(deps.env ?? process.env, claimed);
    const tierModel = (tier: string | undefined): CapModel | undefined => (providers.get((tier as Tier | undefined) ?? "default") ?? providers.get("default"))?.capModel;

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
      endPatch: async () => endPatchOf(booking, decisionCap, paidTools),
      build: (loopHooks: WorkflowHostHooks) => {
        hooks.setPark(loopHooks);
        const hostDeps: WorkflowHostDeps = {
          modelOf,
          sharedExtensions: [],
          nodeTool: () => undefined,
          runEffect: runEffectOf(claimed, complete, callEnv, callPolicyOf(deps.store, claim.runId, claimed), () => paidTools),
          workRoot: claimed.workRoot,
          flush: () => deps.store.flush(),
          // A decision node books through the run's one cap (admitted and settled as main holds it); a cap refusal for room
          // parks the run through the loop's hook, the same as a model node's. The cap is wired at harnessReady, so the
          // wrapper reaches it through the deferred reference. With no decision provider the workflow runs none.
          ...(decisions ? { decisionProviders: decisions, ...(loadImage ? { loadImage } : {}) } : {}),
          // A person's pause holds a call node before its effect starts (before the engine admits it), as main's gate did;
          // a call node's tool failure the driver recorded as its effect's outcome is thrown past the driver
          // (failingEffects, main's `failing`), on the first run and on a resume that answers it from its receipt alike.
          // Before admission too, each call's most cost is held on the run's one ledger (holdAtEffects): a hold the cap
          // refuses for room parks the run there, never admitted.
          cap: pauseAtEffects(holdAtEffects(failingEffects(decisions ? decisionWorkflowCap(() => decisionCap, decisions, hooks) : identityWorkflowCap()), {
            paid: () => paidTools,
            holdOf: (tool, input) => callHoldOf(tool, input, callEnv, tierModel),
            park: (refusal) => hooks.park(refusal),
          }), hooks, flight),
        };
        return workflowHost(hostDeps) as { extensions: readonly Extension[]; host: never };
      },
      harnessReady: async (harness, context) => {
        // The raise this claim took (takeRaises wrote it before the workflow ran) moves the cap in place.
        const raised = await raisedCapOf(harness, context);
        if (raised !== undefined && (effectiveCapUsd === undefined || raised > effectiveCapUsd)) effectiveCapUsd = raised;
        // The run's ONE cap over the journal's sessions: its model requests and its decisions admit by the one rule and
        // book on one ledger (runCap's runBooking over the sessions), so each is judged on the run's whole spend and a
        // refusal's figures are the run's. Wired now the Harness is open; the proxies' hooks forward to the model booking.
        const sessions = journalSessions(harness, context, { flush: () => deps.store.flush() });
        const writer = await sessions.open(SESSION);
        const run = runCap({ sessions: sessions as unknown as RunSessions, capUsd: () => effectiveCapUsd, mode: claimed.mode, now, modelOf: capModelOf });
        booking = await modelPortFor(writer, {
          key: SESSION,
          label: SESSION,
          // The model booking is the run's rule itself (no second booking); a refusal parks the run through the loop's hook.
          beforeRequest: parkOnRefusal(run.before, hooks, flight),
          onEvent: async (event) => { if (event.type === "request_start") await deps.store.flush(); },
        });
        // The run's decisions book on the same cap, under their own session (DECISION_SESSION); created now the Harness is
        // open, so a decision node (which runs after this) reaches it through the deferred reference. The flush makes each
        // decision's hold durable before it is sent, as a model request's is.
        if (decisions) decisionCap = await run.decisions(await sessions.open(DECISION_SESSION), { flush: () => deps.store.flush() });
        // The run's paid tool calls on the same cap (TOOL_SESSION): a call node's hold before its admission, and the paid
        // request it makes, as an agentic run's tool calls book (paidStep).
        paidTools = await run.tools(await sessions.open(TOOL_SESSION), { flush: () => deps.store.flush() });
        hooks.setPort(booking.models as never);
      },
      release: async () => {
        for (const proxy of proxies) await proxy.close().catch(() => undefined);
      },
    };
    return spec;
  };
}

/** The run's rule with a park on a refusal: `before` (runCap's one rule for the model session) is asked, and on a refusal
 *  the run parks through the loop's hook (parkOf decides room vs for good from the refusal), the same as the pi adapter's
 *  parkAtCap. It still returns the refusal, so the proxy refuses the request and the node's turn ends. */
export function parkOnRefusal(before: BeforeRequest, hooks: Pick<WorkflowHostHooks, "park" | "paused" | "pause">, flight: EffectsInFlight = { count: 0 }): BeforeRequest {
  const park = hooks.park;
  return async (request) => {
    // A person's pause in force parks the run here, before the request is sent, as a refusal does: the request is
    // refused unsent, and the resume's claim goes on from the journal (main's pause gate before each model call). Not
    // inside a call node's effect in flight (an `llm` call's request): the engine has admitted that effect, and one
    // parked unfinished is left unknown, which it will not resume (FROZEN_EFFECT_UNKNOWN); it finishes, and the pause
    // lands at the next effect's start or model node's request.
    if (hooks.paused() && flight.count === 0) {
      hooks.pause();
      return { refuse: PAUSED_WORDS, forGood: false } as Refusal;
    }
    const verdict = await before(request);
    // A refusal parks the run, as main's does, unless the request is a call node's (an `llm` call's) in flight: that
    // effect is admitted, and parked unfinished it would be left unknown; refused unsent, its call fails in the cap's
    // words instead (the net under the call's hold, holdAtEffects).
    if (verdict && "refuse" in verdict && flight.count === 0) {
      const refusal = verdict as Refusal;
      park({ message: refusal.refuse, forGood: refusal.forGood ?? true, ...(refusal.figures ? { figures: refusal.figures } : {}) });
    }
    return verdict;
  };
}

/** How many call nodes' effects are in flight (pauseAtEffects counts them; parkOnRefusal reads it). */
export interface EffectsInFlight { count: number }

/** `cap` with a person's pause before each call node's effect starts: applied outside the cap's own effect wrapper, which
 *  is outside the engine's recovery wrapper (the one that admits the effect, dsl recovery/driver.ts wrapEffect), so a
 *  paused call node is never admitted. A pause in force parks the run there (hooks.pause, which aborts the node's
 *  signal) and the effect waits on that signal, never called; the resume's claim runs it once. An effect that starts is
 *  counted in `flight` until it ends, so a model request it makes is not where a pause lands. */
export function pauseAtEffects(cap: WorkflowCap, hooks: Pick<WorkflowHostHooks, "paused" | "pause">, flight: EffectsInFlight): WorkflowCap {
  return {
    ...cap,
    effect: <F>(fn: F): F => {
      const inner = cap.effect(fn) as unknown as (params: { signal?: AbortSignal }) => Promise<unknown>;
      return (async (params: { signal?: AbortSignal }) => {
        if (hooks.paused()) {
          hooks.pause();
          const signal = params?.signal;
          if (signal && !signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw signal?.reason ?? new Error(PAUSED_WORDS);
        }
        flight.count += 1;
        try {
          return await inner(params);
        } finally {
          flight.count -= 1;
        }
      }) as unknown as F;
    },
  };
}

/** The proxies start before the booking is wired; their hooks forward to the booking set at harnessReady. A request before
 *  then would be a bug (no model request runs before the workflow does), so it refuses loudly. `park` is the loop's hook,
 *  set at build, which a cap refusal calls. */
function deferredHooks() {
  let port: { beforeRequest(r: unknown): Promise<unknown>; afterRequest(u: unknown, t?: unknown, e?: unknown): Promise<void>; responded?(ids: unknown, t?: unknown): Promise<void>; note?(m: string, r?: unknown): string | undefined } | undefined;
  let loop: WorkflowHostHooks | undefined;
  return {
    port: {
      beforeRequest: (request: never) => (port ?? missing()).beforeRequest(request),
      afterRequest: (usage: never, ticket?: never, ended?: never) => (port ?? missing()).afterRequest(usage, ticket, ended),
      responded: (ids: never, ticket?: never) => (port ?? missing()).responded?.(ids, ticket) ?? Promise.resolve(),
      note: (model: never, request?: never) => (port ?? missing()).note?.(model, request),
    },
    setPort: (p: typeof port) => { port = p; },
    park: (refusal: CapRefusal) => loop?.park(refusal),
    // A person's pause, asked where the cap is (the loop's hooks): none before the loop hands its hooks over.
    paused: (): boolean => loop?.paused() ?? false,
    pause: (): void => loop?.pause(),
    setPark: (hooks: WorkflowHostHooks) => { loop = hooks; },
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
/** What a call node's request may cost at most, judged before the engine admits it (holdAtEffects): a Parallel search's
 *  or extract's fee as paidRequest prices it (a fixed fee, what it may charge at most); an `llm` call's request at the
 *  cap's worst price for it (its model's tiered rates over an input bound of one token per UTF-8 byte of its prompt and
 *  system plus LLM_FRAMING_BYTES for the request's own framing, and the output it asks for, else its model's most);
 *  nothing for a call that pays no one (pdf_pages, a search the plane sends elsewhere). `pricing` and `bound` for `llm`:
 *  what its answer's own usage is priced at after (the net, holdAtEffects). */
export type CallHold = { readonly usd: number; readonly name: string; readonly basis: string; readonly llm?: { readonly price: CapModel["price"] } };
/** The request's own framing beside its prompt and system (its JSON, the model, its limits), in bytes: a bound. */
export const LLM_FRAMING_BYTES = 2_048;
/** The output an `llm` call that names none is sent asking for at most (port-models.ts sessionModel's maxTokens). */
export const LLM_DEFAULT_OUTPUT = 32_000;
const NO_HOLD = (tool: string): CallHold => ({ usd: 0, name: tool, basis: "nothing paid" });

export function callHoldOf(tool: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv, modelOfTier: (tier: string | undefined) => CapModel | undefined): CallHold {
  if (tool === "web_search" || tool === "web_fetch") {
    if (planeOf(env)[tool] !== "parallel") return NO_HOLD(tool);
    const fee = tool === "web_search" ? parallelSearchFee(searchArgs(input).n) : parallelExtractFee(1);
    return { usd: fee.usd, name: fee.name, basis: fee.basis };
  }
  if (tool === "llm") {
    const model = modelOfTier(typeof input.tier === "string" ? input.tier : undefined);
    if (!model?.price) return NO_HOLD(tool);
    const bytes = (text: unknown) => (typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0);
    const bound = bytes(input.prompt) + bytes(input.system) + LLM_FRAMING_BYTES;
    const output = typeof input.maxTokens === "number" ? input.maxTokens : Math.max(LLM_DEFAULT_OUTPUT, model.outputCeiling ?? 0);
    const usd = requestPrice(pricingOf(model.price), bound, undefined, Date.now(), "strict", model.id).worst(output);
    return { usd, name: `the ${model.id} answer`, basis: `${model.id}'s worst price for ${bound} input and ${output} output tokens`, llm: { price: model.price } };
  }
  return NO_HOLD(tool);
}

/** A call node's hold on the run's one ledger, taken before its effect is admitted (holdAtEffects): the effect's paid
 *  request takes it over (reservedBooking), and an `llm` call gives it back the moment its own request is held by the
 *  cap (the model booking's beforeRequest). */
type Reservation = { readonly id: string; readonly call: string; readonly hold: CallHold; readonly paid: RunTools; taken: boolean; settled: boolean };
const reservations = new AsyncLocalStorage<Reservation>();
const settleReservation = async (held: Reservation, usd: number | null): Promise<void> => {
  if (held.settled) return;
  held.settled = true;
  await held.paid.settle(held.id, usd).catch(() => undefined);
};

/** The run's one ledger as a call node's paid request books on it (Ledger.paid) under its call's reservation: its
 *  request is admitted on the hold taken before the call (never a second hold), and settled there at what it charged. A
 *  request priced above that hold is refused unsent (the net: a provider pricing above its own bound), in the cap's
 *  words; the call fails with it. */
function reservedBooking(held: Reservation): PaidBooking {
  return {
    admit: async (request) => {
      if (held.taken || request.holdUsd > held.hold.usd + 1e-12) {
        throw new CapRefused(`Not sent: ${request.name} would cost ${money(request.holdUsd)}, above the ${money(held.hold.usd)} this call held before it ran.`, { forGood: true, spentUsd: null });
      }
      held.taken = true;
      return undefined;
    },
    settle: async (_id, usd) => settleReservation(held, usd),
  };
}

/** `cap` with each call node's most cost held on the run's one ledger before the engine admits its effect: applied
 *  outside the cap's effect wrapper (and the engine's recovery wrapper, which admits it), as the pause is. A hold the cap
 *  refuses for room parks the run there (`hooks.park`, as a model request's refusal does) and the effect, never admitted,
 *  waits on the node's signal; one refused for good fails the call in the cap's words. Held, the effect runs with the
 *  hold as its reservation; what is not taken is given back at its end. After it, the net: a call whose answer cost more
 *  than its hold (an `llm` answer priced at its usage) fails in the cap's words. */
export function holdAtEffects(cap: WorkflowCap, deps: { readonly paid: () => RunTools | undefined; readonly holdOf: (tool: string, input: Record<string, unknown>) => CallHold; readonly park: (refusal: CapRefusal) => void }): WorkflowCap {
  let seq = 0;
  return {
    ...cap,
    effect: <F>(fn: F): F => {
      const inner = cap.effect(fn) as unknown as (params: unknown) => Promise<unknown>;
      return (async (params: { node: { label: string; tool?: string }; input: Record<string, unknown>; signal?: AbortSignal; executionPath?: string }) => {
        const tool = params.node.tool;
        const hold = tool ? deps.holdOf(tool, params.input ?? {}) : undefined;
        const paid = deps.paid();
        if (!hold || hold.usd <= 0 || !paid) return inner(params);
        const call = `${params.node.label}@${params.executionPath ?? ""}`;
        const id = `${call}#hold${(seq += 1)}`;
        try {
          await paid.admit({ id, name: hold.name, holdUsd: hold.usd, basis: hold.basis, call });
        } catch (error) {
          if (error instanceof CapRefused && !error.forGood) {
            deps.park({ message: error.message, forGood: false, ...(error.figures ? { figures: error.figures } : {}) });
            const signal = params.signal;
            if (signal && !signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            throw signal?.reason ?? error;
          }
          throw new EffectFailure(`call node "${params.node.label}": ${(error as Error)?.message ?? String(error)}`, null, { code: null });
        }
        const held: Reservation = { id, call, hold, paid, taken: false, settled: false };
        try {
          const value = await reservations.run(held, () => inner(params));
          // The net: an `llm` answer priced at its own usage above what was held for it.
          const usage = hold.llm?.price && value && typeof value === "object" ? (value as { usage?: { input_tokens?: number; output_tokens?: number } | null }).usage : undefined;
          if (usage && hold.llm?.price) {
            const charged = pricingOf(hold.llm.price)({ cached: 0, fresh: usage.input_tokens ?? 0 }, usage.output_tokens ?? 0);
            if (charged > hold.usd + 1e-12) throw new EffectFailure(`call node "${params.node.label}": its answer cost ${money(charged)}, above the ${money(hold.usd)} it held before it ran.`, null, { code: null });
          }
          return value;
        } finally {
          await settleReservation(held, held.taken ? null : 0);
        }
      }) as unknown as F;
    },
  };
}

/** The reservation of the call node this request runs under, given back as the request is judged on its own (an `llm`
 *  call's model request): its hold is the request's from here. */
export const releaseCallHold = async (): Promise<void> => {
  const held = reservations.getStore();
  if (held && !held.taken) await settleReservation(held, 0);
};

/** A call tool's permission now, as main's per-run process read it at each call node (app.ts:382-384, the gate's
 *  policy): the revision's tool settings and approvals over the server's, the server's read again from the store at each
 *  call, so a deny or an ask set while the run goes reaches its next call. A read that fails holds the last good one. */
type CallPolicy = (tool: string) => Promise<{ permission: "allow" | "ask" | "deny"; denyFrom: Parameters<typeof deniedText>[2] }>;
function callPolicyOf(store: Pick<Store, "settings">, runId: string, claimed: Claimed): CallPolicy {
  let current: Awaited<ReturnType<typeof loadToolSettings>> = { settings: {}, problems: [] } as never;
  const gate = runGate({ root: claimed.workRoot, work: claimed.workRoot }, runId, claimed.revision as never, () => current);
  return async (tool) => {
    try {
      current = await loadToolSettings(store);
    } catch {
      // Unread: the gate holds to its last good read.
    }
    return { permission: gate.policy(tool), denyFrom: gate.denyFrom(tool) };
  };
}

/** The environment a call node's effect runs with: the runner's run environment (never this process's whole one), with
 *  the run's tool plane (which provider each web tool resolves to), as a non-hand tool's ToolHost.env carries it. */
function callEnvOf(env: NodeJS.ProcessEnv, claimed: Claimed): NodeJS.ProcessEnv {
  return claimed.plane === undefined ? env : { ...env, [TOOL_PLANE_ENV]: JSON.stringify(claimed.plane) };
}

/** `cap` with a call node's recorded tool failure thrown as the node's failure, as main's `failing` (app.ts:417-420):
 *  the driver records the effect's outcome ({ TOOL_FAILED: words }) as its receipt, and this, past the driver, throws it
 *  as an EffectFailure in those words, so the call node fails and the run with it in the tool's words. Applied outside
 *  the cap's own effect wrapper, on the outcome it returns. */
export function failingEffects(cap: WorkflowCap): WorkflowCap {
  return {
    ...cap,
    effect: <F>(fn: F): F => {
      const inner = cap.effect(fn) as unknown as (params: unknown) => Promise<unknown>;
      return (async (params: unknown) => {
        const value = await inner(params);
        const failed = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[TOOL_FAILED] : undefined;
        if (typeof failed === "string") throw new EffectFailure(failed, null, { code: null });
        return value;
      }) as unknown as F;
    },
  };
}

function runEffectOf(claimed: Claimed, complete: ReturnType<typeof completer>, env: NodeJS.ProcessEnv, policy: CallPolicy, paidTools: () => RunTools | undefined): EffectRun extends never ? never : WorkflowHostDeps["runEffect"] {
  // An `llm` call gives its call's hold back as its own model request is judged (the cap holds that request itself).
  const completeHeld: typeof complete = async (args, signal) => {
    await releaseCallHold();
    return complete(args, signal);
  };
  return (async ({ node, input, signal, executionPath }: { node: { label: string; via: string; tool?: string }; input: Record<string, unknown>; signal: AbortSignal; executionPath?: string }) => {
    // The call's ledger: its paid request books on the run's one ledger, on the hold taken before the call (holdAtEffects)
    // when it has one. No pause: a refusal inside an admitted effect fails the call, never parks the run there.
    const held = reservations.getStore();
    const paid = paidTools();
    const ledger = held ? { call: held.call, record: async () => {}, paid: reservedBooking(held) } : paid ? { call: `${node.label}@${executionPath ?? ""}`, record: async () => {}, paid } : undefined;
    const effect = node.via === "tool" && node.tool ? toolOf(node.tool)?.effect : undefined;
    if (!effect) throw new Error(`call node "${node.label}": agentrun-serve runs no tool ${node.tool ?? `via ${node.via}`}`);
    // Its tool's permission now (main's app.ts:382-384): a deny set since the run started is refused in the gate's words,
    // and an ask too, since a call node cannot wait for an approval. Neither runs.
    try {
      const { permission, denyFrom } = await policy(node.tool!);
      if (permission === "deny") throw new Error(deniedText(node.tool!, undefined, denyFrom));
      if (permission === "ask") throw new Error(callNodeAskText(node.tool!));
      return await effect(input, { signal, env, work: claimed.workRoot, complete: completeHeld, ...(ledger ? { ledger } : {}) });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (signal.aborted || (error as Error)?.name === "AbortError") throw error;
      return { [TOOL_FAILED]: `call node "${node.label}": ${node.tool} failed: ${message.slice(0, 500)}` };
    }
  }) as never;
}

/** The end's cost and metrics: what every model request of the run cost (the booking) plus what its decisions and its
 *  call nodes' paid requests cost (the decision cap, the paid tools), one spend for the run. Unknown (no figure) once any
 *  part is unknown. */
async function endPatchOf(booking: Awaited<ReturnType<typeof modelPortFor>> | undefined, decisionCap: RunDecisions | undefined, paidTools: RunTools | undefined): Promise<Pick<EndData, "costUsd" | "metrics">> {
  if (!booking) return {};
  const model = booking.spentUsd();
  const decision = decisionCap ? decisionCap.spentUsd() : 0;
  const paid = paidTools ? paidTools.spentUsd() : 0;
  return model === null || decision === null || paid === null ? {} : { costUsd: model + decision + paid };
}

/** The run's one cap as a WorkflowCap: model nodes and call nodes pass through (their money is on the proxy), and a
 *  decision node is admitted and settled through the run's decisions (`getCap`, wired at harnessReady), priced as main
 *  holds it. The reference is deferred because the cap is not built until the Harness opens. */
function decisionWorkflowCap(getCap: () => RunDecisions | undefined, providers: DecisionProviders, hooks: Pick<WorkflowHostHooks, "park" | "paused" | "pause">): WorkflowCap {
  return { node: (fn) => fn, effect: (fn) => fn, judge: <F>(fn: F, driver?: DecisionDriver): F => decisionJudge(fn, { getCap, providers, park: hooks.park, hooks, driver }) };
}

/** A decision wrapped over the DSL driver's judge (the host's `recovered.runJudge`): it prices the request as main does
 *  (holdOf), admits it through the kernel cap before the driver sends it, asks the driver's judge, and settles the hold at
 *  what the answer charged (its hold when it reports none, the way `charged:held` books it). A refusal for room parks the
 *  run through the loop's hook (as a model node's does); a refusal for no price fails it; a price the catalog could not
 *  read fails the decision node as a connection error, never the cap's stop. A request the driver answers from what it
 *  decided before (a route's, or one an earlier process admitted that did not fail) holds nothing (askedBefore). */
function decisionJudge<F>(inner: F, deps: { getCap: () => RunDecisions | undefined; providers: DecisionProviders; park: (refusal: CapRefusal) => void; hooks?: Pick<WorkflowHostHooks, "paused" | "pause">; driver?: DecisionDriver }): F {
  const judge = inner as (params: JudgeParams) => Promise<JudgeResult>;
  return (async (params: JudgeParams) => {
    if (deps.driver && askedBefore(deps.driver, params)) return judge(params);
    // A person's pause in force parks the run before a new decision is held or sent, as a refusal for room does.
    if (deps.hooks?.paused()) {
      deps.hooks.pause();
      throw new Error(PAUSED_WORDS);
    }
    const id = params.provider ?? deps.providers.default;
    const provider = Object.hasOwn(deps.providers.providers, id) ? deps.providers.providers[id] : undefined;
    // A provider the host lacks is refused by the judge itself (configuration), before anything is held.
    if (!provider) return judge(params);
    const cap = deps.getCap();
    // The cap is wired at harnessReady, before any node runs; a decision reaching here without it is a bug.
    if (!cap) throw new Error(`decision "${params.label}": the run's decision cap was not wired before the workflow ran`);
    const request = await decisionRequestOf(provider, params);
    try {
      await cap.admit(request);
    } catch (error) {
      // A refusal the cap read: for room the run parks (a raise sends it), for no price it fails; both through the loop's
      // hook, as a model node's refusal does. A price the catalog could not read fails the decision node, never the cap.
      if (error instanceof CapRefused) { deps.park({ message: error.message, forGood: error.forGood, ...(error.figures ? { figures: error.figures } : {}) }); throw error; }
      throw error; // DecisionPriceUnreadable, or anything else: the decision node's own failure.
    }
    try {
      const result = await judge(params);
      await cap.settle(request.id, { end: "charged", usd: finiteUsd(result?.cost_usd) });
      return result;
    } catch (error) {
      // Sent and maybe billed (its outcome lost, its answer rejected): at what it was charged, else at its hold (null).
      // One its provider refused unbilled, or that never left, charged nothing: booked at $0 so no later process counts it.
      const charged = chargedCost(error);
      await cap.settle(request.id, { end: "charged", usd: charged !== undefined ? charged : unbilled(error) ? 0 : null });
      throw error;
    }
  }) as F;
}

/** A decision's request for the kernel cap, priced as main holds it (serve decision-cap.ts holdOf): Parallel's list price
 *  for one request; Jev's published per-input-token price; an OpenRouter Decisions model at its catalog price (per request,
 *  per image, per token), "unreadable" when the catalog could not be read, a null-priced `price: null` (refused as no
 *  price). Its input is its state and questions' UTF-8 bytes, one token a byte (the kernel adds each image's tokens). */
async function decisionRequestOf(provider: DecisionProvider, params: JudgeParams): Promise<DecisionCapRequest> {
  const id = params.decisionId ?? `decision:${params.executionPath ?? ""}:${params.label}${params.item ? `:${params.item.index}` : ""}`;
  const inputTokens = Buffer.byteLength(JSON.stringify({ state: params.state ?? null, questions: params.questions }), "utf8");
  const questions = Object.keys(params.questions).length;
  const images = Object.keys(params.images ?? {}).length;
  const base = { kind: "decision" as const, id, inputTokens, questions, images };
  if (provider.id === "parallel") return { ...base, model: openrouterModel("parallel", null, null), requestUsd: PARALLEL_DECISION_USD };
  if (provider.id === "jev") return { ...base, model: { id: "jev", api: "openrouter", price: { input: JEV_INPUT_USD * 1e6, output: 0 }, outputCeiling: null } };
  const priced = provider as DecisionProvider & { priceOf?(model: string): Promise<DecisionModelPrice | null> };
  const model = params.model;
  // A request that names no model: its provider refuses it before it is sent, so there is nothing to hold ($0).
  if (typeof priced.priceOf === "function" && model === undefined) return { ...base, model: openrouterModel(provider.id, null, null) };
  if (typeof priced.priceOf !== "function" || model === undefined) return { ...base, model: openrouterModel(model ?? provider.id, null, null) };
  let price: DecisionModelPrice | null;
  try {
    price = await priced.priceOf(model);
  } catch {
    // The catalog could not be read: the decision fails unsent as a connection error, never the cap's stop (asModel throws
    // DecisionPriceUnreadable for "unreadable").
    return { ...base, model: "unreadable" };
  }
  if (!price) return { ...base, model: openrouterModel(model, null, null) };
  return { ...base, model: openrouterModel(model, { input: price.promptUsd * 1e6, output: price.completionUsd * 1e6 }, price.maxCompletionTokens), requestUsd: price.requestUsd, imageUsd: price.imageUsd };
}

/** An OpenRouter-API model as the kernel cap prices it: a null price is refused as having no price. */
const openrouterModel = (id: string, price: { input: number; output: number } | null, outputCeiling: number | null): CapModel => ({ id, api: "openrouter", price, outputCeiling });

/** A finite, non-negative cost, else null (the answer reported none): settled so, the hold books (`charged:held`). */
const finiteUsd = (usd: unknown): number | null => (typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : null);

/** A provider failure that says the request was never billed (main's `unbilled`): booked at $0. */
const UNBILLED = new Set(["configuration", "auth", "invalid_request", "rate_limited", "connection"]);
const unbilled = (error: unknown): boolean => error instanceof DecisionProviderError && (error.unsent === true || UNBILLED.has(error.code));

/** The tiers the workflow's model nodes run on (model.ts): the llm tiers over its nodes, read as toolsOf reads them (its
 *  inspection's node paths), else the default. */
function tiersOf(workflow: Workflow): Tier[] {
  const nodes = workflowNodes(workflow, inspectWorkflow(workflow));
  const tiers = llmTiers(nodes, nodeTiers(nodes));
  return tiers.length ? tiers : ["default"];
}

/** The tools the workflow may call, for the host to register. */
/** The tool names a workflow's model node offers its model: the node's `submit` (pi's SUBMIT_TOOL) and every tool the
 *  workflow's model nodes name. */
export function nodeOffer(workflow: Workflow): string[] {
  return [...new Set([SUBMIT_TOOL, ...workflowTools(workflowNodes(workflow, inspectWorkflow(workflow))).nodes])];
}

function toolsOf(workflow: Workflow): string[] {
  // A call node's tool, as main's per-run process registers it (app.ts:490, the workflow's own): the call tools the
  // workflow names (tools.ts CALL_TOOLS); any other was refused at its start (runnable.ts).
  return workflowTools(workflowNodes(workflow, inspectWorkflow(workflow))).calls.filter((name) => CALL_TOOLS.includes(name));
}

const providerId = (tier: Tier): string => `workflow-session-${tier}`;

/** The run's revision, launch and work folder, read at the claim. */
async function readClaim(deps: WorkflowSpecDeps, runId: string): Promise<Claimed> {
  const run = await deps.store.runs.get(runId);
  if (!run) throw new Error(`the store has no run ${runId}`);
  const revision = await deps.store.agents.revision(run.revisionId);
  if (!revision || revision.kind !== "workflow") throw new Error(`run ${runId} is not a workflow run`);
  const launchRow = await deps.store.runs.launch(runId);
  const launch = launchRow.body as { input?: unknown; max_cost_usd?: unknown; cap_mode?: unknown; documents?: unknown; plane?: unknown } | null;
  const input = launch && typeof launch.input === "object" && launch.input !== null ? (launch.input as Record<string, unknown>) : {};
  const capUsd = typeof launch?.max_cost_usd === "number" ? launch.max_cost_usd : undefined;
  const mode: CapMode = launch?.cap_mode === "strict" ? "strict" : "expected";
  const workRoot = typeof launch?.documents === "string" ? launch.documents : "/tmp";
  return { agentId: run.agentId, revisionId: run.revisionId, revision: revision as unknown as Revision, workflow: (revision.body as { workflow: Workflow }).workflow, input, capUsd, mode, workRoot, plane: (launch?.plane as RunLaunch["plane"]) };
}

export { BACKGROUND_CONTEXT };
