import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftCommitter } from '../src/draft.ts';

/** Manual timers and builds that finish when the test says so. */
function rig() {
  const log: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const builds: { save: boolean; done: () => void; fail: (e: Error) => void }[] = [];
  const c = new DraftCommitter({
    build: (save) => { log.push(`build(save=${save})`); return new Promise<void>((res, rej) => builds.push({ save, done: () => { log.push('build done'); res(); }, fail: rej })); },
    save: async () => { log.push('save'); },
    onError: (e) => log.push(`error: ${e.message}`),
    liveMs: 300, saveMs: 1500,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { live: boolean }).live = false; },
  });
  const fire = (ms: number) => { const t = timers.find((x) => x.live && x.ms === ms); assert.ok(t, `a ${ms} ms timer is pending`); t.live = false; t.fn(); };
  const tick = () => new Promise<void>((r) => setImmediate(r));
  return { c, log, builds, fire, tick, timers };
}

test('a commit during a live rebuild waits for it, then saves that body: it cannot publish the previous body', async () => {
  const { c, log, builds, fire, tick } = rig();
  c.edit();
  fire(300); // the pen rested: the live rebuild starts and is still hashing and building
  assert.deepEqual(log, ['build(save=false)']);
  let committed = false;
  const p = c.commit().then(() => { committed = true; });
  await tick();
  assert.equal(committed, false, 'the commit has not finished while the build runs');
  assert.deepEqual(log, ['build(save=false)'], 'and nothing was saved yet');
  builds[0].done();
  await p;
  assert.deepEqual(log, ['build(save=false)', 'build done', 'save'], 'the save came after the build it had to wait for');
});

test('a commit with the rebuild still pending builds once with the save, and does not save twice', async () => {
  const { c, log, builds, tick } = rig();
  c.edit();
  const p = c.commit();
  await tick();
  assert.deepEqual(log, ['build(save=true)']);
  builds[0].done();
  await p;
  assert.deepEqual(log, ['build(save=true)', 'build done']);
});

test('an edit made while a build runs is built before the commit saves: the saved body is always the latest drawing', async () => {
  const { c, log, builds, fire, tick } = rig();
  c.edit();
  fire(300); // build 1 starts
  c.edit(); // another stroke while it runs
  const p = c.commit();
  await tick();
  builds[0].done(); // build 1 finishes; the second drawing is still unbuilt
  await tick();
  assert.deepEqual(log.filter((l) => l.startsWith('build(')), ['build(save=false)', 'build(save=true)'], 'the latest drawing gets its own build, with the save');
  builds[1].done();
  await p;
  assert.equal(log.filter((l) => l === 'save').length, 0, 'saved by the last build, not by a separate save of a stale body');
});

test('with nothing pending a commit just saves; the delayed save fires after the pen rests; a failed build is reported, not thrown into the timer', async () => {
  const r = rig();
  await r.c.commit();
  assert.deepEqual(r.log, ['save']);
  const q = rig();
  q.c.edit();
  q.fire(300);
  q.builds[0].fail(new Error('could not hash'));
  await q.tick();
  assert.ok(q.log.includes('error: could not hash'));
  const s = rig();
  s.c.edit();
  s.fire(300);
  s.builds[0].done();
  await s.tick();
  s.fire(1500); // the delayed save
  await s.tick();
  assert.ok(s.log.includes('save'), s.log.join(' | '));
});

test('rebuilt() waits for the live rebuild of the latest drawing, without saving, and is immediate when nothing is pending', async () => {
  const idle = rig();
  await idle.c.rebuilt(); // nothing drawn: resolves at once
  assert.deepEqual(idle.log, []);
  const { c, log, builds, fire, tick } = rig();
  c.edit();
  let rebuilt = false;
  const p = c.rebuilt().then(() => { rebuilt = true; });
  await tick();
  assert.equal(rebuilt, false, 'the rest has not passed, so no build has started');
  fire(300);
  await tick();
  assert.equal(rebuilt, false, 'the build is running');
  c.edit(); // the pen moves again before it finishes: the answer has to be about the newest drawing
  builds[0].done();
  await tick();
  assert.equal(rebuilt, false, 'the finished build is of an older drawing');
  fire(300);
  await tick();
  builds[1].done();
  await p;
  assert.equal(rebuilt, true);
  assert.ok(!log.includes('save'), `it forced no save: ${log.join(' | ')}`);
});
