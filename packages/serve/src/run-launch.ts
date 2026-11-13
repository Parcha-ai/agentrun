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
import { isObject, type Json } from "./validate.js";
import type { Place } from "./workspace/place.js";

/** What a run is launched with: everything its runner needs to build the run's spec at its claim, nothing derived later.
 *  The server writes it once at start; the runner reads it at each claim (its claim rebuilds the run from the store, this
 *  body included). `harness` picks the loop's adapter (a built-in learning run names "learning"; absent, the revision's
 *  harness is used); `input` is the start request's body for a person's or a trigger's run, or an object a built-in run
 *  names (a learning run's `{ runId }`). `model`, `plane`, `approvers`, `documents` and `boxAllow` are the per-run choices
 *  the old path recomputed; here they are pinned at start, and optional (a built-in run may name none). */
export interface RunLaunch {
  /** The start request's body, as the person or trigger gave it, or an object a built-in run names. */
  readonly input: unknown;
  readonly title: string;
  readonly place: Place;
  /** The loop's adapter, when not the revision's: a built-in learning run names "learning". */
  readonly harness?: string;
  /** The run's model, pinned at start. */
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly effort?: string;
  readonly maxCostUsd?: number;
  readonly capMode?: string;
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
  /** The run's learning start, when its agent learns and the server's learning is on, decided once here so the runner reads
   *  no learning folder or git: `given`, the notes its # Learned section names (each `{file, name}`, as /runs/{id}/learning
   *  shows them); `seed`, the learning commit's sha (or null when the seed could not be read); and `section`, the exact
   *  # Learned text to lay into the prompt for those notes (what the old layLearned laid), within the learning budget; and
   *  `seedNotes`, the count of all notes in the seed before the budget picked `given` (present with a read seed; absent when
   *  the seed could not be read); `skills`, the names of the learned skills the seed offers the run (each active one that
   *  fits a run's skill budget at all; its claim lays them), absent when none; `workflows`, the names of the learned
   *  workflows the seed offers its learned_workflow tool (chooseWorkflows), absent when none; `notesOnly`, a run of a
   *  revision that says `learning: "notes"`: given its notes and skills but never a learned workflow, and asked for no
   *  workflow draft at its end; `gradeModel`, the model the
   *  server names to grade what the run proposes (learning.ts gradeModelOf: --grade-model, else AGENTRUN_SERVE_GRADE_MODEL,
   *  else AGENT_MODEL_STRONG), absent when it names none and the agent's own grades it; and `seedFailed`, why it starts with
   *  nothing learned when it does (SeedFailed). Absent when the run does not learn. */
  readonly learning?: { readonly given: readonly { readonly file: string; readonly name: string }[]; readonly seed: string | null; readonly section: string; readonly seedNotes?: number; readonly skills?: readonly string[]; readonly workflows?: readonly string[]; readonly notesOnly?: true; readonly gradeModel?: string; readonly seedFailed?: SeedFailed };
  /** `false`: the run never starts on a learned workflow, even one that fits its input (RunCreate `workflow_first`,
   *  runner/workflow-first.ts); its agent takes it from its first turn. Absent: a fitting one serves first. */
  readonly workflowFirst?: false;
  /** A replay run (runner/promotion.ts): learned workflow `workflow` at `digest`, run alone on graded run `of`'s input to
   *  decide whether that revision serves first (learn/promote.ts). Its guards read record-only (learn/promote.ts recordOnly), a hand-back ends it
   *  with no agent turn, and it asks nothing at its end. Absent: a run of its own. */
  readonly replay?: Replay;
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

/** The trigger a launch body names, as read back: `{ id, firing_key }`, or null (triggerOf of the old serve.json). */
function readTrigger(value: unknown): RunTrigger | null {
  return isObject(value) && typeof value.id === "string" && typeof value.firing_key === "string" ? { id: value.id, firing_key: value.firing_key } : null;
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
    title: launch.title,
    place: launch.place,
    ...(launch.harness !== undefined ? { harness: launch.harness } : {}),
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
    ...(launch.maxCostUsd !== undefined ? { max_cost_usd: launch.maxCostUsd } : {}),
    ...(launch.capMode !== undefined ? { cap_mode: launch.capMode } : {}),
    ...(launch.plane ? { plane: launch.plane } : {}),
    ...(launch.approvers !== undefined ? { approvers: launch.approvers } : {}),
    ...(launch.documents !== undefined ? { documents: launch.documents } : {}),
    ...(launch.boxAllow !== undefined ? { box_allow: launch.boxAllow } : {}),
    ...(launch.boxAllowSet ? { box_allow_set: true } : {}),
    ...(launch.files?.length ? { files: launch.files } : {}),
    ...(launch.learning ? { learning: { given: launch.learning.given.map((note) => ({ file: note.file, name: note.name })), seed: launch.learning.seed, section: launch.learning.section, ...(launch.learning.seedNotes !== undefined ? { seedNotes: launch.learning.seedNotes } : {}), ...(launch.learning.skills?.length ? { skills: [...launch.learning.skills] } : {}), ...(launch.learning.notesOnly ? { notesOnly: true } : {}), ...(launch.learning.workflows?.length ? { workflows: [...launch.learning.workflows] } : {}), ...(launch.learning.gradeModel ? { gradeModel: launch.learning.gradeModel } : {}), ...(launch.learning.seedFailed ? { seedFailed: launch.learning.seedFailed } : {}) } } : {}),
    ...(launch.workflowFirst === false ? { workflow_first: false } : {}),
    ...(launch.replay ? { replay: { of: launch.replay.of, workflow: launch.replay.workflow, digest: launch.replay.digest } } : {}),
    ...(launch.trigger ? { trigger: launch.trigger } : {}),
    ...(launch.inputOrigin ? { input_origin: launch.inputOrigin } : {}),
    ...(launch.followUp ? { follow_up: true } : {}),
    ...(launch.archilDisk ? { archil_disk: { disk_id: launch.archilDisk.diskId, kind: launch.archilDisk.kind } } : {}),
  };
}

