// The runner's pi spec (design 2.1: "the runner takes every run"). What app.ts built for a run it launched — the run's
// workspace, its computer, its tools, its model route, its spend cap and its end metrics — built here instead, from the
// run's launch record and its revision, and handed to the kernel's adapter loop (adapter-loop.ts) as one AdapterRunSpec.
// The dispatch switch (dispatch.ts resolve) runs a pi run on `createAdapterLoop((claim, run) =>
// adapterRunSpecFromLaunch(launch, run, deps, claim, runner))`, and so does a harness a module adds with no adapter facts
// of its own: the session's adapter is the run's runner's (RunnerHarness.adapter), pi's for a pi run.
//
// The one ledger (B2c): pi's model requests go through the session's proxy, booked by the runner's booking under the
// run's cap; the cap prices a request as main's calculateCost does (tiers included), on the hold and the booking. The
// tools are the kernel registry's hands on the run's Workspace (runTools), and — once built through the ToolHost below —
// tools.ts's full set (browser, web, MCP, decisions, monid) by their own names. The gate before a call's intent is the
// run's revision's tool settings, read through runGate (approvals "never" among them), the adapter loop asking it.
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { stopRunWith } from "../paid-calls.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, type Extension, ROOT_CONVERSATION_ID, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CapModel, type CapRefused, checkRaise, followUpOf, freeRequestLimitOf, maxRequestsOf, parkOf, planCapModel } from "@parcha/agentrun-kernel/kernel/cap";
import { inspectWorkflow, type Workflow } from "@parcha/agentrun-dsl";
import type { AdapterFacts, BeforeRequest, HostTool, NestedCalls, Refusal, SessionSpec, Wire } from "@parcha/agentrun-kernel";
import { factsOf } from "../harness-table.js";
import { decisionProvidersIn } from "../decisions.js";
import type { Approvals } from "../approvals.js";
import type { installForClaim, installSettled } from "../harness-install.js";
import type { LiveHandover, LiveViewerStore } from "../browser-live.js";
import { dropLiveViewer, putLiveViewer } from "../browser-live.js";
import { liveForRun, type RunnerLive, runnerLiveOf } from "../live-reach.js";
import { llmTiers, type ModelRef, nodeTiers, type PinnedModel, type Tier, thinkingLevel, TIERS, tierModelOf, workflowNodes } from "../model.js";
import { heldRefusedProvider } from "../provider.js";
import { firstMessage, inputMessage, messageText } from "../run-manifest.js";
import { learningStartOf, seedFailed, type RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { isWebHostTool } from "../tool-list.js";
import { type ArgumentsOf, deniedText, noApproverText, type Permission, type RunFiles, runGate, type SettingFrom, type ToolEffect } from "../tool-gate.js";
import { DECISION_PROVIDER_KEYS, loadToolSettings, recheckPlane, TOOL_PLANE_ENV } from "../tool-plane.js";
import { readApprovers } from "../server-approvers.js";
import { ASK_TOOL, askPerson, type EmailFake, type ToolEntry, type ToolHost, toolOf, webAnswerCut } from "../tools.js";
import type { SaveSlots } from "../web-save.js";
import type { WebFake } from "../web-fake.js";
import { type HostToolCtx, hostToolOf, RUNS_ONCE } from "../host-tools.js";
import { WEB_FETCH_TOOL } from "../web-fetch.js";
import { WEB_SEARCH_TOOL } from "../web-search.js";
import { environmentLine, runZone } from "../environment.js";
import { effortGuidance } from "../effort-guidance.js";
import { outputContract } from "../answer-json.js";
import { laidLearned, type LearnedWorkflow, secretsShown } from "../learning.js";
import { laidOf, layLearningSeed } from "./learning-seed.js";
import { learningEndOfRun, spentBesideOf } from "./learning-end.js";
import { type LearnedAction, learnedAskShown, LEARNED_WORKFLOW_TOOL, learnedMcpCalls, learnedWorkflowTool } from "../learned-workflow.js";
import { PORT_PROVIDER, tieredModels, tierProvider } from "../port-models.js";
import { promptOf, readsFiles } from "../skills.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { withoutKindSkill } from "../workspace/kind-skills.js";
import { layOwnSkills } from "../workspace/revision-skills.js";
import { COMPUTER_ROOT, recordingsFolder, runFolder, scratchFolder } from "../workspace/paths.js";
import { runTools, type ToolResults, withKindTools } from "../workspace/run-tools.js";
import { filesToCopy, placeRunInputs } from "../uploads.js";
import { handedSignInReadsBack, signInReads } from "../sign-ins-store.js";
import { UNREADABLE_SIGN_IN } from "../run-view.js";
import { durableWait } from "../workflow/pi-versions.js";
import { type ClaimModelKey, claimModelEnv, claimModelKey, claimSecrets, claimSpendOff, holdRunKey, keyedAtClaim, keyedNow, hostDecisionKeys, learnedDecisionKeys, type PlanHandBack, subagentTierKeys, tierModelKeys, underClaimed, withoutModelKeys } from "./claim-secrets.js";
import { atRunEnd } from "../learning-work.js";
import { compareEndOfRun, GRADER, withGrader } from "./compare-end.js";
import { agreeOnOf } from "../learning-setting.js";
import { catalogSessionNames, claimMetering, type ClaimMcp, mcpWhereHeld } from "./mcp-run.js";
import { held as runnerSeam, heldOrThrow, heldSignInReads } from "./held.js";
import { type AdapterLoopOptions, type AdapterRun, type AdapterRunSpec, hostLifecycle, type RunCapConfig } from "./adapter-loop.js";
import { RUNNER_HARNESSES, type RunnerHarness } from "./adapters/index.js";
import { DEFAULT_HARNESS } from "../harness.js";
import { agentEntriesOf, type BoundTimer } from "./loop.js";
import { routedSubagentTiers, SUBAGENT_TOOL, type SubagentTier, subagentTool } from "./subagent.js";
import { type Claim, ClaimRefused, type Journal } from "./loop-contract.js";
import { bookedSpend, cliRunMetrics, costBasisOf, endCostOf, runCostOf, runMetrics } from "./metrics.js";
import { journalEntries } from "./journal-reader.js";
import { hashedMcpOf, piShaped } from "../store-reads/journal.js";
import { replayCallsOver } from "./promotion.js";
import { type LearnedFirst, learnedFirstWhereHeld } from "./learned-first.js";
import type { ReplayCalls } from "../learn/replay-calls.js";
import { servedOf, workflowDigest } from "./workflow-first.js";
import { AUDIT_PARKED, withAudit } from "./audit.js";
import { runPathMetricsOverStore } from "../store-reads/learning.js";
import { type SpecHolds, specBuilt } from "./spec-holds.js";
import type { ModelRoute, RouteCost } from "./model-route.js";
import { archilClaim, archilWhereHeld, type ArchilClaimOptions, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { loadArchilSettings, noExecRegionOf } from "../archil-settings.js";
import { settingOfDefinition } from "../computer-setting.js";
import { type claimComputer, type ComputerDeps, computerFilesNote, computerKeptWords, computerReadyWords, computerReplacedNote, computerStartingWords, imageWaitWords } from "../workspace/computer-deps.js";
import type { RunComputer } from "../workspace/run-tools.js";
import { computerTurnedOff, hadComputer, recordComputerOff, type RunComputerHold } from "./computer-journal.js";
import type { KeptKind, MadeKind, Replaced } from "../workspace/computer-for-claim.js";
import type { ShellPlace } from "../workspace/resolve-computer.js";
import type { Workspace } from "../workspace/workspace.js";
import { type HeldRedact, holdClaimed, mustHold, type Redact, runnerSecrets } from "./redact.js";
import { planBeforeRun, PLAN_PROVIDER } from "../chatgpt-plan.js";
import { heldSpecOf } from "./held-run.js";
import { loopComputerOf } from "./computer-channel.js";
import { githubAppAccess } from "./github-app.js";
import { type Checkout, checkoutWhereNoExec, prCheckoutForClaim } from "./pr-checkout.js";
import type { AgenticBody } from "../store/agent-body.js";
import { holdStored, storeSecrets } from "./store-secrets.js";
import { bashPolicyOf } from "../bash-read-only.js";
import { monidForClaim, type MonidFake, withMonid } from "./monid-run.js";
import { verifyPlacedProject, movedSkillFiles } from "../source-sync/claim.js";
import { projectCheckpointForRun } from "./project-checkpoint.js";
import { sourceAuxiliaryAdmitter } from "../source-sync/auxiliary.js";
import { agentOfRun, routeTrace } from "../otel/genai.js";

/** What a claim gives the shared computerForClaim: the run, its epoch, the claim itself (a live view's row is fenced on it
 *  and names its runner), its revision, its place and any computer choice. */
export interface ClaimLaunch {
  readonly runId: string;
  readonly epoch: number;
  readonly claim?: unknown;
  readonly revisionId: string;
  readonly place?: unknown;
  readonly computer?: unknown;
}
/** What the spec gives computerForClaim of its own: the run's mode, its Workspace and the runner's seal key (the runner
 *  gives the rest once, `computerDeps`). */
export interface ClaimDeps {
  readonly mode: 1 | 2;
  readonly workspace: Workspace;
  readonly sealKey: Buffer | undefined;
  readonly signal?: AbortSignal;
}
/** The run's computer at the claim: none for a runner place; its release, after the run's tools' end. A computer that
 *  cannot be had throws (computer_unavailable). */
export interface ClaimComputer {
  readonly computer?: RunComputer;
  readonly hold?: unknown;
  /** The run's desktop or phone and the person's hold on it: the spec's `computer` (AdapterRunSpec.computer). */
  readonly held?: RunComputerHold;
  /** It replaced an earlier claim's computer (computer-for-claim.ts Replaced). */
  readonly replaced?: Replaced;
  /** The claim made it the run's own, of this kind (computer-for-claim.ts ClaimComputer.made). */
  readonly made?: MadeKind;
  /** The kind of computer a park of the run keeps (computer-for-claim.ts ClaimComputer.keeps). */
  readonly keeps?: KeptKind;
  release(): Promise<void>;
  /** The release at the run's park, which keeps the computer it `keeps` (computer-for-claim.ts ClaimComputer.park). */
  park?(): Promise<boolean>;
  /** The park's keep written before the run's timeline says it (computer-for-claim.ts ClaimComputer.keepRow). */
  keepRow?(): Promise<boolean>;
}
/** The one shared claim-time computer every spec takes (computer-for-claim.ts), passed in by the runner: the composer's
 *  (workspace/computer-deps.ts computerDepsFrom), or a test's stand-in. */
export type ComputerForClaim = typeof claimComputer;

/** The wires pi speaks on the runner: main's pi's (provider.ts), Anthropic's Messages and OpenAI's Responses. */
export const PI_WIRES: readonly Wire[] = Object.freeze(["anthropic-messages", "openai-responses"]);

/** The browser's catalog name (tools.ts TOOLS.browser). */
export const BROWSER_TOOL = "browser";
/** Whether the runner offers the browser at all: on pi's native route (PiAdapterOptions.extensions), where pi-browser's
 *  durable extension runs in the claim's Harness, its tools pi's own tool tasks (their memo, task and conversations); on
 *  another harness, its extension in the same Harness and its tools host tools (browserHostTools). */
export const BROWSER_ON_RUNNER = true;
/** Whether the runner installs the browser for a run whose revision grants `granted`, or whose computer is a browser
 *  (host.browserComputer), fail closed: only where the runner offers it (BROWSER_ON_RUNNER), and only with the run's
 *  ledger booking on its ToolHost (host.ledger.paid), so no browser call is held on this process's own spend. */
export const browserListed = (host: Pick<ToolHost, "ledger" | "browserComputer">, granted: readonly string[]): boolean =>
  BROWSER_ON_RUNNER && host.ledger?.paid !== undefined && (granted.includes(BROWSER_TOOL) || host.browserComputer !== undefined);

/** What the runner hands the spec builder, beside the claim and the loop's own Harness (the AdapterRun): the store (its
 *  agent and run reads, and the live-viewer seam the browser tool writes through), the data directory a Mode 1 run folder
 *  sits in, the model route, and the key the live-viewer tokens are sealed under. One per runner, not per claim. */
export interface AdapterSpecDeps {
  /** The run's environment: the runner's, without the server's token (as the old per-run process read it). */
  readonly env: NodeJS.ProcessEnv;
  /** The data directory (--data): a Mode 1 run's folder sits under it (workspace/paths runFolder). */
  readonly data: string;
  /** The run's journal for this claim (store.journal): read at the run's end for its metrics (same journal the loop holds). */
  readonly journal: (claim: Claim) => Journal;
  /** The one store: `runs` and `agents` for the run's revision, and the live-viewer seam for the browser tool. */
  readonly store: Store & LiveViewerStore;
  /** The plane the claim's runner capped (run-child-host.ts, by underServerCeilings) and chose the run's keys by, handed to
   *  the run's own process (run-child.ts): taken as it is there, never capped again on settings read later, so the run's
   *  tools and the keys it was handed are of one reading. Absent: the claim caps its launch itself. */
  readonly claimedPlane?: RunLaunch["plane"];
  /** The key the store's sealed values are opened under (store/seal.ts): the runner's. Undefined in a run's own process
   *  (run-child.ts), which never holds it: what a claim opens with it is asked of the runner there (held.ts). */
  readonly sealKey: Buffer | undefined;
  /** The run's model route (model-route.ts routeOf), the one route the pi adapter and the cap read, on a wire of `wires`
   *  (the caller's; pi speaks both of main's, PI_WIRES). */
  readonly routeOf: (model: string | PinnedModel | undefined, env: NodeJS.ProcessEnv, tier?: Tier, wires?: readonly Wire[], upstream?: typeof fetch, redact?: (text: string) => string) => Promise<ModelRoute>;
  /** The run's log line (what its Workspace and computer have to say that is not a run failure). */
  readonly log?: (message: string) => void;
  /** For tests: a learning run's grade bound, as a signal (learning-dispatch.ts gradeBound). Default: GRADE_TIMEOUT_MS. */
  readonly gradeBound?: () => AbortSignal;
  /** For tests: the timer a native or SDK run's end arms its bound on (END_PATCH_MS, loop.ts) while it waits on its cost
   *  and metrics read, as the adapter loop's spec.endPatchTimer. Default: the real one (REAL_TIMER). */
  readonly endPatchTimer?: BoundTimer;
  /** The one shared claim-time computer (computer-for-claim.ts), for both the pi and the CLI spec: none for a runner place.
   *  The runner gives it; a test gives its own. */
  readonly computerForClaim: ComputerForClaim;
  /** What the runner gives computerForClaim once (its kind registry, provider makers, computer spec, keys and settings). */
  readonly computerDeps: ComputerDeps;
  /** A Mode 2 claim's Archil disk (a test's fake); absent, the real disk the Archil settings name. */
  readonly makeArchilDisk?: ArchilClaimOptions["makeDisk"];
  /** Archil's control plane, for a test's loopback fake (archilControlFake): its base URL and the fetch to call it with,
   *  the claim's control (where the run's disk is read and its mount credential minted). Absent, the region's own. No
   *  test ever reaches the real Archil control plane. */
  readonly mountControl?: { readonly baseUrl?: string; readonly fetch?: typeof fetch };
  /** How a CLI run's claim waits for its harness's first-use install (harness-install.ts installSettled); a test wraps it
   *  to see the claim reach the wait. Absent, installSettled itself. */
  readonly installSettled?: typeof installSettled;
  /** How a CLI run's claim installs its harness when nothing installs it (harness-install.ts installForClaim); a test gives
   *  its own, so none reaches npm. Absent, installForClaim itself. */
  readonly installForClaim?: typeof installForClaim;
  /** For tests only: the lock a claim's first-use install of each harness installs by (harness-install.ts installForClaim),
   *  by harness, as the server's own option of that name gives its installs. The CLI's runner never sets it, and no
   *  environment variable, flag or setting maps onto it; absent, the lock AgentRun ships. */
  readonly harnessLocks?: Readonly<Record<string, string>>;
  /** A test runner's fake GitHub API, where the GitHub App's installation tokens are minted (runner/github-app.ts). Absent,
   *  https://api.github.com: the CLI's runner never sets it, and no environment variable, flag or setting maps onto it. */
  readonly githubApi?: string;
  /** A test runner's GitHub site, where a run's pull request is checked out from (pr-checkout.ts): a folder of bare
   *  repositories, or a git server on loopback. Absent, https://github.com; nothing kept, no environment variable and no
   *  flag reaches it. */
  readonly githubWeb?: string;
  /** A test runner's fake GitHub MCP origin, the one a github_app server may be at (mcp-claim.ts githubMcpOrigin):
   *  for tests only: no environment variable, flag or setting maps onto it; absent, GitHub's hosted MCP (github.ts GITHUB_MCP_ORIGIN). Only a test's in-process runner sets it; the CLI's runner never does. */
  readonly githubMcpOrigin?: string;
  /** A test runner's fake Composio MCP origin, the one a key read from the environment is sent to (mcp-claim.ts
   *  composioMcpOrigin): for tests only, as githubMcpOrigin; absent, Composio's (composio-made.ts COMPOSIO_ORIGIN). */
  readonly composioMcpOrigin?: string;
  /** Whether this runner's runs may reach an MCP server whose URL is on loopback: only a runner beside a local-install
   *  server (runner/beside.ts, Serve.localInstall) is told so, by that server in its own process. Absent, never: a hosted
   *  or standalone runner's loopback is its host's other services. */
  readonly mcpLoopback?: boolean;
  /** That server's own addresses (Serve.own: where it listens, and its public address on loopback), told with
   *  mcpLoopback: a run's loopback request (an MCP server's, its authorization server's, a pin's listing, calendar_events') never goes to
   *  their ports, as the server's own requests never do. */
  readonly mcpOwn?: readonly string[];
  /** More own addresses, read at each claim beside mcpOwn: a standalone runner's (runner/main.ts runnerLoop), the ones
   *  the server kept in the store at its last start (mcp-private-hosts.ts serverOwn), so a server on any port stays
   *  refused. Read only when mcpLoopback is set. */
  readonly mcpOwnOf?: () => Promise<readonly string[]>;
  /** A template eval's fakes, by the agent a run is of (template-eval.ts, from its case: EvalFakes). Only the eval's own
   *  runner, in the eval's process, is given it (runner/beside.ts); no environment variable, flag, setting or API field
   *  maps onto it. Absent, or undefined for a run: none. */
  readonly evalFakes?: (agentId: string) => EvalFakes | undefined;
  /** For tests only: the adapter loop's model retry (adapter-loop.ts retry and stream), so a test whose provider fails a run
   *  on purpose does not wait out MODEL_RETRY's two and a half minutes. No environment variable, flag or setting maps onto
   *  it; absent, MODEL_RETRY and MODEL_STREAM. */
  readonly modelRetry?: Pick<AdapterLoopOptions, "retry" | "stream">;
  /** The runs' GenAI tracing (AdapterLoopOptions.tracing): in a run's own process, the one posted to its runner
   *  (run-child.ts); absent, this process's own. */
  readonly tracing?: AdapterLoopOptions["tracing"];
  /** web_save's download slots (ToolHost.saveSlots): in a run's own process, its runner's (run-child.ts). */
  readonly saveSlots?: SaveSlots;
}

/** One run's template eval fakes (template-eval.ts, from its case). `web`: its web_search, web_fetch and web_save answer from the
 *  case, and its harness's own search is never offered (web-fake.ts, fakedPlane). `now`: its clock, the date and time it
 *  is told wherever it reads "now" (environment.ts environmentLine, claude-agent's turn date); absent, the real clock.
 *  `monid`: its monid endpoints answer as monid unreachable does, never sent (monid-run.ts monidForClaim). `email`: the
 *  case's fake mail account's servers (eval-mailbox.ts), the only account its email tools open (email/tools.ts). `files`:
 *  the case's files, by their path in the run's work folder, written there at its claim (seedEvalFiles). */
export type EvalFakes = { readonly web?: WebFake; readonly now?: Date; readonly monid?: MonidFake; readonly email?: EmailFake; readonly files?: Readonly<Record<string, string>> };

/** A template eval case's files (EvalFakes.files) written into the run's work folder at its claim, after its inputs and
 *  before its computer and its first turn, so they reach a computer's /workspace as its uploads do. Each one the folder
 *  does not hold yet: a claim that resumes the run keeps what the run made of it. A write that fails ends the run failed,
 *  saying which file. */
export async function seedEvalFiles(workspace: Workspace, files: Readonly<Record<string, string>> | undefined): Promise<void> {
  for (const [path, text] of Object.entries(files ?? {})) {
    if (await workspace.stat(path)) continue;
    try {
      await workspace.write(path, text);
    } catch (error) {
      throw new Error(`The eval case's file ${path} could not be written in the run's work folder: ${(error as Error).message}`, { cause: error });
    }
  }
}

/** A model as the cap prices it, from the route's catalog cost: its price WITH TIERS (the money rule — a request past a
 *  model's tier is held and booked at the tier, as main's calculateCost does). `api` is the proxy's shape, for the
 *  overhead its provider adds; the output ceiling is the route's when it carries one, else none. */
export function capModelOf(route: ModelRoute): CapModel {
  // A ChatGPT plan's route is billed to the plan: the one plan rule (planCapModel), a CLI's plan model's too.
  if (route.provider.plan) return planCapModel(route.model, route.provider.api, route.outputCeiling ?? null);
  // A model serve has no price for carries placeholder zeros: the cap reads it as unknown (null), never as $0.
  const cost: RouteCost | undefined = route.unpriced ? undefined : route.cost;
  const price = cost
    ? {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
        ...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ inputTokensAbove: tier.inputTokensAbove, input: tier.input, output: tier.output, cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite })) } : {}),
      }
    : null;
  // The cap reads a request's provider overhead by the route's own wire (providerInputOverhead).
  return { id: route.model, api: route.provider.api, price, outputCeiling: route.outputCeiling ?? null, ...(route.local ? { local: true } : {}) };
}

