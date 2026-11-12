// The runner's pi spec (design 2.1: "the runner takes every run"). What app.ts built for a run it launched — the run's
// workspace, its computer, its tools, its model route, its spend cap and its end metrics — built here instead, from the
// run's launch record and its revision, and handed to the kernel's adapter loop (adapter-loop.ts) as one AdapterRunSpec.
// The dispatch switch (dispatch.ts resolve) runs a pi run on `createAdapterLoop((claim, run) =>
// adapterRunSpecFromLaunch(launch, run, deps, claim))`.
//
// The one ledger (B2c): pi's model requests go through the session's proxy, booked by the runner's booking under the
// run's cap; the cap prices a request as main's calculateCost does (tiers included), on the hold and the booking. The
// tools are the kernel registry's hands on the run's Workspace (runTools), and — once built through the ToolHost below —
// tools.ts's full set (browser, web, MCP, decisions, monid) by their own names. The gate before a call's intent is the
// run's revision's tool settings, read through runGate (approvals "never" among them), the adapter loop asking it.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, type Extension, ROOT_CONVERSATION_ID, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { beforeRequestOf, type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import { inspectWorkflow, type Workflow } from "@parcha/agentrun-dsl";
import type { BeforeRequest, HostTool, Refusal, SessionSpec, Wire } from "@parcha/agentrun-kernel";
import { decisionProvidersIn } from "../decisions.js";
import type { Approvals } from "../approvals.js";
import type { installForClaim, installSettled } from "../harness-install.js";
import type { LiveHandover, LiveViewerStore } from "../browser-live.js";
import { dropLiveViewer, putLiveViewer } from "../browser-live.js";
import { llmTiers, nodeTiers, type PinnedModel, type Tier, thinkingLevel, TIERS, tierModelOf, workflowNodes } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import { learningStartOf, seedFailed, type RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { isObject } from "../validate.js";
import { deniedText, mcpServersOf, noApproverText, type Permission, type RunFiles, runGate, type SettingFrom } from "../tool-gate.js";
import { DECISION_PROVIDER_KEYS, loadToolSettings, recheckPlane, TOOL_PLANE_ENV } from "../tool-plane.js";
import { readApprovers } from "../server-approvers.js";
import { ASK_TOOL, askPerson, type ToolHost, toolOf } from "../tools.js";
import { type HostToolCtx, hostToolOf } from "../host-tools.js";
import { WEB_FETCH_TOOL } from "../web-fetch.js";
import { WEB_SEARCH_TOOL } from "../web-search.js";
import { environmentLine } from "../environment.js";
import { effortGuidance } from "../effort-guidance.js";
import { laidLearned, type LearnedWorkflow, learningFolderOf, secretsShown } from "../learning.js";
import { laidOf, layLearningSeed } from "./learning-seed.js";
import { learningWorkspace } from "../learn/folder.js";
import { learningEndOfRun } from "./learning-end.js";
import { learnedAskFits, learnedAskShown, LEARNED_WORKFLOW_TOOL, learnedMcpTools, learnedWorkflowTool } from "../learned-workflow.js";
import { PORT_PROVIDER, tieredModels, tierProvider } from "../port-models.js";
import { promptOf, readsFiles } from "../skills.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { layOwnSkills } from "../workspace/revision-skills.js";
import { COMPUTER_ROOT, runFolder } from "../workspace/paths.js";
import { runTools, type ToolResults, withKindTools } from "../workspace/run-tools.js";
import { copyRunFiles } from "../uploads.js";
import { handedSignInReadsBack, signInReads } from "../sign-ins-store.js";
import { UNREADABLE_SIGN_IN } from "../run-view.js";
import { claimSecrets, hostDecisionKeys, learnedDecisionKeys, savedModelKeys, tierModelKeys, withModelKeys } from "./claim-secrets.js";
import { type ClaimMcp, mcpForClaim } from "./mcp-run.js";
import { join } from "node:path";
import { type AdapterRun, type AdapterRunSpec, hostLifecycle, type RunCapConfig } from "./adapter-loop.js";
import { piAdapter } from "./adapters/pi.js";
import { agentEntriesOf } from "./loop.js";
import { SUBAGENT_TIERS, SUBAGENT_TOOL, type SubagentTier, subagentTool } from "./subagent.js";
import { wireName } from "../catalog.js";
import { type Claim, ClaimRefused, type Journal } from "./loop-contract.js";
import { bookedSpend, runEndCost, runMetrics } from "./metrics.js";
import { journalEntries } from "./journal-reader.js";
import { type SpecHolds, specBuilt } from "./spec-holds.js";
import type { ModelRoute, RouteCost } from "./model-route.js";
import { archilClaim, type ArchilClaimOptions, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { loadArchilSettings } from "../archil-settings.js";
import type { ComputerSetting } from "../computer-setting.js";
import { type claimComputer, type ComputerDeps, computerReadyWords, imageWaitWords } from "../workspace/computer-deps.js";
import type { RunComputer } from "../workspace/run-tools.js";
import type { ShellPlace } from "../workspace/resolve-computer.js";
import type { Workspace } from "../workspace/workspace.js";
import { type HeldRedact, heldRedactor, holdClaimed, runnerSecrets, secretRedactor } from "./redact.js";
import { githubAppAccess } from "./github-app.js";
import { type Checkout, prCheckoutForClaim } from "./pr-checkout.js";
import { holdStored, storeSecrets } from "./store-secrets.js";
import { bashPolicyOf } from "../bash-read-only.js";

/** What a claim gives the shared computerForClaim: the run, its epoch, its revision, its place and any computer choice. */
export interface ClaimLaunch {
  readonly runId: string;
  readonly epoch: number;
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
  release(): Promise<void>;
}
/** The one shared claim-time computer every spec takes (computer-for-claim.ts), passed in by the runner: the composer's
 *  (workspace/computer-deps.ts computerDepsFrom), or a test's stand-in. */
export type ComputerForClaim = typeof claimComputer;

/** The wires pi speaks on the runner: main's pi's (provider.ts), Anthropic's Messages and OpenAI's Responses. */
export const PI_WIRES: readonly Wire[] = Object.freeze(["anthropic-messages", "openai-responses"]);

/** The browser's catalog name (tools.ts TOOLS.browser). */
const BROWSER_TOOL = "browser";
/** Whether the runner offers the browser at all: on pi's native route (PiAdapterOptions.extensions), where pi-browser's
 *  durable extension runs in the claim's Harness, its tools pi's own tool tasks (their memo, task and conversations). */
export const BROWSER_ON_RUNNER = true;
/** Whether the runner installs the browser for a run whose revision grants `granted`, or whose computer is a browser
 *  (host.browserComputer), fail closed: only on the native route (BROWSER_ON_RUNNER), and only with the run's ledger
 *  booking on its ToolHost (host.ledger.paid), so no browser call is held on this process's own spend. */
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
  /** The key the store's live-viewer tokens are sealed under (store/seal.ts). */
  readonly sealKey: Buffer;
  /** The run's model route (model-route.ts routeOf), the one route the pi adapter and the cap read, on a wire of `wires`
   *  (the caller's; pi speaks both of main's, PI_WIRES). */
  readonly routeOf: (model: string | PinnedModel | undefined, env: NodeJS.ProcessEnv, tier?: Tier, wires?: readonly Wire[], upstream?: typeof fetch, redact?: (text: string) => string) => Promise<ModelRoute>;
  /** The run's log line (what its Workspace and computer have to say that is not a run failure). */
  readonly log?: (message: string) => void;
  /** For tests: a learning run's grade bound, as a signal (learning-dispatch.ts gradeBound). Default: GRADE_TIMEOUT_MS. */
  readonly gradeBound?: () => AbortSignal;
  /** The one shared claim-time computer (computer-for-claim.ts), for both the pi and the CLI spec: none for a runner place.
   *  The runner gives it; a test gives its own. */
  readonly computerForClaim: ComputerForClaim;
  /** What the runner gives computerForClaim once (its kind registry, provider makers, computer spec, keys and settings). */
  readonly computerDeps: ComputerDeps;
  /** A Mode 2 claim's Archil disk (a test's fake); absent, the real disk the Archil settings name. */
  readonly makeArchilDisk?: ArchilClaimOptions["makeDisk"];
  /** The Archil mount credential's control plane, for a test's loopback fake (archilControlFake): its base URL and the
   *  fetch to call it with, spread into the claim's mount. Absent, the real control plane the mount credential names. No
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
}

/** A model as the cap prices it, from the route's catalog cost: its price WITH TIERS (the money rule — a request past a
 *  model's tier is held and booked at the tier, as main's calculateCost does). `api` is the proxy's shape, for the
 *  overhead its provider adds; the output ceiling is the route's when it carries one, else none. */
export function capModelOf(route: ModelRoute): CapModel {
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
  return { id: route.model, api: route.provider.api, price, outputCeiling: route.outputCeiling ?? null };
}

/** The key of a subagent tier's route in a run's tier routes and proxies (a key of its own, never a learned workflow's
 *  tier: those nodes keep their own route and fallback). */
const SUBAGENT_ROUTE = "subagent-";
const subagentRoute = (tier: SubagentTier): string => `${SUBAGENT_ROUTE}${tier}`;
const isSubagentRoute = (key: string): boolean => key.startsWith(SUBAGENT_ROUTE);

/** The revision's body, as the fields the spec reads of it (agentic runs only reach here; a workflow run is dispatched to
 *  the workflow loop). */
type RevisionBody = {
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly toolSettings?: unknown;
  readonly harness?: string;
  readonly approvals?: Approvals;
  readonly skills?: Record<string, unknown>;
  /** What the server checks out in the run's folder before its first turn (pr-checkout.ts). */
  readonly checkout?: Checkout;
  /** The revision's own model ("provider/model-id"), absent for the host's. */
  readonly model?: string;
  /** The model of each of its tiers it names (a subagent's: runner/subagent.ts), absent for the host's tier model. */
  readonly modelTiers?: Readonly<Partial<Record<SubagentTier, string>>>;
};

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
 */
/** The run's tool permissions as a learned workflow's call nodes are held to them (learned-workflow.ts policy, denyFrom,
 *  refresh): the same gate as the run's own calls, its settings read again from the store before each call node. */
export type RunPermissions = {
  readonly policy: (tool: string) => Permission;
  readonly denyFrom: (tool: string) => SettingFrom;
  readonly refresh: () => Promise<void>;
  /** The gate's whole decision of one call with its arguments (RunGate.decide: its deny, its argument pins, its ask or a
   *  refusal where no one can approve), as the run's own call of the tool gets it: a learned workflow's MCP node's. */
  readonly decide: (tool: string, args: unknown) => Promise<"allow" | "ask" | { deny: string }>;
};

export async function adapterRunGate(store: Pick<Store, "settings">, claim: Pick<Claim, "runId">, revision: { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals; maxToolCalls?: number } }, root: RunFiles, shell?: ShellPlace, mcpServers: readonly string[] = []): Promise<NonNullable<AdapterRunSpec["gate"]> & { readonly permissions: RunPermissions; readonly learn: (flows: readonly LearnedWorkflow[]) => void }> {
  let current = await storeSettings(store);
  const approvers = await readApprovers(store.settings);
  // A Workspace's paths are in the run's folder: its folder named as a computer names it, for the gate's path checks.
  const folder = typeof root === "string" ? root : COMPUTER_ROOT;
  // Where the run's shell is (run-tools.ts shell): with no computer, a tool no setting names takes the kernel's ruled
  // default (tool-gate.ts defaultPermission): bash asks first, the background tools are refused. The run's MCP servers
  // (mcpServersOf its grants), so a harness naming an MCP tool its own way (OpenCode's `<server>_<tool>`) is held to that
  // tool's settings, never to a table tool's of the same shape.
  const gate = runGate({ root: folder, work: folder, ...(shell === undefined ? {} : { computer: shell === "computer" }), mcpServers }, claim.runId, revision, () => current, approvers);
  // The run's learned workflows, once its spec has read them (learn): a learned_workflow call is asked about its MCP nodes.
  let learned: readonly LearnedWorkflow[] = [];
  const decide = async (call: Parameters<NonNullable<AdapterRunSpec["gate"]>>[0], options: Parameters<NonNullable<AdapterRunSpec["gate"]>>[1] = {}) => {
    current = await storeSettings(store);
    const decision = await gate.decide(call.tool, call.args, options);
    // A learned workflow's MCP nodes are the run's own MCP calls, held to the same settings, decided for the whole call
    // before any node runs, never mid-run: one set to deny refuses the call in the gate's words, nothing sent; one set to
    // ask asks for the call, up front, on the run's one card (a running workflow can't park mid-call: it is never run
    // again after a crash), and the person's allow lets that call's MCP nodes run, and only that call's.
    // Checked whether the learned_workflow call is itself allowed or asked: a workflow that can't run is never put to a
    // person.
    if ((call.tool as string) !== LEARNED_WORKFLOW_TOOL || typeof decision === "object") return decision;
    const tools = await mcpOf(call.args);
    const refused = (why: string) => ({ deny: `The learned workflow ${String((call.args as { name?: unknown }).name)} was not run: ${why}` });
    const denied = tools.find((tool) => gate.policy(tool) === "deny");
    if (denied) return refused(deniedText(denied, undefined, gate.denyFrom(denied)));
    const asks = tools.filter((tool) => gate.policy(tool) === "ask");
    // An ask no one can answer (the server's accounts off) is refused at once in the gate's words, never parked.
    if (asks.length && !approvers) return refused(noApproverText(asks[0]!, "no"));
    // A card that could not name every MCP tool the person would approve (past its preview's bound) is never shown: the
    // call is refused, so no allow covers a tool its approver did not see.
    if (asks.length && !learnedAskFits(asks)) return refused(`its approval card can't name all ${asks.length} MCP tools it would call that are set to ask: set some of them to allow or deny for this agent.`);
    return asks.length ? "ask" : decision;
  };
  /** The MCP tools the learned workflow a learned_workflow call names can call; none for another call or workflow. */
  const mcpOf = async (args: unknown): Promise<string[]> => {
    const flow = learned.find((one) => one.name === (args as { name?: unknown } | undefined)?.name);
    return flow ? learnedMcpTools(flow.workflow) : [];
  };
  // An ask is named as main's pending approval is (RunGate.askedAs: its settings key), beside the decision, which is
  // unchanged. The permissions are the learned workflow's (main's toolGate.policy and denyFrom), over the same settings.
  const permissions: RunPermissions = { policy: (tool) => gate.policy(tool), denyFrom: (tool) => gate.denyFrom(tool), refresh: async () => { current = await storeSettings(store); }, decide: (tool, args) => gate.decide(tool, args) };
  // What a learned_workflow call's card shows beside its own input: every MCP tool set to ask that the workflow can call,
  // and that their arguments are decided while it runs, so the person sees what they approve.
  const askedFor = async (tool: string, args: unknown): Promise<Record<string, unknown> | undefined> => {
    if (tool !== LEARNED_WORKFLOW_TOOL) return undefined;
    const asks = (await mcpOf(args)).filter((one) => gate.policy(one) === "ask");
    return asks.length ? learnedAskShown(asks) : undefined;
  };
  // The revision's tool-call budget (tool-budget.ts), which the adapter loop holds each conversation's calls to.
  const toolCalls = revision.body.maxToolCalls;
  return Object.assign(decide, { askedAs: (tool: string) => gate.askedAs(tool), askedFor, permissions, learn: (flows: readonly LearnedWorkflow[]) => void (learned = flows), ...(toolCalls === undefined ? {} : { toolCalls }) });
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

/** pi's spec for a claimed run. What it makes for the run (its Archil mount credential, its Workspace, its computer, its
 *  tools) is held until the spec's release; a build that throws part-way lets go what it made by then (spec-holds.ts). */
export function adapterRunSpecFromLaunch(launch: RunLaunch, run: AdapterRun, deps: AdapterSpecDeps, claim: Claim): Promise<AdapterRunSpec> {
  return specBuilt((holds) => adapterSpec(launch, run, deps, claim, holds));
}

async function adapterSpec(launch: RunLaunch, run: AdapterRun, deps: AdapterSpecDeps, claim: Claim, holds: SpecHolds): Promise<AdapterRunSpec> {
  const context = BACKGROUND_CONTEXT;
  // The runner's one redactor (the loop's, LoopDeps.redact), for every text a secret could reach: the spec's log lines
  // (a release, a workspace's end), the model route's translation and the session's model proxy. A spec built with no
  // runner around it cuts every secret the runner's env holds. It holds the keys the claim opens (below), too.
  const cut = heldRedactor(run.redact ?? secretRedactor(runnerSecrets(deps.env)));
  const log = (line: string) => (deps.log ?? (() => {}))(cut(line));
  holds.logTo(log);
  const runRow = await deps.store.runs.get(claim.runId);
  if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
  // A run handed a browser sign-in this runner can't read back (its seal does not open here, or nothing of it is kept):
  // what it said could repeat a pointer nothing can cut, so it ends failed at its claim, in main's words (runs.ts).
  if (!(await handedSignInReadsBack(deps.store, deps.sealKey, runRow))) throw new ClaimRefused(UNREADABLE_SIGN_IN);
  const revisionRow = await deps.store.agents.revision(runRow.revisionId);
  if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
  const body = (revisionRow.body ?? {}) as RevisionBody;
  const revision = { kind: revisionRow.kind, body } as { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals; maxToolCalls?: number } };
  const granted = body.tools ?? [];

  // The run's mode is the server's: Mode 2 where its Archil settings are saved (archil-settings.ts), the run's folder then
  // on the claim's Archil disk (archil-claim.ts: its keys from the store's sealed rows, under the runner's seal key, in this
  // claim's memory only); else Mode 1, the run's local folder. The same for the pi and the CLI spec.
  const archilSettings = await loadArchilSettings(deps.store);
  const mode: 1 | 2 = archilSettings === undefined ? 1 : 2;
  const archil = archilSettings === undefined
    ? undefined
    // The run's mount credential is minted per run the first time a computer's mount asks (archil-mount-credential.ts), on
    // the account key from the server's environment first, then the sealed row; named for the run and this claim's epoch, with
    // a 24 h ttl as the safety net if revoke never comes (revoke normally runs at the run's end, below). A run with no
    // mounting computer never mints one.
    // The mint is lazy (archil-claim.ts token(), k2's run-tools.ts): only a mounting computer asks for it, so a Mode 2 run
    // with no computer makes no control-plane call. mountControl (a test's loopback control-plane fake) is spread into the
    // mount, so no test reaches the real control plane. MOUNT_TTL_MS is the credential's safety net (its computer's 24 h bound), not its lifetime.
    : await archilClaim({ settings: archilSettings, keys: deps.store.sealedKeys, sealKey: deps.sealKey, signal: run.signal ?? new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS, ...(deps.mountControl ?? {}) }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) });
  // Each resource is held the moment it exists (spec-holds.ts): a throw after it lets it go.
  holds.hold({ archil });
  // The run's Workspace at the claim: Mode 1 the run's local folder (made here, the server's start made it before); Mode 2
  // the run's folder on the disk.
  const ws = archil === undefined
    ? await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log })
    : await openRunWorkspace({ mode: 2, agentId: runRow.agentId, runId: claim.runId, archil, log });
  holds.hold({ ws });

  // The run's uploaded files, copied into its work/inputs/ before the first turn, from what its start held for it, once
  // per run (uploads.ts copyRunFiles); a copy that fails ends the run failed, saying why.
  if (launch.files?.length) await copyRunFiles(deps.data, claim.runId, ws.workspace, launch.files);

  // The pull request's checkout, when the revision asks for one (pr-checkout.ts): the server's own fetch before the first
  // turn, with the GitHub App's read-only token for that one repository (or none); the run is told what it holds, or why
  // there is none. Held from the fetch's start, so the release (after the tools' end) removes it however the claim ends; a
  // person's stop ends the fetch at once (run.stopped).
  const checkout = body.checkout === "pull_request" ? await prCheckoutForClaim(deps, ws.workspace, launch, cut, run.stopped ?? run.signal, (part) => holds.hold({ checkout: part })) : undefined;
  holds.hold({ checkout });

  // The run's MCP for this claim (mcp-run.ts mcpForClaim): its pin made at the first claim or read as written, its
  // credentials opened under the server's seal key into this claim's memory, one gateway for the claim. First, before
  // anything the spec would have to let go: a refusal (a pin that cannot be made, a pinned meta tool) ends the run in its
  // words before the session opens. The seal key is the runner's own (deps.sealKey), not re-read from the environment.
  const mcp = await mcpForClaim({ claim, store: deps.store, sealKey: deps.sealKey, grants: granted, harness: run.harness, work: () => ws.workspace, launchInput: launch.input, githubAppAccess: (store, key, input) => githubAppAccess(store, key, input, { ...(deps.githubApi ? { api: deps.githubApi } : {}), fromGitHub: launch.inputOrigin?.kind === "trigger" && launch.inputOrigin.source === "github", hold: (values) => cut.hold(values) }), ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}) });
  // The claim's MCP goes to the loop, which lets it go; a build that throws lets it go itself.
  holds.hold({ passed: mcp });

  // The run's computer, from the one shared claim-time function (the CLI spec takes the same): none for a runner place, a
  // Docker container for a sandbox, under the claim's epoch (the one fence). It throws computer_unavailable (nothing made)
  // when the computer cannot be had: the run fails in its words.
  const computer = await deps.computerForClaim(
    { runId: claim.runId, epoch: claim.epoch, revisionId: runRow.revisionId, place: launch.place, ...((launch as { computer?: ComputerSetting }).computer !== undefined ? { computer: (launch as { computer?: ComputerSetting }).computer } : {}) },
    deps.store,
    // revokeMount removes the run's Archil mount credential when the computer is released (and if a start fails after a mint);
    // the run's end revokes it too (below), so it goes on every outcome even when no computer is made. Idempotent.
    { ...deps.computerDeps, mode, workspace: ws.workspace, sealKey: deps.sealKey, ...(archil ? { revokeMount: () => archil.revoke() } : {}), ...(run.phase ? { onImageWait: (making, image) => run.phase?.(imageWaitWords(making, image)), onConnected: (said) => run.phase?.(computerReadyWords(said)) } : {}) },
  );

  // The run's shell is its computer's (600 s) where one mounts its folder; with none, Archil's serverless exec in Mode 2
  // (295 s), and in Mode 1 none at all: no bash family, its folder being one of this server's own (run-tools.ts).
  // A desktop's or a phone's hold (the person's take-over) wraps its ports: a call made while the person holds it waits,
  // and the agent's hand-over (computer_request_handoff) asks the person through it.
  holds.hold({ computer });
  // Under the agent's bash policy, its shell's environment is the policy's too (bash-read-only.ts policyEnv).
  const bashPolicy = bashPolicyOf(body.toolSettings);
  const tools = await runTools(ws.workspace, computer.computer, { mode, context, ...(computer.hold ? { hold: computer.hold } : {}), ...(bashPolicy === undefined ? {} : { bashPolicy }) });
  holds.hold({ tools });

  // The run's model route: its model through routeOf (NEVER re-resolved — the launch's model, pinned at start), the catalog
  // price with tiers for the cap, and the proxy's price (pi-ai calculateCost, tiered).
  // pi speaks both of main's wires: an OpenAI-family model's route is OpenAI's Responses itself.
  // The runner's one redactor (run.redact) goes to the route's translation and to the session's model proxy: a provider's
  // error that echoes a secret reaches pi's record with none in it, on any route.
  // The run's secrets for this claim, read from the one store (never this process's environment or a pipe): the keys its
  // tools unlock and its model needs, scoped to the run as the old per-run environment was, so one run's keys never reach
  // another's on this runner (claim-secrets.ts). MCP credentials are the other per-claim secret and come through mcp-claim.
  const toolEnv = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, revisionRow as unknown as Parameters<typeof claimSecrets>[1], launch);
  // The keys it opened join the run's one redactor before any tool or model request can echo one.
  holdClaimed(cut, toolEnv);
  // The route reads its model's key from the runner's environment, else the one the claim opened from the store: a key
  // saved in Settings → Model keys runs the next run with no restart (withModelKeys).
  const modelEnv = withModelKeys(deps.env, toolEnv);
  const route = await deps.routeOf(modelAskOf(launch.model, body.model), modelEnv, "default", PI_WIRES, undefined, cut);
  // The run's models of other tiers, for its learned workflows' nodes of a tier (learnedTierRoutes, filled once the seed's
  // lay chose the workflows, below): read when the session opens (pi.ts options.tiers), each on a proxy of its own.
  const tierRoutes = new Map<string, ModelRoute>();
  // The run's pi-native extensions, in the root agent through the pi adapter (PiAdapterOptions.extensions), which installs
  // them in the claim's registry and offers each tool once:
  // - ask_person is pi's own tool (tools.ts): a run granted it carries its native extension, so pi runs it as its own tool
  //   task under the session's gate and keeps its control.terminate — the turn ends on the person's question and the loop
  //   parks the run (endedOnTurnEndingTool), or, with the browser's session open, waits for the answer in its claim
  //   (adapter-loop waitInClaim, the browser's personWait below). It stays out of the session's host tools and REPLAY, so a CLI harness still
  //   refuses it (runnable.ts). pi only.
  // - the browser's durable extension, when the run gets one (bindNonHandTools, below, before the session opens).
  const native: Extension[] = granted.includes(ASK_TOOL) ? [defineExtension({ name: "ask_person", tools: [askPerson] })] : [];
  // pi-native tools in the session's own extension (PiAdapterOptions.tools): the subagent tool, pushed below.
  const piTools: ToolRegistration[] = [];
  // A run granted subagent (runner/subagent.ts): the model of each of its tiers, the revision's own (modelTiers) else the
  // host's for the tier (AGENT_MODEL_FAST, AGENT_MODEL_STRONG), each on a route of its own (its proxy on the session's
  // booking, adapters/pi.ts tiers). A tier with neither is the agent's own model, as a learned workflow's node of it runs
  // on the run's. A tier no route can be made for here is no failure of the run: a call on it answers why. A tier's model may be another
  // provider's than the run's own, whose key claimSecrets never opened (it scopes the claim's keys to the run's model): so
  // its route reads every model key the server holds (savedModelKeys). Those reach the tier's proxy alone, as its
  // credential, never the run's tools (toolEnv).
  // Each is in tierRoutes under its own key (subagentRoute: never a learned workflow's tier, whose nodes keep their own
  // routes and fallback), on a proxy of its own that names that key on each request, so the cap prices a child's
  // requests as that route books them.
  const tierWhy = new Map<SubagentTier, string>();
  if (revision.kind === "agentic" && granted.includes(SUBAGENT_TOOL)) {
    const savedKeys = await savedModelKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env });
    holdClaimed(cut, savedKeys);
    const tierEnv = withModelKeys(deps.env, { ...savedKeys, ...toolEnv });
    for (const tier of SUBAGENT_TIERS) {
      if (body.modelTiers?.[tier] === undefined && tierModelOf(tierEnv, tier) === undefined) continue;
      try {
        tierRoutes.set(subagentRoute(tier), await deps.routeOf(body.modelTiers?.[tier], tierEnv, tier, PI_WIRES, undefined, cut));
      } catch (error) {
        tierWhy.set(tier, cut(error instanceof Error ? error.message : String(error)));
      }
    }
  }
  const adapter = piAdapter({
    run,
    // Read when the session opens (pi.ts), so the browser's extension pushed by bindNonHandTools below is in it.
    extensions: native,
    tools: piTools,
    model: route.model,
    provider: route.provider,
    redact: cut,
    ...(route.like ? { like: route.like } : {}),
    ...(route.price ? { price: route.price as never } : {}),
    ...(route.fetch ? { fetch: route.fetch } : {}),
    tiers: tierRoutes,
  });

  // The gate before a call's intent: the run's revision's tool settings through runGate (approvals "never" turns the one
  // ask it leaves into an allow). The adapter loop asks `gate` and handles the ask/park/answer on the journal itself, so
  // only the permission is read here, never runGate's own file-based approval flow.
  const root = runFolder(deps.data, runRow.agentId, claim.runId);
  // The gate names the run's folder by its Workspace (Mode 2: its folder on the run's disk, never this machine's folder at
  // the same path), for its path checks; it reads nothing in it.
  const gate = await adapterRunGate(deps.store, claim, revision, ws.workspace, tools.shell, mcpServersOf(granted));

  // The run's one cap, as the loop's runCap reads it (adapter-loop.ts RunCapConfig): the launch's cap figure (undefined
  // uncapped — every paid request still books through the one cap), the run's model priced WITH tiers, strict where the
  // launch says. The loop builds the kernel runCap from these over the run's own sessions (its model requests, its paid
  // tool calls and its decisions all on one rule and one booking), so the spec carries no beforeRequest of its own.
  const capUsd = launch.maxCostUsd;
  const capModel = capModelOf(route);
  // And each tier's model (tierRoutes, filled below), by the route its request names (its tier's proxy, ModelRequest.route),
  // priced as that route books it: one id the run's model and a tier share is priced apart, never at the other's price.
  const runCap: RunCapConfig = {
    capUsd: () => launch.maxCostUsd,
    modelOf: (id, by) => {
      if (by === undefined) return id === route.model ? capModel : undefined;
      const tierRoute = tierRoutes.get(by);
      return tierRoute && tierRoute.model === id ? capModelOf(tierRoute) : undefined;
    },
    ...(launch.capMode === "strict" ? { mode: "strict" as const } : {}),
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

  // The launch's learning start (none: the run does not learn), decided once at launch.
  const start = learningStartOf(launch);
  // The revision's own skills are laid in the run's .agents/skills/ before they are read (main's server start laid them;
  // on the one store the claim does), from the revision row's texts (the body keeps only each file's SHA-256): each
  // folder not there yet, never over a learned skill or an earlier claim's.
  await layOwnSkills(ws.workspace, (revisionRow.skills ?? {}) as Record<string, string>, { computer: (launch as { computer?: ComputerSetting }).computer?.kind });
  // A learning run's seed, read once from its learning folder where the run's place keeps it: its notes in .learning/
  // and its learned skills beside the revision's own (runner/learning-seed.ts), cut of the server's secrets, the learned
  // skills then in the skill list the prompt names, its learned workflows the ones its learned_workflow tool runs. Laid
  // before the run's tools are bound. A learning fault, or a seed that failed (seedFailed), lays nothing.
  const seedLaid = start && !seedFailed(start)
    ? await layLearningSeed({
      work: ws.workspace,
      seed: start.seed,
      folder: () => (archil === undefined ? learningFolderOf(deps.data, runRow.agentId) : learningWorkspace({ mode: "archil", agentId: runRow.agentId, archil })),
      own: Object.keys(revisionRow.skills ?? {}),
      shown: async () => secretsShown(runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data)), { local: true }),
      log,
    })
    : undefined;
  // The decision keys its learned workflows' typed questions need (claim-secrets.ts learnedDecisionKeys), read once the lay
  // chose them, scoped as the revision's own: each provider the run's gate does not deny, held by the run's one redactor,
  // onto the tools' environment alone. The model's route was built on the revision's keys above, so a decision key never
  // becomes its model's.
  const workflows = seedLaid?.workflows ?? [];
  // A tier a learned workflow's node names and the host has a model of: none can't be reached is left as `why`, and its
  // node fails in those words (learnedWorkflowHostTool), never on another model.
  const tierUnreachable = new Map<Tier, string>();
  if (learnsWorkflows(revision.kind, workflows)) {
    // The keys those tiers' models need (tierModelKeys: a key saved in Settings too, which claimSecrets opened only for the
    // run's own model), held by the run's one redactor, on the tiers' route env alone (withModelKeys, never enumerable),
    // never on the tools' (toolEnv).
    const tierKeys = await tierModelKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, learnedTiers(workflows));
    holdClaimed(cut, tierKeys);
    const tierEnv = withModelKeys(deps.env, { ...toolEnv, ...tierKeys });
    for (const [tier, routed] of await learnedTierRoutes(workflows, tierEnv, (tier) => deps.routeOf(undefined, tierEnv, tier, PI_WIRES, undefined, cut))) {
      if ("why" in routed) tierUnreachable.set(tier, routed.why);
      else tierRoutes.set(tier, routed);
    }
    const learnedKeys = await learnedDecisionKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, workflows, (provider) => gate.permissions.policy(provider) !== "deny");
    holdClaimed(cut, learnedKeys);
    Object.assign(toolEnv, learnedKeys);
  }

  // The tool host's install lifecycle: what a binding registers to run in each conversation's creating commit, once the
  // Harness is open before the session, and at the run's end (the browser tool's reconcile and release hang off these). The
  // adapter loop runs them from the spec's `lifecycle` (adapter-loop.ts hostLifecycle).
  const life = hostLifecycle();

  // The ToolHost the non-hand tools (browser, web, MCP, decisions, monid) bind through (buildToolHost, the one the CLI
  // spec builds too), on the claim's keys and the run's one ledger and redactor.
  // An agent whose computer is a browser the claim started gets the browser tool on that one session (tools.ts).
  const claimBrowser = computer.computer?.kind === "browser" ? computer.computer.browser : undefined;
  const host: ToolHost = { ...buildToolHost({ root, workspace: ws.workspace, claim, env: toolEnv, run, store: deps.store, sealKey: deps.sealKey, life, redact: cut }), ...(claimBrowser ? { browserComputer: claimBrowser } : {}) };

  // The run's tools. The hands (read/write/edit/bash and the background tools) are the kernel registry's over the run's
  // Workspace and computer (runTools.hostTools); the gate is the adapter loop's own (spec.gate), so they run as asked.
  const results: ToolResults = new Map();
  const handTools = tools.hostTools(withKindTools(granted, tools), results);
  // The non-hand tools run on the claim's keys (host.env), so a vendor's error may echo one: each answer, and a throw's
  // words, pass the run's one redactor before the harness, the model or the record has them.
  const tiers = new Map<string, LearnedTier>([...[...tierRoutes].filter(([tier]) => !isSubagentRoute(tier)).map(([tier, { model }]): [string, LearnedTier] => [tier, { model }]), ...[...tierUnreachable].map(([tier, why]): [string, LearnedTier] => [tier, { why }])]);
  // The gate asks a learned_workflow call about its workflow's MCP nodes (adapterRunGate).
  gate.learn(workflows);
  const nonHandTools = (await bindNonHandTools(host, revision.kind, granted, run, context, results, root, launch.plane, workflows, native, gate.permissions, tiers, mcp, () => route.model)).map((tool) => answersCut(tool, cut));
  const sessionTools = [...handTools, ...nonHandTools];

  // The run's system prompt, as main's per-run process builds it (app.ts): the environment line first (environment.ts, as
  // pi installs it before every other section), then the revision's instructions with what the agent learned laid in
  // (learning.ts laidLearned, from the launch's learning start — the # Learned section decided once at launch, so the runner
  // reads no learning folder), its own skills through skills.ts promptOf, then the effort guidance (the launch's effort,
  // never this process's environment). The one path for every harness.
  // A start whose seed failed tells the run nothing: it is never asked what to keep (learning-end.ts drops it).
  const laid = start && !seedFailed(start) ? laidLearned(body.instructions ?? "", start.section) : (body.instructions ?? "");
  const instructions = await promptOf(laid, [...Object.keys(body.skills ?? {}), ...(seedLaid?.skills ?? [])], ws.workspace, { onDemand: readsFiles(granted) });
  const guidance = effortGuidance(launch.effort);
  const system = [environmentLine(), checkout?.note, instructions, guidance].filter((line): line is string => Boolean(line));

  // The subagent tool, one of the session's own tools (no extension of its own): a child's tools are a subset of the
  // revision's grants (each by its session name: an MCP tool's wire name, the browser's registrations), its model the
  // agent's own or one of the tiers resolved above.
  if (revision.kind === "agentic" && granted.includes(SUBAGENT_TOOL)) {
    const browserNames = native.filter((extension) => extension.name !== "ask_person").flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
    piTools.push(subagentTool({
      granted,
      sessionNames: (catalog) => (catalog === BROWSER_TOOL ? browserNames : [wireName(catalog)]),
      tier: (tier) => {
        const why = tierWhy.get(tier);
        if (why !== undefined) return { why };
        // A tier with no model of its own (no model_tiers, no AGENT_MODEL_<TIER>): the agent's own model.
        const at = tierRoutes.get(subagentRoute(tier));
        if (!at) return { ref: { provider: PORT_PROVIDER, modelId: route.model } };
        // A capped run never sends a request it cannot price: an unpriced tier refuses the call, and the run goes on.
        if (at.unpriced && launch.maxCostUsd !== undefined) return { why: `${at.model} has no known price here, so this run's cost cap cannot hold its requests.` };
        return { ref: { provider: tierProvider(subagentRoute(tier)), modelId: at.model } };
      },
      preamble: environmentLine(),
      ...(revision.body.maxToolCalls !== undefined ? { toolCalls: revision.body.maxToolCalls } : {}),
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
  };

  // The person's first message: the start body's content, with the run's file manifest beside it (run-manifest.ts), read
  // through the run's Workspace (Mode 2: its inputs/ on the disk, never a folder of this machine).
  const content = isObject(launch.input) && typeof (launch.input as { content?: unknown }).content === "string" ? (launch.input as { content: string }).content : "";
  const input = await firstMessage(content, ws.workspace);

  // The run's end-of-run step, when it learns (learningEndOfRun from the launch's learning start; none otherwise): the
  // reflect-and-propose turn over the run's store, asked in the end turn while the claim is held (adapter-loop.ts stepOf).
  // Its learning folder is where the run's place keeps it — Mode 1 the agent's folder under the data directory, Mode 2 the
  // agent's folder on THIS claim's Archil disk (the proposal is checked against the seed on the disk, never this machine's
  // local path) — so the end-of-run step reads the run's own Workspace, the one the run worked in.
  const endOfRun = learningEndOfRun(launch, {
    store: deps.store,
    data: deps.data,
    ...(deps.env ? { env: deps.env } : {}),
    // What the run must never learn beside the runner's secrets: the keys its claim handed it, every secret the server
    // keeps sealed (storeSecrets: the run's redactor holds the same list), and its sign-in's pointers, read back from the
    // store's sign-ins under the seal key (learning-run.ts refused, on the runner).
    signIns: signInReads(deps.store, deps.sealKey),
    handed: runnerSecrets(toolEnv),
    stored: () => storeSecrets(deps.store, deps.sealKey, deps.data),
    // A workflow draft's decision nodes are checked against the host's decision providers, on its keys (LS-07).
    decisionProviders: async () => decisionProvidersIn({ ...(deps.env ?? {}), ...(await hostDecisionKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, DECISION_PROVIDER_KEYS)) }),
    learningFolder: archil === undefined
      ? (agentId: string) => learningFolderOf(deps.data, agentId)
      : (agentId: string) => learningWorkspace({ mode: "archil", agentId, archil }),
  });

  return {
    adapter,
    session,
    input,
    // A trigger's first input is its origin's, the launch's own owner flag kept (run-launch.ts keepInputOrigin).
    ...(launch.inputOrigin ? { inputOrigin: launch.inputOrigin } : {}),
    // The gate's answer with its words (adapterRunGate, RunGate.decide): a deny names where it was set and that nothing was
    // sent or charged, and a pinned MCP tool's call outside its pin is refused before it is asked or sent.
    gate,
    runCap,
    ...(cap ? { cap } : {}),
    // The run's MCP for a harness with its own client (mcp-run.ts), the session the adapter mounts; absent when none.
    ...(mcp ? { mcp } : {}),
    // The run's end-of-run step, when it learns (the spec's, which the loop prefers over its deps': adapter-loop.ts stepOf).
    ...(endOfRun ? { endOfRun } : {}),
    ...(start ? { learningLaid: laidOf(seedLaid) } : {}),
    // The tool host's install lifecycle (its bindings' onConversation/beforeResume/beforeRelease), run by the adapter loop.
    lifecycle: life,
    agentId: runRow.agentId,
    workRoot: root,
    // The end's metrics and cost, from the run's journal, as the old per-run end path read them (metrics.ts runMetrics =
    // runs.ts storedMetrics/costOf). A pi run adds its effort, no model (metrics.ts).
    endPatch: async () => {
      // The root's entries and every conversation a task of the run owns (a subagent's): a child's requests are the run's.
      const entries = await agentEntriesOf(deps.journal(claim), context);
      const { metrics, costUsd } = runMetrics(entries as never, { ...(launch.effort !== undefined ? { effort: launch.effort } : {}) });
      // Its paid tool calls (a Parallel search's, a monid call's, a person's browser time) and its decisions (a learned
      // workflow's decision nodes, LS-07), booked on the run's one ledger (each on its cap, in its own session, not on the
      // root), are the run's cost too; any of them unknown leaves the run's unknown.
      // A decision's cost is what its booking says it charged (bookedSpend over its own session's records, as the CLI spec
      // reads it): one that reported none is unknown, never the hold the cap counted it at (ledger.decisions.spentUsd).
      const decisions = bookedSpend((await journalEntries(deps.journal(claim), context)) as never, "decisions").usd;
      const total = runEndCost({ model: costUsd, paid: run.ledger?.paid ? run.ledger.paid.spentUsd() : 0, decisions });
      return { ...(total !== null ? { costUsd: total } : {}), metrics };
    },
    // The pass's resources go once the loop writes nothing more through them: its tools' end (background processes ended,
    // scratch swept), its computer let go, then its Workspace's end (Mode 2 sweeps the exec spill).
    // The run's Archil mount credential is revoked at its end on every outcome, even with no computer (the computer's
    // release revokes it too; revoke is idempotent, so a second call is a no-op). A run that minted none revokes nothing.
    release: () => holds.release(),
  };
}

/** The host-tool ctx a non-hand tool is wrapped with (host-tools.ts hostToolOf): the run's own Harness (its commit,
 *  snapshot, conversation and task reads), the results map, and the run's folder as the api env's cwd (a tool reads no
 *  file environment, so an error names a path relative to it). Shared by the pi spec's bindNonHandTools and the CLI spec's
 *  learned_workflow. */
export function hostToolCtxOf(run: AdapterRun, context: Context, results: ToolResults, root: string): HostToolCtx {
  return {
    context,
    results,
    env: async () => ({ cwd: root }) as never,
    commit: (change, at, options) => run.harness.commit(change, at, options),
    snapshot: ((...args: unknown[]) => Reflect.apply(run.harness.snapshot, run.harness, args)) as ToolExecutionApi["snapshot"],
    conversation: ((id, at) => run.harness.conversation(id, at)) as ToolExecutionApi["conversation"],
    waitForTask: (id, at) => run.harness.waitForTask(id, at),
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
}): Promise<HostTool | undefined> {
  if (!learnsWorkflows(opts.kind, opts.workflows)) return undefined;
  const flows = opts.workflows;
  const tiers = opts.tiers ?? new Map<string, LearnedTier>();
  const mcpTools = (opts.mcp?.tools ?? []).map((one) => opts.mcp!.catalogOf(one.name)).filter((name): name is string => typeof name === "string");
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
  const tool = learnedWorkflowTool({ workflows: flows, granted: opts.granted, ...(opts.plane ? { plane: opts.plane } : {}), env: opts.env, work: opts.work, models: tieredModels(byProvider) as never, modelOf, policy: opts.permissions.policy, denyFrom: opts.permissions.denyFrom, refresh: opts.permissions.refresh, decide: opts.permissions.decide, mcpTools, ...decisions, ...(opts.workspace ? { workspace: opts.workspace } : {}), ...(opts.modelName ? { modelName: opts.modelName } : {}) });
  return hostToolOf(LEARNED_WORKFLOW_TOOL, tool as never, opts.ctx) ?? undefined;
}

/** The run's non-hand tools as HostTool[], bound through the ToolHost seam and wrapped as the hands are (host-tools.ts
 *  hostToolOf): web_fetch, web_search and monid, each by its catalog name under the adapter loop's one gate (`spec.gate`;
 *  `gated` is undefined here, as for the hands). Their paid requests are booked by the adapter loop on the run's one ledger
 *  (bookedIn), as main books them, so they run. The browser (through host.liveViewers), MCP (the MCP claim step's
 *  mcpForClaim(claim, store, sealKey, pin) -> { sessionMcp, redactions, release }), the learned workflow and decisions are
 *  each a named todo, added as their seams land. */
/** The run's live-viewer writers over the store (browser-live.ts): a session's hand-over written sealed, and gone. Its
 *  viewer token, minted in the run, is held by `cut`, the run's one redactor, as it is handed over, before it is written. */
export function liveViewersOf(store: LiveViewerStore, sealKey: Buffer, claim: Claim, cut: HeldRedact): { put(handover: LiveHandover): Promise<boolean>; drop(tag?: string): Promise<void> } {
  return {
    put: (handover) => {
      cut.hold([handover.token]);
      return putLiveViewer(store, sealKey, claim, handover);
    },
    drop: (tag) => dropLiveViewer(store, claim, tag),
  };
}

/** `tool` with its answer's text, and a throw's message, cut by `cut` (the run's one redactor). */
export function answersCut(tool: HostTool, cut: (text: string) => string): HostTool {
  return {
    ...tool,
    call: async (args, context) => {
      try {
        const answer = await tool.call(args, context);
        return { ...answer, text: cut(answer.text) };
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
  readonly sealKey: Buffer;
  readonly life: ReturnType<typeof hostLifecycle>;
  readonly redact: HeldRedact;
}): ToolHost {
  const { root, claim, run, life } = opts;
  return {
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
    sealKey: opts.sealKey,
    // The run's one ledger, as the adapter loop made it over the run's sessions and handed it on the AdapterRun: the
    // browser holds and settles its calls here (host.ledger.paid), never on this process's own spend, and a refusal at the
    // cap parks the run (pause). browserListed reads it to fail closed.
    ledger: run.ledger,
    // The run's one redactor: the browser's answers pass it inside their call, before pi stores them (tools.ts).
    redact: opts.redact,
    liveViewers: liveViewersOf(opts.store, opts.sealKey, claim, opts.redact),
    // What a tool files for the run's read (monid's whole answer past the model's cut) goes in the run's own Workspace, the
    // one its hands read: in Mode 2 its folder on the run's disk, never the local folder at `root`.
    workspace: opts.workspace,
  };
}

/** The tools of `granted` that bind as web host tools on every harness: web_fetch, web_search and the monid tools. */
export const webToolNames = (granted: readonly string[]): string[] => granted.filter((name) => name === WEB_FETCH_TOOL || name === WEB_SEARCH_TOOL || name.startsWith("monid."));

/** The run's web host tools (webToolNames: web_fetch, web_search, monid) as HostTool[], each bound through `host` by its
 *  catalog name and wrapped as the hands are (host-tools.ts hostToolOf, with `ctx`), the one binding the pi spec and the
 *  CLI spec share. Each runs under the adapter loop's one gate (spec.gate) on the claim's keys (host.env), and books its
 *  paid requests on the run's one ledger itself (bookedIn): they carry no settle of their own. */
export async function webHostTools(host: ToolHost, granted: readonly string[], ctx: HostToolCtx): Promise<HostTool[]> {
  const tools: HostTool[] = [];
  for (const name of webToolNames(granted)) {
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

async function bindNonHandTools(host: ToolHost, kind: string, granted: readonly string[], run: AdapterRun, context: Context, results: ToolResults, root: string, plane: RunLaunch["plane"], workflows: readonly LearnedWorkflow[], native: Extension[], permissions: RunPermissions, tiers: ReadonlyMap<string, LearnedTier>, mcp?: ClaimMcp, modelName?: (tier: string | undefined) => string | undefined): Promise<AdapterRunSpec["session"]["tools"]> {
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
  const learned = await learnedWorkflowHostTool({ run, kind, granted, plane, env: host.env, work: root, workflows, permissions, ctx, tiers, ...(mcp ? { mcp } : {}), ...(host.workspace ? { workspace: host.workspace } : {}), ...(modelName ? { modelName } : {}) });
  if (learned) tools.push(learned);

  // The browser (tl-browser), on pi's native route: tools.ts's own binding on this run's ToolHost (its store, claim and seal
  // key, its live viewers through the store, its sign-in read under the claim, its money on host.ledger), its vendor the
  // launch's plane checked again against the keys this claim read from the store, as main's launch hands its process the
  // plane (runs.ts relaunchPlane). Its durable extension goes to piAdapter (`native`), never wrapped as a HostTool and never
  // installed here too (piAdapter installs it once); its lifecycle (the Config per conversation, reconcile, the release
  // drain) through the host's hooks into the spec's lifecycle.
  if (browser) {
    const checked = plane ? recheckPlane(plane, host.env) : {};
    const env = { ...host.env };
    delete env[TOOL_PLANE_ENV];
    if (Object.keys(checked).length) env[TOOL_PLANE_ENV] = JSON.stringify(checked);
    await toolOf(BROWSER_TOOL)!.bind({ ...host, env, install: (extension) => void native.push(extension) });
  }

  // TODO (decisions, option (a)): a pi run's decision tools book on the run's ONE cap (runCap's run.decisions), which the
  // adapter loop makes from its own sessions and hands the spec at open — the loop passes { decisions, models } the same way
  // it passes spec.lifecycle. The decision providers come from the claim's secrets (claim-secrets.ts). Wired against that
  // seam when it lands; never a second journalSessions + runCap over the one journal (the double-book we closed).
  return tools;
}
