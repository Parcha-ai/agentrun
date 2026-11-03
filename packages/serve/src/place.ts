// Where a revision's runs execute: `runner` (no box and no shell) or `sandbox` (the agent's file and shell tools run in
// the named box, while its loop, its log and every key stay on the server). A revision keeps the place it names, an
// explicit runner included, since the default is this host's; one that names none keeps none, so a revision written
// before this field keeps its id. Which boxes this server has is said in capabilities, and a revision whose box it does
// not have saves with a warning and is refused at run time. A run runs in its revision's place, else this host's
// default, and keeps the place it resolved to: a run request names none. Runs execute in Docker only, for now: every
// other box says it does not run yet. A harness's own tools in the box, when they come, are an option of sandbox,
// never a third mode.
import { join } from "node:path";
import { BOX_IDS, type BoxId, type BoxOffer } from "./boxes.js";
import type { InputIssue } from "./errors.js";

export const PLACE_MODES = ["runner", "sandbox"] as const;
export type PlaceMode = (typeof PLACE_MODES)[number];
export const DEFAULT_PLACE_MODE: PlaceMode = "runner";

export type Place = { mode: "runner" } | { mode: "sandbox"; box: BoxId };

/** The boxes runs execute in so far. */
export const RUN_BOXES: readonly BoxId[] = ["docker"];

/** The boxes this server gives runs, from what its registry set up at its start (boxes.ts): a box runs execute in
 *  that the registry has, and no other. */
export function boxAvailability(registry: readonly BoxOffer[]): BoxOffer[] {
  return BOX_IDS.map((id) => {
    const offer = registry.find((o) => o.id === id);
    if (!offer) return { id, available: false, reason: `${id} is not set up on this server.` };
    if (!offer.available || RUN_BOXES.includes(id)) return { ...offer };
    return { id, available: false, reason: `runs in the ${id} box are not available yet` };
  });
}

/** `places` in capabilities: the modes a revision may name, this host's default, and each box. */
export const placesOf = (registry: readonly BoxOffer[]) => ({ modes: [...PLACE_MODES], default: DEFAULT_PLACE_MODE, boxes: boxAvailability(registry) });

/** A run's place: its revision's, else this host's default. */
export const resolvePlace = (revision: Place | undefined): Place => revision ?? { mode: "runner" };

/** The place a run kept (its serve.json), or runner for a run kept before runs had one. */
export function storedPlace(value: unknown): Place {
  if (!isObject(value) || value.mode !== "sandbox" || !listed(BOX_IDS, value.box)) return { mode: "runner" };
  return { mode: "sandbox", box: value.box as BoxId };
}

/** Where a box binds the run's work/, and where its tools start. */
export const BOX_WORK = "/run/agentrun/run/work";

/** The run's work/ as its agent's tools see it: on the runner, `<runDir>/work`; in any box, BOX_WORK. */
export const agentWorkDir = (runDir: string, place: Place): string => (place.mode === "runner" ? join(runDir, "work") : BOX_WORK);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const listed = (options: readonly string[], value: unknown): boolean => typeof value === "string" && options.includes(value);

/** What is wrong with `place` as a definition gives it, as issues at `field`. */
export function placeIssues(place: unknown, field: string): InputIssue[] {
  const bad = (reason: string, message: string, fix?: string): InputIssue[] => [{ field, reason, message, ...(fix ? { fix } : {}) }];
  if (!isObject(place)) return bad("wrong_type", `${field} is an object: {mode}, or {mode, box}`);
  const extra = Object.keys(place).filter((key) => key !== "mode" && key !== "box");
  if (extra.length) return bad("not_allowed", `${field} keeps only mode and box, not ${extra.join(" or ")}`, `Remove ${extra.map((key) => `${field}.${key}`).join(" and ")}.`);
  if (!listed(PLACE_MODES, place.mode)) return bad(place.mode === undefined ? "missing" : "not_an_option", `${field}.mode is one of ${PLACE_MODES.join(", ")}`);
  if (place.mode === "runner") return place.box === undefined ? [] : bad("not_allowed", "a runner place uses no box", `Remove ${field}.box.`);
  if (place.box === undefined) return bad("missing", `a sandbox place names its box: one of ${BOX_IDS.join(", ")}`);
  if (!listed(BOX_IDS, place.box)) return bad("not_an_option", `${field}.box is one of ${BOX_IDS.join(", ")}`);
  return [];
}
