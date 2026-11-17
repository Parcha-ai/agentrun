// The mirror of the agent's session store (src/state.ts): only files inside the session's HOME enter the records, and a
// file the agent removes while the mirror walks is gone, never an error that costs a turn its outcome.
import assert from 'node:assert/strict';
import fs, { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { StateMirror } from '../dist/state.js';
import { fakeRecipe, openSession, scratch, streamRecords, transcript } from './helpers.mjs';

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
  assert.deepEqual(j.records.map((r) => r.path), ['.agent/own.json']);
});

test('a file removed between the walk seeing it and reading it is gone, and the rest is mirrored', (t) => {
  const home = join(scratch(), 'home');
  mkdirSync(join(home, '.agent'), { recursive: true });
  writeFileSync(join(home, '.agent', 'a.json'), 'a');
  writeFileSync(join(home, '.agent', 'b.json'), 'b');
  const j = journal();
  const mirror = new StateMirror(home, ['.agent'], new Set(), []);
  mirror.take(j);
  assert.deepEqual(j.records.map((r) => r.path), ['.agent/a.json', '.agent/b.json']);
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
  assert.deepEqual(next.records.map((r) => [r.path, r.deleted ?? false]), [['.agent/b.json', false], ['.agent/a.json', true]]);
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
