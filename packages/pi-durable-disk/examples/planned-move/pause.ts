// While the example waits for host A's run to pause at its step boundary, an instance that has ended without pausing it is
// the answer: waiting out the timeout would only say "timed out" three minutes later, with the reason (the unit's journal)
// unread. The decision is a function of three reads, so it takes them as arguments.
/** A host driver's report on an instance (`HostStatus`). */
export type UnitState = "running" | "stopped" | "failed" | "gone" | "unknown";

export interface PauseReads<R extends { status: string }> {
  /** `run.json`, as the supervisor reads it. */
  status(): Promise<R | null>;
  /** The run's delegations on the disk: the instance's own, until its release. */
  delegations(): Promise<unknown[]>;
  /** The state of host A's unit. */
  unit(): Promise<UnitState>;
  /** What the unit last logged, read only once it has ended without pausing the run. */
  journal(): string;
}

/**
 * The paused record once the run is paused and released, false to keep waiting, and a thrown error, with the unit's last log
 * lines, once host A's unit has ended and the run is not paused. A unit that paused the run and exited between the two reads
 * is not an error, so the record is read once more before it is called one. A unit whose state cannot be judged is waited on.
 */
export async function pausedOrEnded<R extends { status: string }>(reads: PauseReads<R>): Promise<R | false> {
  const released = async (record: R) => ((await reads.delegations()).length === 0 ? record : false);
  const record = await reads.status();
  if (record?.status === "paused") return released(record);
  const state = await reads.unit();
  if (state === "running" || state === "unknown") return false;
  const again = await reads.status();
  if (again?.status === "paused") return released(again);
  const log = reads.journal().trim();
  throw new Error(`host A's instance ended (unit ${state}) before the run paused: ${log || "no log lines"}`);
}
