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
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { type CapModel, type CapRefused, checkRaise, followUpOf, parkOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { HostTool, SessionSpec } from "@parcha/agentrun-kernel";
import type { AdapterNeeds } from "../adapters.js";
import { confineOf, noNewPrivsPrefix, standsIn, thinkingFor } from "../adapters.js";
import { claimSettled, installDirOf, installForClaim, installingWords } from "../harness-install.js";
import { HarnessUnavailable } from "../provider.js";
import type { Approvals } from "../approvals.js";
import { effortGuidance } from "../effort-guidance.js";
import { wireName } from "../catalog.js";
import { environmentLine } from "../environment.js";
import { type HarnessEntry, harnessOf } from "../harness-table.js";
import { laidLearned, learningFolderOf, secretsShown } from "../learning.js";
import { laidOf, layLearningSeed } from "./learning-seed.js";
import { learningWorkspace } from "../learn/folder.js";
import { learningEndOfRun } from "./learning-end.js";
import { type ModelRef, type PinnedModel, providerModels, runModels, type Tier } from "../model.js";
import { firstMessage } from "../run-manifest.js";
import { learningStartOf, seedFailed, type RunLaunch } from "../run-launch.js";
import { readsFiles, systemOf } from "../skills.js";
import { DATA_ENV } from "../server-fs.js";
import { copyRunFiles } from "../uploads.js";
import { isObject } from "../validate.js";
import { runFolder, scratchFolder } from "../workspace/paths.js";
import { openRunWorkspace } from "../workspace/run-workspace.js";
import { layOwnSkills } from "../workspace/revision-skills.js";
import { runTools, type ToolResults, withKindTools } from "../workspace/run-tools.js";
import { archilClaim, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import { loadArchilSettings } from "../archil-settings.js";
import type { ComputerSetting } from "../computer-setting.js";
import { computerReadyWords, imageWaitWords } from "../workspace/computer-deps.js";
import { type AdapterRun, type AdapterRunSpec, hostLifecycle, type RunCapConfig } from "./adapter-loop.js";
import { adapterRunGate, type AdapterSpecDeps, answersCut, buildToolHost, capModelOf as capModelOfRoute, hostToolCtxOf, type LearnedTier, learnedTierRoutes, learnedTiers, learnedWorkflowHostTool, learnsWorkflows, modelAskOf, PI_WIRES, webHostTools, webToolNames } from "./adapter-run-spec.js";
import { openTierProxies, type TierProxies } from "./adapters/pi.js";
import type { ModelRoute } from "./model-route.js";
import { signInReads } from "../sign-ins-store.js";
import { mcpServersOf } from "../tool-gate.js";
import { claimSecrets, hostDecisionKeys, learnedDecisionKeys, tierModelKeys, withModelKeys } from "./claim-secrets.js";
import { mcpForClaim } from "./mcp-run.js";
import { DECISION_PROVIDER_KEYS, TOOL_PLANE_ENV } from "../tool-plane.js";
import { decisionProvidersIn } from "../decisions.js";
import { resolveHarness } from "./adapters/index.js";
import { entriesOf } from "./loop.js";
import type { Claim } from "./loop-contract.js";
import { bookedSpend, cliModelWorked, cliRunMetrics, runEndCost } from "./metrics.js";
import { journalEntries } from "./journal-reader.js";
import { pathMetrics, workflowFirstOf } from "./workflow-first.js";
import { pastRunsOverStore, runPathOverStore } from "../store-reads/learning.js";
import { type SpecHolds, specBuilt } from "./spec-holds.js";
import { heldRedactor, holdClaimed, runnerSecrets, secretRedactor } from "./redact.js";
import { heldSpecOf } from "./held-run.js";
import { loopComputerOf } from "./computer-channel.js";
import { githubAppAccess } from "./github-app.js";
import { type Checkout, prCheckoutForClaim } from "./pr-checkout.js";
import { holdStored, storeSecrets } from "./store-secrets.js";
import { bashPolicyOf } from "../bash-read-only.js";

/** The shared claim-time computer types live on the base spec (adapter-run-spec.ts), re-exported for this module's API. */
export type { ClaimComputer, ClaimDeps, ClaimLaunch, ComputerForClaim } from "./adapter-run-spec.js";

/** What the runner hands the CLI spec builder: the same deps the pi spec takes (computerForClaim, computerDeps and
 *  makeArchilDisk are on AdapterSpecDeps, shared by both). One per runner. */
export type CliSpecDeps = AdapterSpecDeps;

/** What a CLI harness refuses of an agent's computer, in words: a browser, which only pi's browser tool drives. */
export const cliRefusesKind = (kind: string): string | undefined =>
  kind === "browser" ? "This agent's computer is a browser, which only the pi harness drives here: pick pi for this agent, or another kind of computer in Settings → Computers." : undefined;

/** The revision's body, as the fields the spec reads of it. */
type RevisionBody = {
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly toolSettings?: unknown;
  readonly harness?: string;
  readonly model?: string;
  readonly approvals?: Approvals;
  readonly skills?: Record<string, unknown>;
  /** What the server checks out in the run's folder before its first turn (pr-checkout.ts). */
  readonly checkout?: Checkout;
};

/** The run's model and the catalog that prices it, as main chooses a CLI run's (app.ts wireModels and runModels): on the
 *  harness's own wire where its entry says its model is chosen there (a pin there is its own provider/model-id, never a
 *  gateway's), else as the run's usual models, a pin sent as pinned (modelAskOf). */
async function modelsOf(entry: HarnessEntry, env: NodeJS.ProcessEnv, ref: string | PinnedModel | undefined): Promise<{ model: ModelRef; models: AdapterNeeds["models"]; unpriced: ReadonlySet<string> }> {
  if (entry.onWire(env)) {
    const choice = await entry.model(env, typeof ref === "object" ? `${ref.pinned.provider}/${ref.pinned.modelId}` : ref, true);
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

/** A CLI run's environment: the runner's run environment (`env`, runner/main.ts runEnv), built from it itself and never
 *  a spread of it, with the model keys the claim opened (`claimed`, withModelKeys) and the server's data directory named
 *  (DATA_ENV). The run environment's secrets, and the keys added, are readable by name and never enumerable: the
 *  harness's model route finds the key its requests carry (model.ts, `env[row.field]`) while a program spawned with this
 *  environment carries none. A spread would drop every secret the launcher handed the runner, and the route would send no
 *  key. The data directory is a plain variable, which a spawn carries. So is the run's resolved tool plane (`plane`,
 *  TOOL_PLANE_ENV, not a secret), as main hands its per-run process: the adapter reads web_search's there (adapters.ts
 *  nativeOptions: claude-agent's WebSearch, codex's live search, admitted by its proxy's policy and priced with it), so a
 *  run whose plane resolves it to native gets the harness's own search (#2458), this run's alone; whatever the runner's
 *  own environment says of a plane is never the run's. Whether each search runs is the tool's setting at that search
 *  (SessionIO.permission, the gate), never this plane, which is frozen when the run is made. */
export function cliRunEnv(env: NodeJS.ProcessEnv | undefined, data: string, claimed: NodeJS.ProcessEnv = {}, plane?: RunLaunch["plane"]): NodeJS.ProcessEnv {
  const out = withModelKeys(env ?? {}, claimed);
  Object.defineProperty(out, DATA_ENV, { value: data, enumerable: true, writable: true, configurable: true });
  delete out[TOOL_PLANE_ENV];
  if (plane && Object.keys(plane).length) Object.defineProperty(out, TOOL_PLANE_ENV, { value: JSON.stringify(plane), enumerable: true, writable: true, configurable: true });
  return out;
}

/** `tools` in the order the agent grants them (`granted`, catalog names; a tool is listed by its catalog name's wire
 *  name), as main listed a CLI run's tools to its harness: each granted tool where its grant is, and a tool the grant
 *  does not name (one a granted tool or the run's computer brings beside it) right after the tool listed before it. Ties
 *  keep the order given. */
export function inGrantOrder<T extends { readonly name: string }>(tools: readonly T[], granted: readonly string[]): T[] {
  const at = new Map(granted.map((name, index) => [wireName(name), index]));
  let last = -1;
  const keyed = tools.map((tool, given) => {
    const index = at.get(tool.name);
    if (index !== undefined) last = index;
    return { tool, key: index ?? last + 0.5, given };
  });
  return keyed.sort((a, b) => a.key - b.key || a.given - b.given).map(({ tool }) => tool);
}

/** Every earlier claim's private folder of the run (`<harnesses>/<n>`, n below `epoch`) removed: what a claim whose runner
 *  died left (its release never ran), or a sweep of its own cut off partway. A claim at `epoch` or later (a live one, or a
 *  next claim's while this one lets go late) is never touched. Each removal is whole or is finished by the next sweep. */
export async function sweepEarlier(harnesses: string, epoch: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(harnesses);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (/^\d+$/.test(name) && Number(name) < epoch) await rm(join(harnesses, name), { recursive: true, force: true });
  }
}

/** A claim's end: every earlier claim's folder of the run (sweepEarlier) and the claim's own (`<harnesses>/<epoch>`)
 *  removed, then each of `parents` in order while it is empty: one another claim of the run has laid things in since (a
 *  follow-up's) stays, with what is in it. Run again over what a cut-off sweep left, it finishes it. */
export async function sweepScratch(harnesses: string, epoch: number, parents: readonly string[]): Promise<void> {
  // An earlier folder that cannot be swept never keeps this claim's own folder: its removal is attempted anyway, and the
  // earlier failure is thrown after it (with this one's, when both fail).
  const failures: unknown[] = [];
  await sweepEarlier(harnesses, epoch).catch((error: unknown) => { failures.push(error); });
  await rm(join(harnesses, String(epoch)), { recursive: true, force: true }).catch((error: unknown) => { failures.push(error); });
  if (failures.length === 0) await rmEmptyParents(parents);
  else await rmEmptyParents(parents).catch((error: unknown) => { failures.push(error); });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failures.map((error) => (error as Error)?.message ?? String(error)).join("; "));
}

async function rmEmptyParents(parents: readonly string[]): Promise<void> {
  for (const parent of parents) {
    try {
      await rmdir(parent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      // Already gone (a sweep cut off after it, or never made): the folder above it may still be left empty.
      if (code !== "ENOENT") throw error;
    }
  }
}

/**
 * One claimed CLI run's AdapterRunSpec, built from its launch record and its revision.
 *
 * `launch` is the run's launch body (run-launch.ts), read by the dispatch at the claim; `run` is the loop's open Harness
 * (AdapterRun: a CLI adds no turns to it, its records are its session's); `deps` is the runner's store, data directory
 * and environment; `claim` is the claim this pass holds.
 */
export function cliRunSpecFromLaunch(launch: RunLaunch, run: AdapterRun, deps: CliSpecDeps, claim: Claim): Promise<AdapterRunSpec> {
  // What it makes for the run (its Archil mount credential, its Workspace, its computer, its tools) is held until the
  // spec's release; a build that throws part-way lets go what it made by then (spec-holds.ts).
  return specBuilt((holds) => cliSpec(launch, run, deps, claim, holds));
}

async function cliSpec(launch: RunLaunch, run: AdapterRun, deps: CliSpecDeps, claim: Claim, holds: SpecHolds): Promise<AdapterRunSpec> {
  const context = BACKGROUND_CONTEXT;
  // The spec's log lines carry error text (a release, a computer, a workspace's end): cut of every secret the runner's env
  // holds.
  const cut = heldRedactor(secretRedactor(runnerSecrets(deps.env)));
  const log = (line: string) => (deps.log ?? (() => {}))(cut(line));
  holds.logTo(log);
  const runRow = await deps.store.runs.get(claim.runId);
  if (!runRow) throw new Error(`run ${claim.runId}: its row is gone from the store`);
  // The claim's private folder is swept at the spec's release, the claim's end, then the scratch folder if nothing else is
  // in it, then the agent's: the next claim, here or on another runner, lays its own, its harness's session coming back from
  // the run's journal. Its own per claim (by the claim's epoch), so a run reopened while this claim still lets go (its
  // release follows the run's end commit) never has the next claim's folder swept from under it. A claim whose runner died
  // never ran its release: every claim sweeps the earlier claims' folders of its run at its start and again at its end, so
  // a killed CLI's home and session state never outlive the run. Held here, before any step that can fail (the install, the
  // MCP claim, the computer): a claim that fails in its setup still sweeps what the earlier claims left, as specBuilt lets
  // go what was held when the build throws.
  const scratch = scratchFolder(deps.data, runRow.agentId, claim.runId);
  const harnesses = join(scratch, "harness");
  const dir = join(harnesses, String(claim.epoch));
  holds.hold({ scratch: { sweep: () => sweepScratch(harnesses, claim.epoch, [harnesses, scratch, dirname(scratch)]) } });
  // Every secret the server keeps sealed (store-secrets.ts) held by the runner's one redactor (the loop's) and this spec's
  // log cut, before any of the run's text is written: a run's text may quote one it was never handed.
  for (const redact of [...(run.redact ? [heldRedactor(run.redact)] : []), cut]) await holdStored(redact, deps.store, deps.sealKey, deps.data);
  const revisionRow = await deps.store.agents.revision(runRow.revisionId);
  if (!revisionRow) throw new Error(`run ${claim.runId}: its revision ${runRow.revisionId} is gone from the store`);
  const body = (revisionRow.body ?? {}) as RevisionBody;
  const revision = { kind: revisionRow.kind, body } as { kind: string; body: { toolSettings?: unknown; harness?: string; approvals?: Approvals } };
  const granted = body.tools ?? [];

  // The harness: the launch's, else the revision's. Its table entry (facts, model choice, adapter, skill check), read from
  // the run's environment table as main does (harnessOf: the built-in entries, a test's module merged over them under a
  // test runner; anywhere else it is the built-ins), and the runner's record mode for it.
  const name = launch.harness ?? body.harness;
  const entry = harnessOf(deps.env, name);
  const runner = name === undefined ? undefined : resolveHarness(name);
  if (!name || !entry?.facts || !entry.adapter || !runner) throw new Error(`run ${claim.runId}: ${JSON.stringify(name)} is not a CLI harness this runner runs`);
  const facts = entry.facts;
  // The level the harness thinks at: the run's effort, else above its highest (codex stops at xhigh) its highest. The
  // run's metrics name this level, the one it ran at, never a level the harness has not.
  const thinking = launch.effort ? thinkingFor(facts, launch.effort) : undefined;

  // A harness that installs on first use (claude-agent, codex) and is not installed whole in this server's data: the claim
  // waits for the install running now (the server starts one at an agent's save), or, with none running (none started, or
  // one cut short or failed before this claim), installs it itself. One install at a time on this data, which every claim
  // that needs it waits for (harness-install.ts installForClaim), bounded by the install's own limit. The wait is said on
  // the run's timeline as it starts, its root made first (a CLI run's root is its record's, which the loop would make once
  // the session opens), so the row shows while it waits. First, before the run's MCP claim: its OAuth tokens are read
  // after a wait that may outlive them. A stop of the run ends its wait at once; an install that fails fails the run in the
  // install's own words. A test's stand-in that runs in place of the CLI (adapters.ts standsIn) loads nothing installed:
  // its claim waits for an install that runs, as any claim does, but starts none of its own.
  if (entry.installs && entry.pins) {
    const installs = entry.installs;
    const pins = entry.pins;
    const dir = installDirOf(deps.data, name);
    const waitOn = run.stopped ?? run.signal;
    let saying: Promise<void> | undefined;
    const say = (): Promise<void> => (saying ??= (async () => {
      await run.harness.root(context);
      run.phase?.(installingWords(installs.label));
    })().catch((error: unknown) => log(`the run's install wait was not said on its timeline: ${(error as Error)?.message ?? String(error)}`)));
    let waited = false;
    const settled = await (deps.installSettled ?? claimSettled)(installs, dir, await pins(), { ...(waitOn ? { signal: waitOn } : {}), onWait: () => void ((waited = true), say()) });
    // The install it waited for failed: the run fails in its words. An earlier one that failed before this claim is tried again.
    if (typeof settled === "object" && waited) throw new HarnessUnavailable(settled.failed, "install");
    if (settled !== "installed" && !standsIn(name, deps.env ?? {})) {
      await say();
      const lock = deps.harnessLocks?.[name];
      await (deps.installForClaim ?? installForClaim)(installs, dir, pins, { ...(lock ? { lock } : {}), ...(waitOn ? { signal: waitOn } : {}) }).catch((error: unknown) => {
        if (waitOn?.aborted) throw error;
        throw new HarnessUnavailable((error as Error).message, "install");
      });
    }
  }

  // The run's MCP for this claim (mcp-run.ts mcpForClaim): its pin made at the first claim or read as written, its
  // credentials opened under the runner's seal key (deps.sealKey) into this claim's memory, one gateway for the claim.
  // Before the session opens: a refusal (a pin that cannot be made, a pinned meta tool) ends the run in its words.
  // A credential the claim opens mid-run (a GitHub App token, a saved or per_run server's) joins the run's redactors.
  const hold = (values: string[]) => { for (const redact of [...(run.redact ? [heldRedactor(run.redact)] : []), cut]) redact.hold(values); };
  const mcp = await mcpForClaim({ claim, store: deps.store, sealKey: deps.sealKey, grants: granted, harness: run.harness, work: () => runFolder(deps.data, runRow.agentId, claim.runId), launchInput: launch.input, hold, githubAppAccess: (store, key, input) => githubAppAccess(store, key, input, { ...(deps.githubApi ? { api: deps.githubApi } : {}), fromGitHub: launch.inputOrigin?.kind === "trigger" && launch.inputOrigin.source === "github", hold, ...(launch.repo !== undefined ? { repo: launch.repo } : {}) }), ...(deps.githubMcpOrigin ? { githubMcpOrigin: deps.githubMcpOrigin } : {}), ...(deps.mcpLoopback ? { loopback: true } : {}) });
  // The claim's MCP goes to the loop, which lets it go; a build that throws lets it go itself.
  holds.hold({ passed: mcp });

  // The run's mode is the server's: Mode 2 where its Archil settings are saved (archil-settings.ts), the run's folder then
  // on the claim's Archil disk (archil-claim.ts: its keys from the store's sealed rows, under the runner's seal key, in
  // this claim's memory only, dropped at the release); else Mode 1, the run's local folder.
  const archilSettings = await loadArchilSettings(deps.store, deps.env);
  const mode: 1 | 2 = archilSettings === undefined ? 1 : 2;
  const archil = archilSettings === undefined
    ? undefined
    // The run's mount credential, minted per run (account key from the server's environment first, then the sealed row),
    // named for the run and this claim's epoch; revoke at the run's end (below). mountControl (a test's loopback control-plane
    // fake) is spread into the mount, so no test reaches the real control plane. TODO(k2 lazy mint): the mint moves into
    // computerForClaim (a mounting computer only), with the ttl the run's lifetime bound (not this fixed figure). As pi does.
    // The disk is the run's (run-disk.ts): its launch record's, else its agent's, made on its first run that needs one.
    : await archilClaim({ settings: archilSettings, keys: deps.store.sealedKeys, sealKey: deps.sealKey, signal: run.signal ?? new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS, ...(deps.mountControl ?? {}) }, run: { agentId: runRow.agentId, ...(launch.archilDisk ? { launch: launch.archilDisk } : {}), store: deps.store }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) });
  // Each resource is held the moment it exists (spec-holds.ts): a throw after it lets it go. The claim's Archil keys go
  // from memory last, once nothing more reads the disk.
  holds.hold({ archil, keys: archil });
  // The run's Workspace at the claim, and its uploaded files copied into work/inputs/ once.
  const ws = archil === undefined
    ? await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log })
    : await openRunWorkspace({ mode: 2, agentId: runRow.agentId, runId: claim.runId, archil, log });
  holds.hold({ ws });
  // The pull request's checkout, when the revision asks for one, as the pi spec makes it (pr-checkout.ts).
  const checkout = body.checkout === "pull_request" ? await prCheckoutForClaim(deps, ws.workspace, launch, cut, run.stopped ?? run.signal, (part) => holds.hold({ checkout: part })) : undefined;
  holds.hold({ checkout });
  if (launch.files?.length) await copyRunFiles(deps.data, claim.runId, ws.workspace, launch.files);
  // The run's computer, from the one shared claim-time function (the pi spec takes the same): none for a runner place.
  // It throws computer_unavailable (nothing made) when the computer cannot be had: the run fails in its words.
  const computer = await deps.computerForClaim(
    { runId: claim.runId, epoch: claim.epoch, claim, agentId: runRow.agentId, revisionId: runRow.revisionId, place: launch.place, ...((launch as { computer?: ComputerSetting }).computer !== undefined ? { computer: (launch as { computer?: ComputerSetting }).computer } : {}) },
    deps.store,
    // revokeMount removes the run's Archil mount credential at the computer's release (and if a start fails after a mint); the
    // run's end revokes it too, so it goes on every outcome even with no computer. Idempotent. As the pi spec does, with
    // what became of the agent's own computer said on the run's timeline.
    // A browser computer is driven by the browser tool, which runs on pi's native route alone: a CLI's run of an agent
    // whose computer is a browser is refused in words at its claim, before anything is made.
    { ...deps.computerDeps, mode, workspace: ws.workspace, sealKey: deps.sealKey, refuseKind: cliRefusesKind, ...(archil ? { revokeMount: () => archil.revoke() } : {}), ...(run.phase ? { onImageWait: (making, image) => run.phase?.(imageWaitWords(making, image)), onConnected: (said) => run.phase?.(computerReadyWords(said)), onComputerNote: (words) => run.phase?.(words) } : {}) },
  );
  holds.hold({ computer });
  const loopComputer = loopComputerOf(computer.computer, computer.held);
  const heldComputer = heldSpecOf(launch, loopComputer);

  // The CLI works in the run's scratch folder on this machine (its working directory), its own files (home, state, the
  // skills laid for it) in this claim's private folder inside it, never on the run's disk. The scratch is an alias of the
  // run's folder for the run's file tools: a path the CLI builds from its working directory lands in the run's folder, and
  // any other absolute path is refused (workspace/paths.ts portPath).
  // Made again if a parent went as it was made (another claim's sweep removing the then empty scratch or agent folder).
  for (let tries = 1; ; tries += 1) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || tries === 3) throw error;
    }
  }
  await sweepEarlier(harnesses, claim.epoch).catch((error: unknown) => log(`an earlier claim's scratch folder could not be swept: ${(error as Error)?.message ?? String(error)}`));
  // The run's shell is its computer's (600 s) where one mounts its folder; with none, Archil's serverless exec in Mode 2
  // (295 s), and in Mode 1 none at all: no bash family, its folder being one of this server's own (run-tools.ts).
  // Under the agent's bash policy, its shell's environment is the policy's too (bash-read-only.ts policyEnv), as the pi spec does.
  const bashPolicy = bashPolicyOf(body.toolSettings);
  const tools = await runTools(ws.workspace, computer.computer, { mode, context, aliases: [scratch], ...(computer.hold ? { hold: computer.hold } : {}), ...(bashPolicy === undefined ? {} : { bashPolicy }) });
  holds.hold({ tools });
  const root = runFolder(deps.data, runRow.agentId, claim.runId);

  // The system prompt, as main's harness branch builds it: the environment line, the instructions with what the agent
  // learned laid in (learning.ts laidLearned, from the launch's learning start, so the runner reads no learning folder), its
  // own skills through systemOf with the harness's own check (a harness that loads skills itself keeps in the prompt only
  // those it would refuse, and is handed the rest), then the effort guidance.
  const start = learningStartOf(launch);
  // A start whose seed failed tells the run nothing: it is never asked what to keep (learning-end.ts drops it).
  const laid = start && !seedFailed(start) ? laidLearned(body.instructions ?? "", start.section, start.use === true) : (body.instructions ?? "");
  const check = await entry.skillCheck?.();
  // The revision's own skills laid before they are read, as the pi spec lays them (adapter-run-spec.ts).
  await layOwnSkills(ws.workspace, (revisionRow.skills ?? {}) as Record<string, string>, { computer: (launch as { computer?: ComputerSetting }).computer?.kind });
  // A learning run's seed laid as the pi spec lays it (runner/learning-seed.ts), its learned skills then in the skill list
  // the harness is handed (its native skills, or the prompt's), its learned workflows the ones learned_workflow runs.
  const seedLaid = start && !seedFailed(start)
    ? await layLearningSeed({
      work: ws.workspace,
      seed: start.seed,
      folder: () => (archil === undefined ? learningFolderOf(deps.data, runRow.agentId) : learningWorkspace({ mode: "archil", agentId: runRow.agentId, archil })),
      own: Object.keys(revisionRow.skills ?? {}),
      shown: async () => secretsShown(runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data)), { local: true }),
      log,
      ...(start.notesOnly ? { workflows: false as const } : {}),
      ...(start.notesLeftOut?.length ? { notesLeftOut: start.notesLeftOut } : {}),
    })
    : undefined;
  const { system: instructions, native } = await systemOf(laid, [...Object.keys(body.skills ?? {}), ...(seedLaid?.skills ?? [])], ws.workspace, check, { onDemand: readsFiles(granted) });
  const guidance = effortGuidance(launch.effort);

  // The run's model (the launch's, pinned at start, else the revision's) and its adapter, as main builds them, on the
  // environment main's server gives its runs: the server's data directory named (DATA_ENV), so the CLI's install is
  // looked up there (the data's harnesses directory), never under the runner's HOME.
  // The run's keys for this claim (claim-secrets.ts: scoped to its tools and its model, the environment's first, then the
  // store's), held by the runner's one redactor and this spec's log cut before anything can echo one. Its model's key goes
  // to the model choice and the adapter's provider (withModelKeys, never enumerable), so a key saved in
  // Settings → Model keys runs the next run with no restart, as one set where AgentRun starts does.
  const claimed = await claimSecrets({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, revisionRow as unknown as Parameters<typeof claimSecrets>[1], launch);
  for (const redact of [...(run.redact ? [heldRedactor(run.redact)] : []), cut]) holdClaimed(redact, claimed);
  const env = cliRunEnv(deps.env, deps.data, claimed, launch.plane);
  const chosen = await modelsOf(entry, env, modelAskOf(launch.model, body.model));
  // The CLI's own process (the Claude CLI, Codex, OpenCode) starts under the no_new_privs pi's commands start under
  // (adapters.ts' noNewPrivsPrefix): on Linux, setpriv --no-new-privs, so a setuid program or file capability it
  // or a command it runs reaches grants nothing; none on macOS. Where setpriv is not usable the run is refused, in pi's words.
  const confine = confineOf(noNewPrivsPrefix());
  const built = await entry.adapter(env, { model: chosen.model, models: chosen.models, unpriced: chosen.unpriced, ...(confine ? { confine } : {}), ...(native.length ? { skills: native } : {}) });
  // The harness's own session options, its private directory and its working directory (SessionIO's dir and cwd, which
  // every CLI adapter reads), set on its open here, so the loop lends the session nothing of its own. A turn that ends on
  // the CLI's own error names the harness first, as main words it (harness-app.ts: `<harness>: <error>`), so the run's
  // error and its Timeline row say which CLI said it.
  // The run's models of other tiers, for its learned workflows' nodes of a tier (learnedTierRoutes, filled once the seed's
  // lay chose the workflows, below): each on a proxy of its own beside the CLI session's (openTierProxies, pi's), on the
  // session's booking, reached through the session's port with a `tier`. The CLI never sees them.
  const tierRoutes = new Map<Tier, ModelRoute>();
  const adapter: typeof built = {
    ...built,
    open: async (spec, io) => {
      const session = await built.open(spec, { ...io, dir, cwd: scratch });
      let tiers: TierProxies;
      try {
        tiers = await openTierProxies(tierRoutes, io.models, cut);
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
      io.signal.addEventListener("abort", () => void tiers.close(), { once: true });
      const turnEnd = session.turnEnd.bind(session);
      const close = session.close.bind(session);
      const port = session.port?.bind(session);
      return Object.assign(session, {
        turnEnd: async () => {
          const end = await turnEnd();
          return end.error ? { ...end, error: `${name}: ${end.error}` } : end;
        },
        close: async () => {
          await close();
          await tiers.close();
        },
        // The session's port; with a `tier`, that tier's proxy, while the session's own port is up (none once closed).
        port: (label: string, tier?: string) => {
          const own = port?.(label);
          return tier === undefined || own === undefined ? own : tiers.port(label, tier);
        },
      });
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
    // One model per CLI session: every request it sends is the run's model, whatever id its provider names it by. A
    // learned node's request on a tier's proxy names its tier (ModelRequest.route) and is priced as that route books it,
    // even under an id the run's model shares.
    modelOf: (id, by) => {
      if (by === undefined) return capModel;
      const tierRoute = tierRoutes.get(by as Tier);
      return tierRoute && tierRoute.model === id ? capModelOfRoute(tierRoute) : undefined;
    },
    ...(launch.capMode === "strict" ? { mode: "strict" as const } : {}),
  };
  const cap = capUsd === undefined
    ? undefined
    : {
        capUsd,
        // A park names the cap the loop holds the run to then (a raise's, else this one).
        park: (refusal: { message: string; forGood: boolean; figures?: CapRefused["figures"] }, capNow: number) => parkOf(refusal as CapRefused, capNow),
        checkRaise,
        followUpOf: (raised: number) => followUpOf(raised),
      };

  // The gate before a call's intent, the same as the pi spec: the revision's tool settings over the store's, read from the
  // store at each decide — adapterRunGate (RunGate.decide: deny with its words, a pin, allow, ask). The end-of-run turn's
  // refusal of writes under .learning/ is the adapter loop's own (it knows the turn), never a file's. The run's MCP servers
  // (mcpServersOf its grants) hold a harness's own name for an MCP tool to that tool's settings.
  const gate = await adapterRunGate(deps.store, claim, revision, ws.workspace, tools.shell, mcpServersOf(granted));
  // What a script's shell and files are held to: this gate, so a denied bash or write holds inside computer_script too.
  tools.computer?.guard.install(async (tool, args) => {
    await gate.permissions.refresh();
    return gate.permissions.decide(tool, args);
  });

  // The run's tools: the kernel registry's hands on its Workspace (and computer); the web host tools it is granted
  // (web_fetch, web_search, monid), bound by the binding the pi spec uses (webHostTools) on the ToolHost the pi spec builds
  // (buildToolHost); and the learned_workflow tool when the run has it (learnsWorkflows: its revision is agentic and the
  // claim's seed lay chose learned workflows, as the pi spec lists them; a revision never names it). A CLI harness's session has a model port, so learned_workflow runs for real on the
  // session's proxied models (learnedWorkflowHostTool), each node a request on the run's one route labelled
  // learned_workflow, booked on the run's one ledger. The web tools and the learned workflow's call nodes run on the run's
  // scoped keys (claim-secrets.ts), the run's plane threaded for the web tools. Each call goes through the run's gate
  // (spec.gate), and a web tool books its paid requests on the run's one ledger itself (bookedIn). The browser is pi's
  // only (its native route): a CLI harness is not handed it.
  const results: ToolResults = new Map();
  const ctx = hostToolCtxOf(run, context, results, root);
  // The runner's one redactor (the loop's), else this spec's log cut: the claim's keys join it, and the answers of the tools
  // that run on them pass it.
  const held = run.redact ? heldRedactor(run.redact) : cut;
  const webNames = webToolNames(granted);
  let learnedTool: Awaited<ReturnType<typeof learnedWorkflowHostTool>>;
  let webTools: HostTool[] = [];
  let life: ReturnType<typeof hostLifecycle> | undefined;
  // The keys the claim hands the run (its web tools and its learned workflow's call nodes run on them): never learned
  // (learningEndOfRun).
  let handedKeys: string[] = [];
  const workflows = seedLaid?.workflows ?? [];
  const learns = learnsWorkflows(revision.kind, workflows);
  if (webNames.length || learns) {
    // The claim's keys (above, already held by the redactors), a copy of its own for the tools' plane below.
    const toolEnv: NodeJS.ProcessEnv = { ...claimed };
    // The decision keys its learned workflows' typed questions need, as the pi spec reads them (claim-secrets.ts
    // learnedDecisionKeys): onto this copy alone, never the CLI's own environment or its model's (cliRunEnv, above), and
    // held by the redactors as the claim's keys are.
    if (learns) {
      const learnedKeys = await learnedDecisionKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, workflows, (provider) => gate.permissions.policy(provider) !== "deny");
      for (const redact of new Set([held, cut])) holdClaimed(redact, learnedKeys);
      Object.assign(toolEnv, learnedKeys);
    }
    handedKeys = runnerSecrets(toolEnv);
    // The run's resolved tool plane (its web tools' providers), as the pi spec hands it its web tools.
    delete toolEnv[TOOL_PLANE_ENV];
    if (launch.plane && Object.keys(launch.plane).length) toolEnv[TOOL_PLANE_ENV] = JSON.stringify(launch.plane);
    if (webNames.length) {
      life = hostLifecycle();
      const host = buildToolHost({ root, workspace: ws.workspace, claim, env: toolEnv, run, store: deps.store, sealKey: deps.sealKey, life, redact: held });
      webTools = await webHostTools(host, granted, ctx);
    }
    if (learns) {
      // A tier the learned workflows name that the host has a model of, routed as pi's are (learnedTierRoutes: the run's
      // keys, pi's wires, since pi-ai's client sends these, never the CLI); one refused fails its node in its words.
      // Their models' keys (tierModelKeys: a saved one too, which claimSecrets opened only for the run's own model), held by
      // the redactors, on the tiers' route env alone (withModelKeys, never enumerable), never on the tools' (toolEnv).
      const tierKeys = await tierModelKeys({ store: deps.store, sealKey: deps.sealKey, env: deps.env }, learnedTiers(workflows));
      for (const redact of new Set([held, cut])) holdClaimed(redact, tierKeys);
      const modelEnv = withModelKeys(deps.env, { ...claimed, ...tierKeys });
      const tiers = new Map<string, LearnedTier>();
      for (const [tier, routed] of await learnedTierRoutes(workflows, modelEnv, (tier) => deps.routeOf(undefined, modelEnv, tier, PI_WIRES, undefined, cut))) {
        if ("why" in routed) tiers.set(tier, { why: routed.why });
        else {
          tierRoutes.set(tier, routed);
          tiers.set(tier, { model: routed.model });
        }
      }
      // The gate asks a learned_workflow call about its workflow's MCP nodes (adapterRunGate); they run through the run's
      // own MCP as the loop wraps it. Its model nodes run on the session's one model: what each node's trace says it ran on.
      gate.learn(workflows);
      learnedTool = await learnedWorkflowHostTool({ run, kind: revision.kind, granted, plane: launch.plane, env: toolEnv, work: root, workflows, permissions: gate.permissions, ctx, tiers, ...(mcp ? { mcp } : {}), workspace: ws.workspace, modelName: () => chosen.model.modelId });
    }
  }
  // The learned workflow the run starts on, before its agent's first turn, when one fits its input (workflow-first.ts).
  // Or the one the money rule stopped, over the agent's past runs (costLineOf): the run asks for its revision.
  const { serve: workflowFirst, revise: workflowRevise } = learnedTool ? await workflowFirstOf(revision.kind, workflows, launch, log, () => pastRunsOverStore(deps.store, runRow.agentId), (revision.body as { outputSchema?: unknown }).outputSchema) : {};
  const session: SessionSpec = {
    key: `run:${claim.runId}`,
    label: runRow.agentId,
    system: [environmentLine(), checkout?.note, instructions, guidance].filter((line): line is string => Boolean(line)),
    // The web tools and the learned workflow's call nodes run on the claim's keys: their answers pass the runner's one
    // redactor, as pi's do. Listed in the order the agent grants them, as main lists a CLI run's tools.
    tools: inGrantOrder([...tools.hostTools(withKindTools(granted, tools), results), ...[...webTools, ...(learnedTool ? [learnedTool] : [])].map((tool) => answersCut(tool, held))], granted),
    context: "fresh",
    ...(thinking ? { thinking } : {}),
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
    // What the run must never learn beside the runner's secrets: the keys its claim handed it, every secret the server
    // keeps sealed (storeSecrets: the run's redactor holds the same list), and its sign-in's pointers, read back from the
    // store's sign-ins under the seal key (learning-run.ts refused, on the runner).
    signIns: signInReads(deps.store, deps.sealKey),
    handed: handedKeys,
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
    ...(runner.record ? { record: runner.record } : {}),
    gate,
    runCap,
    ...(cap ? { cap } : {}),
    // The run's MCP for a harness with its own client (mcp-run.ts), the session the adapter mounts; absent when none.
    ...(mcp ? { mcp } : {}),
    // The run's end-of-run step, when it learns (the spec's, preferred over the loop's deps': adapter-loop.ts stepOf).
    ...(endOfRun ? { endOfRun } : {}),
    ...(start ? { learningLaid: laidOf(seedLaid) } : {}),
    ...(workflowFirst ? { workflowFirst } : {}),
    ...(workflowRevise ? { workflowRevise } : {}),
    // The web tools' install lifecycle, run by the adapter loop, as the pi spec's (they register none today).
    ...(life ? { lifecycle: life } : {}),
    agentId: runRow.agentId,
    // The run's computer and the person's hold on a desktop or phone, as the claim made them (as the pi spec gives them).
    ...(loopComputer ? { computer: loopComputer } : {}),
    workRoot: root,
    // Where the CLI works (its working directory, the run's folder to its file tools): what its absolute paths are read
    // against on the run's rows.
    cwd: scratch,
    // The end's metrics: its tools from the run's record, its tokens and model requests its booking's, at its model
    // (metrics.ts cliRunMetrics). Its cost is its booking's too: the harness's own record carries no per-request cost or
    // usage, so its model requests are counted at what the run's model proxy booked them at (bookedSpend over every
    // session of its journal), as a pi run's are at its answers' costs and tokens.
    endPatch: async () => {
      const entries = await entriesOf(deps.journal(claim), ROOT_CONVERSATION_ID, context);
      // Its tokens and model requests, and its model requests' cost, from one read of its booking (cliRunMetrics). Its
      // model requests and its decisions (a learned workflow's, LS-07) at what they were booked at (bookedSpend), and its
      // paid tool calls (a Parallel extract or search, a monid call), booked on the run's one ledger in their own session,
      // are the run's cost (runEndCost: unknown when any part is), as the pi spec's.
      const all = (await journalEntries(deps.journal(claim), context)) as never;
      const booked = bookedSpend(all, "model");
      const metrics = cliRunMetrics(entries as never, booked, { ...(thinking ? { effort: thinking } : {}), model: `${chosen.model.provider}/${chosen.model.modelId}` });
      // A run whose model answered or called a tool with no request booked (its requests went past its model proxy) spent
      // what no booking read: unknown, never the $0 an empty booking sums to.
      const model = booked.requests === 0 && cliModelWorked(entries as never) ? null : booked.usd;
      // Its paid tool calls (a Parallel extract or search, a monid call), booked on the run's one ledger in their own
      // session, and its decisions (a learned workflow's decision nodes) are the run's cost too, as the pi spec's.
      const total = runEndCost({ model, paid: run.ledger?.paid ? run.ledger.paid.spentUsd() : 0, decisions: bookedSpend(all, "decisions").usd });
      // An unknown cost is written as null, never left out: a follow-up's end clears the cost an earlier end stored.
      return { costUsd: total, metrics: { ...metrics, ...pathMetrics(launch, launch.learning ? await runPathOverStore(deps.store, claim.runId, launch.learning) : undefined) } };
    },
    // A run started with hold: true holds its computer for its owner (computer-held.ts), as the pi spec's.
    ...(heldComputer ? { held: heldComputer } : {}),
    // The run's Archil mount credential is revoked at its end on every outcome, even with no computer (idempotent with
    // the computer's release). A run that minted none revokes nothing.
    release: () => holds.release(),
  };
}
