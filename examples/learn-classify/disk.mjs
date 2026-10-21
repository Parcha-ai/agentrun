// What a run cost the disk: how many durable commits the run's store made (a row field; the TL's switch rule between
// /srv/bulk and / is decided by run wall time alone).
import { recordingLines } from '@parcha/agentrun-pi/durable';

/** The durable commits a run's store made: the highest commit number its recording lines carry. */
export function durableCommits(storePath) {
  let most = 0;
  for (const line of recordingLines(storePath).lines) if (Number.isInteger(line.commit) && line.commit > most) most = line.commit;
  return most;
}
