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
import type { ComputerProvider } from "@parcha/agentrun-computer";
import { type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { HostTool, SessionSpec } from "@parcha/agentrun-kernel";
import type { Approvals } from "../approvals.js";
import type { LiveHandover, LiveViewerStore } from "../browser-live.js";
import { dropLiveViewer, putLiveViewer } from "../browser-live.js";
import type { Tier } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { isObject } from "../validate.js";
import { runGate } from "../tool-gate.js";
import { loadToolSettings } from "../tool-plane.js";
import { type ToolHost, toolOf } from "../tools.js";
import { type HostToolCtx, hostToolOf } from "../host-tools.js";
import { WEB_FETCH_TOOL } from "../web-fetch.js";
import { WEB_SEARCH_TOOL } from "../web-search.js";
import { environmentLine } from "../environment.js";
import { effortGuidance } from "../effort-guidance.js";
import { pinnedWorkflows, readPin, withLearned } from "../learning.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowTool } from "../learned-workflow.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { promptOf, readsFiles } from "../skills.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { runFolder } from "../workspace/paths.js";
import { SEAL_KEY_ENV, sealKeyOf } from "../tool-keys.js";
import { mcpForClaim } from "./mcp-run.js";
import { runTools, type ToolResults } from "../workspace/run-tools.js";
import { INPUTS_DIR, UPLOADS_DIR, Uploads } from "../uploads.js";
import { claimSecrets } from "./claim-secrets.js";
import { join } from "node:path";
import { type AdapterRun, type AdapterRunSpec, hostLifecycle } from "./adapter-loop.js";
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
  return { id: route.model, api: "anthropic-messages", price, outputCeiling: route.outputCeiling ?? null };
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

  // The run's MCP for this claim (mcp-run.ts mcpForClaim): its pin made at the first claim or read as written, its
  // credentials opened under the server's seal key into this claim's memory, one gateway for the claim. First, before
  // anything the spec would have to let go: a refusal (a pin that cannot be made, a pinned meta tool) ends the run in its
  // words before the session opens.
  const mcp = await mcpForClaim({ claim, store: deps.store, sealKey: sealKeyOf(deps.env[SEAL_KEY_ENV]), grants: granted, harness: run.harness, work: () => runFolder(deps.data, runRow.agentId, claim.runId), launchInput: launch.input });

  // The run's Workspace at the claim (E4c). Mode 1: the run's local folder under the data directory, made here (the server's
  // start made it before). Mode 2 (Archil) is TODO(E2r2): the claim's Archil step (archilClaim) is threaded through the deps
  // when E4c's Mode 2 lands on the runner.
  const ws = await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log });

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
  // The server's tool settings are the one store's (loadToolSettings), read once at the claim, never a file beside the data
  // directory (the old per-run process's readToolSettings). The gate's approvals "never" lifts an ask to an allow only where
  // the settings read non-undefined, and the store always reads (no row is every default), so an unattended run goes at an
  // ask it would park on were the settings a file that never read.
  const serverSettings = await loadToolSettings(deps.store);
  const gate = runGate({ root, work: root }, claim.runId, revision, () => serverSettings);

  // The run's cap (its launch's maxCostUsd): the one cap every paid request is admitted through (runCap), and what a
  // refusal does to the run (parkOf), with the kernel's raise rule.
  const capUsd = launch.maxCostUsd;
  const capModel = capModelOf(route);
  // The run's one cap (the loop builds the kernel's runCap from it, on the run's own sessions): every paid request of the
  // run, its model requests and its paid tool calls, admitted and booked through it. An uncapped run reads no cap.
  const runCap: AdapterRunSpec["runCap"] = {
    capUsd: () => launch.maxCostUsd,
    modelOf: (id) => (id === route.model ? capModel : undefined),
    ...(launch.capMode === "strict" ? { mode: "strict" as const } : {}),
  };
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
  // pi installs it before every other section), then the revision's instructions with its skills and what the agent learned
  // folded in (learning.ts withLearned, then skills.ts promptOf, each skill whole or by its file as the run reads its
  // files), then the effort guidance (the launch's effort, never this process's environment). The one path for every harness.
  const learned = await withLearned(root, ws.workspace, body.instructions ?? "", Object.keys(body.skills ?? {}));
  const instructions = await promptOf(learned.instructions, learned.skills, ws.workspace, { onDemand: readsFiles(granted) });
  const guidance = effortGuidance(launch.effort);
  const system = [environmentLine(), instructions, guidance].filter((line): line is string => Boolean(line));

  const session: SessionSpec = {
    key: `run:${claim.runId}`,
    label: runRow.agentId,
    system,
    tools: sessionTools,
    context: "fresh",
  };

  // The person's first message: the start body's content, with the run's file manifest beside it (run-manifest.ts).
  const content = isObject(launch.input) && typeof (launch.input as { content?: unknown }).content === "string" ? (launch.input as { content: string }).content : "";
  const input = await firstMessage(content, root);

  return {
    adapter,
    session,
    input,
    // The gate's answer with its words (RunGate.decide): a deny names where it was set and that nothing was sent or charged,
    // and a pinned MCP tool's call outside its pin is refused before it is asked or sent, as the old per-run gate did.
    gate: (call) => gate.decide(call.tool, call.args),
    runCap,
    ...(cap ? { cap } : {}),
    ...(mcp ? { mcp } : {}),
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
      if (computer) await computer.release().catch((error: unknown) => log(`the run's computer could not be let go: ${(error as Error)?.message ?? String(error)}`));
      await ws.end().catch((error: unknown) => log(`the run's workspace end failed: ${(error as Error)?.message ?? String(error)}`));
    },
  };
}

