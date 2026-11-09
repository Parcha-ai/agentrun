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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ComputerProvider } from "@parcha/agentrun-computer";
import { beforeRequestOf, type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { BeforeRequest, SessionSpec } from "@parcha/agentrun-kernel";
import type { Approvals } from "../approvals.js";
import type { LiveHandover, LiveViewerStore } from "../browser-live.js";
import { dropLiveViewer, putLiveViewer } from "../browser-live.js";
import type { Tier } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { isObject } from "../validate.js";
import { runGate } from "../tool-gate.js";
import type { ToolHost } from "../tools.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { runFolder } from "../workspace/paths.js";
import { runTools, type ToolResults } from "../workspace/run-tools.js";
import type { AdapterRun, AdapterRunSpec } from "./adapter-loop.js";
import { piAdapter } from "./adapters/pi.js";
import { dockerComputer } from "./computer.js";
import { entriesOf } from "./loop.js";
import type { Claim, Journal } from "./loop-contract.js";
import { runMetrics } from "./metrics.js";
import type { ModelRoute, RouteCost } from "./model-route.js";

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
  /** The run's model route (model-route.ts routeOf), the one route the pi adapter and the cap read. */
  readonly routeOf: (model: string | undefined, env: NodeJS.ProcessEnv, tier?: Tier) => Promise<ModelRoute>;
  /** The run's log line (what its Workspace and computer have to say that is not a run failure). */
  readonly log?: (message: string) => void;
  /** D's docker provider for a sandbox run's computer; a test gives its own (computer.ts dockerComputer default). */
  readonly makeProvider?: () => Promise<ComputerProvider>;
}

/** A model as the cap prices it, from the route's catalog cost: its price WITH TIERS (the money rule — a request past a
 *  model's tier is held and booked at the tier, as main's calculateCost does). `api` is the proxy's shape, for the
 *  overhead its provider adds; the output ceiling is the route's when it carries one, else none. */
function capModelOf(route: ModelRoute): CapModel {
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
  return { id: route.model, api: "anthropic-messages", price, outputCeiling: null };
}

/** The revision's body, as the fields the spec reads of it (agentic runs only reach here; a workflow run is dispatched to
 *  the workflow loop). */
type RevisionBody = {
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly toolSettings?: unknown;
  readonly harness?: string;
  readonly approvals?: Approvals;
};

/**
 * One claimed pi run's AdapterRunSpec, built from its launch record and its revision.
 *
 * `launch` is the run's launch body (run-launch.ts), read by the dispatch at the claim; `run` is the loop's open Harness
 * and registry (AdapterRun); `deps` is the runner's store, data directory, model route and seal key; `claim` is the claim
 * this pass holds.
 */
