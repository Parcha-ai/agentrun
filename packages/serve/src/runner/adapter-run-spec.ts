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
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { beforeRequestOf, type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { BeforeRequest, HostTool, SessionSpec, Wire } from "@parcha/agentrun-kernel";
import type { Approvals } from "../approvals.js";
import type { LiveHandover, LiveViewerStore } from "../browser-live.js";
import { dropLiveViewer, putLiveViewer } from "../browser-live.js";
import type { Tier } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import { learningStartOf, type RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { isObject } from "../validate.js";
import { type RunFiles, runGate } from "../tool-gate.js";
import { loadToolSettings, TOOL_PLANE_ENV } from "../tool-plane.js";
import { type ToolHost, toolOf } from "../tools.js";
import { type HostToolCtx, hostToolOf } from "../host-tools.js";
import { WEB_FETCH_TOOL } from "../web-fetch.js";
import { WEB_SEARCH_TOOL } from "../web-search.js";
import { environmentLine } from "../environment.js";
import { effortGuidance } from "../effort-guidance.js";
import { laidLearned, learningFolderOf, pinnedWorkflows, readPin } from "../learning.js";
import { learningWorkspace } from "../learn/folder.js";
import { learningEndOfRun } from "./learning-end.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowTool } from "../learned-workflow.js";
import { PORT_PROVIDER } from "../port-models.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { promptOf, readsFiles } from "../skills.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { COMPUTER_ROOT, runFolder } from "../workspace/paths.js";
import { runTools, type ToolResults } from "../workspace/run-tools.js";
import { INPUTS_DIR, UPLOADS_DIR, Uploads } from "../uploads.js";
import { claimSecrets } from "./claim-secrets.js";
import { join } from "node:path";
import { type AdapterRun, type AdapterRunSpec, hostLifecycle, type RunCapConfig } from "./adapter-loop.js";
import { piAdapter } from "./adapters/pi.js";
import { entriesOf } from "./loop.js";
import type { Claim, Journal } from "./loop-contract.js";
import { runMetrics } from "./metrics.js";
import type { ModelRoute, RouteCost } from "./model-route.js";
import { archilClaim, type ArchilClaimOptions, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { loadArchilSettings } from "../archil-settings.js";
import type { RunComputer } from "../workspace/run-tools.js";
import type { Workspace } from "../workspace/workspace.js";
import { runnerSecrets, secretRedactor } from "./redact.js";

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
/** The one shared claim-time computer every spec takes (computer-for-claim.ts), passed in by the runner. */
export type ComputerForClaim = (launch: ClaimLaunch, store: AdapterSpecDeps["store"], deps: ClaimDeps & Readonly<Record<string, unknown>>) => Promise<ClaimComputer>;

/** The wires pi speaks on the runner: main's pi's (provider.ts), Anthropic's Messages and OpenAI's Responses. */
export const PI_WIRES: readonly Wire[] = Object.freeze(["anthropic-messages", "openai-responses"]);

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
  readonly routeOf: (model: string | undefined, env: NodeJS.ProcessEnv, tier?: Tier, wires?: readonly Wire[]) => Promise<ModelRoute>;
  /** The run's log line (what its Workspace and computer have to say that is not a run failure). */
  readonly log?: (message: string) => void;
  /** The one shared claim-time computer (computer-for-claim.ts), for both the pi and the CLI spec: none for a runner place.
   *  The runner gives it; a test gives its own. */
  readonly computerForClaim: ComputerForClaim;
  /** What the runner gives computerForClaim once (its kind registry, provider makers, computer spec, keys and settings). */
  readonly computerDeps?: Readonly<Record<string, unknown>>;
  /** A Mode 2 claim's Archil disk (a test's fake); absent, the real disk the Archil settings name. */
  readonly makeArchilDisk?: ArchilClaimOptions["makeDisk"];
  /** The Archil mount credential's control plane, for a test's loopback fake (archilControlFake): its base URL and the
   *  fetch to call it with, spread into the claim's mount. Absent, the real control plane the mount credential names. No
   *  test ever reaches the real Archil control plane. */
  readonly mountControl?: { readonly baseUrl?: string; readonly fetch?: typeof fetch };
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
};

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
 */
export async function adapterRunGate(store: Pick<Store, "settings">, claim: Pick<Claim, "runId">, revision: { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } }, root: RunFiles): Promise<NonNullable<AdapterRunSpec["gate"]>> {
  let current = await storeSettings(store);
  // A Workspace's paths are in the run's folder: its folder named as a computer names it, for the gate's path checks.
  const folder = typeof root === "string" ? root : COMPUTER_ROOT;
  const gate = runGate({ root: folder, work: folder }, claim.runId, revision, () => current, root);
  return async (call) => {
    current = await storeSettings(store);
    return gate.decide(call.tool, call.args);
  };
}

/** The server's tool settings from the store now; a read that throws is unread (no value of it said). */
async function storeSettings(store: Pick<Store, "settings">): Promise<Awaited<ReturnType<typeof loadToolSettings>>> {
  try {
    return await loadToolSettings(store);
  } catch {
    return { settings: {}, problems: ["the stored tool settings could not be read"], unreadable: true };
  }
}

export async function adapterRunSpecFromLaunch(launch: RunLaunch, run: AdapterRun, deps: AdapterSpecDeps, claim: Claim): Promise<AdapterRunSpec> {
  const context = BACKGROUND_CONTEXT;
  // The spec's log lines carry error text (a release, a workspace's end): cut of every secret the runner's env holds.
  const cut = secretRedactor(runnerSecrets(deps.env));
  const log = (line: string) => (deps.log ?? (() => {}))(cut(line));
  const runRow = await deps.store.runs.get(claim.runId);
  if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
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
    // mount, so no test reaches the real control plane. MOUNT_TTL_MS is the credential's safety net (7 days), not its lifetime.
    : await archilClaim({ settings: archilSettings, keys: deps.store.sealedKeys, sealKey: deps.sealKey, signal: new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS, ...(deps.mountControl ?? {}) }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) });
  // The run's Workspace at the claim: Mode 1 the run's local folder (made here, the server's start made it before); Mode 2
  // the run's folder on the disk.
  const ws = archil === undefined
    ? await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log })
    : await openRunWorkspace({ mode: 2, agentId: runRow.agentId, runId: claim.runId, archil, log });

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

  // The run's computer, from the one shared claim-time function (the CLI spec takes the same): none for a runner place, a
  // Docker container for a sandbox, under the claim's epoch (the one fence). It throws computer_unavailable (nothing made)
  // when the computer cannot be had: the run fails in its words.
  const computer = await deps.computerForClaim(
    { runId: claim.runId, epoch: claim.epoch, revisionId: runRow.revisionId, place: launch.place, ...((launch as { computer?: unknown }).computer !== undefined ? { computer: (launch as { computer?: unknown }).computer } : {}) },
    deps.store,
    // revokeMount removes the run's Archil mount credential when the computer is released (and if a start fails after a mint);
    // the run's end revokes it too (below), so it goes on every outcome even when no computer is made. Idempotent.
    { ...deps.computerDeps, mode, workspace: ws.workspace, sealKey: deps.sealKey, ...(archil ? { revokeMount: () => archil.revoke() } : {}) },
  );

  // The run's mode bounds its shell: 600 s locally or on a computer, 295 s on Archil's serverless exec (Mode 2, none).
  const tools = await runTools(ws.workspace, computer.computer, { mode, context });

  // The run's model route: its model through routeOf (NEVER re-resolved — the launch's model, pinned at start), the catalog
  // price with tiers for the cap, and the proxy's price (pi-ai calculateCost, tiered).
  // pi speaks both of main's wires: an OpenAI-family model's route is OpenAI's Responses itself.
  const route = await deps.routeOf(launch.model ? `${launch.model.provider}/${launch.model.modelId}` : undefined, deps.env, "default", PI_WIRES);
  const adapter = piAdapter({
    run,
    model: route.model,
    provider: route.provider,
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
  // has a cap.
  const cap = capUsd === undefined
    ? undefined
    : {
        capUsd,
        park: (refusal: { message: string; forGood: boolean; figures?: CapRefused["figures"] }) => parkOf(refusal as CapRefused, capUsd),
        checkRaise,
        followUpOf: (raised: number) => followUpOf(raised),
      };

  // The run's secrets for this claim, read from the one store (never this process's environment or a pipe): the keys its
  // tools unlock and its model needs, scoped to the run as the old per-run environment was, so one run's keys never reach
  // another's on this runner (claim-secrets.ts). MCP credentials are the other per-claim secret and come through mcp-claim.
  const toolEnv = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, revisionRow as unknown as Parameters<typeof claimSecrets>[1], launch);
  // The run's resolved tool plane (its web_search/web_fetch/browser providers), as main hands its per-run process (runs.ts):
  // the web tools read it (tool-plane.ts planeOf) to pick Parallel where the run resolves to it, the model provider's native
  // search, or the guarded direct fetch. Not a secret; without it the runner's web tools would ignore the run's plane and
  // never reach Parallel, so they could not book a Parallel call as main does.
  delete toolEnv[TOOL_PLANE_ENV];
  if (launch.plane && Object.keys(launch.plane).length) toolEnv[TOOL_PLANE_ENV] = JSON.stringify(launch.plane);

  // The tool host's install lifecycle: what a binding registers to run in each conversation's creating commit, once the
  // Harness is open before the session, and at the run's end (the browser tool's reconcile and release hang off these). The
  // adapter loop runs them from the spec's `lifecycle` (adapter-loop.ts hostLifecycle).
  const life = hostLifecycle();

  // The ToolHost the non-hand tools (browser, web, MCP, decisions, monid) bind through, carrying the runner's live-viewer
  // seam: the browser tool's live-viewer writers hand a session's viewer over through the store, not through files. This
  // is the seam tl-browser's live-viewer writers hang off (`liveViewers`).
  const host: ToolHost = {
    // The run's directory and its per-claim environment (claim-secrets.ts: the run's keys from the store). `coding` is the
    // runner's: the hands come from runTools (below), not from a coding source, so the non-hand tools that read it get the
    // run's environment only.
    where: { root, work: root, ref: { id: claim.runId } } as unknown as ToolHost["where"],
    env: toolEnv,
    coding: { tools: [], extension: { name: "coding", tools: [] } } as unknown as ToolHost["coding"],
    install: (extension) => run.registry.install(extension),
    onConversation: life.register.onConversation,
    beforeResume: life.register.beforeResume,
    beforeRelease: life.register.beforeRelease,
    handoverInJournal: true,
    store: deps.store,
    claim,
    sealKey: deps.sealKey,
    liveViewers: {
      put: (handover: LiveHandover) => putLiveViewer(deps.store, deps.sealKey, claim, handover),
      drop: (tag?: string) => dropLiveViewer(deps.store, claim, tag),
    },
  };

  // The run's tools. The hands (read/write/edit/bash and the background tools) are the kernel registry's over the run's
  // Workspace and computer (runTools.hostTools); the gate is the adapter loop's own (spec.gate), so they run as asked.
  const results: ToolResults = new Map();
  const handTools = tools.hostTools(granted, undefined, results);
  const nonHandTools = await bindNonHandTools(host, granted, run, context, results, root, launch.plane);
  const sessionTools = [...handTools, ...nonHandTools];

  // The run's system prompt, as main's per-run process builds it (app.ts): the environment line first (environment.ts, as
  // pi installs it before every other section), then the revision's instructions with what the agent learned laid in
  // (learning.ts laidLearned, from the launch's learning start — the # Learned section decided once at launch, so the runner
  // reads no learning folder), its own skills through skills.ts promptOf, then the effort guidance (the launch's effort,
  // never this process's environment). The one path for every harness.
  const start = learningStartOf(launch);
  const laid = start ? laidLearned(body.instructions ?? "", start.section) : (body.instructions ?? "");
  const instructions = await promptOf(laid, Object.keys(body.skills ?? {}), ws.workspace, { onDemand: readsFiles(granted) });
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
    learningFolder: archil === undefined
      ? (agentId: string) => learningFolderOf(deps.data, agentId)
      : (agentId: string) => learningWorkspace({ mode: "archil", agentId, archil }),
  });

  return {
    adapter,
    session,
    input,
    // The gate's answer with its words (adapterRunGate, RunGate.decide): a deny names where it was set and that nothing was
    // sent or charged, and a pinned MCP tool's call outside its pin is refused before it is asked or sent.
    gate,
    runCap,
    ...(cap ? { cap } : {}),
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
      return { ...(costUsd !== null ? { costUsd } : {}), metrics };
    },
    // The pass's resources go once the loop writes nothing more through them: its tools' end (background processes ended,
    // scratch swept), its computer let go, then its Workspace's end (Mode 2 sweeps the exec spill).
    release: async () => {
      await tools.end().catch((error: unknown) => log(`the run's tools' end failed: ${(error as Error)?.message ?? String(error)}`));
      await computer.release().catch((error: unknown) => log(`the run's computer could not be let go: ${(error as Error)?.message ?? String(error)}`));
      // The run's Archil mount credential, revoked at its end on every outcome, even with no computer (the computer's release
      // revokes it too; revoke is idempotent, so a second call is a no-op). A run that minted none revokes nothing.
      await archil?.revoke().catch((error: unknown) => log(`the run's Archil mount credential could not be revoked: ${(error as Error)?.message ?? String(error)}`));
      await ws.end().catch((error: unknown) => log(`the run's workspace end failed: ${(error as Error)?.message ?? String(error)}`));
    },
  };
}

