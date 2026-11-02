// Where a revision's runs execute: `runner` (no box and no shell) or `sandbox` (the agent's file and shell tools run in
// the named box, while its loop, its log and every key stay on the server). A revision keeps the place it names, an
// explicit runner included, since the default is this host's; one that names none keeps none, so a revision written
// before this field keeps its id. Which boxes this server has is said in capabilities, and a revision whose box it does
// not have saves with a warning and is refused at run time. A harness's own tools in the box, when they come, are an
// option of sandbox, never a third mode.
import type { InputIssue } from "./errors.js";

export const PLACE_MODES = ["runner", "sandbox"] as const;
export type PlaceMode = (typeof PLACE_MODES)[number];
export const BOXES = ["bwrap", "docker", "modal", "daytona"] as const;
export type BoxId = (typeof BOXES)[number];
export const DEFAULT_PLACE_MODE: PlaceMode = "runner";

export type Place = { mode: "runner" } | { mode: "sandbox"; box: BoxId };

/** One box as capabilities lists it: whether this server has it, and when not, why. */
export type BoxOffer = { id: BoxId; available: boolean; reason?: string };

/** The boxes this server has. None yet. */
export function boxAvailability(_env: NodeJS.ProcessEnv): BoxOffer[] {
  return BOXES.map((id) => ({ id, available: false, reason: `${id} is not set up on this server.` }));
}

/** `places` in capabilities: the modes a revision may name, this host's default, and each box. */
export const placesOf = (env: NodeJS.ProcessEnv) => ({ modes: [...PLACE_MODES], default: DEFAULT_PLACE_MODE, boxes: boxAvailability(env) });

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
  if (place.box === undefined) return bad("missing", `a sandbox place names its box: one of ${BOXES.join(", ")}`);
  if (!listed(BOXES, place.box)) return bad("not_an_option", `${field}.box is one of ${BOXES.join(", ")}`);
  return [];
}
