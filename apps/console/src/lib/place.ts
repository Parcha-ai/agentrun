import type { components } from "./api.generated";
import type { Computer } from "./v2";

/** Where an agent's runs execute (a definition's `place`, a run's `place`) and what this server offers
 *  (capabilities `places`). The server's words for a box it lacks (`reason`) are shown as it gives them. */
export type Place = { mode: "runner" } | { mode: "sandbox"; box: string };
/** `state`: the server's word on a box, `ready` or `unavailable`. */
export type BoxOffer = { id: string; available: boolean; reason?: string; state?: BoxState };
/** A box's state as the server's document types it (capabilities' `places.boxes[].state`). */
type BoxState = NonNullable<components["Capabilities"]["places"]>["boxes"][number]["state"];
/** The same states at run time, to check an answer by: each must be one of the generated type's states. */
const BOX_STATES = ["ready", "unavailable"] as const satisfies readonly BoxState[];
/** `defaultPlace`: the server's `default_place`, the place a NEW agent is given and where a revision that names no place
 *  runs (agentForm.ts defaultPlaceOf); null for none, where the server has no Docker box and its runner no shell: a new
 *  agent names a box or the runner, and a create that names neither and would get a box is refused. */
export type Places = { modes: string[]; boxes: BoxOffer[]; defaultPlace: Place | null };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the runner's own shell runs in Mode 2, Archil's serverless exec: bash alone (serve's tools.ts shellTools). The
 *  background tools still need a box. */
const RUNNER_SHELL: ReadonlySet<string> = new Set(["bash"]);
const NO_SHELL: ReadonlySet<string> = new Set();
/** The box-only tools an agent on the runner keeps: bash where the runner has a shell (Mode 2), none where it has no shell
 *  (Mode 1). Capabilities have no shell field of their own: the server serves the runner as a new agent's default place
 *  only where its runner has a shell (serve's place.ts placesOf), so that is the word read. */
export const runnerShellTools = (places: Places | null | undefined): ReadonlySet<string> => (places?.defaultPlace?.mode === "runner" ? RUNNER_SHELL : NO_SHELL);

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

/** Capabilities' `places` (the server always sends them, with its `default_place`, null for no default), or null before
 *  the capabilities are read. */
export function placesOf(caps: unknown): Places | null {
  const p = isObject(caps) ? caps.places : undefined;
  if (!isObject(p) || !Array.isArray(p.modes) || !Array.isArray(p.boxes)) return null;
  const boxes = p.boxes.filter(isObject).filter((b) => typeof b.id === "string")
    .map((b) => ({ id: b.id as string, available: b.available === true, ...(typeof b.reason === "string" ? { reason: b.reason } : {}), ...(BOX_STATES.includes(b.state as BoxState) ? { state: b.state as BoxState } : {}) }));
  const defaultPlace = p.default_place === null ? null : placeOf(p.default_place);
  if (defaultPlace === undefined) return null;
  return { modes: p.modes.filter((m): m is string => typeof m === "string"), boxes, defaultPlace };
}

/** The place a new agent's form starts on: the served default when it is a sandbox; else none (on the runner by
 *  default, the server keeps no place for it; with no default, the person chooses one). */
export const newAgentPlace = (places: Places | null | undefined): Place | undefined => (places?.defaultPlace?.mode === "sandbox" ? places.defaultPlace : undefined);

/** Where an agent runs, as its page's fact: "In a docker box" or "On the server" (agentForm.ts runsWhere: its own place,
 *  else the server's default for it, which the page marks "(server default)"); null, none here to run in (the server has
 *  no default place), so a place is to be chosen; with no place known yet, the server's default place in words. */
export const placeLabel = (place: Place | null | undefined) => (place === null ? "No place yet: choose a box, or On the server" : !place ? "Where this server's default place is" : place.mode === "sandbox" ? `In a ${place.box} box` : "On the server");

/** Where a run ran, as its header says it: "in a docker box" or "on the server" (every run view names its place). */
export const runPlaceWords = (run: Place): string => (run.mode === "sandbox" ? `in a ${run.box} box` : "on the server");
