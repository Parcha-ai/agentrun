// Where a revision's runs execute: `runner` (no box and no shell) or `sandbox` (the agent's file and shell tools run in
// the named box, while its loop, its log and every key stay on the server). A revision keeps the place it names, an
// explicit runner included, since the default is this host's; one that names none keeps none, so a revision written
// before this field keeps its id. Which boxes this server has is said in capabilities, and a revision whose box it does
// not have saves with a warning and is refused at run time. A run runs in its revision's place, else this host's
// default, and keeps the place it resolved to: a run request names none. A sandbox place on a box is a sandbox computer
// of that provider (computer-setting.ts computerOfPlace), which the run's claim starts: Docker, Daytona or Modal; bwrap
// says it does not run yet. A harness's own tools in the box, when they come, are an option of sandbox, never a third
// mode.
//
// The box is a new agent's default machine: an agentic definition that names no place is saved, at its create, with the
// Docker box as its place wherever this server has docker, and with bash when it names no tools
// (newAgentPlace). A revision that names no place resolves the same way at each run (defaultPlaceOf): this server's
// default_place, so where docker is there now it runs in the Docker box, and the runner where it is not. A workflow, and a
// revision with a tool the box refuses, run on the runner.
import { BOX_IDS, BOXES_ENV, type BoxId, type BoxOffer } from "./place-offers.js";
import { type InputIssue, sentence } from "./errors.js";

export const PLACE_MODES = ["runner", "sandbox"] as const;
export type PlaceMode = (typeof PLACE_MODES)[number];

export type Place = { mode: "runner" } | { mode: "sandbox"; box: BoxId };

/** The boxes runs execute in: the sandbox computers of Docker, Daytona and Modal. */
export const RUN_BOXES: readonly BoxId[] = ["docker", "daytona", "modal"];

/** The boxes this server gives runs, from what it found at its start (place-offers.ts): a box runs execute in that it
 *  has, and no other. */
export function boxAvailability(registry: readonly BoxOffer[]): BoxOffer[] {
  return BOX_IDS.map((id) => {
    const offer = registry.find((o) => o.id === id);
    if (!offer) return { id, available: false, reason: `${id} is not set up on this server` };
    if (!offer.available || RUN_BOXES.includes(id)) return { ...offer };
    return { id, available: false, reason: `runs in the ${id} box are not available yet: use the ${RUN_BOXES.join(" or ")} box` };
  });
}

/** The place a new agentic definition that names none is saved with: the Docker box where this server has it; else none, so the agent runs on the runner as it did before, with
 *  `reason` saying why, in docker's own words. A workflow is never given one. */
export function newAgentPlace(registry: readonly BoxOffer[]): { place: Place } | { reason: string } {
  const docker = boxAvailability(registry).find((box) => box.id === "docker");
  if (docker?.available) return { place: { mode: "sandbox", box: "docker" } };
  return { reason: `new agents run on the runner, because the docker box is unavailable here: ${docker?.reason ?? "it is not set up"}` };
}

/** The place a revision that names none resolves to, at its create and at each run alike: this server's default place
 *  (newAgentPlace) for an agentic revision; the runner for a workflow, which is never given a box, and for one that names
 *  a tool the box refuses (`refused`: the browser, runner-only for now). */
export function defaultPlaceOf(kind: "agentic" | "workflow", tools: readonly unknown[], registry: readonly BoxOffer[], refused: (tool: string) => boolean): Place {
  if (kind === "workflow" || tools.some((tool) => typeof tool === "string" && refused(tool))) return { mode: "runner" };
  const fresh = newAgentPlace(registry);
  return "place" in fresh ? fresh.place : { mode: "runner" };
}

/** The tools a new agent in the default box is given when its definition names none: a shell, and the background tools
 *  that start, read, feed, signal and list commands that outlive one call (background.ts SHELL_TOOLS, which a test holds
 *  this list to; written out here, since background.ts reads this module). A definition that names its tools, an empty
 *  list included, keeps exactly those. */
