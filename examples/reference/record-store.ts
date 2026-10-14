// The one place the recorder reaches the run's store, through `@parcha/agentrun-pi/durable`: `snapshotLines` (every document
// at the store's head, as whole values marked `snapshot: true`) and then `recordCommits` (one set of lines per commit pi
// publishes), both inside the process that holds the run. A disk run's store admits one connection, so nothing outside the
// process reads it while the run is open, and the snapshot reads current state, so it is exact only before the run resumes:
// the disk package's `beforeResume` hook is where this runs. It is an adapter so the recorder does not depend on how the
// export is reached, and so a test can hand it a store of its own.

export type DurableLine = {
  channel: 'durable'; source: string; kind: string; gen?: number; commit: number; order: number; snapshot?: true; t?: number;
  path?: string; conv?: number; data: unknown; blobs?: string[];
};
/** What the snapshot and the subscription need, all of which `beforeResume` has or can read: the Harness (pi's commit
 *  publications), the Storage it was opened over, the store's head commit, the open's context, and the process's driver generation. */
export type AttachInput = { session: unknown; storage?: unknown; head?: number; context: unknown; gen: number; clock: () => number };
/** Writes the snapshot, starts recording commits, and returns what stops it (it waits for queued writes). */
export type CommitRecorder = (input: AttachInput, write: (line: DurableLine) => void) => Promise<() => Promise<void>>;

type PackageExport = {
  recordCommits?: (session: unknown, options: { gen?: number; write: (lines: DurableLine[]) => void | Promise<void>; clock?: () => number }) => () => Promise<void>;
  snapshotLines?: (storage: unknown, options: { at: number; gen?: number; context: unknown }) => Promise<DurableLine[]>;
};

/** The real export, or an error that says which build lacks it. */
export async function packageCommitRecorder(): Promise<CommitRecorder> {
  const durable = (await import('@parcha/agentrun-pi/durable')) as unknown as PackageExport;
  const { recordCommits, snapshotLines } = durable;
  if (typeof recordCommits !== 'function' || typeof snapshotLines !== 'function') throw new Error('This build of @parcha/agentrun-pi/durable has no recordCommits and snapshotLines exports, so a recording cannot carry the store\'s lines.');
  return async ({ session, storage, head, context, gen, clock }, write) => {
    if (storage === undefined || head === undefined) throw new Error('A snapshot needs the Storage the run was opened over and the store\'s head commit, which the disk package\'s beforeResume hook gives; attach after the open has no way to take one before the run resumes.');
    const at = clock();
    for (const line of await snapshotLines(storage, { at: head, gen, context })) write({ ...line, t: line.t ?? at });
    return recordCommits(session, { gen, write: (lines) => { for (const line of lines) write(line); }, clock });
  };
}