/** The model of a held run its model kept from running at its create (run-launch.ts hold.refused): as its revision names
 *  it (`provider/model-id`). Its launch pins none (runs-over-store.ts skips modelOf for it). Nothing chooses it and
 *  nothing prices it. */
export function heldModelOf(ref: string | undefined): ModelRef {
  const at = ref?.indexOf("/") ?? -1;
  return ref && at > 0 ? { provider: ref.slice(0, at), modelId: ref.slice(at + 1) } : { provider: "none", modelId: ref ?? "none" };
}

/** The route of a held run its model kept from running at its create (run-launch.ts hold.refused): its provider is the
 *  stand-in (provider.ts heldRefusedProvider), so a host with no key for its model still opens its claim and holds its
 *  computer. Its agent never starts (its start and every message are refused in `why`, its create's words:
 *  computer-held.ts), and a request that reached its proxy anyway is refused in them too, and never sent. */
export function heldRefusedRoute(model: ModelRef, why: string): ModelRoute {
  const { origin, credential } = heldRefusedProvider(model, why);
  return { model: model.modelId, named: `${model.provider}/${model.modelId}`, provider: { api: "anthropic-messages", origin, credential }, price: () => null, unpriced: true, outputCeiling: null };
}

/** Particle requests are never automatically replayed after an uncertain failure. Retry is a harness-wide setting,
 *  so a claim with any Particle route disables it for all its conversations, including subagents on other tiers. */
export function modelRetryOf(routes: Iterable<Pick<ModelRoute, "like">>): Pick<AdapterRunSpec, "retry"> {
  return [...routes].some((route) => route.like?.translatedChatCompletions) ? { retry: { enabled: false } } : {};
}

/** The key of a subagent tier's route in a run's tier routes and proxies (a key of its own, never a learned workflow's
 *  tier: those nodes keep their own route and fallback). */
const SUBAGENT_ROUTE = "subagent-";
const subagentRoute = (tier: SubagentTier): string => `${SUBAGENT_ROUTE}${tier}`;
const isSubagentRoute = (key: string): boolean => key.startsWith(SUBAGENT_ROUTE);

/** A model route as the run's GenAI trace names it: its provider, the host its requests go to, its model. A route that
 *  translates its model's requests (its own `fetch`) is named by its upstream's host (ModelRoute.upstreamOrigin), never
 *  its proxy's placeholder origin; one whose upstream is unknown names no host. */
export const traceOfRoute = (route: ModelRoute) => {
  const origin = route.fetch ? route.upstreamOrigin : route.provider.origin;
  return routeTrace({ ...(route.named ? { named: route.named } : {}), ...(origin ? { origin } : {}), model: route.model });
};

/** A replay run's or an audit shadow's grader route (runner/compare-end.ts): on the fast tier routedSubagentTiers names
 *  (the revision's modelTiers.fast, else AGENT_MODEL_FAST), on pi's wires, when its revision names no agree_on. Its route
 *  reads the saved key of that tier's model alone (subagentTierKeys), held by the run's redactors, on the route's env
 *  alone; in a run's own process its runner hands it that tier's model's key (run-child-host.ts subagentTierKeys). A run
 *  with its own model key carries that key, and no saved key is read. Undefined, with nothing read, when
 *  there is no fast tier or the revision names agree_on; undefined when no route can be made (logged: the pair is then
 *  compared whole). */
export async function graderRouteOf(
  body: { readonly modelTiers?: Readonly<Partial<Record<SubagentTier, string>>>; readonly learning?: unknown },
  keyed: boolean,
  runKey: ClaimModelKey | undefined,
  claimed: NodeJS.ProcessEnv,
  cut: HeldRedact,
  log: (line: string) => void,
  deps: Pick<AdapterSpecDeps, "store" | "sealKey" | "env" | "routeOf"> & PlanHandBack,
  holds: readonly HeldRedact[] = [cut],
  claim?: Pick<Claim, "runId" | "turn" | "attempt">,
): Promise<ModelRoute | undefined> {
  if (agreeOnOf(body.learning)?.length) return undefined;
  const { tiers, refs } = routedSubagentTiers(body, deps.env ?? {});
  if (!tiers.includes("fast")) return undefined;
  const savedKeys = keyed ? {} : await subagentTierKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env, handBack: deps.handBack, signal: deps.signal }, ["fast"], refs);
  for (const redact of new Set(holds)) holdClaimed(redact, savedKeys);
  // The claim's run, turn and attempt on its grader's requests too (request-metadata.ts): they spend on the run's cap.
  const env = claimModelEnv(deps.env, [claimed, savedKeys], runKey, claim);
  try {
    return await deps.routeOf(refs.fast, env, "fast", PI_WIRES, undefined, cut);
  } catch (error) {
    log(`learning: no grader route (${error instanceof Error ? error.message : String(error)}): the answers are compared whole`);
    return undefined;
  }
}

/** A subagent run's tier routes (runner/subagent.ts): each tier routedSubagentTiers names, on its model (the revision's
 *  modelTiers, else the host's tier variable), under its own key (subagentRoute), on a route of its own. A tier's model may
 *  be another provider's than the run's own, whose key claimSecrets never opened (it scopes the claim's keys to the run's
 *  model): so the routes read the saved model keys of those tiers' models alone (subagentTierKeys), held by the run's
 *  redactor, on the routes' env alone, never the run's tools (toolEnv). A run with its own model key carries that key,
 *  and no saved key is read. A tier no route can be made for here is in `why`, cut, and no failure of the run: a call on
 *  it answers why. */
export async function subagentTierRoutes(
  body: { readonly modelTiers?: Readonly<Partial<Record<SubagentTier, string>>> },
  keyed: boolean,
  runKey: ClaimModelKey | undefined,
  toolEnv: NodeJS.ProcessEnv,
  cut: HeldRedact,
  deps: Pick<AdapterSpecDeps, "store" | "sealKey" | "env" | "routeOf"> & PlanHandBack,
  claim?: Pick<Claim, "runId" | "turn" | "attempt">,
): Promise<{ readonly routes: Map<string, ModelRoute>; readonly why: Map<SubagentTier, string> }> {
  const routes = new Map<string, ModelRoute>();
  const why = new Map<SubagentTier, string>();
  const { tiers, refs } = routedSubagentTiers(body, deps.env ?? {});
  const savedKeys = keyed ? {} : await subagentTierKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env, handBack: deps.handBack, signal: deps.signal }, tiers, refs);
  holdClaimed(cut, savedKeys);
  const tierEnv = claimModelEnv(deps.env, [toolEnv, savedKeys], runKey, claim);
  for (const tier of tiers) {
    try {
      routes.set(subagentRoute(tier), await deps.routeOf(refs[tier], tierEnv, tier, PI_WIRES, undefined, cut));
    } catch (error) {
      why.set(tier, cut(error instanceof Error ? error.message : String(error)));
    }
  }
  return { routes, why };
}

/** The revision's body, as the store keeps it (agent-body.ts); agentic runs only reach here, a workflow run is
 *  dispatched to the workflow loop. */
type RevisionBody = Readonly<Partial<AgenticBody>>;

