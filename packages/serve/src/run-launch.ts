import { sdkBindingOf, type SdkBinding } from "./sdk/runtimes.js";
import type { SdkWorkflowTool, SdkWorkflowAdapter } from "./sdk/workflows.js";
import type { NativeBinding } from "./native/types.js";
import { nativeOf } from "./native/binding.js";
// A run's launch record: the one JSON body the server writes when it starts a run (start = INSERT run, design 2.1), and
// the runner reads at its claim to build the run's spec. It replaces the per-run `serve.json` the old per-run process read
// (app.ts meta.input, place, effort, cap): no process, no door, no marker file, one body written once. What a person sees
// (the v2 start request) is unchanged; this is only where its fields live.
//
// The input's origin keeps its fail-safe on read (#1856): a run started by a trigger keeps an origin only when it names
// the run's own trigger with owner === (the source is a schedule, whose words its owner wrote when they set it up), else
// that trigger's own with owner false, so a forged or lost origin never reads as the person's or the owner's.
import { type MessageOrigin, originOf } from "./timeline/index.js";
import type { Plane } from "./tool-plane.js";
import type { RunTrigger } from "./triggers.js";
import { ID, isObject, type Json } from "./validate.js";
import type { Place } from "./workspace/place.js";
import { relativeSegments } from "./workspace/paths.js";

/** What a run is launched with: everything its runner needs to build the run's spec at its claim, nothing derived later.
 *  The server writes it once at start; the runner reads it at each claim (its claim rebuilds the run from the store, this
 *  body included). `harness` picks the loop's adapter (absent, the revision's harness is used); `input` is the start
 *  request's body for a person's or a trigger's run, or an object a built-in run names. `model`, `plane`, `approvers`,
 *  `documents` and `boxAllow` are the per-run choices
 *  the old path recomputed; here they are pinned at start, and optional (a built-in run may name none). */
