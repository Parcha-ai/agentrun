// The result of a process that handed the run off. THIS WEEK ONLY: the disk place reads a run its instance left sealed `sleeping` or `paused` as a failed outcome, so the entry names the clean release here.
// It goes once the disk place reports a clean seal itself (a small disk PR after the public launch), and with it this file.

/** Why a planned handoff did not land (a `handoff.failed` line's reason). */
export type HandoffFailure = 'crossing not logged' | 'exit not 0' | 'not released';

/** A process outcome as a place reports it. */
export type Outcome = { status: string; [other: string]: unknown };

/**
 * Whether a runner's exit is a clean end, in the words places use today: 0 from a process of this machine (the local place), `stopped` from a host driver, which says it only after its instance exited 0
 * (the Daytona launcher's and docker's word on the Archil place; `failed` after any other end). THIS WEEK ONLY too: it goes once every place reports a clean exit the same way (a disk PR after the launch).
 */
export function cleanExit(exit: number | string | null): boolean {
  return exit === 0 || exit === 'stopped';
}

/** `released` when the place said `failed`, the process ended cleanly (`cleanExit`), the last `run.json` read says `sleeping` or `paused`, and a planned handoff landed in this process; the outcome as it was otherwise. */
export function releasedOutcome<T extends Outcome>(outcome: T | undefined, exit: number | string | null, lastRunStatus: string | undefined, handoffLanded: boolean): T | undefined {
  if (!outcome || outcome.status !== 'failed' || !cleanExit(exit) || !handoffLanded) return outcome;
  return lastRunStatus === 'sleeping' || lastRunStatus === 'paused' ? { ...outcome, status: 'released' } : outcome;
}
