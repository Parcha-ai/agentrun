// The v2 stage's own captions: what the feed and the tab do not say but a viewer needs. Each is said once, in plain words, and carries no number,
// so none needs a tag. Pure: the state in, the notes out, with a small memory of what has already been said.
import type { Note, ShowState } from "../types.ts";
import type { Caption } from "./caption.ts";

export type Story = {
  wasAway: boolean;
  homeSaid: boolean;
  /** A trained brain has reached the tab (the page sets it when the tab reports the final policy installed): the only evidence "Done training" rests on. */
  trained: boolean;
};
export const emptyStory = (): Story => ({ wasAway: false, homeSaid: false, trained: false });

const awayNow = (state: ShowState) => state.place.where === "moving" || state.place.where === "cloud" || state.place.where === "universes";
/** Whether the run has been to a machine: it is away now, or its own record of where it stayed shows one (a page that opens after the return has no other evidence). */
export const wentAway = (state: ShowState): boolean => awayNow(state) || state.stays.some((s) => s.hostKind !== "tab");
const homeNow = (state: ShowState) => state.place.where === "home" || state.place.where === "tab";

/**
 * Once the run is back AND a trained brain has reached the tab: that
 * training is done and what it learned came home. A return with nothing trained (the operator brought it home early) claims nothing, and
 * does not use the line up: a trained brain that arrives later still gets it.
 */
export function storyNotes(state: ShowState, story: Story, at: number): Note[] {
  const out: Note[] = [];
  // The run's own record says where it stayed: a stay on a machine means it went, even if this page opened after it was back.
  if (wentAway(state)) story.wasAway = true;
  if (!awayNow(state) && homeNow(state) && story.wasAway && story.trained && !story.homeSaid) {
    story.homeSaid = true;
    out.push({ at, kind: "home", text: "Done training. The agent came back to your browser, and so did what it learned.", rank: 2 });
  }
  return out;
}

/** Everything the creature does is a physics simulation, so that is said once at the start instead of tagging each number SIMULATED. */
export const simulationNote = (at: number): Note => ({ at, kind: "home", text: "The creature is a physics simulation running in your browser.", rank: 1 });

/**
 * The tag pill a caption wears. The clean view draws none: a viewer read MEASURED as a staged label and doubted what it sat on. The tag is not lost, it
 * is on the caption as data (`data-tag`), which the recorder writes to captions.json and the published page keeps in its notes. ?debug=1 draws every pill.
 */
export const visibleTag = (tag: Caption["tag"], debug: boolean): Caption["tag"] => (debug ? tag : null);
