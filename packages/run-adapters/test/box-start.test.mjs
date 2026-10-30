// ./host's box (box-bwrap.ts): the order a box starts in. The record's `ahead` is on disk before the spawn; the box's
// pid 1 is recorded (`started`) before the box is released, so no process of the harness runs before its pid is on disk;
// a failed `started` kills the box before the harness ran. A stand-in for bwrap is spawned here (bwrap itself runs in the
// CI job's box tests): it reports a real process as the namespace's pid 1 on --info-fd, waits for a byte on --block-fd,
// and only then "runs the harness", which writes a marker and echoes its stdin.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { BoxError, bwrapBox, startTimeOf } from '@parcha/agentrun-adapters/host';

function setup() {
  const run = mkdtempSync(join(tmpdir(), 'box-start-'));
  const socket = join(run, 'model.sock');
  writeFileSync(socket, '');
  const spec = { workspace: join(run, 'work'), homes: { HOME: join(run, 'home') }, readOnly: [], modelSocket: socket, modelPort: 8123, env: { PATH: '/usr/bin:/bin' } };
  const recordFile = join(run, 'box.json');
  const marker = join(run, 'harness-ran');
  /** The serve-side recorder: each write synced before it returns. */
  const durable = (record) => {
    const fd = openSync(recordFile, 'w');
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
    closeSync(fd);
  };
  return { run, spec, recordFile, marker, durable };
}

/** A stand-in for bwrap: pid 1 is a real sleep (so its start time and namespace are real), released by a byte on fd 4. */
function fakeBwrap({ marker, beforeInfo, onSpawn, exitBeforeInfo }) {
  const calls = [];
  const procs = [];
  const spawnFake = (command, args, options) => {
    calls.push({ command, args, options });
    onSpawn?.();
    const proc = new EventEmitter();
    const stdio = Array.from({ length: 7 }, () => new PassThrough());
    proc.stdio = stdio;
    [proc.stdin, proc.stdout, proc.stderr] = stdio;
    const pid1 = spawn('sleep', ['60'], { stdio: 'ignore' });
    proc.pid1 = pid1;
    procs.push(proc);
    proc.pid = pid1.pid;
    proc.kill = () => pid1.kill('SIGKILL');
    let stdin = Buffer.alloc(0);
    stdio[0].on('data', (b) => (stdin = Buffer.concat([stdin, b])));
    const close = (code) => setImmediate(() => proc.emit('close', code, null));
    pid1.once('exit', () => close(137));
    if (exitBeforeInfo) {
      stdio[2].write(exitBeforeInfo);
      pid1.kill('SIGKILL');
      return proc;
    }
    setImmediate(() => {
      beforeInfo?.();
      stdio[3].write(`{\n    "child-pid": ${pid1.pid}\n}\n`);
    });
    stdio[4].on('data', () => {
      // Released: the harness runs. Its first act is the marker; then it echoes what reached its stdin.
      writeFileSync(marker, 'ran');
      stdio[1].write(stdin);
    });
    return proc;
  };
  return { spawnFake, calls, procs };
}

test('the record\'s ahead is on disk before the spawn, and carries this process as its writer', async () => {
  const { spec, recordFile, marker, durable } = setup();
  let atSpawn;
  const { spawnFake } = fakeBwrap({ marker, onSpawn: () => (atSpawn = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : undefined) });
  const box = bwrapBox({ spawn: spawnFake });
  const boxed = box.start(spec, { command: '/usr/bin/true', args: [] }, { ahead: durable, started: async (r) => durable(r) });
  assert.ok(atSpawn, 'the ahead record was not on disk when bwrap was spawned');
  assert.equal(typeof atSpawn.id, 'string');
  assert.deepEqual(atSpawn.writer, { pid: process.pid, startTime: startTimeOf(process.pid) });
  assert.equal(atSpawn.pid, undefined, 'no pid before the box exists');
  await boxed.ready;
  boxed.kill();
});

test('no process of the harness runs before started() is durable: the marker is absent while it writes, present after the release', async () => {
  const { spec, recordFile, marker, durable } = setup();
  const { spawnFake } = fakeBwrap({ marker });
  let markerDuringStarted;
  const box = bwrapBox({ spawn: spawnFake });
  const boxed = box.start(spec, { command: '/usr/bin/true', args: [] }, {
    ahead: durable,
    started: async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 50)); // a slow disk: the box must still wait
      durable(r);
      markerDuringStarted = existsSync(marker);
    },
  });
  const record = await boxed.ready;
  assert.equal(markerDuringStarted, false, 'the harness ran before its record was durable');
  const onDisk = JSON.parse(readFileSync(recordFile, 'utf8'));
  assert.equal(onDisk.pid, record.pid);
  assert.equal(onDisk.startTime, startTimeOf(record.pid));
  assert.match(onDisk.pidns, /^pid:\[\d+\]$/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(marker), 'released, the harness runs');
  boxed.kill();
});

