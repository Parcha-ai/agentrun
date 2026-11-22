// The mirror of the agent's session store (src/state.ts): only files inside the session's HOME enter the records, and a
// file the agent removes while the mirror walks is gone, never an error that costs a turn its outcome.
import assert from 'node:assert/strict';
import fs, { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { StateMirror, STATE_BUDGET, stateBudgetPassed, stateFiles, restoreState } from '../dist/state.js';
import { fakeEvents, fakeRecipe, openSession, resolvedRecords, scratch, sessionBytes, streamRecords, transcript } from './helpers.mjs';

/** The bytes records hold in the journal, as their JSON. */
const bytesOf = (records) => records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0);
/** The run channel's frame (serve run-channel.ts MAX_FRAME): a resume reads the session's records through it. */
const CHANNEL_FRAME = 32 * 1024 * 1024;

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const journal = () => {
  const records = [];
  return { records, append: (_stream, data) => records.push(data) };
};

/** Replace `name` on node:fs (its named exports too) for the length of `t`. */
function patchFs(t, name, wrap) {
  const original = fs[name];
  fs[name] = wrap(original);
  syncBuiltinESMExports();
  const restore = () => {
    fs[name] = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}

test('a state path under a symlinked directory leaves the files outside HOME out', () => {
  const root = scratch();
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'sessions'), { recursive: true });
  writeFileSync(join(outside, 'sessions', 'host.json'), 'HOST FILE');
  mkdirSync(join(home, '.agent'), { recursive: true });
  writeFileSync(join(home, '.agent', 'own.json'), 'own');
  // The agent made .agent/store a link out of its HOME; the recipe mirrors .agent/store/sessions.
  symlinkSync(outside, join(home, '.agent', 'store'));
  const j = journal();
  new StateMirror(home, ['.agent/store/sessions', '.agent/own.json'], new Set(), []).take(j);
  assert.deepEqual([...stateFiles(j.records).keys()], ['.agent/own.json']);
});

test('a file removed between the walk seeing it and reading it is gone, and the rest is mirrored', (t) => {
  const home = join(scratch(), 'home');
  mkdirSync(join(home, '.agent'), { recursive: true });
  writeFileSync(join(home, '.agent', 'a.json'), 'a');
  writeFileSync(join(home, '.agent', 'b.json'), 'b');
  const j = journal();
  const mirror = new StateMirror(home, ['.agent'], new Set(), []);
  mirror.take(j);
  assert.deepEqual([...stateFiles(j.records).keys()], ['.agent/a.json', '.agent/b.json']);
  writeFileSync(join(home, '.agent', 'a.json'), 'a2');
  writeFileSync(join(home, '.agent', 'b.json'), 'b2');
  patchFs(t, 'readFileSync', (read) => (path, ...rest) => {
    if (String(path).endsWith('a.json')) {
      fs.rmSync(path);
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      error.code = 'ENOENT';
      throw error;
    }
    return read(path, ...rest);
  });
  const next = journal();
  mirror.take(next);
  // The take's file records (its pieces aside): b changed, a gone.
  assert.deepEqual(next.records.filter((r) => typeof r.path === 'string').map((r) => [r.path, r.deleted ?? false]), [['.agent/b.json', false], ['.agent/a.json', true]]);
  assert.deepEqual([...stateFiles([...j.records, ...next.records])].map(([path, bytes]) => [path, String(bytes)]), [['.agent/b.json', 'b2']]);
});

test('a store that grows by appending costs each take its new bytes, never a whole copy; -shm is never mirrored; the records give the store back whole', () => {
  const home = join(scratch(), 'home');
  const dir = join(home, '.agent');
  mkdirSync(dir, { recursive: true });
  const j = journal();
  const mirror = new StateMirror(home, ['.agent'], new Set(), []);
  // 30 takes, each after 100 KiB more of WAL (never a whole piece): a full copy at each would hold 45 MiB.
  let copies = 0;
  for (let take = 1; take <= 30; take++) {
    fs.appendFileSync(join(dir, 'store.db-wal'), randomBytes(100 * 1024));
    writeFileSync(join(dir, 'store.db-shm'), randomBytes(32 * 1024));
    mirror.take(j);
    copies += take * 100 * 1024;
  }
  assert.ok(copies > CHANNEL_FRAME, 'the old full copies would pass the channel');
  const size = 30 * 100 * 1024;
  const held = bytesOf(j.records);
  // About one copy (base64) plus each take's last piece again.
  assert.ok(held < (size + 30 * 64 * 1024) * 1.4, `the records hold ${held} bytes for a ${size}-byte store`);
  assert.ok(held < STATE_BUDGET, 'inside the budget');
  const files = stateFiles(j.records);
  assert.deepEqual([...files.keys()], ['.agent/store.db-wal'], 'the -shm is never mirrored');
  assert.ok(files.get('.agent/store.db-wal').equals(fs.readFileSync(join(dir, 'store.db-wal'))), 'the WAL comes back byte for byte');
});