/** What the runner routes a claimed run on: the launch's model as its start pinned it, sent as pinned, with the
 *  revision's own ref beside it (main prices a gateway's id by the provider that ref names); the revision's ref alone
 *  when the start pinned none. Never the pin's provider and id joined into a ref: a gateway refuses the joined id, and
 *  bare ids would cut it again (model.ts pinnedChoice). */
export function modelAskOf(pinned: { provider: string; modelId: string } | undefined, ref: string | undefined): string | PinnedModel | undefined {
  return pinned ? { pinned, ...(ref ? { ref } : {}) } : ref;
}

/**
 * One claimed pi run's AdapterRunSpec, built from its launch record and its revision.
 *
 * `launch` is the run's launch body (run-launch.ts), read by the dispatch at the claim; `run` is the loop's open Harness
 * and registry (AdapterRun); `deps` is the runner's store, data directory, model route and seal key; `claim` is the claim
 * this pass holds.
 */
/**
 * The run's gate before a call's intent, as the adapter loop asks it: the revision's tool settings and approvals over the
 * server's, from the one store (loadToolSettings), through RunGate (decide: deny with its words, a pin, allow, ask). The
 * adapter loop handles the ask/park/answer on the journal itself, so only the answer is read here, never RunGate's own
 * file-based approval flow. `root`: the run's folder, the run's Workspace (Mode 2: its folder on the run's disk, never a
 * folder of this machine) or the local folder's path, for the gate's path checks; nothing in it is read.
 *
 * The server's settings are read again at each call, from the store (a row of the local store: no cache, no signal from
 * the server, which may be another process), so a permission set while the run goes reaches its next call ("applies at the
 * next call, in runs already going too"). A read that fails is unread: the gate holds to its last good read, marked unread
 * (RunGate.serverSettings), so a deny it held still refuses and approvals "never" lifts no ask until the store reads.
 *
 * Whether anyone can answer an ask is the store's too (server-approvers.ts), read once at the claim: no one (the
 * server's accounts off), an asked call is refused at once in words, never parked.
 *
 * The run's computer once off for the run (RunGate.computerOff): a call of its tools is refused before any settings read.
 * `turnedOff`: an earlier claim turned it off (computer-journal.ts computerTurnedOff), so this claim's gate starts off.
 * `onComputerOff`: told the computer's kind, and awaited, when this claim's first deny of a call of its tools turns it off,
 * for the run's journal (computer-journal.ts recordComputerOff), so a later claim starts it off too. The gate's
 * `computerOff` says whether it is off now, so a park lets it go instead of keeping it (spec-holds.ts Held.computerOff).
 */
/** The run's tool permissions as a learned workflow's call nodes are held to them (learned-workflow.ts policy, denyFrom,
 *  refresh): the same gate as the run's own calls, its settings read again from the store before each call node. */
export type RunPermissions = {
  readonly policy: (tool: string) => Permission;
  readonly denyFrom: (tool: string) => SettingFrom;
  readonly refresh: () => Promise<void>;
};

export async function adapterRunGate(store: Pick<Store, "settings">, claim: Pick<Claim, "runId">, revision: { kind: string; body: { tools?: readonly string[]; toolSettings?: unknown; harness?: string; approvals?: Approvals } }, root: RunFiles, shell: ShellPlace | undefined, options: { readonly effectOf?: (name: string) => ToolEffect | undefined; readonly argumentsOf?: ArgumentsOf; readonly facts: AdapterFacts | undefined; readonly names?: readonly string[]; readonly turnedOff?: boolean; readonly onComputerOff?: (kind: string) => Promise<void> }): Promise<NonNullable<AdapterRunSpec["gate"]> & { readonly permissions: RunPermissions; readonly learn: (flows: readonly LearnedWorkflow[]) => void; readonly askedOn: (host: ToolHost) => void; readonly computerOff: () => boolean; /** Whether the run can write a file now, as its gate decides a save_as (RunGate.writeBar): what its files note and computer_screenshot's save_as are offered by. */ readonly writes: () => boolean; /** The computer ops the gate refuses whatever their arguments (RunGate.opsRefused: not given, denied, or an ask no one can approve): what computer_op and a script's `computer` leave out. */ readonly opsRefused: () => readonly string[] }> {
  let current = await storeSettings(store);
  const approvers = await readApprovers(store.settings);
  // A Workspace's paths are in the run's folder: its folder named as a computer names it, for the gate's path checks.
  const folder = typeof root === "string" ? root : COMPUTER_ROOT;
  // Where the run's shell is (run-tools.ts shell): with no computer, a tool no setting names takes the kernel's ruled
  // default (tool-gate.ts defaultPermission): bash asks first, the background tools are refused.
  // An MCP tool's effect as the run's pin marks it (ClaimMcp.effectOf): what "allow reads" lifts an ask by.
  // Every name of the run's folder its file tools take (RunTools.names: a CLI's scratch folder among them), for its filed folders.
  const where = { root: folder, work: folder, ...(options.names ? { names: options.names } : {}), ...(options.effectOf ? { effectOf: options.effectOf } : {}), ...(options.argumentsOf ? { argumentsOf: options.argumentsOf } : {}), facts: options.facts };
  const gate = runGate({ ...where, ...(shell === undefined ? {} : { computer: shell === "computer" }) }, claim.runId, revision, () => current, approvers);
  if (options.turnedOff) gate.turnOff();
  // Whether the run's journal has the computer off already (an earlier claim's, or this claim's first deny's): written once.
  let offSaid = options.turnedOff === true;
  const { onComputerOff } = options;
  // The run's learned workflows, once its spec has read them (learn): a learned_workflow call is asked about its MCP nodes.
  let learned: readonly LearnedWorkflow[] = [];
  // The host the run's tools bind through, once the spec has made it (askedOn): a tool's own ask reads it.
  let host: ToolHost | undefined;
  // A tool's own ask counts its calls (AskContext.ran): the journal's, run to a good end, and the calls of it this gate let
  // through in this claim that have no result yet (reserved, by tool), so calls made at once never all read the same
  // count. Its calls are asked about one at a time (asking, a chain by tool): the count read and the reservation with
  // nothing between. A reserved call whose result is in the journal leaves it: counted there, or its slot freed (an
  // error, a deny). A new claim's gate starts with none: what finished is the journal's.
  // Each reserved call is kept with its arguments: a tool's own ask reads what the run's calls of it were made with
  // (AskContext.made), those let through here among them. A call its tool asks about that a person has approved
  // (approved: its answer in the journal, or their approve waiting for it) is reserved the same way, in its turn, before
  // it runs: a call of the tool asked about after it (two sends at once to one new address) reads it as made, never
  // asking again for what the person just approved; its slot goes as any reserved call's does.
  const reserved = new Map<string, Map<string, unknown>>();
  const asking = new Map<string, Promise<unknown>>();
  type GateOptions = NonNullable<Parameters<NonNullable<AdapterRunSpec["gate"]>>[1]>;
  type Ran = NonNullable<GateOptions["ran"]>;
  /** The journal's calls of `tool`, the reserved ones that have a result there let go. */
  const read = async (ran: Ran, tool: string) => {
    const calls = await ran(tool);
    const held = reserved.get(tool);
    for (const id of [...(held?.keys() ?? [])]) if (calls.ran.has(id) || calls.ended.has(id)) held!.delete(id);
    return { calls, held };
  };
  const counted = (ran: Ran) => async (tool: string): Promise<number> => {
    const { calls, held } = await read(ran, tool);
    return calls.ran.size + calls.unnamed + (held?.size ?? 0);
  };
  const madeWith = (ran: Ran) => async (tool: string): Promise<unknown[]> => {
    const { calls, held } = await read(ran, tool);
    return [...[...calls.ran].flatMap((id) => (calls.args.has(id) ? [calls.args.get(id)] : [])), ...(held?.values() ?? [])];
  };
  const askedOne = (call: Parameters<NonNullable<AdapterRunSpec["gate"]>>[0], asks: NonNullable<ToolEntry["asks"]>, made: ToolHost, ran: Ran, approved: GateOptions["approved"]): Promise<string | undefined> => {
    const turn = (asking.get(call.tool) ?? Promise.resolve()).then(async () => {
      const because = await asks((call.args ?? {}) as Record<string, unknown>, { host: made, ran: counted(ran), made: madeWith(ran) });
      if (call.callId && (because === undefined || (await approved?.(call.callId)))) reserved.set(call.tool, (reserved.get(call.tool) ?? new Map()).set(call.callId, call.args));
      return because;
    });
    asking.set(call.tool, turn.catch(() => undefined));
    return turn;
  };
  // The computer off, written to the run's journal once. A write that fails (a fenced claim, a journal error) never fails
  // the call, whose refusal stands: the claim's next refusal of the computer's tools writes it again.
  const sayOff = async (): Promise<void> => {
    const turnedOff = offSaid ? undefined : gate.computerOff;
    if (!turnedOff) return;
    offSaid = true;
    try {
      await onComputerOff?.(turnedOff);
    } catch {
      offSaid = false;
    }
  };
  const decide = async (call: Parameters<NonNullable<AdapterRunSpec["gate"]>>[0], options: Parameters<NonNullable<AdapterRunSpec["gate"]>>[1] = {}) => {
    const off = gate.offRefusal(call.tool, options);
    if (off) {
      await sayOff();
      return off;
    }
    current = await storeSettings(store);
    const decision = await gate.decide(call.tool, call.args, options);
    await sayOff();
    // A call its setting allows that its tool asks about itself (ToolEntry.asks: email_send past its cap, or to someone
    // outside the run's thread): put to a person with the tool's reason on its card, whatever the setting; where no one
    // can approve, refused in those words. No tool's name is read here: the reason is the tool's.
    const asksOf = decision === "allow" && host && options.ran ? toolOf(call.tool)?.asks : undefined;
    const because = asksOf ? await askedOne(call, asksOf, host!, options.ran!, options.approved) : undefined;
    if (because !== undefined) return approvers ? { ask: {}, because } : { deny: noApproverText(gate.askedAs(call.tool, call.args), options.replayed ? "unknown" : "no", because) };
    // A learned workflow's MCP nodes are the run's own MCP calls, held to the same settings: one set to deny refuses the
    // whole call in the gate's words before any node runs, nothing sent; the actions set to ask are put to a person on the
    // call's one card, up front, each with its arguments' shape (learnedAskShown), and the person's allow passes the
    // calls nested in this one of the tools that card named (adapter-loop.ts preIntentGate), and no other. Each MCP call
    // is still asked at the gate as itself as it runs (its pins, a deny set since). Checked whether the learned_workflow
    // call is itself allowed or asked: a workflow that can't run is never put to a person.
    if ((call.tool as string) !== LEARNED_WORKFLOW_TOOL || typeof decision === "object") return decision;
    const actions = await mcpOf(call.args);
    const refused = (why: string) => ({ deny: `The learned workflow ${String((call.args as { name?: unknown }).name)} was not run: ${why}` });
    const denied = actions.find(({ tool }) => gate.policy(tool) === "deny");
    if (denied) return refused(deniedText(denied.tool, undefined, gate.denyFrom(denied.tool)));
    const asks = actions.filter(({ tool }) => gate.policy(tool) === "ask");
    // An ask no one can answer (the server's accounts off) is refused at once in the gate's words, never parked.
    if (asks.length && !approvers) return refused(noApproverText(asks[0]!.tool, "no"));
    return asks.length ? { ask: learnedAskShown(asks) } : decision;
  };
  /** The learned workflow of the run's a learned_workflow call's arguments name, if any. */
  const flowOf = (args: unknown) => learned.find((one) => one.name === (args as { name?: unknown } | undefined)?.name);
  /** The MCP actions the learned workflow a learned_workflow call names can call; none for another call or workflow. */
  const mcpOf = async (args: unknown): Promise<LearnedAction[]> => {
    const flow = flowOf(args);
    return flow ? learnedMcpCalls(flow.workflow) : [];
  };
  /** That workflow's name and digest (SpecGate.learnedOf): what the record of a call of it the gate refuses names. */
  const learnedOf = (args: unknown) => {
    const flow = flowOf(args);
    return flow ? { workflow: flow.name, digest: workflowDigest(flow) } : undefined;
  };
  // An ask is named as main's pending approval is (RunGate.askedAs: its settings key), beside the decision, which is
  // unchanged. The permissions are the learned workflow's (main's toolGate.policy and denyFrom), over the same settings.
  const permissions: RunPermissions = { policy: (tool) => gate.policy(tool), denyFrom: (tool) => gate.denyFrom(tool), refresh: async () => { current = await storeSettings(store); } };
  // A tool's setting now, read from the store as each call's is (SessionIO.permission: Codex's live search, which runs
  // inside a model request, is offered only while it says allow). A read that fails is a deny, never the last good read's
  // allow: a deny saved since may be in what did not read, and no call reaches the gate to say otherwise.
  const permission = async (tool: string): Promise<Permission> => {
    current = await storeSettings(store);
    return current.unreadable ? "deny" : gate.policy(tool);
  };
  return Object.assign(decide, { askedAs: (tool: string, args?: unknown) => gate.askedAs(tool, args), permissions, permission, learnedOf, learn: (flows: readonly LearnedWorkflow[]) => void (learned = flows), askedOn: (made: ToolHost) => void (host = made), computerOff: () => gate.computerOff !== undefined, writes: () => gate.writeBar() === undefined, opsRefused: () => gate.opsRefused() });
}

/** The server's tool settings from the store now; a read that throws is unread (no value of it said). A workflow's call
 *  and model nodes read theirs through it too (workflow-spec.ts callPolicyOf), so both gates fail closed alike. */
export async function storeSettings(store: Pick<Store, "settings">): Promise<Awaited<ReturnType<typeof loadToolSettings>>> {
  try {
    return await loadToolSettings(store);
  } catch {
    return { settings: {}, problems: ["the stored tool settings could not be read"], unreadable: true };
  }
}

/** pi's spec for a claimed run, on `runner`'s adapter (pi's when none is given; a harness module's runner for a harness it
 *  adds with no adapter facts), its visible record kept as that runner says (RunnerHarness.record). What it makes for the
 *  run (its Archil mount credential, its Workspace, its computer, its tools) is held until the spec's release; a build
 *  that throws part-way lets go what it made by then (spec-holds.ts). */
export function adapterRunSpecFromLaunch(launch: RunLaunch, run: AdapterRun, deps: AdapterSpecDeps, claim: Claim, runner: RunnerHarness = RUNNER_HARNESSES[DEFAULT_HARNESS]!): Promise<AdapterRunSpec> {
  return specBuilt((holds) => adapterSpec(launch, run, deps, claim, holds, runner));
}

