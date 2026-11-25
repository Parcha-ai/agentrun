// Where a revision's runs execute: `runner` (no box and no shell) or `sandbox` (the agent's file and shell tools run in
// the named box, while its loop, its log and every key stay on the server). A revision keeps the place it names, an
// explicit runner included, since the default is this host's; one that names none keeps none, so a revision written
// before this field keeps its id. Which boxes this server has is said in capabilities, and a revision whose box it does
// not have saves with a warning and is refused at run time. A run runs in its revision's place, else this host's
// default, and keeps the place it resolved to: a run request names none. A sandbox place on a box is a sandbox computer
// of that provider (computer-setting.ts computerOfPlace), which the run's claim starts: any provider whose descriptor
// gives what a box needs (place-offers.ts isBox). A harness's own tools in the box, when they come, are an option of
// sandbox, never a third mode.
//
// The box is a new agent's default machine for a shell: an agentic definition that names no place and no tools is saved,
// at its create, with Docker's box as its place wherever this server has it, and with bash (newAgentPlace). One that
// names its tools gets the box only when one of them needs a shell; else it keeps no place and runs on the runner, with
// no container to wait for. Where Docker's box is not here, a definition that would get it is refused (noBoxRefusal):
// it names a box or the runner, and no other box that answers is picked for it. A revision that names no place resolves
// the same way at each run (defaultPlaceOf): with a shell tool, this server's default_place, so where docker is there
// now it runs in the Docker box, and where it is not its run is refused in the same words. A workflow, a revision whose
// tools need no shell, and one with a tool the box refuses run on the runner.
import { BOX_IDS, BOXES_ENV, type BoxOffer } from "./place-offers.js";
import { type InputIssue, sentence } from "./errors.js";

export const PLACE_MODES = ["runner", "sandbox"] as const;
export type PlaceMode = (typeof PLACE_MODES)[number];

export type Place = { mode: "runner" } | { mode: "sandbox"; box: string };

/** Every box, from what this server found at its start (place-offers.ts): one it did not find is not set up. */
export function boxAvailability(registry: readonly BoxOffer[]): BoxOffer[] {
  return BOX_IDS.map((id) => {
    const offer = registry.find((o) => o.id === id);
    return offer ? { ...offer } : { id, available: false, reason: `${id} is not set up on this server` };
  });
}

/** The box a new agent is given, by its id: Docker's, never another box that answers in its place. */
const DEFAULT_BOX = "docker";
const defaultBox = (registry: readonly BoxOffer[]): BoxOffer => boxAvailability(registry).find((box) => box.id === DEFAULT_BOX)!;

/** What a new agent that would get Docker's box sets where this server does not have it: a box, listing the boxes this
 *  server has (never picking one), or the runner. */
export function placeToName(registry: readonly BoxOffer[]): string {
  const ready = boxAvailability(registry).filter((box) => box.available).map((box) => box.id);
  return `Set place to {mode: sandbox, box: <${ready.length ? `one of: ${ready.join(", ")}` : "none is set up"}>}, or to {mode: runner} to run without a shell.`;
}

/** Why such an agent is refused: it names a box (placeToName). */
export const nameABox = (registry: readonly BoxOffer[]): string => `name a box: this server has no Docker box for a new agent. ${placeToName(registry)}`;

/** The place a new agentic definition that names none is saved with: Docker's box where this server has it; else none,
 *  with `reason`, the words such a definition is refused in (nameABox), and `why` Docker's box is not here, in its probe's
 *  own words. A workflow is never given one. */
export function newAgentPlace(registry: readonly BoxOffer[]): { place: Place } | { reason: string; why: string } {
  const box = defaultBox(registry);
  if (box.available) return { place: { mode: "sandbox", box: box.id } };
  return { reason: nameABox(registry), why: box.reason ?? "no reason given" };
}

/** The place a revision that names none resolves to, at its create and at each run alike: this server's default place
 *  (newAgentPlace) for an agentic revision with a tool that runs only in a box (`flags`, tools.ts: bash and the
 *  background tools); the runner for a workflow, which is never given a box, for one whose tools need no shell (none, or
 *  only read and write: a container would only hold up its start), and for one that names a tool the box refuses (the
 *  browser, runner-only for now). */
export function defaultPlaceOf(kind: "agentic" | "workflow", tools: readonly unknown[], registry: readonly BoxOffer[], flags: ToolFlags): Place {
  if (kind === "workflow" || !wantsBox(tools, flags)) return { mode: "runner" };
  const fresh = newAgentPlace(registry);
  return "place" in fresh ? fresh.place : { mode: "runner" };
}

type ToolFlags = (tool: string) => { readonly sandboxOnly?: true; readonly runnerOnly?: true } | undefined;

/** Whether an agentic revision naming `tools` and no place would be given the default box: one of them runs only in a
 *  box, and none is a tool the box refuses. */
const wantsBox = (tools: readonly unknown[], flags: ToolFlags): boolean => {
  const named = tools.flatMap((tool) => (typeof tool === "string" ? [flags(tool)] : []));
  return !named.some((tool) => tool?.runnerOnly) && named.some((tool) => tool?.sandboxOnly);
};

/** The refusal of an agentic definition that names no place (noPlaceIssue), at its create or at an edit that would
 *  save it, where it would be given the default box (it names no tools, `tools` undefined, so it would get a shell, or a
 *  tool that runs only in a box) and this server does not have Docker's box. A shell tool the runner's own shell runs
 *  (`runnerShell`: bash on Mode 2's Archil exec) needs no box. Undefined for one that saves. */
