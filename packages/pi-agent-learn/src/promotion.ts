import { LearnError } from "./errors.js";
import { currentRevision, LIMITS, type Precondition, pruneUses, type Revision, type Trial, type Use } from "./trial.js";

/** Promote a trial after this many clean uses in a row; demote after this many failed or escalated ones in a row. */
export const PROMOTION_DEFAULTS = Object.freeze({ promoteAfter: 3, demoteAfter: 2 });
export type Thresholds = { readonly promoteAfter: number; readonly demoteAfter: number };

/** The host's thresholds over the defaults, each a whole number from 1 to `LIMITS.threshold`. */
export function thresholdsOf(partial?: Partial<Thresholds>): Thresholds {
  const thresholds = { ...PROMOTION_DEFAULTS, ...partial };
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.threshold) throw new LearnError("invalid", `${key} is a whole number from 1 to ${LIMITS.threshold}`);
  }
  return thresholds;
}

export type Decision =
  | { readonly action: "hold"; readonly reason: string }
  | { readonly action: "promote"; readonly sha256: string; readonly reason: string }
  /** `rollbackTo` is the revision restored in its place, or null when none can be: the name is then demoted whole.
   *  `skipped` are the superseded revisions the search passed over as unrunnable, newest first. */
  | { readonly action: "demote"; readonly sha256: string; readonly reason: string; readonly rollbackTo: string | null; readonly skipped: readonly string[] };

export type DecisionOptions = {
  readonly thresholds?: Partial<Thresholds>;
  /** Superseded revisions the store can no longer load: a rollback never restores one. */
  readonly unrunnable?: ReadonlySet<string>;
};

const short = (sha: string) => sha.slice(0, 12);

/** A revision's uses folded since it took its current standing, in the order they were folded: a restored revision's earlier
 *  failures never count again. */
export function periodUses(trial: Trial, revision: Revision): Use[] {
  return trial.uses.slice(revision.after).filter((use) => use.sha256 === revision.sha256);
}

/** The most recent superseded revision that can still run, and the newer superseded ones passed over. */
function rollbackSearch(trial: Trial, unrunnable: ReadonlySet<string>): { target: string | null; skipped: string[] } {
  const skipped: string[] = [];
  const candidates = trial.revisions.map((revision, index) => ({ revision, index })).filter(({ revision }) => revision.status === "superseded")
    .sort((a, b) => (a.revision.since < b.revision.since ? 1 : a.revision.since > b.revision.since ? -1 : b.index - a.index));
  for (const { revision } of candidates) {
    if (!unrunnable.has(revision.sha256)) return { target: revision.sha256, skipped };
    skipped.push(revision.sha256);
  }
  return { target: null, skipped };
}

/**
 * What the live revision's uses call for, on receipts alone. Demotion comes first: when its last `demoteAfter` uses
 * since it took its standing all failed or escalated, it is demoted and the most recent superseded revision that still
 * runs comes back. A trial is promoted when its last `promoteAfter` uses all finished frozen. Anything else holds. A demoted
 * revision is never live again, so it is never promoted again, whatever its uses.
 */
export function promotionDecision(trial: Trial, options: DecisionOptions = {}): Decision {
  const live = currentRevision(trial);
  if (!live) return { action: "hold", reason: "no revision is live" };
  const { promoteAfter, demoteAfter } = thresholdsOf(options.thresholds);
  const uses = periodUses(trial, live);
  const worst = uses.slice(-demoteAfter);
  if (worst.length === demoteAfter && worst.every((use) => use.outcome !== "frozen")) {
    const { target, skipped } = rollbackSearch(trial, options.unrunnable ?? new Set());
    const passed = skipped.length ? `; skipped unrunnable ${skipped.map(short).join(", ")}` : "";
    return { action: "demote", sha256: live.sha256, rollbackTo: target, skipped, reason: `its last ${demoteAfter} uses ended ${worst.map((use) => use.outcome).join(", ")}${passed}` };
  }
  if (live.status === "trial") {
    const best = uses.slice(-promoteAfter);
    if (best.length === promoteAfter && best.every((use) => use.outcome === "frozen")) {
      return { action: "promote", sha256: live.sha256, reason: `its last ${promoteAfter} uses all finished frozen` };
    }
    return { action: "hold", reason: `${short(live.sha256)} has ${uses.length} use${uses.length === 1 ? "" : "s"} in its trial; promotion needs its last ${promoteAfter} all frozen` };
  }
  return { action: "hold", reason: `${short(live.sha256)} is active and its last uses did not all fail` };
}

/** A revision with the standing it takes now and none of what only a superseded revision keeps. */
const taking = (revision: Revision, status: Revision["status"], since: string, after: number): Revision => {
  const { when: _when, description: _description, ...rest } = revision;
  return { ...rest, status, since, after };
};

/**
 * The trial a decision leaves, from the use at `at` that caused it, with `uses` folded so far. A promotion makes the trial
 * active. A demotion makes the live revision demoted, and restores the revision it names with its preconditions, or, with
 * none, leaves no revision live. The uses that follow count toward the new standing, not the ones before. Refuses a
 * decision that does not apply.
 */