test('a failed started() kills the box: the harness never ran, and ready rejects with box_record_failed', async () => {
  const { spec, marker, durable } = setup();
  const { spawnFake, procs } = fakeBwrap({ marker });
  const box = bwrapBox({ spawn: spawnFake, reapMs: 200 });
  const boxed = box.start(spec, { command: '/usr/bin/true', args: [] }, { ahead: durable, started: async () => { throw new Error('disk full'); } });
  await assert.rejects(boxed.ready, (e) => e instanceof BoxError && e.code === 'box_record_failed' && /disk full/.test(e.message));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(marker), false, 'the harness ran although its record failed');
  assert.equal(procs[0].pid1.exitCode === null && procs[0].pid1.signalCode === null, false, 'the box\'s pid 1 is still alive');
});

test('stdin written before the release reaches the harness intact', async () => {
  const { spec, marker, durable } = setup();
  const { spawnFake } = fakeBwrap({ marker });
  const box = bwrapBox({ spawn: spawnFake });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const boxed = box.start(spec, { command: '/usr/bin/true', args: [] }, { ahead: durable, started: async (r) => { await gate; durable(r); } });
  const sent = Buffer.concat([Buffer.from('{"type":"user","message":"hi"}\n'), Buffer.from([0, 1, 2, 255, 13, 10])]);
  boxed.child.stdin.write(sent); // the SDK writes at once, before the box is released
  let out = Buffer.alloc(0);
  boxed.child.stdout.on('data', (b) => (out = Buffer.concat([out, b])));
  release();
  await boxed.ready;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(out.equals(sent), `the harness read ${JSON.stringify(out.toString('latin1'))}`);
  boxed.kill();
});

test('a refused argv throws synchronously and nothing is spawned or recorded', () => {
  const { spec, marker, durable } = setup();
  const { spawnFake, calls } = fakeBwrap({ marker });
  let aheads = 0;
  const box = bwrapBox({ spawn: spawnFake });
  assert.throws(() => box.start({ ...spec, readOnly: ['/'] }, { command: '/usr/bin/true', args: [] }, { ahead: () => aheads++, started: async () => {} }), (e) => e instanceof BoxError && e.code === 'box_refused');
  assert.equal(calls.length, 0);
  assert.equal(aheads, 0);
  void durable;
});

test('an ahead that throws stops the start before the spawn', () => {
  const { spec, marker } = setup();
  const { spawnFake, calls } = fakeBwrap({ marker });
  const box = bwrapBox({ spawn: spawnFake });
  assert.throws(() => box.start(spec, { command: '/usr/bin/true', args: [] }, { ahead: () => { throw new Error('no disk'); }, started: async () => {} }), /no disk/);
  assert.equal(calls.length, 0);
});

test('bwrap that ends before reporting its pid rejects ready with the named cause (a host that denies user namespaces)', async () => {
  const { spec, marker, durable } = setup();
  const { spawnFake } = fakeBwrap({ marker, exitBeforeInfo: 'bwrap: setting up uid map: Permission denied\n' });
  const box = bwrapBox({ spawn: spawnFake });
  const boxed = box.start(spec, { command: '/usr/bin/true', args: [] }, { ahead: durable, started: async () => assert.fail('started without a pid') });
  await assert.rejects(boxed.ready, (e) => e instanceof BoxError && e.code === 'bwrap_userns_denied');
  assert.equal(existsSync(marker), false);
});

test('bwrap is started with only PATH in its environment, never the run process\'s', () => {
  const { spec, marker, durable } = setup();
  const { spawnFake, calls } = fakeBwrap({ marker });
  process.env.BOX_TEST_CANARY = 'canary';
  try {
    const boxed = bwrapBox({ spawn: spawnFake }).start(spec, { command: '/usr/bin/true', args: [] }, { ahead: durable, started: async (r) => durable(r) });
    assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin:/bin' });
    boxed.ready.then(() => boxed.kill());
  } finally {
    delete process.env.BOX_TEST_CANARY;
  }
});