export async function adapterRunSpecFromLaunch(launch: RunLaunch, run: AdapterRun, deps: AdapterSpecDeps, claim: Claim): Promise<AdapterRunSpec> {
  const context = BACKGROUND_CONTEXT;
  const log = deps.log ?? (() => {});
  const runRow = await deps.store.runs.get(claim.runId);
  if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
  const revisionRow = await deps.store.agents.revision(runRow.revisionId);
  if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
  const body = (revisionRow.body ?? {}) as RevisionBody;
  const revision = { kind: revisionRow.kind, body } as { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } };
  const granted = body.tools ?? [];

  // The run's Workspace at the claim (E4c). Mode 1: the run's local folder under the data directory. Mode 2 (Archil) is
  // TODO(E2r2): the claim's Archil step (archilClaim) is threaded through the deps when E4c's Mode 2 lands on the runner.
  const ws = await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log });

  // A sandbox run's computer (Mode 1 Docker): D makes a container with the run's folder at /workspace, under the claim's
  // epoch (the one fence). runTools attaches the Workspace to it; the run's release lets it go.
  const computer = launch.place.mode === "sandbox"
    ? await dockerComputer(ws.workspace, {
        runId: claim.runId,
        epoch: claim.epoch,
        ...(launch.boxAllow !== undefined ? { boxAllow: launch.boxAllow } : {}),
        ...(deps.env.AGENTRUN_DOCKER_IMAGE ? { image: deps.env.AGENTRUN_DOCKER_IMAGE } : {}),
      }, deps.makeProvider)
    : undefined;

  const tools = await runTools(ws.workspace, computer?.run, { mode: 1, context });

  // The run's model route: its model through routeOf (NEVER re-resolved — the launch's model, pinned at start), the catalog
  // price with tiers for the cap, and the proxy's price (pi-ai calculateCost, tiered).
  const route = await deps.routeOf(launch.model ? `${launch.model.provider}/${launch.model.modelId}` : undefined, deps.env);
  const adapter = piAdapter({
    run,
    model: route.model,
    provider: route.provider,
    ...(route.price ? { price: route.price as never } : {}),
    ...(route.fetch ? { fetch: route.fetch } : {}),
  });

  // The gate before a call's intent: the run's revision's tool settings through runGate (approvals "never" turns the one
  // ask it leaves into an allow). The adapter loop asks `gate` and handles the ask/park/answer on the journal itself, so
  // only the permission is read here, never runGate's own file-based approval flow.
  const root = runFolder(deps.data, runRow.agentId, claim.runId);
  const gate = runGate({ root, work: root }, claim.runId, revision);

  // The run's cap (its launch's maxCostUsd): the host's check before each paid request (beforeRequestOf), and what a
  // refusal does to the run (parkOf), with the kernel's raise rule.
  const capUsd = launch.maxCostUsd;
  const capModel = capModelOf(route);
  const beforeRequest: BeforeRequest | undefined = capUsd === undefined
    ? undefined
    : beforeRequestOf({
        capUsd: () => launch.maxCostUsd,
        modelOf: (id) => (id === route.model ? capModel : undefined),
        ...(launch.capMode === "strict" ? { mode: "strict" as const } : {}),
      });
  const cap = capUsd === undefined
    ? undefined
    : {
        capUsd,
        park: (refusal: { message: string; forGood: boolean; figures?: CapRefused["figures"] }) => parkOf(refusal as CapRefused, capUsd),
        checkRaise,
        followUpOf: (raised: number) => followUpOf(raised),
      };

  // The ToolHost the non-hand tools (browser, web, MCP, decisions, monid) bind through, carrying the runner's live-viewer
  // seam: the browser tool's live-viewer writers hand a session's viewer over through the store, not through files. This
  // is the seam tl-browser's live-viewer writers hang off (`liveViewers`).
  const host: ToolHost = {
    // The run's directory and environment, as the old per-run process had them. `coding` is the runner's: the hands come
    // from runTools (below), not from a coding source, so the non-hand tools that read it get the run's environment only.
    where: { root, work: root, ref: { id: claim.runId } } as unknown as ToolHost["where"],
    env: deps.env,
    coding: { tools: [], extension: { name: "coding", tools: [] } } as unknown as ToolHost["coding"],
    install: (extension) => run.registry.install(extension),
    onConversation: () => {},
    beforeResume: () => {},
    beforeRelease: () => {},
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
  // TODO(E2r2): the full non-hand tool set as HostTool[] under one gate — tools.ts's browser (through the ToolHost seam
  // above, its live-viewer writers co-owned with tl-browser), web_fetch, web_search, monid, decisions and the learned
  // workflow — moved from app.ts. Until then a pi run through the dispatch lists only its hands; `host` carries the seam
  // these bind through.
  const nonHandTools = bindNonHandTools(host, granted);
  const sessionTools = [...handTools, ...nonHandTools];

  const session: SessionSpec = {
    key: `run:${claim.runId}`,
    label: runRow.agentId,
    // TODO(E2r2): the full system prompt as app.ts builds it (the environment line, the revision's instructions with its
    // skills, the effort guidance, what the agent learned). The run's instructions alone until then.
    system: [body.instructions ?? ""].filter((line): line is string => line.length > 0),
    tools: sessionTools,
    context: "fresh",
  };

  // TODO(E2r2): copy launch.files into the workspace before the first turn (uploads' copy), once `files` is on RunLaunch
  // (E2c cutover-e2c). TODO(E2r2): at a run's sign-in save, store.signIns.verify(agentId, provider, at) (E1b
  // cutover-e1b): the runner marks the agent's sign-in verified when a session saved to it.

  // The person's first message: the start body's content, with the run's file manifest beside it (run-manifest.ts).
  const content = isObject(launch.input) && typeof (launch.input as { content?: unknown }).content === "string" ? (launch.input as { content: string }).content : "";
  const input = await firstMessage(content, root);

  return {
    adapter,
    session,
    input,
    gate: (call) => gate.policy(call.tool),
    ...(beforeRequest ? { beforeRequest } : {}),
    ...(cap ? { cap } : {}),
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
      if (computer) await computer.release().catch((error: unknown) => log(`the run's computer could not be let go: ${(error as Error)?.message ?? String(error)}`));
      await ws.end().catch((error: unknown) => log(`the run's workspace end failed: ${(error as Error)?.message ?? String(error)}`));
    },
  };
}

/** The run's non-hand tools as HostTool[], bound through the ToolHost seam (browser, web, MCP, decisions, monid, the
 *  learned workflow). TODO(E2r2): move app.ts's tool building here, each tool by its catalog name under the run's gate;
 *  the browser's live-viewer writers hang off `host.liveViewers`. Empty until then: a pi run lists only its hands. */
function bindNonHandTools(host: ToolHost, granted: readonly string[]): AdapterRunSpec["session"]["tools"] {
  void host;
  void granted;
  return [];
}
