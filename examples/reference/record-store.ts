// The one place the recorder reaches the run's store: `recordCommits(session, { gen, write })` from
// @parcha/agentrun-pi/durable, which runs inside the process that holds the run and maps each commit pi-durable publishes
// to durable recording lines (a snapshot of every document first, marked `snapshot: true`, then one line per change). It is
// an adapter so the recorder does not depend on how the export is reached, and so a test can hand it a store of its own.
//
// A disk run's store admits one connection, so nothing outside the run's process reads it while the run is open.

export type DurableLine = {
  channel: 'durable'; source: string; kind: string; gen?: number; commit: number; order: number; snapshot?: true;
  path?: string; conv?: number; data: unknown; blobs?: string[];
};
/** Starts recording the commits of an open run; returns what stops it. */
export type CommitRecorder = (harness: unknown, options: { gen: number; write: (line: DurableLine) => void }) => (() => void) | Promise<() => void>;

/** The real export, or an error that says which build lacks it. */
export async function packageCommitRecorder(): Promise<CommitRecorder> {
  const durable = (await import('@parcha/agentrun-pi/durable')) as unknown as { recordCommits?: CommitRecorder };
  if (typeof durable.recordCommits !== 'function') throw new Error('This build of @parcha/agentrun-pi/durable has no recordCommits export, so a recording cannot carry the store\'s lines.');
  return durable.recordCommits;
}
