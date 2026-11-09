// GET /v2/runs/{run_id}/computer's answer: the run's computer live view, one family for every kind (browser, desktop,
// phone). The viewer comes first: a run's open viewer is served even when its computer would resolve off here now (the
// run holds the keys it started with). With none open, the run's computer says `none` with its kind, or `off` with why
// there is no computer here. `hold` is who drives now.

/** A run's computer: its agent's computer kind (`browser` for the browser tool). */
export type ComputerKind = "browser" | "desktop" | "phone";
/** Who drives the run's computer now: the agent; `pending`, the person's Take over waits for the agent's step; the person. */
export type ComputerHold = "agent" | "pending" | "person";
/** The run's computer as the server reads it: its kind, or why there is none here (in plain words). */
export type ComputerOf = { kind: ComputerKind } | { off: string };
/** The answer, as openapi.ts getRunComputer documents it. */
export type ComputerAnswer =
  | { state: "off"; hold: ComputerHold; why?: string }
  | { state: "none"; kind: ComputerKind; hold: ComputerHold }
  | { state: "live"; kind: ComputerKind; viewer: string; hold: ComputerHold };

export async function computerView(deps: {
  /** The run's open viewer, the owner's link to it (its token in the fragment) and its computer's kind; none, undefined. */
  viewer(): Promise<{ kind: ComputerKind; viewer: string } | undefined>;
  /** The run's computer, read only when no viewer is open. */
  computer(): ComputerOf;
  /** Who drives now. TODO(tl-places computer-hold): the run's ViewerHold.state() once the hold is readable from the
   *  store; until then the agent drives, as no seam answers. */
  hold?(): ComputerHold;
}): Promise<ComputerAnswer> {
  const hold = deps.hold?.() ?? "agent";
  const open = await deps.viewer();
  if (open) return { state: "live", kind: open.kind, viewer: open.viewer, hold };
  const computer = deps.computer();
  if ("off" in computer) return { state: "off", hold: "agent", why: computer.off };
  return { state: "none", kind: computer.kind, hold };
}