export interface RunLaunch {
  readonly sdk?: SdkBinding & {instructions: string; model?: string; workflow_tools?: SdkWorkflowTool[]; workflow_adapters?: SdkWorkflowAdapter[]};
  readonly cli_learning?: {runtime: "codex-cli" | "claude-code-cli"; connection_id: string; connection_generation: string; session_id: string; turn_id: string; instructions: string; policy_complete: boolean; model?: string};
  readonly native?: NativeBinding;
  /** The start request's body, as the person or trigger gave it, or an object a built-in run names. */
  readonly input: unknown;
  readonly title: string;
  /** The GitHub repository (owner/name) a person's run reaches, from the start body's `repo` or its agent's one bound
   *  repository (run-repo.ts); a github trigger's run has none here, its event names it. */
  readonly repo?: string;
  readonly place: Place;
  /** The loop's adapter, when not the revision's (an SDK run names "sdk"). */
  readonly harness?: string;
  /** The run's model, pinned at start. */
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly effort?: string;
  readonly maxCostUsd?: number;
  /** The tool plane as the server resolved it at start (tool-plane.ts). */
  readonly plane?: Plane;
  /** Whether a person can answer a tool call's approval for this run. */
  readonly approvers?: boolean;
  /** The documents directory a workflow's reads are rooted at, when the server gives one. */
  readonly documents?: string;
  /** What a run's box may reach, as the server resolved it: the list, or "none". */
  readonly boxAllow?: readonly string[] | "none";
  /** The operator set AGENTRUN_BOX_ALLOW (box-settings.ts boxAllowSetIn): `boxAllow` is theirs, not the default. A
   *  browser is held to an operator's list and runs open under the default. Absent: the default. */
  readonly boxAllowSet?: true;
  /** The uploaded file ids the run was started with, in order (the create body's file_ids, already checked ready): the
   *  runner copies them into the run's work/inputs/ at its claim, as the old start copied them before the process ran. */
  readonly files?: readonly string[];
  /** The server copied `files` into the run's folder (work/inputs/) when it started the run, before its row was written:
   *  a run on an Archil disk (Mode 2, uploads-archil.ts placeRunFiles), or a moved project's local placement. Its claim reads no upload (uploads.ts
   *  filesToCopy). Absent: the claim copies them from the server's data directory, as before. */
  readonly filesPlaced?: true;
  /** A moved project's completed, private pre-admission placement. Claims verify this receipt; they never seed again.
   *  The control marker is outside the run's tool workspace. No source path or credential is kept in this record. */
  readonly sourceProject?: SourceProjectLaunch;
  /** The run's learning start, when its agent learns and the server's learning is on, decided once here so the runner reads
   *  no learning folder or git: `seed`, the learning commit's sha (or null when the seed could not be read); `section`,
   *  the exact # Learned text to lay into the prompt (its owner's corrections, learning.ts learnedSection); `workflows`,
   *  the names of the learned workflows the seed offers the run (chooseWorkflows), absent when none; `noWorkflows`, a run
   *  never answered by a learned workflow and asked for no workflow draft at its end (a native run, an SDK run with no
   *  workflow binding); `model`, the model an SDK run's compile turn is asked on (its agent's own); `seedFailed`, why it
   *  starts with nothing learned when it does (SeedFailed); `use`, a run started with `learning: "use"` (learning.ts
   *  RUN_LEARNING_USE): it starts from all of the above and keeps nothing; `seededAt`, when its seed was read (learning.ts
   *  Seed.at), which the agent's reset watermark is read against. Absent when the run does not learn. */
  readonly learning?: { readonly seed: string | null; readonly section: string; readonly workflows?: readonly string[]; readonly noWorkflows?: true; readonly model?: string; readonly seedFailed?: SeedFailed; readonly use?: true; readonly seededAt?: number };
  /** `false`: the run never starts on a learned workflow, even one that fits its input (RunCreate `workflow_first`,
   *  runner/workflow-first.ts); its agent takes it from its first turn. Absent: a fitting one serves first. */
  readonly workflowFirst?: false;
  /** A replay run (runner/promotion.ts): learned workflow `workflow` at `digest`, run alone on the agent's own run `of`'s input to
   *  decide whether that revision serves first (learn/promote.ts). A hand-back ends it with no agent turn, and it asks nothing at its end. Absent: a run of its own. */
  readonly replay?: Replay;
  /** A shadow run (runner/audit.ts): the audit of run `of`, which learned workflow `workflow` at `digest` served. The same
   *  agent on the same input with learning off: its answer is what the served answer is compared with (learn/audit.ts),
   *  it is no row of the run list, and it asks nothing at its end. Absent: a run of its own. */
  readonly audit?: Replay;
  /** The trigger and firing that started the run, or none for a person's run. */
  readonly trigger?: RunTrigger;
  /** Who the first message is from, when not the person: kept only through the fail-safe below. */
  readonly inputOrigin?: MessageOrigin;
  /** A run that re-asks its agent after it ends (a trigger's follow-up). */
  readonly followUp?: boolean;
  /** The Archil disk the run keeps its folder on (Archil mode), chosen at its start: the one its launch named (`launch`, a
   *  customer's disk agentrun never makes or removes), or its agent's when the agent had one then (`agent`). Absent, the
   *  run uses its agent's disk, made at its claim when the agent has none (workspace/run-disk.ts). Kept here so every
   *  claim, revoke and reclaim of the run, after a restart too, acts on that one disk. */
  readonly archilDisk?: LaunchDisk;
  /** A run started with `hold: true` (computer-held.ts): its computer waits for its owner's start, and stays the owner's
   *  after the agent's end until released, each wait for at most `minutes` with no call. */
  readonly hold?: { readonly minutes: number };
}

/** Immutable placement identity for a project copied before admission. */
export interface SourceProjectLaunch {
  readonly version: 1;
  readonly sourceId: string;
  readonly baselineRevision: string;
  readonly digest: string;
  /** SHA-256 of the private complete marker's exact bytes. */
  readonly receipt: string;
  /** Exact preplaced upload paths, pinned in the private marker; never a whole inputs/ exclusion. */
  readonly inputs?: readonly string[];
}

export function sourceProjectOf(value: unknown): SourceProjectLaunch | undefined {
  if (!isObject(value) || value.version !== 1 || Object.keys(value).length !== (value.inputs === undefined ? 5 : 6)
    || typeof value.baselineRevision !== "string" || !ID.test(value.baselineRevision)) return undefined;
  for (const key of ["sourceId", "digest", "receipt"]) if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key])) return undefined;
  if (value.inputs !== undefined) {
    if (!Array.isArray(value.inputs) || value.inputs.length > 20 || !value.inputs.length || new Set(value.inputs).size !== value.inputs.length) return undefined;
    for (const input of value.inputs) {
      if (typeof input !== "string" || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input) || !input.startsWith("inputs/") || input === "inputs/message.md") return undefined;
      try { relativeSegments(input); } catch { return undefined; }
    }
  }
  return value as unknown as SourceProjectLaunch;
}

