// The result of a process that handed the run off. THIS WEEK ONLY: the disk place reads a run its instance left sealed `sleeping` or `paused` as a failed outcome, so the entry names the clean release here.
// It goes once the disk place reports a clean seal itself (a small disk PR after the public launch), and with it this file.

/** Why a planned handoff did not land (a `handoff.failed` line's reason). */
export type HandoffFailure = 'crossing not logged' | 'exit not 0' | 'not released';

/** A process outcome as a place reports it. */
export type Outcome = { status: string; [other: string]: unknown };

/** `released` when the place said `failed`, the process exited 0, the last `run.json` read says `sleeping` or `paused`, and a planned handoff landed in this process; the outcome as it was otherwise. */
export function releasedOutcome<T extends Outcome>(outcome: T | undefined, exit: number | string | null, lastRunStatus: string | undefined, handoffLanded: boolean): T | undefined {
  if (!outcome || outcome.status !== 'failed' || exit !== 0 || !handoffLanded) return outcome;
  return lastRunStatus === 'sleeping' || lastRunStatus === 'paused' ? { ...outcome, status: 'released' } : outcome;
}
