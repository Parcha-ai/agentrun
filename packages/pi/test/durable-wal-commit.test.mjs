// walHasCommit: whether a SQLite WAL holds a commit its recovery would take (a frame with the header's salts, its chained
// checksum holding, and nTruncate not 0). Frames with no commit yet, a broken checksum or salts that are not the header's
// say no; a walk kept for a file resumes where it stopped, and a new header (a WAL made again with new salts) starts over.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { walHasCommit } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-wal-commit-'));
after(() => rmSync(root, { recursive: true, force: true }));
const dirOf = () => mkdtempSync(join(root, 'run-'));
const HEADER = 32;

/** A writer as a run's process opens its database, its first transaction spilling pages into a fresh WAL before it
 *  commits: the WAL's bytes with frames and no commit, then with the commit, and the page size. The connection is kept
 *  open (a close would checkpoint and remove the WAL). */
const kept = [];
function writeWal(dir) {
  const file = join(dir, 'run.sqlite');
  const db = new DatabaseSync(file);
  kept.push(db);
  db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=2');
  db.exec('BEGIN; CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)');
  const insert = db.prepare('INSERT INTO t(b) VALUES(?)');
  for (let i = 0; i < 20; i++) insert.run('x'.repeat(3000));
  const uncommitted = readFileSync(`${file}-wal`);
  db.exec('COMMIT');
  const committed = readFileSync(`${file}-wal`);
  return { wal: `${file}-wal`, uncommitted, committed, pageSize: committed.readUInt32BE(8) };
}

test('no WAL, an empty one, a short one or one that is not a WAL: no commit', () => {
  const dir = dirOf();
  assert.equal(walHasCommit(join(dir, 'none-wal')), false);
  writeFileSync(join(dir, 'empty-wal'), '');
  assert.equal(walHasCommit(join(dir, 'empty-wal')), false);
  writeFileSync(join(dir, 'short-wal'), Buffer.alloc(40));
  assert.equal(walHasCommit(join(dir, 'short-wal')), false);
  writeFileSync(join(dir, 'junk-wal'), Buffer.alloc(8192, 7));
  assert.equal(walHasCommit(join(dir, 'junk-wal')), false);
});

test("a fresh WAL's first transaction: its frames with no commit yet say no, its commit says yes", () => {
  const { wal, uncommitted, committed, pageSize } = writeWal(dirOf());
  assert.ok(uncommitted.length >= HEADER + 2 * (24 + pageSize), `frames before the commit (${uncommitted.length} bytes)`);
  const copy = `${wal}.copy`;
  writeFileSync(copy, uncommitted);
  assert.equal(walHasCommit(copy), false);
  assert.equal(walHasCommit(wal), true);
  writeFileSync(`${wal}.done`, committed);
  assert.equal(walHasCommit(`${wal}.done`), true);
});

test("a frame whose checksum does not hold, or whose salts are not the header's, ends the walk before the commit", () => {
  const { wal, committed, pageSize } = writeWal(dirOf());
  const page = HEADER + 24 + 100;
  const torn = Buffer.from(committed);
  torn[page] ^= 0xff;
  writeFileSync(`${wal}.torn`, torn);
  assert.equal(walHasCommit(`${wal}.torn`), false);
  const salted = Buffer.from(committed);
  salted.writeUInt32BE((salted.readUInt32BE(HEADER + 8) + 1) >>> 0, HEADER + 8);
  writeFileSync(`${wal}.salted`, salted);
  assert.equal(walHasCommit(`${wal}.salted`), false);
  // A torn last frame (the commit's, cut short) is no commit either.
  writeFileSync(`${wal}.cut`, committed.subarray(0, committed.length - pageSize / 2));
  assert.equal(walHasCommit(`${wal}.cut`), false);
});

/** The committed WAL less its last frame (the commit's): every frame verified, none a commit. */
const beforeCommit = ({ committed, pageSize }) => committed.subarray(0, committed.length - (24 + pageSize));

test('a walk resumes from the frames it verified: the prefix is not read again as the WAL grows', () => {
  const written = writeWal(dirOf());
  const grow = `${written.wal}.grow`;
  const prefix = beforeCommit(written);
  writeFileSync(grow, prefix);
  assert.equal(walHasCommit(grow), false);
  // Spoil a frame the walk already verified, in place (the same file, the same header), then append the commit: a walk
  // that resumed never reads the spoiled frame again and finds the commit.
  const spoiled = Buffer.from(prefix);
  spoiled[HEADER + 24 + 100] ^= 0xff;
  writeFileSync(grow, spoiled);
  appendFileSync(grow, written.committed.subarray(prefix.length));
  assert.equal(walHasCommit(grow), true);
});

test('a new header (the WAL made again, with new salts) starts the walk over', () => {
  const first = writeWal(dirOf());
  const second = writeWal(dirOf());
  assert.notEqual(first.committed.subarray(16, 24).toString('hex'), second.committed.subarray(16, 24).toString('hex'), 'new salts');
  const wal = join(dirOf(), 'run.sqlite-wal');
  writeFileSync(wal, first.committed);
  assert.equal(walHasCommit(wal), true);
  // The same file rewritten in place with another WAL's header and frames with no commit yet: the kept walk (committed)
  // is not this WAL's.
  writeFileSync(wal, beforeCommit(second));
  assert.equal(walHasCommit(wal), false);
  appendFileSync(wal, second.committed.subarray(beforeCommit(second).length));
  assert.equal(walHasCommit(wal), true);
});