test("a SQLite store in WAL mode comes back usable after SQLite rewrote its WAL from the start (a checkpoint), and after a kill between takes", () => {
  const home = join(scratch(), 'home');
  const dir = join(home, '.agent');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'store.db'));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE turns (n INTEGER, body BLOB)");
  const insert = db.prepare('INSERT INTO turns VALUES (?, ?)');
  const j = journal();
  const mirror = new StateMirror(home, ['.agent'], new Set(), []);
  for (let n = 1; n <= 20; n++) insert.run(n, randomBytes(8 * 1024));
  mirror.take(j);
  // A checkpoint that restarts the WAL: the next write rewrites it from its first frame, with a new salt.
  db.exec('PRAGMA wal_checkpoint(RESTART)');
  for (let n = 21; n <= 30; n++) insert.run(n, randomBytes(8 * 1024));
  mirror.take(j);
  // A kill here: what the records hold is the last take, whole.
  const killed = [...j.records];
  for (let n = 31; n <= 35; n++) insert.run(n, randomBytes(8 * 1024));
  assert.ok(!j.records.some((r) => typeof r.path === 'string' && r.path.endsWith('-shm')), 'no -shm record');
  /** The store the records give back, opened as the next agent process opens it: the turns it holds. */
  const restored = (records) => {
    const next = join(scratch(), 'home');
    restoreState(next, records);
    const again = new DatabaseSync(join(next, '.agent', 'store.db'));
    try {
      assert.equal(again.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      return again.prepare('SELECT count(*) AS n, max(n) AS last FROM turns').get();
    } finally {
      again.close();
    }
  };
  assert.deepEqual({ ...restored(killed) }, { n: 30, last: 30 }, 'after the checkpoint, every turn up to the kill');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  insert.run(36, randomBytes(8 * 1024));
  mirror.take(j);
  db.close();
  assert.deepEqual({ ...restored(j.records) }, { n: 36, last: 36 }, 'after a truncating checkpoint too');
});

test('a mirror that would pass its budget writes one record saying so, says it to the run once, and takes nothing more; its records restore nothing', () => {
  const home = join(scratch(), 'home');
  const dir = join(home, '.agent');
  mkdirSync(dir, { recursive: true });
  const j = journal();
  const said = [];
  const budget = 512 * 1024;
  const mirror = new StateMirror(home, ['.agent'], new Set(), [], () => {}, (words) => said.push(words), budget);
  writeFileSync(join(dir, 'store.db-wal'), randomBytes(200 * 1024));
  mirror.take(j);
  assert.equal(stateFiles(j.records).size, 1, 'inside the budget, mirrored');
  fs.appendFileSync(join(dir, 'store.db-wal'), randomBytes(300 * 1024));
  mirror.take(j);
  assert.deepEqual(said, [stateBudgetPassed(budget)]);
  assert.match(said[0], /passed 0\.5 MiB, so a resume starts it fresh with the conversation so far/);
  const dropped = j.records.filter((r) => r.dropped);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].bytes > budget && dropped[0].limit === budget, JSON.stringify(dropped[0]));
  assert.ok(bytesOf(j.records) < budget + 1024, 'the records never pass the budget');
  const before = j.records.length;
  fs.appendFileSync(join(dir, 'store.db-wal'), randomBytes(10));
  mirror.take(j);
  new StateMirror(home, ['.agent'], new Set(), j.records, () => {}, (words) => said.push(words), budget).take(j);
  assert.equal(j.records.length, before, 'nothing more, in this process or the next');
  assert.equal(said.length, 1, 'said once');
  assert.equal(stateFiles(j.records).size, 0, 'a resume restores nothing: the agent starts fresh');
});

test("a fake agent whose store grows each turn past the old bound: every turn completes, the journal holds about one copy, and a resume gets the store back", async (t) => {
  // 192 KiB more at each save of the agent's session (a partial last piece is the unit test's above). Before pieces, this
  // session's records held a full copy at each mirror point: at 200 KiB a save they held 46.7 MB after 12 turns, past the
  // channel's 32 MiB frame.
  const recipe = fakeRecipe(scratch(), { script: Array.from({ length: 12 }, (_, i) => ({ say: `turn ${i + 1}` })), grow: { bytes: 192 * 1024 } });
  const { session, store, events } = await openSession(t, recipe);
  const sizes = [];
  for (let turn = 1; turn <= 12; turn++) {
    await session.send(`turn ${turn}`);
    const end = await session.turnEnd();
    assert.equal(end.status, 'completed', `turn ${turn}: ${end.error}`);
    const home = fakeEvents(recipe).find((e) => e.type === 'start').home;
    sizes.push(fs.statSync(join(home, '.fake-acp', 'sessions', 'store.db-wal')).size);
  }
  const records = await resolvedRecords(store, 'acp.state');
  // The whole session's records (blobs and all), as a resume reads them through the channel.
  const held = await sessionBytes(store);
  const last = sizes.at(-1);
  assert.ok(held < last * 1.5 + 1024 * 1024, `the session holds ${held} bytes for a ${last}-byte store`);
  assert.ok(held < CHANNEL_FRAME / 4, `a resume reads ${held} bytes, well inside the channel's ${CHANNEL_FRAME}`);
  assert.equal(records.some((r) => r.dropped), false, 'inside the budget');
  assert.equal(events.some((e) => e.type === 'notice'), false, 'nothing to say');
  const files = stateFiles(records);
  assert.equal([...files.keys()].some((path) => path.endsWith('-shm')), false, 'the -shm is never mirrored');
  assert.equal(files.get('.fake-acp/sessions/store.db-wal')?.length, last, "a resume gets the store's last take back");
});