async function adapterSpec(launch: RunLaunch, run: AdapterRun, deps: AdapterSpecDeps, claim: Claim, holds: SpecHolds, runner: RunnerHarness): Promise<AdapterRunSpec> {
  mustHold(run.redact, "A pi run's spec");
  const context = BACKGROUND_CONTEXT;
  // What this claim may reach on loopback, read once for its MCP servers and its calendar_events alike (mcpReachOf).
  const reach = await mcpReachOf(deps);
  // The runner's one redactor (the loop's, LoopDeps.redact), for every text a secret could reach: the spec's log lines
  // (a release, a workspace's end), the model route's translation and the session's model proxy. It holds the keys the
  // claim opens (below), too.
  const cut = run.redact;
  const log = (line: string) => (deps.log ?? (() => {}))(cut(line));
  holds.logTo(log);
  const runRow = await deps.store.runs.get(claim.runId);
  if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
  // A run handed a browser sign-in this runner can't read back (its seal does not open here, or nothing of it is kept):
  // what it said could repeat a pointer nothing can cut, so it ends failed at its claim, in main's words (runs.ts).
  if (!(await (deps.sealKey ? handedSignInReadsBack(deps.store, deps.sealKey, runRow) : heldOrThrow("a handed sign-in's read-back").signInReadsBack()))) throw new ClaimRefused(UNREADABLE_SIGN_IN);
  const revisionRow = await deps.store.agents.revision(runRow.revisionId);
  if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
  const body = (revisionRow.body ?? {}) as RevisionBody;
  const movedProject = await verifyPlacedProject(deps.store, runRow, revisionRow, launch, { data: deps.data, sealKey: deps.sealKey, env: deps.env, ...(run.signal ? { signal: run.signal } : {}), control: { ...deps.mountControl, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) } });
  const revision = { kind: revisionRow.kind, body } as { kind: string; body: { tools?: readonly string[]; toolSettings?: unknown; harness?: string; approvals?: Approvals } };
  const granted = body.tools ?? [];

  // The run's mode is the server's: Mode 2 where its Archil settings are saved (archil-settings.ts), the run's folder then
  // on the claim's Archil disk (archil-claim.ts: its keys from the store's sealed rows, under the runner's seal key, in this
  // claim's memory only); else Mode 1, the run's local folder. The same for the pi and the CLI spec.
  const archilSettings = await loadArchilSettings(deps.store, deps.env);
  const mode: 1 | 2 = archilSettings === undefined ? 1 : 2;
  // Its region with no serverless exec, where it has none: a run with no computer that mounts its folder has no shell.
  const noExec = noExecRegionOf(archilSettings);
  const archil = archilSettings === undefined
    ? undefined
    // The run's mount credential is minted per run the first time a computer's mount asks (archil-mount-credential.ts), on
    // the account key from the server's environment first, then the sealed row; named for the run and this claim's epoch, with
    // a 24 h ttl as the safety net if revoke never comes (revoke normally runs at the run's end, below). A run with no
    // mounting computer never mints one.
    // The mint is lazy (archil-claim.ts token(), k2's run-tools.ts): only a mounting computer asks for it, so a Mode 2 run
    // with no computer mints nothing. mountControl (a test's loopback control-plane fake) is the claim's control, so no
    // test reaches the real control plane. MOUNT_TTL_MS is the credential's safety net (its computer's 24 h bound), not its lifetime.
    // The disk is the run's (run-disk.ts): its launch record's, else its agent's, made on its first run that needs one,
    // and read at Archil at every claim.
    : await archilWhereHeld({ settings: archilSettings, keys: deps.store.sealedKeys, sealKey: deps.sealKey, signal: run.signal ?? new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS }, ...(deps.mountControl ? { control: deps.mountControl } : {}), run: { agentId: runRow.agentId, ...(launch.archilDisk ? { launch: launch.archilDisk } : {}), store: deps.store }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) });
  // Each resource is held the moment it exists (spec-holds.ts): a throw after it lets it go.
  holds.hold({ archil });
  // The run's Workspace at the claim: Mode 1 the run's local folder (made here, the server's start made it before); Mode 2
  // the run's folder on the disk.
  const ws = archil === undefined
    ? await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log })
    : await openRunWorkspace({ mode: 2, agentId: runRow.agentId, runId: claim.runId, archil, log });
  holds.hold({ ws });

  // The run's uploaded files, copied into its work/inputs/ before the first turn, from what its start held for it, once
  // per run (uploads.ts copyRunFiles), and its opening message saved beside them as inputs/message.md (placeRunInputs);
  // a copy that fails ends the run failed, saying why. A run's own process copies nothing: its runner placed them before
  // the process started (run-child-host.ts), as the server's held uploads are never the run's to read.
  if (!(deps.sealKey === undefined && runnerSeam())) await placeRunInputs(deps.data, claim.runId, ws.workspace, filesToCopy(launch), messageText(launch.input));
  // The run's template eval fakes (AdapterSpecDeps.evalFakes), read once: its files, its metered jobs' media and its tools.
  const fakes = deps.evalFakes?.(runRow.agentId);
  await seedEvalFiles(ws.workspace, fakes?.files);

  // The pull request's checkout, when the revision asks for one (pr-checkout.ts): the server's own fetch before the first
  // turn, with the GitHub App's read-only token for that one repository (or none); the run is told what it holds, or why
  // there is none. Held from the fetch's start, so the release (after the tools' end) removes it however the claim ends; a
  // person's stop ends the fetch at once (run.stopped). On an Archil region with no serverless exec (noExec) the disk runs
  // no command: the checkout waits for the run's computer (below, checkoutWhereNoExec).
  let checkout = body.checkout && noExec === undefined ? await prCheckoutForClaim(deps, ws.workspace, launch, cut, run.stopped ?? run.signal, (part) => holds.hold({ checkout: part }), body.checkout) : undefined;
  holds.hold({ checkout });

  // The run's skills and its learning seed, laid in its folder through the run's Workspace now, before its computer
  // exists: on Archil the computer's mount of the folder takes the disk's write delegation, and from then on every write
  // over the disk's file API is refused (409) while the mount holds it, so a lay after the mount fails the run. The lay
  // reads nothing of the computer: the kind skill is the revision's computer setting's kind. A later claim lays only what
  // is not there yet (layOwnSkills keeps every folder an earlier claim laid).
  // The launch's learning start (none: the run does not learn), decided once at launch.
  const start = learningStartOf(launch);
  // The revision's own skills are laid in the run's .agents/skills/ before they are read (main's server start laid them;
  // on the one store the claim does), from the revision row's texts (the body keeps only each file's SHA-256): each
  // folder not there yet, never over an earlier claim's. A desktop or a phone (the revision's computer
  // setting, the one computerForClaim starts) brings its kind's skill, named in the prompt beside the revision's own.
  const kindSkills = movedProject ? [] : await layOwnSkills(ws.workspace, (revisionRow.skills ?? {}) as Record<string, string>, { computer: settingOfDefinition(body)?.computer.kind });
  const currentSkills = movedProject ? await movedSkillFiles(ws.workspace, body.skills ?? {}, settingOfDefinition(body)?.computer.kind) : [...Object.keys(body.skills ?? {}), ...kindSkills];
  // A learning run's seed, read once from its agent's learning rows (runner/learning-seed.ts): its learned workflows,
  // cut of the server's secrets, the ones its learned_workflow tool runs. Read before the run's tools are bound. A
  // learning fault, or a seed that failed (seedFailed), gives none.
  const shown = async () => secretsShown(runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data)), { local: true });
  const seedLaid = start && !seedFailed(start)
    ? await layLearningSeed({ seed: start.seed, store: deps.store, agentId: runRow.agentId, shown, log, ...(start.noWorkflows ? { workflows: false as const } : {}) })
    : undefined;

  // The run's MCP for this claim (mcp-run.ts mcpForClaim): its pin, the one its revision's save made, read, its
  // credentials opened under the server's seal key into this claim's memory, one gateway for the claim. First, before
  // anything the spec would have to let go: a refusal (a granted tool its pin does not hold, a pinned meta tool) ends the run in its
  // words before the session opens. The seal key is the runner's own (deps.sealKey), not re-read from the environment.
  // A credential the claim opens mid-run (a GitHub App token, a saved or per_run server's) joins the run's redactor. A
  // per_run server the run was handed no credential for is left out of its tools, and its timeline says so.
  // A held run its model kept from running at its create (hold.refused) opens none: nothing can call one.
  const heldRefusal = launch.hold?.refused?.message;
  // What its gateway files (a long answer, a server's results) goes in the run's own files. In Mode 1 that is the run's
  // folder on this machine (ws.workspace below, the folder a box bind-mounts). In Mode 2 it is the run's Archil disk:
  // through the run's computer once it mounts the folder (filedIn, set at runTools), since the mount holds the disk's
  // write delegation and a write over the disk's file API is refused (409) while it does; over that file API (ws.workspace)
  // when no computer mounts it. The gateway reads work() only when a call is answered (mcp-gateway.ts textOf, fileResults),
  // and a call reaches it only through the session this spec returns, after `tools` is made.
  let filedIn: Workspace | undefined;
  const hold = (values: string[]) => cut.hold(values);
  const mcp = heldRefusal !== undefined ? undefined : await mcpWhereHeld({ claim, store: deps.store, sealKey: deps.sealKey, grants: granted, harness: run.harness, toolSettings: body.toolSettings, work: () => (mode === 2 ? filedIn ?? ws.workspace : ws.workspace), launchInput: launch.input, hold, redact: cut, githubAppAccess: (store, key, input) => githubAppAccess(store, key, input, { ...(deps.githubApi ? { api: deps.githubApi } : {}), fromGitHub: launch.inputOrigin?.kind === "trigger" && launch.inputOrigin.source === "github", hold, ...(launch.repo !== undefined ? { repo: launch.repo } : {}) }), ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}), ...(deps.composioMcpOrigin ? { composioMcpOrigin: deps.composioMcpOrigin } : {}), ...reach, say: (words) => run.phase?.(words), ...claimMetering(deps, fakes?.web, launch) });
  // The claim's MCP goes to the loop, which lets it go; a build that throws lets it go itself.
  holds.hold({ passed: mcp });

  // The run's computer, from the one shared claim-time function (the CLI spec takes the same): none for a runner place, a
  // Docker container for a sandbox, under the claim's epoch (the one fence). It throws computer_unavailable (nothing made)
  // when the computer cannot be had: the run fails in its words.
  const claimSignal = run.stopped ?? run.signal;
  // An earlier claim's deny turned the run's computer off for the run (computerTurnedOff): this claim starts none, and
  // ends the one a park kept, its mount with it, before the run's tools touch its folder (turnedOff).
  const offAlready = await computerTurnedOff(deps.journal(claim), context);
  const computer = await deps.computerForClaim(
    // The runner holding the claim (its name, its presence incarnation): a computer a park keeps that only it can reach
    // again is pinned to it.
    { runId: claim.runId, epoch: claim.epoch, claim, agentId: runRow.agentId, revisionId: runRow.revisionId, place: launch.place, ...(run.incarnation ? { holder: { runner: claim.runner, incarnation: run.incarnation } } : {}) },
    deps.store,
    // revokeMount removes the run's Archil mount credential when the computer is released (and if a start fails after a mint);
    // the run's end revokes it too (below), so it goes on every outcome even when no computer is made. Idempotent. What
    // became of the agent's own computer (a persistent setting) is said on the run's timeline.
    // A person's stop ends the claim's waits at once: a first image pull or registration (Agent37's runs minutes) among them.
    // Whether an earlier claim made the run a computer of its own is the run's journal's to say (hadComputer): a later
    // claim's is a new one whatever ended the earlier claim (a lost runner, a server's stop, a park past its keep). The
    // computer a park kept, attached again, brings its mount credential with it (inheritMount): none is minted. A park's
    // row names the disk that credential is on (mountDisk), asked only at the park: a run's own process hands its claim to
    // its runner, whose computerForClaim asks its own Archil claim. A recording of its screen (computer.record) goes in
    // the run's recordings folder, beside its folder, said on its timeline.
    { ...deps.computerDeps, mode, noExec, workspace: ws.workspace, sealKey: deps.sealKey, ...(offAlready ? { turnedOff: offAlready } : {}), recordings: { folder: recordingsFolder(deps.data, runRow.agentId, claim.runId), say: (words) => run.phase?.(words) }, hadComputer: () => hadComputer(deps.journal(claim), context), stopRun: stopRunWith((refusal) => run.ledger.pause(refusal)), ...(run.ledger ? { compute: { ledger: { paid: run.ledger.paid, pause: (refusal: Refusal) => run.ledger.pause(refusal), judges: () => run.ledger.judges?.() ?? true }, env: deps.env } } : {}), ...(claimSignal ? { signal: claimSignal } : {}), ...(archil ? { revokeMount: () => archil.revoke(), inheritMount: () => archil.inherit(), mountDisk: () => archil.disk.id } : {}), ...(run.phase ? { onImageWait: (making, image) => run.phase?.(imageWaitWords(making, image)), onStarting: (said) => run.phase?.(computerStartingWords(said)), onConnected: (said) => run.phase?.(computerReadyWords(said)), onComputerNote: (words) => run.phase?.(words) } : {}) },
  );

  // The run's shell is its computer's (600 s) where one mounts its folder; with none, Archil's serverless exec in Mode 2
  // (295 s), and in Mode 1 none at all: no bash family, its folder being one of this server's own (run-tools.ts).
  // A desktop's or a phone's hold (the person's take-over) wraps its ports: a call made while the person holds it waits,
  // and the agent's hand-over (computer_request_handoff) asks the person through it.
  holds.hold({ computer });
  const loopComputer = loopComputerOf(computer.computer, computer.held, computer.made);
  const heldComputer = heldSpecOf(launch, loopComputer);
  // Under the agent's bash policy, its shell's environment is the policy's too (bash-read-only.ts policyEnv).
  const bashPolicy = bashPolicyOf(body.toolSettings);
  // The computer's tools are the run's own host tools, as on every harness: the host's codemode (meta-tools.ts) calls them
  // as `tools.<name>`, each a nested call, gated and recorded as the model's own call is. A computer that replaced an
  // earlier claim's holds its acts to what it showed.
  const tools = await runTools(ws.workspace, computer.computer, { mode, noExec, context, ...(computer.hold ? { hold: computer.hold } : {}), ...(bashPolicy === undefined ? {} : { bashPolicy }), ...(computer.replaced ? { replaced: true } : {}) });
  filedIn = tools.workspace;
  let remoteProjectCapture = false;
  holds.hold({ tools: { end: () => remoteProjectCapture ? Promise.resolve() : tools.end() } });
  // On an Archil region with no serverless exec, the checkout now: in the computer that mounts the run's folder, through
  // its own exec, writing through its mount; with none, the run is told why there is none (pr-checkout.ts).
  if (body.checkout && noExec !== undefined) {
    checkout = await checkoutWhereNoExec(deps, tools.shell === "computer" ? tools.workspace : undefined, noExec, launch, cut, claimSignal, (part) => holds.hold({ checkout: part }), body.checkout, (words) => run.phase?.(words));
    holds.hold({ checkout });
  }

  // The run's model route: its model through routeOf (NEVER re-resolved — the launch's model, pinned at start), the catalog
  // price with tiers for the cap, and the proxy's price (pi-ai calculateCost, tiered).
  // pi speaks both of main's wires: an OpenAI-family model's route is OpenAI's Responses itself.
  // The runner's one redactor (run.redact) goes to the route's translation and to the session's model proxy: a provider's
  // error that echoes a secret reaches pi's record with none in it, on any route.
  // The run's secrets for this claim, read from the one store (never this process's environment or a pipe): the keys its
  // tools unlock and its model needs, scoped to the run as the old per-run environment was, so one run's keys never reach
  // another's on this runner (claim-secrets.ts). MCP credentials are the other per-claim secret and come through mcp-claim.
  const toolEnv = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: deps.env, redact: run.redact, handBack: run.handBack, signal: run.signal }, revisionRow as unknown as Parameters<typeof claimSecrets>[1], launch, claim.runId);
  // The run's own model key, when its caller handed one (model_key, sealed in its launch): opened at every claim, a reclaim
  // after a crash among them, and held by the run's one redactor. Its model routes read it alone; its tools never do.
  // A run that starts on the server's key holds the claim's key holder too: a message's first key reaches its next request.
  const runKey = await claimModelKey({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, claim.runId);
  const keyed = keyedAtClaim(runKey);
  if (keyed) withoutModelKeys(toolEnv);
  if (runKey) holdRunKey(cut, runKey);
  // The keys it opened join the run's one redactor before any tool or model request can echo one.
  holdClaimed(cut, toolEnv);
  // The route reads its model's key from the runner's environment, else the one the claim opened from the store: a key
  // saved in Settings → Model keys runs the next run with no restart (withModelKeys). A run with its own key: that key.
  const modelEnv = claimModelEnv(deps.env, [toolEnv], runKey, claim);
  // A held run its model kept from running at its create is never routed (heldRefusedRoute): its model's route chooses no
  // model and reads no key, so a key saved since runs a new run, never this one. Its claim lays only the keys any claim
  // of the run lays (its tools', a key handed with it: claimSecrets lays it no model key), routes no subagent tier and
  // takes no learning step (below).
  const route = heldRefusal !== undefined ? heldRefusedRoute(heldModelOf(body.model), heldRefusal) : await deps.routeOf(modelAskOf(launch.model, body.model), modelEnv, "default", PI_WIRES, undefined, cut);
  await planBeforeRun(modelEnv, route.provider.plan ? { provider: PLAN_PROVIDER } : undefined);
  // The run's models of other tiers, for its learned workflows' nodes of a tier (learnedTierRoutes, filled once the seed's
  // lay chose the workflows, below): read when the session opens (pi.ts options.tiers), each on a proxy of its own.
  const tierRoutes = new Map<string, ModelRoute>();
  // The run's pi-native extensions, in the root agent through the pi adapter (PiAdapterOptions.extensions), which installs
  // them in the claim's registry and offers each tool once:
  // - ask_person is pi's own tool (tools.ts): a run granted it carries its native extension, so pi runs it as its own tool
  //   task under the session's gate and keeps its control.terminate — the turn ends on the person's question and the loop
  //   parks the run (endedOnTurnEndingTool), or, with the browser's session open, waits for the answer in its claim
  //   (adapter-loop waitInClaim, the browser's personWait below). It stays out of this session's host tools: a CLI
  //   harness gets the same tool as a host tool (cli-run-spec.ts), whose turn the loop cuts at the question.
  // - the browser's durable extension, when the run gets one (bindNonHandTools, below, before the session opens).
  const native: Extension[] = granted.includes(ASK_TOOL) ? [defineExtension({ name: "ask_person", tools: [askPerson] })] : [];
  // pi-native tools in the session's own extension (PiAdapterOptions.tools): the subagent tool, pushed below.
  const piTools: ToolRegistration[] = [];
  // A run granted subagent (runner/subagent.ts): the model of each of its tiers, the revision's own (modelTiers) else the
  // host's for the tier (AGENT_MODEL_FAST, AGENT_MODEL_STRONG), each on a route of its own (its proxy on the session's
  // booking, adapters/pi.ts tiers). A tier with neither is the agent's own model, as a learned workflow's node of it runs
  // on the run's. A tier no route can be made for here is no failure of the run: a call on it answers why. A tier's model may be another
  // provider's than the run's own, whose key claimSecrets never opened: so its route reads the saved model keys of its
  // tiers' models alone (subagentTierRoutes). Those reach the tier's proxy alone, as its credential, never the run's tools
  // (toolEnv).
  // Each is in tierRoutes under its own key (subagentRoute: never a learned workflow's tier, whose nodes keep their own
  // routes and fallback), on a proxy of its own that names that key on each request, so the cap prices a child's
  // requests as that route books them. A held run its model kept from running routes none: its subagent's calls run on
  // the stand-in, refused in its create's words.
  const tierWhy = new Map<SubagentTier, string>();
  if (revision.kind === "agentic" && granted.includes(SUBAGENT_TOOL) && heldRefusal === undefined) {
    // A run with its own model key: its subagents' models carry that key too, and no saved key is read.
    const subagent = await subagentTierRoutes(body, keyed, runKey, toolEnv, cut, { ...deps, handBack: run.handBack, signal: run.signal }, claim);
    for (const [key, at] of subagent.routes) tierRoutes.set(key, at);
    for (const [tier, why] of subagent.why) tierWhy.set(tier, why);
  }
  // The run's adapter is its runner's (runner/adapters/index.ts RunnerHarness: pi's, or the one a harness module's entry
  // brings), made from the run's launch on its route. Its private files, where it keeps any, go in this claim's folder of
  // the run's scratch (the CLI spec's layout), swept at the claim's end with the earlier claims' and any parent left empty.
  // The run's one redactor is the launch's (HarnessLaunch.redact). pi's own options (its extensions, tools, the model's
  // catalog entry, hosted search, tiers, and the route's whole provider) are the harness's own (`extra`), passed on as given.
  const scratch = scratchFolder(deps.data, runRow.agentId, claim.runId);
  const harnesses = join(scratch, "harness");
  holds.hold({ scratch: { sweep: async () => (await import("./cli-run-spec.js")).sweepScratch(harnesses, claim.epoch, [harnesses, scratch, dirname(scratch)]) } });
  const adapter = await runner.adapter({
    run,
    model: route.model,
    provider: route.provider,
    ...(route.price ? { price: route.price as never } : {}),
    sessionsDir: join(harnesses, String(claim.epoch)),
    ...(route.fetch ? { fetch: route.fetch } : {}),
    ...(route.local ? { local: true } : {}),
    redact: cut,
  }, {
    // Read when the session opens (pi.ts), so the browser's extension pushed by bindNonHandTools below is in it.
    extensions: native,
    tools: piTools,
    provider: route.provider,
    ...(route.like ? { like: route.like } : {}),
    // The run's web_search is its provider's hosted search (the launch's plane, as its start resolved it): the session's
    // proxy admits that search's one request (it goes through the session's port: buildToolHost's `search`) and books it
    // with each search it ran.
    ...(launch.plane?.web_search === "native" ? { webSearch: true } : {}),
    tiers: tierRoutes,
  });

  // The gate before a call's intent: the run's revision's tool settings through runGate (approvals "never" turns the one
  // ask it leaves into an allow). The adapter loop asks `gate` and handles the ask/park/answer on the journal itself, so
  // only the permission is read here, never runGate's own file-based approval flow.
  const root = runFolder(deps.data, runRow.agentId, claim.runId);
  // The gate names the run's folder by its Workspace (Mode 2: its folder on the run's disk, never this machine's folder at
  // the same path), for its path checks; it reads nothing in it.
  // A pinned MCP tool is held to the arguments its listing in the run's pin declares (mcp.argumentsOf). The harness's facts
  // are its entry's on the owner's table (factsOf): none for pi, nor for a module's harness on a runner of its own.
  const facts = factsOf(deps.env, revision.body.harness);
  // The run's computer off for the run (its first deny's, this claim's or an earlier one's) is on the run's journal.
  const gate = await adapterRunGate(deps.store, claim, revision, ws.workspace, tools.shell, { ...(mcp ? { effectOf: (name: string) => mcp.effectOf(name), argumentsOf: (name: string) => mcp.argumentsOf(name) } : {}), facts, names: tools.names, turnedOff: offAlready !== undefined, onComputerOff: (kind) => recordComputerOff(run.harness, kind) });
  // A park lets a computer the gate turned off go rather than keep it (SpecHolds Held.computerOff).
  holds.hold({ computerOff: gate.computerOff });

  // The run's one cap, as the loop's runCap reads it (adapter-loop.ts RunCapConfig): the launch's cap figure (undefined
  // uncapped — every paid request still books through the one cap), the run's model priced WITH tiers, strict where the
  // launch says. The loop builds the kernel runCap from these over the run's own sessions (its model requests, its paid
  // tool calls and its decisions all on one rule and one booking), so the spec carries no beforeRequest of its own.
  const capUsd = launch.maxCostUsd;
  const capModel = capModelOf(route);
  // And each tier's model (tierRoutes, filled below), by the route its request names (its tier's proxy, ModelRequest.route),
  // priced as that route books it: one id the run's model and a tier share is priced apart, never at the other's price.
  const besideOf = spentBesideOf(launch, deps.store, claim.runId);
  const runCap: RunCapConfig = {
    capUsd: () => launch.maxCostUsd,
    modelOf: (id, by) => {
      if (by === undefined) return id === route.model ? capModel : undefined;
      const tierRoute = tierRoutes.get(by);
      return tierRoute && tierRoute.model === id ? capModelOf(tierRoute) : undefined;
    },
    // What its audit's shadow took beside it, read by every gate with its own sessions (none: it starts none).
    ...(besideOf ? { beside: besideOf } : {}),
    // The most requests on free models it makes, capped or not (AGENTRUN_FREE_MODEL_REQUESTS, or the agent's lower max_requests).
    freeRequests: freeRequestLimitOf(deps.env, body.maxRequests),
    // The agent's own limit alone, which a local model's requests count toward too (run-cap.ts maxRequests).
    ...(maxRequestsOf(body.maxRequests) === undefined ? {} : { maxRequests: maxRequestsOf(body.maxRequests) }),
  };
  // The run's cap figure and what a refusal does to it (parkOf, with the kernel's raise rule): present only when the run
  // has a cap. A park names the cap the loop holds the run to then (a raise's, else this one).
  const cap = capUsd === undefined
    ? undefined
    : {
        capUsd,
        park: (refusal: { message: string; forGood: boolean; figures?: CapRefused["figures"] }, capNow: number) => parkOf(refusal as CapRefused, capNow),
        checkRaise,
        followUpOf: (raised: number) => followUpOf(raised),
      };

  // And every secret the server keeps sealed (store-secrets.ts): a run's text may quote one it was never handed.
  await holdStored(cut, deps.store, deps.sealKey, deps.data);
  // The run's resolved tool plane (its web_search/web_fetch/browser providers), as main hands its per-run process (runs.ts):
  // the web tools read it (tool-plane.ts planeOf) to pick Parallel where the run resolves to it, the model provider's native
  // search, or the guarded direct fetch. Not a secret; without it the runner's web tools would ignore the run's plane and
  // never reach Parallel, so they could not book a Parallel call as main does.
  delete toolEnv[TOOL_PLANE_ENV];
  if (launch.plane && Object.keys(launch.plane).length) toolEnv[TOOL_PLANE_ENV] = JSON.stringify(launch.plane);

  // The decision keys its learned workflows' typed questions need (claim-secrets.ts learnedDecisionKeys), read once the lay
  // chose them, scoped as the revision's own: each provider the run's gate does not deny, held by the run's one redactor,
  // onto the tools' environment alone. The model's route was built on the revision's keys above, so a decision key never
  // becomes its model's.
  // The learned workflow the run starts on, before its agent's first turn, when one fits its input (workflow-first.ts),
  // chosen before the learned_workflow tool is bound, so the tool runs the text that serves. Only a promoted digest
  // serves (runner/promotion.ts: replayed on the agent's graded inputs first, or promoted on its dry run with fewer than
  // five); while the folder's revision replays or is held, the champion (the digest promoted last) serves in its place
  // (laidFor). Or the one the money rule stopped, over the agent's past runs (costLineOf): the agent takes the run.
  // The audits that finished since are written first (runner/audit.ts settleAudits): a hold they make decides this claim.
  const admitAuxiliary = runnerSeam() ? undefined : sourceAuxiliaryAdmitter(deps.store, { data: deps.data, sealKey: deps.sealKey, env: deps.env, control: { ...deps.mountControl, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) } });
  // None for a held run, so its claim reads no saved key for spend beside it (claimSpendOff).
  // A claim on the run's own key runs its learning work on that key (keyed), its check at the run's end (atEnd).
  const audits = heldRefusal === undefined ? { store: deps.store, agentId: runRow.agentId, revisionId: runRow.revisionId, context, log, shown, sealKey: deps.sealKey, spendOff: await claimSpendOff({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, runKey), keyed: keyedNow(runKey), atEnd: atRunEnd(log), admitAuxiliary } : undefined;
  // Each step writes the store or reads another run (runner/learned-first.ts): in a run's own process its runner takes
  // them (held.ts learnedFirst), over the workflows it reads at the claim's seed itself. A held run its model kept from
  // running takes none of them: it settles no audit and starts no replay run, starts on no workflow, and its tool runs
  // none (so no learned tier is routed, below).
  const learned: LearnedFirst = audits ? await learnedFirstWhereHeld(deps, { agentId: runRow.agentId, runId: claim.runId, revisionId: runRow.revisionId, kind: revision.kind, outputSchema: (revision.body as { outputSchema?: unknown }).outputSchema, launch, context, log, shown, spendOff: audits.spendOff, keyed: audits.keyed, atEnd: audits.atEnd, admitAuxiliary }, seedLaid?.workflows ?? []) : { choice: { reason: "held" }, workflows: [] };
  const firstChoice = learned.choice;
  // A replay run's call nodes: reads live through a cache seeded from the graded run's recorded calls, writes only ever
  // answered from that recording (runner/promotion.ts replayCallsOver, learn/replay-calls.ts).
  const replay = learned.recorded ? await replayCallsOver(deps.store, claim.runId, new Map(learned.recorded)) : undefined;
  const { serve: workflowFirst, revise: workflowRevise } = firstChoice;
  // The tool runs what serves, never a revision not promoted (runner/promotion.ts toolFlowsFor).
  const workflows = learned.workflows;
  // A tier a learned workflow's node names and the host has a model of: none can't be reached is left as `why`, and its
  // node fails in those words (learnedWorkflowHostTool), never on another model.
  const tierUnreachable = new Map<Tier, string>();
  if (learnsWorkflows(revision.kind, workflows)) {
    // The keys those tiers' models need (tierModelKeys: a key saved in Settings too, which claimSecrets opened only for the
    // run's own model), held by the run's one redactor, on the tiers' route env alone (withModelKeys, never enumerable),
    // never on the tools' (toolEnv).
    // A run with its own model key: its learned nodes' tiers carry that key too, and no saved key is read.
    const tierKeys = keyed ? {} : await tierModelKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env, handBack: run.handBack, signal: run.signal }, learnedTiers(workflows));
    holdClaimed(cut, tierKeys);
    const tierEnv = claimModelEnv(deps.env, [tierKeys, toolEnv], runKey, claim);
    for (const [tier, routed] of await learnedTierRoutes(workflows, tierEnv, (tier) => deps.routeOf(undefined, tierEnv, tier, PI_WIRES, undefined, cut))) {
      if ("why" in routed) tierUnreachable.set(tier, routed.why);
      else tierRoutes.set(tier, routed);
    }
    const learnedKeys = await learnedDecisionKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, workflows, (provider) => gate.permissions.policy(provider) !== "deny");
    holdClaimed(cut, learnedKeys);
    underClaimed(toolEnv, learnedKeys);
  }
  // A replay run's or a shadow's grader (runner/compare-end.ts), on a route of its own beside the session's, on the
  // session's booking under the run's one cap. None: the pair is compared whole, in words saying so. None for a held run
  // its model kept from running, whose model runs nowhere.
  const graderRoute = (launch.replay || launch.audit) && heldRefusal === undefined ? await graderRouteOf(body as RevisionBody & { learning?: unknown }, keyed, runKey, toolEnv, cut, log, { ...deps, handBack: run.handBack, signal: run.signal }, [cut], claim) : undefined;
  if (graderRoute) tierRoutes.set(GRADER, graderRoute);

  // The tool host's install lifecycle: what a binding registers to run in each conversation's creating commit, once the
  // Harness is open before the session, and at the run's end (the browser tool's reconcile and release hang off these). The
  // adapter loop runs them from the spec's `lifecycle` (adapter-loop.ts hostLifecycle).
  const life = hostLifecycle();
  // The claim's computers' time booked up to now before the run's end or park is written (compute-cost.ts), so the end's
  // cost holds it: the release that deletes them comes after the end.
  const settleComputers = computer.settle;
  if (settleComputers) life.register.beforeRelease(() => settleComputers());

  // The ToolHost the non-hand tools (browser, web, MCP, decisions, monid) bind through (buildToolHost, the one the CLI
  // spec builds too), on the claim's keys and the run's one ledger and redactor.
  // An agent whose computer is a browser the claim started gets the browser tool on that one session (tools.ts).
  const claimBrowser = computer.computer?.kind === "browser" ? computer.computer.browser : undefined;
  const liveAt = await claimLiveAt(deps, claim.runId);
  const host: ToolHost = { ...buildToolHost({ root, workspace: ws.workspace, claim, env: toolEnv, run, store: deps.store, sealKey: deps.sealKey, life, redact: cut, launch, toolSettings: body.toolSettings, ...(fakes ? { fakes } : {}), ...reach, ...(liveAt ? { liveAt } : {}), ...(deps.saveSlots ? { saveSlots: deps.saveSlots } : {}) }), ...(claimBrowser ? { browserComputer: claimBrowser } : {}) };
  gate.askedOn(host);

  // The run's tools. The hands (read/write/edit/bash and the background tools) are the kernel registry's over the run's
  // Workspace and computer (runTools.hostTools); the gate is the adapter loop's own (spec.gate), so they run as asked.
  const results: ToolResults = new Map();
  const handTools = tools.hostTools(withKindTools(granted, tools), { results, writes: gate.writes(), opsRefused: gate.opsRefused() });
  // The non-hand tools run on the claim's keys (host.env), so a vendor's error may echo one: each answer, and a throw's
  // words, pass the run's one redactor before the harness, the model or the record has them.
  const tiers = new Map<string, LearnedTier>([...[...tierRoutes].filter(([tier]) => !isSubagentRoute(tier) && tier !== GRADER).map(([tier, { model }]): [string, LearnedTier] => [tier, { model }]), ...[...tierUnreachable].map(([tier, why]): [string, LearnedTier] => [tier, { why }])]);
  // The gate asks a learned_workflow call about its workflow's MCP nodes (adapterRunGate).
  gate.learn(workflows);
  // The run's monid endpoints (monid-run.ts), one host tool each from its revision's pin, on the claim's keys and beside
  // its MCP tools in the loop's one catalog seam; their answers pass the run's one redactor as the other non-hand tools'.
  const monid = monidForClaim(revisionRow.monidPin ?? undefined, toolEnv, () => ws.workspace, claim.runId, () => launch.maxCostUsd !== undefined, fakes?.monid);
  const catalog = withMonid(mcp, monid && { ...monid, tools: monid.tools.map((tool) => answersCut(tool, cut)) });
  const nonHandTools = (await bindNonHandTools(host, revision.kind, granted, run, context, results, root, launch.plane, workflows, native, gate.permissions, tiers, catalog, () => route.model, replay)).map((tool) => answersCut(tool, cut));
  const sessionTools = [...handTools, ...nonHandTools];

  // The run's system prompt, as main's per-run process builds it (app.ts): the environment line first (environment.ts, as
  // pi installs it before every other section), then the revision's instructions with what the agent learned laid in
  // (learning.ts laidLearned, from the launch's learning start — the # Learned section decided once at launch, so the runner
  // reads no learning rows), its own skills through skills.ts promptOf, the output schema it answers in (answer-json.ts
  // outputContract, the CLI spec's too), then the effort guidance (the launch's effort, never this process's environment).
  // The one path for every harness.
  // A start whose seed failed tells the run nothing: it is never asked what to keep (learning-end.ts drops it).
  const laid = start && !seedFailed(start) ? laidLearned(body.instructions ?? "", start.section) : (body.instructions ?? "");
  // A computer the claim did not start (every tool of it set to deny: ClaimComputer.off) has its kind's skill named to no one.
  const skills = computer.off ? withoutKindSkill(currentSkills, body.skills ?? {}, settingOfDefinition(body)?.computer.kind) : currentSkills;
  const instructions = await promptOf(laid, skills, ws.workspace, { onDemand: movedProject || readsFiles(granted) });
  const guidance = effortGuidance(launch.effort);
  // The run's clock: a template eval case's (EvalFakes.now), else the real one.
  const now = fakes?.now;
  // A run's own process reads no trigger's row: its runner answers the zone (held.ts runZone).
  const seam = deps.sealKey ? undefined : runnerSeam();
  const zone = seam ? await seam.runZone() : await runZone(deps.store, launch.inputOrigin);
  const system =[environmentLine(now, zone), checkout?.note, instructions, outputContract(body.outputSchema), guidance].filter((line): line is string => Boolean(line));

  // The subagent tool, one of the session's own tools (no extension of its own): a child's tools are a subset of the
  // revision's grants (each by its session name: an MCP tool's wire name, the browser's registrations), its model the
  // agent's own or one of the tiers resolved above.
  if (revision.kind === "agentic" && granted.includes(SUBAGENT_TOOL)) {
    const browserNames = native.filter((extension) => extension.name !== "ask_person").flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
    piTools.push(subagentTool({
      granted,
      sessionNames: (grant) => (grant === BROWSER_TOOL ? browserNames : catalogSessionNames(catalog, grant)),
      tier: (tier) => {
        const why = tierWhy.get(tier);
        if (why !== undefined) return { why };
        // A tier with no model of its own (no model_tiers, no AGENT_MODEL_<TIER>): the agent's own model.
        const at = tierRoutes.get(subagentRoute(tier));
        if (!at) return { ref: { provider: PORT_PROVIDER, modelId: route.model } };
        // A capped run never sends a request it cannot price: an unpriced tier refuses the call, and the run goes on. A
        // ChatGPT plan's tier is not unpriced: it costs the run no dollars (capModelOf).
        if (at.unpriced && !at.provider.plan && launch.maxCostUsd !== undefined) return { why: `${at.model} has no known price here, so this run's cost cap cannot hold its requests.` };
        return { ref: { provider: tierProvider(subagentRoute(tier)), modelId: at.model } };
      },
      preamble: environmentLine(now, zone),
    }));
  }

  // The level pi thinks at: the launch's effort (the run's own, else its revision's, else the host's), every level pi's
  // agent takes; none, pi's default.
  const thinking = thinkingLevel(launch.effort);
  const session: SessionSpec = {
    key: `run:${claim.runId}`,
    label: runRow.agentId,
    system,
    tools: sessionTools,
    context: "fresh",
    ...(thinking ? { thinking: thinking as SessionSpec["thinking"] } : {}),
    // The run's model's window, from its route's catalog entry: pi holds every tool result to its share (boundPiResult).
    ...(route.contextWindow ? { contextWindow: route.contextWindow } : {}),
  };

  // The person's first message: the start body's content, with the run's file manifest beside it (run-manifest.ts), read
  // through the run's Workspace (Mode 2: its inputs/ on the disk, never a folder of this machine).
  // A typed input's other fields follow its content as one json block (inputMessage).
  const input = await firstMessage(inputMessage(launch.input), ws.workspace);

  // The run's end-of-run step, when it learns (learningEndOfRun from the launch's learning start; none otherwise): the
  // compile turn and the owner's correction over the run's store, asked in the end turn while the claim is held
  // (adapter-loop.ts stepOf), its draft checked against the seed in the agent's learning rows.
  // A replay run or an audit's shadow run learns nothing at its end: it is the promotion's, never the agent's to learn
  // from. With a grader it compares its answer with the other one (runner/compare-end.ts), on its own cap.
  // A run the promoted workflow answered (path `workflow`) starts its shadow audit after the step, drawn at 1 in k (runner/audit.ts
  // withAudit): at its end, so the shadow's cap is what the run's own left.
  // A held run (no audits) takes none, and its runner refuses one too (run-child-host.ts heldFor).
  const endOfRun = audits === undefined ? undefined : launch.replay || launch.audit ? withGrader(compareEndOfRun(launch, { store: deps.store, log, redact: run.redact }), graderRoute ? { model: graderRoute.model, models: () => run.ledger.models(GRADER, GRADER) } : undefined) : withAudit(learningEndOfRun(launch, {
    store: deps.store,
    data: deps.data,
    ...(deps.env ? { env: deps.env } : {}),
    // What the run must never learn beside the runner's secrets: the keys its claim handed it, every secret the server
    // keeps sealed (storeSecrets: the run's redactor holds the same list), and its sign-in's pointers, read back from the
    // store's sign-ins under the seal key (learning-run.ts refused, on the runner).
    signIns: deps.sealKey ? signInReads(deps.store, deps.sealKey) : heldSignInReads(),
    handed: runnerSecrets(toolEnv),
    stored: () => storeSecrets(deps.store, deps.sealKey, deps.data),
    log,
    // A workflow draft's decision nodes are checked against the host's decision providers, on its keys (LS-07).
    decisionProviders: async () => decisionProvidersIn({ ...(deps.env ?? {}), ...(await hostDecisionKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, DECISION_PROVIDER_KEYS)) }),
  }), { ...audits, launch, redact: run.redact });

  return {
    adapter,
    facts,
    // Who keeps the run's visible record: its runner says (none: the adapter, as pi keeps its own).
    ...(runner.record ? { record: runner.record } : {}),
    session,
    input,
    ...modelRetryOf([route, ...tierRoutes.values()]),
    // A trigger's first input is its origin's, the launch's own owner flag kept (run-launch.ts keepInputOrigin).
    ...(launch.inputOrigin ? { inputOrigin: launch.inputOrigin } : {}),
    // The gate's answer with its words (adapterRunGate, RunGate.decide): a deny names where it was set and that nothing was
    // sent or charged, and a pinned MCP tool's call outside its pin is refused before it is asked or sent.
    gate,
    runCap,
    // The answer's schema: a miss is asked again once (adapter-loop.ts, the output contract's retry).
    ...(body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {}),
    ...(cap ? { cap } : {}),
    // Its routes, as its GenAI trace names them (otel/genai.ts): the session's, and each tier's by its name.
    // And the agent the run is of (its id and name; the loop cuts them).
    trace: {
      ...traceOfRoute(route),
      routes: new Map([...tierRoutes].map(([tier, routed]) => [tier, traceOfRoute(routed)])),
      agent: await agentOfRun(deps.store.agents, runRow.agentId),
    },
    // The run's MCP for a harness with its own client (mcp-run.ts), with its monid endpoints beside it (monid-run.ts):
    // the catalog tools the session mounts; absent when none.
    ...(catalog ? { mcp: catalog } : {}),
    // The run's own model key: a command row opens it again before the next model request (a message's new key).
    ...(runKey ? { modelKey: runKey } : {}),
    // The run's end-of-run step, when it learns (the spec's, which the loop prefers over its deps': adapter-loop.ts stepOf).
    ...(endOfRun ? { endOfRun } : {}),
    ...(start ? { learningLaid: laidOf(seedLaid) } : {}),
    ...(workflowFirst ? { workflowFirst } : {}),
    ...(workflowRevise ? { workflowRevise } : {}),
    // The tool host's install lifecycle (its bindings' onConversation/beforeResume/beforeRelease), run by the adapter loop.
    lifecycle: life,
    agentId: runRow.agentId,
    // An audit's shadow run waits on no one: where it would park (an approval, a raise of its cap, a person's answer) it
    // ends at once, its row `parked` (runner/audit.ts).
    ...(launch.audit ? { neverWaits: AUDIT_PARKED } : {}),
    // The run's computer as the claim made it, with the person's hold on a desktop or phone: the loop shows the hold up,
    // applies a take-over and a hand-back to it, and answers the computer call channel's rows on it.
    ...(loopComputer ? { computer: loopComputer } : {}),
    // A desktop or a phone as a codemode script gets it: the script's `computer`, over the run's computer tools, its
    // declarations without the ops the gate refuses whatever their arguments.
    ...(tools.computer ? { scriptComputer: { ...tools.computer, opsRefused: gate.opsRefused() } } : {}),
    // A computer that replaced an earlier claim's: the model is told once, on its next request (the loop's computer note).
    ...(computer.replaced ? { computerNote: computerReplacedNote(computer.replaced) } : {}),
    // A desktop or a phone that holds none of the run's files: the model is told once in the run where they are, or, where
    // the gate would refuse a save (RunGate.writeBar), that a screenshot can't be saved to them.
    ...(tools.apart ? { computerFilesNote: computerFilesNote({ ...tools.apart, writes: gate.writes(), outlives: computer.outlives === true }) } : {}),
    workRoot: root,
    // The end's cost: its booking's, by the one rule every reader of an ended run's cost takes (metrics.ts runCostOf):
    // every model request its session's proxy booked (pi's own answers and its side calls: a learned workflow's nodes,
    // web_search's hosted search with its fee), its paid tool calls (a Parallel search's, a monid call's, a person's
    // browser time, each booked in its own session) and its decisions (a learned workflow's decision nodes, LS-07; one
    // that reported none is unknown, never the cap's hold for it). A request a cancel or a stop cut while it streamed is
    // booked at no known cost (the provider may bill what it streamed), so the run's cost is unknown, never the $0 its cut
    // answer carries. One cheap read, apart from the metrics below, so metrics that run late never take the cost with them.
    endCost: async () => endCostOf(runCostOf((await journalEntries(deps.journal(claim), context)) as never)),
    // The end's metrics, from the run's journal, as the old per-run end path read them (metrics.ts runMetrics =
    // runs.ts storedMetrics). A pi run adds its effort, no model (metrics.ts).
    endPatch: async () => {
      // The root's entries and every conversation a task of the run owns (a subagent's): a child's requests are the run's.
      const entries = await agentEntriesOf(deps.journal(claim), context);
      // The path it took, the learned revision it ran on, its learned workflow calls and why its first choice served or
      // did not, for a run that learns (workflow-first.ts pathMetrics), by the one writer every harness's end calls
      // (runPathMetricsOverStore).
      const path = await runPathMetricsOverStore(deps.store, claim.runId, launch, { redact: run.redact, choice: firstChoice.reason });
      // A run its learned workflow served first: that call is on the loop's record (no pi answer carries its tokens), so its
      // metrics are its booking's, as a CLI harness's run reads them: the workflow's nodes and the agent's own after a handback.
      // An MCP tool called by a hashed wire name is counted under its catalog name, as its timeline names it.
      const catalog = await hashedMcpOf(deps.store, claim.runId);
      // Its model requests as every session of its journal booked them: how they were priced (costBasis, which the sums
      // over runs read), and, for a run its learned workflow served, its tokens.
      const booked = bookedSpend((await journalEntries(deps.journal(claim), context)) as never, "model");
      const { metrics } = servedOf(entries as never)
        ? { metrics: cliRunMetrics(piShaped(entries as never), booked, { ...(launch.effort !== undefined ? { effort: launch.effort } : {}), model: launch.model ? `${launch.model.provider}/${launch.model.modelId}` : route.model, catalog }) }
        : runMetrics(entries as never, { ...(launch.effort !== undefined ? { effort: launch.effort } : {}), catalog });
      // Its cost is endCost's, read apart (an unknown one written as null, never left out: a follow-up's end clears the
      // cost an earlier end stored).
      return { metrics: { ...metrics, ...path, costBasis: costBasisOf(booked) } };
    },
    // A run started with hold: true holds its computer for its owner (computer-held.ts): the loop waits for their start
    // and release, and runs their calls on it.
    ...(heldComputer ? { held: heldComputer } : {}),
    // The pass's resources go once the loop writes nothing more through them: its tools' end (background processes ended,
    // scratch swept), its computer let go, then its Workspace's end (Mode 2 sweeps the exec spill).
    // The run's Archil mount credential is revoked at its end on every outcome, even with no computer (the computer's
    // release revokes it too; revoke is idempotent, so a second call is a no-op). A run that minted none revokes nothing.
    // At a park, a desktop or a phone is kept for the resume instead (spec-holds.ts SpecHolds.release `parked`), its mount
    // credential with it, and the run's timeline is told so once its row is written (keep: a park that keeps nothing
    // says nothing of a keep). A computer the gate turned off is not kept (spec-holds.ts Held.computerOff), so the
    // timeline says nothing of keeping it and no row is written.
    keptWords: () => (computer.keeps === undefined || gate.computerOff() ? undefined : computerKeptWords(computer.keeps)),
    ...(computer.keeps && computer.keepRow ? { keep: () => computer.keepRow!() } : {}),
    release: (how) => holds.release(how),
    ...(movedProject ? { projectCheckpoint: projectCheckpointForRun({ store: deps.store, agentId: runRow.agentId, claim, launch, tools, computer,
      workspace: { data: deps.data, sealKey: deps.sealKey, env: deps.env, control: { ...deps.mountControl, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) } },
      secrets: async () => runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data)),
    }, () => { remoteProjectCapture = true; }) } : {}),
    endCheckout: () => holds.endCheckout(),
  };
}

