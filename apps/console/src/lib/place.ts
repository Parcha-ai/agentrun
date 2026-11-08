import type { Computer } from "./v2";

/** Where an agent's runs execute (a definition's `place`, a run's `place`) and what this server offers
 *  (capabilities `places`). The server's words for a box it lacks (`reason`) are shown as it gives them. */
export type Place = { mode: "runner" } | { mode: "sandbox"; box: string };
export type BoxOffer = { id: string; available: boolean; reason?: string };
/** `defaultPlace`: the server's `default_place`, the place a NEW agent is given and where a revision that names no place
 *  runs (agentForm.ts defaultPlaceOf). */
export type Places = { modes: string[]; boxes: BoxOffer[]; defaultPlace?: Place };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The computer a place is, as the server keeps place as computer's view: the runner is the computer none, a sandbox box
 *  is a sandbox on that box's provider. */
export const computerOfPlace = (place: Place): Computer => (place.mode === "sandbox" ? { kind: "sandbox", provider: place.box } : { kind: "none" });

/** A place as the server sent it, or undefined for none (the server's default) or a shape this console does not know. */
export function placeOf(v: unknown): Place | undefined {
  if (!isObject(v)) return undefined;
  if (v.mode === "runner") return { mode: "runner" };
  if (v.mode === "sandbox" && typeof v.box === "string") return { mode: "sandbox", box: v.box };
  return undefined;
}

/** Capabilities' `places`, or null on a server without places (it has no picker to offer). */
export function placesOf(caps: unknown): Places | null {
  const p = isObject(caps) ? caps.places : undefined;
  if (!isObject(p) || !Array.isArray(p.modes) || !Array.isArray(p.boxes)) return null;
  const boxes = p.boxes.filter(isObject).filter((b) => typeof b.id === "string")
    .map((b) => ({ id: b.id as string, available: b.available === true, ...(typeof b.reason === "string" ? { reason: b.reason } : {}) }));
  const defaultPlace = placeOf(p.default_place);
  return { modes: p.modes.filter((m): m is string => typeof m === "string"), boxes, ...(defaultPlace ? { defaultPlace } : {}) };
}

/** The place a new agent's form starts on: the served default when it is a sandbox; else none, as before (the server
 *  keeps no place for it, and it runs on the runner). */
export const newAgentPlace = (places: Places | null | undefined): Place | undefined => (places?.defaultPlace?.mode === "sandbox" ? places.defaultPlace : undefined);

/** Where a place runs, in words: "Runs in a docker box" or "Runs on the server". None is the server's default place. */
export function placeWords(place: Place | undefined, places: Places | null): string {
  const p = place ?? places?.defaultPlace;
  if (!p) return "Runs where this server's default puts it";
  return p.mode === "sandbox" ? `Runs in a ${p.box} box` : "Runs on the server";
}

/** Where an agent runs, as its page's fact: "In a docker box", "On the server", or, for an agent that names no place,
 *  this server's default place (capabilities' default_place, which the page does not read). */
export const placeLabel = (place: Place | undefined) => (!place ? "Where this server's default place is" : place.mode === "sandbox" ? `In a ${place.box} box` : "On the server");

/** Where a run ran, as its header says it: "in a docker box" or "on the server". Nothing for a run kept without a place
 *  (an older server). */
export function runPlaceWords(run: Place | undefined): string | undefined {
  if (!run) return undefined;
  return run.mode === "sandbox" ? `in a ${run.box} box` : "on the server";
}