test("a fake agent whose store passes the budget: the run is told in words, every turn completes, and the next process starts fresh with the conversation so far", async (t) => {
  const recipe = fakeRecipe(scratch(), { script: Array.from({ length: 6 }, (_, i) => ({ say: `turn ${i + 1}` })), grow: { bytes: 2 * 1024 * 1024 } });
  const sessionsDir = join(scratch(), 'sessions');
  const first = await openSession(t, recipe, { sessionsDir });
  for (let turn = 1; turn <= 4; turn++) {
    await first.session.send(`turn ${turn}`);
    const end = await first.session.turnEnd();
    assert.equal(end.status, 'completed', `turn ${turn}: ${end.error}`);
  }
  const notices = first.events.filter((e) => e.type === 'notice');
  assert.deepEqual(notices.map((e) => e.text), [stateBudgetPassed()], 'said once, in words');
  assert.match(notices[0].text, /passed 8 MiB, so a resume starts it fresh with the conversation so far/);
  const records = await resolvedRecords(first.store, 'acp.state');
  assert.ok(bytesOf(records) <= STATE_BUDGET, `the mirror stays inside its budget: ${bytesOf(records)} bytes`);
  assert.ok((await sessionBytes(first.store)) < STATE_BUDGET * 1.5, 'and the whole session with it');
  assert.equal(records.filter((r) => r.dropped).length, 1);
  await first.session.close();
  // The next process: no store comes back, so it cannot load its session, and starts a new one.
  const second = await openSession(t, recipe, { sessionsDir, store: first.store });
  await second.session.send('turn 5');
  const end = await second.session.turnEnd();
  assert.equal(end.status, 'completed', end.error);
  const starts = fakeEvents(recipe).filter((e) => e.type === 'new' || e.type === 'load').map((e) => e.type);
  assert.equal(starts.at(-1), 'new', `the next process started fresh: ${starts.join(', ')}`);
  assert.equal((await streamRecords(first.store, 'acp.state')).length, records.length, 'and mirrors nothing more');
  assert.ok(!(await transcript(first.store)).some((e) => e.type === 'turn' && e.status !== 'completed'), 'every turn completed');
});

test("a record of any other shape (a whole file's bytes in one record, as before pieces) restores nothing, and the mirror takes that file whole", () => {
  const home = join(scratch(), 'home');
  mkdirSync(join(home, '.agent'), { recursive: true });
  writeFileSync(join(home, '.agent', 'store.json'), 'kept');
  const earlier = [{ path: '.agent/store.json', sha256: createHash('sha256').update('kept').digest('hex'), data: Buffer.from('kept').toString('base64') }];
  assert.equal(stateFiles(earlier).size, 0);
  const j = journal();
  new StateMirror(home, ['.agent'], new Set(), earlier).take(j);
  assert.equal(String(stateFiles([...earlier, ...j.records]).get('.agent/store.json')), 'kept', 'mirrored as pieces, never taken for known');
});

test('a mirror that fails at the turn end never costs the turn its outcome', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'done' }] });
  const { session, store } = await openSession(t, recipe);
  await session.send('first');
  assert.equal((await session.turnEnd()).status, 'completed');
  // From here the walk of the agent's store fails with an error that is not "gone".
  patchFs(t, 'readdirSync', (readdir) => (path, ...rest) => {
    if (String(path).includes('.fake-acp')) {
      const error = new Error(`EACCES: permission denied, scandir '${path}'`);
      error.code = 'EACCES';
      throw error;
    }
    return readdir(path, ...rest);
  });
  await session.send('second');
  const end = await session.turnEnd();
  assert.equal(end.status, 'completed', end.error);
  const turns = (await transcript(store)).filter((e) => e.type === 'turn');
  assert.deepEqual(turns.map((e) => e.status), ['completed', 'completed'], 'both turns ended in the records');
  assert.ok((await streamRecords(store, 'acp.state')).length > 0);
});