/** The host-tool ctx a non-hand tool is wrapped with (host-tools.ts hostToolOf): the run's own Harness (its commit,
 *  snapshot and task reads), the results map, and the run's folder as the api env's cwd (a tool reads no
 *  file environment, so an error names a path relative to it). Shared by the pi spec's bindNonHandTools and the CLI spec's
 *  learned_workflow. */
export function hostToolCtxOf(run: AdapterRun, context: Context, results: ToolResults, root: string): HostToolCtx {
  return {
    context,
    results,
    env: async () => ({ cwd: root }) as never,
    commit: (change, at, options) => run.harness.commit(change, at, options),
    snapshot: ((...args: unknown[]) => Reflect.apply(run.harness.snapshot, run.harness, args)) as ToolExecutionApi["snapshot"],
    // Never on the call's signal (durableWait): an abort while it registers rejects this wait, never one unhandled.
    waitForTask: (id, at) => durableWait((bare) => run.harness.waitForTask(id, bare), at),
    agent: async (at) => {
      const conversation = await run.harness.conversation(ROOT_CONVERSATION_ID, at);
      if (!conversation) throw new Error("the run has no root conversation");
      return conversation.agent(at);
    },
  };
}

/** Whether a run has the learned_workflow tool, by main's rule (app.ts): its revision is agentic and its agent learned
 *  a workflow it may run (`workflows`: the claim's seed lay chose them, runner/learning-seed.ts). A revision never names
 *  the tool among its own: the run has it beside them, so the harness is told of it as of theirs. */