/** learned_workflow on a pi run is listed so the dispatch offers main's tool set, but it is not run yet: its model nodes
 *  run on the session's proxied models (run.ledger.models), which pi's adapter has no port for yet (its session exposes
 *  none). Until that port lands it is refused in words, never run as a stub. A CLI harness's session HAS a model port, so
 *  its learned_workflow runs for real (learnedWorkflowHostTool onSessionPort). web_fetch, web_search and monid carry no
 *  such gate: the adapter loop books their paid requests on the run's one ledger (adapter-loop.ts bookedIn,
 *  paid-calls.ts), held at Parallel's or monid's price and settled at the charge, exactly as main does, so they run. */
function settleLearnedWorkflow(name: string): { refused: string } | undefined {
  return name === LEARNED_WORKFLOW_TOOL ? { refused: "This tool is not available on the runner yet, so its call was not run." } : undefined;
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

/** The run's learned_workflow tool as a HostTool, listed when its pin names learned workflows (as main lists it, so the
 *  tool set the model sees matches main). `onSessionPort`: the run's session has a model port (the CLI harnesses), so its
 *  model nodes run on the session's proxied models (run.ledger.models, port-models.ts: read at each request, labelled
 *  learned_workflow), booked on the run's one ledger and priced by the harness's own policy; false (pi, no port yet)
 *  lists it refused in words (settleLearnedWorkflow). A pin whose learned-workflows file is not on the runner is skipped
 *  (its own seam), never failing the run. Its call nodes run the agent's tools' effects on `env`, the run's scoped keys. */
export async function learnedWorkflowHostTool(opts: {
  readonly run: AdapterRun;
  readonly granted: readonly string[];
  readonly plane: RunLaunch["plane"];
  readonly env: NodeJS.ProcessEnv;
  readonly work: string;
  readonly ctx: HostToolCtx;
  readonly onSessionPort: boolean;
}): Promise<HostTool | undefined> {
  if (!opts.granted.includes(LEARNED_WORKFLOW_TOOL)) return undefined;
  const flows = await pinnedWorkflows(opts.work, await readPin(opts.work)).catch(() => []);
  if (!flows.length) return undefined;
  const base = { workflows: flows, granted: opts.granted, ...(opts.plane ? { plane: opts.plane } : {}), env: opts.env, work: opts.work };
  if (!opts.onSessionPort) {
    const tool = learnedWorkflowTool({ ...base, models: createModels() as never, modelOf: () => undefined });
    return hostToolOf(LEARNED_WORKFLOW_TOOL, tool as never, { ...opts.ctx, settle: settleLearnedWorkflow }) ?? undefined;
  }
  const models = await opts.run.ledger.models(LEARNED_WORKFLOW_TOOL);
  const tool = learnedWorkflowTool({ ...base, models: models as never, modelOf: () => ({ provider: PORT_PROVIDER, modelId: "session" }) });
  return hostToolOf(LEARNED_WORKFLOW_TOOL, tool as never, opts.ctx) ?? undefined;
}

/** The run's non-hand tools as HostTool[], bound through the ToolHost seam and wrapped as the hands are (host-tools.ts
 *  hostToolOf): web_fetch, web_search and monid, each by its catalog name under the adapter loop's one gate (`spec.gate`;
 *  `gated` is undefined here, as for the hands). Their paid requests are booked by the adapter loop on the run's one ledger
 *  (bookedIn), as main books them, so they run. The browser (tl-browser, through host.liveViewers), MCP (tl-mcp's
 *  mcpForClaim(claim, store, sealKey, pin) -> { sessionMcp, redactions, release }), the learned workflow and decisions are
 *  each a named todo, added as their seams land. */
async function bindNonHandTools(host: ToolHost, granted: readonly string[], run: AdapterRun, context: Context, results: ToolResults, root: string, plane: RunLaunch["plane"]): Promise<AdapterRunSpec["session"]["tools"]> {
  const names = granted.filter((name) => name === WEB_FETCH_TOOL || name === WEB_SEARCH_TOOL || name.startsWith("monid."));
  // The host-tool ctx the non-hand tools are wrapped with (hostToolCtxOf): the run's own Harness and the run's folder as
  // the api env's cwd. The gate is the adapter loop's own (spec.gate); web_fetch/web_search/monid carry no settle, so the
  // loop books their paid requests on the run's one ledger (bookedIn) and they run.
  const ctx = hostToolCtxOf(run, context, results, root);
  const tools: HostTool[] = [];
  for (const name of names) {
    const entry = toolOf(name);
    if (!entry) continue;
    const binding = await entry.bind(host);
    for (const registration of binding.tools) {
      const tool = hostToolOf(name, registration, ctx);
      if (tool) tools.push(tool);
    }
  }

  // learned_workflow, listed when the run's pin names learned workflows (as main lists it). On pi it is listed but refused
  // (onSessionPort false: pi's adapter exposes no session port for its model nodes yet); a CLI run lists it for real on the
  // session's proxied models (cli-run-spec.ts). The agent's scoped keys (host.env) are its call nodes'.
  const learned = await learnedWorkflowHostTool({ run, granted, plane, env: host.env, work: root, ctx, onSessionPort: false });
  if (learned) tools.push(learned);

  // TODO (decisions, option (a)): a pi run's decision tools book on the run's ONE cap (runCap's run.decisions), which the
  // adapter loop makes from its own sessions and hands the spec at open — the loop passes { decisions, models } the same way
  // it passes spec.lifecycle. The decision providers come from the claim's secrets (claim-secrets.ts). Wired against that
  // seam when it lands; never a second journalSessions + runCap over the one journal (the double-book we closed).
  return tools;
}
