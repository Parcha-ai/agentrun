// The submission keys the door records a request under in a run's store (door.ts): a journal, one entry per key, from
// `door <requestId>` (its admission) on to `door <requestId> <n>`. An admission is followed by its outcome, an UNKNOWN
// outcome by its late one, and a busy refusal by a new admission when the request comes again. A requestId has no
// space, so no key collides. Exported so a host can find a request the door took without a door: a message a run
// already holds is not sent again.
export const doorKey = (requestId: string, n = 0): string => (n === 0 ? `door ${requestId}` : `door ${requestId} ${n}`);

/** Whether the door took a request, or may have: its journal's last status (`statusAt` reads the status kept under a
 *  key, undefined for none), unless that is a busy refusal, which leaves the request to a retry. One never admitted was
 *  not taken. */
export async function doorTook(requestId: string, statusAt: (key: string) => string | undefined | Promise<string | undefined>): Promise<boolean> {
  let last: string | undefined;
  for (let n = 0, status: string | undefined; (status = await statusAt(doorKey(requestId, n))) !== undefined; n++) last = status;
  return last !== undefined && last !== "REJECTED_BUSY";
}