export const learnsWorkflows = (kind: string, workflows: readonly LearnedWorkflow[]): boolean => kind === "agentic" && workflows.length > 0;

/** A tier a learned workflow's node names, as the run has it: its model's id, or why it could not be reached. */
export type LearnedTier = { readonly model: string } | { readonly why: string };

/** The tiers other than the default that `workflows`' model nodes and `llm` calls name (model.ts nodeTiers, llmTiers),
 *  in TIERS order. A workflow that does not parse names none: its call refuses it. */
export function learnedTiers(workflows: readonly LearnedWorkflow[]): Tier[] {
  const named = new Set<Tier>();
  for (const flow of workflows) {
    let doc: Workflow;
    try {
      doc = JSON.parse(flow.workflow) as Workflow;
      const nodes = workflowNodes(doc, inspectWorkflow(doc));
      for (const tier of llmTiers(nodes, nodeTiers(nodes))) named.add(tier);
    } catch {
      continue;
    }
  }
  return TIERS.filter((tier) => tier !== "default" && named.has(tier));
}

/** The route of each tier `workflows` name (learnedTiers) that `env` names a model of its own for (tierModelOf:
 *  AGENT_MODEL_FAST, AGENT_MODEL_STRONG), through `routeOf` (the run's one route, as its own model's): the model a node
 *  of that tier runs on, priced at its own price. A tier with no model of its own is left out (its nodes run on the
 *  run's model); one whose route is refused is `why`, so its nodes fail in those words and never run on another model. */
