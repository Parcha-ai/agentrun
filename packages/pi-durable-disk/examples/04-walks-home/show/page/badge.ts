// The v2 stage's one location badge: where the agent is, in plain words. Pure, so what it says in each place is testable.
import type { ShowState } from "../types.ts";
import { wentAway } from "./story-notes.ts";

export type Badge = {
  text: string;
  /** `tab`: the creature's own browser; `cloud`: a machine somewhere; `moving`: between the two; `parked`: nowhere yet. */
  tone: "tab" | "cloud" | "moving" | "parked";
  /** Whether the line about the agent's memory is shown: for as long as it is away (it is why it can change machines at all). */
  memory: boolean;
};

/** The sentence under the header while the agent is away. The product's point, said where a viewer can read it. */
export const MEMORY_LINE = "Its memory is on a cloud disk, so it can change machines without forgetting anything.";

/**
 * The header, in plain words, from the pipe's own label for the machine (never a provider the feed did not name). "Back" only once the run's own
 * record shows it went to a machine.
 */
export function badgeFor(state: ShowState): Badge {
  const p = state.place;
  const isTab = (label: string) => state.environments.some((e) => e.kind === "tab" && e.label === label) || /browser|\btab\b/i.test(label);
  switch (p.where) {
    case "tab":
    case "home":
      return { text: wentAway(state) ? "Your agent is back in your browser" : "Your agent is in your browser", tone: "tab", memory: false };
    case "moving":
      return { text: isTab(p.to) ? "Your agent is moving back to your browser\u2026" : `Your agent is moving to ${p.to}\u2026`, tone: "moving", memory: true };
    case "cloud":
    case "universes":
      return { text: `Your agent moved to ${p.host} to train`, tone: "cloud", memory: true };
    case "parked":
      return { text: "Your agent is waiting", tone: "parked", memory: false };
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
