// The wait between "teach it to walk" and the first checkpoint is real: the agent sets up the training program on the GPU. The stage says so with a
// seconds counter on its own clock, from the agent's first command on the machine to the tab's first checkpoint. Pure: state in, caption out.
import type { Note, ShowState } from "../types.ts";
import type { Caption } from "./caption.ts";

/** The counter while the setup runs, or null before it starts and after learning has begun. Measured on a live feed; scripted in a rehearsal. */
export function setupCaption(state: ShowState, now: number): { text: string; tag: NonNullable<Caption["tag"]> } | null {
  const s = state.setup;
  if (!s || s.endedAt !== null || now < s.startedAt) return null;
  return { text: `Setting up the training program on the GPU... ${Math.floor((now - s.startedAt) / 1000)} s`, tag: state.source === "live" ? "measured" : "scripted" };
}

/** The line that replaces the counter when learning starts: how long the setup took, on the same clock. */
export function learningStartedNote(setup: NonNullable<ShowState["setup"]>, endedAt: number, source: ShowState["source"], at: number): Note {
  // No `origin`: with one, the caption rule would tag a rehearsal's number unmeasured; without it a rehearsal reads scripted and a live feed measured.
  return { at, kind: "home", text: `Learning started ${Math.round((endedAt - setup.startedAt) / 1000)} s after the agent began.`, measured: source === "live", rank: 2 };
}