export function applyDecision(trial: Trial, decision: Decision, at: string): Trial {
  if (decision.action === "hold") return trial;
  const live = currentRevision(trial);
  if (!live || live.sha256 !== decision.sha256) throw new LearnError("invalid", `${short(decision.sha256)} is not the live revision`);
  const after = trial.uses.length;
  if (decision.action === "promote") {
    if (live.status !== "trial") throw new LearnError("invalid", "only a trial is promoted");
    return { ...trial, status: "active", revisions: trial.revisions.map((r) => (r === live ? taking(r, "active", at, after) : r)) };
  }
  const back = decision.rollbackTo;
  const target = back === null ? undefined : trial.revisions.find((r) => r.sha256 === back);
  if (back !== null && target?.status !== "superseded") throw new LearnError("invalid", `${short(back)} is not a superseded revision, so it cannot be restored`);
  const revisions = trial.revisions.map((r): Revision => (r === live ? taking(r, "demoted", at, after) : r === target ? taking(r, "active", at, after) : r));
  return target
    ? { ...trial, status: "active", when: target.when ?? [], revisions }
    : { ...trial, status: "demoted", revisions };
}

export type AdmitRevision = {
  readonly name: string;
  readonly sha256: string;
  readonly run: string;
  readonly at: string;
  readonly when: readonly Precondition[];
  /** The description of the skill as it stands, kept with the revision this one replaces when that was active. */
  readonly replacedDescription?: string;
};
export type Admission =
  | { readonly status: "admitted" | "unchanged"; readonly trial: Trial }
  | { readonly status: "refused"; readonly reason: "demoted" | "limit"; readonly detail: string };

/**
 * A new revision becomes the live trial under its name, with `when` as its preconditions. The revision it replaces is
 * superseded when it was active, keeping its preconditions and the description of its skill so a rollback restores them, and
 * retired when it was a trial that had not proved itself. Only the `LIMITS.restorable` newest superseded revisions keep
 * that; an older one is retired. A digest the trial already holds changes nothing, and a demoted one is refused: only a
 * changed document, a new digest, can be tried under the name again.
 */
export function admitRevision(trial: Trial | undefined, input: AdmitRevision): Admission {
  const held = trial?.revisions.find((r) => r.sha256 === input.sha256);
  if (held?.status === "demoted") return { status: "refused", reason: "demoted", detail: `${short(input.sha256)} was demoted; a demoted revision is never tried again` };
  if (trial && held) return { status: "unchanged", trial };
  if (trial && trial.revisions.length >= LIMITS.revisions) return { status: "refused", reason: "limit", detail: `${input.name} already holds ${LIMITS.revisions} revisions` };
  const after = trial?.uses.length ?? 0;
  const fresh: Revision = { sha256: input.sha256, status: "trial", since: input.at, run: input.run, after };
  const replaced = (trial?.revisions ?? []).map((r): Revision => {
    if (r.status === "active") {
      return { ...taking(r, "superseded", input.at, r.after), when: trial!.when, ...(input.replacedDescription === undefined ? {} : { description: input.replacedDescription }) };
    }
    return r.status === "trial" ? taking(r, "retired", input.at, r.after) : r;
  });
  const superseded = replaced.map((r, index) => ({ r, index })).filter(({ r }) => r.status === "superseded").sort((a, b) => (a.r.since < b.r.since ? -1 : a.r.since > b.r.since ? 1 : a.index - b.index));
  const forgotten = new Set(superseded.slice(0, Math.max(0, superseded.length - LIMITS.restorable)).map(({ index }) => index));
  const revisions = replaced.map((r, index) => (forgotten.has(index) ? taking(r, "retired", r.since, r.after) : r));
  return { status: "admitted", trial: { name: input.name, status: "trial", when: input.when, revisions: [...revisions, fresh], uses: trial?.uses ?? [] } };
}

export type IgnoredUse = { readonly use: Use; readonly reason: "unknown_revision" | "author" | "duplicate" };
export type Applied = { readonly decision: Exclude<Decision, { action: "hold" }>; readonly at: string };
export type Folded = { readonly trial: Trial; readonly applied: readonly Applied[]; readonly ignored: readonly IgnoredUse[] };

const order = (a: Use, b: Use) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.run < b.run ? -1 : a.run > b.run ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0);

/**
 * Appends one run's uses to a trial and settles after each one, as if a curator had run between them. The uses of one call
 * are folded in the order they happened; calls are folded in the order they are made, and that order, not any clock, decides
 * which uses count toward a standing: a use that arrives after a decision counts toward the standing the decision gave. A use
 * of a revision the trial does not hold is left out, and so is one by the run that proposed the revision (the author's run is
 * not evidence for its own work) and one by a run already folded for that revision. At most `LIMITS.uses` are kept, the newest
 * first, and always the newest few of the live revision's standing (`pruneUses`).
 */
export function foldUses(trial: Trial, incoming: readonly Use[], options: DecisionOptions = {}): Folded {
  let current = trial;
  const applied: Applied[] = [];
  const ignored: IgnoredUse[] = [];
  const folded = new Set(trial.uses.map((use) => `${use.run}\n${use.sha256}`));
  for (const use of [...incoming].sort(order)) {
    const revision = current.revisions.find((r) => r.sha256 === use.sha256);
    if (!revision) ignored.push({ use, reason: "unknown_revision" });
    else if (revision.run === use.run) ignored.push({ use, reason: "author" });
    else if (folded.has(`${use.run}\n${use.sha256}`)) ignored.push({ use, reason: "duplicate" });
    else {
      current = pruneUses({ ...current, uses: [...current.uses, use] }, LIMITS.uses);
      const decision = promotionDecision(current, options);
      if (decision.action !== "hold") {
        current = applyDecision(current, decision, use.at);
        applied.push({ decision, at: use.at });
      }
    }
  }
  return { trial: current, applied, ignored };
}
