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
import { defineExtension, type Extension, ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { beforeRequestOf, type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { BeforeRequest, HostTool, SessionSpec, Wire } from "@parcha/agentrun-kernel";
import type { Approvals } from "../approvals.js";
import type { LiveHandover, LiveViewerStore } from "../browser-live.js";
import { dropLiveViewer, putLiveViewer } from "../browser-live.js";
import type { PinnedModel, Tier } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import { learningStartOf, type RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { isObject } from "../validate.js";
import { type Permission, type RunFiles, runGate, type SettingFrom } from "../tool-gate.js";
import { loadToolSettings, recheckPlane, TOOL_PLANE_ENV } from "../tool-plane.js";
import { readApprovers } from "../server-approvers.js";
import { ASK_TOOL, askPerson, type ToolHost, toolOf } from "../tools.js";
import { type HostToolCtx, hostToolOf } from "../host-tools.js";
import { WEB_FETCH_TOOL } from "../web-fetch.js";
import { WEB_SEARCH_TOOL } from "../web-search.js";
import { environmentLine } from "../environment.js";
import { effortGuidance } from "../effort-guidance.js";
import { laidLearned, type LearnedWorkflow, learningFolderOf, secretsShown } from "../learning.js";
import { layLearningSeed } from "./learning-seed.js";
import { learningWorkspace } from "../learn/folder.js";
import { learningEndOfRun } from "./learning-end.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowTool } from "../learned-workflow.js";
import { PORT_PROVIDER } from "../port-models.js";
import { promptOf, readsFiles } from "../skills.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { layOwnSkills } from "../workspace/revision-skills.js";
import { COMPUTER_ROOT, runFolder } from "../workspace/paths.js";
import { runTools, type ToolResults, withKindTools } from "../workspace/run-tools.js";
import { INPUTS_DIR, UPLOADS_DIR, Uploads } from "../uploads.js";
import { handedSignInReadsBack, signInReads } from "../sign-ins-store.js";
import { UNREADABLE_SIGN_IN } from "../runs.js";
import { claimSecrets, withModelKeys } from "./claim-secrets.js";
import { mcpForClaim } from "./mcp-run.js";
import { join } from "node:path";
import { type AdapterRun, type AdapterRunSpec, hostLifecycle, type RunCapConfig } from "./adapter-loop.js";
import { piAdapter } from "./adapters/pi.js";
import { entriesOf } from "./loop.js";
import { type Claim, ClaimRefused, type Journal } from "./loop-contract.js";
import { runMetrics } from "./metrics.js";
import { type SpecHolds, specBuilt } from "./spec-holds.js";
import type { ModelRoute, RouteCost } from "./model-route.js";
import { archilClaim, type ArchilClaimOptions, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { loadArchilSettings } from "../archil-settings.js";
import type { ComputerSetting } from "../computer-setting.js";
import { type claimComputer, type ComputerDeps, imageWaitWords } from "../workspace/computer-deps.js";
import type { RunComputer } from "../workspace/run-tools.js";
import type { Workspace } from "../workspace/workspace.js";
import { type HeldRedact, heldRedactor, holdClaimed, runnerSecrets, secretRedactor } from "./redact.js";
import { githubAppAccess } from "./github-app.js";
import { holdStored, storeSecrets } from "./store-secrets.js";

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
/** Whether the runner installs the browser for a run whose revision grants `granted`, fail closed: only on the native route
 *  (BROWSER_ON_RUNNER), and only with the run's ledger booking on its ToolHost (host.ledger.paid), so no browser call is
 *  held on this process's own spend. */
export const browserListed = (host: Pick<ToolHost, "ledger">, granted: readonly string[]): boolean => BROWSER_ON_RUNNER && host.ledger?.paid !== undefined && granted.includes(BROWSER_TOOL);

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
  /** A test runner's fake GitHub API, where the GitHub App's installation tokens are minted (runner/github-app.ts). Absent,
   *  https://api.github.com: the CLI's runner never sets it, and no environment variable, flag or setting maps onto it. */
  readonly githubApi?: string;
  /** A test runner's fake GitHub MCP origin, the one a github_app server may be at (mcp-claim.ts githubMcpOrigin):
   *  for tests only: no environment variable, flag or setting maps onto it; absent, GitHub's hosted MCP (github.ts GITHUB_MCP_ORIGIN). Only a test's in-process runner sets it; the CLI's runner never does. */
  readonly githubMcpOrigin?: string;
}

/** A model as the cap prices it, from the route's catalog cost: its price WITH TIERS (the money rule — a request past a
 *  model's tier is held and booked at the tier, as main's calculateCost does). `api` is the proxy's shape, for the
 *  overhead its provider adds; the output ceiling is the route's when it carries one, else none. */
export function capModelOf(route: ModelRoute): CapModel {
  const cost: RouteCost | undefined = route.cost;
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

/** The revision's body, as the fields the spec reads of it (agentic runs only reach here; a workflow run is dispatched to
 *  the workflow loop). */
type RevisionBody = {
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly toolSettings?: unknown;
  readonly harness?: string;
  readonly approvals?: Approvals;
  readonly skills?: Record<string, unknown>;
  /** The revision's own model ("provider/model-id"), absent for the host's. */
  readonly model?: string;
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
 * file-based approval flow. `root`: the run's files, the run's Workspace (Mode 2: its folder on the run's disk; the turn's
 * origin is read through it, never a folder of this machine) or the local folder's path.
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
export type RunPermissions = { readonly policy: (tool: string) => Permission; readonly denyFrom: (tool: string) => SettingFrom; readonly refresh: () => Promise<void> };

export async function adapterRunGate(store: Pick<Store, "settings">, claim: Pick<Claim, "runId">, revision: { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } }, root: RunFiles): Promise<NonNullable<AdapterRunSpec["gate"]> & { readonly permissions: RunPermissions }> {
  let current = await storeSettings(store);
  const approvers = await readApprovers(store.settings);
  // A Workspace's paths are in the run's folder: its folder named as a computer names it, for the gate's path checks.
  const folder = typeof root === "string" ? root : COMPUTER_ROOT;
  const gate = runGate({ root: folder, work: folder }, claim.runId, revision, () => current, root, approvers);
  const decide = async (call: Parameters<NonNullable<AdapterRunSpec["gate"]>>[0]) => {
    current = await storeSettings(store);
    return gate.decide(call.tool, call.args);
  };
  // An ask is named as main's pending approval is (RunGate.askedAs: its settings key), beside the decision, which is
  // unchanged. The permissions are the learned workflow's (main's toolGate.policy and denyFrom), over the same settings.
  const permissions: RunPermissions = { policy: (tool) => gate.policy(tool), denyFrom: (tool) => gate.denyFrom(tool), refresh: async () => { current = await storeSettings(store); } };
  return Object.assign(decide, { askedAs: (tool: string) => gate.askedAs(tool), permissions });
}

/** The server's tool settings from the store now; a read that throws is unread (no value of it said). */
async function storeSettings(store: Pick<Store, "settings">): Promise<Awaited<ReturnType<typeof loadToolSettings>>> {
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
  const revision = { kind: revisionRow.kind, body } as { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } };
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

  // The run's uploaded files, copied into its work/inputs/ before the first turn, as the server's start copied them before
  // the per-run process ran (uploads.copyInto). Once per run: a fresh run has no inputs/ yet; a resumed claim finds them
  // copied and skips, so the copy's name-collision suffixes never duplicate a file across claims.
  if (launch.files?.length) {
    const copied = await ws.workspace.list(INPUTS_DIR).then(() => true, () => false);
    if (!copied) {
      const uploads = new Uploads(join(deps.data, UPLOADS_DIR));
      await uploads.copyInto(ws.workspace, await uploads.readyFiles(launch.files));
    }
  }

  // The run's MCP for this claim (mcp-run.ts mcpForClaim): its pin made at the first claim or read as written, its
  // credentials opened under the server's seal key into this claim's memory, one gateway for the claim. First, before
  // anything the spec would have to let go: a refusal (a pin that cannot be made, a pinned meta tool) ends the run in its
  // words before the session opens. The seal key is the runner's own (deps.sealKey), not re-read from the environment.
  const mcp = await mcpForClaim({ claim, store: deps.store, sealKey: deps.sealKey, grants: granted, harness: run.harness, work: () => ws.workspace, launchInput: launch.input, githubAppAccess: (store, key, input) => githubAppAccess(store, key, input, deps.githubApi ? { api: deps.githubApi } : {}), ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}) });
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
    { ...deps.computerDeps, mode, workspace: ws.workspace, sealKey: deps.sealKey, ...(archil ? { revokeMount: () => archil.revoke() } : {}), ...(run.phase ? { onImageWait: (making, image) => run.phase?.(imageWaitWords(making, image)) } : {}) },
  );

  // The run's shell is its computer's (600 s) where one mounts its folder; with none, Archil's serverless exec in Mode 2
  // (295 s), and in Mode 1 none at all: no bash family, its folder being one of this server's own (run-tools.ts).
  // A desktop's or a phone's hold (the person's take-over) wraps its ports: a call made while the person holds it waits,
  // and the agent's hand-over (computer_request_handoff) asks the person through it.
  holds.hold({ computer });
  const tools = await runTools(ws.workspace, computer.computer, { mode, context, ...(computer.hold ? { hold: computer.hold } : {}) });
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
  const route = await deps.routeOf(modelAskOf(launch.model, body.model), withModelKeys(deps.env, toolEnv), "default", PI_WIRES, undefined, cut);
  // The run's pi-native extensions, in the root agent through the pi adapter (PiAdapterOptions.extensions), which installs
  // them in the claim's registry and offers each tool once:
  // - ask_person is pi's own tool (tools.ts): a run granted it carries its native extension, so pi runs it as its own tool
  //   task under the session's gate and keeps its control.terminate — the turn ends on the person's question and the loop
  //   parks the run (endedOnTurnEndingTool), or, with the browser's session open, waits for the answer in its claim
  //   (adapter-loop waitInClaim, the browser's personWait below). It stays out of the session's host tools and REPLAY, so a CLI harness still
  //   refuses it (runnable.ts). pi only.
  // - the browser's durable extension, when the run gets one (bindNonHandTools, below, before the session opens).
  const native: Extension[] = granted.includes(ASK_TOOL) ? [defineExtension({ name: "ask_person", tools: [askPerson] })] : [];
  const adapter = piAdapter({
    run,
    // Read when the session opens (pi.ts), so the browser's extension pushed by bindNonHandTools below is in it.
    extensions: native,
    model: route.model,
    provider: route.provider,
    redact: cut,
    ...(route.like ? { like: route.like } : {}),
    ...(route.price ? { price: route.price as never } : {}),
    ...(route.fetch ? { fetch: route.fetch } : {}),
  });

  // The gate before a call's intent: the run's revision's tool settings through runGate (approvals "never" turns the one
  // ask it leaves into an allow). The adapter loop asks `gate` and handles the ask/park/answer on the journal itself, so
  // only the permission is read here, never runGate's own file-based approval flow.
  const root = runFolder(deps.data, runRow.agentId, claim.runId);
  // The gate reads the run's own files (the turn's origin) through the run's Workspace: in Mode 2, its folder on the run's
  // disk, never this machine's folder at the same path.
  const gate = await adapterRunGate(deps.store, claim, revision, ws.workspace);

  // The run's one cap, as the loop's runCap reads it (adapter-loop.ts RunCapConfig): the launch's cap figure (undefined
  // uncapped — every paid request still books through the one cap), the run's model priced WITH tiers, strict where the
  // launch says. The loop builds the kernel runCap from these over the run's own sessions (its model requests, its paid
  // tool calls and its decisions all on one rule and one booking), so the spec carries no beforeRequest of its own.
  const capUsd = launch.maxCostUsd;
  const capModel = capModelOf(route);
  const runCap: RunCapConfig = {
    capUsd: () => launch.maxCostUsd,
    modelOf: (id) => (id === route.model ? capModel : undefined),
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
  // before the run's tools are bound. A learning fault lays nothing and the run goes on.
  const seedLaid = start
    ? await layLearningSeed({
      work: ws.workspace,
      seed: start.seed,
      folder: () => (archil === undefined ? learningFolderOf(deps.data, runRow.agentId) : learningWorkspace({ mode: "archil", agentId: runRow.agentId, archil })),
      own: Object.keys(revisionRow.skills ?? {}),
      shown: async () => secretsShown(runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data))),
      log,
    })
    : undefined;

  // The tool host's install lifecycle: what a binding registers to run in each conversation's creating commit, once the
  // Harness is open before the session, and at the run's end (the browser tool's reconcile and release hang off these). The
  // adapter loop runs them from the spec's `lifecycle` (adapter-loop.ts hostLifecycle).
  const life = hostLifecycle();

  // The ToolHost the non-hand tools (browser, web, MCP, decisions, monid) bind through (buildToolHost, the one the CLI
  // spec builds too), on the claim's keys and the run's one ledger and redactor.
  const host = buildToolHost({ root, workspace: ws.workspace, claim, env: toolEnv, run, store: deps.store, sealKey: deps.sealKey, life, redact: cut });

  // The run's tools. The hands (read/write/edit/bash and the background tools) are the kernel registry's over the run's
  // Workspace and computer (runTools.hostTools); the gate is the adapter loop's own (spec.gate), so they run as asked.
  const results: ToolResults = new Map();
  const handTools = tools.hostTools(withKindTools(granted, tools), undefined, results);
  // The non-hand tools run on the claim's keys (host.env), so a vendor's error may echo one: each answer, and a throw's
  // words, pass the run's one redactor before the harness, the model or the record has them.
  const nonHandTools = (await bindNonHandTools(host, revision.kind, granted, run, context, results, root, launch.plane, seedLaid?.workflows ?? [], native, gate.permissions)).map((tool) => answersCut(tool, cut));
  const sessionTools = [...handTools, ...nonHandTools];

  // The run's system prompt, as main's per-run process builds it (app.ts): the environment line first (environment.ts, as
  // pi installs it before every other section), then the revision's instructions with what the agent learned laid in
  // (learning.ts laidLearned, from the launch's learning start — the # Learned section decided once at launch, so the runner
  // reads no learning folder for it), its own skills through skills.ts promptOf, then the effort guidance (the launch's
  // effort, never this process's environment). The one path for every harness.
  const laid = start ? laidLearned(body.instructions ?? "", start.section) : (body.instructions ?? "");
  const instructions = await promptOf(laid, [...Object.keys(body.skills ?? {}), ...(seedLaid?.skills ?? [])], ws.workspace, { onDemand: readsFiles(granted) });
  const guidance = effortGuidance(launch.effort);
  const system = [environmentLine(), instructions, guidance].filter((line): line is string => Boolean(line));

  const session: SessionSpec = {
    key: `run:${claim.runId}`,
    label: runRow.agentId,
    system,
    tools: sessionTools,
    context: "fresh",
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
    // The tool host's install lifecycle (its bindings' onConversation/beforeResume/beforeRelease), run by the adapter loop.
    lifecycle: life,
    agentId: runRow.agentId,
    workRoot: root,
    // The end's metrics and cost, from the run's journal, as the old per-run end path read them (metrics.ts runMetrics =
    // runs.ts storedMetrics/costOf). A pi run adds its effort, no model (metrics.ts).
    endPatch: async () => {
      const entries = await entriesOf(deps.journal(claim), ROOT_CONVERSATION_ID, context);
      const { metrics, costUsd } = runMetrics(entries as never, { ...(launch.effort !== undefined ? { effort: launch.effort } : {}) });
      // Its paid tool calls (a Parallel search's, a monid call's, a person's browser time), booked on the run's one ledger
      // (the paid tool calls on its cap, in their own session, not on the root), are the run's cost too.
      const paid = run.ledger?.paid ? run.ledger.paid.spentUsd() : 0;
      const total = costUsd === null || paid === null ? null : costUsd + paid;
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
}): Promise<HostTool | undefined> {
  if (!learnsWorkflows(opts.kind, opts.workflows)) return undefined;
  const flows = opts.workflows;
  const models = await opts.run.ledger.models(LEARNED_WORKFLOW_TOOL);
  const tool = learnedWorkflowTool({ workflows: flows, granted: opts.granted, ...(opts.plane ? { plane: opts.plane } : {}), env: opts.env, work: opts.work, models: models as never, modelOf: () => ({ provider: PORT_PROVIDER, modelId: "session" }), policy: opts.permissions.policy, denyFrom: opts.permissions.denyFrom, refresh: opts.permissions.refresh });
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
    // The run's directory and its per-claim environment. `coding` is the runner's: the hands come from runTools, not from
    // a coding source, so the non-hand tools that read it get the run's environment only.
    where: { root, work: root, ref: { id: claim.runId } } as unknown as ToolHost["where"],
    env: opts.env,
    coding: { tools: [], extension: { name: "coding", tools: [] } } as unknown as ToolHost["coding"],
    install: (extension) => run.registry.install(extension),
    onConversation: life.register.onConversation,
    beforeResume: life.register.beforeResume,
    beforeRelease: life.register.beforeRelease,
    personWait: life.register.personWait,
    // The run row's summary staged on a commit of the run's (a hand-over's wait, its claim held: run.needs_input).
    ...(run.rowSummaryOn ? { rowSummaryOn: run.rowSummaryOn } : {}),
    handoverInJournal: true,
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

async function bindNonHandTools(host: ToolHost, kind: string, granted: readonly string[], run: AdapterRun, context: Context, results: ToolResults, root: string, plane: RunLaunch["plane"], workflows: readonly LearnedWorkflow[], native: Extension[], permissions: RunPermissions): Promise<AdapterRunSpec["session"]["tools"]> {
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
  const learned = await learnedWorkflowHostTool({ run, kind, granted, plane, env: host.env, work: root, workflows, permissions, ctx });
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