/** The learning start a launch body names, as read back: its given notes (each {file, name}), its seed sha, its # Learned
 *  section text, the learned skills and workflows it was offered, its grade model and why its seed failed, or undefined
 *  when the body names none (a run that does not learn). */
function readLearning(value: unknown): { given: readonly { file: string; name: string }[]; seed: string | null; section: string; seedNotes?: number; skills?: readonly string[]; workflows?: readonly string[]; notesOnly?: true; gradeModel?: string; seedFailed?: SeedFailed } | undefined {
  if (!isObject(value)) return undefined;
  const given = Array.isArray(value.given) ? value.given.flatMap((note) => (isObject(note) && typeof note.file === "string" && typeof note.name === "string" ? [{ file: note.file, name: note.name }] : [])) : [];
  const seed = typeof value.seed === "string" ? value.seed : null;
  const section = typeof value.section === "string" ? value.section : "";
  const names = (list: unknown) => (Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : []);
  const [skills, workflows] = [names(value.skills), names(value.workflows)];
  return { given, seed, section, ...(typeof value.seedNotes === "number" ? { seedNotes: value.seedNotes } : {}), ...(skills.length ? { skills } : {}), ...(workflows.length ? { workflows } : {}), ...(value.notesOnly === true ? { notesOnly: true as const } : {}), ...(typeof value.gradeModel === "string" && value.gradeModel !== "" ? { gradeModel: value.gradeModel } : {}), ...(typeof value.seedFailed === "string" && SEED_FAILURES.includes(value.seedFailed) ? { seedFailed: value.seedFailed as SeedFailed } : {}) };
}

/** A launch body read back into a `RunLaunch`, with the input-origin fail-safe applied through the body's own trigger, or
 *  undefined when the body is not one (not an object, or it names no place: a damaged or hand-edited body). */
export function readLaunchBody(stored: unknown): RunLaunch | undefined {
  if (!isObject(stored)) return undefined;
  const place = readPlace(stored.place);
  if (!place) return undefined;
  const trigger = readTrigger(stored.trigger);
  const inputOrigin = keepInputOrigin(stored.input_origin, trigger);
  const model = readModel(stored.model);
  const boxAllow = readBoxAllow(stored.box_allow);
  const archilDisk = readDisk(stored.archil_disk);
  return {
    input: stored.input,
    title: typeof stored.title === "string" ? stored.title : "",
    place,
    ...(typeof stored.harness === "string" ? { harness: stored.harness } : {}),
    ...(model ? { model } : {}),
    ...(typeof stored.effort === "string" ? { effort: stored.effort } : {}),
    ...(typeof stored.max_cost_usd === "number" ? { maxCostUsd: stored.max_cost_usd } : {}),
    ...(typeof stored.cap_mode === "string" ? { capMode: stored.cap_mode } : {}),
    ...(isObject(stored.plane) ? { plane: stored.plane as Plane } : {}),
    ...(typeof stored.approvers === "boolean" ? { approvers: stored.approvers } : {}),
    ...(typeof stored.documents === "string" ? { documents: stored.documents } : {}),
    ...(boxAllow !== undefined ? { boxAllow } : {}),
    ...(stored.box_allow_set === true ? { boxAllowSet: true as const } : {}),
    ...(Array.isArray(stored.files) && stored.files.every((id) => typeof id === "string") ? { files: stored.files as string[] } : {}),
    ...(stored.learning !== undefined ? { learning: readLearning(stored.learning) ?? { given: [], seed: null, section: "" } } : {}),
    ...(stored.workflow_first === false ? { workflowFirst: false as const } : {}),
    ...(readReplay(stored.replay) ? { replay: readReplay(stored.replay)! } : {}),
    ...(trigger ? { trigger } : {}),
    ...(inputOrigin ? { inputOrigin } : {}),
    ...(stored.follow_up === true ? { followUp: true } : {}),
    ...(archilDisk ? { archilDisk } : {}),
  };
}

/** The run's learning start (its given notes, its seed sha and its # Learned section), read from one place by learning's
 *  routes and the runner; undefined when the run does not learn. */
export const learningStartOf = (launch: RunLaunch): RunLaunch["learning"] => launch.learning;

/** Why a learning run starts with nothing learned, as main says it: its agent's learning folder could not be read
 *  (`unreadable`, STOPPED.unreadable), or what was read could not be made into its start (`not_copied`,
 *  STOPPED.notCopied). */
export type SeedFailed = "unreadable" | "not_copied";
const SEED_FAILURES: readonly string[] = ["unreadable", "not_copied"];

/** A learning start with no seed (no commit of main, runs-over-store.ts learningStartFor): the run learns nothing, is
 *  never asked what to keep, and so is never told it learns. Why is its `seedFailed`, when its start records one. */
export const seedFailed = (start: NonNullable<RunLaunch["learning"]>): boolean => start.seed === null;