export async function learnedTierRoutes(workflows: readonly LearnedWorkflow[], env: NodeJS.ProcessEnv, routeOf: (tier: Tier) => Promise<ModelRoute>): Promise<Map<Tier, ModelRoute | { why: string }>> {
  const routes = new Map<Tier, ModelRoute | { why: string }>();
  for (const tier of learnedTiers(workflows)) {
    if (tierModelOf(env, tier) === undefined) continue;
    try {
      routes.set(tier, await routeOf(tier));
    } catch (error) {
      routes.set(tier, { why: String((error as Error)?.message ?? error).slice(0, 300) });
    }
  }
  return routes;
}

/** The run's learned_workflow tool as a HostTool, listed when the run has it (learnsWorkflows: an agentic revision whose
 *  agent learned workflows, by learning.ts chooseWorkflows as main's start chooses them, so the tool set the model sees
 *  matches main). `granted`, the revision's own tools, are the ones its workflows' call nodes may call. Every run's session — pi's and every CLI harness's — has a model
 *  port, so its model nodes run on the session's proxied models (run.ledger.models, port-models.ts: read at each
 *  request, labelled learned_workflow), each a request on the run's one route, booked on the run's one ledger and priced
 *  by the session's policy. Its call nodes run the agent's tools' effects on `env`, the run's scoped keys. */
export async function learnedWorkflowHostTool(opts: {
  readonly run: AdapterRun;
  /** The revision's kind: only an agentic revision's run has the tool. */
  readonly kind: string;
  readonly granted: readonly string[];
  readonly plane: RunLaunch["plane"];
  readonly env: NodeJS.ProcessEnv;
  readonly work: string;
  readonly workflows: readonly LearnedWorkflow[];
  /** The run's gate's permissions (adapterRunGate): each call node's tool is held to them, as main holds it. */
  readonly permissions: RunPermissions;
  readonly ctx: HostToolCtx;
  /** The run's models of other tiers (pi's: learnedTierRoutes), by tier: a node of one runs on that model, through the
   *  session's port of the tier (AdapterSession.port's `tier`); one with `why` fails in those words. A tier not here runs
   *  on the session's model. */
  readonly tiers?: ReadonlyMap<string, LearnedTier>;
  /** The claim's MCP (mcp-run.ts mcpForClaim), when its revision grants an MCP tool: its call nodes may name its tools by
   *  catalog name, each run through the run's own MCP as the loop wraps it. */
  readonly mcp?: Pick<ClaimMcp, "tools" | "catalogOf">;
  /** The run's own Workspace (Mode 2: its folder on the run's disk): a decision node's images are read through it. */
  readonly workspace?: Workspace;
  /** The model a node on the session's own port runs on (a node of no tier, or of a tier not in `tiers`), as the run's
   *  route names it: what its trace says it ran on. A node of a tier in `tiers` names that tier's model. */
  readonly modelName?: (tier: string | undefined) => string | undefined;
  /** A replay run's call nodes (runner/promotion.ts replayCallsFor): never a write run, reads cached. Absent: live. */
  readonly replay?: ReplayCalls;
}): Promise<HostTool | undefined> {
  if (!learnsWorkflows(opts.kind, opts.workflows)) return undefined;
  const flows = opts.workflows;
  const tiers = opts.tiers ?? new Map<string, LearnedTier>();
  // Each MCP tool of the run by its catalog name, to the name the session's tools hold it by: what an MCP node calls,
  // nested in the workflow's call.
  const mcpTools = new Map((opts.mcp?.tools ?? []).flatMap((one) => {
    const catalog = opts.mcp!.catalogOf(one.name);
    return typeof catalog === "string" ? [[catalog, one.name] as const] : [];
  }));
  const byProvider = new Map([[PORT_PROVIDER, await opts.run.ledger.models(LEARNED_WORKFLOW_TOOL)]]);
  for (const [tier, model] of tiers) if ("model" in model) byProvider.set(tierProvider(tier), await opts.run.ledger.models(LEARNED_WORKFLOW_TOOL, tier));
  const modelOf = (tier: string | undefined) => {
    const model = tier === undefined ? undefined : tiers.get(tier);
    if (model === undefined) return { provider: PORT_PROVIDER, modelId: "session" };
    if ("why" in model) throw new Error(`the run's ${tier} model could not be reached: ${model.why}`);
    return { provider: tierProvider(tier!), modelId: model.model };
  };
  // Its decision nodes (LS-07) on the decision providers the run's keys give (decisions.ts decisionProvidersIn over `env`,
  // the claim's own), each booked on the run's one cap (ledger.decisions) and a refusal of it pausing the run
  // (ledger.pause). A run whose keys give none runs no decision node: the check refuses it before any node runs.
  const providers = await decisionProvidersIn(opts.env);
  const decisions = providers ? { decisions: { providers, book: opts.run.ledger.decisions, pause: (refusal: Refusal) => opts.run.ledger.pause(refusal) } } : {};
  // A call node's native web_search goes through the session's port too, labelled web_search, as the run's own does.
  const tool = learnedWorkflowTool({ workflows: flows, granted: opts.granted, ...(opts.plane ? { plane: opts.plane } : {}), env: opts.env, work: opts.work, models: tieredModels(byProvider) as never, modelOf, search: () => opts.run.ledger.models(WEB_SEARCH_TOOL), policy: opts.permissions.policy, denyFrom: opts.permissions.denyFrom, refresh: opts.permissions.refresh, mcpTools, nestedOf: (callId) => nestedBy.get(callId), ...decisions, ...(opts.workspace ? { workspace: opts.workspace } : {}), ...(opts.modelName ? { modelName: opts.modelName } : {}), ...(opts.replay ? { replay: opts.replay } : {}) });
  const host = hostToolOf(LEARNED_WORKFLOW_TOOL, tool as never, opts.ctx);
  if (!host) return undefined;
  // The tool nests calls (HostTool.nests): its MCP nodes are the session's tools called nested in it, which the harness
  // hands each call (`nested`), each asked at the gate and recorded as its own; it runs again whole after a park or a
  // crash, each node answered as it was the first time.
  const nestedBy = new Map<string, NestedCalls>();
  return {
    ...host,
    nests: true,
    async call(args, context) {
      if (context.nested) nestedBy.set(context.callId, context.nested);
      try {
        return await host.call(args, context);
      } finally {
        nestedBy.delete(context.callId);
      }
    },
  };
}

