// The runner's spec for a run on a CLI harness (claude-agent, codex, opencode): what the old per-run process built for
// one (app.ts, its harness branch), built here from the run's launch record and its revision, and handed to the kernel's
// adapter loop as one AdapterRunSpec, the CLI counterpart of adapterRunSpecFromLaunch (adapter-run-spec.ts). The
// dispatch runs a CLI run on `createAdapterLoop((claim, run) => cliRunSpecFromLaunch(launch, run, deps, claim))`.
//
// The adapter is the one main builds for the harness (its harness-table entry's adapter, adapters.ts): the installed SDK,
// CLI or binary, its provider on the harness's own wire (Anthropic's Messages, or the Responses API through serve's
// gateway, OpenAI or OpenRouter), the catalog price of the model that bills it, the skills it loads itself, its native
// search. So a CLI run's model, its price and its refusals are main's. Its paid requests go through the session's proxy,
// booked by the runner's booking (the one ledger) under the run's cap, which prices a request at that model's catalog
// cost, tiers included. The run's visible record is the loop's (record "loop"): a CLI's own records are resume log only.
//
// Shared with the pi spec: the run's Workspace and its uploaded files, a sandbox run's computer, the kernel registry's
// hands on them (runTools), the gate from the store's tool settings, the system prompt (environment line, instructions
// with what the agent learned and its skills, effort guidance), the first message, the end's metrics and the release.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { beforeRequestOf, type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { BeforeRequest, SessionSpec } from "@parcha/agentrun-kernel";
import type { AdapterNeeds } from "../adapters.js";
import { thinkingFor } from "../adapters.js";
import type { Approvals } from "../approvals.js";
import { effortGuidance } from "../effort-guidance.js";
import { environmentLine } from "../environment.js";
import { builtinHarness, type HarnessEntry } from "../harness-table.js";
import { withLearned } from "../learning.js";
import { type ModelRef, providerModels, runModels } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import type { RunLaunch } from "../run-launch.js";
import { readsFiles, systemOf } from "../skills.js";
import { runGate } from "../tool-gate.js";
import { loadToolSettings } from "../tool-plane.js";
import { INPUTS_DIR, UPLOADS_DIR, Uploads } from "../uploads.js";
import { isObject } from "../validate.js";
import { runFolder, scratchFolder } from "../workspace/paths.js";
import { DATA_ENV } from "../server-fs.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { runTools, type ToolResults } from "../workspace/run-tools.js";
import type { AdapterRun, AdapterRunSpec } from "./adapter-loop.js";
import type { AdapterSpecDeps } from "./adapter-run-spec.js";
import { resolveHarness } from "./adapters/index.js";
import { dockerComputer } from "./computer.js";
import { entriesOf } from "./loop.js";
import type { Claim } from "./loop-contract.js";
import { runMetrics } from "./metrics.js";

/** What the runner hands the CLI spec builder: the pi spec's deps, one per runner. */
export type CliSpecDeps = AdapterSpecDeps;

/** The revision's body, as the fields the spec reads of it. */
type RevisionBody = {
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly toolSettings?: unknown;
  readonly harness?: string;
  readonly model?: string;
  readonly approvals?: Approvals;
  readonly skills?: Record<string, unknown>;
};

/** The run's model and the catalog that prices it, as main chooses a CLI run's (app.ts wireModels and runModels): on the
 *  harness's own wire where its entry says its model is chosen there, else as the run's usual models. */
async function modelsOf(entry: HarnessEntry, env: NodeJS.ProcessEnv, ref: string | undefined): Promise<{ model: ModelRef; models: AdapterNeeds["models"]; unpriced: ReadonlySet<string> }> {
  if (entry.onWire(env)) {
    const choice = await entry.model(env, ref, true);
    if (!choice) throw new Error(`${entry.id} does not run here.`);
    if ("why" in choice) throw new Error(choice.why);
    return { model: choice.model, models: await providerModels(env) as unknown as AdapterNeeds["models"], unpriced: new Set() };
  }
  const chosen = await runModels(env, ref, ["default"], entry.id);
  if (!chosen.model) throw new Error(`${entry.id} has no model here.`);
  return { model: chosen.model, models: chosen.models as unknown as AdapterNeeds["models"], unpriced: chosen.unpriced };
}

