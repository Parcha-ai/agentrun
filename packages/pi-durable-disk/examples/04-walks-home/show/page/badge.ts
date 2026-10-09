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
 * The picture under the badge: the browser on the left, the machine the agent can go to on the right (the first one the feed lists that is
 * not a tab, or the one it is on), and where the agent is. It slides across when the run moves.
 */
export function trackFor(state: ShowState): Track {
  const p = state.place;
  const listed = state.environments.find((e) => e.kind !== "tab")?.label ?? null;
  const right = listed ?? (p.where === "cloud" || p.where === "universes" ? p.host : null);
  const at: Track["at"] = p.where === "tab" || p.where === "home" ? "left" : p.where === "cloud" || p.where === "universes" ? "right" : p.where === "moving" ? "between" : "none";
  return { left: "your browser", right, at };
}