/** The tools whose call spends, routed through the one money seam below. web_fetch/web_search book Parallel's extract and
 *  search; monid's three call monid's paid API; a learned workflow's nodes spend on the run's models and decisions. */
const PAID_TOOLS: ReadonlySet<string> = new Set([WEB_FETCH_TOOL, WEB_SEARCH_TOOL, "monid.discover", "monid.inspect", "monid.run", LEARNED_WORKFLOW_TOOL]);

/** A paid tool call's money on the runner, through one named seam. Today it refuses the call in words, so a paid tool is
 *  never run unbooked; its name is still listed, so a pi run through the dispatch offers main's tools. A tool that spends
 *  nothing runs (undefined). TODO(spendcap-1): book the call's charge as main does (paid-calls.ts settleIn on the adapter
 *  loop's harness), then return undefined to let it run, and add the red that a paid call books main's figure. */
function settlePaidCall(name: string): { refused: string } | undefined {
  return PAID_TOOLS.has(name) ? { refused: "This tool's charge is not settled on the runner yet, so its call was not run." } : undefined;
}

/** The run's non-hand tools as HostTool[], bound through the ToolHost seam and wrapped as the hands are (host-tools.ts
 *  hostToolOf): web_fetch, web_search and monid, each by its catalog name under the adapter loop's one gate (`spec.gate`;
 *  `gated` is undefined here, as for the hands), its paid call's money through settlePaidCall. The browser (tl-browser,
 *  through host.liveViewers), MCP (opened at the top of adapterRunSpecFromLaunch by mcp-run.ts mcpForClaim and handed to the loop as spec.mcp),
 *  the learned workflow and decisions are each a named todo, added as their seams land. */
async function bindNonHandTools(host: ToolHost, granted: readonly string[], run: AdapterRun, context: Context, results: ToolResults, root: string, plane: RunLaunch["plane"]): Promise<AdapterRunSpec["session"]["tools"]> {
  const names = granted.filter((name) => name === WEB_FETCH_TOOL || name === WEB_SEARCH_TOOL || name.startsWith("monid."));
  const ctx: HostToolCtx = {
    context,
    results,
    // The web and monid tools read no file environment; the run's folder is the api env's cwd, so an error names a path
    // relative to it (host-tools.ts workspaceRelative).
    env: async () => ({ cwd: root }) as never,
    commit: (change, at, options) => run.harness.commit(change, at, options),
    // The run's own Harness, read at the call as commit's is: a document, conversation or task of this run only.
    snapshot: ((...args: unknown[]) => Reflect.apply(run.harness.snapshot, run.harness, args)) as ToolExecutionApi["snapshot"],
    conversation: ((id, at) => run.harness.conversation(id, at)) as ToolExecutionApi["conversation"],
    waitForTask: (id, at) => run.harness.waitForTask(id, at),
    agent: async (at) => {
      const conversation = await run.harness.conversation(ROOT_CONVERSATION_ID, at);
      if (!conversation) throw new Error("the run has no root conversation");
      return conversation.agent(at);
    },
    // The gate is the adapter loop's own (spec.gate); each paid tool's money through the one settle seam.
    settle: settlePaidCall,
  };
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

  // learned_workflow, by main's wire name, listed when the run's pin names learned workflows (as main lists it), behind
  // settlePaidCall like the other paid tools so the tool set the model sees matches main. Its nodes run on the run's models,
  // which the adapter loop's open seam gives (TODO, the same {decisions, models} seam as decisions below); the refusal means
  // they are never reached here, so it is listed, not run. A pin whose learned-workflows file is not on the runner yet is
  // skipped (that copy is its own seam), never failing the run.
  if (granted.includes(LEARNED_WORKFLOW_TOOL)) {
    const flows = await pinnedWorkflows(root, await readPin(root)).catch(() => []);
    if (flows.length) {
      const learnedTool = learnedWorkflowTool({
        workflows: flows,
        granted,
        ...(plane ? { plane } : {}),
        env: host.env,
        work: root,
        // TODO(loop seam): the run's models and modelOf come from the adapter loop's {decisions, models} at open; unreached
        // behind settlePaidCall until the paid-call settle lands.
        models: createModels() as never,
        modelOf: () => undefined,
      });
      const tool = hostToolOf(LEARNED_WORKFLOW_TOOL, learnedTool as never, ctx);
      if (tool) tools.push(tool);
    }
  }

  // TODO (decisions, option (a)): a pi run's decision tools book on the run's ONE cap (runCap's run.decisions), which the
  // adapter loop makes from its own sessions and hands the spec at open — the loop passes { decisions, models } the same way
  // it passes spec.lifecycle. The decision providers come from the claim's secrets (claim-secrets.ts). Wired against that
  // seam when it lands; never a second journalSessions + runCap over the one journal (the double-book we closed).
  return tools;
}
