// The v2 stage's own captions: what the feed and the tab do not say but a viewer needs. Each is said once, in plain words, and carries no number,
// so none needs a tag. Pure: the state in, the notes out, with a small memory of what has already been said.
import type { Note, ShowState } from "../types.ts";
import type { Caption } from "./caption.ts";

export type Story = { memorySaid: boolean; wasAway: boolean; homeSaid: boolean };
export const emptyStory = (): Story => ({ memorySaid: false, wasAway: false, homeSaid: false });

const awayNow = (state: ShowState) => state.place.where === "moving" || state.place.where === "cloud" || state.place.where === "universes";
const homeNow = (state: ShowState) => state.place.where === "home" || state.place.where === "tab";

/**
 * At the first move: why it can move at all (its memory is on a cloud disk). On the way back: why it came home. Said once each. The first
 * is stamped when the run starts to move, so it is the caption that comes with the move, ahead of the measured switch time that follows.
 */
export function storyNotes(state: ShowState, story: Story, at: number): Note[] {
  const out: Note[] = [];
  const note = (text: string): Note => ({ at, kind: "switch", text, rank: 2 });
  if (awayNow(state)) {
    story.wasAway = true;
    if (!story.memorySaid) {
      story.memorySaid = true;
      out.push(note("Its memory is on a cloud disk, so it can change machines without forgetting anything."));
    }
  } else if (homeNow(state) && story.wasAway && !story.homeSaid) {
    story.homeSaid = true;
    out.push({ at, kind: "home", text: "Done training. The agent came back to your browser, and so did what it learned.", rank: 2 });
  }
  return out;
}

/** Everything the creature does is a physics simulation, so that is said once at the start instead of tagging each number SIMULATED. */
export const simulationNote = (at: number): Note => ({ at, kind: "home", text: "The creature is a physics simulation running in your browser.", rank: 1 });

/** The tag a caption wears. The v2 view drops SIMULATED (said once in words instead); ?debug=1 keeps every tag. */
export const visibleTag = (tag: Caption["tag"], debug: boolean): Caption["tag"] => (tag === "simulated" && !debug ? null : tag);
