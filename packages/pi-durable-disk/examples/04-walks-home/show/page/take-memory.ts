// What the page remembers about one take, and when it forgets it: a feed that starts over (a reset, a retake, even with the same run name) is a new
// take, so the stage's own captions are due again and nothing counted for the old one is carried across. All of it lives here and resets together
// (it used to be spread over module variables, and only some of them reset). Notes are added through the memory, which syncs first, so a note for
// the new take is never wiped by a reset that was already due. Pure.
import type { Note } from "../types.ts";
import { emptyStory } from "./story-notes.ts";

const MAX_NOTES = 60;

export class TakeMemory {
  story = emptyStory();
  /** The setups whose end has been said, by feed generation and start time. */
  setupNoted = new Set<string>();
  /** The stage's and the tab's own captions for this take, oldest first. */
  notes: Note[] = [];
  /** The trained brain the stage asked the tab to load for this take ("" until it has), so the next take asks again. */
  policyRequested = "";
  /** Whether the run went to a machine in this take. */
  wasAway = false;
  /** What each install the tab reported was, by its number, and the last one's kind. */
  installKind = new Map<number, "checkpoint" | "final">();
  lastInstallKind: "checkpoint" | "final" | undefined;
  /** Each version's reported distance in the fixed 10 s window, in order of arrival, for the sparkline. A version that arrives twice replaces its point. */
  versions: { n: number; metres: number }[] = [];
  /** When the tab last said the creature was kicked (the page clock), so the getup lines are told only after one. */
  lastKickAt: number | null = null;
  /** The tab reported the first stroke of a drawing: the chat's "draw a creature" prompt has done its job. */
  drawStarted = false;
  private generation = -1;

  /** Call with the feed's generation. True when the take started over (not for the first connection). */
  sync(generation: number): boolean {
    if (generation === this.generation) return false;
    const first = this.generation === -1;
    this.generation = generation;
    if (first) return false;
    this.story = emptyStory();
    this.setupNoted.clear();
    this.notes = [];
    this.policyRequested = "";
    this.wasAway = false;
    this.installKind.clear();
    this.lastInstallKind = undefined;
    this.versions = [];
    this.lastKickAt = null;
    this.drawStarted = false;
    return true;
  }

  /** Records a version's distance (its file's own report) for the sparkline. */
  addVersion(n: number, metres: number): void {
    const at = this.versions.findIndex((v) => v.n === n);
    if (at >= 0) this.versions[at] = { n, metres };
    else this.versions.push({ n, metres });
  }

  /** Adds notes for the take the feed is in now: syncs first, so a restart that is due clears the old take's notes and not these. True when it restarted. */
  add(generation: number, ...notes: Note[]): boolean {
    const restarted = this.sync(generation);
    this.notes.push(...notes);
    if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES);
    return restarted;
  }
}