/** The model a CLI run is capped at: the catalog entry that bills it (its entry's priceModel), its cost WITH TIERS (the
 *  money rule: a request past a tier is held and booked at it, as main's calculateCost does), on the harness's wire. A
 *  model the catalog does not price is held at no price: its requests are unknown, never $0. */
function capModelOf(id: string, wire: string, listed: { cost?: Partial<CapPrice>; maxTokens?: number } | undefined, unpriced: boolean): CapModel {
  const cost = listed?.cost;
  const price = !unpriced && cost && typeof cost.input === "number" && typeof cost.output === "number"
    ? {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead ?? 0,
        cacheWrite: cost.cacheWrite ?? 0,
        ...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ inputTokensAbove: tier.inputTokensAbove, input: tier.input, output: tier.output, cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite })) } : {}),
      }
    : null;
  return { id, api: wire, price, outputCeiling: typeof listed?.maxTokens === "number" ? listed.maxTokens : null };
}
type CapPrice = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers: readonly { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[] };

/**
 * One claimed CLI run's AdapterRunSpec, built from its launch record and its revision.
 *
 * `launch` is the run's launch body (run-launch.ts), read by the dispatch at the claim; `run` is the loop's open Harness
 * (AdapterRun: a CLI adds no turns to it, its records are its session's); `deps` is the runner's store, data directory
 * and environment; `claim` is the claim this pass holds.
 */
