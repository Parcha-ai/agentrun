// The on-screen caption: the newest key moment, tagged by what its numbers are. Pure, so the honesty rule is testable:
// a number is shown as MEASURED only when the live driver said so; a scripted feed's numbers are labelled SCRIPTED, and a
// live line with numbers that the driver did not flag is labelled UNMEASURED. A line with no number needs no tag.
import type { Note, ShowState } from "../types.ts";

export type Caption = { text: string; tag: "measured" | "scripted" | "unmeasured" | null; at: number };

/** A quantity: a duration, size, share, price, or a score or checkpoint position. A digit inside a machine name ("GPU 6") is not one. */
const QUANTITY = /\d(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|km|kb|mb|gb|%)(?![a-z])|\$\d|\b(?:checkpoint|with|score)\s+\d/i;

const KEY_KINDS = new Set<Note["kind"]>(["kill", "takeover", "winner", "home", "switch"]);
export const CAPTION_MS = 7000;

export function captionFor(state: ShowState, now: number): Caption | null {
  // Notes are in time order, so the first qualifying note from the end is the newest one.
  for (let i = state.notes.length - 1; i >= 0; i--) {
    const n = state.notes[i];
    if (n.at > now) continue;
    if (now - n.at > CAPTION_MS) return null;
    const flagged = n.measured === true;
    if (!KEY_KINDS.has(n.kind) && !flagged) continue;
    // Some drivers write "(measured)" in the text; the words are shown only through the tag, not twice.
    const said = /\(measured\)/.test(n.text);
    const text = n.text.replace(/\s*\(measured\)/g, "").trim();
    const numeric = QUANTITY.test(text);
    const tag = !numeric ? null : state.source === "scripted" ? "scripted" : flagged || said ? "measured" : "unmeasured";
    return { text, tag, at: n.at };
  }
  return null;
}
