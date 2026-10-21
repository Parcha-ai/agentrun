// What a run costs the disk, for the switch rule between /srv/bulk and /: the time one small durable commit takes on the
// run's own volume, measured beside the run the way pi-durable's stores commit (WAL, synchronous NORMAL: no fsync per
// commit), and how many durable commits the run's store made.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recordingLines } from '@parcha/agentrun-pi/durable';

/** The median time of `commits` one-row commits in a scratch database under `dir`, with pi-durable's settings, removed after. */
export function diskProbe(dir, { commits = 10 } = {}) {
  const scratch = mkdtempSync(join(dir, '.disk-probe-'));
  try {
    const db = new DatabaseSync(join(scratch, 'probe.sqlite'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE t (x INTEGER)');
    const journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
    const synchronous = db.prepare('PRAGMA synchronous').get().synchronous;
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    const times = [];
    for (let i = 0; i < commits; i++) {
      const start = process.hrtime.bigint();
      db.exec('BEGIN');
      insert.run(i);
      db.exec('COMMIT');
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    db.close();
    times.sort((a, b) => a - b);
    return { fsyncMs: Math.round(times[Math.floor(times.length / 2)] * 100) / 100, commits, journal, synchronous };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The durable commits a run's store made: the highest commit number its recording lines carry. */
export function durableCommits(storePath) {
  let most = 0;
  for (const line of recordingLines(storePath).lines) if (Number.isInteger(line.commit) && line.commit > most) most = line.commit;
  return most;
}
