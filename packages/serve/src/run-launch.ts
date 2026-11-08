// A run's launch record: the one JSON body the server writes when it starts a run (start = INSERT run, design 2.1), and
// the runner reads at its claim to build the run's spec. It replaces the per-run `serve.json` the old per-run process read
// (app.ts meta.input, place, effort, cap): no process, no door, no marker file, one body written once. What a person sees
// (the v2 start request) is unchanged; this is only where its fields live.
//
// The input's origin keeps its fail-safe on read (#1856): a run started by a trigger keeps an origin only when it names
// the run's own trigger with owner === (the source is a schedule, whose words its owner wrote when they set it up), else
// that trigger's own with owner false, so a forged or lost origin never reads as the person's or the owner's.
import { type MessageOrigin, originOf } from "@parcha/pi-durable-agent/timeline";
import type { RunTrigger } from "./triggers.js";
import { isObject, type Json } from "./validate.js";
import type { Place } from "./workspace/place.js";

/** What a run is launched with: its first input and title, where it runs, its effort and per-run cap, and the trigger and
 *  origin that started it. The server writes it once at start; the runner reads it at each claim (its claim rebuilds the
 *  run from the store, this body included). */
export interface RunLaunch {
  /** The v2 start request's body, as the person or trigger gave it. */
  readonly input: unknown;
  readonly title: string;
  readonly place: Place;
  readonly effort?: string;
  readonly maxCostUsd?: number;
  readonly capMode?: string;
  /** The trigger and firing that started the run, or none for a person's run. */
  readonly trigger?: RunTrigger;
  /** Who the first message is from, when not the person: kept only through the fail-safe below. */
  readonly inputOrigin?: MessageOrigin;
  /** A run that re-asks its agent after it ends (a trigger's follow-up). */
  readonly followUp?: boolean;
}

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

/** The JSON body the server stores for a run's launch. */
export function launchBody(launch: RunLaunch): Json {
  return {
    input: launch.input,
    title: launch.title,
    place: launch.place,
    ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
    ...(launch.maxCostUsd !== undefined ? { max_cost_usd: launch.maxCostUsd } : {}),
    ...(launch.capMode !== undefined ? { cap_mode: launch.capMode } : {}),
    ...(launch.trigger ? { trigger: launch.trigger } : {}),
    ...(launch.inputOrigin ? { input_origin: launch.inputOrigin } : {}),
    ...(launch.followUp ? { follow_up: true } : {}),
  };
}

/** A launch body read back into a `RunLaunch`, with the input-origin fail-safe applied through the body's own trigger, or
 *  undefined when the body is not one (not an object, or it names no place: a damaged or hand-edited body). */
export function readLaunchBody(stored: unknown): RunLaunch | undefined {
  if (!isObject(stored)) return undefined;
  const place = readPlace(stored.place);
  if (!place) return undefined;
  const trigger = readTrigger(stored.trigger);
  const inputOrigin = keepInputOrigin(stored.input_origin, trigger);
  return {
    input: stored.input,
    title: typeof stored.title === "string" ? stored.title : "",
    place,
    ...(typeof stored.effort === "string" ? { effort: stored.effort } : {}),
    ...(typeof stored.max_cost_usd === "number" ? { maxCostUsd: stored.max_cost_usd } : {}),
    ...(typeof stored.cap_mode === "string" ? { capMode: stored.cap_mode } : {}),
    ...(trigger ? { trigger } : {}),
    ...(inputOrigin ? { inputOrigin } : {}),
    ...(stored.follow_up === true ? { followUp: true } : {}),
  };
}
