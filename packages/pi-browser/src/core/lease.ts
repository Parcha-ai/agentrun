// A browser session's custody vocabulary: its states and their allowed changes, the provider's view of a session,
// the handle custody commits, and the tag that lets a create whose answer was lost be found again.
import { createHash } from "node:crypto";

export type LeaseState = "creating" | "live" | "releasing" | "released" | "lost";

/** The provider's view of one session. `gone` means it no longer knows it, which counts as released. */
export type ResourceStatus = "pending" | "running" | "stopped" | "gone";

/** A provider's handle on one session. It is written to documents, so it never carries a secret: a provider keeps
 *  connect URLs and keys in its own memory, found again by `id`. */
export type LeaseRef = { readonly id: string; readonly tag: string };

/** Every allowed state change; each is one commit, and a provider call sits between two commits, never inside one.
 *  `lost` ends custody of a resource the provider no longer answers for and that was never confirmed released. */
export const LEASE_TRANSITIONS: Readonly<Record<LeaseState | "none", readonly LeaseState[]>> = Object.freeze({
  none: ["creating"],
  // The create answered, or reconcile bound the tag; the create failed and nothing carries the tag; or a release was
  // asked before the create was settled, which the release task settles by the tag.
  creating: ["live", "released", "releasing"],
  // A release was asked (tool, idle, relaunch, close, or reconcile for a finished conversation); or the provider
  // reports the resource ended.
  live: ["releasing", "released", "lost"],
  releasing: ["released", "lost"],
  released: [],
  lost: [],
});

export function isLeaseTransition(from: LeaseState | "none", to: LeaseState): boolean {
  return LEASE_TRANSITIONS[from].includes(to);
}

/** `part` in `[A-Za-z0-9_.-]`, at most `max` characters. A part that had to be cleaned or cut keeps its head and a hash
 *  of the original, so two distinct parts never collapse into one. */
function tagPart(part: string, max: number): string {
  const clean = part.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return clean === part && clean.length <= max ? clean : `${clean.slice(0, max - 9)}_${createHash("sha256").update(part).digest("hex").slice(0, 8)}`;
}

/** `<prefix>-<run>-<conversation>-<seq>`: unique per run, conversation and sequence number, at most 60 characters of
 *  `[A-Za-z0-9_.-]` (Browserbase metadata values are held to 60), so it fits every provider's metadata and quotes into
 *  a provider's tag query unescaped. */
export function leaseTag(prefix: string, run: string, conversation: string | number, seq: number): string {
  return `${tagPart(prefix, 4)}-${tagPart(run, 28)}-${tagPart(String(conversation), 12)}-${tagPart(String(seq), 10)}`;
}