export function noBoxRefusal(tools: readonly unknown[] | undefined, registry: readonly BoxOffer[], flags: ToolFlags, runnerShell: ReadonlySet<string> = new Set()): InputIssue | undefined {
  if (!wantsBox((tools ?? NEW_AGENT_TOOLS).filter((tool) => typeof tool !== "string" || !runnerShell.has(tool)), flags)) return undefined;
  const fresh = newAgentPlace(registry);
  return "reason" in fresh ? noPlaceIssue(registry) : undefined;
}

/** The refusal of a revision that names no place where Docker's box is not here, at definition.place: its words, and
 *  what to set as its fix, so no example of a place is picked for it. */
export const noPlaceIssue = (registry: readonly BoxOffer[]): InputIssue => ({ field: "definition.place", reason: "missing", message: nameABox(registry), fix: placeToName(registry) });

/** The tools a new agent in the default box is given when its definition names none: a shell, and the background tools
 *  that start, read, feed, signal and list commands that outlive one call (background.ts SHELL_TOOLS, which a test holds
 *  this list to; written out here, since background.ts reads this module). A definition that names its tools, an empty
 *  list included, keeps exactly those. */
export const NEW_AGENT_TOOLS: readonly string[] = Object.freeze(["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]);

const and = (items: readonly string[]): string => new Intl.ListFormat("en", { type: "conjunction" }).format(items);

/** The boxes AGENTRUN_BOXES does not list (`listed`), at once, with the setting that lists them; undefined for none.
 *  Said where no box is ready, in place of each one's own reason, which says the same. */
function notListed(boxes: readonly BoxOffer[], listed: ReadonlySet<string>): string | undefined {
  const ids = boxes.filter((box) => !box.available && !listed.has(box.id)).map((box) => box.id);
  if (ids.length === 0) return undefined;
  return `${and(ids)} ${ids.length === 1 ? "is" : "are"} not enabled: start AgentRun with ${BOXES_ENV} listing the boxes to set up`;
}

/** Why a sandbox-only tool (bash) cannot run on this server: no box is available, each box AGENTRUN_BOXES lists
 *  (`listed`) with its reason, then the boxes it does not list. Undefined when one is. */
export function noBoxReason(registry: readonly BoxOffer[], listed: ReadonlySet<string>): string | undefined {
  const boxes = boxAvailability(registry);
  if (boxes.some((box) => box.available)) return undefined;
  const why = boxes.filter((box) => listed.has(box.id)).map((box) => `${box.id} is unavailable (${box.reason ?? "no reason given"})`);
  const rest = notListed(boxes, listed);
  return `no box is set up on this server: ${[...why, ...(rest ? [rest] : [])].join("; ")}`;
}

/** The start banner's words on the boxes: which are ready for a sandbox agent's tools, then why each box is not that
 *  AGENTRUN_BOXES lists (`listed`), and, when none is ready, the boxes it does not list, with what to do.
 *  `byDefault`, with AGENTRUN_BOXES not set at all: short, the local box alone, said to be on by default, or why it is
 *  not. */
export function boxesLine(registry: readonly BoxOffer[], listed: ReadonlySet<string>, allow: readonly string[] | "none" = "none", byDefault = false): string {
  const boxes = boxAvailability(registry);
  const ready = boxes.filter((box) => box.available).map((box) => box.id);
  const said = ready.length ? [`${and(ready)} ${ready.length === 1 ? "is" : "are"} ready, so sandbox agents run their tools there.`] : [];
  const none = !said.length;
  const why = boxes.filter((box) => !box.available && listed.has(box.id));
  const rest = none ? notListed(boxes, listed) : undefined;
  // What an available box's programs reach, as capabilities say (`network`, `network_reason`, `places.allow`).
  const hosts = and(allow === "none" ? [] : allow);
  const reach = boxes.filter((box) => box.available && box.network).map((box) =>
    box.network === "allowlist" ? sentence(`${box.id} boxes reach only ${hosts}`) : sentence(`${box.id} boxes have no network${box.network_reason ? `: ${box.network_reason}` : ""}`));
  if (byDefault) {
    const box = defaultBox(registry);
    if (!box.available) return `Boxes: none, so a new agent must name its place: a box, or the runner. ${sentence(box.reason ?? "no reason given")}`;
    return [`Boxes: ${box.id} (on by default; set ${BOXES_ENV} to change).`, ...reach].join(" ");
  }
  return ["Boxes:", ...(none ? ["none is ready, so sandbox agents do not run here."] : said), ...reach, ...why.map((box) => sentence(`${box.id}: ${box.reason ?? "not available"}`)), ...(rest ? [sentence(rest)] : [])].join(" ");
}

/** `places` in capabilities: the modes a revision may name, the place a new agent is saved with and a revision that
 *  names none runs in (`default_place`, with `default_reason` when it is the runner: the words a new agent that would get
 *  a box is refused in there), each box, and the hosts a box whose
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
 *  sandbox on the box it names (as its box, or as its mode), or on the first box. */
function meant(place: unknown): Place {
  const box = isObject(place) ? named(BOX_IDS, place.box) ?? named(BOX_IDS, place.mode) : named(BOX_IDS, place);
  if (!box && named(PLACE_MODES, isObject(place) ? place.mode : place) === "runner") return { mode: "runner" };
  return { mode: "sandbox", box: box ?? BOX_IDS[0]! };
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
