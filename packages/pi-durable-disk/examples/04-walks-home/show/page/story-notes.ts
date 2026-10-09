// The v2 stage's own captions: what the feed and the tab do not say but a viewer needs. Each is said once, in plain words, and carries no number,
// so none needs a tag. Pure: the state in, the notes out, with a small memory of what has already been said.
import type { Note, ShowState } from "../types.ts";
import type { Caption } from "./caption.ts";

export type Story = {
  memorySaid: boolean;
  wasAway: boolean;
  homeSaid: boolean;
  /** A trained brain has reached the tab (the page sets it when the tab reports the final policy installed): the only evidence "Done training" rests on. */
  trained: boolean;
};
export const emptyStory = (): Story => ({ memorySaid: false, wasAway: false, homeSaid: false, trained: false });

const awayNow = (state: ShowState) => state.place.where === "moving" || state.place.where === "cloud" || state.place.where === "universes";
const homeNow = (state: ShowState) => state.place.where === "home" || state.place.where === "tab";

/**
 * At the first move: why it can move at all (its memory is on a cloud disk). Once it is back AND a trained brain has reached the tab: that
 * training is done and what it learned came home. A return with nothing trained (the operator brought it home early) claims nothing, and
 * does not use the line up: a trained brain that arrives later still gets it.
 */
export function storyNotes(state: ShowState, story: Story, at: number): Note[] {
  const out: Note[] = [];
  // The run's own record says where it stayed: a stay on a machine means it went, even if this page opened after it was back.
  if (state.stays.some((s) => s.hostKind !== "tab")) story.wasAway = true;
  const note = (text: string): Note => ({ at, kind: "switch", text, rank: 2 });
  if (awayNow(state)) {
    story.wasAway = true;
    if (!story.memorySaid) {
      story.memorySaid = true;
      out.push(note("Its memory is on a cloud disk, so it can change machines without forgetting anything."));
    }
  } else if (homeNow(state) && story.wasAway && story.trained && !story.homeSaid) {
    story.homeSaid = true;
    out.push({ at, kind: "home", text: "Done training. The agent came back to your browser, and so did what it learned.", rank: 2 });
  }
  return out;
}

/** Everything the creature does is a physics simulation, so that is said once at the start instead of tagging each number SIMULATED. */
export const simulationNote = (at: number): Note => ({ at, kind: "home", text: "The creature is a physics simulation running in your browser.", rank: 1 });

/** The tag a caption wears. The v2 view drops SIMULATED (said once in words instead); ?debug=1 keeps every tag. */
export const visibleTag = (tag: Caption["tag"], debug: boolean): Caption["tag"] => (tag === "simulated" && !debug ? null : tag);
