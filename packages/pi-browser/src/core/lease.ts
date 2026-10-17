import { createHash } from "node:crypto";

export type LeaseState = "creating" | "live" | "held" | "releasing" | "released" | "lost";

/** `gone`: the provider no longer knows the session, which counts as released. */
export type ResourceStatus = "pending" | "running" | "stopped" | "gone";

/** Written to documents, so never a secret: a provider keeps connect URLs and keys in its own memory, found again by
 *  `id`. */
export type LeaseRef = { readonly id: string; readonly tag: string };

/** Each change is one commit, and a provider call sits between two commits, never inside one. `lost` ends custody of a
 *  resource the provider no longer answers for and that was never confirmed released. */
export const LEASE_TRANSITIONS: Readonly<Record<LeaseState | "none", readonly LeaseState[]>> = Object.freeze({
  none: ["creating"],
  creating: ["live", "released", "releasing"],
  live: ["held", "releasing", "released", "lost"],
  held: ["live", "releasing", "released", "lost"],
  releasing: ["released", "lost"],
  released: [],
  lost: [],
});

export function isLeaseTransition(from: LeaseState | "none", to: LeaseState): boolean {
  return LEASE_TRANSITIONS[from].includes(to);
}

// Only the run part may keep a '-', the separator, so two different part lists never join into one tag.
const UNCLEAN = /[^A-Za-z0-9_.]+/g;
const UNCLEAN_RUN = /[^A-Za-z0-9_.-]+/g;

/** A cleaned or cut part keeps a hash of the original, after its head when it fits: distinct parts never collapse. */
function tagPart(part: string, max: number, unclean = UNCLEAN): string {
  const clean = part.replace(unclean, "_");
  if (clean === part && clean.length <= max) return clean;
  const hash = createHash("sha256").update(part).digest("hex");
  return max > 9 ? `${clean.slice(0, max - 9)}_${hash.slice(0, 8)}` : hash.slice(0, max);
}

/** At most 60 characters of `[A-Za-z0-9_.-]`: Browserbase holds metadata values to 60, and a tag query quotes it
 *  unescaped. */
export function leaseTag(prefix: string, run: string, conversation: string | number, seq: number): string {
  return `${tagPart(prefix, 4)}-${tagPart(run, 28, UNCLEAN_RUN)}-${tagPart(String(conversation), 12)}-${tagPart(String(seq), 10)}`;
}