export async function cliRunSpecFromLaunch(launch: RunLaunch, run: AdapterRun, deps: CliSpecDeps, claim: Claim): Promise<AdapterRunSpec> {
  void run;
  const context = BACKGROUND_CONTEXT;
  const log = deps.log ?? (() => {});
  const runRow = await deps.store.runs.get(claim.runId);
  if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
  const revisionRow = await deps.store.agents.revision(runRow.revisionId);
  if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
  const body = (revisionRow.body ?? {}) as RevisionBody;
  const revision = { kind: revisionRow.kind, body } as { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } };
  const granted = body.tools ?? [];

  // The harness: the launch's, else the revision's. Its table entry (facts, model choice, adapter, skill check) and the
  // runner's record mode for it.
  const name = launch.harness ?? body.harness;
  const entry = builtinHarness(name);
  const runner = name === undefined ? undefined : resolveHarness(name);
  if (!name || !entry?.facts || !entry.adapter || !runner) throw new Error(`run ${claim.runId}: ${JSON.stringify(name)} is not a CLI harness this runner runs`);
  const facts = entry.facts;

  // The run's Workspace at the claim, its uploaded files copied into work/inputs/ once, and a sandbox run's computer, as
  // the pi spec makes them (Mode 1; Mode 2 is the pi spec's TODO too).
  const ws = await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log });
  if (launch.files?.length) {
    const copied = await ws.workspace.list(INPUTS_DIR).then(() => true, () => false);
    if (!copied) {
      const uploads = new Uploads(join(deps.data, UPLOADS_DIR));
      await uploads.copyInto(ws.workspace, await uploads.readyFiles(launch.files));
    }
  }
  const computer = launch.place.mode === "sandbox"
    ? await dockerComputer(ws.workspace, {
        runId: claim.runId,
        epoch: claim.epoch,
        ...(launch.boxAllow !== undefined ? { boxAllow: launch.boxAllow } : {}),
        ...(deps.env.AGENTRUN_DOCKER_IMAGE ? { image: deps.env.AGENTRUN_DOCKER_IMAGE } : {}),
      }, deps.makeProvider)
    : undefined;
  const tools = await runTools(ws.workspace, computer?.run, { mode: 1, context });
  const root = runFolder(deps.data, runRow.agentId, claim.runId);

  // The system prompt, as main's harness branch builds it: the environment line, the instructions with what the agent
  // learned folded in, and its skills through systemOf with the harness's own check (a harness that loads skills itself
  // keeps in the prompt only those it would refuse, and is handed the rest), then the effort guidance.
  const learned = await withLearned(root, ws.workspace, body.instructions ?? "", Object.keys(body.skills ?? {}));
  const check = await entry.skillCheck?.();
  const { system: instructions, native } = await systemOf(learned.instructions, learned.skills, ws.workspace, check, { onDemand: readsFiles(granted) });
  const guidance = effortGuidance(launch.effort);

  // The run's model (the launch's, pinned at start, else the revision's) and its adapter, as main builds them.
  const ref = launch.model ? `${launch.model.provider}/${launch.model.modelId}` : body.model;
  const chosen = await modelsOf(entry, deps.env, ref);
  // The harness's install is under the runner's data directory (harness-install.ts installDirOf), which the table's
  // adapter reads from DATA_ENV, as main's per-run process was handed it.
  const built = await entry.adapter({ ...deps.env, [DATA_ENV]: deps.data }, { model: chosen.model, models: chosen.models, unpriced: chosen.unpriced, ...(native.length ? { skills: native } : {}) });
  // The harness's own files (its home, its state) go in a private directory of the run's scratch, outside the disk, so no
  // Workspace, and none of the run's file tools, reaches them; it works in the run's folder itself, the one its file tools
  // confine to, so a path it builds from its working directory is one they take (as main's harness branch lends both).
  const dir = join(scratchFolder(deps.data, runRow.agentId, claim.runId), "harness");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const adapter: typeof built = { ...built, open: (spec, io) => built.open(spec, { ...io, dir, cwd: root }) };

  // The run's cap (its launch's maxCostUsd): the kernel's check before each paid request, at the catalog price of the
  // model that bills the run, and what a refusal does to the run, with the kernel's raise rule.
  const priced = entry.priceModel(deps.env, chosen.model);
  const listed = chosen.models.getModel(priced.provider, priced.modelId) as { cost?: Partial<CapPrice>; maxTokens?: number } | undefined;
  const capModel = capModelOf(priced.modelId, facts.wire, listed, chosen.unpriced.has(priced.modelId) || listed === undefined);
  const capUsd = launch.maxCostUsd;
  const beforeRequest: BeforeRequest | undefined = capUsd === undefined
    ? undefined
    : beforeRequestOf({
        capUsd: () => launch.maxCostUsd,
        // One model per CLI session: every request it sends is the run's model, whatever id its provider names it by.
        modelOf: () => capModel,
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

  // The gate before a call's intent: the revision's tool settings over the store's, read once at the claim.
  const serverSettings = await loadToolSettings(deps.store);
  const gate = runGate({ root, work: root }, claim.runId, revision, () => serverSettings);

  // The run's tools: the kernel registry's hands on its Workspace (and computer). TODO, as the pi spec's: the non-hand
  // tools (web_fetch, web_search, monid, the learned workflow) as host tools under the run's gate.
  const results: ToolResults = new Map();
  const session: SessionSpec = {
    key: `run:${claim.runId}`,
    label: runRow.agentId,
    system: [environmentLine(), instructions, guidance].filter((line): line is string => Boolean(line)),
    tools: tools.hostTools(granted, undefined, results),
    context: "fresh",
    ...(launch.effort ? { thinking: thinkingFor(facts, launch.effort) } : {}),
  };

  const content = isObject(launch.input) && typeof (launch.input as { content?: unknown }).content === "string" ? (launch.input as { content: string }).content : "";
  const input = await firstMessage(content, root);

  return {
    adapter,
    session,
    input,
    ...(runner.record ? { record: runner.record } : {}),
    gate: (call) => gate.policy(call.tool),
    ...(beforeRequest ? { beforeRequest } : {}),
    ...(cap ? { cap } : {}),
    agentId: runRow.agentId,
    workRoot: root,
    // The end's metrics and cost from the run's journal; a CLI run's carry its model.
    endPatch: async () => {
      const entries = await entriesOf(deps.journal(claim), ROOT_CONVERSATION_ID, context);
      const { metrics, costUsd } = runMetrics(entries as never, { ...(launch.effort !== undefined ? { effort: launch.effort } : {}), model: `${chosen.model.provider}/${chosen.model.modelId}` });
      return { ...(costUsd !== null ? { costUsd } : {}), metrics };
    },
    release: async () => {
      await tools.end().catch((error: unknown) => log(`the run's tools' end failed: ${(error as Error)?.message ?? String(error)}`));
      if (computer) await computer.release().catch((error: unknown) => log(`the run's computer could not be let go: ${(error as Error)?.message ?? String(error)}`));
      await ws.end().catch((error: unknown) => log(`the run's workspace end failed: ${(error as Error)?.message ?? String(error)}`));
    },
  };
}
