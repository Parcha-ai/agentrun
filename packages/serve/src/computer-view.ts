// GET /v2/runs/{run_id}/computer's answer: the run's computer live view, one family for every kind (browser, desktop,
// phone). The viewer comes first: a run's open viewer is served even when its computer would resolve off here now (the
// run holds the keys it started with). With none open, the run's computer says `none` with its kind and where its session
// is (never opened, opening, closed), or `off` with why there is no computer here. `hold` is who drives now.

import type { JournalEntry } from "./computer-commands.js";
import type { ViewerKind } from "./store/store.js";
import { BROWSER_OPENERS } from "./timeline/labels.js";

export type { JournalEntry };

/** A run's computer: its agent's computer kind (`browser` for the browser tool), the store's viewer kind. */
export type ComputerKind = ViewerKind;
/** Who drives the run's computer now: the agent; `pending`, the person's Take over waits for the agent's step; the person. */
export type ComputerHold = "agent" | "pending" | "person";
/** Where a run's computer with no viewer open is: `unopened`, the run hasn't opened it so far; `opening`, it is being
 *  opened now; `closed`, the run opened one, which is not up now. */
export type ComputerSession = "unopened" | "opening" | "closed";
/** The run's computer as the server reads it: its kind, or why there is none here (in plain words). */
export type ComputerOf = { kind: ComputerKind } | { off: string };
/** The answer, as openapi.ts getRunComputer documents it. */
export type ComputerAnswer =
  | { state: "off"; hold: ComputerHold; why?: string }
  | { state: "none"; kind: ComputerKind; hold: ComputerHold; session: ComputerSession; ended?: { at: string; why: string } }
  | { state: "live"; kind: ComputerKind; viewer: string; hold: ComputerHold };

export async function computerView(deps: {
  /** The run's open viewer, the owner's link to it (its token in the fragment) and its computer's kind; none, undefined. */
  viewer(): Promise<{ kind: ComputerKind; viewer: string } | undefined>;
  /** The run's computer, read only when no viewer is open. */
  computer(): ComputerOf;
  /** Where the run's computer of `kind` is with no viewer open (sessionIn over the run's journal). */
  session(kind: ComputerKind): ComputerSession;
  /** Who drives now. */
  hold?(): ComputerHold;
  /** Why the run's browser is not up, read only for a `none` browser: let go while the run waited for its person, and none
   *  opened since (browser-wait-ended.ts), with when; undefined otherwise. */
  ended?(): Promise<{ at: string; why: string } | undefined>;
}): Promise<ComputerAnswer> {
  const hold = deps.hold?.() ?? "agent";
  const open = await deps.viewer();
  if (open) return { state: "live", kind: open.kind, viewer: open.viewer, hold };
  const computer = deps.computer();
  if ("off" in computer) return { state: "off", hold: "agent", why: computer.off };
  const ended = computer.kind === "browser" ? await deps.ended?.() : undefined;
  if (ended) return { state: "none", kind: computer.kind, hold, session: "closed", ended };
  return { state: "none", kind: computer.kind, hold, session: deps.session(computer.kind) };
}

type Obj = Record<string, unknown>;
const objOf = (value: unknown): Obj | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined);
const messageOf = (entry: JournalEntry): Obj | undefined => {
  const model = (entry as { model?: unknown }).model;
  return Array.isArray(model) ? objOf(model[0]) : undefined;
};

/** Where the run's computer of `kind` is, read from the run's journal `entries` (in order), for a run with no viewer
 *  open. A desktop or a phone is opened by the run's claim at its start and held to its end: opening until its viewer
 *  answers. A browser is opened by the agent's browser steps (BROWSER_OPENERS, the calls the Timeline's "A live browser
 *  session started" row reads): unopened with no such call in the run; opening while one has no result yet; closed
 *  otherwise (released, or let go with its process). */
export function sessionIn(kind: ComputerKind, entries: readonly JournalEntry[]): ComputerSession {
  if (kind !== "browser") return "opening";
  let asked = false;
  const waiting = new Set<string>();
  for (const entry of entries) {
    const message = messageOf(entry);
    if (entry.kind === "pi.assistant" && message && message.stopReason !== "error" && message.stopReason !== "aborted" && Array.isArray(message.content)) {
      for (const block of message.content.map(objOf)) {
        if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string" || !BROWSER_OPENERS.has(block.name)) continue;
        asked = true;
        waiting.add(block.id);
      }
    } else if (entry.kind === "pi.tool-result" && typeof message?.toolCallId === "string") waiting.delete(message.toolCallId);
  }
  return !asked ? "unopened" : waiting.size ? "opening" : "closed";
}
