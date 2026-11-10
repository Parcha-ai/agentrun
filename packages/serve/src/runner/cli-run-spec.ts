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
import { type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { SessionSpec } from "@parcha/agentrun-kernel";
import type { AdapterNeeds } from "../adapters.js";
import { thinkingFor } from "../adapters.js";
import type { Approvals } from "../approvals.js";
import { effortGuidance } from "../effort-guidance.js";
import { environmentLine } from "../environment.js";
import { type HarnessEntry, harnessOf } from "../harness-table.js";
import { laidLearned, learningFolderOf, secretsShown } from "../learning.js";
import { layLearningSeed } from "./learning-seed.js";
import { savedKeyValues } from "../server-keys.js";
import { learningWorkspace } from "../learn/folder.js";
import { learningEndOfRun } from "./learning-end.js";
import { type ModelRef, providerModels, runModels } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import { learningStartOf, type RunLaunch } from "../run-launch.js";
import { readsFiles, systemOf } from "../skills.js";
import { DATA_ENV } from "../server-fs.js";
import { INPUTS_DIR, UPLOADS_DIR, Uploads } from "../uploads.js";
import { isObject } from "../validate.js";
import { runFolder, scratchFolder } from "../workspace/paths.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { layOwnSkills } from "../workspace/revision-skills.js";
import { runTools, type ToolResults } from "../workspace/run-tools.js";
import { archilClaim, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { loadArchilSettings } from "../archil-settings.js";
import type { Workspace } from "../workspace/workspace.js";
import type { ComputerSetting } from "../computer-setting.js";
import type { AdapterRun, AdapterRunSpec, RunCapConfig } from "./adapter-loop.js";
import { adapterRunGate, type AdapterSpecDeps, answersCut, hostToolCtxOf, learnedWorkflowHostTool } from "./adapter-run-spec.js";
import { mcpServersOf } from "../tool-gate.js";
import { signInReads } from "../sign-ins-store.js";
import { claimSecrets } from "./claim-secrets.js";
import { mcpForClaim } from "./mcp-run.js";
import { LEARNED_WORKFLOW_TOOL } from "../learned-workflow.js";
import { TOOL_PLANE_ENV } from "../tool-plane.js";
import { resolveHarness } from "./adapters/index.js";
import { entriesOf } from "./loop.js";
import type { Claim } from "./loop-contract.js";
import { runMetrics } from "./metrics.js";
import { heldRedactor, holdClaimed, runnerSecrets, secretRedactor } from "./redact.js";
import { githubAppAccess } from "./github-app.js";
import { holdStored } from "./store-secrets.js";

/** The shared claim-time computer types live on the base spec (adapter-run-spec.ts), re-exported for this module's API. */
export type { ClaimComputer, ClaimDeps, ClaimLaunch, ComputerForClaim } from "./adapter-run-spec.js";

/** What the runner hands the CLI spec builder: the same deps the pi spec takes (computerForClaim, computerDeps and
 *  makeArchilDisk are on AdapterSpecDeps, shared by both). One per runner. */
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
  const context = BACKGROUND_CONTEXT;
  // The spec's log lines carry error text (a release, a computer, a workspace's end): cut of every secret the runner's env
  // holds.
  const cut = heldRedactor(secretRedactor(runnerSecrets(deps.env)));
  const log = (line: string) => (deps.log ?? (() => {}))(cut(line));
  const runRow = await deps.store.runs.get(claim.runId);
  if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
  // Every secret the server keeps sealed (store-secrets.ts) held by the runner's one redactor (the loop's) and this spec's
  // log cut, before any of the run's text is written: a run's text may quote one it was never handed.
  for (const redact of [...(run.redact ? [heldRedactor(run.redact)] : []), cut]) await holdStored(redact, deps.store, deps.sealKey, deps.data);
  const revisionRow = await deps.store.agents.revision(runRow.revisionId);
  if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
  const body = (revisionRow.body ?? {}) as RevisionBody;
  const revision = { kind: revisionRow.kind, body } as { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } };
  const granted = body.tools ?? [];

  // The run's MCP for this claim (mcp-run.ts mcpForClaim): its pin made at the first claim or read as written, its
  // credentials opened under the runner's seal key (deps.sealKey) into this claim's memory, one gateway for the claim.
  // First, before the session opens: a refusal (a pin that cannot be made, a pinned meta tool) ends the run in its words.
  const mcp = await mcpForClaim({ claim, store: deps.store, sealKey: deps.sealKey, grants: granted, harness: run.harness, work: () => runFolder(deps.data, runRow.agentId, claim.runId), launchInput: launch.input, githubAppAccess: (store, key, input) => githubAppAccess(store, key, input, deps.githubApi ? { api: deps.githubApi } : {}), ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}) });

  // The harness: the launch's, else the revision's. Its table entry (facts, model choice, adapter, skill check), read from
  // the run's environment table as main does (harnessOf: the built-in entries, a test's module merged over them under a
  // test runner; anywhere else it is the built-ins), and the runner's record mode for it.
  const name = launch.harness ?? body.harness;
  const entry = harnessOf(deps.env, name);
  const runner = name === undefined ? undefined : resolveHarness(name);
  if (!name || !entry?.facts || !entry.adapter || !runner) throw new Error(`run ${claim.runId}: ${JSON.stringify(name)} is not a CLI harness this runner runs`);
  const facts = entry.facts;

  // The run's mode is the server's: Mode 2 where its Archil settings are saved (archil-settings.ts), the run's folder then
  // on the claim's Archil disk (archil-claim.ts: its keys from the store's sealed rows, under the runner's seal key, in
  // this claim's memory only, dropped at the release); else Mode 1, the run's local folder.
  const archilSettings = await loadArchilSettings(deps.store);
  const mode: 1 | 2 = archilSettings === undefined ? 1 : 2;
  const archil = archilSettings === undefined
    ? undefined
    // The run's mount credential, minted per run (account key from the server's environment first, then the sealed row),
    // named for the run and this claim's epoch; revoke at the run's end (below). mountControl (a test's loopback control-plane
    // fake) is spread into the mount, so no test reaches the real control plane. TODO(k2 lazy mint): the mint moves into
    // computerForClaim (a mounting computer only), with the ttl the run's lifetime bound (not this fixed figure). As pi does.
    : await archilClaim({ settings: archilSettings, keys: deps.store.sealedKeys, sealKey: deps.sealKey, signal: run.signal ?? new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS, ...(deps.mountControl ?? {}) }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) });
  // The run's Workspace at the claim, and its uploaded files copied into work/inputs/ once.
  const ws = archil === undefined
    ? await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log })
    : await openRunWorkspace({ mode: 2, agentId: runRow.agentId, runId: claim.runId, archil, log });
  if (launch.files?.length) {
    const copied = await ws.workspace.list(INPUTS_DIR).then(() => true, () => false);
    if (!copied) {
      const uploads = new Uploads(join(deps.data, UPLOADS_DIR));
      await uploads.copyInto(ws.workspace, await uploads.readyFiles(launch.files));
    }
  }
  // The run's computer, from the one shared claim-time function (the pi spec takes the same): none for a runner place.
  // It throws computer_unavailable (nothing made) when the computer cannot be had: the run fails in its words.
  const computer = await deps.computerForClaim(
    { runId: claim.runId, epoch: claim.epoch, revisionId: runRow.revisionId, place: launch.place, ...((launch as { computer?: ComputerSetting }).computer !== undefined ? { computer: (launch as { computer?: ComputerSetting }).computer } : {}) },
    deps.store,
    // revokeMount removes the run's Archil mount credential at the computer's release (and if a start fails after a mint); the
    // run's end revokes it too, so it goes on every outcome even with no computer. Idempotent. As the pi spec does.
    { ...deps.computerDeps, mode, workspace: ws.workspace, sealKey: deps.sealKey, ...(archil ? { revokeMount: () => archil.revoke() } : {}) },
  );

  // The CLI works in the run's scratch folder on this machine (its working directory, swept at the run's end), its own
  // files (home, state) in a private folder inside it, never on the run's disk. The scratch is an alias of the run's
  // folder for the run's file tools: a path the CLI builds from its working directory lands in the run's folder, and any
  // other absolute path is refused (workspace/paths.ts portPath).
  const scratch = scratchFolder(deps.data, runRow.agentId, claim.runId);
  const dir = join(scratch, "harness");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // The run's mode bounds its shell: 600 s locally or on a computer, 295 s on Archil's serverless exec (Mode 2, none).
  const tools = await runTools(ws.workspace, computer.computer, { mode, context, aliases: [scratch] });
  const root = runFolder(deps.data, runRow.agentId, claim.runId);

  // The system prompt, as main's harness branch builds it: the environment line, the instructions with what the agent
  // learned laid in (learning.ts laidLearned, from the launch's learning start, so the runner reads no learning folder), its
  // own skills through systemOf with the harness's own check (a harness that loads skills itself keeps in the prompt only
  // those it would refuse, and is handed the rest), then the effort guidance.
  const start = learningStartOf(launch);
  const laid = start ? laidLearned(body.instructions ?? "", start.section) : (body.instructions ?? "");
  const check = await entry.skillCheck?.();
  // The revision's own skills laid before they are read, as the pi spec lays them (adapter-run-spec.ts).
  await layOwnSkills(ws.workspace, (revisionRow.skills ?? {}) as Record<string, string>, { computer: (launch as { computer?: ComputerSetting }).computer?.kind });
  // A learning run's seed laid as the pi spec lays it (runner/learning-seed.ts), its learned skills then in the skill list
  // the harness is handed (its native skills, or the prompt's), its learned workflows the ones learned_workflow runs.
  const seedLaid = start
    ? await layLearningSeed({
      work: ws.workspace,
      seed: start.seed,
      folder: () => (archil === undefined ? learningFolderOf(deps.data, runRow.agentId) : learningWorkspace({ mode: "archil", agentId: runRow.agentId, archil })),
      own: Object.keys(revisionRow.skills ?? {}),
      shown: async () => secretsShown(runnerSecrets(deps.env, await savedKeyValues(deps.store, deps.sealKey))),
      log,
    })
    : undefined;
  const { system: instructions, native } = await systemOf(laid, [...Object.keys(body.skills ?? {}), ...(seedLaid?.skills ?? [])], ws.workspace, check, { onDemand: readsFiles(granted) });
  const guidance = effortGuidance(launch.effort);

  // The run's model (the launch's, pinned at start, else the revision's) and its adapter, as main builds them, on the
  // environment main's server gives its runs: the server's data directory named (DATA_ENV), so the CLI's install is
  // looked up there (the data's harnesses directory), never under the runner's HOME.
  const env: NodeJS.ProcessEnv = { ...deps.env, [DATA_ENV]: deps.data };
  const ref = launch.model ? `${launch.model.provider}/${launch.model.modelId}` : body.model;
  const chosen = await modelsOf(entry, env, ref);
  const built = await entry.adapter(env, { model: chosen.model, models: chosen.models, unpriced: chosen.unpriced, ...(native.length ? { skills: native } : {}) });
  // The harness's own session options, its private directory and its working directory (SessionIO's dir and cwd, which
  // every CLI adapter reads), set on its open here, so the loop lends the session nothing of its own. A turn that ends on
  // the CLI's own error names the harness first, as main words it (harness-app.ts: `<harness>: <error>`), so the run's
  // error and its Timeline row say which CLI said it.
  const adapter: typeof built = {
    ...built,
    open: async (spec, io) => {
      const session = await built.open(spec, { ...io, dir, cwd: scratch });
      const turnEnd = session.turnEnd.bind(session);
      return Object.assign(session, { turnEnd: async () => {
        const end = await turnEnd();
        return end.error ? { ...end, error: `${name}: ${end.error}` } : end;
      } });
    },
  };

  // The run's cap (its launch's maxCostUsd): the kernel's check before each paid request, at the catalog price of the
  // model that bills the run, and what a refusal does to the run, with the kernel's raise rule.
  const priced = entry.priceModel(env, chosen.model);
  const listed = chosen.models.getModel(priced.provider, priced.modelId) as { cost?: Partial<CapPrice>; maxTokens?: number } | undefined;
  const capModel = capModelOf(priced.modelId, facts.wire, listed, chosen.unpriced.has(priced.modelId) || listed === undefined);
  const capUsd = launch.maxCostUsd;
  // The run's one cap, as the loop's runCap reads it (adapter-loop.ts RunCapConfig): the launch's cap figure (undefined
  // uncapped), the model that bills this CLI run priced WITH tiers, strict where the launch says. The loop builds the
  // kernel runCap from these over the run's own sessions; the spec carries no beforeRequest of its own.
  const runCap: RunCapConfig = {
    capUsd: () => launch.maxCostUsd,
    // One model per CLI session: every request it sends is the run's model, whatever id its provider names it by.
    modelOf: () => capModel,
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

  // The gate before a call's intent, the same as the pi spec: the revision's tool settings over the store's, read from the
  // store at each decide, and the turn's origin read through the run's Workspace (Mode 2: on the run's disk) — adapterRunGate
  // (RunGate.decide: the reflect-turn .learning refusal, deny with its words, a pin, allow, ask).
  const gate = await adapterRunGate(deps.store, claim, revision, ws.workspace, mcpServersOf(granted));

  // The run's tools: the kernel registry's hands on its Workspace (and computer), beside the learned_workflow tool when the
  // claim's seed lay chose learned workflows (seedLaid.workflows, as the pi spec lists them). A CLI harness's session has
  // a model port, so learned_workflow runs for real on the session's proxied models (learnedWorkflowHostTool), each node
  // a request on the run's one route labelled learned_workflow, booked on the run's one ledger. Its call nodes run the agent's tools' effects on the run's scoped
  // keys (claim-secrets.ts), the run's plane threaded for the web tools among them. (web_fetch/web_search/monid as the CLI's
  // own host tools are still a TODO, as the pi spec binds them.)
  const results: ToolResults = new Map();
  let learnedTool: Awaited<ReturnType<typeof learnedWorkflowHostTool>>;
  // The keys the claim hands the run (its learned workflow's call nodes run on them): never learned (learningEndOfRun).
  let handedKeys: string[] = [];
  if (granted.includes(LEARNED_WORKFLOW_TOOL)) {
    const toolEnv = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, revisionRow as unknown as Parameters<typeof claimSecrets>[1], launch);
    handedKeys = runnerSecrets(toolEnv);
    // The keys it opened join the runner's one redactor (the loop's), and this spec's log cut.
    for (const redact of [...(run.redact ? [heldRedactor(run.redact)] : []), cut]) holdClaimed(redact, toolEnv);
    delete toolEnv[TOOL_PLANE_ENV];
    if (launch.plane && Object.keys(launch.plane).length) toolEnv[TOOL_PLANE_ENV] = JSON.stringify(launch.plane);
    learnedTool = await learnedWorkflowHostTool({ run, granted, plane: launch.plane, env: toolEnv, work: root, workflows: seedLaid?.workflows ?? [], ctx: hostToolCtxOf(run, context, results, root) });
  }
  const session: SessionSpec = {
    key: `run:${claim.runId}`,
    label: runRow.agentId,
    system: [environmentLine(), instructions, guidance].filter((line): line is string => Boolean(line)),
    // The learned workflow's call nodes run on the claim's keys: its answers pass the runner's one redactor, as pi's do.
    tools: [...tools.hostTools(granted, undefined, results), ...(learnedTool ? [answersCut(learnedTool, run.redact ? heldRedactor(run.redact) : cut)] : [])],
    context: "fresh",
    ...(launch.effort ? { thinking: thinkingFor(facts, launch.effort) } : {}),
  };

  const content = isObject(launch.input) && typeof (launch.input as { content?: unknown }).content === "string" ? (launch.input as { content: string }).content : "";
  const input = await firstMessage(content, ws.workspace);

  // The run's end-of-run step, when it learns, the same as the pi spec's: the reflect-and-propose turn over the run's
  // store, its learning folder where the run's place keeps it — Mode 1 under the data directory, Mode 2 on this claim's
  // Archil disk — so the proposal is checked against the seed in the run's own Workspace, never this machine's local path.
  const endOfRun = learningEndOfRun(launch, {
    store: deps.store,
    data: deps.data,
    ...(deps.env ? { env: deps.env } : {}),
    // What the run must never learn beside the runner's secrets: the keys its claim handed it, and its sign-in's pointers,
    // read back from the store's sign-ins under the seal key (learning-run.ts refused, on the runner).
    signIns: signInReads(deps.store, deps.sealKey),
    handed: handedKeys,
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
    ...(runner.record ? { record: runner.record } : {}),
    gate,
    runCap,
    ...(cap ? { cap } : {}),
    // The run's MCP for a harness with its own client (mcp-run.ts), the session the adapter mounts; absent when none.
    ...(mcp ? { mcp } : {}),
    // The run's end-of-run step, when it learns (the spec's, preferred over the loop's deps': adapter-loop.ts stepOf).
    ...(endOfRun ? { endOfRun } : {}),
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
      await computer.release().catch((error: unknown) => log(`the run's computer could not be let go: ${(error as Error)?.message ?? String(error)}`));
      // The run's Archil mount credential, revoked at its end on every outcome, even with no computer (idempotent with the
      // computer's release). A run that minted none revokes nothing.
      await archil?.revoke().catch((error: unknown) => log(`the run's Archil mount credential could not be revoked: ${(error as Error)?.message ?? String(error)}`));
      await ws.end().catch((error: unknown) => log(`the run's workspace end failed: ${(error as Error)?.message ?? String(error)}`));
      // The claim's Archil keys go from memory once nothing more reads the disk.
      archil?.release();
    },
  };
}