/** The run's non-hand tools as HostTool[], bound through the ToolHost seam and wrapped as the hands are (host-tools.ts
 *  hostToolOf): web_fetch, web_search and monid, each by its catalog name under the adapter loop's one gate (`spec.gate`;
 *  `gated` is undefined here, as for the hands). Their paid requests are booked by the adapter loop on the run's one ledger
 *  (bookedIn), as main books them, so they run. The browser (through host.liveViewers), MCP (the MCP claim step's
 *  mcpForClaim(claim, store, sealKey, pin) -> { sessionMcp, release }), the learned workflow and decisions are
 *  each a named todo, added as their seams land. */
/** The run's live-viewer writers over the store (browser-live.ts): a session's hand-over written sealed, and gone. Its
 *  viewer token, minted in the run, is held by `cut`, the run's one redactor, as it is handed over, before it is written. */
export function liveViewersOf(store: LiveViewerStore, sealKey: Buffer | undefined, claim: Claim, cut: HeldRedact): { put(handover: LiveHandover): Promise<boolean>; drop(tag?: string): Promise<void> } {
  return {
    put: (handover) => {
      cut.hold([handover.token]);
      // A run's own process holds no seal key: its runner seals the hand-over under the claim (held.ts).
      return sealKey ? putLiveViewer(store, sealKey, claim, handover) : heldOrThrow("a browser viewer's hand-over").liveViewerPut(handover);
    },
    drop: (tag) => (sealKey ? dropLiveViewer(store, claim, tag) : heldOrThrow("a browser viewer's drop").liveViewerDrop(tag)),
  };
}

/** `tool` with its answer's text, and a throw's message, cut by `cut` (the run's one redactor). A web call's answer is cut
 *  string by string inside its JSON (tools.ts webAnswerCut), so what the harness stores still parses and keeps its links
 *  whole for a grader's link check; one whose strings, read joined, hold a held value split across two of them is
 *  "[redacted]". */
export function answersCut(tool: HostTool, cut: Redact): HostTool {
  return {
    ...tool,
    call: async (args, context) => {
      try {
        const answer = await tool.call(args, context);
        return { ...answer, text: webAnswerCut(cut)(tool.name, answer.text) ?? cut(answer.text) };
      } catch (error) {
        if (error instanceof Error) {
          error.message = cut(error.message);
          if (error.stack) error.stack = cut(error.stack);
          throw error;
        }
        throw new Error(cut(String(error)));
      }
    },
  };
}

/** The ToolHost a run's non-hand tools bind through, the one both the pi spec and the CLI spec build: the run's folder and
 *  the claim's environment (claim-secrets.ts: the run's keys from the store, its plane set), the run's registry for an
 *  extension a binding installs, the install lifecycle (`life`, run by the adapter loop from the spec's `lifecycle`), the
 *  store, claim and seal key, the run's one ledger and its one redactor, the live-viewer seam the browser's writers hand a
 *  session's viewer over through (the store, never files), and the run's own Workspace (`workspace`: in Mode 2 its folder
 *  on the run's disk), where a tool files what the run's read finds later. */
export function buildToolHost(opts: {
  readonly root: string;
  readonly workspace: Workspace;
  readonly claim: Claim;
  readonly env: NodeJS.ProcessEnv;
  readonly run: AdapterRun;
  readonly store: Store & LiveViewerStore;
  /** The runner's seal key; none in a run's own process, whose sealed reads its runner makes (held.ts). */
  readonly sealKey: Buffer | undefined;
  readonly life: ReturnType<typeof hostLifecycle>;
  readonly redact: HeldRedact;
  /** The run's launch (its trigger and origin) and its agent's own tool settings, as the email tools read them. */
  readonly launch?: Pick<RunLaunch, "trigger" | "inputOrigin">;
  readonly toolSettings?: unknown;
  /** The run's template eval fakes, where the eval's own runner gives them (AdapterSpecDeps.evalFakes). */
  readonly fakes?: EvalFakes;
  /** The server is a local install (AdapterSpecDeps.mcpLoopback): calendar_events may read a calendar on loopback. */
  readonly loopback?: boolean;
  /** That server's own addresses (AdapterSpecDeps.mcpOwn): never the ports calendar_events reads on loopback. */
  readonly own?: readonly string[];
  /** A runner on another host than its server: where the run's viewers answer, under its run's key (claimLiveAt). */
  readonly liveAt?: RunnerLive;
  /** web_save's download slots (AdapterSpecDeps.saveSlots). */
  readonly saveSlots?: SaveSlots;
}): ToolHost {
  const { root, claim, run, life, liveAt } = opts;
  const { web, now, email } = opts.fakes ?? {};
  return {
    ...(web ? { web } : {}),
    ...(now ? { now } : {}),
    ...(email ? { emailFake: email } : {}),
    ...(opts.loopback ? { calendarLoopback: true } : {}),
    ...(opts.own ? { serverOwn: opts.own } : {}),
    ...(opts.saveSlots ? { saveSlots: opts.saveSlots } : {}),
    // The run's directory and its per-claim environment: the hands come from runTools, so the non-hand tools get the run's
    // environment only.
    where: { root, work: root, ref: { id: claim.runId } },
    env: opts.env,
    install: (extension) => run.registry.install(extension),
    onConversation: life.register.onConversation,
    beforeResume: life.register.beforeResume,
    beforeRelease: life.register.beforeRelease,
    personWait: life.register.personWait,
    // The run row's summary staged on a commit of the run's (a hand-over's wait, its claim held: run.needs_input).
    ...(run.rowSummaryOn ? { rowSummaryOn: run.rowSummaryOn } : {}),
    store: opts.store,
    claim,
    ...(opts.sealKey ? { sealKey: opts.sealKey } : {}),
    // The run's one ledger, as the adapter loop made it over the run's sessions and handed it on the AdapterRun: the
    // browser holds and settles its calls here (host.ledger.paid), never on this process's own spend, and a refusal at the
    // cap parks the run (pause). browserListed reads it to fail closed.
    ledger: run.ledger,
    // A native web_search's models: the session's port under a side key labelled web_search, so the search request goes
    // through the run's one route (its proxy, policy, key, price and cap), this run's alone (#2458).
    search: () => run.ledger.models(WEB_SEARCH_TOOL),
    // The run's one redactor: the browser's answers pass it inside their call, before pi stores them (tools.ts).
    redact: opts.redact,
    liveViewers: liveViewersOf(opts.store, opts.sealKey, claim, opts.redact),
    // A runner on another host than its server (AGENTRUN_RUNNER_LIVE_HOST): its browser's viewer answers there.
    ...(liveAt ? { liveAt } : {}),
    // What a tool files for the run's read (monid's whole answer past the model's cut) goes in the run's own Workspace, the
    // one its hands read: in Mode 2 its folder on the run's disk, never the local folder at `root`.
    workspace: opts.workspace,
    // The trigger that started the run, and the agent's own settings: an email's run reads its thread alone (email/tools.ts).
    ...(opts.launch?.trigger && opts.launch.inputOrigin?.kind === "trigger" ? { startedBy: { trigger: opts.launch.trigger, source: opts.launch.inputOrigin.source } } : {}),
    ...(opts.toolSettings !== undefined ? { toolSettings: opts.toolSettings } : {}),
  };
}

/** Where the claim's viewers answer on a runner on another host than its server (live-reach.ts runnerLiveOf), under the
 *  claim's run's own proof key (liveForRun); none on the server's machine. In a run's own process its runner's
 *  (held.ts liveAt): the process holds its run's key, never the runners' shared one. */
export async function claimLiveAt(deps: Pick<AdapterSpecDeps, "env" | "sealKey">, runId: string): Promise<RunnerLive | undefined> {
  if (deps.sealKey) {
    const live = runnerLiveOf(deps.env ?? {}, deps.sealKey);
    return live && liveForRun(live, runId);
  }
  const given = await runnerSeam()?.liveAt();
  return given && { host: given.host, bind: given.bind, key: Buffer.from(given.key) };
}

/** The run's web host tools (tool-list.ts `host` rows: web_fetch, web_search, monid) as HostTool[], each bound through `host` by its
 *  catalog name and wrapped as the hands are (host-tools.ts hostToolOf, with `ctx`), the one binding the pi spec and the
 *  CLI spec share. Each runs under the adapter loop's one gate (spec.gate) on the claim's keys (host.env), and books its
 *  paid requests on the run's one ledger itself (bookedIn): they carry no settle of their own. */
export async function webHostTools(host: ToolHost, granted: readonly string[], ctx: HostToolCtx): Promise<HostTool[]> {
  const tools: HostTool[] = [];
  for (const name of granted.filter(isWebHostTool)) {
    const entry = toolOf(name);
    if (!entry) continue;
    const binding = await entry.bind(host);
    for (const registration of binding.tools) {
      const tool = hostToolOf(name, registration, ctx);
      if (tool) tools.push(tool);
    }
  }
  return tools;
}

/** `host` for the browser's binding: its vendor the launch's plane (resolved when the run was created, runs-over-store.ts
 *  planeFor) checked again against the keys this claim read from the store (recheckPlane, which keeps the plane's Jev
 *  off), as both specs bind it. */
function browserHostOf(host: ToolHost, plane: RunLaunch["plane"]): ToolHost {
  const checked = plane ? recheckPlane(plane, host.env) : {};
  const env = { ...host.env };
  delete env[TOOL_PLANE_ENV];
  if (Object.keys(checked).length) env[TOOL_PLANE_ENV] = JSON.stringify(checked);
  return { ...host, env };
}

/** The browser on a harness other than pi (the CLI spec): tools.ts's own binding on this run's ToolHost, as pi's native
 *  route binds it (its store, claim and seal key, its live viewers, its money on host.ledger, its computer the claim's),
 *  its durable extension installed in the run's registry (host.install), so its documents and its release and hand-over
 *  tasks are the run's Harness's, and its reconcile, release and drain on the host's lifecycle (the spec's `lifecycle`).
 *  Each of its registrations is a host tool (host-tools.ts hostToolOf, RUNS_ONCE: a call a crash cut off is answered
 *  interrupted, its session left to the next claim's reconcile), under the adapter loop's one gate (spec.gate), which
 *  holds each to the table's `browser` (tool-gate.ts BROWSER_REGISTRATIONS). None unless browserListed. */
export async function browserHostTools(host: ToolHost, granted: readonly string[], plane: RunLaunch["plane"], ctx: HostToolCtx): Promise<HostTool[]> {
  if (!browserListed(host, granted)) return [];
  const binding = await toolOf(BROWSER_TOOL)!.bind(browserHostOf(host, plane));
  return binding.tools.flatMap((registration) => hostToolOf(BROWSER_TOOL, registration, ctx, RUNS_ONCE) ?? []);
}

async function bindNonHandTools(host: ToolHost, kind: string, granted: readonly string[], run: AdapterRun, context: Context, results: ToolResults, root: string, plane: RunLaunch["plane"], workflows: readonly LearnedWorkflow[], native: Extension[], permissions: RunPermissions, tiers: ReadonlyMap<string, LearnedTier>, mcp?: ClaimMcp, modelName?: (tier: string | undefined) => string | undefined, replay?: ReplayCalls): Promise<AdapterRunSpec["session"]["tools"]> {
  // Fail closed (browserListed): the browser binds only on the native route (BROWSER_ON_RUNNER) and with the claim's
  // one-ledger booking on its ToolHost (host.ledger.paid); otherwise its extension is not installed. learned_workflow
  // binds below with no web tool, so a learned run with no web tool still lists it.
  const browser = browserListed(host, granted);
  // The host-tool ctx the non-hand tools are wrapped with (hostToolCtxOf): the run's own Harness and the run's folder as
  // the api env's cwd. The gate is the adapter loop's own (spec.gate).
  const ctx = hostToolCtxOf(run, context, results, root);
  const tools: HostTool[] = await webHostTools(host, granted, ctx);

  // learned_workflow, listed when the run has it (learnsWorkflows, as main lists it: no grant asked of the revision), in
  // the session's tools the harness is told of: its model nodes run on the session's proxied models (run.ledger.models),
  // each a request on the run's one route labelled learned_workflow. The agent's scoped keys (host.env) are its call
  // nodes'.
  const learned = await learnedWorkflowHostTool({ run, kind, granted, plane, env: host.env, work: root, workflows, permissions, ctx, tiers, ...(mcp ? { mcp } : {}), ...(host.workspace ? { workspace: host.workspace } : {}), ...(modelName ? { modelName } : {}), ...(replay ? { replay } : {}) });
  if (learned) tools.push(learned);

  // The browser (tl-browser), on pi's native route: tools.ts's own binding on this run's ToolHost (its store, claim and seal
  // key, its live viewers through the store, its sign-in read under the claim, its money on host.ledger), its vendor the
  // launch's plane (resolved when the run was created, runs-over-store.ts planeFor) checked again against the keys this
  // claim read from the store (recheckPlane, which keeps the plane's Jev off). Its durable extension goes to piAdapter
  // (`native`), never wrapped as a HostTool and never installed here too (piAdapter installs it once); its lifecycle (the
  // Config per conversation, reconcile, the release drain) through the host's hooks into the spec's lifecycle.
  if (browser) await toolOf(BROWSER_TOOL)!.bind({ ...browserHostOf(host, plane), install: (extension) => void native.push(extension) });

  // TODO (decisions, option (a)): a pi run's decision tools book on the run's ONE cap (runCap's run.decisions), which the
  // adapter loop makes from its own sessions and hands the spec at open — the loop passes { decisions, models } the same way
  // it passes spec.lifecycle. The decision providers come from the claim's secrets (claim-secrets.ts). Wired against that
  // seam when it lands; never a second journalSessions + runCap over the one journal (the double-book we closed).
  return tools;
}

/** What a claim's MCP servers and calendar_events may reach on loopback (mcpForClaim's and buildToolHost's `loopback` and
 *  `own`): nothing unless mcpLoopback; else loopback, never at mcpOwn's ports nor mcpOwnOf's, read now. Read once per
 *  claim. */
export async function mcpReachOf(deps: Pick<AdapterSpecDeps, "mcpLoopback" | "mcpOwn" | "mcpOwnOf">): Promise<{ loopback?: true; own?: readonly string[] }> {
  if (!deps.mcpLoopback) return {};
  const own = [...(deps.mcpOwn ?? []), ...((await deps.mcpOwnOf?.()) ?? [])];
  return { loopback: true, ...(own.length ? { own } : {}) };
}
