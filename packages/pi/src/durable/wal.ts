// Whether a SQLite WAL holds a commit, read as SQLite's own recovery reads it (walIndexRecover): the 32-byte header
// (its magic, which sets the checksums' byte order, the page size, the two salts and the header's checksum), then each
// frame (a 24-byte header and a page) whose salts are the header's and whose checksum, chained from the header's, holds.
// Recovery takes the WAL's end at the last such frame that is a commit (its nTruncate, the database size after the
// commit, not 0); a WAL with frames and no commit yet recovers to no frame at all. A lock-free reader of a run's
// database (vfs=unix-none, an exclusive locking mode, the WAL index in heap) that opens such a WAL recovers none, and its
// close then checkpoints nothing and removes the WAL (sqlite3WalClose), under a writer whose first transaction is still
// being written there: that writer's commits go into a removed file and are lost. A reader opens a WAL only once this
// says it holds a commit, and the database file alone (immutable) before then.
//
// A WAL is only ever appended to by the run's writer (no automatic checkpoint, and no checkpoint of its own: it ends by
// process.exit), so a prefix verified once stays verified: the walk resumes from where it stopped, kept per file under
// its inode and the header's salts and checksum. A new header (a WAL made again, or restarted with new salts) starts it
// over.
import fs from "node:fs";

/** A WAL header's magic: its low bit set, the checksums read their words big-endian; clear, little-endian. */
const MAGIC = 0x377f0682;
/** The one WAL format version SQLite writes and reads (WAL_MAX_VERSION). */
const WAL_VERSION = 3007000;
const HEADER = 32;
const FRAME_HEADER = 24;

/** Where a walk of a WAL stopped: past the last frame it verified, with the checksum chained to there. */
type Walked = { key: string; offset: number; s1: number; s2: number; committed: boolean };
const walked = new Map<string, Walked>();

/** SQLite's walChecksumBytes over `data` (its length a multiple of 8), from `s1`/`s2`: each two 32-bit words x0, x1 (read
 *  big-endian when `bigEnd`, else little-endian) add s1 += x0 + s2; s2 += x1 + s1, modulo 2^32. */
function checksum(data: Buffer, bigEnd: boolean, s1: number, s2: number): [number, number] {
  for (let at = 0; at < data.length; at += 8) {
    const x0 = bigEnd ? data.readUInt32BE(at) : data.readUInt32LE(at);
    const x1 = bigEnd ? data.readUInt32BE(at + 4) : data.readUInt32LE(at + 4);
    s1 = (s1 + x0 + s2) >>> 0;
    s2 = (s2 + x1 + s1) >>> 0;
  }
  return [s1, s2];
}

/** Forgets the walk kept for `wal`: a WAL a checkpoint removed. A WAL found gone is forgotten by walHasCommit too, so the
 *  walks kept are of WALs that still exist. */
export function forgetWalWalk(wal: string): void {
  walked.delete(wal);
}

/** How many walks are kept (tests). */
export function keptWalWalks(): number {
  return walked.size;
}

/**
 * Whether the WAL at `wal` holds a commit SQLite's recovery would take: a frame whose salts are the header's, whose
 * chained checksum holds, and whose nTruncate is not 0. No WAL, a short one, a header that is not one, or frames with no
 * verified commit yet: false.
 */
export function walHasCommit(wal: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(wal, "r");
  } catch {
    walked.delete(wal);
    return false;
  }
  try {
    const at = fs.fstatSync(fd);
    if (at.size < HEADER + FRAME_HEADER) return false;
    const header = Buffer.alloc(HEADER);
    if (fs.readSync(fd, header, 0, HEADER, 0) < HEADER) return false;
    const magic = header.readUInt32BE(0);
    if ((magic & 0xfffffffe) !== MAGIC || header.readUInt32BE(4) !== WAL_VERSION) return false;
    const bigEnd = (magic & 1) === 1;
    const pageSize = header.readUInt32BE(8);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return false;
    const [h1, h2] = checksum(header.subarray(0, 24), bigEnd, 0, 0);
    if (h1 !== header.readUInt32BE(24) || h2 !== header.readUInt32BE(28)) return false;
    const salt1 = header.readUInt32BE(16);
    const salt2 = header.readUInt32BE(20);
    const key = `${at.dev}:${at.ino}:${header.toString("hex")}`;
    let walk = walked.get(wal);
    if (walk?.key !== key) walk = { key, offset: HEADER, s1: h1, s2: h2, committed: false };
    walked.set(wal, walk);
    if (walk.committed) return true;
    const frame = Buffer.alloc(FRAME_HEADER + pageSize);
    while (walk.offset + frame.length <= at.size) {
      if (fs.readSync(fd, frame, 0, frame.length, walk.offset) < frame.length) break;
      if (frame.readUInt32BE(0) === 0 || frame.readUInt32BE(8) !== salt1 || frame.readUInt32BE(12) !== salt2) break;
      let [s1, s2] = checksum(frame.subarray(0, 8), bigEnd, walk.s1, walk.s2);
      [s1, s2] = checksum(frame.subarray(FRAME_HEADER), bigEnd, s1, s2);
      if (s1 !== frame.readUInt32BE(16) || s2 !== frame.readUInt32BE(20)) break;
      walk.offset += frame.length;
      walk.s1 = s1;
      walk.s2 = s2;
      if (frame.readUInt32BE(4) !== 0) {
        walk.committed = true;
        return true;
      }
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
