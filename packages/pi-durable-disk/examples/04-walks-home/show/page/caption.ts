// The on-screen caption: the newest key moment, tagged by what its numbers are. Pure, so the honesty rule is testable:
// a number is shown as MEASURED only when the live driver said so; a scripted feed's numbers are labelled SCRIPTED, and a
// live line with numbers that the driver did not flag is labelled UNMEASURED. A line with no number needs no tag.
import type { Note, ShowState } from "../types.ts";

export type Caption = { text: string; tag: "measured" | "scripted" | "unmeasured" | "agent" | "simulated" | "reported" | null; at: number };

/** A quantity: a duration, size, share, price, or a score or checkpoint position. A digit inside a machine name ("GPU 6") is not one. */
const QUANTITY = /\d(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|km|kb|mb|gb|%)(?![a-z])|\$\d|\b(?:checkpoint|with|score)\s+\d/i;

const KEY_KINDS = new Set<Note["kind"]>(["kill", "takeover", "winner", "home", "switch", "agent"]);
const MAX_CHARS = 220;
export const CAPTION_MS = 7000;

/** Words that claim nothing was lost ("0 acknowledged writes lost", "zero loss", "nothing was lost", "no writes lost"). */
const ZERO_LOSS = /\b(?:zero|no|0)\s+(?:acknowledged\s+)?(?:writes?|commits?|files?|data)\s+(?:were\s+)?lost\b|\bzero[- ]loss\b|\bnothing\s+(?:was\s+)?lost\b|\bwithout\s+losing\b/i;
export const claimsZeroLoss = (text: string): boolean => ZERO_LOSS.test(text);
/** The only evidence a measured zero-loss claim may cite: a read-back that does not go through the pipe being judged. */
const INDEPENDENT = new Set<NonNullable<Note["evidence"]>>(["independent-readback", "chaos-harness"]);

function caption(n: Note, source: ShowState["source"]): Caption {
  const flagged = n.measured === true;
  // Some drivers write "(measured)" in the text; the words are shown only through the tag, not twice.
  const said = /\(measured\)/.test(n.text);
  const full = n.text.replace(/\s*\(measured\)/g, "").trim();
  const text = full.length > MAX_CHARS ? `${full.slice(0, MAX_CHARS - 1).trimEnd()}\u2026` : full;
  // What the agent says is quoted speech, not a number of ours: it is tagged AGENT, never measured or unmeasured.
  if (n.kind === "agent") return { text, tag: "agent", at: n.at };
  // A claim that nothing was lost is measured only on independent evidence. The pipe's own digest of what it wrote (pipe.released) is
  // not a read-back of the disk: a note that flags itself measured on that, or on nothing, is shown unmeasured.
  const zeroLoss = claimsZeroLoss(full);
  const backed = !zeroLoss || (n.evidence !== undefined && INDEPENDENT.has(n.evidence));
  const measured = (flagged || said) && backed;
  let tag: Caption["tag"];
  if (!QUANTITY.test(full) && !zeroLoss) tag = null;
  else if (n.basis !== undefined) tag = n.basis;
  else if (n.origin === "tab") tag = flagged && backed ? "measured" : "unmeasured";
  else if (source === "scripted") tag = "scripted";
  else tag = measured ? "measured" : "unmeasured";
  return { text, tag, at: n.at };
}

/**
 * The key moments still on screen, oldest first, at most `max`: a measured switch time must not vanish the instant the
 * agent's notice arrives, so several captions stack and each one stays for CAPTION_MS.
 */
export function captionsFor(state: ShowState, now: number, max = 3): Caption[] {
  const live: Caption[] = [];
  // Notes are in time order, so walking from the end meets the newest first.
  for (let i = state.notes.length - 1; i >= 0 && live.length < max; i--) {
    const n = state.notes[i];
    if (n.at > now) continue;
    if (now - n.at > CAPTION_MS) break;
    if (!KEY_KINDS.has(n.kind) && n.measured !== true) continue;
    live.unshift(caption(n, state.source));
  }
  return live;
}

/** The newest key moment, or null. */
export function captionFor(state: ShowState, now: number): Caption | null {
  return captionsFor(state, now, 1)[0] ?? null;
}
