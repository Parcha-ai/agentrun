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
const ZERO_LOSS = /\b(?:zero|no|0)\s+(?:acknowledged\s+)?(?:writes?|commits?|files?|data)\s+(?:(?:were|was)\s+)?lost\b|\bzero[- ]loss\b|\bnothing\s+(?:was\s+)?lost\b|\bwithout\s+losing\b/i;
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

/**
 * The v2 stage's caption: one at a time, held long enough to read. A key moment is shown for at least `minHoldMs`; the next unseen
 * one replaces it once that has passed, and the last one clears after `maxHoldMs`. The agent's own lines are the chat's job, so they
 * are not captions here. A moment older than `staleMs` when the page first looks (a reconnect) is history, not news.
 */
export class CaptionDesk {
  private shown = new Set<string>();
  private current: { caption: Caption; shownAt: number } | undefined;
  private lastNow = 0;
  private opts: { minHoldMs: number; maxHoldMs: number; staleMs: number; lagMs: number };

  constructor(options: { minHoldMs?: number; maxHoldMs?: number; staleMs?: number; lagMs?: number } = {}) {
    this.opts = { minHoldMs: options.minHoldMs ?? 4000, maxHoldMs: options.maxHoldMs ?? 10_000, staleMs: options.staleMs ?? 15_000, lagMs: options.lagMs ?? 8000 };
  }

  /** `yieldSlot`: something open-ended (the setup counter) wants the slot, so a caption that has had its time and has nothing behind it gives way. */
  update(state: ShowState, now: number, options: { yieldSlot?: boolean } = {}): Caption | null {
    // A clock that went backwards is a new timeline (a reset, a retake): nothing of the old one is still on screen or already seen.
    if (now < this.lastNow) {
      this.current = undefined;
      this.shown.clear();
    }
    this.lastNow = now;
    if (this.current && now - this.current.shownAt < this.opts.minHoldMs) return this.current.caption;
    // The moments waiting, oldest first. When several are waiting the desk catches up: one already older than `lagMs` is skipped, so the
    // newest news is not stuck behind a backlog. A single late moment is still shown.
    const waiting: { n: Note; key: string }[] = [];
    for (const n of state.notes) {
      if (n.at > now) break;
      if (now - n.at > this.opts.staleMs) continue;
      if (n.kind === "agent" || (!KEY_KINDS.has(n.kind) && n.measured !== true)) continue;
      const key = `${n.at}|${n.kind}|${n.text}`;
      if (!this.shown.has(key)) waiting.push({ n, key });
    }
    const fresh = waiting.filter((w) => now - w.n.at <= this.opts.lagMs);
    const take = waiting.length > 1 ? (fresh.length > 0 ? fresh : waiting.slice(-1)) : waiting;
    for (const w of waiting) if (!take.includes(w)) this.shown.add(w.key);
    // Of what is still news, the one a viewer needs most first (a note's `rank`), then the oldest.
    const next = take.reduce<{ n: Note; key: string } | undefined>((best, w) => (best === undefined || (w.n.rank ?? 0) > (best.n.rank ?? 0) ? w : best), undefined);
    if (next) {
      this.shown.add(next.key);
      this.current = { caption: caption(next.n, state.source), shownAt: now };
      return this.current.caption;
    }
    if (this.current && now - this.current.shownAt >= (options.yieldSlot ? this.opts.minHoldMs : this.opts.maxHoldMs)) this.current = undefined;
    return this.current?.caption ?? null;
  }
}
