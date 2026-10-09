// What the page remembers about one take, and when it forgets it: a feed that starts over (a reset, a retake, even with the same run name)
// is a new take, so the stage's own captions are due again and nothing counted for the old one is carried across. Pure.
import { emptyStory } from "./story-notes.ts";

export class TakeMemory {
  story = emptyStory();
  /** The setups whose end has been said, by feed generation and start time. */
  setupNoted = new Set<string>();
  private generation = -1;

  /** Call with the feed's generation each frame. True when the take started over (not for the first connection). */
  sync(generation: number): boolean {
    if (generation === this.generation) return false;
    const first = this.generation === -1;
    this.generation = generation;
    if (first) return false;
    this.story = emptyStory();
    this.setupNoted.clear();
    return true;
  }
}