/** What a replay run replays: the graded run, and the learned workflow at the digest it decides. */
export interface Replay {
  readonly of: string;
  readonly workflow: string;
  readonly digest: string;
}

/** The disk a launch record names, and whose it is. */
export interface LaunchDisk {
  readonly diskId: string;
  readonly kind: "launch" | "agent";
}

/** The disk a launch body names, as read back, or undefined. */
const readDisk = (value: unknown): LaunchDisk | undefined =>
  isObject(value) && typeof value.disk_id === "string" && (value.kind === "launch" || value.kind === "agent") ? { diskId: value.disk_id, kind: value.kind } : undefined;

/** The replay a launch body names, as read back, or undefined. */
const readReplay = (value: unknown): Replay | undefined =>
  isObject(value) && typeof value.of === "string" && typeof value.workflow === "string" && typeof value.digest === "string" ? { of: value.of, workflow: value.workflow, digest: value.digest } : undefined;

/** The trigger a launch body names, as read back: `{ id, firing_key }` and its firing's `attrs` (each a string) when it
 *  kept them, or null (triggerOf of the old serve.json). */
function readTrigger(value: unknown): RunTrigger | null {
  if (!(isObject(value) && typeof value.id === "string" && typeof value.firing_key === "string")) return null;
  const attrs = isObject(value.attrs) ? Object.fromEntries(Object.entries(value.attrs).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  return { id: value.id, firing_key: value.firing_key, ...(Object.keys(attrs).length ? { attrs } : {}) };
}

/** Where a run runs, as read back from a launch body, or undefined when it names none. */
function readPlace(value: unknown): Place | undefined {
  if (!isObject(value)) return undefined;
  if (value.mode === "runner") return { mode: "runner" };
  if (value.mode === "sandbox" && typeof value.box === "string") return { mode: "sandbox", box: value.box };
  return undefined;
}

/** The run's model as read back, or undefined when the body names none. */
const readModel = (value: unknown): { provider: string; modelId: string } | undefined =>
  isObject(value) && typeof value.provider === "string" && typeof value.modelId === "string" ? { provider: value.provider, modelId: value.modelId } : undefined;

/** What a box may reach as read back: a list of strings or "none", else undefined. */
const readBoxAllow = (value: unknown): readonly string[] | "none" | undefined =>
  value === "none" ? "none" : Array.isArray(value) && value.every((host) => typeof host === "string") ? (value as readonly string[]) : undefined;

/** The input's origin kept through the fail-safe (#1856): the stored one only if it names `trigger` with
 *  owner === (its source is a schedule), else that trigger's own with owner false (its source a best-effort label: the
 *  stored one when it is a known source other than a schedule's, else "webhook"). A run with no trigger keeps none. */
export function keepInputOrigin(stored: unknown, trigger: RunTrigger | null): MessageOrigin | undefined {
  if (trigger === null) return undefined;
  const origin = originOf(stored);
  if (origin?.kind === "trigger" && origin.trigger_id === trigger.id && origin.owner === (origin.source === "schedule")) return origin;
  const source = origin?.kind === "trigger" && origin.source !== "schedule" ? origin.source : "webhook";
  return { kind: "trigger", trigger_id: trigger.id, source, owner: false };
}

/** The JSON body the server stores for a run's launch. `harness` is a top-level field, so the loop factory reads it from the
 *  stored body without parsing the rest. */
export function launchBody(launch: RunLaunch): Json {
  return {
    input: launch.input,
    ...(launch.sdk ? {sdk:launch.sdk as unknown as Json}:{}),
    ...(launch.cli_learning ? {cli_learning:launch.cli_learning as unknown as Json}:{}),
    ...(launch.native ? {native:launch.native}:{}),
    title: launch.title,
    ...(launch.repo !== undefined ? { repo: launch.repo } : {}),
    place: launch.place,
    ...(launch.harness !== undefined ? { harness: launch.harness } : {}),
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
    ...(launch.maxCostUsd !== undefined ? { max_cost_usd: launch.maxCostUsd } : {}),
    ...(launch.plane ? { plane: launch.plane } : {}),
    ...(launch.approvers !== undefined ? { approvers: launch.approvers } : {}),
    ...(launch.documents !== undefined ? { documents: launch.documents } : {}),
    ...(launch.boxAllow !== undefined ? { box_allow: launch.boxAllow } : {}),
    ...(launch.boxAllowSet ? { box_allow_set: true } : {}),
    ...(launch.files?.length ? { files: launch.files } : {}),
    ...(launch.filesPlaced ? { files_placed: true } : {}),
    ...(launch.sourceProject ? { source_project: launch.sourceProject } : {}),
    ...(launch.learning ? { learning: { seed: launch.learning.seed, section: launch.learning.section, ...(launch.learning.workflows?.length ? { workflows: [...launch.learning.workflows] } : {}), ...(launch.learning.noWorkflows ? { noWorkflows: true } : {}), ...(launch.learning.model ? { model: launch.learning.model } : {}), ...(launch.learning.seedFailed ? { seedFailed: launch.learning.seedFailed } : {}), ...(launch.learning.use ? { use: true } : {}), ...(launch.learning.seededAt !== undefined ? { seededAt: launch.learning.seededAt } : {}) } } : {}),
    ...(launch.workflowFirst === false ? { workflow_first: false } : {}),
    ...(launch.replay ? { replay: { of: launch.replay.of, workflow: launch.replay.workflow, digest: launch.replay.digest } } : {}),
    ...(launch.audit ? { audit: { of: launch.audit.of, workflow: launch.audit.workflow, digest: launch.audit.digest } } : {}),
    ...(launch.trigger ? { trigger: launch.trigger } : {}),
    ...(launch.inputOrigin ? { input_origin: launch.inputOrigin } : {}),
    ...(launch.followUp ? { follow_up: true } : {}),
    ...(launch.archilDisk ? { archil_disk: { disk_id: launch.archilDisk.diskId, kind: launch.archilDisk.kind } } : {}),
    ...(launch.hold ? { hold: { minutes: launch.hold.minutes } } : {}),
  };
}

/** The learning start a launch body names, as read back: its seed sha, its # Learned section text, the learned workflows
 *  it was offered, its compile model, why its seed failed and whether it only uses them (`use`), or undefined when the
 *  body names none (a run that does not learn). */
function readLearning(value: unknown): NonNullable<RunLaunch["learning"]> | undefined {
  if (!isObject(value)) return undefined;
  const seed = typeof value.seed === "string" ? value.seed : null;
  const section = typeof value.section === "string" ? value.section : "";
  const workflows = Array.isArray(value.workflows) ? value.workflows.filter((name): name is string => typeof name === "string") : [];
  return { seed, section, ...(workflows.length ? { workflows } : {}), ...(value.noWorkflows === true ? { noWorkflows: true as const } : {}), ...(typeof value.model === "string" && value.model !== "" ? { model: value.model } : {}), ...(typeof value.seedFailed === "string" && SEED_FAILURES.includes(value.seedFailed) ? { seedFailed: value.seedFailed as SeedFailed } : {}), ...(value.use === true ? { use: true as const } : {}), ...(typeof value.seededAt === "number" && Number.isFinite(value.seededAt) ? { seededAt: value.seededAt } : {}) };
}

/** The launch a runner runs (runner/dispatch.ts, run-child-host.ts): on a disk the launch names as its own (kind
 *  "launch"), its learning start holds no seed, # Learned section or learned workflow, whatever the body says (a start
 *  made before its run's disk was read, or written by hand), as the server's seed is the default disk's, never that
 *  disk's (learn/learning-of.ts): the run starts with nothing learned (`other_disk`), its flags kept. Any other launch as
 *  read. readLaunchBody keeps the body as written: a finished run's views show what it ran. */
export function launchOnItsDisk(launch: RunLaunch): RunLaunch {
  if (!launch.learning || launch.archilDisk?.kind !== "launch") return launch;
  const { noWorkflows, model, use } = launch.learning;
  return { ...launch, learning: { seed: null, section: "", seedFailed: "other_disk", ...(noWorkflows ? { noWorkflows } : {}), ...(model ? { model } : {}), ...(use ? { use } : {}) } };
}

/** A launch body read back into a `RunLaunch`, with the input-origin fail-safe applied through the body's own trigger, or
 *  undefined when the body is not one (not an object, or it names no place: a damaged or hand-edited body). */
export function readLaunchBody(stored: unknown): RunLaunch | undefined {
  if (!isObject(stored)) return undefined;
  const sourceProject = sourceProjectOf(stored.source_project);
  if (stored.source_project !== undefined && !sourceProject) return undefined;
  const place = readPlace(stored.place);
  if (!place) return undefined;
  const trigger = readTrigger(stored.trigger);
  const inputOrigin = keepInputOrigin(stored.input_origin, trigger);
  const model = readModel(stored.model);
  const boxAllow = readBoxAllow(stored.box_allow);
  const archilDisk = readDisk(stored.archil_disk);
  return {
    input: stored.input,
    ...(isObject(stored.sdk) && sdkBindingOf(stored.sdk) && typeof stored.sdk.instructions === "string" ? {sdk: stored.sdk as unknown as NonNullable<RunLaunch["sdk"]>} : {}),
    ...(nativeOf(stored) ? {native:nativeOf(stored)}:{}),
    ...(isObject(stored.cli_learning) && ["codex-cli", "claude-code-cli"].includes(String(stored.cli_learning.runtime)) && typeof stored.cli_learning.instructions === "string" ? {cli_learning:stored.cli_learning as unknown as NonNullable<RunLaunch["cli_learning"]>} : {}),
    title: typeof stored.title === "string" ? stored.title : "",
    ...(typeof stored.repo === "string" ? { repo: stored.repo } : {}),
    place,
    ...(typeof stored.harness === "string" ? { harness: stored.harness } : {}),
    ...(model ? { model } : {}),
    ...(typeof stored.effort === "string" ? { effort: stored.effort } : {}),
    ...(typeof stored.max_cost_usd === "number" ? { maxCostUsd: stored.max_cost_usd } : {}),
    ...(isObject(stored.plane) ? { plane: stored.plane as Plane } : {}),
    ...(typeof stored.approvers === "boolean" ? { approvers: stored.approvers } : {}),
    ...(typeof stored.documents === "string" ? { documents: stored.documents } : {}),
    ...(boxAllow !== undefined ? { boxAllow } : {}),
    ...(stored.box_allow_set === true ? { boxAllowSet: true as const } : {}),
    ...(Array.isArray(stored.files) && stored.files.every((id) => typeof id === "string") ? { files: stored.files as string[] } : {}),
    ...(stored.files_placed === true ? { filesPlaced: true as const } : {}),
    ...(sourceProject ? { sourceProject } : {}),
    ...(stored.learning !== undefined ? { learning: readLearning(stored.learning) ?? { seed: null, section: "" } } : {}),
    ...(stored.workflow_first === false ? { workflowFirst: false as const } : {}),
    ...(readReplay(stored.replay) ? { replay: readReplay(stored.replay)! } : {}),
    ...(readReplay(stored.audit) ? { audit: readReplay(stored.audit)! } : {}),
    ...(trigger ? { trigger } : {}),
    ...(inputOrigin ? { inputOrigin } : {}),
    ...(stored.follow_up === true ? { followUp: true } : {}),
    ...(archilDisk ? { archilDisk } : {}),
    ...(isObject(stored.hold) && typeof stored.hold.minutes === "number" ? { hold: { minutes: stored.hold.minutes } } : {}),
  };
}

/** The run's learning start (its seed sha, its # Learned section and its learned workflows), read from one place by learning's
 *  routes and the runner; undefined when the run does not learn. */
export const learningStartOf = (launch: RunLaunch): RunLaunch["learning"] => launch.learning;

/** The same start read from a launch body's `learning` member alone (Store.runs.learningStarts), as readLaunchBody reads it. */
export const learningStartOfStored = (stored: unknown): RunLaunch["learning"] => (stored === undefined ? undefined : readLearning(stored) ?? { seed: null, section: "" });

/** Why a learning run starts with nothing learned, as main says it: its agent's learning folder could not be read
 *  (`unreadable`, STOPPED.unreadable), what was read could not be made into its start (`not_copied`,
 *  STOPPED.notCopied), or its launch names a disk of its own, whose learning folder the server does not read
 *  (`other_disk`, STOPPED.otherDisk): a run on a named disk learns nothing (learn/learning-of.ts). */
export type SeedFailed = "unreadable" | "not_copied" | "other_disk";
const SEED_FAILURES: readonly string[] = ["unreadable", "not_copied", "other_disk"];

/** A learning start with no seed (no commit of main, runs-over-store.ts learningStartFor): the run learns nothing, is
 *  never asked what to keep, and so is never told it learns. Why is its `seedFailed`, when its start records one. */
export const seedFailed = (start: NonNullable<RunLaunch["learning"]>): boolean => start.seed === null;