export const NEW_AGENT_TOOLS: readonly string[] = Object.freeze(["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]);

/** Why a sandbox-only tool (bash) cannot run on this server: no box runs execute in is available, each with its reason.
 *  Undefined when one is. */
export function noBoxReason(registry: readonly BoxOffer[]): string | undefined {
  const boxes = boxAvailability(registry).filter((box) => RUN_BOXES.includes(box.id));
  if (boxes.some((box) => box.available)) return undefined;
  return `no box is set up on this server: ${boxes.map((box) => `${box.id} is unavailable (${box.reason ?? "no reason given"})`).join("; ")}`;
}

/** The start banner's words on the boxes: which are ready for a sandbox agent's tools, then why each box is not that
 *  AGENTRUN_BOXES lists (`listed`), or, when none is ready, each box runs execute in, with what to do.
 *  `byDefault`, with AGENTRUN_BOXES not set at all: short, docker alone, said to be on by default, or why it is not. */
export function boxesLine(registry: readonly BoxOffer[], listed: ReadonlySet<BoxId>, allow: readonly string[] | "none" = "none", byDefault = false): string {
  const boxes = boxAvailability(registry);
  const ready = boxes.filter((box) => box.available).map((box) => box.id);
  const said = ready.length ? [`${new Intl.ListFormat("en", { type: "conjunction" }).format(ready)} ${ready.length === 1 ? "is" : "are"} ready, so sandbox agents run their tools there.`] : [];
  const none = !said.length;
  const why = boxes.filter((box) => !box.available && (listed.has(box.id) || (none && RUN_BOXES.includes(box.id))));
  // What an available box's programs reach, as capabilities say (`network`, `network_reason`, `places.allow`).
  const hosts = new Intl.ListFormat("en", { type: "conjunction" }).format(allow === "none" ? [] : allow);
  const reach = boxes.filter((box) => box.available && box.network).map((box) =>
    box.network === "allowlist" ? sentence(`${box.id} boxes reach only ${hosts}`) : sentence(`${box.id} boxes have no network${box.network_reason ? `: ${box.network_reason}` : ""}`));
  if (byDefault) {
    const docker = boxes.find((box) => box.id === "docker");
    if (!docker?.available) return `Boxes: none, so new agents run on the runner. ${sentence(docker?.reason ?? "Docker is not set up")}`;
    return [`Boxes: docker (on by default; set ${BOXES_ENV} to change).`, ...reach].join(" ");
  }
  return ["Boxes:", ...(none ? ["none is ready, so sandbox agents do not run here."] : said), ...reach, ...why.map((box) => sentence(`${box.id}: ${box.reason ?? "not available"}`))].join(" ");
}

/** `places` in capabilities: the modes a revision may name, the place a new agent is saved with and a revision that
 *  names none runs in (`default_place`, with `default_reason` when it is the runner), each box, and the hosts a box whose
 *  `network` is `allowlist` reaches (`allow`, box-settings.ts boxAllowOf; empty for `none`). */
export const placesOf = (registry: readonly BoxOffer[], allow: readonly string[] | "none" = "none") => {
  const fresh = newAgentPlace(registry);
  return { modes: [...PLACE_MODES], ...("place" in fresh ? { default_place: fresh.place } : { default_place: { mode: "runner" } as Place, default_reason: fresh.reason }), boxes: boxAvailability(registry).map(stated), allow: allow === "none" ? [] : [...allow] };
};
/** A box with its state, `ready` when it is available and `unavailable` when not; and, on an available box, its network as the server set it, with
 *  `network_reason` when it is none for a cause of its own. */
const stated = ({ state: _state, network, network_reason, ...offer }: BoxOffer): BoxOffer => ({
  ...offer,
  state: offer.available ? "ready" : "unavailable",
  ...(offer.available && network ? { network } : {}),
  ...(offer.available && network === "none" && network_reason ? { network_reason } : {}),
});

/** A run's place: its revision's, else the place a revision that names none resolves to here (`fallback`: defaultPlaceOf). */
export const resolvePlace = (revision: Place | undefined, fallback: Place): Place => revision ?? fallback;


/** Where a box has the run's work/ (bound, or seeded), and where its tools start: the same in every box. */
export const BOX_WORK = "/workspace";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const listed = (options: readonly string[], value: unknown): boolean => typeof value === "string" && options.includes(value);

/** `place` as a definition writes it, to copy: `"place": {"mode": "sandbox", "box": "docker"}`. */
export const placeFix = (place: Place): string => `"place": ${place.mode === "runner" ? '{"mode": "runner"}' : `{"mode": "sandbox", "box": "${place.box}"}`}`;

/** The option of `options` that `value` names in any case, if any. */
const named = <T extends string>(options: readonly T[], value: unknown): T | undefined => (typeof value === "string" ? options.find((option) => option === value.trim().toLowerCase()) : undefined);

/** The place a definition most likely meant by a `place` that is none: the runner when that is all it names, else a
 *  sandbox on the box it names (as its box, or as its mode), or on the first box runs execute in. */
function meant(place: unknown): Place {
  const box = isObject(place) ? named(BOX_IDS, place.box) ?? named(BOX_IDS, place.mode) : named(BOX_IDS, place);
  if (!box && named(PLACE_MODES, isObject(place) ? place.mode : place) === "runner") return { mode: "runner" };
  return { mode: "sandbox", box: box ?? RUN_BOXES[0]! };
}

/** What is wrong with `place` as a definition gives it, as issues at `field`. Each names its fix: the field to remove,
 *  or the place to copy, the one it most likely meant. */
export function placeIssues(place: unknown, field: string): InputIssue[] {
  const bad = (reason: string, message: string, fix = placeFix(meant(place))): InputIssue[] => [{ field, reason, message, fix }];
  if (!isObject(place)) return bad("wrong_type", `${field} is an object: {mode}, or {mode, box}`);
  const extra = Object.keys(place).filter((key) => key !== "mode" && key !== "box");
  if (extra.length) return bad("not_allowed", `${field} keeps only mode and box, not ${extra.join(" or ")}`, `Remove ${extra.map((key) => `${field}.${key}`).join(" and ")}.`);
  if (!listed(PLACE_MODES, place.mode)) return bad(place.mode === undefined ? "missing" : "not_an_option", `${field}.mode is one of ${PLACE_MODES.join(", ")}`);
  if (place.mode === "runner") return place.box === undefined ? [] : bad("not_allowed", "a runner place uses no box", `Remove ${field}.box.`);
  if (place.box === undefined) return bad("missing", `a sandbox place names its box: one of ${BOX_IDS.join(", ")}`);
  if (!listed(BOX_IDS, place.box)) return bad("not_an_option", `${field}.box is one of ${BOX_IDS.join(", ")}`);
  return [];
}
