// The v2 stage's one location badge: where the agent is, in plain words. Pure, so what it says in each place is testable.
import type { ShowState } from "../types.ts";

export type Badge = {
  text: string;
  /** `tab`: the creature's own browser; `cloud`: a machine somewhere; `moving`: between the two; `parked`: nowhere yet. */
  tone: "tab" | "cloud" | "moving" | "parked";
};

export function badgeFor(state: ShowState): Badge {
  const p = state.place;
  switch (p.where) {
    case "tab":
    case "home":
      return { text: "Agent: running in your browser", tone: "tab" };
    case "moving":
      return { text: `Agent: moving to ${p.to === "your browser" || /browser/i.test(p.to) ? "your browser" : p.to}…`, tone: "moving" };
    case "cloud":
    case "universes":
      return { text: `Agent: running on ${p.host}`, tone: "cloud" };
    case "parked":
      return { text: "Agent: waiting", tone: "parked" };
  }
}

export type Track = { left: string; right: string | null; at: "left" | "right" | "between" | "none" };

/**
 * The picture under the badge: the browser on the left, the machine the agent is on or moving to on the right, and where the agent is. It
 * slides across when the run moves. With several machines listed it never guesses the first: the right-hand name is the machine the agent
 * is on, the one it is moving to (or leaving, on its way home), or the last one it visited; only before it has gone anywhere is the first
 * machine the feed lists shown, as where it may go.
 */
export function trackFor(state: ShowState): Track {
  const p = state.place;
  const isTab = (label: string) => state.environments.some((e) => e.kind === "tab" && e.label === label) || /browser|\btab\b/i.test(label);
  const lastMachine = [...state.stays].reverse().find((s) => s.hostKind !== "tab")?.host ?? null;
  const firstListed = state.environments.find((e) => e.kind !== "tab")?.label ?? null;
  let right: string | null;
  if (p.where === "cloud" || p.where === "universes") right = p.host;
  else if (p.where === "moving") right = isTab(p.to) ? p.host : p.to;
  else right = lastMachine ?? firstListed;
  const at: Track["at"] = p.where === "tab" || p.where === "home" ? "left" : p.where === "cloud" || p.where === "universes" ? "right" : p.where === "moving" ? "between" : "none";
  return { left: "your browser", right, at };
}
